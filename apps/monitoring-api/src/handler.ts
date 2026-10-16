import { ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { QueryCommand } from '@aws-sdk/client-dynamodb';
import type {
  CognitoIdentityProviderClient,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type {
  MetricPeriods,
  MetricValue,
  MonitoringSnapshot,
  MonitoringUser,
} from '../../../shared/monitoring.js';

const PAGE_SIZE = 60;
const WINDOWS = {
  hours24: 24 * 60 * 60 * 1_000,
  days3: 72 * 60 * 60 * 1_000,
  days7: 168 * 60 * 60 * 1_000,
} as const;
const UNKNOWN_PERIODS = (): MetricPeriods => ({
  hours24: 'N/A',
  days3: 'N/A',
  days7: 'N/A',
});

export interface MonitoringHandlerDependencies {
  readonly cognito: Pick<CognitoIdentityProviderClient, 'send'>;
  readonly dynamo: Pick<DynamoDBClient, 'send'>;
  readonly userPoolId: string;
  readonly tableName: string;
  readonly now?: () => Date;
}

interface ConfirmedUser {
  readonly id: string;
  email: string;
  createdAtMs?: number;
}

class IncompleteInventoryError extends Error {
  public constructor() {
    super('La consulta del inventario de Cognito quedó incompleta.');
    this.name = 'IncompleteInventoryError';
  }
}

class IncompleteAttemptsError extends Error {
  public constructor() {
    super('La consulta del historial de intentos quedó incompleta.');
    this.name = 'IncompleteAttemptsError';
  }
}

interface AttemptMetrics {
  readonly attempts: MetricPeriods;
  readonly maxScore: MetricValue;
}

const MAX_CONCURRENT_OWNER_QUERIES = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStringValue = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.S === 'string' ? value.S : undefined;

const readFiniteNumberValue = (value: unknown): number | undefined => {
  if (!isRecord(value) || typeof value.N !== 'string' || value.N.trim() === '') return undefined;
  const number = Number(value.N);
  return Number.isFinite(number) ? number : undefined;
};

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-](\d{2}):(\d{2}))$/u;

const timestampFromIso = (value: string): number | undefined => {
  const parts = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!parts) return undefined;

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = parts[8] === undefined ? 0 : Number(parts[8]);
  const offsetMinute = parts[9] === undefined ? 0 : Number(parts[9]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) return undefined;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const readPaginationKey = (value: unknown): Record<string, AttributeValue> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new IncompleteAttemptsError();

  const keys = Object.keys(value);
  if (keys.length === 0) return undefined;
  if (keys.length !== 2 || !keys.includes('PK') || !keys.includes('SK')) {
    throw new IncompleteAttemptsError();
  }

  const partition = readStringValue(value.PK);
  const sort = readStringValue(value.SK);
  if (partition === undefined || sort === undefined) throw new IncompleteAttemptsError();

  return { PK: { S: partition }, SK: { S: sort } };
};

const paginationTokenFor = (key: Record<string, AttributeValue>): string =>
  JSON.stringify(Object.entries(key).sort(([left], [right]) => left.localeCompare(right)));

const jsonResponse = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

const attributesFor = (user: UserType): Map<string, string> => {
  if (user.Attributes !== undefined && !Array.isArray(user.Attributes)) {
    throw new IncompleteInventoryError();
  }

  const attributes = new Map<string, string>();
  for (const attribute of user.Attributes ?? []) {
    if (attribute && typeof attribute.Name === 'string' && typeof attribute.Value === 'string') {
      attributes.set(attribute.Name, attribute.Value);
    }
  }
  return attributes;
};

const createTimestamp = (user: UserType): number | undefined => {
  if (!(user.UserCreateDate instanceof Date)) return undefined;
  const timestamp = user.UserCreateDate.getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const confirmedUsers = async (
  cognito: MonitoringHandlerDependencies['cognito'],
  userPoolId: string,
): Promise<ConfirmedUser[]> => {
  const usersBySub = new Map<string, ConfirmedUser>();
  const visitedTokens = new Set<string>();
  let paginationToken: string | undefined;

  do {
    const page = await cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: PAGE_SIZE,
        ...(paginationToken === undefined ? {} : { PaginationToken: paginationToken }),
      }),
    );
    if (page.Users !== undefined && !Array.isArray(page.Users)) {
      throw new IncompleteInventoryError();
    }

    for (const user of page.Users ?? []) {
      if (!user || typeof user !== 'object') throw new IncompleteInventoryError();
      const attributes = attributesFor(user);
      if (attributes.get('email_verified') !== 'true') continue;

      const id = attributes.get('sub')?.trim();
      if (!id) throw new IncompleteInventoryError();

      const sourceEmail = attributes.get('email')?.trim();
      const email = sourceEmail || 'N/A';
      const createdAtMs = createTimestamp(user);
      const existing = usersBySub.get(id);
      if (!existing) {
        usersBySub.set(id, { id, email, ...(createdAtMs === undefined ? {} : { createdAtMs }) });
      } else {
        if (existing.email === 'N/A' && email !== 'N/A') existing.email = email;
        if (existing.createdAtMs === undefined && createdAtMs !== undefined) {
          existing.createdAtMs = createdAtMs;
        }
      }
    }

    const nextToken: unknown = page.PaginationToken;
    if (nextToken === undefined) {
      paginationToken = undefined;
    } else {
      if (typeof nextToken !== 'string' || nextToken.length === 0) {
        throw new IncompleteInventoryError();
      }
      if (visitedTokens.has(nextToken)) throw new IncompleteInventoryError();
      visitedTokens.add(nextToken);
      paginationToken = nextToken;
    }
  } while (paginationToken !== undefined);

  return [...usersBySub.values()];
};

const attemptMetricsForUser = async (
  userId: string,
  dependencies: MonitoringHandlerDependencies,
  asOfMs: number,
): Promise<AttemptMetrics> => {
  const counts = { hours24: 0, days3: 0, days7: 0 };
  const visitedTokens = new Set<string>();
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  let hasUnknownDate = false;
  let maxScore: number | undefined;

  while (true) {
    const page = await dependencies.dynamo.send(
      new QueryCommand({
        TableName: dependencies.tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: {
          '#pk': 'PK',
          '#sk': 'SK',
          '#createdAt': 'createdAt',
          '#score': 'score',
        },
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${userId}` },
          ':prefix': { S: 'ATTEMPT#' },
        },
        ConsistentRead: true,
        ProjectionExpression: '#pk, #sk, #createdAt, #score',
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );

    if (page.Items !== undefined && !Array.isArray(page.Items)) {
      throw new IncompleteAttemptsError();
    }

    for (const item of page.Items ?? []) {
      if (!isRecord(item)) throw new IncompleteAttemptsError();

      const createdAt = readStringValue(item.createdAt);
      const createdAtMs = createdAt === undefined ? undefined : timestampFromIso(createdAt);
      if (createdAtMs === undefined) {
        hasUnknownDate = true;
      } else if (createdAtMs <= asOfMs) {
        if (createdAtMs >= asOfMs - WINDOWS.hours24) counts.hours24 += 1;
        if (createdAtMs >= asOfMs - WINDOWS.days3) counts.days3 += 1;
        if (createdAtMs >= asOfMs - WINDOWS.days7) counts.days7 += 1;
      }

      const score = readFiniteNumberValue(item.score);
      if (score !== undefined)
        maxScore = maxScore === undefined ? score : Math.max(maxScore, score);
    }

    const nextKey = readPaginationKey(page.LastEvaluatedKey);
    if (nextKey === undefined) break;

    const token = paginationTokenFor(nextKey);
    if (visitedTokens.has(token)) throw new IncompleteAttemptsError();
    visitedTokens.add(token);
    exclusiveStartKey = nextKey;
  }

  return {
    attempts: hasUnknownDate ? UNKNOWN_PERIODS() : counts,
    maxScore: maxScore ?? 'N/A',
  };
};

const attemptMetricsForUsers = async (
  users: readonly ConfirmedUser[],
  dependencies: MonitoringHandlerDependencies,
  asOfMs: number,
): Promise<Map<string, AttemptMetrics>> => {
  const metrics = new Map<string, AttemptMetrics>();
  let nextIndex = 0;
  let hasFailed = false;
  let failure: unknown;

  const worker = async (): Promise<void> => {
    while (!hasFailed) {
      const index = nextIndex;
      nextIndex += 1;
      const user = users[index];
      if (user === undefined) return;

      try {
        metrics.set(user.id, await attemptMetricsForUser(user.id, dependencies, asOfMs));
      } catch (error) {
        if (!hasFailed) failure = error;
        hasFailed = true;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_OWNER_QUERIES, users.length) }, () => worker()),
  );
  if (hasFailed) throw failure ?? new IncompleteAttemptsError();
  return metrics;
};

const newUserCount = (
  users: readonly ConfirmedUser[],
  asOfMs: number,
  windowMs: number,
): MetricValue => {
  if (users.some((user) => user.createdAtMs === undefined)) return 'N/A';

  return users.reduce((count, user) => {
    const createdAtMs = user.createdAtMs;
    return createdAtMs !== undefined && createdAtMs <= asOfMs && createdAtMs >= asOfMs - windowMs
      ? count + 1
      : count;
  }, 0);
};

const snapshotFor = async (
  dependencies: MonitoringHandlerDependencies,
): Promise<MonitoringSnapshot> => {
  const clock = dependencies.now ?? (() => new Date());
  const asOfDate = clock();
  const asOfMs = asOfDate.getTime();
  if (!Number.isFinite(asOfMs)) throw new IncompleteInventoryError();

  const users = await confirmedUsers(dependencies.cognito, dependencies.userPoolId);
  const attemptsByUser = await attemptMetricsForUsers(users, dependencies, asOfMs);
  const completedAt = clock().getTime();
  if (!Number.isFinite(completedAt)) throw new IncompleteInventoryError();

  const newUsers: MetricPeriods = {
    hours24: newUserCount(users, asOfMs, WINDOWS.hours24),
    days3: newUserCount(users, asOfMs, WINDOWS.days3),
    days7: newUserCount(users, asOfMs, WINDOWS.days7),
  };
  const rows: MonitoringUser[] = users.map((user) => {
    const attempts = attemptsByUser.get(user.id);
    if (attempts === undefined) throw new IncompleteAttemptsError();

    return {
      id: user.id,
      email: user.email,
      registeredAt:
        user.createdAtMs === undefined ? 'N/A' : new Date(user.createdAtMs).toISOString(),
      lastActiveAt: 'N/A',
      attempts: attempts.attempts,
      bedrockCostUsd: UNKNOWN_PERIODS(),
      maxScore: attempts.maxScore,
    };
  });

  return {
    asOf: asOfDate.toISOString(),
    generatedAt: new Date(Math.max(asOfMs, completedAt)).toISOString(),
    registeredUsers: users.length,
    newUsers,
    activeUsers: UNKNOWN_PERIODS(),
    bedrockCostUsd: UNKNOWN_PERIODS(),
    users: rows,
  };
};

export const handleRequest = async (
  event: APIGatewayProxyEventV2,
  dependencies: MonitoringHandlerDependencies,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext?.http?.method?.toUpperCase();
  if (method !== 'GET') {
    return jsonResponse(405, { code: 'method_not_allowed', message: 'Método no permitido.' });
  }

  const path = event.rawPath || event.requestContext?.http?.path;
  if (path !== '/api/metrics') {
    return jsonResponse(404, { code: 'not_found', message: 'Ruta no encontrada.' });
  }

  if (
    typeof dependencies?.userPoolId !== 'string' ||
    dependencies.userPoolId.trim() === '' ||
    typeof dependencies?.tableName !== 'string' ||
    dependencies.tableName.trim() === '' ||
    !dependencies.cognito ||
    typeof dependencies.cognito.send !== 'function' ||
    !dependencies.dynamo ||
    typeof dependencies.dynamo.send !== 'function'
  ) {
    return jsonResponse(500, {
      code: 'configuration_error',
      message: 'El servicio de métricas no está configurado.',
    });
  }

  try {
    return jsonResponse(200, await snapshotFor(dependencies));
  } catch {
    return jsonResponse(503, {
      code: 'metrics_unavailable',
      message: 'No se pudieron consultar las métricas.',
    });
  }
};
