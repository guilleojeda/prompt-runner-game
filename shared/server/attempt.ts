import { isDeepStrictEqual } from 'node:util';
import type { RobotDraft } from '../robot.js';
import { DEFAULT_MODEL_KEY, resolveModelProfile, type ModelProfile } from '../models.js';
import type {
  AnimationPreference,
  AttemptActionRecord,
  AttemptActionView,
  AttemptClosure,
  AttemptMetrics,
  ReplayRecordView,
  AttemptStatus as SharedAttemptStatus,
  AttemptSummary as SharedAttemptSummary,
} from '../attempt.js';
import { ATTEMPT_RECORD_VERSION } from '../attempt.js';
import type {
  ActionResolution,
  GameSnapshot,
  LevelDefinition,
  LevelObject,
  LevelSegment,
  NormalizedAction,
  TerrainState,
} from '../game.js';
import {
  isActionResolution,
  isNormalizedAction,
  isSemanticallyValidActionResolution,
  LEVEL,
  RULES_VERSION,
} from '../game.js';

/** API summaries use the authoritative attempt contract from shared/attempt.ts. */
export type AttemptStatus = SharedAttemptStatus;
export type AttemptSummary = SharedAttemptSummary;

export type Usage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly gameTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
};

/** The part of an attempt Runtime needs. It is never returned to the browser. */
export type PersistedAttempt = AttemptSummary & {
  readonly recordVersion: typeof ATTEMPT_RECORD_VERSION;
  readonly owner: string;
  /** Internal idempotency key; intentionally omitted from AttemptSummary. */
  readonly requestKey: string;
  readonly draft: RobotDraft;
  readonly instructions: string;
  readonly skills: readonly AttemptSkill[];
  readonly config: AttemptConfig;
  readonly initialSnapshot: unknown;
  readonly currentSnapshot: unknown;
  readonly sequence: number;
  readonly nextCall: number;
  readonly executorId?: string;
  readonly claimedAt?: string;
  readonly startDeadline: string;
  readonly executionDeadline?: string;
  readonly runtimeDeadline?: string;
  readonly sessionId: string;
};

export type AttemptSkill = {
  readonly id: string;
  readonly opaqueId: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type AttemptConfig = {
  readonly levelId: string;
  readonly levelVersion: string;
  readonly levelDefinition: LevelDefinition;
  readonly engineVersion: string;
  readonly protocolVersion: string;
  readonly protocol: Readonly<{ api: 'converse'; stream: false }>;
  readonly inferenceVersion: string;
  /** Complete effective profile copied into the attempt snapshot. */
  readonly model: Readonly<ModelProfile>;
  readonly scoreVersion: string;
  readonly maxTurns: number;
  readonly startTimeoutMs: number;
  readonly starterTimeoutMs: number;
  readonly eventMaxAgeMs: number;
  readonly runtimeLifetimeMs: number;
  readonly callTimeoutMs: number;
  readonly saveReserveMs: number;
  readonly terminationMarginMs: number;
  readonly scoreParameters: Readonly<Record<string, number>>;
};

export type AdmitInput = {
  readonly owner: string;
  readonly requestKey: string;
  readonly expectedVersion: number;
  readonly draft: RobotDraft;
  readonly animationEnabled: boolean;
  readonly now?: string;
  readonly config?: Partial<AttemptConfig>;
};

export type AdmitResult = {
  readonly attempt: AttemptSummary;
  readonly admitted: boolean;
};

export type CallRecord = {
  readonly attemptId: string;
  readonly seq: number;
  readonly decisionId: string;
  readonly requestKey: string;
  readonly responseKey: string;
  readonly requestSha256: string;
  readonly requestBytes: number;
  readonly responseSha256?: string;
  readonly responseBytes?: number;
  readonly status: 'started' | 'received' | 'invalid' | 'error' | 'unknown';
  readonly rawAction?: unknown;
  readonly usage: Usage;
  readonly requestId?: string;
  readonly responseStatus?: number;
  readonly errorCode?: string;
  /** Effective identity copied from the admitted model profile. */
  readonly modelKey: ModelProfile['key'];
  readonly modelId: string;
  readonly region: string;
  readonly profileVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ActionPublication = {
  readonly seq: number;
  readonly decisionId: string;
  readonly action: unknown;
  readonly resolution: unknown;
  readonly beforeStateId: string;
  readonly afterStateId: string;
  readonly beforeSnapshot: unknown;
  readonly afterSnapshot: unknown;
  readonly terminalStatus?: Extract<AttemptStatus, 'victory' | 'defeat' | 'incomplete'>;
  readonly reason?: string;
  readonly progress: number;
  readonly finalSupport: number;
  readonly turnsUsed: number;
};

export type AttemptStore = {
  admit(input: AdmitInput): Promise<AdmitResult>;
  get(owner: string, attemptId: string): Promise<PersistedAttempt | undefined>;
  getReplayRecord(owner: string, attemptId: string): Promise<ReplayRecordView | undefined>;
  getAnimationPreference(owner: string): Promise<AnimationPreference>;
  putAnimationPreference(
    owner: string,
    animationEnabled: boolean,
    expectedVersion: number,
  ): Promise<AnimationPreference>;
  markPresentationComplete(owner: string, attemptId: string): Promise<PersistedAttempt | undefined>;
  getByRequest(owner: string, requestKey: string): Promise<PersistedAttempt | undefined>;
  list(
    owner: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ attempts: AttemptSummary[]; nextCursor?: string }>;
  quota(
    owner: string,
  ): Promise<{ day: string; used: number; limit: number; remaining: number; resetsAt: string }>;
  claim(
    owner: string,
    attemptId: string,
    executorId: string,
    now?: string,
  ): Promise<PersistedAttempt | undefined>;
  requestCancel(
    owner: string,
    attemptId: string,
    now?: string,
  ): Promise<PersistedAttempt | undefined>;
  beginCall(
    owner: string,
    attemptId: string,
    executorId: string,
    call: CallRecord,
  ): Promise<CallRecord | undefined>;
  finishCall(
    owner: string,
    attemptId: string,
    executorId: string,
    call: CallRecord,
  ): Promise<CallRecord | undefined>;
  publishAction(
    owner: string,
    attemptId: string,
    executorId: string,
    publication: ActionPublication,
  ): Promise<PersistedAttempt | undefined>;
  close(
    owner: string,
    attemptId: string,
    terminalStatus: Extract<AttemptStatus, 'cancelled' | 'error'>,
    reason: string,
    executorId?: string,
    now?: string,
  ): Promise<PersistedAttempt | undefined>;
  closeExpired(
    owner: string,
    attemptId: string,
    now?: string,
  ): Promise<PersistedAttempt | undefined>;
  getSnapshot(owner: string, attemptId: string, stateId?: string): Promise<unknown | undefined>;
  getCalls(owner: string, attemptId: string): Promise<CallRecord[]>;
  /** Best-effort late metadata recovery after an S3 write was acknowledged. */
  recoverBodies?(owner: string, attemptId: string): Promise<void>;
};

export type BodyStore = {
  put(key: string, body: Uint8Array): Promise<{ sha256: string; bytes: number }>;
  get(key: string): Promise<Uint8Array | undefined>;
};

export class ReplayRecordError extends Error {
  public constructor(message = 'El registro no está disponible para reproducir.') {
    super(message);
    this.name = 'ReplayRecordError';
  }
}

export class AnimationPreferenceConflictError extends Error {
  public readonly current: AnimationPreference;

  public constructor(current: AnimationPreference) {
    super('La preferencia cambió en otra pestaña.');
    this.name = 'AnimationPreferenceConflictError';
    this.current = current;
  }
}

export class AttemptNotTerminalError extends Error {
  public constructor() {
    super('La presentación solo se puede completar para un intento cerrado.');
    this.name = 'AttemptNotTerminalError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isFiniteValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isTerrain = (value: unknown): value is TerrainState =>
  value === 'ground' ||
  value === 'pit' ||
  value === 'branch' ||
  value === 'barrier_low' ||
  value === 'barrier_high';
const isTerminal = (status: AttemptStatus): boolean =>
  status === 'victory' ||
  status === 'defeat' ||
  status === 'incomplete' ||
  status === 'cancelled' ||
  status === 'error';

const readSnapshot = (value: unknown): GameSnapshot => {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    !isInteger(value.support) ||
    !isInteger(value.turnsUsed) ||
    !isInteger(value.phaseTurn) ||
    !Array.isArray(value.terrain) ||
    !value.terrain.every(isTerrain) ||
    !Array.isArray(value.remainingObjects) ||
    !value.remainingObjects.every((item) => typeof item === 'string') ||
    !Array.isArray(value.inventory) ||
    !value.inventory.every((item) => typeof item === 'string') ||
    typeof value.exitEnabled !== 'boolean' ||
    (value.status !== 'running' &&
      value.status !== 'victory' &&
      value.status !== 'defeat' &&
      value.status !== 'incomplete') ||
    !isInteger(value.maxSupportReached)
  ) {
    throw new ReplayRecordError('El registro contiene un estado inválido.');
  }
  const terrain = value.terrain.map((item) => {
    if (!isTerrain(item)) throw new ReplayRecordError('El estado contiene un terreno inválido.');
    return item;
  });
  const remainingObjects = value.remainingObjects.map((item) => {
    if (typeof item !== 'string')
      throw new ReplayRecordError('El estado contiene un objeto inválido.');
    return item;
  });
  const inventory = value.inventory.map((item) => {
    if (typeof item !== 'string')
      throw new ReplayRecordError('El estado contiene un objeto inválido.');
    return item;
  });
  return {
    id: value.id,
    support: value.support,
    turnsUsed: value.turnsUsed,
    phaseTurn: value.phaseTurn,
    terrain,
    remainingObjects,
    inventory,
    exitEnabled: value.exitEnabled,
    status: value.status,
    maxSupportReached: value.maxSupportReached,
  };
};

const readAction = (value: unknown): AttemptActionRecord => {
  if (
    !isObject(value) ||
    !isInteger(value.seq) ||
    value.seq === 0 ||
    typeof value.decisionId !== 'string' ||
    typeof value.beforeStateId !== 'string' ||
    typeof value.afterStateId !== 'string'
  ) {
    throw new ReplayRecordError('El registro contiene una acción inválida.');
  }
  const rawAction = value.action;
  if (!isNormalizedAction(rawAction))
    throw new ReplayRecordError('El registro contiene una acción no compatible.');
  const action: NormalizedAction =
    rawAction.kind === 'jump' || rawAction.kind === 'crouch'
      ? { kind: rawAction.kind, direction: rawAction.direction }
      : { kind: rawAction.kind };

  const rawResolution = value.resolution;
  if (!isActionResolution(rawResolution))
    throw new ReplayRecordError('El registro contiene una resolución no compatible.');
  const resolution: ActionResolution =
    rawResolution.outcome === 'no_op'
      ? { outcome: 'no_op', reason: rawResolution.reason }
      : {
          outcome: rawResolution.outcome,
          reason: rawResolution.reason,
          segment: rawResolution.segment,
          targetSupport: rawResolution.targetSupport,
        };
  return {
    seq: value.seq,
    decisionId: value.decisionId,
    beforeStateId: value.beforeStateId,
    afterStateId: value.afterStateId,
    action,
    resolution,
  };
};

const readCurrentLevel = (value: unknown): LevelDefinition => {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    !isInteger(value.version) ||
    value.version === 0 ||
    value.rulesVersion !== RULES_VERSION ||
    !isInteger(value.maxTurns) ||
    value.maxTurns === 0 ||
    !Array.isArray(value.segments) ||
    !Array.isArray(value.objects) ||
    !isObject(value.exit)
  ) {
    throw new ReplayRecordError('El nivel guardado no es compatible con la reproducción.');
  }
  const segments: LevelSegment[] = value.segments.map((segment): LevelSegment => {
    if (!isObject(segment))
      throw new ReplayRecordError('El nivel contiene un tramo no compatible.');
    if (segment.type === 'ground' || segment.type === 'pit' || segment.type === 'branch') {
      return { type: segment.type };
    }
    if (
      (segment.type !== 'barrier' && segment.type !== 'platform') ||
      !Array.isArray(segment.phases) ||
      segment.phases.length === 0 ||
      !segment.phases.every(isTerrain) ||
      !isInteger(segment.offset)
    ) {
      throw new ReplayRecordError('El nivel contiene un tramo periódico no compatible.');
    }
    if (
      (segment.type === 'barrier' &&
        segment.phases.some((phase) => phase !== 'barrier_low' && phase !== 'barrier_high')) ||
      (segment.type === 'platform' &&
        segment.phases.some((phase) => phase !== 'ground' && phase !== 'pit'))
    ) {
      throw new ReplayRecordError('El nivel contiene fases no compatibles.');
    }
    return {
      type: segment.type,
      phases: [...segment.phases] as TerrainState[],
      offset: segment.offset,
    };
  });
  const objects: LevelObject[] = value.objects.map((item): LevelObject => {
    if (
      !isObject(item) ||
      typeof item.id !== 'string' ||
      !isInteger(item.support) ||
      !isFiniteValue(item.scoreValue) ||
      (item.requiredForExit !== undefined && typeof item.requiredForExit !== 'boolean')
    ) {
      throw new ReplayRecordError('El nivel contiene un objeto no compatible.');
    }
    return {
      id: item.id,
      support: item.support,
      scoreValue: item.scoreValue,
      ...(item.requiredForExit === undefined ? {} : { requiredForExit: item.requiredForExit }),
    };
  });
  const exit = value.exit;
  if (
    !isInteger(exit.support) ||
    !Array.isArray(exit.requiredObjectIds) ||
    !exit.requiredObjectIds.every((item) => typeof item === 'string')
  ) {
    throw new ReplayRecordError('La salida guardada no es compatible con la reproducción.');
  }
  const requiredObjectIds = exit.requiredObjectIds.map((item) => {
    if (typeof item !== 'string')
      throw new ReplayRecordError('La salida contiene un objeto inválido.');
    return item;
  });
  const level: LevelDefinition = {
    id: value.id,
    version: value.version,
    rulesVersion: RULES_VERSION,
    maxTurns: value.maxTurns,
    segments,
    objects,
    exit: {
      support: exit.support,
      requiredObjectIds,
    },
  };
  if (!isDeepStrictEqual(level, LEVEL)) {
    throw new ReplayRecordError('El nivel guardado no es el único nivel vigente.');
  }
  return level;
};

/** Read a level snapshot only when it is the code-owned periodic level. */
export { readCurrentLevel };

/** Validates durable rows and returns only the public data needed by the visual replay. */
export const replayRecordViewOf = (
  attempt: PersistedAttempt,
  rawActions: readonly unknown[],
  rawSnapshots: readonly unknown[],
): ReplayRecordView => {
  if (
    attempt.recordVersion !== ATTEMPT_RECORD_VERSION ||
    !isTerminal(attempt.status) ||
    !attempt.recordComplete ||
    !isInteger(attempt.sequence) ||
    rawActions.length !== attempt.sequence ||
    rawSnapshots.length !== rawActions.length + 1
  ) {
    throw new ReplayRecordError();
  }
  const level = readCurrentLevel(attempt.config.levelDefinition);
  const storedSnapshots = rawSnapshots.map((entry) => {
    if (!isObject(entry) || typeof entry.stateId !== 'string')
      throw new ReplayRecordError('El registro contiene una referencia de estado inválida.');
    const snapshot = readSnapshot(entry.snapshot);
    if (snapshot.id !== entry.stateId)
      throw new ReplayRecordError('La referencia del estado no coincide con el snapshot.');
    return snapshot;
  });
  const snapshotsById = new Map(storedSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  if (snapshotsById.size !== storedSnapshots.length)
    throw new ReplayRecordError('El registro contiene estados repetidos.');

  const actionRecords = rawActions.map(readAction).sort((left, right) => left.seq - right.seq);
  const expectedStateIds = ['state-0', ...actionRecords.map((action) => action.afterStateId)];
  if (
    new Set(expectedStateIds).size !== expectedStateIds.length ||
    expectedStateIds.length !== storedSnapshots.length ||
    expectedStateIds.some((stateId) => !snapshotsById.has(stateId))
  ) {
    throw new ReplayRecordError('Falta un estado o hay una referencia repetida.');
  }
  const snapshots = expectedStateIds.map((stateId) => snapshotsById.get(stateId)!);
  if (
    !isObject(attempt.initialSnapshot) ||
    attempt.initialSnapshot.id !== snapshots[0]?.id ||
    snapshots.some((snapshot) => snapshot.terrain.length !== level.segments.length)
  ) {
    throw new ReplayRecordError(
      'El estado inicial o el terreno no coincide con el nivel guardado.',
    );
  }

  const actions = actionRecords.map((action, index): AttemptActionView => {
    const before = snapshotsById.get(action.beforeStateId);
    const after = snapshotsById.get(action.afterStateId);
    if (
      action.seq !== index + 1 ||
      !before ||
      !after ||
      before.id !== snapshots[index]?.id ||
      after.id !== snapshots[index + 1]?.id ||
      after.turnsUsed !== before.turnsUsed + 1
    ) {
      throw new ReplayRecordError('La secuencia de acciones o estados está incompleta.');
    }
    if (!isSemanticallyValidActionResolution(action.action, before, after, action.resolution)) {
      throw new ReplayRecordError(`La acción ${index + 1} contradice el contrato del juego.`);
    }
    return { ...action, before, after };
  });

  const finalSnapshot = snapshots.at(-1);
  if (
    !finalSnapshot ||
    !isObject(attempt.currentSnapshot) ||
    attempt.currentSnapshot.id !== finalSnapshot.id ||
    attempt.turnsUsed !== finalSnapshot.turnsUsed ||
    ((attempt.status === 'victory' ||
      attempt.status === 'defeat' ||
      attempt.status === 'incomplete') &&
      finalSnapshot.status !== attempt.status)
  ) {
    throw new ReplayRecordError('El cierre no coincide con el último estado guardado.');
  }
  const closure: AttemptClosure = {
    status: attempt.status,
    ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
    actionCount: actions.length,
    finalStateId: finalSnapshot.id,
    recordComplete: true,
  };
  const metrics: AttemptMetrics = {
    calls: attempt.calls,
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    reasoningTokens: attempt.reasoningTokens,
    gameTokens: attempt.gameTokens,
    cacheReadTokens: attempt.cacheReadTokens,
    cacheWriteTokens: attempt.cacheWriteTokens,
  };
  return {
    recordVersion: ATTEMPT_RECORD_VERSION,
    id: attempt.id,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    config: { level },
    snapshots,
    actions,
    closure,
    metrics,
    score: attempt.score,
  };
};

export const DEFAULT_ATTEMPT_CONFIG: AttemptConfig = {
  levelId: LEVEL.id,
  levelVersion: String(LEVEL.version),
  levelDefinition: LEVEL,
  engineVersion: 'periodic-engine-v2',
  protocolVersion: 'tool-protocol-v2',
  protocol: { api: 'converse', stream: false },
  inferenceVersion: 'claude-sonnet-4.6-global-v1',
  model: resolveModelProfile(DEFAULT_MODEL_KEY),
  scoreVersion: 'score-v1',
  maxTurns: LEVEL.maxTurns,
  startTimeoutMs: 5 * 60_000,
  starterTimeoutMs: 120_000,
  eventMaxAgeMs: 5 * 60_000,
  runtimeLifetimeMs: 30 * 60_000,
  callTimeoutMs: 60_000,
  saveReserveMs: 30_000,
  terminationMarginMs: 2 * 60_000,
  scoreParameters: {
    base: 1000,
    turnWeight: 10,
    tokenWeight: 1,
    tokenUnit: 1000,
    decimals: 2,
    allowNegative: 1,
  },
};

export const summaryOf = (record: PersistedAttempt): AttemptSummary => ({
  id: record.id,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  status: record.status,
  cancelRequested: record.cancelRequested,
  ...(record.reason === undefined ? {} : { reason: record.reason }),
  levelId: record.levelId,
  modelKey: record.config.model.key,
  modelLabel: record.config.model.label,
  modelId: record.config.model.modelId,
  turnsUsed: record.turnsUsed,
  maxTurns: record.maxTurns,
  calls: record.calls,
  inputTokens: record.inputTokens,
  outputTokens: record.outputTokens,
  reasoningTokens: record.reasoningTokens,
  gameTokens: record.gameTokens,
  cacheReadTokens: record.cacheReadTokens,
  cacheWriteTokens: record.cacheWriteTokens,
  score: record.score,
  progress: record.progress,
  finalSupport: record.finalSupport,
  animationEnabled: record.animationEnabled,
  presentationComplete: record.presentationComplete,
  recordComplete: record.recordComplete,
});
