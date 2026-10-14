// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { AttemptApiClient } from './attempt-api.js';
import { AttemptWorkspace, type AttemptWorkspaceHandle } from './AttemptWorkspace.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { MemoryAttemptStore } from '../../api/src/attempt-store.js';
import { handleRequest } from '../../api/src/handler.js';
import { writeAttemptRecovery } from './attempt-recovery.js';

const identity = {
  sub: 'subject-a',
  token_use: 'access',
  client_id: 'fixture-client',
  scope: 'prompt-runner/robot',
};

function session(sub = identity.sub): AuthSession {
  return {
    identity: { sub, email: `${sub}@example.com` },
    user: new User({
      access_token: 'fixture-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
        sub,
        email: `${sub}@example.com`,
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

function eventFor(url: URL, init?: RequestInit, sub = identity.sub): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `${init?.method ?? 'GET'} ${url.pathname}`,
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: {
      authorization: new Headers(init?.headers).get('authorization') ?? 'Bearer fixture-token',
    },
    requestContext: {
      http: { method: init?.method ?? 'GET', path: url.pathname },
      requestId: 'recovery-integration',
      authorizer: { jwt: { claims: { ...identity, sub } } },
    },
    body: init?.body ? String(init.body) : undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function responseFrom(result: APIGatewayProxyStructuredResultV2): Response {
  return new Response(result.body, {
    status: result.statusCode,
    headers: result.headers as HeadersInit,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type RecoveryRequestOverride = (
  url: URL,
  init: RequestInit | undefined,
  event: APIGatewayProxyEventV2,
) => Promise<Response> | undefined;

function createRecoveryHarness(options: { now?: () => Date } = {}) {
  const draft = createDefaultDraft();
  const attemptStore = new MemoryAttemptStore({
    draft: { version: 1, draft },
    ...(options.now ? { now: options.now } : {}),
  });
  const dispatch = vi.fn(async () => undefined);
  const dependencies = {
    store: {
      get: vi.fn().mockResolvedValue({ version: 1, draft }),
      put: vi.fn(),
    },
    attemptStore,
    dispatch,
    clientId: 'fixture-client',
    userInfoUrl: 'https://identity.fixture.invalid/userinfo',
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      const token = authorization.replace(/^Bearer\s+/u, '');
      const sub = token.startsWith('fixture-token-')
        ? token.slice('fixture-token-'.length)
        : identity.sub;
      return jsonResponse({ sub, email_verified: true });
    }),
  };
  const overrides: RecoveryRequestOverride[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const token =
      new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/u, '') ??
      'fixture-token';
    const sub = token.startsWith('fixture-token-')
      ? token.slice('fixture-token-'.length)
      : identity.sub;
    const event = eventFor(url, init, sub);
    for (const override of overrides) {
      const response = override(url, init, event);
      if (response) return await response;
    }
    return responseFrom(await handleRequest(event, dependencies));
  });
  const clientFor = (sub = identity.sub): AttemptApiClient =>
    new AttemptApiClient(
      { apiBaseUrl: 'https://api.fixture.invalid' },
      {
        tokenProvider: () => ({ accessToken: `fixture-token-${sub}`, authContext: 1 }),
        fetch: transport,
      },
    );
  return { draft, attemptStore, dispatch, dependencies, overrides, transport, clientFor };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('AttemptWorkspace recovery integration', () => {
  it('retries the existing start after a real handler admission response is lost', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const draft = createDefaultDraft();
    const attemptStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
    let dispatchCalls = 0;
    const dispatch = vi.fn(async () => {
      dispatchCalls += 1;
      if (dispatchCalls === 1) throw new Error('dispatch unavailable before enqueue');
    });
    const dependencies = {
      store: {
        get: vi.fn().mockResolvedValue({ version: 1, draft }),
        put: vi.fn(),
      },
      attemptStore,
      dispatch,
      clientId: 'fixture-client',
      userInfoUrl: 'https://identity.fixture.invalid/userinfo',
      fetch: vi.fn().mockImplementation(
        () =>
          new Response(JSON.stringify({ sub: identity.sub, email_verified: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    };
    let firstAdmission = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const event = eventFor(url, init);
      if (firstAdmission && init?.method === 'POST' && url.pathname === '/attempts') {
        firstAdmission = false;
        await handleRequest(event, dependencies);
        throw new TypeError('connection lost after admission');
      }
      return responseFrom(await handleRequest(event, dependencies));
    });
    const client = new AttemptApiClient(
      { apiBaseUrl: 'https://api.fixture.invalid' },
      {
        tokenProvider: () => ({ accessToken: 'fixture-token', authContext: 1 }),
        fetch: transport,
      },
    );
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft } satisfies DraftSnapshot),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={client} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      ref.current?.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();

    const attempts = (await attemptStore.list(identity.sub)).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('pending');
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      transport.mock.calls.filter(([input, init]) => {
        return init?.method === 'POST' && new URL(String(input)).pathname.endsWith('/start');
      }),
    ).toHaveLength(1);
    expect((await attemptStore.quota(identity.sub)).used).toBe(1);
  });

  it('releases its cancel lock when Check supersedes the failed POST result', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = createRecoveryHarness();
    const { draft, attemptStore } = harness;
    const admitted = await attemptStore.admit({
      owner: identity.sub,
      requestKey: 'cancel-check-finalizer',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const running = await attemptStore.claim(identity.sub, admitted.attempt.id, 'runner');
    expect(running?.status).toBe('running');
    writeAttemptRecovery({ sub: identity.sub, attemptId: admitted.attempt.id });

    const cancelIdentity = deferred<Response>();
    let cancelResponse: Promise<APIGatewayProxyStructuredResultV2> | undefined;
    let cancelCalls = 0;
    let failNextPoll = false;
    harness.overrides.push((url, init, event) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/cancel')) {
        cancelCalls += 1;
        if (cancelCalls === 1) {
          cancelResponse = handleRequest(event, {
            ...harness.dependencies,
            fetch: () => cancelIdentity.promise,
          });
          return cancelResponse.then(responseFrom);
        }
      }
      if (url.pathname === `/attempts/${admitted.attempt.id}` && failNextPoll) {
        failNextPoll = false;
        return handleRequest(event, {
          ...harness.dependencies,
          fetch: async () => jsonResponse({}, 503),
        }).then(responseFrom);
      }
    });
    const client = harness.clientFor();
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={client} editor={editor} session={session()} />);
    await screen.findByRole('button', { name: 'Cancelar' });

    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(cancelResponse).toBeDefined());
    failNextPoll = true;
    fireEvent.click(
      await screen.findByRole('button', { name: 'Comprobar estado' }, { timeout: 3_500 }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Comprobar estado' })).toBeNull(),
    );
    expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      cancelIdentity.resolve(jsonResponse({}, 503));
      expect((await cancelResponse)?.statusCode).toBe(503);
    });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await screen.findByRole('button', { name: 'Cancelando…' });
    await waitFor(async () =>
      expect((await attemptStore.get(identity.sub, admitted.attempt.id))?.cancelRequested).toBe(
        true,
      ),
    );

    expect(cancelCalls).toBe(2);
    expect((await attemptStore.get(identity.sub, admitted.attempt.id))?.status).toBe('running');
    expect((await attemptStore.quota(identity.sub)).used).toBe(1);
  }, 10_000);

  it('keeps a later attempt cancellation busy when the previous attempt finalizes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let now = new Date('2026-10-14T13:00:00.000Z');
    const harness = createRecoveryHarness({ now: () => new Date(now) });
    const { draft, attemptStore } = harness;
    const first = await attemptStore.admit({
      owner: identity.sub,
      requestKey: 'cancel-first-game',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const firstRunning = await attemptStore.claim(identity.sub, first.attempt.id, 'runner-a');
    expect(firstRunning?.runtimeDeadline).toBeDefined();
    writeAttemptRecovery({ sub: identity.sub, attemptId: first.attempt.id });

    const firstCancelIdentity = deferred<Response>();
    const secondCancelIdentity = deferred<Response>();
    const cancelResponses: Array<Promise<APIGatewayProxyStructuredResultV2>> = [];
    let cancelCalls = 0;
    harness.overrides.push((url, init, event) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/cancel')) {
        cancelCalls += 1;
        const identityResponse = cancelCalls === 1 ? firstCancelIdentity : secondCancelIdentity;
        const response = handleRequest(event, {
          ...harness.dependencies,
          fetch: () => identityResponse.promise,
        });
        cancelResponses.push(response);
        return response.then(responseFrom);
      }
    });
    const client = harness.clientFor();
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft } satisfies DraftSnapshot),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={client} editor={editor} session={session()} />);
    await screen.findByRole('button', { name: 'Cancelar' });

    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(cancelCalls).toBe(1));
    now = new Date(new Date(firstRunning!.runtimeDeadline!).getTime() + 1);
    await screen.findByRole('heading', { name: 'Error de ejecución' }, { timeout: 3_500 });
    act(() => ref.current?.start());
    await screen.findByRole('button', { name: 'Cancelar' }, { timeout: 3_500 });
    const attempts = (await attemptStore.list(identity.sub)).attempts;
    const second = attempts.find((item) => item.id !== first.attempt.id);
    expect(second?.status).toBe('pending');

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(cancelCalls).toBe(2));
    expect(
      (screen.getByRole('button', { name: 'Cancelando…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      firstCancelIdentity.resolve(jsonResponse({}, 503));
      expect((await cancelResponses[0])?.statusCode).toBe(503);
    });
    expect(
      (screen.getByRole('button', { name: 'Cancelando…' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      secondCancelIdentity.resolve(jsonResponse({ sub: identity.sub, email_verified: true }));
      expect((await cancelResponses[1])?.statusCode).toBe(200);
    });
    await waitFor(async () =>
      expect((await attemptStore.get(identity.sub, second!.id))?.cancelRequested).toBe(true),
    );
    expect((await attemptStore.get(identity.sub, first.attempt.id))?.status).toBe('error');
    expect((await attemptStore.quota(identity.sub)).used).toBe(2);
  }, 10_000);

  it('does not let an old account cancellation clear a new account cancellation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = createRecoveryHarness();
    const { draft, attemptStore } = harness;
    const first = await attemptStore.admit({
      owner: 'subject-a',
      requestKey: 'cancel-account-a',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const second = await attemptStore.admit({
      owner: 'subject-b',
      requestKey: 'cancel-account-b',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    await attemptStore.claim('subject-a', first.attempt.id, 'runner-a');
    await attemptStore.claim('subject-b', second.attempt.id, 'runner-b');
    writeAttemptRecovery({ sub: 'subject-a', attemptId: first.attempt.id });

    const firstCancelIdentity = deferred<Response>();
    const secondCancelIdentity = deferred<Response>();
    let firstCancelResponse: Promise<APIGatewayProxyStructuredResultV2> | undefined;
    let secondCancelResponse: Promise<APIGatewayProxyStructuredResultV2> | undefined;
    let firstCancelCalls = 0;
    let secondCancelCalls = 0;
    harness.overrides.push((url, init, event) => {
      if (init?.method !== 'POST' || !url.pathname.endsWith('/cancel')) return undefined;
      const token = event.headers.authorization?.replace(/^Bearer\s+/u, '') ?? '';
      const sub = token.slice('fixture-token-'.length);
      const identityResponse = sub === 'subject-a' ? firstCancelIdentity : secondCancelIdentity;
      const response = handleRequest(event, {
        ...harness.dependencies,
        fetch: () => identityResponse.promise,
      });
      if (sub === 'subject-a') {
        firstCancelCalls += 1;
        firstCancelResponse = response;
      } else {
        secondCancelCalls += 1;
        secondCancelResponse = response;
      }
      return response.then(responseFrom);
    });
    const firstClient = harness.clientFor('subject-a');
    const secondClient = harness.clientFor('subject-b');
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptWorkspace api={firstClient} editor={editor} session={session('subject-a')} />,
    );
    await screen.findByRole('button', { name: 'Cancelar' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(firstCancelCalls).toBe(1));

    writeAttemptRecovery({ sub: 'subject-b', attemptId: second.attempt.id });
    view.rerender(
      <AttemptWorkspace api={secondClient} editor={editor} session={session('subject-b')} />,
    );
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(secondCancelCalls).toBe(1));
    expect(
      (screen.getByRole('button', { name: 'Cancelando…' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      firstCancelIdentity.resolve(jsonResponse({ sub: 'subject-a', email_verified: true }, 503));
      expect((await firstCancelResponse)?.statusCode).toBe(503);
    });
    expect(
      (screen.getByRole('button', { name: 'Cancelando…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(
      second.attempt.id,
    );

    await act(async () => {
      secondCancelIdentity.resolve(jsonResponse({ sub: 'subject-b', email_verified: true }));
      expect((await secondCancelResponse)?.statusCode).toBe(200);
    });
    await waitFor(async () =>
      expect((await attemptStore.get('subject-b', second.attempt.id))?.cancelRequested).toBe(true),
    );
    expect((await attemptStore.get('subject-a', first.attempt.id))?.cancelRequested).toBe(false);
    expect((await attemptStore.quota('subject-a')).used).toBe(1);
    expect((await attemptStore.quota('subject-b')).used).toBe(1);
  }, 10_000);
});
