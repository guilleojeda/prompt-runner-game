import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  TransactionConflictException,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
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
import { createDefaultDraft, validateDraft } from '../../../shared/robot.js';
import { createClosedAttemptRecordFixture } from '../../../shared/attempt.fixture.js';
import {
  AdmissionConflictError,
  AttemptNotTerminalError,
  AttemptStoreError,
  createDynamoAttemptStore,
  IdempotencyConflictError,
  ModelUnavailableError,
  ReplayRecordError,
  S3BodyStore,
} from './attempt-store.js';

const commandClient = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as DynamoDBClient;

type CommandLike = {
  readonly input: Record<string, unknown>;
  readonly constructor: { readonly name: string };
};

type HarnessBehavior = undefined | 'throw' | 'applyThenThrow' | 'transaction-conflict';

const conditionalError = (): ConditionalCheckFailedException =>
  new ConditionalCheckFailedException({ message: 'conditional', $metadata: {} });

const transactionError = (): TransactionCanceledException =>
  new TransactionCanceledException({ message: 'ambiguous', $metadata: {} });
const transactionConflictError = (): TransactionConflictException =>
  new TransactionConflictException({ message: 'conflict', $metadata: {} });

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
  public queryPageSize = Number.POSITIVE_INFINITY;
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
      const start = input.ExclusiveStartKey
        ? unmarshall(input.ExclusiveStartKey as Record<string, AttributeValue>).SK
        : undefined;
      const matching = [...this.items.entries()]
        .filter(
          ([key]) =>
            key.startsWith(`${pk}\u0000`) &&
            key.split('\u0000')[1].startsWith(prefix) &&
            (typeof start !== 'string' || key.split('\u0000')[1] > start),
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([itemKeyValue, value]) => ({ itemKeyValue, value }));
      const commandLimit = typeof input.Limit === 'number' ? input.Limit : Number.POSITIVE_INFINITY;
      const pageSize = Math.min(this.queryPageSize, commandLimit);
      const page = matching.slice(0, pageSize);
      const last = page.at(-1)?.itemKeyValue.split('\u0000')[1];
      return {
        Items: page.map(({ value }) => structuredClone(value)),
        ...(page.length < matching.length && last
          ? { LastEvaluatedKey: marshall({ PK: pk, SK: last }) }
          : {}),
      };
    }
    if (name === 'UpdateItemCommand') {
      const behavior = this.updateBehavior(input);
      if (behavior === 'applyThenThrow') {
        this.applyUpdate(input);
        throw conditionalError();
      }
      if (behavior === 'transaction-conflict') throw transactionConflictError();
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

const seedClosedReplay = (
  harness: DynamoHarness,
  overrides: Record<string, unknown> = {},
): { readonly attemptId: string; readonly actionCount: number; readonly snapshotCount: number } => {
  const record = createClosedAttemptRecordFixture();
  const attemptId = 'attempt-replay';
  const final = record.snapshots.at(-1);
  const attempt = {
    PK: 'USER#owner',
    SK: `ATTEMPT#${attemptId}`,
    entity: 'attempt',
    recordVersion: record.recordVersion,
    id: attemptId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.closure.status,
    cancelRequested: false,
    levelId: record.config.level.id,
    turnsUsed: final?.turnsUsed ?? 0,
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
    finalSupport: final?.support ?? 0,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
    owner: 'owner',
    requestKey: 'replay-request',
    draft: { ...createDefaultDraft(), instructions: 'PRIVATE REPLAY PROMPT' },
    instructions: 'PRIVATE HEADER INSTRUCTIONS',
    skills: [],
    config: { ...DEFAULT_ATTEMPT_CONFIG, levelDefinition: record.config.level },
    sequence: record.actions.length,
    nextCall: record.actions.length + 1,
    initialStateId: record.snapshots[0]?.id,
    currentStateId: record.closure.finalStateId,
    startDeadline: '2026-09-21T16:00:00.000Z',
    sessionId: `attempt-${attemptId}`,
    ...overrides,
  };
  harness.put(attempt);
  for (const snapshot of record.snapshots) {
    harness.put({
      PK: `ATTEMPT#${attemptId}`,
      SK: `STATE#${snapshot.id}`,
      entity: 'snapshot',
      stateId: snapshot.id,
      snapshot,
    });
  }
  for (const action of record.actions) {
    harness.put({
      PK: `ATTEMPT#${attemptId}`,
      SK: `ACTION#${String(action.seq).padStart(8, '0')}`,
      entity: 'action',
      ...action,
    });
  }
  return {
    attemptId,
    actionCount: record.actions.length,
    snapshotCount: record.snapshots.length,
  };
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
      reasoningTokens: null,
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
  it('reads a legacy Sonnet 5 config without merging current defaults', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, {
      config: {
        ...DEFAULT_ATTEMPT_CONFIG,
        inferenceVersion: 'legacy-inference-v7',
        protocol: { stream: false, thinking: 'disabled', toolChoice: 'any' },
        model: {
          modelId: 'global.anthropic.claude-sonnet-5',
          region: 'us-east-1',
          maxTokens: 777,
        },
        scoreParameters: { ...DEFAULT_ATTEMPT_CONFIG.scoreParameters, base: 321 },
      },
      draft: { ...createDefaultDraft(), modelKey: 'claude-sonnet-5' as const },
    });

    const record = await storeFor(harness).get('owner', attemptId);

    expect(record?.config).toMatchObject({
      inferenceVersion: 'legacy-inference-v7',
      protocol: { api: 'converse', stream: false },
      model: {
        key: 'claude-sonnet-5',
        maxTokens: 777,
        profileVersion: 'legacy-inference-v7',
      },
      scoreParameters: { base: 321 },
    });
  });

  it('reads a v2 profile snapshot without resolving current catalog values', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, {
      config: {
        ...DEFAULT_ATTEMPT_CONFIG,
        inferenceVersion: 'historical-profile-v9',
        model: {
          ...DEFAULT_ATTEMPT_CONFIG.model,
          key: 'claude-sonnet-5',
          provider: 'anthropic',
          label: 'Historical label',
          modelId: 'us.anthropic.claude-sonnet-5',
          region: 'eu-west-1',
          profileVersion: 'historical-profile-v9',
          maxTokens: 777,
          protocol: { stream: false, thinking: 'disabled', toolChoice: 'any' },
        },
      },
      draft: { ...createDefaultDraft(), modelKey: 'claude-sonnet-5' as const },
    });

    const record = await storeFor(harness).get('owner', attemptId);

    expect(record?.config.model).toMatchObject({
      key: 'claude-sonnet-5',
      label: 'Historical label',
      modelId: 'us.anthropic.claude-sonnet-5',
      region: 'eu-west-1',
      profileVersion: 'historical-profile-v9',
      maxTokens: 777,
    });
  });

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

  it('recovers a phase-3 request key as animation-off before reading current draft state', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness);
    const legacyHeader = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    delete legacyHeader.animationEnabled;
    delete legacyHeader.presentationComplete;
    harness.put(legacyHeader);
    harness.put({
      PK: 'USER#owner',
      SK: 'REQUEST#request',
      entity: 'attempt-request',
      owner: 'owner',
      requestKey: 'request',
      fingerprint: 'legacy-draft-only-fingerprint',
      attemptId,
      day: '2026-09-21',
    });
    const store = storeFor(harness);
    const draft = createDefaultDraft();
    const duplicate = await store.admit({
      owner: 'owner',
      requestKey: 'request',
      expectedVersion: 999,
      draft,
    });
    expect(duplicate.admitted).toBe(false);
    expect(duplicate.attempt).toMatchObject({ id: attemptId, animationEnabled: false });
    expect(harness.send.mock.calls.some(([command]) => command.input.TransactItems)).toBe(false);
    await expect(
      store.admit({
        owner: 'owner',
        requestKey: 'request',
        expectedVersion: 1,
        draft,
        animationEnabled: true,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('rejects an unchanged legacy v1 draft before creating a new attempt', async () => {
    const harness = new DynamoHarness();
    const current = createDefaultDraft();
    const legacy = {
      schemaVersion: 1 as const,
      catalogVersion: current.catalogVersion,
      instructions: current.instructions,
      skills: current.skills,
    };
    harness.put({
      PK: 'USER#owner',
      SK: 'DRAFT',
      version: 1,
      updatedAt: '2026-09-21T15:00:00.000Z',
      draft: legacy,
    });
    await expect(
      storeFor(harness).admit({
        owner: 'owner',
        requestKey: 'legacy',
        expectedVersion: 1,
        draft: validateDraft(legacy),
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(harness.send.mock.calls.some(([command]) => command.input.TransactItems)).toBe(false);
  });

  it('rejects a concurrent change that only changes the selected model', async () => {
    const harness = new DynamoHarness();
    const original = createDefaultDraft();
    harness.put({
      PK: 'USER#owner',
      SK: 'DRAFT',
      version: 1,
      updatedAt: '2026-09-21T15:00:00.000Z',
      draft: original,
    });
    harness.transactionBehavior = () => {
      harness.put({
        ...harness.read('USER#owner', 'DRAFT'),
        draft: { ...original, modelKey: 'gpt-5.6-sol' },
      });
      return 'throw';
    };
    await expect(
      storeFor(harness).admit({
        owner: 'owner',
        requestKey: 'concurrent-model',
        expectedVersion: 1,
        draft: original,
      }),
    ).rejects.toBeInstanceOf(AdmissionConflictError);
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

describe('Dynamo animation preference and replay projection', () => {
  it('persists the default-on preference and rejects a stale conditional write', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness);
    expect(await store.getAnimationPreference('owner')).toEqual({
      animationEnabled: true,
      version: 0,
    });
    expect(await store.putAnimationPreference('owner', false, 0)).toEqual({
      animationEnabled: false,
      version: 1,
    });
    expect(await storeFor(harness).getAnimationPreference('owner')).toEqual({
      animationEnabled: false,
      version: 1,
    });
    harness.updateBehavior = (input) => {
      const condition = String(input.ConditionExpression);
      const current = harness.read('USER#owner', 'PREFERENCE#ANIMATION');
      if (condition.includes('attribute_not_exists(PK)')) return current ? 'throw' : undefined;
      if (!condition.includes('#version = :expectedVersion')) return undefined;
      const values = unmarshall(input.ExpressionAttributeValues as Record<string, AttributeValue>);
      return current?.version === values[':expectedVersion'] ? undefined : 'throw';
    };
    await expect(store.putAnimationPreference('owner', true, 0)).rejects.toMatchObject({
      current: { animationEnabled: false, version: 1 },
    });
    expect(harness.read('USER#owner', 'PREFERENCE#ANIMATION')).toMatchObject({
      animationEnabled: false,
      version: 1,
    });
  });

  it('marks presentation complete only for the owner of a terminal attempt', async () => {
    const harness = new DynamoHarness();
    const pending = seedAttempt(harness, { animationEnabled: true, presentationComplete: false });
    const store = storeFor(harness);
    await expect(store.markPresentationComplete('owner', pending.attemptId)).rejects.toBeInstanceOf(
      AttemptNotTerminalError,
    );

    const terminal = seedAttempt(harness, {
      status: 'error',
      animationEnabled: true,
      presentationComplete: false,
    });
    const completed = await store.markPresentationComplete('owner', terminal.attemptId);
    expect(completed?.presentationComplete).toBe(true);
    const markCommand = harness.send.mock.calls
      .map(([command]) => command)
      .find((command) =>
        String(command.input.UpdateExpression ?? '').includes('#presentationComplete = :true'),
      );
    expect(markCommand?.input.ConditionExpression).toContain('#status IN');
    await expect(
      store.markPresentationComplete('owner', terminal.attemptId),
    ).resolves.toMatchObject({ presentationComplete: true });
    expect(await store.markPresentationComplete('other-user', terminal.attemptId)).toBeUndefined();
  });

  it('reads every action and snapshot page and returns no private header fields', async () => {
    const harness = new DynamoHarness();
    harness.queryPageSize = 2;
    const { attemptId, actionCount, snapshotCount } = seedClosedReplay(harness);
    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    const storedConfig = header.config as Record<string, unknown>;
    const storedLevel = storedConfig.levelDefinition as Record<string, unknown>;
    header.config = {
      ...storedConfig,
      levelDefinition: { ...storedLevel, privateNote: 'PRIVATE NESTED LEVEL' },
    };
    harness.put(header);
    const firstState = harness.read(`ATTEMPT#${attemptId}`, 'STATE#state-0')!;
    firstState.snapshot = {
      ...(firstState.snapshot as Record<string, unknown>),
      privateObservation: 'PRIVATE SNAPSHOT DATA',
    };
    harness.put(firstState);
    const firstAction = harness.read(`ATTEMPT#${attemptId}`, 'ACTION#00000001')!;
    firstAction.action = {
      ...(firstAction.action as Record<string, unknown>),
      privatePrompt: 'PRIVATE ACTION DATA',
    };
    harness.put(firstAction);
    const store = storeFor(harness);
    const record = await store.getReplayRecord('owner', attemptId);
    expect(record?.actions).toHaveLength(actionCount);
    expect(record?.snapshots).toHaveLength(snapshotCount);
    expect(record?.actions[0]).toMatchObject({
      seq: 1,
      before: { id: 'state-0' },
      after: { id: 'state-1' },
    });
    expect(await store.getReplayRecord('another-user', attemptId)).toBeUndefined();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('PRIVATE REPLAY PROMPT');
    expect(serialized).not.toContain('PRIVATE HEADER INSTRUCTIONS');
    expect(serialized).not.toContain('PRIVATE NESTED LEVEL');
    expect(serialized).not.toContain('PRIVATE SNAPSHOT DATA');
    expect(serialized).not.toContain('PRIVATE ACTION DATA');
    expect(serialized).not.toContain('requestKey');
    expect(serialized).not.toContain('responseKey');
    expect(serialized).not.toContain('owner');
    expect(
      harness.send.mock.calls.filter(([command]) => command.constructor.name === 'QueryCommand'),
    ).toHaveLength(6);
  });

  it('rejects a missing replay action or a broken state reference instead of truncating', async () => {
    const missingAction = new DynamoHarness();
    const { attemptId } = seedClosedReplay(missingAction);
    missingAction.items.delete(itemKey(`ATTEMPT#${attemptId}`, 'ACTION#00000003'));
    await expect(
      storeFor(missingAction).getReplayRecord('owner', attemptId),
    ).rejects.toBeInstanceOf(ReplayRecordError);

    const brokenReference = new DynamoHarness();
    const broken = seedClosedReplay(brokenReference);
    const action = brokenReference.read(`ATTEMPT#${broken.attemptId}`, 'ACTION#00000003')!;
    brokenReference.put({ ...action, beforeStateId: 'state-missing' });
    await expect(
      storeFor(brokenReference).getReplayRecord('owner', broken.attemptId),
    ).rejects.toBeInstanceOf(ReplayRecordError);

    const missingSnapshot = new DynamoHarness();
    const incomplete = seedClosedReplay(missingSnapshot);
    missingSnapshot.items.delete(itemKey(`ATTEMPT#${incomplete.attemptId}`, 'STATE#state-3'));
    await expect(
      storeFor(missingSnapshot).getReplayRecord('owner', incomplete.attemptId),
    ).rejects.toBeInstanceOf(ReplayRecordError);

    const incompleteHeader = new DynamoHarness();
    const partial = seedClosedReplay(incompleteHeader);
    incompleteHeader.put({
      ...incompleteHeader.read('USER#owner', `ATTEMPT#${partial.attemptId}`),
      recordComplete: false,
    });
    await expect(
      storeFor(incompleteHeader).getReplayRecord('owner', partial.attemptId),
    ).rejects.toBeInstanceOf(ReplayRecordError);
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
  it('records the effective model identity on every new call', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, {
      status: 'running',
      executorId: 'executor-a',
    });
    const call = await storeFor(harness).beginCall('owner', attemptId, 'executor-a', {
      attemptId,
      seq: 1,
      decisionId: 'decision-1',
      requestKey: 'request-key',
      responseKey: 'response-key',
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
    });
    expect(call).toMatchObject({
      modelKey: 'claude-sonnet-4.6',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      region: 'us-east-1',
      profileVersion: 'claude-sonnet-4.6-global-v1',
    });
    expect(harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')).toMatchObject({
      modelKey: 'claude-sonnet-4.6',
    });
  });

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
        reasoningTokens: null,
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
        reasoningTokens: null,
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
        reasoningTokens: null,
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

  it('does not fail a running read when the active response object is not visible yet', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'running', executorId: 'executor-a' });
    seedCall(harness, attemptId);
    const bodyStore: BodyStore = {
      put: vi.fn(),
      get: vi.fn(async () => {
        throw new AttemptStoreError('private body is not visible yet');
      }),
    };

    await expect(
      storeFor(harness, bodyStore).recoverBodies('owner', attemptId),
    ).resolves.toBeUndefined();

    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    expect(header.status).toBe('running');
    expect(header.calls).toBe(0);
    expect(header.recordComplete).toBe(true);
    expect(bodyStore.get).not.toHaveBeenCalled();
    expect(harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')?.status).toBe('started');
  });

  it('does not recover any body while a running attempt owns a received call', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'running', executorId: 'executor-a' });
    seedCall(harness, attemptId, { status: 'received' });
    const bodyStore: BodyStore = {
      put: vi.fn(),
      get: vi.fn(async () => {
        throw new AttemptStoreError('running recovery must not read bodies');
      }),
    };

    await expect(
      storeFor(harness, bodyStore).recoverBodies('owner', attemptId),
    ).resolves.toBeUndefined();

    expect(bodyStore.get).not.toHaveBeenCalled();
    expect(harness.read('USER#owner', `ATTEMPT#${attemptId}`)?.status).toBe('running');
  });

  it('does not recover bodies while a pending attempt may be claiming', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'pending' });
    seedCall(harness, attemptId);
    const bodyStore: BodyStore = {
      put: vi.fn(),
      get: vi.fn(async () => {
        throw new AttemptStoreError('pending recovery must not read bodies');
      }),
    };

    await expect(
      storeFor(harness, bodyStore).recoverBodies('owner', attemptId),
    ).resolves.toBeUndefined();

    expect(bodyStore.get).not.toHaveBeenCalled();
    expect(harness.read('USER#owner', `ATTEMPT#${attemptId}`)?.status).toBe('pending');
  });

  it.each([
    ['NoSuchKey', false],
    ['NotFound', false],
    ['AccessDenied', true],
  ])('maps S3 %s according to private-body availability', async (name, rejects) => {
    const error = Object.assign(new Error(name), {
      name,
      $metadata: { httpStatusCode: name === 'AccessDenied' ? 403 : 404 },
    });
    const client = { send: vi.fn().mockRejectedValue(error) } as unknown as S3Client;
    const bodyStore = new S3BodyStore({ client, bucket: 'attempt-bodies' });
    const result = bodyStore.get('attempt/1/response.json');

    if (rejects) await expect(result).rejects.toMatchObject({ name: 'AttemptStoreError' });
    else await expect(result).resolves.toBeUndefined();
  });

  it('recovers a missing active body after the runtime deadline as incomplete', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, {
      status: 'running',
      executorId: 'executor-a',
      runtimeDeadline: '2026-09-21T14:59:00.000Z',
    });
    seedCall(harness, attemptId);
    const bodyStore: BodyStore = { put: vi.fn(), get: vi.fn(async () => undefined) };

    const recovered = await storeFor(harness, bodyStore).closeExpired(
      'owner',
      attemptId,
      '2026-09-21T15:00:00.000Z',
    );

    expect(recovered).toMatchObject({
      status: 'error',
      reason: 'runtime_deadline_expired',
      calls: 1,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      gameTokens: null,
      recordComplete: false,
    });
    expect(bodyStore.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['response metadata', '#responseSha256'],
    ['aggregate metadata', '#calls'],
  ])('does not turn a terminal %s conflict into a GET failure', async (_label, conflictField) => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'error', executorId: 'executor-a' });
    seedCall(harness, attemptId);
    harness.updateBehavior = (input) =>
      String(input.UpdateExpression).includes(conflictField) ? 'transaction-conflict' : undefined;
    const bodyStore: BodyStore = {
      put: vi.fn(),
      get: vi.fn(async () => new TextEncoder().encode('{"ok":true}')),
    };

    await expect(
      storeFor(harness, bodyStore).recoverBodies('owner', attemptId),
    ).resolves.toBeUndefined();

    const call = harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')!;
    const header = harness.read('USER#owner', `ATTEMPT#${attemptId}`)!;
    if (conflictField === '#responseSha256') {
      expect(call.status).toBe('started');
      expect(call.responseSha256).toBeUndefined();
      expect(header.calls).toBe(1);
      expect(header.recordComplete).toBe(false);
    } else {
      expect(call.status).toBe('received');
      expect(call.responseSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(header.calls).toBe(0);
      expect(header.recordComplete).toBe(true);
    }
  });

  it('guards response recovery against a stale call status', async () => {
    const harness = new DynamoHarness();
    const { attemptId } = seedAttempt(harness, { status: 'error', executorId: 'executor-a' });
    seedCall(harness, attemptId);
    let responseCondition = '';
    harness.updateBehavior = (input) => {
      if (String(input.UpdateExpression).includes('#responseSha256')) {
        responseCondition = String(input.ConditionExpression);
        const current = harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')!;
        harness.put({ ...current, status: 'error' });
        return 'throw';
      }
      return undefined;
    };
    const bodyStore: BodyStore = {
      put: vi.fn(),
      get: vi.fn(async () => new TextEncoder().encode('{"ok":true}')),
    };

    await expect(
      storeFor(harness, bodyStore).recoverBodies('owner', attemptId),
    ).resolves.toBeUndefined();

    expect(responseCondition).toContain('#status = :statusBefore');
    expect(harness.read(`ATTEMPT#${attemptId}`, 'CALL#00000001')?.status).toBe('error');
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
        reasoningTokens: null,
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
        reasoningTokens: null,
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
