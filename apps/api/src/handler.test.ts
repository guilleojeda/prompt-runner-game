import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot';
import { DraftConflictError, type DraftStore } from './draft';
import { handleRequest } from './handler';

const identity = {
  sub: 'user-a',
  token_use: 'access',
  client_id: 'client-1',
  scope: 'openid email prompt-runner/robot',
};

const eventFor = (
  method: 'GET' | 'PUT',
  options: { body?: string; claims?: Record<string, unknown>; query?: Record<string, string> } = {},
): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: `${method} /draft`,
    rawPath: '/draft',
    rawQueryString: '',
    headers: { authorization: 'Bearer access-token' },
    queryStringParameters: options.query,
    requestContext: {
      accountId: 'account',
      apiId: 'api',
      domainName: 'api.example.test',
      domainPrefix: 'api',
      http: { method, path: '/draft', protocol: 'https', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'request',
      routeKey: `${method} /draft`,
      stage: '$default',
      time: '21/Sep/2026:00:00:00 +0000',
      timeEpoch: 0,
      authorizer: { jwt: { claims: options.claims ?? identity } },
    },
    body: options.body,
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const verifiedUserInfo = vi.fn(
  async () =>
    new Response(JSON.stringify({ sub: 'user-a', email_verified: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);

const dependencies = (store: DraftStore, fetch: typeof globalThis.fetch = verifiedUserInfo) => ({
  store,
  fetch,
  clientId: 'client-1',
  userInfoUrl: 'https://cognito.example.test/userinfo',
});

describe('draft API handler', () => {
  it('gets the authenticated owner default and never asks the store for a request owner', async () => {
    const snapshot: DraftSnapshot = { version: 0, draft: createDefaultDraft() };
    const store: DraftStore = { get: vi.fn().mockResolvedValue(snapshot), put: vi.fn() };

    const response = await handleRequest(eventFor('GET'), dependencies(store));

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual(snapshot);
    expect(store.get).toHaveBeenCalledWith('user-a');
    expect(store.put).not.toHaveBeenCalled();
    expect(verifiedUserInfo).toHaveBeenCalledWith(
      'https://cognito.example.test/userinfo',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer access-token' }),
      }),
    );
  });

  it('requires the access token, expected client and application scope before UserInfo or DynamoDB', async () => {
    const store: DraftStore = { get: vi.fn(), put: vi.fn() };
    const validPutBody = JSON.stringify({ expectedVersion: 0, draft: createDefaultDraft() });
    const cases = [
      { claims: { ...identity, token_use: 'id' } },
      { claims: { ...identity, client_id: 'other-client' } },
      { claims: { ...identity, scope: 'openid email' } },
    ];

    for (const options of cases) {
      for (const method of ['GET', 'PUT'] as const) {
        const response = await handleRequest(
          eventFor(method, method === 'PUT' ? { ...options, body: validPutBody } : options),
          dependencies(store, vi.fn()),
        );
        expect(response.statusCode).toBe(403);
      }
    }
    for (const method of ['GET', 'PUT'] as const) {
      const noBearer = eventFor(method, method === 'PUT' ? { body: validPutBody } : {});
      noBearer.headers = {};
      const response = await handleRequest(noBearer, dependencies(store, vi.fn()));
      expect(response.statusCode).toBe(401);
    }
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it.each([
    { userInfo: { sub: 'user-a', email_verified: false } },
    { userInfo: { sub: 'user-a', email_verified: 'false' } },
    { userInfo: { sub: 'user-a' } },
    { userInfo: { sub: 'user-b', email_verified: true } },
  ])('rejects unverified or mismatched UserInfo identity: %#', async ({ userInfo }) => {
    const store: DraftStore = { get: vi.fn(), put: vi.fn() };
    const fetch = vi.fn(async () => new Response(JSON.stringify(userInfo), { status: 200 }));

    for (const method of ['GET', 'PUT'] as const) {
      const response = await handleRequest(
        eventFor(
          method,
          method === 'PUT'
            ? { body: JSON.stringify({ expectedVersion: 0, draft: createDefaultDraft() }) }
            : {},
        ),
        dependencies(store, fetch),
      );
      expect(response.statusCode).toBe(403);
    }
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('returns a recoverable dependency error without touching data when UserInfo is unavailable', async () => {
    const store: DraftStore = { get: vi.fn(), put: vi.fn() };
    const fetch = vi.fn(async () => new Response('', { status: 503 }));

    const response = await handleRequest(eventFor('GET'), dependencies(store, fetch));

    expect(response.statusCode).toBe(503);
    expect(responseBody(response).code).toBe('dependency_unavailable');
    expect(store.get).not.toHaveBeenCalled();
  });

  it('validates the exact PUT contract and preserves conflict snapshots', async () => {
    const current: DraftSnapshot = {
      version: 1,
      updatedAt: '2026-09-21T00:00:00.000Z',
      draft: createDefaultDraft(),
    };
    const store: DraftStore = {
      get: vi.fn(),
      put: vi.fn().mockRejectedValue(new DraftConflictError(current)),
    };
    const draft = createDefaultDraft();
    const response = await handleRequest(
      eventFor('PUT', { body: JSON.stringify({ expectedVersion: 0, draft }) }),
      dependencies(store),
    );

    expect(response.statusCode).toBe(409);
    expect(responseBody(response)).toEqual({
      code: 'conflict',
      message: 'La configuración cambió en otra pestaña.',
      current,
    });
    expect(store.put).toHaveBeenCalledWith('user-a', 0, draft);

    for (const body of [
      { expectedVersion: 0, draft, owner: 'user-b' },
      { expectedVersion: 0, draft: { ...draft, owner: 'user-b' } },
      { expectedVersion: -1, draft },
      { expectedVersion: 0, draft: { ...draft, schemaVersion: 2 } },
    ]) {
      const invalidResponse = await handleRequest(
        eventFor('PUT', { body: JSON.stringify(body) }),
        dependencies(store),
      );
      expect(invalidResponse.statusCode).toBe(400);
    }
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it('rejects owner query selectors and returns no-store data responses', async () => {
    const store: DraftStore = {
      get: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      put: vi.fn(),
    };
    const response = await handleRequest(
      eventFor('GET', { query: { owner: 'user-b' } }),
      dependencies(store),
    );

    expect(response.statusCode).toBe(400);
    expect(store.get).not.toHaveBeenCalled();
    const normal = await handleRequest(eventFor('GET'), dependencies(store));
    expect(normal.headers?.['cache-control']).toBe('no-store');
  });
});
