import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const defaultClient = new DynamoDBClient({});
const WRITE_TIMEOUT_MS = 1_000;

export const authTimeToIsoTimestamp = (value: unknown, now = Date.now()): string | undefined => {
  let seconds: number;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    seconds = value;
  } else if (typeof value === 'string' && /^\d+$/u.test(value)) {
    seconds = Number(value);
  } else {
    return undefined;
  }

  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds * 1_000 > now) {
    return undefined;
  }
  return new Date(seconds * 1_000).toISOString();
};

export const recordLoginActivity = async (
  sub: string,
  lastLoginAt: string,
  client: DynamoDBClient = defaultClient,
): Promise<void> => {
  const tableName = process.env.DRAFT_TABLE_NAME;
  if (!tableName) throw new Error('Falta DRAFT_TABLE_NAME.');

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ PK: `USER#${sub}`, SK: 'ACTIVITY' }),
        UpdateExpression: 'SET #lastLoginAt = :lastLoginAt',
        ConditionExpression: 'attribute_not_exists(#lastLoginAt) OR #lastLoginAt < :lastLoginAt',
        ExpressionAttributeNames: { '#lastLoginAt': 'lastLoginAt' },
        ExpressionAttributeValues: marshall({ ':lastLoginAt': lastLoginAt }),
      }),
      { abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS) },
    );
  } catch (error) {
    if (
      error instanceof ConditionalCheckFailedException ||
      (error instanceof Error && error.name === 'ConditionalCheckFailedException')
    ) {
      return;
    }
    throw error;
  }
};
