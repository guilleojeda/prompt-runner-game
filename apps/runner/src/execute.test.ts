import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_KEY, modelByKey } from '../../../shared/models.js';
import { createDefaultDraft, ROBOT_CATALOG } from '../../../shared/robot';
import { MemoryAttemptStore, MemoryBodyStore } from '../../api/src/attempt-store';
import { executeAttempt, createGameEngine, type InferenceAdapter } from './execute';

describe('Runtime attempt coordinator', () => {
  it('persists request/response before each action and closes with the engine result', async () => {
    const base = createDefaultDraft();
    const humanDescriptions = {
      advance: 'Avanzá un apoyo.',
      retreat: 'Retrocedé hasta el apoyo anterior.',
      jump: 'Saltá en la dirección elegida.',
      crouch: 'Pasá agachado en la dirección elegida.',
      collect: 'Recogé el objeto que haya aquí.',
    };
    const draft = {
      ...base,
      skills: base.skills.map((skill) => ({
        ...skill,
        enabled: Object.hasOwn(humanDescriptions, skill.id),
        description:
          humanDescriptions[skill.id as keyof typeof humanDescriptions] ?? skill.description,
      })),
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
      animationEnabled: false,
    });
    const actions = [
      { name: 'tool_1', input: {} },
      { name: 'tool_3', input: { direction: 'derecha' } },
      { name: 'tool_7', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_4', input: { direction: 'derecha' } },
      { name: 'tool_4', input: { direction: 'derecha' } },
      { name: 'tool_3', input: { direction: 'derecha' } },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_2', input: {} },
      { name: 'tool_2', input: {} },
      { name: 'tool_7', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
    ];
    let index = 0;
    const observations: unknown[] = [];
    const effectiveTools: unknown[] = [];
    const infer: InferenceAdapter = async ({ audit, observation, tools }) => {
      observations.push(observation);
      effectiveTools.push(tools);
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
    const replay = await store.getReplayRecord('a', admitted.attempt.id);
    expect(record?.status).toBe('victory');
    expect(record?.reason).toBe('exit_reached');
    expect(record?.turnsUsed).toBe(17);
    expect(record?.calls).toBe(17);
    expect(record?.gameTokens).toBe(34);
    expect(record?.score).toBe(854.97);
    expect(record?.collectedObjectIds).toEqual(['recompensa-1', 'llave-1']);
    expect(replay?.actions[2]).toMatchObject({
      action: { kind: 'collect' },
      resolution: { outcome: 'picked_up', objectId: 'recompensa-1' },
      before: {
        support: 2,
        remainingObjects: ['recompensa-1', 'llave-1'],
        inventory: [],
      },
      after: {
        support: 2,
        remainingObjects: ['llave-1'],
        inventory: ['recompensa-1'],
      },
    });
    expect(replay?.actions[9]).toMatchObject({
      resolution: { outcome: 'no_op', reason: 'door_locked' },
      before: { support: 8 },
      after: { support: 8, status: 'running' },
    });
    expect(replay?.actions[12]).toMatchObject({
      resolution: { outcome: 'picked_up', objectId: 'llave-1' },
      before: { support: 6 },
      after: { support: 6, inventory: ['recompensa-1', 'llave-1'] },
    });
    expect(replay?.actions[15]).toMatchObject({
      before: { support: 8, inventory: ['recompensa-1', 'llave-1'] },
      after: { support: 9, status: 'running' },
    });
    expect(replay?.actions[16]).toMatchObject({
      before: { support: 9 },
      after: { support: 10, status: 'victory' },
    });
    expect(observations[9]).toMatchObject({
      facing: 'right',
      here: { objects: [] },
      right: { kind: 'door', state: 'locked', requiredObjectId: 'llave-1' },
    });
    expect(observations[12]).toMatchObject({
      facing: 'left',
      here: { objects: ['llave-1'] },
    });
    expect(observations[15]).toMatchObject({
      right: { kind: 'door', state: 'open', requiredObjectId: 'llave-1' },
    });
    const lockedObservation = {
      facing: 'right',
      here: { objects: [] },
      left: { kind: 'segment', terrain: 'ground' },
      right: { kind: 'door', state: 'locked', requiredObjectId: 'llave-1' },
    };
    const openObservation = {
      ...lockedObservation,
      right: { kind: 'door', state: 'open', requiredObjectId: 'llave-1' },
    };
    expect(observations[9]).toEqual(lockedObservation);
    expect(observations[10]).toEqual(lockedObservation);
    expect(observations[15]).toEqual(openObservation);
    const literalTools = draft.skills
      .filter((skill) => skill.enabled)
      .map((skill) => {
        const entry = ROBOT_CATALOG.find((candidate) => candidate.id === skill.id)!;
        return {
          name: entry.opaqueId,
          description: skill.description,
          inputSchema: entry.inputSchema,
        };
      });
    expect(effectiveTools[9]).toEqual(literalTools);
    expect(effectiveTools[10]).toEqual(literalTools);
    expect(await store.getCalls('a', admitted.attempt.id)).toHaveLength(17);
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

  it('executes one tool_6 wait, advances the periodic phase, and stops at the terminal action', async () => {
    const base = createDefaultDraft();
    const draft = {
      ...base,
      skills: base.skills.map((skill) => ({
        ...skill,
        enabled: skill.id === 'advance' || skill.id === 'wait',
      })),
    };
    const store = new MemoryAttemptStore({
      draft: { version: 1, draft },
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const bodies = new MemoryBodyStore();
    const admitted = await store.admit({
      owner: 'a',
      requestKey: 'wait-decision',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    const selectedActions = [
      { name: 'tool_6', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
    ] as const;
    const observations: unknown[] = [];
    let calls = 0;
    const infer: InferenceAdapter = async ({ audit, observation, tools }) => {
      const action = selectedActions[calls];
      if (!action) throw new Error('inference ran after the game was already terminal');
      observations.push(observation);
      if (calls === 0) {
        expect(tools).toContainEqual({
          name: 'tool_6',
          description: expect.any(String),
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        });
      }
      await audit.beforeSend(new TextEncoder().encode(`request-${calls}`));
      await audit.afterReceive({
        bytes: new TextEncoder().encode('{"usage":{"inputTokens":1,"outputTokens":1}}'),
        statusCode: 200,
        requestId: `request-${calls}`,
        complete: true,
      });
      calls += 1;
      return {
        action,
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
    const replay = await store.getReplayRecord('a', admitted.attempt.id);
    const callRecords = await store.getCalls('a', admitted.attempt.id);
    expect(calls).toBe(3);
    expect(record).toMatchObject({ status: 'defeat', reason: 'walk_into_pit', turnsUsed: 3 });
    expect(record?.sequence).toBe(3);
    expect(record?.calls).toBe(3);
    expect(callRecords.map((call) => call.seq)).toEqual([1, 2, 3]);
    expect(replay?.actions).toHaveLength(3);
    expect(replay?.actions[0]).toMatchObject({
      action: { kind: 'wait' },
      resolution: { outcome: 'no_op', reason: 'wait' },
      before: { phaseTurn: 0 },
      after: { phaseTurn: 1, terrain: expect.arrayContaining(['barrier_high', 'pit']) },
    });
    expect(replay?.actions[2]).toMatchObject({
      resolution: { outcome: 'fall', reason: 'walk_into_pit' },
      after: { status: 'defeat', phaseTurn: 2 },
    });
    expect(observations).toHaveLength(3);
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
      animationEnabled: false,
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

  it('recovers after two throttles without publishing extra turns', async () => {
    const base = createDefaultDraft();
    const draft = {
      ...base,
      skills: base.skills.map((skill) => ({
        ...skill,
        enabled: ['advance', 'retreat', 'jump', 'crouch', 'collect'].includes(skill.id),
      })),
    };
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
      animationEnabled: false,
    });
    let attempts = 0;
    let routeIndex = 0;
    const actions = [
      { name: 'tool_1', input: {} },
      { name: 'tool_3', input: { direction: 'derecha' } },
      { name: 'tool_7', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_4', input: { direction: 'derecha' } },
      { name: 'tool_4', input: { direction: 'derecha' } },
      { name: 'tool_3', input: { direction: 'derecha' } },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_2', input: {} },
      { name: 'tool_2', input: {} },
      { name: 'tool_7', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
      { name: 'tool_1', input: {} },
    ] as const;
    const delays: number[] = [];
    const infer: InferenceAdapter = async ({ audit }) => {
      attempts += 1;
      await audit.beforeSend(new TextEncoder().encode(`request-${attempts}`));
      if (attempts < 3) {
        await audit.afterReceive({
          bytes: new TextEncoder().encode('{"error":"throttled"}'),
          statusCode: 429,
          requestId: `throttled-${attempts}`,
          complete: true,
        });
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
        action: actions[routeIndex++]!,
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
        sleep: async (milliseconds) => {
          if (milliseconds > 0) delays.push(milliseconds);
        },
      },
    );
    const record = await store.get('a', admitted.attempt.id);
    const calls = await store.getCalls('a', admitted.attempt.id);
    const replay = await store.getReplayRecord('a', admitted.attempt.id);
    expect(attempts).toBe(19);
    expect(delays).toHaveLength(24);
    expect(delays.every((milliseconds) => milliseconds === 5_000)).toBe(true);
    expect(delays.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(120_000);
    expect(calls.map((call) => call.seq)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    expect(new Set(calls.slice(0, 3).map((call) => call.decisionId)).size).toBe(1);
    expect(record).toMatchObject({ status: 'victory', turnsUsed: 17, sequence: 17, calls: 19 });
    expect(replay?.actions).toHaveLength(17);
  });

  it('closes as throttled after two delayed retries for the same decision', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({
      draft: { version: 1, draft },
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const admitted = await store.admit({
      owner: 'a',
      requestKey: 'throttle-exhausted',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    let attempts = 0;
    const waits: number[] = [];
    const infer: InferenceAdapter = async ({ audit }) => {
      attempts += 1;
      await audit.beforeSend(new TextEncoder().encode(`request-${attempts}`));
      await audit.afterReceive({
        bytes: new TextEncoder().encode('{"error":"throttled"}'),
        statusCode: 429,
        requestId: `throttled-${attempts}`,
        complete: true,
      });
      throw Object.assign(new Error('throttled'), {
        code: 'throttled',
        usage: { normalized: { inputTokens: null, outputTokens: null, gameTokens: null } },
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
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
    );

    const record = await store.get('a', admitted.attempt.id);
    const calls = await store.getCalls('a', admitted.attempt.id);
    const replay = await store.getReplayRecord('a', admitted.attempt.id);
    expect(attempts).toBe(3);
    expect(waits).toHaveLength(24);
    expect(waits.every((milliseconds) => milliseconds === 5_000)).toBe(true);
    expect(waits.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(120_000);
    expect(calls.map((call) => call.seq)).toEqual([1, 2, 3]);
    expect(new Set(calls.map((call) => call.decisionId)).size).toBe(1);
    expect(record).toMatchObject({
      status: 'error',
      reason: 'throttled',
      turnsUsed: 0,
      sequence: 0,
      calls: 3,
    });
    expect(replay).toMatchObject({
      actions: [],
      snapshots: [{ id: 'state-0', support: 0, turnsUsed: 0 }],
      closure: { status: 'error', actionCount: 0, finalStateId: 'state-0' },
    });
  });

  it('closes a throttled attempt without retrying when cancellation arrives during backoff', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({
      draft: { version: 1, draft },
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const admitted = await store.admit({
      owner: 'a',
      requestKey: 'throttle-cancel',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
    });
    let attempts = 0;
    const waits: number[] = [];
    const infer: InferenceAdapter = async ({ audit }) => {
      attempts += 1;
      await audit.beforeSend(new TextEncoder().encode(`request-${attempts}`));
      throw Object.assign(new Error('throttled'), {
        code: 'throttled',
        usage: { normalized: { inputTokens: null, outputTokens: null, gameTokens: null } },
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
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
          await store.requestCancel('a', admitted.attempt.id);
        },
      },
    );

    expect(waits).toEqual([5_000]);
    expect(attempts).toBe(1);
    expect(await store.get('a', admitted.attempt.id)).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled_during_retry',
      turnsUsed: 0,
      sequence: 0,
      calls: 1,
    });
  });

  it('stops throttle retries before the next backoff would consume the Runtime deadline reserve', async () => {
    const draft = createDefaultDraft();
    let nowMs = new Date('2026-09-21T15:00:00.000Z').getTime();
    const now = () => new Date(nowMs);
    const store = new MemoryAttemptStore({ draft: { version: 1, draft }, now });
    const admitted = await store.admit({
      owner: 'a',
      requestKey: 'throttle-deadline',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
      config: { runtimeLifetimeMs: 155_000 },
    });
    let attempts = 0;
    const waits: number[] = [];
    const infer: InferenceAdapter = async ({ audit }) => {
      attempts += 1;
      await audit.beforeSend(new TextEncoder().encode(`request-${attempts}`));
      throw Object.assign(new Error('throttled'), {
        code: 'throttled',
        usage: { normalized: { inputTokens: null, outputTokens: null, gameTokens: null } },
      });
    };

    await executeAttempt(
      { owner: 'a', attemptId: admitted.attempt.id, executorId: 'executor' },
      {
        store,
        bodies: new MemoryBodyStore(),
        infer,
        engine: createGameEngine(),
        now,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
          nowMs += milliseconds;
        },
      },
    );

    expect(attempts).toBe(2);
    expect(waits).toHaveLength(12);
    expect(waits.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(60_000);
    expect(await store.get('a', admitted.attempt.id)).toMatchObject({
      status: 'error',
      reason: 'runtime_deadline_exceeded',
      turnsUsed: 0,
      sequence: 0,
      calls: 2,
    });
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
      animationEnabled: false,
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
    const initialSnapshot = await store.getSnapshot('a', admitted.attempt.id);
    const replay = await store.getReplayRecord('a', admitted.attempt.id);
    expect(record?.status).toBe('error');
    expect(initialSnapshot).toMatchObject({
      id: 'state-0',
      status: 'running',
      support: 0,
      turnsUsed: 0,
    });
    expect(record).toMatchObject({ turnsUsed: 0, sequence: 0 });
    expect(record?.currentSnapshot).toEqual(initialSnapshot);
    expect(record?.initialSnapshot).toEqual(initialSnapshot);
    expect(replay).toMatchObject({
      actions: [],
      snapshots: [{ id: 'state-0', support: 0, turnsUsed: 0 }],
      closure: { status: 'error', actionCount: 0, finalStateId: 'state-0' },
    });
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
