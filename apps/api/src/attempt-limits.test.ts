import { describe, expect, it } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import type { CallRecord } from '../../../shared/server/attempt.js';
// Fictional amounts for transactional accounting tests, not operational prices.
const TEST_EXECUTION_LIMITS = {
  globalActiveAttempts: 2,
  globalDailyMicros: 10_000,
  userDailyMicros: 8_000,
  rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 },
};
import {
  MemoryAttemptStore,
  AttemptCapacityError,
  BudgetUnavailableError,
} from './attempt-store.js';

const now = '2026-10-04T15:00:00.000Z';
const draft = createDefaultDraft();
const storeFor = (override = {}) =>
  new MemoryAttemptStore({
    now: () => new Date(now),
    draft: { version: 1, draft },
    limits: { ...TEST_EXECUTION_LIMITS, ...override },
  });
const admit = (store: MemoryAttemptStore, owner: string, requestKey = owner) =>
  store.admit({ owner, requestKey, expectedVersion: 1, draft, animationEnabled: false });
const callFor = (attemptId: string, seq = 1): CallRecord => ({
  attemptId,
  seq,
  decisionId: 'decision-1',
  requestKey: `request-${seq}`,
  responseKey: `response-${seq}`,
  requestSha256: 'request-hash',
  requestBytes: 1000,
  countedInputTokens: 100,
  status: 'started',
  usage: {
    inputTokens: null,
    outputTokens: null,
    gameTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  },
  modelKey: draft.modelKey,
  modelId: 'global.anthropic.claude-sonnet-4-6',
  region: 'us-east-1',
  profileVersion: 'claude-sonnet-4.6-global-v1',
  createdAt: now,
  updatedAt: now,
});
const running = async (store: MemoryAttemptStore, owner: string) => {
  const { attempt } = await admit(store, owner);
  await store.claim(owner, attempt.id, 'executor');
  return attempt.id;
};

describe('atomic active attempts and inference margin', () => {
  it('admits a single request across sessions and rejects a distinct active attempt before quota', async () => {
    const store = storeFor();
    const results = await Promise.all([admit(store, 'owner'), admit(store, 'owner')]);
    expect(results[0].attempt.id).toBe(results[1].attempt.id);
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    await expect(admit(store, 'owner', 'other')).rejects.toThrow(AttemptCapacityError);
    expect((await store.quota('owner')).used).toBe(1);
    await store.requestCancel('owner', results[0].attempt.id);
    await expect(admit(store, 'owner', 'other')).resolves.toMatchObject({ admitted: true });
  });
  it('races global capacity without consuming the rejected quota and recovers expired pending slots', async () => {
    const store = storeFor();
    const results = await Promise.allSettled(['a', 'b', 'c'].map((owner) => admit(store, owner)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect((await store.quota('c')).used).toBe(0);
    await expect(
      store.admit({
        owner: 'c',
        requestKey: 'late',
        expectedVersion: 1,
        draft,
        animationEnabled: false,
        now: '2026-10-04T15:06:00.000Z',
      }),
    ).resolves.toMatchObject({ admitted: true });
  });
  it('reserves each concurrent initial call atomically', async () => {
    const store = storeFor({ globalDailyMicros: 1500 });
    const ids = await Promise.all(['a', 'b'].map((owner) => running(store, owner)));
    const results = await Promise.allSettled(
      ids.map((id, index) => store.beginCall(['a', 'b'][index], id, 'executor', callFor(id))),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(BudgetUnavailableError),
    });
    expect(store.budgetAmount('2026-10-04')).toBe(1174);
    expect(await store.getCalls('b', ids[1])).toHaveLength(0);
  });
  it('settles reported cache usage once and reauthorizes each retry independently', async () => {
    const store = storeFor();
    const id = await running(store, 'a');
    const call = await store.beginCall('a', id, 'executor', callFor(id));
    const finished: CallRecord = {
      ...call!,
      status: 'error',
      responseSha256: 'response',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        reasoningTokens: 5,
        gameTokens: 120,
      },
    };
    await store.finishCall('a', id, 'executor', finished);
    await store.finishCall('a', id, 'executor', finished);
    expect(store.budgetAmount('2026-10-04')).toBe(118);
    expect(await store.beginCall('a', id, 'executor', callFor(id))).toBeUndefined();
    await store.beginCall('a', id, 'executor', callFor(id, 2));
    expect(store.budgetAmount('2026-10-04')).toBe(1292);
  });
  it('keeps cancel in flight and unknown usage reserved until runtime expiry', async () => {
    const store = storeFor();
    const id = await running(store, 'a');
    const call = await store.beginCall('a', id, 'executor', callFor(id));
    await store.requestCancel('a', id);
    await expect(admit(store, 'a', 'cancel-race')).rejects.toThrow(AttemptCapacityError);
    await store.finishCall('a', id, 'executor', { ...call!, status: 'unknown' });
    await store.close('a', id, 'cancelled', 'cancelled', 'executor');
    await expect(admit(store, 'a', 'cancel-race')).rejects.toThrow(AttemptCapacityError);
    expect(store.budgetAmount('2026-10-04')).toBe(1174);
    await expect(
      store.admit({
        owner: 'a',
        requestKey: 'expired',
        expectedVersion: 1,
        draft,
        animationEnabled: false,
        now: '2026-10-04T15:38:00.000Z',
      }),
    ).resolves.toMatchObject({ admitted: true });
    expect(store.budgetAmount('2026-10-04')).toBe(1174);
  });
  it('releases cancelled capacity after a complete response while keeping its unknown cache cost reserved', async () => {
    const store = storeFor();
    const id = await running(store, 'a');
    const call = await store.beginCall('a', id, 'executor', callFor(id));
    await store.requestCancel('a', id);
    await store.finishCall('a', id, 'executor', {
      ...call!,
      status: 'received',
      responseSha256: 'response',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        gameTokens: 120,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    });
    await store.close('a', id, 'cancelled', 'cancelled', 'executor');
    expect(store.budgetAmount('2026-10-04')).toBe(1174);
    await expect(admit(store, 'a', 'next')).resolves.toMatchObject({ admitted: true });
  });
});

it.each(['cacheReadTokens', 'cacheWriteTokens'] as const)(
  'Memory keeps counted-input reservation when ordinary input is partial and %s is unknown',
  async (field) => {
    const store = storeFor();
    const id = await running(store, 'a');
    const call = await store.beginCall('a', id, 'executor', callFor(id));
    const finished: CallRecord = {
      ...call!,
      status: 'received',
      responseSha256: 'response',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        gameTokens: 30,
        reasoningTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        [field]: null,
      },
    };
    await store.finishCall('a', id, 'executor', finished);
    await store.finishCall('a', id, 'executor', finished);
    expect(store.budgetAmount('2026-10-04')).toBe(call!.budget!.reservedMicros);
    expect(store.budgetAmount('2026-10-04', 'a')).toBe(1174);
    expect((await store.getCalls('a', id))[0].budget?.settledMicros).toBeUndefined();
  },
);
