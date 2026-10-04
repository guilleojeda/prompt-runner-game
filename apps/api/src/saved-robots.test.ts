import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot';
import {
  DynamoSavedRobotStore,
  SavedRobotConflictError,
  SavedRobotCursorError,
  SavedRobotLimitError,
  SavedRobotStorageError,
  type DynamoSavedRobotStoreOptions,
} from './saved-robots';

type Item = Record<string, AttributeValue>;

class DynamoHarness {
  public readonly items = new Map<string, Item>();
  public readonly commands: string[] = [];
  public readonly inputs: Record<string, unknown>[] = [];
  public failNextTransactAfterCommit = false;
  public successfulTransactions = 0;

  public constructor(private readonly queryPageSize = Number.MAX_SAFE_INTEGER) {}

  public async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const name = command.constructor.name;
    this.commands.push(name);
    this.inputs.push(command.input);
    if (name === 'GetItemCommand') {
      const key = unmarshall(command.input.Key as Item) as { PK: string; SK: string };
      const item = this.items.get(`${key.PK}\u0000${key.SK}`);
      return item ? { Item: structuredClone(item) } : {};
    }
    if (name === 'PutItemCommand') {
      const value = unmarshall(command.input.Item as Item) as { PK: string; SK: string };
      const itemKey = `${value.PK}\u0000${value.SK}`;
      const existing = this.items.get(itemKey);
      const expectedVersion = command.input.ExpressionAttributeValues
        ? (
            unmarshall(command.input.ExpressionAttributeValues as Item) as {
              ':expectedVersion'?: number;
            }
          )[':expectedVersion']
        : undefined;
      if (
        (String(command.input.ConditionExpression).includes('attribute_not_exists') && existing) ||
        (expectedVersion !== undefined &&
          (!existing || Number(unmarshall(existing).version) !== expectedVersion))
      ) {
        throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      }
      this.items.set(itemKey, structuredClone(command.input.Item as Item));
      return {};
    }
    if (name === 'TransactWriteItemsCommand') return this.transact(command.input);
    if (name === 'QueryCommand') {
      const values = unmarshall(command.input.ExpressionAttributeValues as Item) as {
        ':pk': string;
        ':prefix': string;
      };
      const start = command.input.ExclusiveStartKey
        ? (unmarshall(command.input.ExclusiveStartKey as Item) as { SK: string }).SK
        : undefined;
      const matching = [...this.items.entries()]
        .filter(([key]) => {
          const [pk, sk] = key.split('\u0000');
          return pk === values[':pk'] && sk.startsWith(values[':prefix']) && (!start || sk < start);
        })
        .sort(([left], [right]) => right.localeCompare(left));
      const requestedLimit = Number(command.input.Limit ?? this.queryPageSize);
      const limit = Math.min(requestedLimit, this.queryPageSize, matching.length);
      const page = matching.slice(0, limit);
      if (command.input.Select === 'COUNT') {
        return {
          Count: page.length,
          ...(page.length < matching.length
            ? {
                LastEvaluatedKey: marshall({
                  PK: page.at(-1)![0].split('\u0000')[0],
                  SK: page.at(-1)![0].split('\u0000')[1],
                }),
              }
            : {}),
        };
      }
      return {
        Items: page.map(([, item]) => {
          const names = (command.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
          const attributes = String(command.input.ProjectionExpression ?? '')
            .split(',')
            .map((attribute) => names[attribute.trim()] ?? attribute.trim())
            .filter(Boolean);
          if (attributes.length === 0) return structuredClone(item);
          return Object.fromEntries(
            attributes
              .filter((attribute) => Object.prototype.hasOwnProperty.call(item, attribute))
              .map((attribute) => [attribute, item[attribute]]),
          ) as Item;
        }),
        ...(page.length < matching.length
          ? {
              LastEvaluatedKey: marshall({
                PK: page.at(-1)![0].split('\u0000')[0],
                SK: page.at(-1)![0].split('\u0000')[1],
              }),
            }
          : {}),
      };
    }
    throw new Error(`Unhandled ${name}`);
  }

  private transact(input: Record<string, unknown>) {
    const actions = input.TransactItems as Array<Record<string, Record<string, unknown>>>;
    const parsed = actions.map((action) => {
      if (action.Update) {
        const update = action.Update;
        const key = unmarshall(update.Key as Item) as { PK: string; SK: string };
        const storageKey = `${key.PK}\u0000${key.SK}`;
        const existing = this.items.get(storageKey);
        if (!existing)
          throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
        const item = unmarshall(existing) as { count?: number };
        const names = update.ExpressionAttributeNames as Record<string, string>;
        const values = unmarshall(update.ExpressionAttributeValues as Item);
        const oldCount = item[names['#count'] as 'count'];
        const candidate =
          Number(oldCount) + (String(update.UpdateExpression).includes('-') ? -1 : 1);
        const condition = String(update.ConditionExpression);
        const passes =
          (condition.includes('< :maximum') && Number(oldCount) < Number(values[':maximum'])) ||
          (condition.includes('> :zero') && Number(oldCount) > Number(values[':zero']));
        if (!passes) {
          throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
        }
        return { kind: 'update' as const, storageKey, existing, candidate, names };
      }
      if (action.Put) {
        const put = action.Put;
        const value = unmarshall(put.Item as Item) as { PK: string; SK: string };
        const storageKey = `${value.PK}\u0000${value.SK}`;
        if (this.items.has(storageKey)) {
          throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
        }
        return { kind: 'put' as const, storageKey, item: put.Item as Item };
      }
      if (action.Delete) {
        const deletion = action.Delete;
        const key = unmarshall(deletion.Key as Item) as { PK: string; SK: string };
        const storageKey = `${key.PK}\u0000${key.SK}`;
        const existing = this.items.get(storageKey);
        const expectedVersion = (
          unmarshall(deletion.ExpressionAttributeValues as Item) as { ':version': number }
        )[':version'];
        if (!existing || Number(unmarshall(existing).version) !== expectedVersion) {
          throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
        }
        return { kind: 'delete' as const, storageKey };
      }
      throw new Error('Unhandled transaction action');
    });

    for (const action of parsed) {
      if (action.kind === 'update') {
        const value = unmarshall(action.existing) as Record<string, unknown>;
        value[action.names['#count']] = action.candidate;
        this.items.set(action.storageKey, marshall(value));
      } else if (action.kind === 'put') {
        this.items.set(action.storageKey, structuredClone(action.item));
      } else {
        this.items.delete(action.storageKey);
      }
    }
    this.successfulTransactions += 1;
    if (this.failNextTransactAfterCommit) {
      this.failNextTransactAfterCommit = false;
      throw Object.assign(new Error('response lost'), { name: 'TimeoutError' });
    }
    return {};
  }
}

const storeFor = (harness: DynamoHarness, now = '2026-09-29T12:00:00.000Z', maxCopies = 3) =>
  new DynamoSavedRobotStore({
    client: harness as unknown as DynamoSavedRobotStoreOptions['client'],
    tableName: 'robots',
    now: () => now,
    maxCopies,
  });

afterEach(() => vi.unstubAllEnvs());

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

const seedRobot = (harness: DynamoHarness, owner: string, id: string) => {
  const draft = createDefaultDraft();
  harness.items.set(
    `USER#${owner}\u0000ROBOT#${id}`,
    marshall({
      PK: `USER#${owner}`,
      SK: `ROBOT#${id}`,
      entity: 'saved-robot',
      id,
      name: `Robot ${id.slice(0, 4)}`,
      version: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      modelKey: draft.modelKey,
      draft,
    }),
  );
};

describe('DynamoSavedRobotStore', () => {
  it('keeps independent private copies, paginates summaries, and preserves exact draft text', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness);
    const firstDraft = {
      ...createDefaultDraft(),
      instructions: 'Instrucción literal ñ',
      skills: createDefaultDraft().skills.map((skill) =>
        skill.id === 'advance' ? { ...skill, description: 'Descripción exacta' } : skill,
      ),
    };
    const secondDraft = { ...createDefaultDraft(), instructions: 'Segunda instrucción' };

    const first = await store.put('user-a', firstId, 0, '  Robot uno  ', firstDraft);
    const second = await store.put('user-a', secondId, 0, 'Robot dos', secondDraft);
    expect(first).toMatchObject({ id: firstId, name: 'Robot uno', version: 1, draft: firstDraft });
    expect(second).toMatchObject({ id: secondId, name: 'Robot dos', version: 1 });
    expect(unmarshall(harness.items.get(`USER#user-a\u0000ROBOT#${firstId}`)!)).not.toHaveProperty(
      'levelId',
    );

    const firstPage = await store.list('user-a', undefined, 1);
    expect(firstPage.robots).toHaveLength(1);
    expect(firstPage.robots[0]).not.toHaveProperty('draft');
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await store.list('user-a', firstPage.nextCursor, 1);
    expect(secondPage.robots).toHaveLength(1);
    expect(new Set([firstPage.robots[0].id, secondPage.robots[0].id])).toEqual(
      new Set([firstId, secondId]),
    );

    const read = await store.get('user-a', firstId);
    expect(read).toEqual(first);
    expect(read?.draft.instructions).toBe('Instrucción literal ñ');
    expect(read?.draft.skills.find((skill) => skill.id === 'advance')?.description).toBe(
      'Descripción exacta',
    );
    expect(await store.get('user-b', firstId)).toBeUndefined();
    expect(harness.inputs.filter((input) => input.ProjectionExpression).length).toBe(2);
    expect(
      harness.inputs
        .filter((input) => input.TableName === 'robots')
        .filter((input) => 'ConsistentRead' in input)
        .every((input) => input.ConsistentRead === true),
    ).toBe(true);
    const queryInput = harness.inputs.find((input) => input.ProjectionExpression);
    expect(queryInput?.ProjectionExpression).toContain('#modelKey');
    expect(queryInput?.ProjectionExpression).not.toContain('draft');
  });

  it('updates and deletes with conditional versions, exposing current records on conflicts', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness);
    const draft = createDefaultDraft();
    const created = await store.put('user-a', firstId, 0, 'Original', draft);
    const updated = await store.put('user-a', firstId, 1, 'Actualizado', {
      ...draft,
      instructions: 'Nueva instrucción',
    });
    expect(updated).toMatchObject({
      version: 2,
      createdAt: created.createdAt,
      name: 'Actualizado',
    });

    await expect(store.put('user-a', firstId, 1, 'Obsoleto', draft)).rejects.toMatchObject({
      current: updated,
    });
    await expect(store.delete('user-a', firstId, 1)).rejects.toMatchObject({
      current: updated,
    });
    await expect(store.delete('user-b', firstId, 1)).rejects.toMatchObject({ current: undefined });
    await expect(store.delete('user-a', firstId, 2)).resolves.toEqual({ deleted: true });
    await expect(store.get('user-a', firstId)).resolves.toBeUndefined();
  });

  it('reconciles an ambiguous create by returning a conflict for the same client id', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness);
    const draft = createDefaultDraft();
    const created = await store.put('user-a', firstId, 0, 'Robot', draft);
    await expect(store.put('user-a', firstId, 0, 'Robot', draft)).rejects.toEqual(
      expect.objectContaining({
        current: created,
      } satisfies Partial<SavedRobotConflictError>),
    );
  });

  it('rejects malformed and cross-owner cursors before querying another owner', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness);
    await store.put('user-a', firstId, 0, 'Robot uno', createDefaultDraft());
    await store.put('user-a', secondId, 0, 'Robot dos', createDefaultDraft());
    const page = await store.list('user-a', undefined, 1);
    expect(page.nextCursor).toBeDefined();

    await expect(store.list('user-b', page.nextCursor, 1)).rejects.toBeInstanceOf(
      SavedRobotCursorError,
    );
    await expect(store.list('user-a', 'not-a-cursor', 1)).rejects.toBeInstanceOf(
      SavedRobotCursorError,
    );
    expect(harness.inputs.filter((input) => input.ProjectionExpression)).toHaveLength(1);
  });

  it('lists a summary when the full draft is incompatible but GET reports the incompatibility', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness);
    await store.put('user-a', firstId, 0, 'Robot', createDefaultDraft());
    const item = harness.items.get(`USER#user-a\u0000ROBOT#${firstId}`);
    expect(item).toBeDefined();
    item!.draft = { M: marshall({ malformed: true }) };

    const page = await store.list('user-a');
    expect(page.robots).toEqual([
      expect.objectContaining({ id: firstId, name: 'Robot', modelKey: 'claude-sonnet-4.6' }),
    ]);
    await expect(store.get('user-a', firstId)).rejects.toMatchObject({
      name: 'SavedRobotIncompatibleError',
    });
  });

  it('counts copies transactionally, leaves edits count-neutral, and frees a slot on delete', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness, undefined, 1);
    const draft = createDefaultDraft();

    await store.put('user-a', firstId, 0, 'Robot', draft);
    const createTransaction = harness.inputs.find((input) => 'TransactItems' in input);
    expect(createTransaction?.TransactItems).toEqual([
      expect.objectContaining({ Update: expect.any(Object) }),
      expect.objectContaining({ Put: expect.any(Object) }),
    ]);
    await expect(store.put('user-a', secondId, 0, 'Otro robot', draft)).rejects.toBeInstanceOf(
      SavedRobotLimitError,
    );
    const committedBeforeEdit = harness.successfulTransactions;
    await expect(store.put('user-a', firstId, 1, 'Editado', draft)).resolves.toMatchObject({
      version: 2,
      name: 'Editado',
    });
    expect(harness.successfulTransactions).toBe(committedBeforeEdit);

    await store.delete('user-a', firstId, 2);
    const transactions = harness.inputs.filter((input) => 'TransactItems' in input);
    expect(transactions).toHaveLength(3);
    expect(transactions[2].TransactItems).toEqual([
      expect.objectContaining({ Delete: expect.any(Object) }),
      expect.objectContaining({ Update: expect.any(Object) }),
    ]);
    await expect(store.put('user-a', secondId, 0, 'Otro robot', draft)).resolves.toMatchObject({
      id: secondId,
    });
  });

  it('bootstraps legacy copies with paginated consistent reads and keeps over-limit data usable', async () => {
    const harness = new DynamoHarness(2);
    const legacyIds = [firstId, secondId, '33333333-3333-4333-8333-333333333333'];
    legacyIds.forEach((id) => seedRobot(harness, 'user-a', id));
    const store = storeFor(harness, undefined, 2);

    const listed = await store.list('user-a');
    expect(listed.nextCursor).toBeDefined();
    const remaining = await store.list('user-a', listed.nextCursor);
    expect([...listed.robots, ...remaining.robots]).toHaveLength(3);
    await expect(
      store.put('user-a', '44444444-4444-4444-8444-444444444444', 0, 'Nuevo', createDefaultDraft()),
    ).rejects.toBeInstanceOf(SavedRobotLimitError);

    const countQueries = harness.inputs.filter((input) => input.Select === 'COUNT');
    expect(countQueries.length).toBeGreaterThan(1);
    expect(countQueries.every((input) => input.ConsistentRead === true)).toBe(true);
    expect(unmarshall(harness.items.get('USER#user-a\u0000META#SAVED_ROBOTS_COUNT')!).count).toBe(
      3,
    );

    await expect(
      store.put('user-a', firstId, 1, 'Editado', createDefaultDraft()),
    ).resolves.toMatchObject({ version: 2 });
    await store.delete('user-a', firstId, 2);
    await expect(
      store.put('user-a', '44444444-4444-4444-8444-444444444444', 0, 'Nuevo', createDefaultDraft()),
    ).rejects.toBeInstanceOf(SavedRobotLimitError);
    await store.delete('user-a', secondId, 1);
    await expect(
      store.put('user-a', '44444444-4444-4444-8444-444444444444', 0, 'Nuevo', createDefaultDraft()),
    ).resolves.toMatchObject({ id: '44444444-4444-4444-8444-444444444444' });
    expect(legacyIds).toContain('33333333-3333-4333-8333-333333333333');
    expect(harness.items.has('USER#user-a\u0000ROBOT#33333333-3333-4333-8333-333333333333')).toBe(
      true,
    );
  });

  it('rejects concurrent creates at the limit without overshooting', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness, undefined, 2);
    const ids = [
      firstId,
      secondId,
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ];
    const outcomes = await Promise.allSettled(
      ids.map((id) => store.put('user-a', id, 0, 'Robot', createDefaultDraft())),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.status === 'rejected' && outcome.reason instanceof SavedRobotLimitError,
      ),
    ).toHaveLength(3);
    expect(
      [...harness.items.keys()].filter((key) => key.startsWith('USER#user-a\u0000ROBOT#')),
    ).toHaveLength(2);
    expect(unmarshall(harness.items.get('USER#user-a\u0000META#SAVED_ROBOTS_COUNT')!).count).toBe(
      2,
    );
  });

  it('does not free a slot when a delete loses its version condition', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness, undefined, 1);
    await store.put('user-a', firstId, 0, 'Robot', createDefaultDraft());

    await expect(store.delete('user-a', firstId, 8)).rejects.toMatchObject({
      name: 'SavedRobotConflictError',
    });
    await expect(
      store.put('user-a', secondId, 0, 'Otro robot', createDefaultDraft()),
    ).rejects.toBeInstanceOf(SavedRobotLimitError);
    expect(unmarshall(harness.items.get('USER#user-a\u0000META#SAVED_ROBOTS_COUNT')!).count).toBe(
      1,
    );
  });

  it('keeps a lost create response retry from incrementing the count twice', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness, undefined, 2);
    harness.failNextTransactAfterCommit = true;

    await expect(
      store.put('user-a', firstId, 0, 'Robot', createDefaultDraft()),
    ).rejects.toBeInstanceOf(SavedRobotStorageError);
    await expect(
      store.put('user-a', firstId, 0, 'Robot', createDefaultDraft()),
    ).rejects.toMatchObject({
      name: 'SavedRobotConflictError',
      current: expect.objectContaining({ id: firstId }),
    });
    expect(unmarshall(harness.items.get('USER#user-a\u0000META#SAVED_ROBOTS_COUNT')!).count).toBe(
      1,
    );
  });

  it('keeps legacy reads, edits, and deletes available when the private limit is invalid', async () => {
    const harness = new DynamoHarness();
    seedRobot(harness, 'user-a', firstId);
    vi.stubEnv('SAVED_ROBOTS_LIMIT', 'invalid');
    const store = new DynamoSavedRobotStore({
      client: harness as unknown as DynamoSavedRobotStoreOptions['client'],
      tableName: 'robots',
    });

    await expect(store.get('user-a', firstId)).resolves.toMatchObject({ id: firstId });
    await expect(
      store.put('user-a', firstId, 1, 'Editado', createDefaultDraft()),
    ).resolves.toMatchObject({
      version: 2,
    });
    await expect(
      store.put('user-a', secondId, 0, 'Nuevo', createDefaultDraft()),
    ).rejects.toMatchObject({
      name: 'SavedRobotStorageError',
      message: 'No se pudo guardar la configuración guardada.',
    });
    await expect(store.delete('user-a', firstId, 2)).resolves.toEqual({ deleted: true });
  });
});
