import { describe, expect, it } from 'vitest';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  LEVEL,
  resolveAction,
  type GameSnapshot,
  type NormalizedAction,
} from '../../../shared/game';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot';
import { createClosedAttemptRecordFixture } from '../../../shared/attempt.fixture';
import { DEFAULT_ATTEMPT_CONFIG, readCurrentLevel } from '../../../shared/server/attempt';
import type { CallRecord } from '../../../shared/server/attempt';
import {
  AttemptNotTerminalError,
  DynamoAttemptStore,
  IdempotencyConflictError,
  MemoryAttemptStore,
  MemoryBodyStore,
  QuotaExceededError,
} from './attempt-store';

const savedDraft = (): DraftSnapshot => ({
  version: 1,
  updatedAt: '2026-09-21T12:00:00.000Z',
  draft: createDefaultDraft(),
});

const modelIdentity = {
  modelKey: 'claude-sonnet-4.6' as const,
  modelId: 'global.anthropic.claude-sonnet-4-6',
  region: 'us-east-1',
  profileVersion: 'claude-sonnet-4.6-global-v1',
};

const publishMemoryRoute = async (
  store: MemoryAttemptStore,
  attemptId: string,
  actions: readonly NormalizedAction[],
  usage: { readonly gameTokens: number | null },
) => {
  await store.claim('a', attemptId, 'executor');
  const started: CallRecord = {
    attemptId,
    seq: 1,
    decisionId: 'decision-1',
    ...modelIdentity,
    requestKey: `attempt/${attemptId}/request.json`,
    responseKey: `attempt/${attemptId}/response.json`,
    requestSha256: 'a'.repeat(64),
    requestBytes: 1,
    status: 'started',
    usage: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      gameTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    },
    createdAt: '2026-09-21T15:00:00.000Z',
    updatedAt: '2026-09-21T15:00:00.000Z',
  };
  await store.beginCall('a', attemptId, 'executor', started);
  await store.finishCall('a', attemptId, 'executor', {
    ...started,
    status: 'received',
    responseSha256: 'b'.repeat(64),
    responseBytes: 1,
    usage: {
      inputTokens: 200,
      outputTokens: 300,
      reasoningTokens: 0,
      gameTokens: usage.gameTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });

  let state = (await store.getSnapshot('a', attemptId)) as GameSnapshot;
  for (const [index, action] of actions.entries()) {
    const resolved = resolveAction(state, action, LEVEL);
    const terminalStatus = resolved.after.status === 'running' ? undefined : resolved.after.status;
    await store.publishAction('a', attemptId, 'executor', {
      seq: index + 1,
      decisionId: `decision-${index + 1}`,
      action: resolved.action,
      resolution: resolved.resolution,
      beforeStateId: resolved.before.id,
      afterStateId: resolved.after.id,
      beforeSnapshot: resolved.before,
      afterSnapshot: resolved.after,
      ...(terminalStatus ? { terminalStatus } : {}),
      ...('reason' in resolved.resolution ? { reason: resolved.resolution.reason } : {}),
      progress: resolved.after.maxSupportReached / LEVEL.segments.length,
      finalSupport: resolved.after.support,
      turnsUsed: resolved.after.turnsUsed,
    });
    state = resolved.after;
  }
  return store.get('a', attemptId);
};

describe('attempt lifecycle store', () => {
  it('reads the current level independent of serialized object key order', () => {
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (typeof value !== 'object' || value === null) return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .reverse()
          .map(([key, child]) => [key, reverseKeys(child)]),
      );
    };

    expect(readCurrentLevel(reverseKeys(LEVEL))).toEqual(LEVEL);
    expect(() => readCurrentLevel({ ...LEVEL, id: 'principal-estatico-v1' })).toThrow();
  });

  it('publishes actions atomically and returns an identical committed publication on retry', async () => {
    const store = new MemoryAttemptStore({ draft: savedDraft() });
    const { attempt } = await store.admit({
      owner: 'a',
      requestKey: 'atomic-publication',
      expectedVersion: 1,
      draft: savedDraft().draft,
      animationEnabled: false,
    });
    await store.claim('a', attempt.id, 'executor');
    const before = (await store.getSnapshot('a', attempt.id)) as GameSnapshot;
    const resolved = resolveAction(before, { kind: 'advance' }, LEVEL);
    const publication = (afterSnapshot: GameSnapshot) => ({
      seq: 1,
      decisionId: 'decision-1',
      action: resolved.action,
      resolution: resolved.resolution,
      beforeStateId: resolved.before.id,
      afterStateId: resolved.after.id,
      beforeSnapshot: resolved.before,
      afterSnapshot,
      progress: resolved.after.maxSupportReached / LEVEL.segments.length,
      finalSupport: resolved.after.support,
      turnsUsed: resolved.after.turnsUsed,
    });

    const invalidAfter = {
      ...resolved.after,
      inventory: ['recompensa-1', 'recompensa-1'],
    };
    await expect(
      store.publishAction('a', attempt.id, 'executor', publication(invalidAfter)),
    ).rejects.toThrow('inventario y los objetos restantes no forman una partición válida');
    await expect(store.getSnapshot('a', attempt.id, resolved.after.id)).resolves.toBeUndefined();
    await expect(store.get('a', attempt.id)).resolves.toMatchObject({ sequence: 0 });

    const committed = await store.publishAction(
      'a',
      attempt.id,
      'executor',
      publication(resolved.after),
    );
    expect(committed).toMatchObject({ sequence: 1, currentSnapshot: resolved.after });
    await expect(
      store.publishAction('a', attempt.id, 'executor', publication(resolved.after)),
    ).resolves.toEqual(committed);
    await expect(
      store.publishAction('a', attempt.id, 'executor', {
        ...publication(resolved.after),
        decisionId: 'different-decision',
      }),
    ).resolves.toBeUndefined();
    await expect(store.get('a', attempt.id)).resolves.toEqual(committed);

    await store.close('a', attempt.id, 'cancelled', 'cancelled_by_user');
    await expect(store.getReplayRecord('a', attempt.id)).resolves.toMatchObject({
      actions: [{ seq: 1, decisionId: 'decision-1' }],
      snapshots: [{ id: 'state-0' }, { id: resolved.after.id }],
      closure: { status: 'cancelled', actionCount: 1 },
    });
  });

  it('scores the persisted inventory and exposes its object summary without reading replay', async () => {
    const draft = savedDraft().draft;
    const store = new MemoryAttemptStore({ draft: savedDraft() });
    const routes: readonly {
      readonly requestKey: string;
      readonly actions: readonly NormalizedAction[];
      readonly gameTokens: number | null;
      readonly expected: {
        readonly status: 'victory' | 'defeat';
        readonly score: number | null;
        readonly collectedObjectIds: readonly string[];
        readonly objectPoints: number;
      };
    }[] = [
      {
        requestKey: 'collected-reward',
        actions: [
          { kind: 'advance' },
          { kind: 'jump', direction: 'right' },
          { kind: 'collect' },
          { kind: 'advance' },
          { kind: 'crouch', direction: 'right' },
          { kind: 'crouch', direction: 'right' },
          { kind: 'jump', direction: 'right' },
          { kind: 'advance' },
        ],
        gameTokens: 500,
        expected: {
          status: 'victory',
          score: 944.5,
          collectedObjectIds: ['recompensa-1'],
          objectPoints: 25,
        },
      },
      {
        requestKey: 'without-reward',
        actions: [
          { kind: 'advance' },
          { kind: 'jump', direction: 'right' },
          { kind: 'advance' },
          { kind: 'crouch', direction: 'right' },
          { kind: 'jump', direction: 'right' },
          { kind: 'jump', direction: 'right' },
          { kind: 'advance' },
        ],
        gameTokens: 500,
        expected: {
          status: 'victory',
          score: 929.5,
          collectedObjectIds: [],
          objectPoints: 0,
        },
      },
      {
        requestKey: 'unknown-usage',
        actions: [
          { kind: 'advance' },
          { kind: 'jump', direction: 'right' },
          { kind: 'advance' },
          { kind: 'crouch', direction: 'right' },
          { kind: 'jump', direction: 'right' },
          { kind: 'jump', direction: 'right' },
          { kind: 'advance' },
        ],
        gameTokens: null,
        expected: {
          status: 'victory',
          score: null,
          collectedObjectIds: [],
          objectPoints: 0,
        },
      },
      {
        requestKey: 'defeat-score',
        actions: [{ kind: 'advance' }, { kind: 'advance' }],
        gameTokens: 500,
        expected: {
          status: 'defeat',
          score: null,
          collectedObjectIds: [],
          objectPoints: 0,
        },
      },
    ];

    for (const route of routes) {
      const { attempt } = await store.admit({
        owner: 'a',
        requestKey: route.requestKey,
        expectedVersion: 1,
        draft,
        animationEnabled: false,
      });
      const saved = await publishMemoryRoute(store, attempt.id, route.actions, {
        gameTokens: route.gameTokens,
      });
      expect(saved).toMatchObject({
        status: route.expected.status,
        score: route.expected.score,
        collectedObjectIds: route.expected.collectedObjectIds,
      });
      expect(saved).not.toHaveProperty('objectPoints');
      expect((await store.list('a')).attempts).toContainEqual(
        expect.objectContaining({
          id: attempt.id,
          collectedObjectIds: route.expected.collectedObjectIds,
          objectPoints: route.expected.objectPoints,
          score: route.expected.score,
        }),
      );
    }
  });

  it('checks idempotency before the draft version and quota', async () => {
    const store = new MemoryAttemptStore({
      quotaLimit: 1,
      draft: savedDraft(),
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const draft = savedDraft().draft;
    const first = await store.admit({
      owner: 'a',
      requestKey: 'same',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    expect(first.attempt).toMatchObject({
      modelKey: 'claude-sonnet-4.6',
      modelLabel: 'Claude Sonnet 4.6',
      modelId: 'global.anthropic.claude-sonnet-4-6',
    });
    expect((await store.get('a', first.attempt.id))?.config.engineVersion).toBe(
      'periodic-engine-v3',
    );
    expect((await store.get('a', first.attempt.id))?.config.scoreParameters).toEqual(
      DEFAULT_ATTEMPT_CONFIG.scoreParameters,
    );
    const duplicate = await store.admit({
      owner: 'a',
      requestKey: 'same',
      expectedVersion: 999,
      draft,
      animationEnabled: false,
    });
    expect(duplicate.admitted).toBe(false);
    expect(duplicate.attempt.id).toBe(first.attempt.id);
    await expect(
      store.admit({
        owner: 'a',
        requestKey: 'different',
        expectedVersion: 1,
        draft,
        animationEnabled: false,
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(
      store.admit({
        owner: 'a',
        requestKey: 'same',
        expectedVersion: 1,
        draft: { ...draft, instructions: 'otro' },
        animationEnabled: false,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('stores preference versions and binds the animation choice into idempotency', async () => {
    const draft = savedDraft().draft;
    const store = new MemoryAttemptStore({ draft: savedDraft() });
    expect(await store.getAnimationPreference('a')).toEqual({ animationEnabled: true, version: 0 });
    expect(await store.putAnimationPreference('a', false, 0)).toEqual({
      animationEnabled: false,
      version: 1,
    });
    await expect(store.putAnimationPreference('a', true, 0)).rejects.toMatchObject({
      current: { animationEnabled: false, version: 1 },
    });
    expect(await store.getAnimationPreference('a')).toEqual({
      animationEnabled: false,
      version: 1,
    });

    const firstRequest = await store.admit({
      owner: 'a',
      requestKey: 'animation-off',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    expect(firstRequest.attempt.animationEnabled).toBe(false);
    const recovered = await store.admit({
      owner: 'a',
      requestKey: 'animation-off',
      expectedVersion: 999,
      draft,
      animationEnabled: false,
    });
    expect(recovered.admitted).toBe(false);
    expect(recovered.attempt.id).toBe(firstRequest.attempt.id);
    await expect(
      store.admit({
        owner: 'a',
        requestKey: 'animation-off',
        expectedVersion: 1,
        draft,
        animationEnabled: true,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('keeps terminal presentation pending only when animation has published actions', async () => {
    const draft = savedDraft().draft;
    const now = () => new Date('2026-09-21T15:00:00.000Z');
    const makeTerminalRecord = async (animationEnabled: boolean, suffix: string) => {
      const store = new MemoryAttemptStore({ draft: savedDraft(), now });
      const { attempt } = await store.admit({
        owner: 'a',
        requestKey: suffix,
        expectedVersion: 1,
        draft,
        animationEnabled,
      });
      await store.claim('a', attempt.id, 'executor');
      const before = (await store.getSnapshot('a', attempt.id)) as GameSnapshot;
      const resolved = resolveAction(before, { kind: 'advance' }, LEVEL);
      await store.publishAction('a', attempt.id, 'executor', {
        seq: 1,
        decisionId: 'decision-1',
        action: resolved.action,
        resolution: resolved.resolution,
        beforeStateId: resolved.before.id,
        afterStateId: resolved.after.id,
        beforeSnapshot: resolved.before,
        afterSnapshot: resolved.after,
        progress: 0.2,
        finalSupport: resolved.after.support,
        turnsUsed: 1,
      });
      const terminal = await store.close('a', attempt.id, 'cancelled', 'cancelled_by_user');
      return { store, attemptId: attempt.id, terminal };
    };

    const animated = await makeTerminalRecord(true, 'animated');
    const animationOffResult = await makeTerminalRecord(false, 'animation-off');
    expect(animated.terminal?.presentationComplete).toBe(false);
    expect(animationOffResult.terminal?.presentationComplete).toBe(true);
    const animatedRecord = await animated.store.getReplayRecord('a', animated.attemptId);
    const animationOffRecord = await animationOffResult.store.getReplayRecord(
      'a',
      animationOffResult.attemptId,
    );
    expect(animatedRecord).toMatchObject({
      actions: [{ seq: 1, action: { kind: 'advance' } }],
      closure: { status: 'cancelled', actionCount: 1 },
    });
    expect(animationOffRecord).toMatchObject({
      actions: animatedRecord?.actions,
      metrics: animatedRecord?.metrics,
    });
    expect(animationOffRecord?.snapshots).toEqual(animatedRecord?.snapshots);

    await expect(
      animated.store.markPresentationComplete('a', animated.attemptId),
    ).resolves.toMatchObject({ presentationComplete: true });
    await expect(
      animated.store.markPresentationComplete('a', animated.attemptId),
    ).resolves.toMatchObject({ presentationComplete: true });
    expect(await animated.store.getReplayRecord('a', animated.attemptId)).toEqual(animatedRecord);
  });

  it('completes zero-action error and cancellation paths without inventing an action', async () => {
    const store = new MemoryAttemptStore({ draft: savedDraft() });
    const draft = savedDraft().draft;
    const { attempt } = await store.admit({
      owner: 'a',
      requestKey: 'no-action-error',
      expectedVersion: 1,
      draft,
      animationEnabled: true,
    });
    expect(attempt.presentationComplete).toBe(false);
    const closed = await store.close('a', attempt.id, 'error', 'startup_failure');
    expect(closed?.presentationComplete).toBe(true);
    const replay = await store.getReplayRecord('a', attempt.id);
    expect(replay).toMatchObject({
      actions: [],
      snapshots: [{ id: 'state-0' }],
      closure: { status: 'error', actionCount: 0, recordComplete: true },
    });

    const { attempt: pending } = await store.admit({
      owner: 'a',
      requestKey: 'presentation-before-terminal',
      expectedVersion: 1,
      draft,
      animationEnabled: true,
    });
    await expect(store.markPresentationComplete('a', pending.id)).rejects.toBeInstanceOf(
      AttemptNotTerminalError,
    );
  });

  it('leaves a terminal action victory pending until its automatic presentation is marked', async () => {
    const draft = savedDraft().draft;
    const fixture = createClosedAttemptRecordFixture();
    const store = new MemoryAttemptStore({ draft: savedDraft() });
    const { attempt } = await store.admit({
      owner: 'a',
      requestKey: 'animated-victory',
      expectedVersion: 1,
      draft,
      animationEnabled: true,
    });
    await store.claim('a', attempt.id, 'executor');
    for (const action of fixture.actions) {
      const before = fixture.snapshots.find((snapshot) => snapshot.id === action.beforeStateId);
      const after = fixture.snapshots.find((snapshot) => snapshot.id === action.afterStateId);
      if (!before || !after) throw new Error('fixture action is missing its referenced state');
      await store.publishAction('a', attempt.id, 'executor', {
        ...action,
        beforeSnapshot: before,
        afterSnapshot: after,
        progress: after.maxSupportReached / LEVEL.segments.length,
        finalSupport: after.support,
        turnsUsed: after.turnsUsed,
        ...(action.seq === fixture.actions.length ? { terminalStatus: 'victory' as const } : {}),
      });
    }
    expect(await store.get('a', attempt.id)).toMatchObject({
      status: 'victory',
      turnsUsed: fixture.actions.length,
      presentationComplete: false,
    });
    await expect(store.markPresentationComplete('a', attempt.id)).resolves.toMatchObject({
      status: 'victory',
      presentationComplete: true,
    });
  });

  it('allows two keys until the last quota slot and only one concurrent claim', async () => {
    const store = new MemoryAttemptStore({
      quotaLimit: 2,
      draft: savedDraft(),
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const draft = savedDraft().draft;
    const [a, b] = await Promise.all([
      store.admit({
        owner: 'a',
        requestKey: 'a',
        expectedVersion: 1,
        draft,
        animationEnabled: false,
      }),
      store.admit({
        owner: 'a',
        requestKey: 'b',
        expectedVersion: 1,
        draft,
        animationEnabled: false,
      }),
    ]);
    const claimed = await Promise.all([
      store.claim('a', a.attempt.id, 'executor-a'),
      store.claim('a', a.attempt.id, 'executor-b'),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect((await store.quota('a')).used).toBe(2);
    expect(b.attempt.id).not.toBe(a.attempt.id);
  });

  it('records wait against the start phase and replays the periodic transition', async () => {
    const base = createDefaultDraft();
    const draft = {
      ...base,
      skills: base.skills.map((skill) => ({
        ...skill,
        enabled: skill.id === 'wait' || skill.enabled,
      })),
    };
    const store = new MemoryAttemptStore({ draft: { version: 1, draft } });
    const { attempt } = await store.admit({
      owner: 'a',
      requestKey: 'periodic-wait',
      expectedVersion: 1,
      draft,
      animationEnabled: true,
    });
    await store.claim('a', attempt.id, 'executor');
    const before = (await store.getSnapshot('a', attempt.id)) as GameSnapshot;
    const resolved = resolveAction(before, { kind: 'wait' }, LEVEL);
    await store.publishAction('a', attempt.id, 'executor', {
      seq: 1,
      decisionId: 'decision-1',
      action: resolved.action,
      resolution: resolved.resolution,
      beforeStateId: resolved.before.id,
      afterStateId: resolved.after.id,
      beforeSnapshot: resolved.before,
      afterSnapshot: resolved.after,
      progress: 0,
      finalSupport: resolved.after.support,
      turnsUsed: resolved.after.turnsUsed,
    });
    await store.close('a', attempt.id, 'cancelled', 'cancelled_by_user');

    const replay = await store.getReplayRecord('a', attempt.id);
    expect(replay?.config.level).toEqual(LEVEL);
    expect(replay?.actions[0]).toMatchObject({
      action: { kind: 'wait' },
      resolution: { outcome: 'no_op', reason: 'wait' },
      before: { phaseTurn: 0, terrain: expect.arrayContaining(['barrier_low', 'ground']) },
      after: { phaseTurn: 1, terrain: expect.arrayContaining(['barrier_high', 'pit']) },
    });
  });

  it('rejects a persisted movement whose cause does not match its recorded terrain', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({ draft: { version: 1, draft } });
    const { attempt } = await store.admit({
      owner: 'a',
      requestKey: 'invalid-replay-cause',
      expectedVersion: 1,
      draft,
      animationEnabled: true,
    });
    await store.claim('a', attempt.id, 'executor');
    const before = (await store.getSnapshot('a', attempt.id)) as GameSnapshot;
    const resolved = resolveAction(before, { kind: 'advance' }, LEVEL);
    await store.publishAction('a', attempt.id, 'executor', {
      seq: 1,
      decisionId: 'decision-1',
      action: resolved.action,
      resolution: { ...resolved.resolution, reason: 'walk_into_pit' },
      beforeStateId: resolved.before.id,
      afterStateId: resolved.after.id,
      beforeSnapshot: resolved.before,
      afterSnapshot: resolved.after,
      progress: 1 / LEVEL.segments.length,
      finalSupport: resolved.after.support,
      turnsUsed: resolved.after.turnsUsed,
    });
    await store.close('a', attempt.id, 'cancelled', 'cancelled_by_user');

    await expect(store.getReplayRecord('a', attempt.id)).rejects.toThrow(
      'contradice el contrato del juego',
    );
  });

  it('replays the low-barrier collision cause from its start phase', async () => {
    const base = createDefaultDraft();
    const draft = {
      ...base,
      skills: base.skills.map((skill) => ({
        ...skill,
        enabled: skill.id === 'advance' || skill.id === 'jump' || skill.id === 'crouch',
      })),
    };
    const store = new MemoryAttemptStore({ draft: { version: 1, draft } });
    const { attempt } = await store.admit({
      owner: 'a',
      requestKey: 'low-barrier-collision',
      expectedVersion: 1,
      draft,
      animationEnabled: true,
    });
    await store.claim('a', attempt.id, 'executor');
    let snapshot = (await store.getSnapshot('a', attempt.id)) as GameSnapshot;
    const actions = [
      { kind: 'advance' },
      { kind: 'jump', direction: 'right' },
      { kind: 'advance' },
      { kind: 'crouch', direction: 'right' },
      { kind: 'advance' },
    ] as const;
    for (const [index, action] of actions.entries()) {
      const resolved = resolveAction(snapshot, action, LEVEL);
      await store.publishAction('a', attempt.id, 'executor', {
        seq: index + 1,
        decisionId: `decision-${index + 1}`,
        action: resolved.action,
        resolution: resolved.resolution,
        beforeStateId: resolved.before.id,
        afterStateId: resolved.after.id,
        beforeSnapshot: resolved.before,
        afterSnapshot: resolved.after,
        ...(resolved.after.status === 'running'
          ? {}
          : {
              terminalStatus: 'defeat' as const,
              ...('reason' in resolved.resolution ? { reason: resolved.resolution.reason } : {}),
            }),
        progress: resolved.after.maxSupportReached / LEVEL.segments.length,
        finalSupport: resolved.after.support,
        turnsUsed: resolved.after.turnsUsed,
      });
      snapshot = resolved.after;
    }

    const replay = await store.getReplayRecord('a', attempt.id);
    expect(replay?.actions.at(-1)).toMatchObject({
      action: { kind: 'advance' },
      resolution: { outcome: 'collision', reason: 'walk_into_barrier' },
      before: { phaseTurn: 4, terrain: expect.arrayContaining(['barrier_low']) },
      after: { status: 'defeat', phaseTurn: 4 },
    });
  });

  it('makes cancel/claim and cancel/publish races conditional', async () => {
    const store = new MemoryAttemptStore({
      draft: savedDraft(),
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const draft = savedDraft().draft;
    const { attempt } = await store.admit({
      owner: 'a',
      requestKey: 'race',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const cancelled = await store.requestCancel('a', attempt.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(await store.claim('a', attempt.id, 'executor')).toBeUndefined();

    const second = await store.admit({
      owner: 'a',
      requestKey: 'race-2',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    expect(await store.claim('a', second.attempt.id, 'executor')).toBeTruthy();
    await store.requestCancel('a', second.attempt.id);
    const call = {
      attemptId: second.attempt.id,
      seq: 1,
      decisionId: 'd1',
      ...modelIdentity,
      requestKey: 'r',
      responseKey: 's',
      requestSha256: 'x',
      requestBytes: 1,
      status: 'received' as const,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: null,
        gameTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      createdAt: '2026-09-21T15:00:00.000Z',
      updatedAt: '2026-09-21T15:00:00.000Z',
    };
    expect(await store.beginCall('a', second.attempt.id, 'executor', call)).toBeUndefined();
  });

  it('stores exact immutable bodies and rejects different retry bytes', async () => {
    const bodies = new MemoryBodyStore();
    const bytes = new TextEncoder().encode('{"unicode":"🦾"}');
    const first = await bodies.put('attempt/a/request', bytes);
    expect(first.bytes).toBe(bytes.byteLength);
    await expect(
      bodies.put('attempt/a/request', new TextEncoder().encode('{"unicode":"otro"}')),
    ).rejects.toThrow('inmutable');
    expect(new TextDecoder().decode(await bodies.get('attempt/a/request'))).toBe(
      '{"unicode":"🦾"}',
    );
  });

  it('keeps known usage fields when another field is unavailable', async () => {
    const store = new MemoryAttemptStore({
      draft: savedDraft(),
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const draft = savedDraft().draft;
    const { attempt } = await store.admit({
      owner: 'a',
      requestKey: 'partial-usage',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    await store.claim('a', attempt.id, 'executor');
    const started = {
      attemptId: attempt.id,
      seq: 1,
      decisionId: 'decision-1',
      ...modelIdentity,
      requestKey: 'request-1',
      responseKey: 'response-1',
      requestSha256: 'request-hash',
      requestBytes: 10,
      status: 'started' as const,
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        gameTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
      createdAt: '2026-09-21T15:00:01.000Z',
      updatedAt: '2026-09-21T15:00:01.000Z',
    };
    await store.beginCall('a', attempt.id, 'executor', started);
    await store.finishCall('a', attempt.id, 'executor', {
      ...started,
      status: 'error',
      responseSha256: 'response-hash',
      responseBytes: 20,
      usage: {
        inputTokens: 7,
        outputTokens: null,
        reasoningTokens: 12,
        gameTokens: 3,
        cacheReadTokens: null,
        cacheWriteTokens: 2,
      },
      updatedAt: '2026-09-21T15:00:02.000Z',
    });
    const saved = await store.get('a', attempt.id);
    expect(saved).toMatchObject({
      calls: 1,
      inputTokens: 7,
      outputTokens: null,
      reasoningTokens: 12,
      gameTokens: 3,
      cacheReadTokens: null,
      cacheWriteTokens: 2,
      recordComplete: true,
    });
  });

  it('does not mark an active started call incomplete during recovery polling', async () => {
    const memory = new MemoryAttemptStore({
      draft: savedDraft(),
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const draft = savedDraft().draft;
    const { attempt } = await memory.admit({
      owner: 'a',
      requestKey: 'recovery-poll',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const running = await memory.claim('a', attempt.id, 'executor');
    if (!running) throw new Error('test setup did not claim attempt');
    const started = {
      attemptId: attempt.id,
      seq: 1,
      decisionId: 'decision-1',
      ...modelIdentity,
      requestKey: 'request-1',
      responseKey: 'response-1',
      requestSha256: 'request-hash',
      requestBytes: 10,
      status: 'started' as const,
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        gameTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
      createdAt: '2026-09-21T15:00:01.000Z',
      updatedAt: '2026-09-21T15:00:01.000Z',
    };
    await memory.beginCall('a', attempt.id, 'executor', started);
    const closed = await memory.close('a', attempt.id, 'error', 'timeout', 'executor');
    expect(closed).toMatchObject({
      status: 'error',
      calls: 1,
      inputTokens: null,
      outputTokens: null,
      gameTokens: null,
      recordComplete: false,
    });
    const storedCall = {
      ...started,
      status: 'started' as const,
    };
    const stateItem = marshall({ snapshot: running.currentSnapshot });
    const headerItem = marshall(running, { removeUndefinedValues: true });
    const callItem = marshall(storedCall, { removeUndefinedValues: true });
    let updates = 0;
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        if (name === 'GetItemCommand') {
          const key = command.input.Key as { SK?: { S?: string } };
          return { Item: key.SK?.S?.startsWith('STATE#') ? stateItem : headerItem };
        }
        if (name === 'QueryCommand') return { Items: [callItem] };
        if (name === 'UpdateItemCommand') {
          updates += 1;
          return {};
        }
        throw new Error(`unexpected command ${name}`);
      },
    };
    const store = new DynamoAttemptStore({
      client: client as unknown as DynamoDBClient,
      tableName: 'attempts',
      bodyStore: new MemoryBodyStore(),
    });
    await store.recoverBodies('a', attempt.id);
    expect(updates).toBe(0);
  });

  it('rereads a winner after a same-key transaction conflict without retrying the write', async () => {
    const draft = savedDraft().draft;
    const winnerStore = new MemoryAttemptStore({ draft: savedDraft() });
    const winner = await winnerStore.admit({
      owner: 'a',
      requestKey: 'transaction-conflict',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const winnerRecord = await winnerStore.get('a', winner.attempt.id);
    if (!winnerRecord) throw new Error('test setup did not create winner');
    let requestReads = 0;
    let transactions = 0;
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        if (name === 'TransactWriteItemsCommand') {
          transactions += 1;
          const error = new TransactionCanceledException({
            message: 'transaction conflict',
            $metadata: {},
          });
          (error as unknown as { CancellationReasons: unknown[] }).CancellationReasons = [
            { Code: 'TransactionConflict' },
          ];
          throw error;
        }
        if (name !== 'GetItemCommand') throw new Error(`unexpected command ${name}`);
        const key = command.input.Key as { SK?: { S?: string } };
        const sk = key.SK?.S;
        if (sk === 'REQUEST#transaction-conflict') {
          requestReads += 1;
          return requestReads >= 3 ? { Item: marshall({ attemptId: winner.attempt.id }) } : {};
        }
        if (sk === 'DRAFT') return { Item: marshall({ version: 1, draft }) };
        if (sk === `ATTEMPT#${winner.attempt.id}`)
          return { Item: marshall(winnerRecord, { removeUndefinedValues: true }) };
        if (sk === 'STATE#state-0')
          return { Item: marshall({ snapshot: winnerRecord.currentSnapshot }) };
        return {};
      },
    };
    const store = new DynamoAttemptStore({
      client: client as unknown as DynamoDBClient,
      tableName: 'attempts',
    });
    const result = await store.admit({
      owner: 'a',
      requestKey: 'transaction-conflict',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    expect(result.admitted).toBe(false);
    expect(result.attempt.id).toBe(winner.attempt.id);
    expect(requestReads).toBe(3);
    expect(transactions).toBe(1);
  });

  it('binds every pending-cancel condition value in the Dynamo command', async () => {
    const draft = savedDraft().draft;
    const memory = new MemoryAttemptStore({ draft: savedDraft() });
    const admitted = await memory.admit({
      owner: 'a',
      requestKey: 'pending-cancel-command',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const record = await memory.get('a', admitted.attempt.id);
    if (!record) throw new Error('test setup did not create pending record');
    let updateInput: Record<string, unknown> | undefined;
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        if (name === 'UpdateItemCommand') {
          updateInput = command.input;
          return {};
        }
        if (name !== 'GetItemCommand') throw new Error(`unexpected command ${name}`);
        const key = command.input.Key as { SK?: { S?: string } };
        return {
          Item:
            key.SK?.S === 'STATE#state-0'
              ? marshall({ snapshot: record.currentSnapshot })
              : marshall(record, { removeUndefinedValues: true }),
        };
      },
    };
    const store = new DynamoAttemptStore({
      client: client as unknown as DynamoDBClient,
      tableName: 'attempts',
    });
    await store.requestCancel('a', record.id, '2026-09-21T15:00:00.000Z');
    const values = updateInput?.ExpressionAttributeValues as Record<string, { BOOL?: boolean }>;
    expect(values[':false']).toEqual({ BOOL: false });
  });

  it('omits unused optional call aliases from the Dynamo finish command', async () => {
    const draft = savedDraft().draft;
    const memory = new MemoryAttemptStore({ draft: savedDraft() });
    const admitted = await memory.admit({
      owner: 'a',
      requestKey: 'finish-call-aliases',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const claimed = await memory.claim('a', admitted.attempt.id, 'executor');
    if (!claimed) throw new Error('test setup did not claim record');
    const started = {
      attemptId: admitted.attempt.id,
      seq: 1,
      decisionId: 'decision-1',
      ...modelIdentity,
      requestKey: 'request-1',
      responseKey: 'response-1',
      requestSha256: 'request-hash',
      requestBytes: 10,
      status: 'started' as const,
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        gameTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
      createdAt: '2026-09-21T15:00:01.000Z',
      updatedAt: '2026-09-21T15:00:01.000Z',
    };
    await memory.beginCall('a', admitted.attempt.id, 'executor', started);
    const persisted = { ...started, status: 'error' as const };
    const currentItem = marshall(claimed, { removeUndefinedValues: true });
    const callItem = marshall(persisted, { removeUndefinedValues: true });
    let transactionInput: Record<string, unknown> | undefined;
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        if (name === 'GetItemCommand') return { Item: currentItem };
        if (name === 'QueryCommand') return { Items: [callItem] };
        if (name === 'TransactWriteItemsCommand') {
          transactionInput = command.input;
          throw new TransactionCanceledException({ message: 'condition', $metadata: {} });
        }
        throw new Error(`unexpected command ${name}`);
      },
    };
    const store = new DynamoAttemptStore({
      client: client as unknown as DynamoDBClient,
      tableName: 'attempts',
    });
    await store.finishCall('a', admitted.attempt.id, 'executor', {
      ...persisted,
      responseSha256: 'response-hash',
      responseBytes: 20,
      updatedAt: '2026-09-21T15:00:02.000Z',
    });
    const update = ((transactionInput?.TransactItems as Array<{
      Update?: { ExpressionAttributeNames?: Record<string, string> };
    }>) ?? [])[0]?.Update;
    expect(update?.ExpressionAttributeNames).not.toHaveProperty('#requestId');
    expect(update?.ExpressionAttributeNames).not.toHaveProperty('#responseStatus');
    expect(update?.ExpressionAttributeNames).not.toHaveProperty('#errorCode');
  });
});
