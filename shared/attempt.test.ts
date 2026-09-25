import { describe, expect, it } from 'vitest';
import {
  createClosedAttemptRecordFixture,
  representativeAttemptItems,
  utf8ByteLength,
} from './attempt.fixture.js';
import { ATTEMPT_RECORD_VERSION } from './attempt.js';
import type { ReplayRecordView } from './attempt.js';
import {
  LEVEL,
  createInitialState,
  resolveAction,
  type GameSnapshot,
  type NormalizedAction,
} from './game.js';
import { DEFAULT_ATTEMPT_CONFIG, replayRecordViewOf, summaryOf } from './server/attempt.js';
import type { PersistedAttempt } from './server/attempt.js';

const DYNAMODB_ITEM_LIMIT = 400 * 1024;
const REQUIRED_ITEM_MARGIN = 16 * 1024;

const terminalChain = (status: 'victory' | 'defeat' | 'incomplete') => {
  if (status === 'victory') {
    const record = createClosedAttemptRecordFixture();
    return { actions: record.actions, snapshots: record.snapshots };
  }

  const route: readonly NormalizedAction[] =
    status === 'defeat'
      ? [{ kind: 'advance' }, { kind: 'advance' }]
      : Array.from({ length: LEVEL.maxTurns }, () => ({ kind: 'wait' as const }));
  let state = createInitialState(LEVEL);
  const snapshots: GameSnapshot[] = [state];
  const actions = route.map((action, index) => {
    const result = resolveAction(state, action, LEVEL);
    state = result.after;
    snapshots.push(state);
    return {
      seq: index + 1,
      decisionId: `decision-${index + 1}`,
      beforeStateId: result.before.id,
      afterStateId: result.after.id,
      action: result.action,
      resolution: result.resolution,
    };
  });
  return { actions, snapshots };
};

const persistedReplayAttempt = (
  status: 'victory' | 'defeat' | 'incomplete',
  reason: string | undefined,
  snapshots: readonly GameSnapshot[],
  sequence: number,
): PersistedAttempt => {
  const final = snapshots.at(-1)!;
  return {
    recordVersion: ATTEMPT_RECORD_VERSION,
    id: `fixture-${status}`,
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:05.000Z',
    status,
    cancelRequested: false,
    ...(reason === undefined ? {} : { reason }),
    levelId: LEVEL.id,
    modelKey: DEFAULT_ATTEMPT_CONFIG.model.key,
    modelLabel: DEFAULT_ATTEMPT_CONFIG.model.label,
    modelId: DEFAULT_ATTEMPT_CONFIG.model.modelId,
    turnsUsed: final.turnsUsed,
    maxTurns: LEVEL.maxTurns,
    calls: sequence,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    gameTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    score: null,
    collectedObjectIds: [...final.inventory],
    progress: final.maxSupportReached / LEVEL.segments.length,
    finalSupport: final.support,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
    owner: 'fixture-owner',
    requestKey: `request-${status}`,
    draft: {} as PersistedAttempt['draft'],
    instructions: '',
    skills: [],
    config: DEFAULT_ATTEMPT_CONFIG,
    initialSnapshot: snapshots[0],
    currentSnapshot: final,
    sequence,
    nextCall: sequence + 1,
    startDeadline: '2026-09-21T13:00:00.000Z',
    sessionId: `attempt-${status}`,
  };
};

describe('durable closed attempt contract fixture', () => {
  it('keeps the immutable record version, level and effective score parameters', () => {
    const record = createClosedAttemptRecordFixture();

    expect(ATTEMPT_RECORD_VERSION).toBe(4);
    expect(record.recordVersion).toBe(ATTEMPT_RECORD_VERSION);
    expect(record.config.level.id).toBe('principal-puerta-v4');
    expect(record.config.level.version).toBe(4);
    expect(record.config.level.rulesVersion).toBe(4);
    expect(record.config.level.maxTurns).toBe(24);
    expect(record.config.level.door).toEqual({ support: 9, requiredObjectId: 'llave-1' });
    expect(record.config.level.exit).toEqual({ support: 10 });
    expect(record.config.scoreRules).toMatchObject({
      base: 1000,
      turnWeight: 10,
      tokenWeight: 1,
      tokenUnit: 1000,
      decimalPlaces: 2,
      allowNegative: true,
    });
    expect(Object.isFrozen(record.config)).toBe(true);
    expect(Object.isFrozen(record.config.scoreRules)).toBe(true);
    expect(record.config.scoreRules.objectValues).toEqual({ 'recompensa-1': 25, 'llave-1': 0 });
    expect(record.score).toBe(854.4);
  });

  it('forms a closed reference chain without duplicating posterior snapshots in actions', () => {
    const record = createClosedAttemptRecordFixture();
    const snapshotIds = record.snapshots.map((snapshot) => snapshot.id);

    expect(snapshotIds).toEqual(Array.from({ length: 18 }, (_, index) => `state-${index}`));
    expect(new Set(snapshotIds).size).toBe(snapshotIds.length);
    expect(record.actions).toHaveLength(17);
    for (const [index, action] of record.actions.entries()) {
      expect(action.seq).toBe(index + 1);
      expect(action.beforeStateId).toBe(snapshotIds[index]);
      expect(action.afterStateId).toBe(snapshotIds[index + 1]);
      expect(action).not.toHaveProperty('before');
      expect(action).not.toHaveProperty('after');
    }
    expect(record.closure).toEqual({
      status: 'victory',
      actionCount: 17,
      finalStateId: 'state-17',
      recordComplete: true,
    });
    expect(record.actions[9]).toMatchObject({
      action: { kind: 'advance' },
      resolution: { outcome: 'no_op', reason: 'door_locked' },
      beforeStateId: 'state-9',
      afterStateId: 'state-10',
    });
    expect(record.snapshots[9]).toMatchObject({ support: 8, status: 'running' });
    expect(record.snapshots[0]).toMatchObject({ facing: 'right' });
    expect(record.snapshots[10]).toMatchObject({ support: 8, status: 'running', facing: 'right' });
    expect(record.snapshots[11]).toMatchObject({ support: 7, facing: 'left' });
    expect(record.actions[12]).toMatchObject({
      action: { kind: 'collect' },
      resolution: { outcome: 'picked_up', objectId: 'llave-1' },
    });
    expect(record.snapshots[13]).toMatchObject({
      support: 6,
      inventory: ['recompensa-1', 'llave-1'],
      facing: 'left',
    });
    expect(record.snapshots[14]).toMatchObject({ support: 7, facing: 'right' });
    expect(record.snapshots[16]).toMatchObject({ support: 9, status: 'running' });
    expect(record.snapshots[17]).toMatchObject({ support: 10, status: 'victory' });
    expect(record.snapshots.every((snapshot) => !('exitEnabled' in snapshot))).toBe(true);
    expect(record.snapshots.every((snapshot) => !('doorOpen' in snapshot))).toBe(true);
    expect(record.config.level.objects.every((object) => !('requiredForExit' in object))).toBe(
      true,
    );
  });

  it('defines a replay projection with public level/state/action data only', () => {
    const record = createClosedAttemptRecordFixture();
    const replay: ReplayRecordView = {
      recordVersion: record.recordVersion,
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      config: { level: record.config.level },
      snapshots: record.snapshots,
      actions: record.actions.map((action, index) => ({
        ...action,
        before: record.snapshots[index]!,
        after: record.snapshots[index + 1]!,
      })),
      closure: record.closure,
      metrics: record.metrics,
      score: record.score,
    };
    expect(replay.config).toEqual({ level: record.config.level });
    expect(replay.config).not.toHaveProperty('robot');
    expect(replay.config).not.toHaveProperty('scoreRules');
    expect(replay.actions[0]).toMatchObject({
      before: { id: 'state-0' },
      after: { id: 'state-1' },
    });
  });

  it('checks representative DynamoDB projections per item, leaving bodies in S3 references', () => {
    const record = createClosedAttemptRecordFixture();
    const items = representativeAttemptItems(record);
    const keys = items.map(({ PK, SK }) => `${PK}/${SK}`);

    expect(keys).toContain('USER#fixture-owner/ATTEMPT#fixture-closed-attempt');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/META');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/STATE#state-0');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/STATE#state-8');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/STATE#state-17');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/ACTION#00000001');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/CALL#00000001');
    expect(
      items.every((item) => utf8ByteLength(item) < DYNAMODB_ITEM_LIMIT - REQUIRED_ITEM_MARGIN),
    ).toBe(true);

    const call = items.find(({ SK }) => SK === 'CALL#00000001');
    const header = items.find(({ SK }) => SK === 'ATTEMPT#fixture-closed-attempt');
    expect(call?.value).toMatchObject({
      requestBytes: 1024,
      responseBytes: 2048,
      requestKey: expect.stringContaining('/request.json'),
      responseKey: expect.stringContaining('/response.json'),
    });
    expect(call?.value).not.toHaveProperty('requestBody');
    expect(call?.value).not.toHaveProperty('responseBody');
    expect(header?.value).toHaveProperty('collectedObjectIds', ['recompensa-1', 'llave-1']);
    expect(header?.value).not.toHaveProperty('objectPoints');
  });
});

describe('durable terminal reason validation', () => {
  const replayInput = (status: 'victory' | 'defeat' | 'incomplete') => {
    const { actions, snapshots } = terminalChain(status);
    const lastResolution = actions.at(-1)?.resolution;
    const reason =
      status === 'victory'
        ? 'exit_reached'
        : status === 'incomplete'
          ? 'turn_limit_reached'
          : lastResolution && 'reason' in lastResolution
            ? lastResolution.reason
            : undefined;
    const attempt = persistedReplayAttempt(status, reason, snapshots, actions.length);
    return {
      actions,
      snapshots,
      attempt,
      rawActions: actions,
      rawSnapshots: snapshots.map((snapshot) => ({ stateId: snapshot.id, snapshot })),
    };
  };

  it.each([
    ['victory', 'exit_reached', 'walk_into_pit'],
    ['defeat', 'walk_into_pit', 'walk_into_branch'],
    ['incomplete', 'turn_limit_reached', 'wait'],
  ] as const)(
    'checks both presence and exact last-transition reason for %s replay closures',
    (status, validReason, otherReason) => {
      const { attempt, rawActions, rawSnapshots } = replayInput(status);
      expect(replayRecordViewOf(attempt, rawActions, rawSnapshots).closure).toMatchObject({
        status,
        reason: validReason,
      });
      for (const reason of [undefined, otherReason]) {
        const corrupted = { ...attempt, reason } as PersistedAttempt;
        expect(() => replayRecordViewOf(corrupted, rawActions, rawSnapshots)).toThrow(
          'causa del cierre',
        );
      }
    },
  );

  it('requires the complete persisted current snapshot to match the final replay snapshot', () => {
    const { attempt, rawActions, rawSnapshots, snapshots } = replayInput('victory');
    const final = snapshots.at(-1)!;
    const corrupted = {
      ...attempt,
      currentSnapshot: { ...final, turnsUsed: final.turnsUsed - 1 },
    } as PersistedAttempt;

    expect(() => replayRecordViewOf(corrupted, rawActions, rawSnapshots)).toThrow(
      'cierre no coincide',
    );
  });

  it.each([
    ['victory', 'exit_reached', 'walk_into_pit'],
    ['incomplete', 'turn_limit_reached', 'wait'],
  ] as const)('validates %s reason in summaries', (status, validReason, otherReason) => {
    const { attempt, snapshots } = replayInput(status);
    expect(summaryOf(attempt).reason).toBe(validReason);
    for (const reason of [undefined, otherReason]) {
      expect(() => summaryOf({ ...attempt, reason } as PersistedAttempt)).toThrow(
        'causa terminal esperada',
      );
    }
    expect(attempt.currentSnapshot).toEqual(snapshots.at(-1));
  });

  it('keeps a defeat cause in summaries only when it is a fatal game reason', () => {
    const { attempt } = replayInput('defeat');
    expect(summaryOf(attempt).reason).toBe('walk_into_pit');
    expect(() => summaryOf({ ...attempt, reason: undefined })).toThrow('causa de derrota');
    expect(() => summaryOf({ ...attempt, reason: 'wait' })).toThrow('causa de derrota');
  });
});
