// @vitest-environment jsdom

import { User, UserManager, WebStorageStateStore, type INavigator } from 'oidc-client-ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthFailure,
  CognitoAuthClient,
  cognitoLogoutUrl,
  loadAuthConfig,
  validateAuthConfig,
} from './auth.js';

const config = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'client-public',
  domain: 'https://prompt-runner.auth.us-east-1.amazoncognito.com',
  redirectUri: 'https://d1ilpq1n58tzqo.cloudfront.net/',
  logoutUri: 'https://d1ilpq1n58tzqo.cloudfront.net/',
};

type UserInput = ConstructorParameters<typeof User>[0];
type UserOverrides = Omit<Partial<UserInput>, 'profile'> & {
  profile?: Partial<UserInput['profile']>;
};

function user(overrides: UserOverrides = {}) {
  const { profile, ...rest } = overrides;
  return new User({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    session_state: null,
    profile: {
      iss: config.issuer,
      aud: config.clientId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      sub: 'subject-a',
      email: 'a@example.com',
      ...profile,
    },
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ...rest,
  });
}

function userManagerForTest(overrides: Partial<ConstructorParameters<typeof UserManager>[0]> = {}) {
  const stateStore = new WebStorageStateStore({ store: window.sessionStorage });
  return new UserManager({
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email',
    extraQueryParams: { lang: 'es' },
    filterProtocolClaims: ['nbf', 'jti', 'auth_time', 'acr', 'amr', 'at_hash'],
    automaticSilentRenew: false,
    monitorSession: false,
    revokeTokensOnSignout: false,
    revokeTokenTypes: ['refresh_token'],
    requestTimeoutInSeconds: 10,
    stateStore,
    userStore: stateStore,
    metadata: {
      issuer: config.issuer,
      authorization_endpoint: `${config.domain}/oauth2/authorize`,
      token_endpoint: `${config.domain}/oauth2/token`,
      userinfo_endpoint: `${config.domain}/oauth2/userInfo`,
      revocation_endpoint: `${config.domain}/oauth2/revoke`,
    },
    ...overrides,
  });
}

function testNavigator(onNavigate: (url: string) => void): INavigator {
  return {
    prepare: async () => ({
      navigate: async ({ url }) => {
        onNavigate(url);
        return { url };
      },
      close: () => undefined,
    }),
    callback: async () => undefined,
  };
}

function testLocation() {
  return { href: `${config.redirectUri}?`, assign: vi.fn() } as unknown as Location;
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

function productionClientHarness(nonce: 'correct' | 'wrong' = 'correct') {
  let authorizationUrl = '';
  const redirectNavigator = testNavigator((url) => {
    authorizationUrl = url;
  });
  const providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify({
          issuer: config.issuer,
          authorization_endpoint: `${config.domain}/oauth2/authorize`,
          token_endpoint: `${config.domain}/oauth2/token`,
          userinfo_endpoint: `${config.domain}/oauth2/userInfo`,
          revocation_endpoint: `${config.domain}/oauth2/revoke`,
          jwks_uri: `${config.issuer}/.well-known/jwks.json`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url === `${config.domain}/oauth2/token`) {
      const requestedNonce = new URL(authorizationUrl).searchParams.get('nonce');
      return new Response(
        JSON.stringify({
          access_token: 'callback-access-token',
          refresh_token: 'callback-refresh-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: unsignedJwt({
            iss: config.issuer,
            sub: 'subject-a',
            aud: config.clientId,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
            nonce: nonce === 'correct' ? requestedNonce : 'wrong-nonce',
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url === `${config.domain}/oauth2/userInfo`) {
      return new Response(
        JSON.stringify({ sub: 'subject-a', email: 'a@example.com', email_verified: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected provider URL: ${url}`);
  });
  const client = new CognitoAuthClient(config, {
    storage: window.sessionStorage,
    location: testLocation(),
    redirectNavigator,
  });
  return { client, providerFetch, getAuthorizationUrl: () => authorizationUrl };
}

describe('auth configuration and Cognito boundaries', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('rejects missing, insecure, and slash-terminated public configuration', () => {
    expect(() => validateAuthConfig({})).toThrowError(AuthFailure);
    expect(() => validateAuthConfig({ ...config, domain: 'http://login.example.test' })).toThrow(
      'dominio',
    );
    expect(() => validateAuthConfig({ ...config, domain: `${config.domain}/` })).toThrow(
      'terminar en /',
    );
    expect(() => validateAuthConfig({ ...config, redirectUri: 'http://localhost:3000/' })).toThrow(
      'URL de retorno',
    );
    expect(() =>
      validateAuthConfig({ ...config, logoutUri: config.logoutUri.slice(0, -1) }),
    ).toThrow('URL de retorno');
  });

  it('reports an unavailable config without opening an OAuth redirect', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    await expect(loadAuthConfig(fetchImpl)).rejects.toMatchObject({ code: 'configuration' });
    expect(fetchImpl).toHaveBeenCalledWith('/auth-config.json', {
      headers: { Accept: 'application/json' },
    });
  });

  it('builds the Cognito logout endpoint with only the registered parameters', () => {
    const logout = new URL(cognitoLogoutUrl(config));
    expect(logout.pathname).toBe('/logout');
    expect([...logout.searchParams]).toEqual([
      ['client_id', config.clientId],
      ['logout_uri', config.logoutUri],
    ]);
  });

  it('uses oidc-client-ts to create code, state, nonce, and S256 PKCE parameters', async () => {
    const harness = productionClientHarness();

    await harness.client.beginLogin();

    const redirect = new URL(harness.getAuthorizationUrl());
    expect(redirect.origin).toBe(config.domain);
    expect(redirect.pathname).toBe('/oauth2/authorize');
    expect(redirect.searchParams.get('response_type')).toBe('code');
    expect(redirect.searchParams.get('client_id')).toBe(config.clientId);
    expect(redirect.searchParams.get('scope')).toBe('openid email');
    expect(redirect.searchParams.get('lang')).toBe('es');
    expect(redirect.searchParams.get('state')).toBeTruthy();
    expect(redirect.searchParams.get('nonce')).toBeTruthy();
    expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
    expect(redirect.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(window.sessionStorage.length).toBeGreaterThan(0);
    expect(harness.providerFetch.mock.calls[0]?.[0]).toBe(
      `${config.issuer}/.well-known/openid-configuration`,
    );
  });

  it('rejects an unrelated callback state before it can create a session', async () => {
    const harness = productionClientHarness();

    await harness.client.beginLogin();
    expect(harness.getAuthorizationUrl()).toBeTruthy();
    await expect(
      harness.client.initialize(`${config.redirectUri}?code=attacker-code&state=attacker-state`),
    ).rejects.toMatchObject({
      code: 'callback',
    });
    expect(harness.providerFetch).toHaveBeenCalledOnce();
  });

  it('completes a real library callback and checks the retained ID token nonce', async () => {
    const harness = productionClientHarness();

    await harness.client.beginLogin();
    const request = new URL(harness.getAuthorizationUrl());
    const nonce = request.searchParams.get('nonce');
    expect(nonce).toBeTruthy();

    const session = await harness.client.initialize(
      `${config.redirectUri}?code=callback-code&state=${encodeURIComponent(request.searchParams.get('state') ?? '')}`,
    );
    expect(session?.identity).toEqual({ sub: 'subject-a', email: 'a@example.com' });
    expect(harness.providerFetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${config.issuer}/.well-known/openid-configuration`,
      `${config.domain}/oauth2/token`,
      `${config.domain}/oauth2/userInfo`,
    ]);
    const tokenRequest = harness.providerFetch.mock.calls[1]?.[1];
    expect(String(tokenRequest?.body)).toContain('code_verifier=');
  });

  it('rejects a real callback when the ID token nonce does not match', async () => {
    const harness = productionClientHarness('wrong');

    await harness.client.beginLogin();
    const request = new URL(harness.getAuthorizationUrl());
    await expect(
      harness.client.initialize(
        `${config.redirectUri}?code=callback-code&state=${encodeURIComponent(request.searchParams.get('state') ?? '')}`,
      ),
    ).rejects.toMatchObject({ code: 'callback' });
    const storageKeys = Array.from({ length: window.sessionStorage.length }, (_, index) =>
      window.sessionStorage.key(index),
    );
    expect(storageKeys.some((key) => key?.startsWith('oidc.user:'))).toBe(false);
    const reloadedClient = new CognitoAuthClient(config, {
      storage: window.sessionStorage,
      location: testLocation(),
      redirectNavigator: testNavigator(() => undefined),
    });
    await expect(reloadedClient.initialize()).resolves.toBeNull();
    expect(harness.providerFetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${config.issuer}/.well-known/openid-configuration`,
      `${config.domain}/oauth2/token`,
    ]);
  });

  it('single-flights a callback under StrictMode-style duplicate effects', async () => {
    const manager = userManagerForTest();
    window.sessionStorage.setItem('prompt-runner.auth.nonce', 'nonce-once');
    const callback = vi
      .spyOn(manager, 'signinRedirectCallback')
      .mockResolvedValue(
        user({ profile: { sub: 'subject-a', email: 'a@example.com', nonce: 'nonce-once' } }),
      );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ sub: 'subject-a', email: 'a@example.com', email_verified: true }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const client = new CognitoAuthClient(config, { userManager: manager, fetch: fetchImpl });
    const url = `${config.redirectUri}?code=code-once&state=state-once`;

    await expect(
      Promise.all([client.initialize(url), client.initialize(url)]),
    ).resolves.toHaveLength(2);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('binds a native fetch transport before validating userInfo', async () => {
    const manager = userManagerForTest();
    await manager.storeUser(user());
    const nativeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ sub: 'subject-a', email: 'a@example.com', email_verified: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
    const client = new CognitoAuthClient(config, {
      userManager: manager,
      fetch: nativeFetch,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      identity: { sub: 'subject-a', email: 'a@example.com' },
    });
    expect(nativeFetch).toHaveBeenCalledWith(`${config.domain}/oauth2/userInfo`, {
      headers: { Authorization: 'Bearer access-token', Accept: 'application/json' },
    });
  });

  it('does not create a session from an unverified userInfo response', async () => {
    const manager = userManagerForTest();
    await manager.storeUser(user({ profile: { sub: 'subject-a', email: 'a@example.com' } }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ sub: 'subject-a', email: 'a@example.com', email_verified: 'false' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const client = new CognitoAuthClient(config, { userManager: manager, fetch: fetchImpl });

    await expect(client.initialize()).resolves.toBeNull();
    await expect(manager.getUser()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([true, 'true'] as const)(
    'accepts only the documented verified values: %s',
    async (verified) => {
      const manager = userManagerForTest();
      await manager.storeUser(user());
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ sub: 'subject-a', email: 'a@example.com', email_verified: verified }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
      const client = new CognitoAuthClient(config, { userManager: manager, fetch: fetchImpl });

      await expect(client.initialize()).resolves.toMatchObject({
        identity: { sub: 'subject-a', email: 'a@example.com' },
      });
    },
  );

  it('rejects a mismatching sub and never trusts the cached profile', async () => {
    const manager = userManagerForTest();
    await manager.storeUser(user());
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ sub: 'subject-b', email: 'b@example.com', email_verified: true }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const client = new CognitoAuthClient(config, { userManager: manager, fetch: fetchImpl });

    await expect(client.initialize()).resolves.toBeNull();
    await expect(manager.getUser()).resolves.toBeNull();
  });

  it('refreshes an expired access token and validates the new userInfo', async () => {
    const manager = userManagerForTest();
    await manager.storeUser(user({ expires_at: Math.floor(Date.now() / 1000) - 1 }));
    const refresh = vi
      .spyOn(manager, 'signinSilent')
      .mockResolvedValue(user({ expires_at: Math.floor(Date.now() / 1000) + 300 }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ sub: 'subject-a', email: 'a@example.com', email_verified: true }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const client = new CognitoAuthClient(config, { userManager: manager, fetch: fetchImpl });

    await expect(client.initialize()).resolves.toMatchObject({ identity: { sub: 'subject-a' } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps a session pending when the refresh endpoint returns a transient 503', async () => {
    const manager = userManagerForTest();
    await manager.storeUser(user({ expires_at: Math.floor(Date.now() / 1000) - 1 }));
    const providerFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'service_unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            token_type: 'Bearer',
            expires_in: 300,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ sub: 'subject-a', email: 'a@example.com', email_verified: true }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const client = new CognitoAuthClient(config, { userManager: manager, fetch: fetchImpl });

    await expect(client.initialize()).rejects.toMatchObject({ code: 'network' });
    await expect(manager.getUser()).resolves.not.toBeNull();
    await expect(client.initialize()).resolves.toMatchObject({ identity: { sub: 'subject-a' } });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the user signed out when refresh is rejected and surfaces remote logout failure for retry', async () => {
    const manager = userManagerForTest();
    await manager.storeUser(user({ expires_at: Math.floor(Date.now() / 1000) - 1 }));
    vi.spyOn(manager, 'signinSilent').mockRejectedValue(new Error('invalid_grant'));
    const client = new CognitoAuthClient(config, { userManager: manager, fetch: vi.fn() });
    await expect(client.initialize()).resolves.toBeNull();

    const logoutManager = userManagerForTest();
    await logoutManager.storeUser(user());
    vi.spyOn(logoutManager, 'revokeTokens').mockRejectedValueOnce(new Error('offline'));
    const location = testLocation();
    const logoutClient = new CognitoAuthClient(config, {
      userManager: logoutManager,
      location,
    });
    await expect(logoutClient.logout()).rejects.toMatchObject({ code: 'logout' });
    await expect(logoutManager.getUser()).resolves.toBeNull();
    expect(location.assign).toHaveBeenCalledOnce();
    const reloadedClient = new CognitoAuthClient(config, {
      userManager: logoutManager,
      location,
    });
    await expect(reloadedClient.initialize()).rejects.toMatchObject({ code: 'logout' });
  });

  it('classifies a userInfo network error as recoverable and does not show cached identity', async () => {
    const manager = userManagerForTest();
    await manager.storeUser(user());
    const client = new CognitoAuthClient(config, {
      userManager: manager,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')),
    });

    await expect(client.initialize()).rejects.toMatchObject({ code: 'network' });
    await expect(manager.getUser()).resolves.not.toBeNull();
  });
});
