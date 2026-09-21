import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot';
import { createDynamoDraftStore } from './draft';

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
});
