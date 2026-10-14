// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const identity = {
  sub: 'subject-a',
  token_use: 'access',
  client_id: 'fixture-client',
  scope: 'prompt-runner/robot',
};

function session(): AuthSession {
  return {
    identity: { sub: identity.sub, email: 'a@example.com' },
    user: new User({
      access_token: 'fixture-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
        sub: identity.sub,
        email: 'a@example.com',
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

function eventFor(url: URL, init?: RequestInit): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `${init?.method ?? 'GET'} ${url.pathname}`,
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: { authorization: 'Bearer fixture-token' },
    requestContext: {
      http: { method: init?.method ?? 'GET', path: url.pathname },
      requestId: 'recovery-integration',
      authorizer: { jwt: { claims: identity } },
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
});
