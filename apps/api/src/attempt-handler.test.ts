import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createDefaultDraft } from '../../../shared/robot';
import * as attemptStoreModule from './attempt-store';
import { MemoryAttemptStore } from './attempt-store';
import { handleRequest } from './handler';

const eventFor = (method: 'GET' | 'POST', path: string, body?: unknown): APIGatewayProxyEventV2 =>
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
            sub: 'owner',
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
    const input = { requestKey: 'request', expectedVersion: 1, draft };
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
});
