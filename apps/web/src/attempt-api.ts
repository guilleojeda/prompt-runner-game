import type { RobotDraft } from '../../../shared/robot.js';
import type { AttemptStatus, AttemptSummary } from '../../../shared/attempt.js';
import { isModelKey, type ModelKey } from '../../../shared/models.js';
import type { AuthConfig } from './auth.js';

export type { AttemptStatus, AttemptSummary } from '../../../shared/attempt.js';

export interface AttemptsPage {
  readonly attempts: readonly AttemptSummary[];
  readonly nextCursor?: string;
}

export interface QuotaSummary {
  readonly day: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resetsAt: string;
}

export interface AttemptAdmission {
  readonly attempt: AttemptSummary;
  readonly dispatchConfirmed: boolean;
}

export interface AttemptApi {
  createAttempt(
    requestKey: string,
    expectedVersion: number,
    draft: RobotDraft,
    signal?: AbortSignal,
  ): Promise<AttemptAdmission>;
  getAttemptRequest(requestKey: string, signal?: AbortSignal): Promise<AttemptSummary>;
  getAttempt(id: string, signal?: AbortSignal): Promise<AttemptSummary>;
  listAttempts(cursor?: string, signal?: AbortSignal): Promise<AttemptsPage>;
  startAttempt(id: string, signal?: AbortSignal): Promise<AttemptAdmission>;
  cancelAttempt(id: string, signal?: AbortSignal): Promise<AttemptSummary>;
  getQuota(signal?: AbortSignal): Promise<QuotaSummary>;
}

export type AttemptApiFailureCode =
  'authentication' | 'conflict' | 'quota_exceeded' | 'not_found' | 'invalid' | 'network' | 'server';

export class AttemptApiFailure extends Error {
  public constructor(
    public readonly code: AttemptApiFailureCode,
    message: string,
    public readonly status?: number,
    public readonly ambiguous = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AttemptApiFailure';
  }
}

export type AttemptTokenProvider = () => string | Promise<string>;

export interface AttemptApiClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly tokenProvider: AttemptTokenProvider;
}

const attemptStatuses: readonly AttemptStatus[] = [
  'pending',
  'running',
  'victory',
  'defeat',
  'incomplete',
  'cancelled',
  'error',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === 'string' && record[key].length > 0 ? record[key] : null;

const requiredNumber = (record: Record<string, unknown>, key: string): number | null =>
  typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : null;

const nullableNumber = (
  record: Record<string, unknown>,
  key: string,
): number | null | undefined => {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  return value === null
    ? null
    : typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
};

function parseAttempt(value: unknown): AttemptSummary | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value, 'id');
  const createdAt = requiredString(value, 'createdAt');
  const updatedAt = requiredString(value, 'updatedAt');
  const levelId = requiredString(value, 'levelId');
  const status = value.status;
  const turnsUsed = requiredNumber(value, 'turnsUsed');
  const maxTurns = requiredNumber(value, 'maxTurns');
  const calls = requiredNumber(value, 'calls');
  const progress = requiredNumber(value, 'progress');
  const finalSupport = requiredNumber(value, 'finalSupport');
  if (
    !id ||
    !createdAt ||
    !updatedAt ||
    !levelId ||
    typeof status !== 'string' ||
    !attemptStatuses.includes(status as AttemptStatus) ||
    turnsUsed === null ||
    maxTurns === null ||
    calls === null ||
    progress === null ||
    finalSupport === null ||
    typeof value.cancelRequested !== 'boolean' ||
    value.animationEnabled !== false ||
    typeof value.presentationComplete !== 'boolean' ||
    typeof value.recordComplete !== 'boolean'
  ) {
    return null;
  }
  const reason =
    value.reason === undefined ? undefined : typeof value.reason === 'string' ? value.reason : null;
  if (reason === null) return null;
  const score = nullableNumber(value, 'score');
  const inputTokens = nullableNumber(value, 'inputTokens');
  const outputTokens = nullableNumber(value, 'outputTokens');
  const gameTokens = nullableNumber(value, 'gameTokens');
  const cacheReadTokens = nullableNumber(value, 'cacheReadTokens');
  const cacheWriteTokens = nullableNumber(value, 'cacheWriteTokens');
  const reasoningTokens = nullableNumber(value, 'reasoningTokens');
  if (
    score === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    gameTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return null;
  }
  if (
    reasoningTokens === undefined &&
    Object.prototype.hasOwnProperty.call(value, 'reasoningTokens')
  ) {
    return null;
  }
  if (!isModelKey(value.modelKey)) return null;
  const modelLabel = requiredString(value, 'modelLabel');
  const modelId = requiredString(value, 'modelId');
  if (!modelLabel || !modelId) {
    return null;
  }
  const modelKey: ModelKey = value.modelKey;
  return {
    id,
    createdAt,
    updatedAt,
    status: status as AttemptStatus,
    cancelRequested: value.cancelRequested,
    ...(reason === undefined ? {} : { reason }),
    levelId,
    turnsUsed,
    maxTurns,
    calls,
    inputTokens,
    outputTokens,
    gameTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: reasoningTokens ?? null,
    modelKey,
    modelLabel,
    modelId,
    score,
    progress,
    finalSupport,
    animationEnabled: false,
    presentationComplete: value.presentationComplete,
    recordComplete: value.recordComplete,
  };
}

function parseAdmission(value: unknown): AttemptAdmission | null {
  if (!isRecord(value)) return null;
  const attempt = parseAttempt(value.attempt);
  if (!attempt || typeof value.dispatchConfirmed !== 'boolean') return null;
  return { attempt, dispatchConfirmed: value.dispatchConfirmed };
}

function parseAttemptsPage(value: unknown): AttemptsPage | null {
  if (!isRecord(value) || !Array.isArray(value.attempts)) return null;
  const attempts = value.attempts.map(parseAttempt);
  if (attempts.some((attempt): attempt is null => attempt === null)) return null;
  if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string') return null;
  return {
    attempts: attempts as AttemptSummary[],
    ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}),
  };
}

function parseQuota(value: unknown): QuotaSummary | null {
  if (!isRecord(value)) return null;
  const day = requiredString(value, 'day');
  const resetsAt = requiredString(value, 'resetsAt');
  const used = requiredNumber(value, 'used');
  const limit = requiredNumber(value, 'limit');
  const remaining = requiredNumber(value, 'remaining');
  if (!day || !resetsAt || used === null || limit === null || remaining === null) return null;
  return { day, used, limit, remaining, resetsAt };
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.message === 'string' && body.message.trim() !== ''
    ? body.message
    : fallback;
}

function bindFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return fetchImpl.bind(globalThis);
}

export class AttemptApiClient implements AttemptApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly tokenProvider: AttemptTokenProvider;

  public constructor(config: Pick<AuthConfig, 'apiBaseUrl'>, options: AttemptApiClientOptions) {
    this.baseUrl = config.apiBaseUrl.endsWith('/') ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
    this.fetchImpl = bindFetch(options.fetch ?? globalThis.fetch);
    this.tokenProvider = options.tokenProvider;
  }

  public createAttempt(
    requestKey: string,
    expectedVersion: number,
    draft: RobotDraft,
    signal?: AbortSignal,
  ): Promise<AttemptAdmission> {
    return this.request(
      'POST',
      'attempts',
      { requestKey, expectedVersion, draft },
      parseAdmission,
      'No se pudo admitir el intento.',
      signal,
    );
  }

  public getAttemptRequest(requestKey: string, signal?: AbortSignal): Promise<AttemptSummary> {
    return this.request(
      'GET',
      `attempt-requests/${encodeURIComponent(requestKey)}`,
      undefined,
      (value) => {
        if (!isRecord(value)) return null;
        return parseAttempt(value.attempt);
      },
      'No se pudo comprobar la admisión.',
      signal,
    );
  }

  public getAttempt(id: string, signal?: AbortSignal): Promise<AttemptSummary> {
    return this.request(
      'GET',
      `attempts/${encodeURIComponent(id)}`,
      undefined,
      (value) => {
        if (!isRecord(value)) return null;
        return parseAttempt(value.attempt);
      },
      'No se pudo consultar el intento.',
      signal,
    );
  }

  public listAttempts(cursor?: string, signal?: AbortSignal): Promise<AttemptsPage> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request(
      'GET',
      `attempts${suffix}`,
      undefined,
      parseAttemptsPage,
      'No se pudo cargar el historial.',
      signal,
    );
  }

  public startAttempt(id: string, signal?: AbortSignal): Promise<AttemptAdmission> {
    return this.request(
      'POST',
      `attempts/${encodeURIComponent(id)}/start`,
      undefined,
      parseAdmission,
      'No se pudo iniciar el intento.',
      signal,
    );
  }

  public cancelAttempt(id: string, signal?: AbortSignal): Promise<AttemptSummary> {
    return this.request(
      'POST',
      `attempts/${encodeURIComponent(id)}/cancel`,
      undefined,
      (value) => {
        if (!isRecord(value)) return null;
        return parseAttempt(value.attempt);
      },
      'No se pudo cancelar el intento.',
      signal,
    );
  }

  public getQuota(signal?: AbortSignal): Promise<QuotaSummary> {
    return this.request(
      'GET',
      'quota',
      undefined,
      parseQuota,
      'No se pudo consultar la cuota.',
      signal,
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    parser: (value: unknown) => T | null,
    invalidMessage: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let token: string;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      throw new AttemptApiFailure(
        'authentication',
        'La sesión no tiene un token de acceso.',
        undefined,
        false,
        {
          cause: error,
        },
      );
    }
    if (!token)
      throw new AttemptApiFailure('authentication', 'La sesión no tiene un token de acceso.');
    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AttemptApiFailure('network', invalidMessage, undefined, method === 'POST', {
        cause: error,
      });
    }
    const parsed = await readBody(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AttemptApiFailure(
          'authentication',
          errorMessage(parsed, 'Tu sesión ya no está autorizada.'),
          response.status,
        );
      }
      if (response.status === 404) {
        throw new AttemptApiFailure(
          'not_found',
          errorMessage(parsed, 'No se encontró el intento.'),
          response.status,
        );
      }
      if (response.status === 409) {
        throw new AttemptApiFailure(
          'conflict',
          errorMessage(parsed, 'La solicitud ya no es válida.'),
          response.status,
        );
      }
      if (response.status === 429) {
        throw new AttemptApiFailure(
          'quota_exceeded',
          errorMessage(parsed, 'Alcanzaste la cuota diaria.'),
          response.status,
        );
      }
      if (response.status >= 400 && response.status < 500) {
        throw new AttemptApiFailure(
          'invalid',
          errorMessage(parsed, 'No se pudo procesar el intento.'),
          response.status,
        );
      }
      throw new AttemptApiFailure(
        'server',
        errorMessage(parsed, invalidMessage),
        response.status,
        method === 'POST',
      );
    }
    const result = parser(parsed);
    if (result === null) {
      throw new AttemptApiFailure('server', invalidMessage, response.status, method === 'POST');
    }
    return result;
  }
}

export function createAttemptApiClient(
  config: Pick<AuthConfig, 'apiBaseUrl'>,
  tokenProvider: AttemptTokenProvider,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AttemptApi {
  return new AttemptApiClient(config, { tokenProvider, fetch: fetchImpl });
}
