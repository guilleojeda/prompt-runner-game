import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot';
import {
  DynamoSavedRobotStore,
  SavedRobotConflictError,
  SavedRobotCursorError,
  type DynamoSavedRobotStoreOptions,
} from './saved-robots';

type Item = Record<string, AttributeValue>;

class DynamoHarness {
  public readonly items = new Map<string, Item>();
  public readonly commands: string[] = [];
  public readonly inputs: Record<string, unknown>[] = [];

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
    if (name === 'DeleteItemCommand') {
      const key = unmarshall(command.input.Key as Item) as { PK: string; SK: string };
      const itemKey = `${key.PK}\u0000${key.SK}`;
      const existing = this.items.get(itemKey);
      const expectedVersion = (
        unmarshall(command.input.ExpressionAttributeValues as Item) as { ':version': number }
      )[':version'];
      if (!existing || Number(unmarshall(existing).version) !== expectedVersion) {
        throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      }
      this.items.delete(itemKey);
      return {};
    }
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
      const limit = Math.min(Number(command.input.Limit), matching.length);
      const page = matching.slice(0, limit);
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
}

const storeFor = (harness: DynamoHarness, now = '2026-09-29T12:00:00.000Z') =>
  new DynamoSavedRobotStore({
    client: harness as unknown as DynamoSavedRobotStoreOptions['client'],
    tableName: 'robots',
    now: () => now,
  });

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const modelChoices = [
  'claude-sonnet-5.5',
  'claude-opus-5.5',
  'openai-gpt-6.1-sol',
  'openai-gpt-6-luna',
] as const;

describe('DynamoSavedRobotStore', () => {
  it('persists each added model in the saved copy and its list summary', async () => {
    const harness = new DynamoHarness();
    const store = storeFor(harness);
    const ids = [
      firstId,
      secondId,
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];

    for (const [index, modelKey] of modelChoices.entries()) {
      const draft = { ...createDefaultDraft(), modelKey };
      const saved = await store.put('user-a', ids[index]!, 0, `Robot ${index + 1}`, draft);
      expect(saved.draft.modelKey).toBe(modelKey);
      await expect(store.get('user-a', ids[index]!)).resolves.toMatchObject({
        modelKey,
        draft: { modelKey },
      });
    }

    const summaries = await store.list('user-a');
    expect(summaries.robots.map((robot) => robot.modelKey)).toEqual(
      expect.arrayContaining([...modelChoices]),
    );
  });

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
    expect(harness.commands.filter((name) => name === 'QueryCommand').length).toBe(2);
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
    expect(harness.commands.filter((name) => name === 'QueryCommand')).toHaveLength(1);
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
});
