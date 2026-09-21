import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import {
  createInitialState,
  LEVEL,
  resolveAction,
  type GameSnapshot,
} from '../../../shared/game.js';
import {
  DEFAULT_ATTEMPT_CONFIG,
  type ActionPublication,
  type BodyStore,
  type CallRecord,
} from '../../../shared/server/attempt.js';
import { createDefaultDraft } from '../../../shared/robot.js';
import { AttemptStoreError, createDynamoAttemptStore } from './attempt-store.js';

const commandClient = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as DynamoDBClient;

type CommandLike = {
  readonly input: Record<string, unknown>;
  readonly constructor: { readonly name: string };
};

type HarnessBehavior = undefined | 'throw' | 'applyThenThrow';

const conditionalError = (): ConditionalCheckFailedException =>
  new ConditionalCheckFailedException({ message: 'conditional', $metadata: {} });

const transactionError = (): TransactionCanceledException =>
  new TransactionCanceledException({ message: 'ambiguous', $metadata: {} });

const keyFromInput = (input: Record<string, unknown>): { PK: string; SK: string } => {
  const key = unmarshall(input.Key as Record<string, AttributeValue>) as {
    PK?: unknown;
    SK?: unknown;
  };
  if (typeof key.PK !== 'string' || typeof key.SK !== 'string')
    throw new Error('Invalid test key.');
  return { PK: key.PK, SK: key.SK };
};

const itemKey = (pk: string, sk: string): string => `${pk}\u0000${sk}`;

/** Command-level DynamoDB double; production code still uses DynamoAttemptStore. */
class DynamoHarness {
  public readonly items = new Map<string, Record<string, AttributeValue>>();
  public readonly send = vi.fn((command: CommandLike) => this.handle(command));
  public updateBehavior: (input: Record<string, unknown>) => HarnessBehavior = () => undefined;
  public transactionBehavior: (input: Record<string, unknown>) => HarnessBehavior = () => undefined;

  public put(value: Record<string, unknown>): void {
    const { PK, SK } = value as { PK: string; SK: string };
    this.items.set(itemKey(PK, SK), marshall(value, { removeUndefinedValues: true }));
  }

  public read(pk: string, sk: string): Record<string, unknown> | undefined {
    const item = this.items.get(itemKey(pk, sk));
    return item ? unmarshall(item) : undefined;
  }

  public applyUpdate(input: Record<string, unknown>): void {
    const { PK, SK } = keyFromInput(input);
    const existing = this.read(PK, SK) ?? { PK, SK };
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
    const values = input.ExpressionAttributeValues
      ? unmarshall(input.ExpressionAttributeValues as Record<string, AttributeValue>)
      : {};
    const expression = String(input.UpdateExpression ?? '');
    for (const match of expression.matchAll(/(#\w+)\s*=\s*(:\w+)/g)) {
      const field = names[match[1]];
      const value = Object.prototype.hasOwnProperty.call(values, match[2])
        ? values[match[2]]
        : values[match[2].slice(1)];
      if (field && value !== undefined) existing[field] = value;
    }
    this.put(existing);
  }

  private applyTransaction(input: Record<string, unknown>): void {
    const transactItems = input.TransactItems as readonly Record<string, unknown>[];
    for (const transaction of transactItems) {
      if (transaction.Put) {
        const put = transaction.Put as { Item: Record<string, AttributeValue> };
        this.put(unmarshall(put.Item));
      } else if (transaction.Update) {
        this.applyUpdate(transaction.Update as Record<string, unknown>);
      }
    }
  }

  private async handle(command: CommandLike): Promise<Record<string, unknown>> {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'GetItemCommand') {
      const { PK, SK } = keyFromInput(input);
      const Item = this.items.get(itemKey(PK, SK));
      return Item ? { Item: structuredClone(Item) } : {};
    }
    if (name === 'QueryCommand') {
      const values = unmarshall(input.ExpressionAttributeValues as Record<string, AttributeValue>);
      const pk = String(values[':pk']);
      const prefix = String(values[':prefix']);
      const Items = [...this.items.entries()]
        .filter(
          ([key]) => key.startsWith(`${pk}\u0000`) && key.split('\u0000')[1].startsWith(prefix),
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => structuredClone(value));
      return { Items };
    }
    if (name === 'UpdateItemCommand') {
      const behavior = this.updateBehavior(input);
      if (behavior === 'applyThenThrow') {
        this.applyUpdate(input);
        throw conditionalError();
      }
      if (behavior === 'throw') throw conditionalError();
      this.applyUpdate(input);
      return {};
    }
    if (name === 'TransactWriteItemsCommand') {
      const behavior = this.transactionBehavior(input);
      if (behavior === 'applyThenThrow') {
        this.applyTransaction(input);
        throw transactionError();
      }
      if (behavior === 'throw') throw transactionError();
      this.applyTransaction(input);
      return {};
    }
    throw new Error(`Unhandled Dynamo command ${name}.`);
  }
}

const seedAttempt = (
  harness: DynamoHarness,
  overrides: Record<string, unknown> = {},
): { readonly initial: GameSnapshot; readonly attemptId: string } => {
  const initial = createInitialState(LEVEL);
  const attemptId = 'attempt-1';
  harness.put({
    PK: 'USER#owner',
    SK: `ATTEMPT#${attemptId}`,
    id: attemptId,
    createdAt: '2026-09-21T15:00:00.000Z',
    updatedAt: '2026-09-21T15:00:00.000Z',
    status: 'pending',
    cancelRequested: false,
    levelId: DEFAULT_ATTEMPT_CONFIG.levelId,
    turnsUsed: 0,
    maxTurns: DEFAULT_ATTEMPT_CONFIG.maxTurns,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    gameTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    score: null,
    progress: 0,
    finalSupport: 0,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
    owner: 'owner',
    requestKey: 'request',
    draft: createDefaultDraft(),
    instructions: '',
    skills: [],
    config: DEFAULT_ATTEMPT_CONFIG,
    sequence: 0,
    nextCall: 1,
    initialStateId: initial.id,
    currentStateId: initial.id,
    startDeadline: '2026-09-21T16:00:00.000Z',
    sessionId: `attempt-${attemptId}`,
    ...overrides,
  });
  harness.put({
    PK: `ATTEMPT#${attemptId}`,
    SK: `STATE#${initial.id}`,
    entity: 'snapshot',
    stateId: initial.id,
    snapshot: initial,
  });
  return { initial, attemptId };
};

const seedCall = (
  harness: DynamoHarness,
  attemptId: string,
  overrides: Partial<CallRecord> = {},
): CallRecord => {
  const call: CallRecord = {
    attemptId,
    seq: 1,
    decisionId: 'decision-1',
    requestKey: `attempt/${attemptId}/decision/decision-1/call/1/request.json`,
    responseKey: `attempt/${attemptId}/decision/decision-1/call/1/response.json`,
    requestSha256: 'a'.repeat(64),
    requestBytes: 10,
    status: 'started',
    usage: {
      inputTokens: null,
      outputTokens: null,
      gameTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    },
    createdAt: '2026-09-21T15:00:00.000Z',
    updatedAt: '2026-09-21T15:00:00.000Z',
    ...overrides,
  };
  harness.put({
    PK: `ATTEMPT#${attemptId}`,
    SK: 'CALL#00000001',
    entity: 'call',
    ...call,
  });
  return call;
};

const storeFor = (harness: DynamoHarness, bodyStore?: BodyStore) =>
  createDynamoAttemptStore({
    client: commandClient(harness.send),
    tableName: 'Attempts',
    bodyStore,
    now: () => new Date('2026-09-21T15:00:00.000Z'),
  });

describe('Dynamo attempt admission conditions', () => {
  it('checks request identity before draft/version/quota and writes all admission records atomically', async () => {
    const draft = createDefaultDraft();
    const send = vi.fn().mockImplementation(async (command: { input: Record<string, unknown> }) => {
      const input = command.input;
      const sk = (input.Key as { SK?: { S?: string } } | undefined)?.SK?.S;
      if (sk === 'REQUEST#request') return {};
      if (sk === 'DRAFT')
        return { Item: marshall({ PK: 'USER#owner', SK: 'DRAFT', version: 1, draft }) };
      return {};
    });
    const store = createDynamoAttemptStore({
      client: commandClient(send),
      tableName: 'Attempts',
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    const result = await store.admit({
      owner: 'owner',
      requestKey: 'request',
      expectedVersion: 1,
      draft,
    });
    expect(result.admitted).toBe(true);
    const transaction = send.mock.calls.find(([command]) => command.input.TransactItems)?.[0].input;
    expect(transaction.TransactItems).toHaveLength(5);
    expect(transaction.TransactItems[0].ConditionCheck.ConditionExpression).toContain(
      '#draft = :draft',
    );
    expect(transaction.TransactItems[1].Put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(transaction.TransactItems[4].Update.ConditionExpression).toContain('#used < :limit');
  });

  it('resolves a transaction cancellation by rereading idempotency, draft and quota without re-admitting', async () => {
    const draft = createDefaultDraft();
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: marshall({ PK: 'USER#owner', SK: 'DRAFT', version: 1, draft }),
      })
      .mockRejectedValueOnce(
        new TransactionCanceledException({ message: 'ambiguous', $metadata: {} }),
      )
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: marshall({ PK: 'USER#owner', SK: 'DRAFT', version: 1, draft }),
      })
      .mockResolvedValueOnce({ Item: marshall({ used: 3, limit: 100 }) });
    const store = createDynamoAttemptStore({
      client: commandClient(send),
      tableName: 'Attempts',
      now: () => new Date('2026-09-21T15:00:00.000Z'),
    });
    await expect(
      store.admit({ owner: 'owner', requestKey: 'request', expectedVersion: 1, draft }),
    ).rejects.toBeInstanceOf(AttemptStoreError);
    expect(send).toHaveBeenCalledTimes(6);
    expect(send.mock.calls.filter(([command]) => command.input.TransactItems)).toHaveLength(1);
  });
});

describe('Dynamo attempt claim and cancellation races', () => {
  it('recovers a committed claim after lost acknowledgement and preserves both deadlines', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness);
    let firstClaim = true;
    harness.updateBehavior = (input) => {
      if (firstClaim && String(input.UpdateExpression).includes('#executionDeadline')) {
        firstClaim = false;
        return 'applyThenThrow';
      }
      return undefined;
    };
    const store = storeFor(harness);
    const claimed = await store.claim('owner', attemptId, 'executor-a', '2026-09-21T15:00:00.000Z');

    expect(claimed?.status).toBe('running');
    expect(claimed?.executorId).toBe('executor-a');
    expect(claimed?.executionDeadline).toBe('2026-09-21T15:30:00.000Z');
    expect(claimed?.runtimeDeadline).toBe('2026-09-21T15:32:00.000Z');
    expect(
      harness.send.mock.calls.filter(([command]) => command.input.UpdateExpression).length,
    ).toBe(1);
  });

  it('does not let a different executor adopt a claim after a conditional failure', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness);
    harness.updateBehavior = () => 'throw';

    const claimed = await storeFor(harness).claim(
      'owner',
      attemptId,
      'executor-b',
      '2026-09-21T15:00:00.000Z',
    );

    expect(claimed).toBeUndefined();
    expect(harness.read('USER#owner', `ATTEMPT#${attemptId}`)?.status).toBe('pending');
  });

  it('retries a pending cancellation after claim wins the conditional race', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness);
    let firstCancel = true;
    harness.updateBehavior = (input) => {
      if (firstCancel && String(input.UpdateExpression).includes(':cancelled')) {
        firstCancel = false;
        const current = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
        harness.put({
          ...current,
          status: 'running',
          executorId: 'executor-a',
          executionDeadline: '2026-09-21T15:30:00.000Z',
          runtimeDeadline: '2026-09-21T15:32:00.000Z',
        });
        return 'throw';
      }
      return undefined;
    };

    const cancelled = await storeFor(harness).requestCancel(
      'owner',
      attemptId,
      '2026-09-21T15:00:01.000Z',
    );

    expect(cancelled?.status).toBe('running');
    expect(cancelled?.cancelRequested).toBe(true);
    const updates = harness.send.mock.calls.filter(([command]) => command.input.UpdateExpression);
    expect(updates).toHaveLength(2);
    expect(String(updates[0][0].input.ConditionExpression)).toContain(':pending');
    expect(String(updates[1][0].input.ConditionExpression)).toContain(':running');
  });
});

describe('Dynamo action publication ambiguity', () => {
  const publicationFor = (initial: GameSnapshot): ActionPublication => {
    const resolved = resolveAction(initial, { kind: 'advance' }, LEVEL);
    return {
      seq: 1,
      decisionId: 'decision-1',
      action: resolved.action,
      resolution: resolved.resolution,
      beforeStateId: resolved.before.id,
      afterStateId: resolved.after.id,
      beforeSnapshot: resolved.before,
      afterSnapshot: resolved.after,
      progress: resolved.after.maxSupportReached / LEVEL.segments.length,
      finalSupport: resolved.after.support,
      turnsUsed: resolved.after.turnsUsed,
    };
  };

  it('returns an exactly committed action after an ambiguous transaction', async () => {
    const harness = new DynamoHarness();
    const { attemptId, initial } = seedAttempt(harness, {
      status: 'running',
      executorId: 'executor-a',
    });
    const publication = publicationFor(initial);
    let firstTransaction = true;
    harness.transactionBehavior = () => {
      if (firstTransaction) {
        firstTransaction = false;
        return 'applyThenThrow';
      }
      return undefined;
    };

    const result = await storeFor(harness).publishAction(
      'owner',
      attemptId,
      'executor-a',
      publication,
    );

    expect(result?.sequence).toBe(1);
    expect((result?.currentSnapshot as GameSnapshot).id).toBe(publication.afterStateId);
    const transaction = harness.send.mock.calls.find(
      ([command]) => command.constructor.name === 'TransactWriteItemsCommand',
    )?.[0].input as { TransactItems: readonly Record<string, unknown>[] };
    const headerUpdate = transaction.TransactItems.find((item) => item.Update)?.Update as {
      ConditionExpression: string;
    };
    expect(headerUpdate.ConditionExpression).toContain('#currentStateId = :beforeState');
    expect(headerUpdate.ConditionExpression).toContain('#sequence = :previous');
  });

  it('rejects a retry whose action or posterior snapshot differs from the committed payload', async () => {
    const harness = new DynamoHarness();
    const { attemptId, initial } = seedAttempt(harness, {
      status: 'running',
      executorId: 'executor-a',
    });
    const publication = publicationFor(initial);
    harness.transactionBehavior = () => 'applyThenThrow';
    const store = storeFor(harness);
    await store.publishAction('owner', attemptId, 'executor-a', publication);

    const alteredAction = await store.publishAction('owner', attemptId, 'executor-a', {
      ...publication,
      action: { kind: 'retreat' },
    });
    const alteredState = await store.publishAction('owner', attemptId, 'executor-a', {
      ...publication,
      afterSnapshot: { ...(publication.afterSnapshot as GameSnapshot), support: 4 },
    });

    expect(alteredAction).toBeUndefined();
    expect(alteredState).toBeUndefined();
  });
});

describe('Dynamo call finalization and recovery', () => {
  it('requires immutable call identity and permits only legal status transitions', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, {
      status: 'running',
      executorId: 'executor-a',
    });
    const started = seedCall(harness, attemptId);
    const received: CallRecord = {
      ...started,
      status: 'received',
      responseSha256: 'b'.repeat(64),
      responseBytes: 20,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        gameTokens: 15,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
      updatedAt: '2026-09-21T15:00:02.000Z',
    };
    const store = storeFor(harness);
    const first = await store.finishCall('owner', attemptId, 'executor-a', received);
    expect(first?.status).toBe('received');
    expect(first?.requestKey).toBe(started.requestKey);

    const transaction = harness.send.mock.calls.find(
      ([command]) => command.constructor.name === 'TransactWriteItemsCommand',
    )?.[0].input as { TransactItems: readonly Record<string, unknown>[] };
    const callUpdate = transaction.TransactItems[0].Update as { ConditionExpression: string };
    expect(callUpdate.ConditionExpression).toContain('#attemptId = :attemptId');
    expect(callUpdate.ConditionExpression).toContain('#seq = :seq');
    expect(callUpdate.ConditionExpression).toContain('#requestKey = :requestKey');
    expect(callUpdate.ConditionExpression).toContain('#responseKey = :responseKey');
    expect(callUpdate.ConditionExpression).toContain('#status = :started');

    const invalid: CallRecord = {
      ...received,
      status: 'invalid',
      errorCode: 'invalid_response',
      updatedAt: '2026-09-21T15:00:03.000Z',
    };
    expect((await store.finishCall('owner', attemptId, 'executor-a', invalid))?.status).toBe(
      'invalid',
    );

    harness.transactionBehavior = () => 'throw';
    const forbiddenReceived = {
      ...invalid,
      status: 'received' as const,
      requestKey: 'attempt/other/request.json',
      updatedAt: '2026-09-21T15:00:04.000Z',
    };
    const result = await store.finishCall('owner', attemptId, 'executor-a', forbiddenReceived);
    expect(result?.status).toBe('invalid');
    const lastTransaction = harness.send.mock.calls
      .filter(([command]) => command.constructor.name === 'TransactWriteItemsCommand')
      .at(-1)?.[0].input as { TransactItems: readonly Record<string, unknown>[] };
    expect(
      (lastTransaction.TransactItems[0].Update as { ConditionExpression: string })
        .ConditionExpression,
    ).toContain('#requestKey = :requestKey');
  });

  it('keeps an audited received call when a delayed same-status write has null usage', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, {
      status: 'running',
      executorId: 'executor-a',
    });
    const known = seedCall(harness, attemptId, {
      status: 'received',
      responseSha256: 'b'.repeat(64),
      responseBytes: 20,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        gameTokens: 15,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
      },
    });
    harness.transactionBehavior = () => 'throw';
    const delayed: CallRecord = {
      ...known,
      usage: {
        inputTokens: null,
        outputTokens: null,
        gameTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
      updatedAt: '2026-09-21T15:00:04.000Z',
    };

    const result = await storeFor(harness).finishCall('owner', attemptId, 'executor-a', delayed);

    expect(result?.status).toBe('received');
    expect(result?.usage).toEqual(known.usage);
    expect(harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')?.usage).toEqual(known.usage);
  });

  it('leaves an active header untouched while a started call is still being audited', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'running', executorId: 'executor-a' });
    seedCall(harness, attemptId);
    const bodyStore: BodyStore = { put: vi.fn(), get: vi.fn(async () => undefined) };

    await storeFor(harness, bodyStore).recoverBodies('owner', attemptId);

    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    expect(header.calls).toBe(0);
    expect(header.recordComplete).toBe(true);
    expect(harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')?.status).toBe('started');
  });

  it('counts an unresolved started call after terminal recovery and keeps all metrics unknown', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'error', executorId: 'executor-a' });
    seedCall(harness, attemptId);
    const bodyStore: BodyStore = { put: vi.fn(), get: vi.fn(async () => undefined) };

    await storeFor(harness, bodyStore).recoverBodies('owner', attemptId);

    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    expect(header.calls).toBe(1);
    expect(header.inputTokens).toBeNull();
    expect(header.outputTokens).toBeNull();
    expect(header.gameTokens).toBeNull();
    expect(header.recordComplete).toBe(false);
  });

  it('marks a complete response with unknown usage as received without inventing metrics', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'error', executorId: 'executor-a' });
    const call = seedCall(harness, attemptId);
    const bodyStore: BodyStore = {
      put: vi.fn(),
      get: vi.fn(async (key) =>
        key === call.responseKey ? new TextEncoder().encode('{"ok":true}') : undefined,
      ),
    };

    await storeFor(harness, bodyStore).recoverBodies('owner', attemptId);

    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    const recovered = harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')!;
    expect(recovered.status).toBe('received');
    expect(recovered.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(header.calls).toBe(1);
    expect(header.inputTokens).toBeNull();
    expect(header.outputTokens).toBeNull();
    expect(header.gameTokens).toBeNull();
    expect(header.recordComplete).toBe(true);
  });

  it('aggregates known main usage and keeps partially reported cache categories unknown', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'error', executorId: 'executor-a' });
    const first = seedCall(harness, attemptId);
    const second: CallRecord = {
      ...first,
      seq: 2,
      decisionId: 'decision-2',
      requestKey: `attempt/${attemptId}/decision/decision-2/call/2/request.json`,
      responseKey: `attempt/${attemptId}/decision/decision-2/call/2/response.json`,
    };
    harness.put({ PK: `ATTEMPT#${attemptId}`, SK: 'CALL#00000002', entity: 'call', ...second });
    const bodies = new Map<string, Uint8Array>([
      [
        first.responseKey,
        new TextEncoder().encode(
          '{"usage":{"inputTokens":10,"outputTokens":5,"cacheReadInputTokens":3}}',
        ),
      ],
      [
        second.responseKey,
        new TextEncoder().encode(
          '{"usage":{"inputTokens":20,"outputTokens":7,"cacheWriteInputTokens":4}}',
        ),
      ],
    ]);
    const bodyStore: BodyStore = { put: vi.fn(), get: vi.fn(async (key) => bodies.get(key)) };

    await storeFor(harness, bodyStore).recoverBodies('owner', attemptId);

    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    expect(header.calls).toBe(2);
    expect(header.inputTokens).toBe(37);
    expect(header.outputTokens).toBe(12);
    expect(header.gameTokens).toBe(49);
    expect(header.cacheReadTokens).toBeNull();
    expect(header.cacheWriteTokens).toBeNull();
    expect(header.recordComplete).toBe(true);
  });

  it('keeps every aggregate metric unknown when a terminal record has an orphan started call', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'error', executorId: 'executor-a' });
    const known = seedCall(harness, attemptId, {
      status: 'received',
      responseSha256: 'b'.repeat(64),
      responseBytes: 20,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        gameTokens: 15,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    });
    harness.put({
      PK: `ATTEMPT#${attemptId}`,
      SK: 'CALL#00000002',
      entity: 'call',
      ...known,
      seq: 2,
      decisionId: 'decision-2',
      requestKey: `attempt/${attemptId}/decision/decision-2/call/2/request.json`,
      responseKey: `attempt/${attemptId}/decision/decision-2/call/2/response.json`,
      status: 'started',
      responseSha256: undefined,
      responseBytes: undefined,
      usage: {
        inputTokens: null,
        outputTokens: null,
        gameTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    });
    const bodyStore: BodyStore = { put: vi.fn(), get: vi.fn(async () => undefined) };

    await storeFor(harness, bodyStore).recoverBodies('owner', attemptId);

    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    expect(header.calls).toBe(2);
    expect(header.inputTokens).toBeNull();
    expect(header.outputTokens).toBeNull();
    expect(header.gameTokens).toBeNull();
    expect(header.cacheReadTokens).toBeNull();
    expect(header.cacheWriteTokens).toBeNull();
    expect(header.recordComplete).toBe(false);
  });

  it('does not let stale recovery overwrite metrics after the attempt advances', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'error', executorId: 'executor-a' });
    const call = seedCall(harness, attemptId);
    const bodyStore: BodyStore = {
      put: vi.fn(),
      get: vi.fn(async (key) =>
        key === call.responseKey
          ? new TextEncoder().encode('{"usage":{"inputTokens":1,"outputTokens":2}}')
          : undefined,
      ),
    };
    harness.updateBehavior = (input) => {
      if (!String(input.UpdateExpression).includes('#calls')) return undefined;
      const current = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
      harness.put({
        ...current,
        sequence: 7,
        nextCall: 8,
        calls: 7,
        inputTokens: 700,
        outputTokens: 701,
        gameTokens: 1401,
        recordComplete: false,
      });
      return input.ConditionExpression ? 'throw' : undefined;
    };

    await expect(
      storeFor(harness, bodyStore).recoverBodies('owner', attemptId),
    ).resolves.toBeUndefined();

    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    expect(header.sequence).toBe(7);
    expect(header.nextCall).toBe(8);
    expect(header.calls).toBe(7);
    expect(header.inputTokens).toBe(700);
    expect(header.outputTokens).toBe(701);
    expect(header.gameTokens).toBe(1401);
  });

  it('does not replace an existing response body hash during recovery', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'error', executorId: 'executor-a' });
    const call = seedCall(harness, attemptId, { responseSha256: 'f'.repeat(64) });
    const bodyStore: BodyStore = {
      put: vi.fn(),
      get: vi.fn(async () =>
        new TextEncoder().encode('{"usage":{"inputTokens":1,"outputTokens":1}}'),
      ),
    };
    harness.updateBehavior = (input) =>
      String(input.UpdateExpression).includes('#responseSha256') ? 'throw' : undefined;

    await storeFor(harness, bodyStore).recoverBodies('owner', attemptId);

    const recovered = harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')!;
    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    expect(recovered.responseSha256).toBe('f'.repeat(64));
    expect(recovered.status).toBe('started');
    expect(header.recordComplete).toBe(false);
    expect(call.responseKey).toContain('/response.json');
  });
});
