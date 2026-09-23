import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_KEY, modelByKey } from '../../../shared/models.js';
import { createDefaultDraft } from '../../../shared/robot';
import { MemoryAttemptStore, MemoryBodyStore } from '../../api/src/attempt-store';
import { executeAttempt, createGameEngine, type InferenceAdapter } from './execute';

describe('Runtime attempt coordinator', () => {
  it('persists request/response before each action and closes with the engine result', async () => {
    const draft = {
      ...createDefaultDraft(),
      skills: createDefaultDraft().skills.map((skill) =>
        skill.id === 'advance' || skill.id === 'jump' || skill.id === 'crouch'
          ? { ...skill, enabled: true }
          : skill,
      ),
    };
    const store = new MemoryAttemptStore({
      draft: { version: 1, updatedAt: '2026-09-21T15:00:00.000Z', draft },
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const bodies = new MemoryBodyStore();
    const admitted = await store.admit({
      owner: 'a',
      requestKey: 'run',
      expectedVersion: 1,
      draft,
    });
    const actions = [
      { name: 'tool_1', input: {} },
      { name: 'tool_3', input: { direction: 'derecha' } },
      { name: 'tool_1', input: {} },
      { name: 'tool_4', input: { direction: 'derecha' } },
      { name: 'tool_1', input: {} },
    ];
    let index = 0;
    const infer: InferenceAdapter = async ({ audit }) => {
      await audit.beforeSend(new TextEncoder().encode(`request-${index}`));
      await audit.afterReceive({
        bytes: new TextEncoder().encode(
          JSON.stringify({ usage: { inputTokens: 1, outputTokens: 1 } }),
        ),
        statusCode: 200,
        requestId: `r-${index}`,
        complete: true,
      });
      return {
        action: actions[index++],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          gameTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    };
    await executeAttempt(
      { owner: 'a', attemptId: admitted.attempt.id, executorId: 'executor' },
      {
        store,
        bodies,
        infer,
        engine: createGameEngine(),
        now: () => new Date('2026-09-21T15:00:00.000Z'),
      },
    );
    const record = await store.get('a', admitted.attempt.id);
    expect(record?.status).toBe('victory');
    expect(record?.turnsUsed).toBe(5);
    expect(record?.calls).toBe(5);
    expect(record?.gameTokens).toBe(10);
    expect(record?.score).toBe(949.99);
    expect(await store.getCalls('a', admitted.attempt.id)).toHaveLength(5);
    expect(await store.getCalls('a', admitted.attempt.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelKey: DEFAULT_MODEL_KEY,
          modelId: modelByKey(DEFAULT_MODEL_KEY)?.modelId,
          region: modelByKey(DEFAULT_MODEL_KEY)?.region,
          profileVersion: modelByKey(DEFAULT_MODEL_KEY)?.profileVersion,
        }),
      ]),
    );
    expect(
      await bodies.get(
        `attempt/${admitted.attempt.id}/decision/${admitted.attempt.id}-decision-1/call/1/request.json`,
      ),
    ).toBeTruthy();
    expect(record?.recordComplete).toBe(true);
  });

  it('does not infer after cancellation wins before call authorization', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({
      draft: { version: 1, draft },
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const admitted = await store.admit({
      owner: 'a',
      requestKey: 'cancel',
      expectedVersion: 1,
      draft,
    });
    await store.requestCancel('a', admitted.attempt.id);
    let invoked = false;
    const infer: InferenceAdapter = async () => {
      invoked = true;
      throw new Error('should not infer');
    };
    await executeAttempt(
      { owner: 'a', attemptId: admitted.attempt.id, executorId: 'executor' },
      { store, bodies: new MemoryBodyStore(), infer, engine: createGameEngine() },
    );
    expect(invoked).toBe(false);
    expect((await store.get('a', admitted.attempt.id))?.status).toBe('cancelled');
  });

  it('retries only throttling twice with separate call ordinals and fixed backoff', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({
      draft: { version: 1, draft },
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const bodies = new MemoryBodyStore();
    const admitted = await store.admit({
      owner: 'a',
      requestKey: 'throttle',
      expectedVersion: 1,
      draft,
    });
    let attempts = 0;
    const delays: number[] = [];
    const infer: InferenceAdapter = async ({ audit }) => {
      attempts += 1;
      await audit.beforeSend(new TextEncoder().encode(`request-${attempts}`));
      if (attempts < 3) {
        const error = Object.assign(new Error('throttled'), {
          code: 'throttled',
          usage: {
            normalized: {
              inputTokens: null,
              outputTokens: null,
              gameTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
            },
          },
        });
        throw error;
      }
      await audit.afterReceive({
        bytes: new TextEncoder().encode('{}'),
        statusCode: 200,
        requestId: 'ok',
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
    };
    const instantVictory = {
      observe: () => ({}),
      apply: ({ snapshot }: { snapshot: unknown }) => ({
        afterSnapshot: snapshot,
        beforeStateId: 'state-0',
        afterStateId: 'state-1',
        resolution: { outcome: 'moved', reason: 'moved' },
        normalizedAction: { kind: 'advance' },
        terminalStatus: 'victory' as const,
        progress: 1,
        finalSupport: 5,
        turnsUsed: 1,
      }),
    };
    await executeAttempt(
      { owner: 'a', attemptId: admitted.attempt.id, executorId: 'executor' },
      {
        store,
        bodies,
        infer,
        engine: instantVictory,
        now: () => new Date('2026-09-21T15:00:00.000Z'),
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );
    expect(attempts).toBe(3);
    expect(delays).toEqual([500, 1000]);
    expect((await store.getCalls('a', admitted.attempt.id)).map((call) => call.seq)).toEqual([
      1, 2, 3,
    ]);
    expect((await store.get('a', admitted.attempt.id))?.status).toBe('victory');
  });

  it('keeps provider usage when response validation fails after an audited body', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({
      draft: { version: 1, draft },
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const admitted = await store.admit({
      owner: 'a',
      requestKey: 'invalid',
      expectedVersion: 1,
      draft,
    });
    const infer: InferenceAdapter = async ({ audit }) => {
      await audit.beforeSend(new TextEncoder().encode('request'));
      await audit.afterReceive({
        bytes: new TextEncoder().encode('{}'),
        statusCode: 200,
        requestId: 'invalid',
        complete: true,
      });
      throw Object.assign(new Error('invalid'), {
        code: 'invalid_response',
        usage: {
          normalized: {
            inputTokens: 7,
            outputTokens: 3,
            gameTokens: 10,
            reasoningTokens: 2,
            cacheReadTokens: 1,
            cacheWriteTokens: 2,
          },
        },
      });
    };
    await executeAttempt(
      { owner: 'a', attemptId: admitted.attempt.id, executorId: 'executor' },
      {
        store,
        bodies: new MemoryBodyStore(),
        infer,
        engine: createGameEngine(),
        now: () => new Date('2026-09-21T15:00:00.000Z'),
      },
    );
    const record = await store.get('a', admitted.attempt.id);
    const [call] = await store.getCalls('a', admitted.attempt.id);
    expect(record?.status).toBe('error');
    expect(record?.inputTokens).toBe(7);
    expect(record?.outputTokens).toBe(3);
    expect(record?.reasoningTokens).toBe(2);
    expect(record?.gameTokens).toBe(10);
    expect(record?.recordComplete).toBe(true);
    expect(call.status).toBe('invalid');
    expect(call.usage.reasoningTokens).toBe(2);
    expect(call.usage.gameTokens).toBe(10);
  });
});
