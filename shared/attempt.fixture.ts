import { ROBOT_CATALOG, ROBOT_CATALOG_VERSION, ROBOT_SCHEMA_VERSION } from './robot.js';
import {
  DEFAULT_SCORE_RULES,
  LEVEL,
  createInitialState,
  resolveAction,
  scoreAttempt,
  type GameSnapshot,
  type NormalizedAction,
  type ResolvedAction,
} from './game.js';
import { ATTEMPT_RECORD_VERSION } from './attempt.js';
import type {
  AttemptActionRecord,
  AttemptConfigSnapshot,
  AttemptRecord,
  AttemptRobotSnapshot,
} from './attempt.js';

const freezeDeep = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
};

const referenceActions: readonly NormalizedAction[] = [
  { kind: 'advance' },
  { kind: 'jump', direction: 'right' },
  { kind: 'advance' },
  { kind: 'crouch', direction: 'right' },
  { kind: 'jump', direction: 'right' },
  { kind: 'jump', direction: 'right' },
  { kind: 'advance' },
];

const robotSnapshot = (): AttemptRobotSnapshot => ({
  schemaVersion: ROBOT_SCHEMA_VERSION,
  catalogVersion: ROBOT_CATALOG_VERSION,
  instructions:
    'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
  skills: ROBOT_CATALOG.map((entry) => ({
    id: entry.id,
    opaqueId: entry.opaqueId,
    enabled: true,
    description: '',
    inputSchema: entry.inputSchema,
  })),
});

const configSnapshot = (): AttemptConfigSnapshot => ({
  level: LEVEL,
  scoreRules: DEFAULT_SCORE_RULES,
  robot: robotSnapshot(),
  animationEnabled: false,
});

const resolveReferenceChain = (): {
  readonly initial: GameSnapshot;
  readonly results: readonly ResolvedAction[];
} => {
  const initial = createInitialState(LEVEL);
  const results: ResolvedAction[] = [];
  let state = initial;
  for (const action of referenceActions) {
    const resolved = resolveAction(state, action, LEVEL);
    results.push(resolved);
    state = resolved.after;
  }
  return { initial, results };
};

/**
 * Closed logical record used by shared contract tests and future replay tests.
 * This fixture is deliberately test-only; it is not the DynamoDB projection.
 */
export const createClosedAttemptRecordFixture = (): AttemptRecord => {
  const { initial, results } = resolveReferenceChain();
  const actions: AttemptActionRecord[] = results.map((result, index) => ({
    seq: index + 1,
    decisionId: `fixture-decision-${index + 1}`,
    beforeStateId: result.before.id,
    afterStateId: result.after.id,
    action: result.action,
    resolution: result.resolution,
  }));
  const snapshots = [initial, ...results.map((result) => result.after)];
  const metrics = {
    calls: referenceActions.length,
    inputTokens: 500,
    outputTokens: 100,
    reasoningTokens: 0,
    gameTokens: 600,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  } as const;
  const record: AttemptRecord = {
    recordVersion: ATTEMPT_RECORD_VERSION,
    id: 'fixture-closed-attempt',
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:05.000Z',
    config: configSnapshot(),
    snapshots,
    actions,
    closure: {
      status: 'victory',
      actionCount: actions.length,
      finalStateId: results.at(-1)?.after.id ?? initial.id,
      recordComplete: true,
    },
    metrics,
    score: scoreAttempt({
      status: 'victory',
      turnsUsed: results.at(-1)?.after.turnsUsed ?? 0,
      collectedObjectIds: [],
      gameTokens: metrics.gameTokens,
    }),
  };
  return freezeDeep(record);
};

export interface RepresentativeAttemptItem {
  readonly PK: string;
  readonly SK: string;
  readonly entity: string;
  readonly value: unknown;
}

/**
 * Test-only structured item mirror of apps/api/src/attempt-store.ts. It keeps
 * bodies out of DynamoDB and checks the actual key families separately.
 */
export const representativeAttemptItems = (
  record: AttemptRecord = createClosedAttemptRecordFixture(),
): readonly RepresentativeAttemptItem[] => {
  const items: RepresentativeAttemptItem[] = [];
  const attemptPk = `ATTEMPT#${record.id}`;
  const publicPk = 'USER#fixture-owner';
  const headerValue: Record<string, unknown> = {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.closure.status,
    cancelRequested: false,
    levelId: record.config.level.id,
    turnsUsed: record.snapshots.at(-1)?.turnsUsed ?? 0,
    maxTurns: record.config.level.maxTurns,
    calls: record.metrics.calls,
    inputTokens: record.metrics.inputTokens,
    outputTokens: record.metrics.outputTokens,
    reasoningTokens: record.metrics.reasoningTokens,
    gameTokens: record.metrics.gameTokens,
    cacheReadTokens: record.metrics.cacheReadTokens,
    cacheWriteTokens: record.metrics.cacheWriteTokens,
    score: record.score,
    progress: 1,
    finalSupport: record.snapshots.at(-1)?.support ?? 0,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: record.closure.recordComplete,
    owner: 'fixture-owner',
    requestKey: 'fixture-request',
    initialStateId: record.snapshots[0]?.id,
    currentStateId: record.closure.finalStateId,
    sequence: record.actions.length,
    config: record.config,
  };
  items.push({ PK: publicPk, SK: `ATTEMPT#${record.id}`, entity: 'attempt', value: headerValue });
  items.push({
    PK: attemptPk,
    SK: 'META',
    entity: 'attempt-meta',
    value: headerValue,
  });
  for (const snapshot of record.snapshots) {
    items.push({
      PK: attemptPk,
      SK: `STATE#${snapshot.id}`,
      entity: 'snapshot',
      value: { stateId: snapshot.id, snapshot },
    });
  }
  for (const action of record.actions) {
    items.push({
      PK: attemptPk,
      SK: `ACTION#${String(action.seq).padStart(8, '0')}`,
      entity: 'action',
      value: action,
    });
    items.push({
      PK: attemptPk,
      SK: `CALL#${String(action.seq).padStart(8, '0')}`,
      entity: 'call',
      value: {
        attemptId: record.id,
        seq: action.seq,
        decisionId: action.decisionId,
        requestKey: `attempt/${record.id}/decision/${action.decisionId}/call/${action.seq}/request.json`,
        responseKey: `attempt/${record.id}/decision/${action.decisionId}/call/${action.seq}/response.json`,
        requestSha256: '0'.repeat(64),
        requestBytes: 1024,
        responseSha256: '1'.repeat(64),
        responseBytes: 2048,
        status: 'received',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: null,
          gameTokens: 120,
        },
      },
    });
  }
  return freezeDeep(items);
};

export const utf8ByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
