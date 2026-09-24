import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createDefaultDraft } from '../../../shared/robot';
import * as attemptStoreModule from './attempt-store';
import { MemoryAttemptStore } from './attempt-store';
import { handleRequest } from './handler';

const eventFor = (
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  sub = 'owner',
): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { authorization: 'Bearer access-token' },
    requestContext: {
      http: { method, path },
      requestId: 'request',
      authorizer: {
        jwt: {
          claims: {
            sub,
            token_use: 'access',
            client_id: 'client',
            scope: 'prompt-runner/robot',
          },
        },
      },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

describe('attempt API projection and dispatch recovery', () => {
  it('uses the production Dynamo store with private body recovery for default attempt GETs', async () => {
    vi.stubEnv('DRAFT_TABLE_NAME', 'attempts');
    vi.stubEnv('ATTEMPT_BODIES_BUCKET', 'attempt-bodies');
    const draft = createDefaultDraft();
    const defaultStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
    const admitted = await defaultStore.admit({
      owner: 'owner',
      requestKey: 'default-store',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const factory = vi
      .spyOn(attemptStoreModule, 'createDynamoAttemptStore')
      .mockReturnValue(
        defaultStore as unknown as ReturnType<typeof attemptStoreModule.createDynamoAttemptStore>,
      );
    try {
      const response = await handleRequest(
        eventFor('GET', `/attempts/${encodeURIComponent(admitted.attempt.id)}`),
        {
          store: {
            get: vi.fn().mockResolvedValue({ version: 1, draft }),
            put: vi.fn(),
          },
          fetch: vi.fn(
            async () => new Response(JSON.stringify({ sub: 'owner', email_verified: true })),
          ),
          clientId: 'client',
          userInfoUrl: 'https://cognito.example.test/userinfo',
        },
      );
      expect(response.statusCode).toBe(200);
      expect(factory).toHaveBeenCalledWith({ bodyStore: expect.anything() });
      expect(JSON.parse(response.body ?? '{}')).toMatchObject({
        attempt: { id: admitted.attempt.id },
      });
    } finally {
      factory.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('never returns server ownership/configuration fields and retries a failed duplicate dispatch', async () => {
    const draft = createDefaultDraft();
    const draftStore = { get: vi.fn().mockResolvedValue({ version: 1, draft }), put: vi.fn() };
    const attemptStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost ack'))
      .mockResolvedValueOnce(undefined);
    const dependencies = {
      store: draftStore,
      attemptStore,
      dispatch,
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ sub: 'owner', email_verified: true })),
      ),
      clientId: 'client',
      userInfoUrl: 'https://cognito.example.test/userinfo',
    };
    const input = {
      requestKey: 'request',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    };
    const first = await handleRequest(eventFor('POST', '/attempts', input), dependencies);
    expect(first.statusCode).toBe(200);
    expect(responseBody(first).dispatchConfirmed).toBe(false);
    const duplicate = await handleRequest(eventFor('POST', '/attempts', input), dependencies);
    expect(duplicate.statusCode).toBe(200);
    expect(responseBody(duplicate).dispatchConfirmed).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const attempt = responseBody(duplicate).attempt as Record<string, unknown>;
    expect(attempt).not.toHaveProperty('owner');
    expect(attempt).not.toHaveProperty('draft');
    expect(attempt).not.toHaveProperty('config');
    expect(attempt).not.toHaveProperty('executorId');
    const recovered = await handleRequest(
      eventFor('GET', '/attempt-requests/request'),
      dependencies,
    );
    const recoveredAttempt = responseBody(recovered).attempt as Record<string, unknown>;
    expect(recoveredAttempt).not.toHaveProperty('owner');
    expect(recoveredAttempt).not.toHaveProperty('requestKey');
  });

  it('persists the server-owned animation preference with a version conflict for stale writes', async () => {
    const draft = createDefaultDraft();
    const attemptStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
    const dependencies = {
      store: { get: vi.fn().mockResolvedValue({ version: 1, draft }), put: vi.fn() },
      attemptStore,
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ sub: 'owner', email_verified: true })),
      ),
      clientId: 'client',
      userInfoUrl: 'https://cognito.example.test/userinfo',
    };

    const initial = await handleRequest(eventFor('GET', '/animation-preference'), dependencies);
    expect(responseBody(initial)).toEqual({ animationEnabled: true, version: 0 });
    const saved = await handleRequest(
      eventFor('PUT', '/animation-preference', { animationEnabled: false, expectedVersion: 0 }),
      dependencies,
    );
    expect(responseBody(saved)).toEqual({ animationEnabled: false, version: 1 });
    const reloaded = await handleRequest(eventFor('GET', '/animation-preference'), dependencies);
    expect(responseBody(reloaded)).toEqual({ animationEnabled: false, version: 1 });
    const stale = await handleRequest(
      eventFor('PUT', '/animation-preference', { animationEnabled: true, expectedVersion: 0 }),
      dependencies,
    );
    expect(stale.statusCode).toBe(409);
    expect(responseBody(stale)).toMatchObject({
      code: 'conflict',
      current: { animationEnabled: false, version: 1 },
    });
  });

  it('projects only public replay data and completes terminal zero-action presentation idempotently', async () => {
    const draft = { ...createDefaultDraft(), instructions: 'PRIVATE TEST PROMPT' };
    const draftStore = { get: vi.fn().mockResolvedValue({ version: 1, draft }), put: vi.fn() };
    const attemptStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
    const dispatch = vi.fn();
    const dependencies = {
      store: draftStore,
      attemptStore,
      dispatch,
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ sub: 'owner', email_verified: true })),
      ),
      clientId: 'client',
      userInfoUrl: 'https://cognito.example.test/userinfo',
    };
    const { attempt } = await attemptStore.admit({
      owner: 'owner',
      requestKey: 'terminal-noop',
      expectedVersion: 1,
      draft,
      animationEnabled: true,
    });
    const cancelled = await attemptStore.requestCancel('owner', attempt.id);
    expect(cancelled?.presentationComplete).toBe(true);

    const replay = await handleRequest(
      eventFor('GET', `/attempts/${attempt.id}/replay`),
      dependencies,
    );
    expect(replay.statusCode).toBe(200);
    const body = responseBody(replay);
    expect(body.record).toMatchObject({
      id: attempt.id,
      actions: [],
      snapshots: [{ id: 'state-0' }],
      closure: { status: 'cancelled', actionCount: 0, recordComplete: true },
    });
    expect(JSON.stringify(body)).not.toContain('PRIVATE TEST PROMPT');
    expect(body.record).not.toHaveProperty('owner');
    expect(body.record).not.toHaveProperty('draft');
    expect(body.record).not.toHaveProperty('instructions');
    expect(body.record).not.toHaveProperty('config.robot');
    expect(dispatch).not.toHaveBeenCalled();

    const complete = await handleRequest(
      eventFor('POST', `/attempts/${attempt.id}/presentation-complete`),
      dependencies,
    );
    const duplicate = await handleRequest(
      eventFor('POST', `/attempts/${attempt.id}/presentation-complete`),
      dependencies,
    );
    expect(complete.statusCode).toBe(200);
    expect(responseBody(duplicate).attempt).toMatchObject({
      id: attempt.id,
      presentationComplete: true,
    });

    const otherUser = await handleRequest(
      eventFor('GET', `/attempts/${attempt.id}/replay`, undefined, 'other'),
      {
        ...dependencies,
        fetch: vi.fn(
          async () => new Response(JSON.stringify({ sub: 'other', email_verified: true })),
        ),
      },
    );
    expect(otherUser.statusCode).toBe(404);
  });

  it('recovers duplicate current admissions before dispatching another inference', async () => {
    const draft = createDefaultDraft();
    const attemptStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      store: { get: vi.fn().mockResolvedValue({ version: 1, draft }), put: vi.fn() },
      attemptStore,
      dispatch,
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ sub: 'owner', email_verified: true })),
      ),
      clientId: 'client',
      userInfoUrl: 'https://cognito.example.test/userinfo',
    };
    const body = {
      requestKey: 'same-request',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    };
    const first = await handleRequest(eventFor('POST', '/attempts', body), dependencies);
    const duplicate = await handleRequest(eventFor('POST', '/attempts', body), dependencies);
    expect(responseBody(first).attempt).toMatchObject({ animationEnabled: false });
    expect((responseBody(duplicate).attempt as { id: string }).id).toBe(
      (responseBody(first).attempt as { id: string }).id,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);

    const changedChoice = await handleRequest(
      eventFor('POST', '/attempts', { ...body, animationEnabled: true }),
      dependencies,
    );
    expect(changedChoice.statusCode).toBe(409);
    expect(responseBody(changedChoice).code).toBe('idempotency_conflict');
  });
});
