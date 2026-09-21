import { describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot';
import {
  DynamoAttemptStore,
  MemoryAttemptStore,
  MemoryBodyStore,
  IdempotencyConflictError,
  QuotaExceededError,
} from './attempt-store';

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
});
