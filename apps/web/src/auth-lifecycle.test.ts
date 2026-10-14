// @vitest-environment jsdom

import { User, UserManager, WebStorageStateStore, type INavigator } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitoAuthClient, type AuthConfig } from './auth.js';

const config: AuthConfig = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'client-public',
  domain: 'https://prompt-runner.auth.us-east-1.amazoncognito.com',
  redirectUri: 'https://robotrunner.guilleojeda.com/jugar',
  logoutUri: 'https://robotrunner.guilleojeda.com/',
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};
const metadata = {
  issuer: config.issuer,
  authorization_endpoint: `${config.domain}/oauth2/authorize`,
  token_endpoint: `${config.domain}/oauth2/token`,
  userinfo_endpoint: `${config.domain}/oauth2/userInfo`,
  revocation_endpoint: `${config.domain}/oauth2/revoke`,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function user(accessToken = 'old-token', expired = true) {
  return new User({
    access_token: accessToken,
    refresh_token: 'old-refresh-token',
    token_type: 'Bearer',
    scope: `openid email ${config.apiScope}`,
    session_state: null,
    expires_at: Math.floor(Date.now() / 1000) + (expired ? -1 : 300),
    profile: {
      iss: config.issuer,
      aud: config.clientId,
      sub: 'subject-a',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    },
  });
}
function unsignedJwt(payload: unknown) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}
function refreshedToken() {
  return json({
    access_token: 'refreshed-token',
    refresh_token: 'refreshed-refresh-token',
    token_type: 'Bearer',
    expires_in: 300,
  });
}

function harness(injected = false) {
  const store = new WebStorageStateStore({ store: window.sessionStorage });
  const refresh = deferred<Response>();
  const callback = deferred<Response>();
  const revocation = deferred<Response>();
  const validation = deferred<Response>();
  let holdCallback = false;
  let holdRevocation = false;
  let holdValidation: string | undefined;
  const redirects: URL[] = [];
  const navigator: INavigator = {
    prepare: async () => ({
      navigate: async ({ url }) => {
        redirects.push(new URL(url));
        return { url };
      },
      close: () => undefined,
    }),
    callback: async () => undefined,
  };
  const manager = new UserManager(
    {
      authority: config.issuer,
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: `openid email ${config.apiScope}`,
      stateStore: store,
      userStore: store,
      automaticSilentRenew: false,
      monitorSession: false,
      filterProtocolClaims: ['nbf', 'jti', 'auth_time', 'acr', 'amr', 'at_hash'],
      metadata,
    },
    navigator,
  );
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) return json(metadata);
    if (url === metadata.token_endpoint) {
      const params = new URLSearchParams(String(init?.body));
      if (params.get('grant_type') === 'refresh_token') return refresh.promise;
      if (holdCallback) return callback.promise;
      return callbackToken(params.get('code') ?? 'new-login', redirects.at(-1)!);
    }
    if (url === metadata.revocation_endpoint) {
      return holdRevocation ? revocation.promise : json({}, 503);
    }
    if (url === metadata.userinfo_endpoint) {
      const authorization = new Headers(init?.headers).get('Authorization');
      if (authorization === `Bearer ${holdValidation}`) return validation.promise;
      return json({ sub: 'subject-a', email: 'a@example.com', email_verified: true });
    }
    throw new Error(`Unexpected local provider request: ${url}`);
  });
  const location = { href: config.redirectUri, assign: vi.fn() } as unknown as Location;
  const client = () =>
    new CognitoAuthClient(config, {
      storage: window.sessionStorage,
      location,
      redirectNavigator: navigator,
      ...(injected ? { userManager: manager } : {}),
    });
  function callbackToken(code: string, request: URL) {
    return json({
      access_token: `${code}-token`,
      refresh_token: `${code}-refresh-token`,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: unsignedJwt({
        iss: config.issuer,
        aud: config.clientId,
        sub: 'subject-a',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: request.searchParams.get('nonce'),
      }),
    });
  }
  function callbackUrl(code = 'new-login', request = redirects.at(-1)!) {
    return `${config.redirectUri}?code=${code}&state=${request.searchParams.get('state')}`;
  }
  async function waitForRequest(
    endpoint: string,
    match: (init?: RequestInit) => boolean = () => true,
  ) {
    await vi.waitFor(() => {
      expect(
        transport.mock.calls.some(([url, init]) => String(url) === endpoint && match(init)),
      ).toBe(true);
    });
  }
  return {
    manager,
    client,
    transport,
    location,
    refresh,
    callback,
    revocation,
    validation,
    redirects,
    callbackToken,
    callbackUrl,
    waitForRequest,
    holdCallback: () => {
      holdCallback = true;
    },
    holdRevocation: () => {
      holdRevocation = true;
    },
    holdValidation: (token: string) => {
      holdValidation = token;
    },
  };
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe.each([false, true])('OIDC acquisition invalidation (injected manager: %s)', (injected) => {
  it('keeps logout local after late refresh and failed remote revocation', async () => {
    const h = harness(injected);
    await h.manager.storeUser(user());
    const client = h.client();
    const renewal = client.initialize();
    await h.waitForRequest(metadata.token_endpoint);
    await expect(client.logout()).rejects.toMatchObject({ code: 'logout' });
    expect(await h.manager.getUser()).toBeNull();
    expect(h.location.assign).toHaveBeenCalledOnce();
    h.refresh.resolve(refreshedToken());
    await expect(renewal).resolves.toBeNull();
    expect(await h.manager.getUser()).toBeNull();
    const reloaded = h.client();
    await expect(reloaded.initialize()).rejects.toMatchObject({ code: 'logout' });
    await expect(reloaded.initialize()).resolves.toBeNull();
  });

  it('still clears a refresh that completed before logout', async () => {
    const h = harness(injected);
    await h.manager.storeUser(user());
    const client = h.client();
    const renewal = client.initialize();
    h.refresh.resolve(refreshedToken());
    await expect(renewal).resolves.toMatchObject({ user: { access_token: 'refreshed-token' } });
    await expect(client.logout()).rejects.toMatchObject({ code: 'logout' });
    expect(await h.manager.getUser()).toBeNull();
  });

  it.each(['success', 'invalid-grant'])(
    'preserves a newer deliberate login after late refresh %s',
    async (outcome) => {
      const h = harness(injected);
      await h.manager.storeUser(user());
      const client = h.client();
      const renewal = client.initialize();
      await h.waitForRequest(metadata.token_endpoint);
      await expect(client.logout()).rejects.toMatchObject({ code: 'logout' });
      const newerClient = h.client();
      await newerClient.beginLogin();
      await expect(newerClient.initialize(h.callbackUrl())).resolves.toMatchObject({
        user: { access_token: 'new-login-token' },
      });
      h.refresh.resolve(
        outcome === 'success' ? refreshedToken() : json({ error: 'invalid_grant' }, 400),
      );
      await expect(renewal).resolves.toBeNull();
      expect(await h.manager.getUser()).toMatchObject({ access_token: 'new-login-token' });
    },
  );

  it('does not clear or navigate away from a login newer than pending logout revocation', async () => {
    const h = harness(injected);
    await h.manager.storeUser(user('old-token', false));
    h.holdRevocation();
    const client = h.client();
    const logout = client.logout();
    await h.waitForRequest(metadata.revocation_endpoint);
    expect(await h.manager.getUser()).toBeNull();
    const newerClient = h.client();
    await newerClient.beginLogin();
    await newerClient.initialize(h.callbackUrl());
    h.revocation.resolve(json({}));
    await logout;
    expect(await h.manager.getUser()).toMatchObject({ access_token: 'new-login-token' });
    expect(h.location.assign).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner.auth.logout-warning')).toBeNull();
  });

  it('does not publish a callback whose token exchange completes after logout', async () => {
    const h = harness(injected);
    const client = h.client();
    await client.beginLogin();
    const request = h.redirects.at(-1)!;
    h.holdCallback();
    const pending = client.initialize(h.callbackUrl('old-login', request));
    await h.waitForRequest(metadata.token_endpoint);
    await client.logout();
    h.callback.resolve(h.callbackToken('old-login', request));
    await expect(pending).resolves.toBeNull();
    expect(await h.manager.getUser()).toBeNull();
    await expect(client.initialize(h.callbackUrl('old-login', request))).resolves.toBeNull();
  });

  it('rejects an old callback started after a newer login without touching its credentials or nonce', async () => {
    const h = harness(injected);
    const oldClient = h.client();
    await oldClient.beginLogin();
    const oldUrl = h.callbackUrl('old-login');
    await oldClient.logout();
    const newerClient = h.client();
    await newerClient.beginLogin();
    const newNonce = window.sessionStorage.getItem('prompt-runner.auth.nonce');
    const calls = h.transport.mock.calls.length;
    await expect(oldClient.initialize(oldUrl)).resolves.toBeNull();
    expect(h.transport.mock.calls).toHaveLength(calls);
    expect(window.sessionStorage.getItem('prompt-runner.auth.nonce')).toBe(newNonce);
    await newerClient.initialize(h.callbackUrl());
    await expect(h.client().initialize(oldUrl)).resolves.toBeNull();
    expect(await h.manager.getUser()).toMatchObject({ access_token: 'new-login-token' });
  });

  it.each(['restore', 'callback'])(
    'ignores late rejected userInfo from %s after a newer login',
    async (kind) => {
      const h = harness(injected);
      const client = h.client();
      let url: string | undefined;
      if (kind === 'restore') await h.manager.storeUser(user('old-token', false));
      else {
        await client.beginLogin();
        url = h.callbackUrl('old-login');
      }
      h.holdValidation(kind === 'restore' ? 'old-token' : 'old-login-token');
      const pending = client.initialize(url);
      await h.waitForRequest(metadata.userinfo_endpoint);
      await client.logout().catch(() => undefined);
      const newerClient = h.client();
      await newerClient.beginLogin();
      await newerClient.initialize(h.callbackUrl());
      h.validation.resolve(json({}, 403));
      await expect(pending).resolves.toBeNull();
      expect(await h.manager.getUser()).toMatchObject({ access_token: 'new-login-token' });
    },
  );

  it('retains refreshed credentials for a transient userInfo retry without refreshing twice', async () => {
    const h = harness(injected);
    await h.manager.storeUser(user());
    h.holdValidation('refreshed-token');
    const client = h.client();
    const renewal = client.initialize();
    h.refresh.resolve(refreshedToken());
    await h.waitForRequest(metadata.userinfo_endpoint);
    h.validation.reject(new TypeError('Failed to fetch'));
    await expect(renewal).rejects.toMatchObject({ code: 'network' });
    expect(await h.manager.getUser()).toMatchObject({ access_token: 'refreshed-token' });
    h.holdValidation('unused-token');
    await expect(client.initialize()).resolves.toMatchObject({
      user: { access_token: 'refreshed-token' },
    });
    expect(
      h.transport.mock.calls.filter(([url]) => String(url) === metadata.token_endpoint),
    ).toHaveLength(1);
  });

  it('retains a current callback for a transient userInfo retry without exchanging its code twice', async () => {
    const h = harness(injected);
    const client = h.client();
    await client.beginLogin();
    h.holdValidation('new-login-token');
    const pending = client.initialize(h.callbackUrl());
    await h.waitForRequest(metadata.userinfo_endpoint);
    h.validation.reject(new TypeError('Failed to fetch'));
    await expect(pending).rejects.toMatchObject({ code: 'network' });
    expect(await h.manager.getUser()).toMatchObject({ access_token: 'new-login-token' });
    h.holdValidation('unused-token');
    await expect(h.client().initialize()).resolves.toMatchObject({
      user: { access_token: 'new-login-token' },
    });
    expect(
      h.transport.mock.calls.filter(([url]) => String(url) === metadata.token_endpoint),
    ).toHaveLength(1);
  });

  it('accepts a valid authorization transaction created before generation tracking was present', async () => {
    const h = harness(injected);
    window.sessionStorage.setItem('prompt-runner.auth.nonce', 'legacy-nonce');
    await h.manager.signinRedirect({ nonce: 'legacy-nonce' });
    await expect(h.client().initialize(h.callbackUrl('legacy-login'))).resolves.toMatchObject({
      user: { access_token: 'legacy-login-token' },
    });
  });
});
