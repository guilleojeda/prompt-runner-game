import { validateDraft, type DraftSnapshot, type RobotDraft } from '../../../shared/robot.js';
import type { AuthConfig } from './auth.js';

export type DraftApiFailureCode =
  'authentication' | 'conflict' | 'invalid' | 'too_large' | 'network' | 'server';

export class DraftApiFailure extends Error {
  public constructor(
    public readonly code: DraftApiFailureCode,
    message: string,
    public readonly status?: number,
    public readonly current?: DraftSnapshot,
    public readonly ambiguous = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DraftApiFailure';
  }
}

export interface DraftApi {
  getDraft(signal?: AbortSignal): Promise<DraftSnapshot>;
  putDraft(
    expectedVersion: number,
    draft: RobotDraft,
    signal?: AbortSignal,
  ): Promise<DraftSnapshot>;
}

export type DraftTokenProvider = () => string | Promise<string>;

export interface DraftApiClientOptions {
  fetch?: typeof globalThis.fetch;
  tokenProvider: DraftTokenProvider;
}

function bindFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return fetchImpl.bind(globalThis);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDraftSnapshot(value: unknown): DraftSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 0 ||
    (value.updatedAt !== undefined && typeof value.updatedAt !== 'string')
  ) {
    return null;
  }
  try {
    return {
      version: value.version,
      ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
      draft: validateDraft(value.draft),
    };
  } catch {
    return null;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.message === 'string' && body.message.trim() !== '') {
    return body.message;
  }
  return fallback;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export class DraftApiClient implements DraftApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly tokenProvider: DraftTokenProvider;

  public constructor(config: Pick<AuthConfig, 'apiBaseUrl'>, options: DraftApiClientOptions) {
    this.baseUrl = config.apiBaseUrl.endsWith('/') ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
    this.fetchImpl = bindFetch(options.fetch ?? globalThis.fetch);
    this.tokenProvider = options.tokenProvider;
  }

  public getDraft(signal?: AbortSignal): Promise<DraftSnapshot> {
    return this.request('GET', undefined, signal);
  }

  public putDraft(
    expectedVersion: number,
    draft: RobotDraft,
    signal?: AbortSignal,
  ): Promise<DraftSnapshot> {
    return this.request('PUT', { expectedVersion, draft }, signal);
  }

  private async request(
    method: 'GET' | 'PUT',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<DraftSnapshot> {
    let token: string;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      throw new DraftApiFailure(
        'authentication',
        'La sesión no tiene un token de acceso.',
        undefined,
        undefined,
        false,
        {
          cause: error,
        },
      );
    }
    if (!token) {
      throw new DraftApiFailure('authentication', 'La sesión no tiene un token de acceso.');
    }

    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    };
    if (signal) {
      init.signal = signal;
    }
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}draft`, init);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new DraftApiFailure(
        'network',
        method === 'PUT'
          ? 'No se confirmó la respuesta del guardado. Revisá la configuración guardada.'
          : 'No se pudo cargar la configuración. Revisá tu conexión.',
        undefined,
        undefined,
        method === 'PUT',
        { cause: error },
      );
    }

    const parsed = await readBody(response);
    if (response.ok) {
      const snapshot = parseDraftSnapshot(parsed);
      if (!snapshot) {
        throw new DraftApiFailure(
          'server',
          method === 'PUT'
            ? 'No se confirmó la respuesta del guardado. Comprobando la configuración guardada…'
            : 'La API devolvió una configuración inválida.',
          response.status,
          undefined,
          method === 'PUT',
        );
      }
      return snapshot;
    }

    if (response.status === 401 || response.status === 403) {
      throw new DraftApiFailure(
        'authentication',
        'Tu sesión no tiene acceso a la configuración. Volvé a ingresar para actualizarla.',
        response.status,
      );
    }
    if (response.status === 409) {
      const current = isRecord(parsed)
        ? (parseDraftSnapshot(parsed.current) ?? undefined)
        : undefined;
      throw new DraftApiFailure(
        'conflict',
        errorMessage(parsed, 'La configuración cambió en otra pestaña.'),
        response.status,
        current,
      );
    }
    if (response.status === 413) {
      throw new DraftApiFailure(
        'too_large',
        errorMessage(parsed, 'La configuración supera el límite permitido.'),
        response.status,
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new DraftApiFailure(
        'invalid',
        errorMessage(parsed, 'La configuración no pudo guardarse.'),
        response.status,
      );
    }
    throw new DraftApiFailure(
      'server',
      errorMessage(
        parsed,
        method === 'PUT'
          ? 'No se confirmó el guardado. Podés reintentar sin perder tus cambios.'
          : 'No se pudo cargar la configuración. Podés reintentar.',
      ),
      response.status,
      undefined,
      method === 'PUT',
    );
  }
}

export function createDraftApiClient(
  config: Pick<AuthConfig, 'apiBaseUrl'>,
  tokenProvider: DraftTokenProvider,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): DraftApi {
  return new DraftApiClient(config, { tokenProvider, fetch: fetchImpl });
}
