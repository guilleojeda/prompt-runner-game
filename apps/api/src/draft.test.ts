import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot';
import { DraftIncompatibleError, createDynamoDraftStore } from './draft';

const commandClient = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as DynamoDBClient;

describe('Dynamo draft store', () => {
  it('uses strongly consistent reads and conditional first writes', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createDynamoDraftStore({
      client: commandClient(send),
      tableName: 'Drafts',
      now: () => '2026-09-21T00:00:00.000Z',
    });

    const initial = await store.get('user-a');
    const saved = await store.put('user-a', initial.version, initial.draft);

    expect(initial.version).toBe(0);
    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: 'Drafts',
      ConsistentRead: true,
      Key: marshall({ PK: 'USER#user-a', SK: 'DRAFT' }),
    });
    expect(send.mock.calls[1][0].input).toMatchObject({
      TableName: 'Drafts',
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    });
    expect(saved).toMatchObject({ version: 1, updatedAt: '2026-09-21T00:00:00.000Z' });
    expect(send.mock.calls[1][0].input.Item).toMatchObject(
      marshall({
        PK: 'USER#user-a',
        SK: 'DRAFT',
        version: 1,
        updatedAt: '2026-09-21T00:00:00.000Z',
        draft: initial.draft,
      }),
    );
  });

  it('uses the current version condition and reads the winner on conflict', async () => {
    const winner = createDefaultDraft();
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: 'conditional failure', $metadata: {} }),
      )
      .mockResolvedValueOnce({
        Item: marshall({
          PK: 'USER#user-a',
          SK: 'DRAFT',
          version: 3,
          updatedAt: '2026-09-21T00:00:03.000Z',
          draft: winner,
        }),
      });
    const store = createDynamoDraftStore({ client: commandClient(send), tableName: 'Drafts' });

    try {
      await store.put('user-a', 2, winner);
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toHaveProperty('current.version', 3);
      expect(error).toHaveProperty('current.draft', winner);
    }
    expect(send.mock.calls[0][0].input).toMatchObject({
      ConditionExpression:
        'attribute_exists(PK) AND attribute_exists(SK) AND #version = :expectedVersion',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: marshall({ ':expectedVersion': 2 }),
    });
    expect(send.mock.calls[1][0].input.ConsistentRead).toBe(true);
  });

  it('keeps users isolated by the server derived key', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createDynamoDraftStore({ client: commandClient(send), tableName: 'Drafts' });

    await store.put('user-a', 0, createDefaultDraft());
    await store.put('user-b', 0, createDefaultDraft());

    expect(send.mock.calls[0][0].input.Item.PK).toEqual({ S: 'USER#user-a' });
    expect(send.mock.calls[1][0].input.Item.PK).toEqual({ S: 'USER#user-b' });
  });

  it('reads a valid v1 draft as Sonnet 5 without writing a migration', async () => {
    const current = createDefaultDraft();
    const legacy = Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== 'modelKey'),
    );
    const send = vi.fn().mockResolvedValue({
      Item: marshall({
        PK: 'USER#user-a',
        SK: 'DRAFT',
        version: 7,
        updatedAt: '2026-09-21T00:00:00.000Z',
        draft: { ...legacy, schemaVersion: 1 },
      }),
    });
    const store = createDynamoDraftStore({ client: commandClient(send), tableName: 'Drafts' });

    const snapshot = await store.get('user-a');

    expect(snapshot.version).toBe(7);
    expect(snapshot.draft.modelKey).toBe('claude-sonnet-5');
    expect(snapshot.draft.instructions).toBe(current.instructions);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].constructor.name).toBe('GetItemCommand');
  });

  it.each(['schemaVersion', 'catalogVersion'] as const)(
    'classifies an unknown stored %s as incompatible without writing',
    async (versionKey) => {
      const draft = { ...createDefaultDraft(), [versionKey]: 99 };
      const send = vi.fn().mockResolvedValue({
        Item: marshall({
          PK: 'USER#user-a',
          SK: 'DRAFT',
          version: 1,
          updatedAt: '2026-09-21T00:00:00.000Z',
          draft,
        }),
      });
      const store = createDynamoDraftStore({ client: commandClient(send), tableName: 'Drafts' });

      await expect(store.get('user-a')).rejects.toBeInstanceOf(DraftIncompatibleError);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
});
