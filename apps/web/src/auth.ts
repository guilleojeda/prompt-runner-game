import {
  UserManager,
  WebStorageStateStore,
  type INavigator,
  type User,
  type UserManagerSettings,
} from 'oidc-client-ts';

export interface AuthConfig {
  issuer: string;
  clientId: string;
  domain: string;
  redirectUri: string;
  logoutUri: string;
}

export interface AuthIdentity {
  sub: string;
  email: string;
}

export interface AuthSession {
  identity: AuthIdentity;
  user: User;
}

export type AuthFailureCode =
  'configuration' | 'callback' | 'identity' | 'network' | 'session' | 'logout';

export class AuthFailure extends Error {
  public constructor(
    public readonly code: AuthFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AuthFailure';
  }
}

export interface AuthClient {
  initialize(url?: string): Promise<AuthSession | null>;
  beginLogin(): Promise<void>;
  logout(): Promise<void>;
}

export interface AuthClientOptions {
  fetch?: typeof globalThis.fetch;
  storage?: Storage;
  location?: Location;
  userManager?: UserManager;
  redirectNavigator?: INavigator;
}

const NONCE_STORAGE_KEY = 'prompt-runner.auth.nonce';
const LOGOUT_WARNING_STORAGE_KEY = 'prompt-runner.auth.logout-warning';

const CONFIG_KEYS: readonly (keyof AuthConfig)[] = [
  'issuer',
  'clientId',
  'domain',
  'redirectUri',
  'logoutUri',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isSecureOrLocalhost(url: URL): boolean {
  return url.protocol === 'https:' || url.href === 'http://localhost:5173/';
}

/** Validate the public contract before any identifier can reach the OIDC library. */
export function validateAuthConfig(value: unknown): AuthConfig {
  if (!isRecord(value)) {
    throw new AuthFailure('configuration', 'La configuración de acceso no es válida.');
  }

  for (const key of CONFIG_KEYS) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new AuthFailure('configuration', 'La configuración de acceso está incompleta.');
    }
  }

  const config = value as unknown as AuthConfig;
  const issuer = isAbsoluteUrl(config.issuer);
  const domain = isAbsoluteUrl(config.domain);
  const redirectUri = isAbsoluteUrl(config.redirectUri);
  const logoutUri = isAbsoluteUrl(config.logoutUri);

  if (!issuer || issuer.protocol !== 'https:' || issuer.search || issuer.hash) {
    throw new AuthFailure('configuration', 'El emisor de acceso no es una URL HTTPS válida.');
  }
  if (
    !domain ||
    domain.protocol !== 'https:' ||
    domain.pathname !== '/' ||
    domain.search ||
    domain.hash
  ) {
    throw new AuthFailure('configuration', 'El dominio de acceso no es válido.');
  }
  if (config.domain.endsWith('/')) {
    throw new AuthFailure('configuration', 'El dominio de acceso no debe terminar en /.');
  }
  if (
    !redirectUri ||
    !logoutUri ||
    !isSecureOrLocalhost(redirectUri) ||
    !isSecureOrLocalhost(logoutUri) ||
    !config.redirectUri.endsWith('/') ||
    !config.logoutUri.endsWith('/') ||
    redirectUri.pathname !== '/' ||
    logoutUri.pathname !== '/' ||
    redirectUri.origin !== logoutUri.origin ||
    redirectUri.search ||
    redirectUri.hash ||
    logoutUri.search ||
    logoutUri.hash
  ) {
    throw new AuthFailure('configuration', 'La URL de retorno de acceso no es válida.');
  }

  return {
    issuer: config.issuer,
    clientId: config.clientId,
    domain: config.domain,
    redirectUri: config.redirectUri,
    logoutUri: config.logoutUri,
  };
}

export async function loadAuthConfig(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  endpoint = '/auth-config.json',
): Promise<AuthConfig> {
  let response: Response;
  try {
    response = await bindFetch(fetchImpl)(endpoint, { headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new AuthFailure('configuration', 'No se pudo cargar la configuración de acceso.', {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new AuthFailure('configuration', 'La configuración de acceso no está disponible.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AuthFailure('configuration', 'La configuración de acceso no contiene JSON válido.', {
      cause: error,
    });
  }

  return validateAuthConfig(body);
}

function validVerifiedEmail(value: unknown): value is true | 'true' {
  return value === true || value === 'true';
}

function identityFromClaims(claims: unknown, expectedSub?: string): AuthIdentity {
  if (!isRecord(claims) || typeof claims.sub !== 'string' || claims.sub.trim() === '') {
    throw new AuthFailure('identity', 'Cognito no devolvió una identidad válida.');
  }
  if (expectedSub !== undefined && claims.sub !== expectedSub) {
    throw new AuthFailure('identity', 'La identidad de la sesión no coincide.');
  }
  if (typeof claims.email !== 'string' || claims.email.trim() === '') {
    throw new AuthFailure('identity', 'La cuenta no tiene un email válido.');
  }
  if (!validVerifiedEmail(claims.email_verified)) {
    throw new AuthFailure('identity', 'Confirmá tu email antes de entrar al juego.');
  }
  return { sub: claims.sub, email: claims.email };
}

function callbackKey(url: string): string | null {
  const parsed = new URL(url, globalThis.location?.origin ?? 'http://localhost:5173');
  const params = parsed.searchParams;
  if (!params.has('code') && !params.has('error')) {
    return null;
  }
  return `${params.get('state') ?? ''}:${params.get('code') ?? ''}:${params.get('error') ?? ''}`;
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof AuthFailure) {
    return error.code === 'network';
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (isRecord(error)) {
    const details = [error.message, error.error, error.error_description]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    return /network|fetch|timeout|temporar|failed to fetch|service[_ -]?unavailable|server[_ -]?error|rate limit|throttl|\b(?:429|500|502|503|504)\b/i.test(
      details,
    );
  }
  return false;
}

function authFailure(error: unknown, fallback: string, code: AuthFailureCode): AuthFailure {
  if (error instanceof AuthFailure) {
    return error;
  }
  return new AuthFailure(code, fallback, { cause: error });
}

export function cognitoLogoutUrl(config: AuthConfig): string {
  const params = new URLSearchParams({ client_id: config.clientId, logout_uri: config.logoutUri });
  return `${config.domain}/logout?${params.toString()}`;
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function bindFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return fetchImpl.bind(globalThis);
}

function createNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function managerSettings(config: AuthConfig, storage: Storage): UserManagerSettings {
  const stateStore = new WebStorageStateStore({ store: storage });

  return {
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.logoutUri,
    response_type: 'code',
    scope: 'openid email',
    extraQueryParams: { lang: 'es' },
    // oidc-client-ts removes nonce from the cached profile by default; retain it so the
    // callback can compare the ID token nonce with the one generated for this transaction.
    filterProtocolClaims: ['nbf', 'jti', 'auth_time', 'acr', 'amr', 'at_hash'],
    stateStore,
    userStore: stateStore,
    loadUserInfo: false,
    automaticSilentRenew: false,
    monitorSession: false,
    revokeTokensOnSignout: false,
    revokeTokenTypes: ['refresh_token'],
    requestTimeoutInSeconds: 10,
  };
}

export class CognitoAuthClient implements AuthClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly location: Location | undefined;
  private readonly manager: UserManager;
  private readonly callbackResults = new Map<string, Promise<AuthSession>>();
  private readonly config: AuthConfig;
  private readonly storage: Storage | undefined;

  public constructor(config: AuthConfig, options: AuthClientOptions = {}) {
    this.config = validateAuthConfig(config);
    this.fetchImpl = bindFetch(options.fetch ?? globalThis.fetch);
    this.location = options.location ?? globalThis.location;
    const storage = options.storage ?? defaultStorage();
    this.storage = storage;
    if (!options.userManager && !storage) {
      throw new AuthFailure(
        'configuration',
        'Este navegador no permite guardar la sesión de acceso. Habilitá sessionStorage e intentá de nuevo.',
      );
    }
    this.manager =
      options.userManager ??
      new UserManager(managerSettings(this.config, storage as Storage), options.redirectNavigator);
  }

  public async initialize(
    url = this.location?.href ?? this.config.redirectUri,
  ): Promise<AuthSession | null> {
    const key = callbackKey(url);
    if (key) {
      const existing = this.callbackResults.get(key);
      if (existing) {
        return existing;
      }
      const result = this.consumeCallback(url);
      this.callbackResults.set(key, result);
      return result;
    }
    return this.restoreSession();
  }

  public async beginLogin(): Promise<void> {
    this.storage?.removeItem(LOGOUT_WARNING_STORAGE_KEY);
    if (!this.storage) {
      throw new AuthFailure(
        'configuration',
        'Este navegador no permite guardar la transacción de acceso. Habilitá sessionStorage e intentá de nuevo.',
      );
    }
    const nonce = createNonce();
    this.storage.setItem(NONCE_STORAGE_KEY, nonce);
    try {
      await this.manager.signinRedirect({ nonce });
    } catch (error) {
      this.storage.removeItem(NONCE_STORAGE_KEY);
      throw authFailure(error, 'No se pudo iniciar el acceso. Intentá de nuevo.', 'network');
    }
  }

  public async logout(): Promise<void> {
    const user = await this.manager.getUser();
    let remoteRevocationFailed = false;
    if (user?.refresh_token) {
      try {
        await this.manager.revokeTokens(['refresh_token']);
      } catch {
        remoteRevocationFailed = true;
      }
    }

    await this.manager.removeUser();
    if (remoteRevocationFailed) {
      this.storage?.setItem(LOGOUT_WARNING_STORAGE_KEY, '1');
      this.navigateToCognitoLogout();
      throw new AuthFailure(
        'logout',
        'Se cerró la sesión local, pero no se pudo completar el cierre remoto.',
      );
    }

    this.navigateToCognitoLogout();
  }

  private async consumeCallback(url: string): Promise<AuthSession> {
    let callbackUser: User | null = null;
    try {
      callbackUser = await this.manager.signinRedirectCallback(url);
      const nonce = this.storage?.getItem(NONCE_STORAGE_KEY);
      if (!nonce || callbackUser.profile.nonce !== nonce) {
        throw new AuthFailure('callback', 'La respuesta de acceso no pudo validarse.');
      }
      const session = await this.validateSession(callbackUser);
      this.storage?.removeItem(NONCE_STORAGE_KEY);
      this.clearCallbackUrl();
      return session;
    } catch (error) {
      if (callbackUser && !(error instanceof AuthFailure && error.code === 'network')) {
        await this.manager.removeUser();
      }
      this.storage?.removeItem(NONCE_STORAGE_KEY);
      this.clearCallbackUrl();
      throw authFailure(error, 'No se pudo completar el acceso. Volvé a intentarlo.', 'callback');
    }
  }

  private async restoreSession(): Promise<AuthSession | null> {
    if (this.storage?.getItem(LOGOUT_WARNING_STORAGE_KEY)) {
      this.storage.removeItem(LOGOUT_WARNING_STORAGE_KEY);
      throw new AuthFailure(
        'logout',
        'La sesión local se cerró, pero el proveedor no confirmó la revocación remota.',
      );
    }
    let user: User | null;
    try {
      user = await this.manager.getUser();
    } catch (error) {
      throw authFailure(error, 'No se pudo recuperar la sesión.', 'session');
    }
    if (!user) {
      return null;
    }

    if (user.expired) {
      if (!user.refresh_token) {
        await this.manager.removeUser();
        return null;
      }
      try {
        user = await this.manager.signinSilent();
      } catch (error) {
        if (isTransientFailure(error)) {
          throw new AuthFailure(
            'network',
            'No se pudo renovar la sesión. Revisá tu conexión e intentá de nuevo.',
            {
              cause: error,
            },
          );
        }
        await this.manager.removeUser();
        return null;
      }
    }

    if (!user) {
      await this.manager.removeUser();
      return null;
    }

    try {
      return await this.validateSession(user);
    } catch (error) {
      if (isTransientFailure(error)) {
        throw authFailure(error, 'No se pudo validar la sesión. Intentá de nuevo.', 'network');
      }
      await this.manager.removeUser();
      return null;
    }
  }

  private async validateSession(user: User): Promise<AuthSession> {
    if (!user.access_token) {
      throw new AuthFailure('identity', 'La sesión no tiene un token de acceso.');
    }
    if (typeof user.profile.sub !== 'string' || user.profile.sub.trim() === '') {
      throw new AuthFailure('identity', 'La sesión no tiene una identidad válida.');
    }
    let claims: unknown;
    try {
      const endpoint = await this.manager.metadataService.getUserInfoEndpoint();
      const response = await this.fetchImpl(endpoint, {
        headers: { Authorization: `Bearer ${user.access_token}`, Accept: 'application/json' },
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AuthFailure('identity', 'La sesión ya no es válida.');
        }
        throw new AuthFailure('network', 'No se pudo validar la cuenta.');
      }
      claims = await response.json();
    } catch (error) {
      if (error instanceof AuthFailure) {
        throw error;
      }
      throw new AuthFailure('network', 'No se pudo validar la cuenta.', { cause: error });
    }

    return { user, identity: identityFromClaims(claims, user.profile.sub) };
  }

  private clearCallbackUrl(): void {
    if (!this.location || typeof history === 'undefined') {
      return;
    }
    const current = new URL(this.location.href);
    if (!current.searchParams.has('code') && !current.searchParams.has('error')) {
      return;
    }
    current.search = '';
    current.hash = '';
    history.replaceState({}, document.title, current.toString());
  }

  private navigateToCognitoLogout(): void {
    this.location?.assign(cognitoLogoutUrl(this.config));
  }
}

export function createAuthClient(config: AuthConfig, options?: AuthClientOptions): AuthClient {
  return new CognitoAuthClient(config, options);
}
