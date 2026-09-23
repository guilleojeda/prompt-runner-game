import type { RobotDraft } from '../robot.js';
import { DEFAULT_MODEL_KEY, resolveModelProfile, type ModelProfile } from '../models.js';
import type {
  AttemptStatus as SharedAttemptStatus,
  AttemptSummary as SharedAttemptSummary,
} from '../attempt.js';
import { LEVEL } from '../game.js';
import type { LevelDefinition } from '../game.js';
import { ATTEMPT_RECORD_VERSION } from '../attempt.js';

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
  /** Effective identity copied at beginCall; omitted only on legacy records. */
  readonly modelKey?: ModelProfile['key'];
  readonly modelId?: string;
  readonly region?: string;
  readonly profileVersion?: string;
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

export const DEFAULT_ATTEMPT_CONFIG: AttemptConfig = {
  levelId: 'principal-estatico-v1',
  levelVersion: 'principal-estatico-v1',
  levelDefinition: LEVEL,
  engineVersion: 'static-engine-v1',
  protocolVersion: 'tool-protocol-v1',
  protocol: { api: 'converse', stream: false },
  inferenceVersion: 'claude-sonnet-4.6-global-v1',
  model: resolveModelProfile(DEFAULT_MODEL_KEY),
  scoreVersion: 'score-v1',
  maxTurns: 12,
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
  animationEnabled: false,
  presentationComplete: record.presentationComplete,
  recordComplete: record.recordComplete,
});
