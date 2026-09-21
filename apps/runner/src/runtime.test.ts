import { describe, expect, it } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot';
import { MemoryAttemptStore, MemoryBodyStore } from '../../api/src/attempt-store';
import { createGameEngine } from './execute';
import { createRuntimeProcessor } from './runtime';
import type { AttemptStore } from '../../../shared/server/attempt';

describe('Runtime acknowledgement and task health', () => {
  it('acknowledges after tracking a background task and completes tracking in finally', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({
      draft: { version: 1, draft },
    });
    const admitted = await store.admit({
      owner: 'owner',
      requestKey: 'runtime',
      expectedVersion: 1,
      draft,
    });
    await store.requestCancel('owner', admitted.attempt.id);
    let active = 0;
    const processor = createRuntimeProcessor(
      {
        store,
        bodies: new MemoryBodyStore(),
        engine: createGameEngine(),
        infer: async () => {
          throw new Error('cancelled attempt must not infer');
        },
      },
      {
        addAsyncTask: () => {
          active += 1;
          return 1;
        },
        completeAsyncTask: () => {
          active -= 1;
          return true;
        },
      },
    );
    const response = await processor(
      { attemptId: admitted.attempt.id, owner: 'owner' },
      admitted.attempt.id,
    );
    expect(response).toEqual({ accepted: true, attemptId: admitted.attempt.id });
    expect(active).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(0);
    expect((await store.get('owner', admitted.attempt.id))?.status).toBe('cancelled');
  });

  it('uses a fresh executor claim for duplicate invocations in one session', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({
      draft: { version: 1, draft },
    });
    const admitted = await store.admit({
      owner: 'owner',
      requestKey: 'duplicate',
      expectedVersion: 1,
      draft,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const processor = createRuntimeProcessor(
      {
        store,
        bodies: new MemoryBodyStore(),
        engine: createGameEngine(),
        infer: async ({ audit }) => {
          calls += 1;
          await audit.beforeSend(new TextEncoder().encode('request'));
          await blocked;
          await audit.afterReceive({
            bytes: new TextEncoder().encode('{}'),
            statusCode: 200,
            requestId: 'id',
            complete: true,
          });
          return {
            action: { name: 'tool_1', input: {} },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              gameTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        },
      },
      { addAsyncTask: () => 1, completeAsyncTask: () => true },
    );
    await Promise.all([
      processor({ attemptId: admitted.attempt.id, owner: 'owner' }, 'same-session'),
      processor({ attemptId: admitted.attempt.id, owner: 'owner' }, 'same-session'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.getCalls('owner', admitted.attempt.id)).toHaveLength(1);
  });

  it('clears task tracking when claim setup rejects without an unhandled background promise', async () => {
    let active = 0;
    const rejectedStore = {
      claim: async () => {
        throw Object.assign(new Error('storage'), { code: 'storage_error' });
      },
    } as unknown as AttemptStore;
    const processor = createRuntimeProcessor(
      {
        store: rejectedStore,
        bodies: new MemoryBodyStore(),
        infer: async () => {
          throw new Error('must not infer');
        },
        engine: createGameEngine(),
      },
      {
        addAsyncTask: () => {
          active += 1;
          return 7;
        },
        completeAsyncTask: () => {
          active -= 1;
          return true;
        },
      },
    );
    await processor({ attemptId: 'attempt', owner: 'owner' }, 'session');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(0);
  });
});
