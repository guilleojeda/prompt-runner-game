import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  createDefaultDraft,
  type DraftSnapshot,
  type RobotDraft,
  validateDraft,
} from '../../../shared/robot.js';

export interface DraftStore {
  get(sub: string): Promise<DraftSnapshot>;
  put(sub: string, expectedVersion: number, draft: RobotDraft): Promise<DraftSnapshot>;
}

export class DraftConflictError extends Error {
  public readonly current: DraftSnapshot;

  public constructor(current: DraftSnapshot) {
    super('La configuración cambió en otra pestaña.');
    this.name = 'DraftConflictError';
    this.current = current;
  }
}

export class DraftStorageError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DraftStorageError';
  }
}

export class DraftIncompatibleError extends Error {
  public constructor(
    message = 'El borrador guardado no es compatible con la versión actual.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DraftIncompatibleError';
  }
}

const keyFor = (sub: string): Record<string, AttributeValue> =>
  marshall({ PK: `USER#${sub}`, SK: 'DRAFT' });

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException ||
  (error instanceof Error && error.name === 'ConditionalCheckFailedException');

const readSnapshot = (item: Record<string, unknown>): DraftSnapshot => {
  const version = item.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new DraftIncompatibleError('El borrador guardado tiene una versión incompatible.');
  }
  if (typeof item.updatedAt !== 'string' || item.updatedAt.length === 0) {
    throw new DraftIncompatibleError();
  }
  let draft: RobotDraft;
  try {
    draft = validateDraft(item.draft);
  } catch (error) {
    throw new DraftIncompatibleError('El borrador guardado tiene una configuración incompatible.', {
      cause: error,
    });
  }
  return { version, updatedAt: item.updatedAt, draft };
};

export interface DynamoDraftStoreOptions {
  readonly client?: DynamoDBClient;
  readonly tableName?: string;
  readonly now?: () => string;
}

/** The single current draft item stored for each user. */
export const createDynamoDraftStore = (options: DynamoDraftStoreOptions = {}): DraftStore => {
  const client = options.client ?? new DynamoDBClient({});
  const tableName = options.tableName ?? process.env.DRAFT_TABLE_NAME;
  const now = options.now ?? (() => new Date().toISOString());
  if (!tableName) {
    throw new DraftStorageError('Falta DRAFT_TABLE_NAME.');
  }

  const get = async (sub: string): Promise<DraftSnapshot> => {
    let response;
    try {
      response = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: keyFor(sub),
          ConsistentRead: true,
        }),
      );
    } catch (error) {
      throw new DraftStorageError('No se pudo leer la configuración.', { cause: error });
    }
    if (!response.Item) {
      return { version: 0, draft: createDefaultDraft() };
    }
    try {
      return readSnapshot(unmarshall(response.Item));
    } catch (error) {
      if (error instanceof DraftIncompatibleError) {
        throw error;
      }
      throw new DraftIncompatibleError(undefined, { cause: error });
    }
  };

  const put = async (
    sub: string,
    expectedVersion: number,
    draft: RobotDraft,
  ): Promise<DraftSnapshot> => {
    const version = expectedVersion + 1;
    const updatedAt = now();
    const condition =
      expectedVersion === 0
        ? 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
        : 'attribute_exists(PK) AND attribute_exists(SK) AND #version = :expectedVersion';
    const item = marshall(
      {
        PK: `USER#${sub}`,
        SK: 'DRAFT',
        version,
        updatedAt,
        draft,
      },
      { removeUndefinedValues: true },
    );
    try {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: condition,
          ...(expectedVersion > 0
            ? {
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: marshall({ ':expectedVersion': expectedVersion }),
              }
            : {}),
          ReturnValues: 'NONE',
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new DraftConflictError(await get(sub));
      }
      throw new DraftStorageError('No se pudo guardar la configuración.', { cause: error });
    }
    return { version, updatedAt, draft };
  };

  return { get, put };
};
