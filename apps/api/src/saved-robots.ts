import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { isModelKey } from '../../../shared/models.js';
import {
  validateSavedRobotName,
  validateDraft,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';

export interface SavedRobotStore {
  list(
    owner: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ robots: SavedRobotSummary[]; nextCursor?: string }>;
  get(owner: string, id: string): Promise<SavedRobot | undefined>;
  put(
    owner: string,
    id: string,
    expectedVersion: number,
    name: string,
    draft: RobotDraft,
  ): Promise<SavedRobot>;
  delete(owner: string, id: string, expectedVersion: number): Promise<{ deleted: true }>;
}

export class SavedRobotConflictError extends Error {
  public readonly current?: SavedRobot;

  public constructor(current?: SavedRobot) {
    super('La configuración guardada cambió en otra pestaña.');
    this.name = 'SavedRobotConflictError';
    this.current = current;
  }
}

export class SavedRobotStorageError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SavedRobotStorageError';
  }
}

export class SavedRobotCursorError extends SavedRobotStorageError {
  public constructor(message = 'El cursor no es válido.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SavedRobotCursorError';
  }
}

export class SavedRobotIncompatibleError extends Error {
  public constructor(
    message = 'La configuración guardada no es compatible.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SavedRobotIncompatibleError';
  }
}

const MAX_ID_LENGTH = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Client generated UUIDs are the stable identity of saved copies. */
export const validateSavedRobotId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !UUID_PATTERN.test(value)) {
    throw new SavedRobotStorageError('El identificador de la configuración no es válido.');
  }
  return value.toLowerCase();
};

const keyFor = (owner: string, id: string): Record<string, AttributeValue> =>
  marshall({ PK: `USER#${owner}`, SK: `ROBOT#${id}` });

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException ||
  (error instanceof Error && error.name === 'ConditionalCheckFailedException');

const stringField = (item: Record<string, unknown>, field: string): string => {
  const value = item[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SavedRobotIncompatibleError('La configuración guardada tiene datos inválidos.');
  }
  return value;
};

const integerField = (item: Record<string, unknown>, field: string): number => {
  const value = item[field];
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
    throw new SavedRobotIncompatibleError('La configuración guardada tiene una versión inválida.');
  }
  return value;
};

const readSummary = (item: Record<string, unknown>): SavedRobotSummary => {
  let id: string;
  try {
    id = validateSavedRobotId(stringField(item, 'id'));
  } catch (error) {
    throw new SavedRobotIncompatibleError(
      'La configuración guardada tiene un identificador inválido.',
      { cause: error },
    );
  }
  let name: string;
  try {
    name = validateSavedRobotName(item.name);
  } catch (error) {
    throw new SavedRobotIncompatibleError('La configuración guardada tiene un nombre inválido.', {
      cause: error,
    });
  }
  const version = integerField(item, 'version');
  const createdAt = stringField(item, 'createdAt');
  const updatedAt = stringField(item, 'updatedAt');
  if (!isModelKey(item.modelKey)) {
    throw new SavedRobotIncompatibleError(
      'La configuración guardada tiene un modelo incompatible.',
    );
  }
  return { id, name, version, createdAt, updatedAt, modelKey: item.modelKey };
};

const readRobot = (item: Record<string, unknown>): SavedRobot => {
  const summary = readSummary(item);
  let draft: RobotDraft;
  try {
    draft = validateDraft(item.draft);
  } catch (error) {
    throw new SavedRobotIncompatibleError(
      'La configuración guardada tiene un borrador incompatible.',
      { cause: error },
    );
  }
  if (summary.modelKey !== draft.modelKey) {
    throw new SavedRobotIncompatibleError(
      'La configuración guardada tiene un modelo inconsistente.',
    );
  }
  return { ...summary, draft };
};

const summaryProjection = {
  ProjectionExpression: '#pk, #sk, #id, #name, #version, #createdAt, #updatedAt, #modelKey',
  ExpressionAttributeNames: {
    '#pk': 'PK',
    '#sk': 'SK',
    '#id': 'id',
    '#name': 'name',
    '#version': 'version',
    '#createdAt': 'createdAt',
    '#updatedAt': 'updatedAt',
    '#modelKey': 'modelKey',
  },
} as const;

export interface DynamoSavedRobotStoreOptions {
  readonly client?: DynamoDBClient;
  readonly tableName?: string;
  readonly now?: () => string;
}

/** Private named robot copies stored alongside the user's draft and attempts. */
export class DynamoSavedRobotStore implements SavedRobotStore {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly now: () => string;

  public constructor(options: DynamoSavedRobotStoreOptions = {}) {
    this.client = options.client ?? new DynamoDBClient({});
    this.tableName = options.tableName ?? process.env.DRAFT_TABLE_NAME ?? '';
    if (!this.tableName) throw new SavedRobotStorageError('Falta DRAFT_TABLE_NAME.');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async list(
    owner: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ robots: SavedRobotSummary[]; nextCursor?: string }> {
    const exclusiveStartKey = cursor ? this.decodeCursor(cursor, owner) : undefined;
    let response;
    try {
      response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: marshall({ ':pk': `USER#${owner}`, ':prefix': 'ROBOT#' }),
          ExclusiveStartKey: exclusiveStartKey,
          Limit: Math.min(Math.max(limit, 1), 20),
          ScanIndexForward: false,
          ConsistentRead: true,
          ...summaryProjection,
        }),
      );
    } catch (error) {
      if (error instanceof SavedRobotStorageError) throw error;
      throw new SavedRobotStorageError('No se pudieron leer las configuraciones guardadas.', {
        cause: error,
      });
    }
    try {
      const robots = (response.Items ?? []).map((item) => readSummary(unmarshall(item)));
      return {
        robots,
        ...(response.LastEvaluatedKey
          ? { nextCursor: this.encodeCursor(owner, response.LastEvaluatedKey) }
          : {}),
      };
    } catch (error) {
      if (error instanceof SavedRobotIncompatibleError) throw error;
      throw new SavedRobotStorageError('No se pudieron leer las configuraciones guardadas.', {
        cause: error,
      });
    }
  }

  public async get(owner: string, id: string): Promise<SavedRobot | undefined> {
    const robotId = validateSavedRobotId(id);
    let response;
    try {
      response = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: keyFor(owner, robotId),
          ConsistentRead: true,
        }),
      );
    } catch (error) {
      throw new SavedRobotStorageError('No se pudo leer la configuración guardada.', {
        cause: error,
      });
    }
    if (!response.Item) return undefined;
    try {
      return readRobot(unmarshall(response.Item));
    } catch (error) {
      if (error instanceof SavedRobotIncompatibleError) throw error;
      throw new SavedRobotStorageError('No se pudo leer la configuración guardada.', {
        cause: error,
      });
    }
  }

  public async put(
    owner: string,
    id: string,
    expectedVersion: number,
    name: string,
    draft: RobotDraft,
  ): Promise<SavedRobot> {
    const robotId = validateSavedRobotId(id);
    const robotName = validateSavedRobotName(name);
    let current: SavedRobot | undefined;
    if (expectedVersion > 0) current = await this.get(owner, robotId);
    const version = expectedVersion + 1;
    const updatedAt = this.now();
    const createdAt = current?.createdAt ?? updatedAt;
    const robot: SavedRobot = {
      id: robotId,
      name: robotName,
      version,
      createdAt,
      updatedAt,
      modelKey: draft.modelKey,
      draft,
    };
    const condition =
      expectedVersion === 0
        ? 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
        : 'attribute_exists(PK) AND attribute_exists(SK) AND #version = :expectedVersion';
    const item = marshall(
      {
        PK: `USER#${owner}`,
        SK: `ROBOT#${robotId}`,
        entity: 'saved-robot',
        ...robot,
      },
      { removeUndefinedValues: true },
    );
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
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
      if (isConditionalFailure(error))
        throw new SavedRobotConflictError(await this.get(owner, robotId));
      throw new SavedRobotStorageError('No se pudo guardar la configuración guardada.', {
        cause: error,
      });
    }
    return robot;
  }

  public async delete(
    owner: string,
    id: string,
    expectedVersion: number,
  ): Promise<{ deleted: true }> {
    const robotId = validateSavedRobotId(id);
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: keyFor(owner, robotId),
          ConditionExpression:
            'attribute_exists(PK) AND attribute_exists(SK) AND #version = :version',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: marshall({ ':version': expectedVersion }),
          ReturnValues: 'NONE',
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error))
        throw new SavedRobotConflictError(await this.get(owner, robotId));
      throw new SavedRobotStorageError('No se pudo eliminar la configuración guardada.', {
        cause: error,
      });
    }
    return { deleted: true };
  }

  private encodeCursor(owner: string, key: Record<string, AttributeValue>): string {
    return Buffer.from(JSON.stringify({ owner, key }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string, owner: string): Record<string, AttributeValue> {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        owner?: unknown;
        key?: Record<string, AttributeValue>;
      };
      if (parsed.owner !== owner || !parsed.key?.PK || !parsed.key.SK)
        throw new Error('invalid cursor');
      const decoded = unmarshall(parsed.key);
      if (
        decoded.PK !== `USER#${owner}` ||
        typeof decoded.SK !== 'string' ||
        !decoded.SK.startsWith('ROBOT#')
      ) {
        throw new Error('invalid cursor');
      }
      return parsed.key;
    } catch (error) {
      throw new SavedRobotCursorError(undefined, { cause: error });
    }
  }
}

export const createDynamoSavedRobotStore = (
  options: DynamoSavedRobotStoreOptions = {},
): SavedRobotStore => new DynamoSavedRobotStore(options);
