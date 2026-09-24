import { describe, expect, it, vi } from 'vitest';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { LEVEL, resolveAction, type GameSnapshot } from '../../../shared/game';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot';
import { createClosedAttemptRecordFixture } from '../../../shared/attempt.fixture';
import {
  AttemptNotTerminalError,
  DynamoAttemptStore,
  IdempotencyConflictError,
  MemoryAttemptStore,
  MemoryBodyStore,
  ModelUnavailableError,
  QuotaExceededError,
} from './attempt-store';
import * as models from '../../../shared/models';

const savedDraft = (): DraftSnapshot => ({
  version: 1,
  updatedAt: '2026-09-21T12:00:00.000Z',
  draft: createDefaultDraft(),
});

describe('attempt lifecycle store', () => {
  it('checks idempotency before the draft version and quota', async () => {
    const store = new MemoryAttemptStore({
      quotaLimit: 1,
      draft: savedDraft(),
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const draft = savedDraft().draft;
    const first = await store.admit({ owner: 'a', requestKey: 'same', expectedVersion: 1, draft });
    expect(first.attempt).toMatchObject({
      modelKey: 'claude-sonnet-4.6',
      modelLabel: 'Claude Sonnet 4.6',
      modelId: 'global.anthropic.claude-sonnet-4-6',
    });
    const duplicate = await store.admit({
      owner: 'a',
      requestKey: 'same',
      expectedVersion: 999,
      draft,
    });
    expect(duplicate.admitted).toBe(false);
    expect(duplicate.attempt.id).toBe(first.attempt.id);
    await expect(
      store.admit({ owner: 'a', requestKey: 'different', expectedVersion: 1, draft }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(
      store.admit({
        owner: 'a',
        requestKey: 'same',
        expectedVersion: 1,
        draft: { ...draft, instructions: 'otro' },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      store.admit({
        owner: 'a',
        requestKey: 'same',
        expectedVersion: 1,
        draft: { ...draft, modelKey: 'gpt-5.6-sol' },
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

    const oldRequest = await store.admit({
      owner: 'a',
      requestKey: 'legacy-presentation',
      expectedVersion: 1,
      draft,
    });
    expect(oldRequest.attempt.animationEnabled).toBe(false);
    const recovered = await store.admit({
      owner: 'a',
      requestKey: 'legacy-presentation',
      expectedVersion: 999,
      draft,
      animationEnabled: false,
    });
    expect(recovered.admitted).toBe(false);
    expect(recovered.attempt.id).toBe(oldRequest.attempt.id);
    await expect(
      store.admit({
        owner: 'a',
        requestKey: 'legacy-presentation',
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
    const staticResult = await makeTerminalRecord(false, 'static');
    expect(animated.terminal?.presentationComplete).toBe(false);
    expect(staticResult.terminal?.presentationComplete).toBe(true);
    const animatedRecord = await animated.store.getReplayRecord('a', animated.attemptId);
    const staticRecord = await staticResult.store.getReplayRecord('a', staticResult.attemptId);
    expect(animatedRecord).toMatchObject({
      actions: [{ seq: 1, action: { kind: 'advance' } }],
      closure: { status: 'cancelled', actionCount: 1 },
    });
    expect(staticRecord).toMatchObject({
      actions: animatedRecord?.actions,
      metrics: animatedRecord?.metrics,
    });
    expect(staticRecord?.snapshots).toEqual(animatedRecord?.snapshots);

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
      store.admit({ owner: 'a', requestKey: 'a', expectedVersion: 1, draft }),
      store.admit({ owner: 'a', requestKey: 'b', expectedVersion: 1, draft }),
    ]);
    const claimed = await Promise.all([
      store.claim('a', a.attempt.id, 'executor-a'),
      store.claim('a', a.attempt.id, 'executor-b'),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect((await store.quota('a')).used).toBe(2);
    expect(b.attempt.id).not.toBe(a.attempt.id);
  });

  it('recovers a duplicate before checking a temporarily inactive model', async () => {
    const blockedDraft = { ...createDefaultDraft(), modelKey: 'claude-sonnet-5' as const };
    const store = new MemoryAttemptStore({
      quotaLimit: 1,
      draft: { ...savedDraft(), draft: blockedDraft },
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const draft = blockedDraft;
    const resolver = vi
      .spyOn(models, 'resolveAvailableModelProfile')
      .mockImplementation((key) => models.resolveModelProfile(key));
    const first = await store.admit({
      owner: 'a',
      requestKey: 'inactive',
      expectedVersion: 1,
      draft,
    });
    resolver.mockImplementation(() => {
      throw new Error('temporarily unavailable');
    });
    try {
      const duplicate = await store.admit({
        owner: 'a',
        requestKey: 'inactive',
        expectedVersion: 999,
        draft,
      });
      expect(duplicate.admitted).toBe(false);
      expect(duplicate.attempt.id).toBe(first.attempt.id);
      expect((await store.quota('a')).used).toBe(1);
      await expect(
        store.admit({ owner: 'a', requestKey: 'new-inactive', expectedVersion: 1, draft }),
      ).rejects.toBeInstanceOf(ModelUnavailableError);
      expect((await store.quota('a')).used).toBe(1);
    } finally {
      resolver.mockRestore();
    }
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
    });
    const cancelled = await store.requestCancel('a', attempt.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(await store.claim('a', attempt.id, 'executor')).toBeUndefined();

    const second = await store.admit({
      owner: 'a',
      requestKey: 'race-2',
      expectedVersion: 1,
      draft,
    });
    expect(await store.claim('a', second.attempt.id, 'executor')).toBeTruthy();
    await store.requestCancel('a', second.attempt.id);
    const call = {
      attemptId: second.attempt.id,
      seq: 1,
      decisionId: 'd1',
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
    });
    await store.claim('a', attempt.id, 'executor');
    const started = {
      attemptId: attempt.id,
      seq: 1,
      decisionId: 'decision-1',
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
    });
    const running = await memory.claim('a', attempt.id, 'executor');
    if (!running) throw new Error('test setup did not claim attempt');
    const started = {
      attemptId: attempt.id,
      seq: 1,
      decisionId: 'decision-1',
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
    });
    const claimed = await memory.claim('a', admitted.attempt.id, 'executor');
    if (!claimed) throw new Error('test setup did not claim record');
    const started = {
      attemptId: admitted.attempt.id,
      seq: 1,
      decisionId: 'decision-1',
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
