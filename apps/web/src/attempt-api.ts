import type { RobotDraft } from '../../../shared/robot.js';
import type {
  AnimationPreference,
  AttemptStatus,
  AttemptSummary,
  ReplayRecordView,
} from '../../../shared/attempt.js';
import { ATTEMPT_RECORD_VERSION } from '../../../shared/attempt.js';
import {
  isSemanticallyValidActionResolution,
  LEVEL,
  type LevelDefinition,
  type LevelSegment,
  type TerrainState,
} from '../../../shared/game.js';
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
  getAnimationPreference(signal?: AbortSignal): Promise<AnimationPreference>;
  putAnimationPreference(
    animationEnabled: boolean,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<AnimationPreference>;
  createAttempt(
    requestKey: string,
    expectedVersion: number,
    draft: RobotDraft,
    animationEnabled: boolean,
    signal?: AbortSignal,
  ): Promise<AttemptAdmission>;
  getAttemptRequest(requestKey: string, signal?: AbortSignal): Promise<AttemptSummary>;
  getAttempt(id: string, signal?: AbortSignal): Promise<AttemptSummary>;
  listAttempts(cursor?: string, signal?: AbortSignal): Promise<AttemptsPage>;
  startAttempt(id: string, signal?: AbortSignal): Promise<AttemptAdmission>;
  cancelAttempt(id: string, signal?: AbortSignal): Promise<AttemptSummary>;
  getReplay(id: string, signal?: AbortSignal): Promise<ReplayRecordView>;
  completePresentation(id: string, signal?: AbortSignal): Promise<AttemptSummary>;
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
    levelId !== LEVEL.id ||
    typeof status !== 'string' ||
    !attemptStatuses.includes(status as AttemptStatus) ||
    turnsUsed === null ||
    maxTurns === null ||
    maxTurns !== LEVEL.maxTurns ||
    calls === null ||
    progress === null ||
    finalSupport === null ||
    typeof value.cancelRequested !== 'boolean' ||
    typeof value.animationEnabled !== 'boolean' ||
    typeof value.presentationComplete !== 'boolean' ||
    typeof value.recordComplete !== 'boolean'
  ) {
    return null;
  }
  const reason =
    value.reason === undefined ? undefined : typeof value.reason === 'string' ? value.reason : null;
  if (reason === null) return null;
  const score = nullableNumber(value, 'score');
  const objectPoints = requiredNumber(value, 'objectPoints');
  const inputTokens = nullableNumber(value, 'inputTokens');
  const outputTokens = nullableNumber(value, 'outputTokens');
  const gameTokens = nullableNumber(value, 'gameTokens');
  const cacheReadTokens = nullableNumber(value, 'cacheReadTokens');
  const cacheWriteTokens = nullableNumber(value, 'cacheWriteTokens');
  const reasoningTokens = nullableNumber(value, 'reasoningTokens');
  const collectedObjectIds = Array.isArray(value.collectedObjectIds)
    ? value.collectedObjectIds
    : null;
  const knownObjectValues = new Map(LEVEL.objects.map((object) => [object.id, object.scoreValue]));
  const validCollectedObjectIds =
    collectedObjectIds !== null &&
    collectedObjectIds.every(
      (objectId): objectId is string =>
        typeof objectId === 'string' && knownObjectValues.has(objectId),
    ) &&
    new Set(collectedObjectIds).size === collectedObjectIds.length;
  if (
    score === undefined ||
    objectPoints === null ||
    !Number.isInteger(objectPoints) ||
    objectPoints < 0 ||
    !validCollectedObjectIds ||
    objectPoints !==
      (collectedObjectIds as string[]).reduce(
        (total, objectId) => total + (knownObjectValues.get(objectId) ?? 0),
        0,
      ) ||
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
    collectedObjectIds: collectedObjectIds as string[],
    objectPoints,
    progress,
    finalSupport,
    animationEnabled: value.animationEnabled,
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

function parseAnimationPreference(value: unknown): AnimationPreference | null {
  if (!isRecord(value) || typeof value.animationEnabled !== 'boolean') return null;
  const version = requiredNumber(value, 'version');
  if (version === null || !Number.isSafeInteger(version) || version < 0) return null;
  return { animationEnabled: value.animationEnabled, version };
}

const gameStatuses = ['running', 'victory', 'defeat', 'incomplete'] as const;
const terminalStatuses: readonly AttemptStatus[] = [
  'victory',
  'defeat',
  'incomplete',
  'cancelled',
  'error',
];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isGameSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Number.isSafeInteger(value.support) &&
    (value.facing === 'left' || value.facing === 'right') &&
    Number.isSafeInteger(value.turnsUsed) &&
    Number.isSafeInteger(value.phaseTurn) &&
    terrainAllowedByLevel(value.terrain, LEVEL.segments) &&
    isStringArray(value.remainingObjects) &&
    isStringArray(value.inventory) &&
    !Object.prototype.hasOwnProperty.call(value, 'exitEnabled') &&
    typeof value.status === 'string' &&
    gameStatuses.includes(value.status as (typeof gameStatuses)[number]) &&
    Number.isSafeInteger(value.maxSupportReached)
  );
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
};

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

function isReplayLevel(value: unknown): value is LevelDefinition {
  return isRecord(value) && sameValue(value, LEVEL);
}

function terrainAllowedByLevel(value: unknown, segments: readonly LevelSegment[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === segments.length &&
    segments.every((segment, index) => {
      const terrain = value[index];
      return segment.type === 'barrier' || segment.type === 'platform'
        ? segment.phases.includes(terrain as TerrainState)
        : terrain === segment.type;
    })
  );
}

function isReplayAction(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.seq !== 'number' ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 1
  )
    return false;
  if (
    typeof value.decisionId !== 'string' ||
    typeof value.beforeStateId !== 'string' ||
    typeof value.afterStateId !== 'string' ||
    !isRecord(value.action) ||
    !isRecord(value.resolution) ||
    !isGameSnapshot(value.before) ||
    !isGameSnapshot(value.after)
  ) {
    return false;
  }
  return isSemanticallyValidActionResolution(
    value.action,
    value.before,
    value.after,
    value.resolution,
  );
}

function isReplayRecord(value: unknown): value is ReplayRecordView {
  if (
    !isRecord(value) ||
    value.recordVersion !== ATTEMPT_RECORD_VERSION ||
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isRecord(value.config) ||
    !isReplayLevel(value.config.level) ||
    !Array.isArray(value.snapshots) ||
    !value.snapshots.every(isGameSnapshot) ||
    !Array.isArray(value.actions) ||
    !value.actions.every(isReplayAction) ||
    !isRecord(value.closure) ||
    typeof value.closure.status !== 'string' ||
    !terminalStatuses.includes(value.closure.status as AttemptStatus) ||
    !Number.isSafeInteger(value.closure.actionCount) ||
    typeof value.closure.finalStateId !== 'string' ||
    value.closure.recordComplete !== true ||
    !isRecord(value.metrics) ||
    !Number.isSafeInteger(value.metrics.calls) ||
    (!Number.isFinite(value.score) && value.score !== null)
  ) {
    return false;
  }
  const metrics = value.metrics;
  return [
    metrics.inputTokens,
    metrics.outputTokens,
    metrics.reasoningTokens,
    metrics.gameTokens,
    metrics.cacheReadTokens,
    metrics.cacheWriteTokens,
  ].every((metric) => metric === null || (typeof metric === 'number' && Number.isFinite(metric)));
}

function parseReplayRecord(value: unknown): ReplayRecordView | null {
  return isReplayRecord(value) ? value : null;
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
    animationEnabled: boolean,
    signal?: AbortSignal,
  ): Promise<AttemptAdmission> {
    return this.request(
      'POST',
      'attempts',
      { requestKey, expectedVersion, draft, animationEnabled },
      parseAdmission,
      'No se pudo admitir el intento.',
      signal,
    );
  }

  public getAnimationPreference(signal?: AbortSignal): Promise<AnimationPreference> {
    return this.request(
      'GET',
      'animation-preference',
      undefined,
      parseAnimationPreference,
      'No se pudo consultar la preferencia de animación.',
      signal,
    );
  }

  public putAnimationPreference(
    animationEnabled: boolean,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<AnimationPreference> {
    return this.request(
      'PUT',
      'animation-preference',
      { animationEnabled, expectedVersion },
      parseAnimationPreference,
      'No se pudo guardar la preferencia de animación.',
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

  public getReplay(id: string, signal?: AbortSignal): Promise<ReplayRecordView> {
    return this.request(
      'GET',
      `attempts/${encodeURIComponent(id)}/replay`,
      undefined,
      (value) => {
        if (!isRecord(value)) return null;
        return parseReplayRecord(value.record);
      },
      'No se pudo cargar el registro para reproducirlo.',
      signal,
    );
  }

  public completePresentation(id: string, signal?: AbortSignal): Promise<AttemptSummary> {
    return this.request(
      'POST',
      `attempts/${encodeURIComponent(id)}/presentation-complete`,
      undefined,
      (value) => {
        if (!isRecord(value)) return null;
        return parseAttempt(value.attempt);
      },
      'No se pudo guardar el cierre de la presentación.',
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
    method: 'GET' | 'POST' | 'PUT',
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
