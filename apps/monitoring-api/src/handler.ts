import { ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ScanCommand } from '@aws-sdk/client-dynamodb';
import type {
  CognitoIdentityProviderClient,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { measuredCallCost } from '../../../shared/server/execution-limits.js';
import type { TokenRates } from '../../../shared/server/execution-limits.js';
import type { Usage } from '../../../shared/server/attempt.js';
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

class IncompleteScanError extends Error {
  public constructor() {
    super('El recorrido de metadatos quedó incompleto.');
    this.name = 'IncompleteScanError';
  }
}

interface AttemptMetrics {
  readonly attempts: MetricPeriods;
  readonly maxScore: MetricValue;
}

interface ScannedHeader {
  readonly ownerId: string;
  readonly attemptId: string;
  readonly createdAt: unknown;
  readonly score: unknown;
}

interface ScannedCall {
  readonly attemptId: string;
  readonly createdAt: unknown;
  readonly usage: unknown;
  readonly budget: unknown;
}

type CostMicrosByPeriod = Record<keyof MetricPeriods, bigint>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStringValue = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.S === 'string' ? value.S : undefined;

const readDynamoNumberValue = (value: unknown): number | undefined => {
  if (!isRecord(value) || typeof value.N !== 'string' || value.N.trim() === '') return undefined;
  const number = Number(value.N);
  return Number.isFinite(number) ? number : undefined;
};

const readFiniteNumberValue = (value: unknown): number | undefined => readDynamoNumberValue(value);

const readNonnegativeSafeIntegerValue = (value: unknown): number | undefined => {
  const number = readDynamoNumberValue(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};

const readFiniteNonnegativeNumberValue = (value: unknown): number | undefined => {
  const number = readDynamoNumberValue(value);
  return number !== undefined && number >= 0 ? number : undefined;
};

const readMapValue = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) && isRecord(value.M) ? value.M : undefined;

const readUsageValue = (value: unknown): Usage | undefined => {
  const usage = readMapValue(value);
  if (usage === undefined) return undefined;

  const inputTokens = readNonnegativeSafeIntegerValue(usage.inputTokens);
  const outputTokens = readNonnegativeSafeIntegerValue(usage.outputTokens);
  const cacheReadTokens = readNonnegativeSafeIntegerValue(usage.cacheReadTokens);
  const cacheWriteTokens = readNonnegativeSafeIntegerValue(usage.cacheWriteTokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: null,
    gameTokens: null,
    cacheReadTokens,
    cacheWriteTokens,
  };
};

const readRatesValue = (value: unknown): TokenRates | undefined => {
  const budget = readMapValue(value);
  const rates = readMapValue(budget?.rates);
  if (rates === undefined) return undefined;

  const input = readFiniteNonnegativeNumberValue(rates.input);
  const output = readFiniteNonnegativeNumberValue(rates.output);
  const cacheRead = readFiniteNonnegativeNumberValue(rates.cacheRead);
  const cacheWrite = readFiniteNonnegativeNumberValue(rates.cacheWrite);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }

  return { input, output, cacheRead, cacheWrite };
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
  if (!isRecord(value)) throw new IncompleteScanError();

  const keys = Object.keys(value);
  if (keys.length === 0) return undefined;
  if (keys.length !== 2 || !keys.includes('PK') || !keys.includes('SK')) {
    throw new IncompleteScanError();
  }

  const partition = readStringValue(value.PK);
  const sort = readStringValue(value.SK);
  if (partition === undefined || sort === undefined) throw new IncompleteScanError();

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

const physicalKeyFor = (partition: string, sort: string): string =>
  JSON.stringify([partition, sort]);

const scanMetadata = async (
  dependencies: MonitoringHandlerDependencies,
): Promise<{ headers: ScannedHeader[]; calls: ScannedCall[] }> => {
  const headers = new Map<string, ScannedHeader>();
  const calls = new Map<string, ScannedCall>();
  const visitedTokens = new Set<string>();
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  while (true) {
    const page = await dependencies.dynamo.send(
      new ScanCommand({
        TableName: dependencies.tableName,
        ConsistentRead: true,
        FilterExpression:
          '(begins_with(#pk, :userPrefix) AND begins_with(#sk, :attemptPrefix)) OR (begins_with(#pk, :attemptPrefix) AND begins_with(#sk, :callPrefix))',
        ProjectionExpression:
          '#pk, #sk, #createdAt, #score, #usage.#inputTokens, #usage.#outputTokens, #usage.#cacheReadTokens, #usage.#cacheWriteTokens, #budget.#rates',
        ExpressionAttributeNames: {
          '#pk': 'PK',
          '#sk': 'SK',
          '#createdAt': 'createdAt',
          '#score': 'score',
          '#usage': 'usage',
          '#inputTokens': 'inputTokens',
          '#outputTokens': 'outputTokens',
          '#cacheReadTokens': 'cacheReadTokens',
          '#cacheWriteTokens': 'cacheWriteTokens',
          '#budget': 'budget',
          '#rates': 'rates',
        },
        ExpressionAttributeValues: {
          ':userPrefix': { S: 'USER#' },
          ':attemptPrefix': { S: 'ATTEMPT#' },
          ':callPrefix': { S: 'CALL#' },
        },
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );

    if (page.Items !== undefined && !Array.isArray(page.Items)) {
      throw new IncompleteScanError();
    }

    for (const item of page.Items ?? []) {
      if (!isRecord(item)) throw new IncompleteScanError();

      const partition = readStringValue(item.PK);
      const sort = readStringValue(item.SK);
      if (partition === undefined || sort === undefined) throw new IncompleteScanError();

      if (partition.startsWith('USER#') && sort.startsWith('ATTEMPT#')) {
        const ownerId = partition.slice('USER#'.length);
        const attemptId = sort.slice('ATTEMPT#'.length);
        if (!ownerId || !attemptId) throw new IncompleteScanError();
        headers.set(physicalKeyFor(partition, sort), {
          ownerId,
          attemptId,
          createdAt: item.createdAt,
          score: item.score,
        });
      } else if (partition.startsWith('ATTEMPT#') && sort.startsWith('CALL#')) {
        const attemptId = partition.slice('ATTEMPT#'.length);
        const sequence = sort.slice('CALL#'.length);
        if (!attemptId || !sequence) throw new IncompleteScanError();
        calls.set(physicalKeyFor(partition, sort), {
          attemptId,
          createdAt: item.createdAt,
          usage: item.usage,
          budget: item.budget,
        });
      }
    }

    const nextKey = readPaginationKey(page.LastEvaluatedKey);
    if (nextKey === undefined) break;

    const token = paginationTokenFor(nextKey);
    if (visitedTokens.has(token)) throw new IncompleteScanError();
    visitedTokens.add(token);
    exclusiveStartKey = nextKey;
  }

  return { headers: [...headers.values()], calls: [...calls.values()] };
};

const attemptMetricsForHeaders = (
  headers: readonly ScannedHeader[],
  asOfMs: number,
): AttemptMetrics => {
  const counts = { hours24: 0, days3: 0, days7: 0 };
  let hasUnknownDate = false;
  let maxScore: number | undefined;

  for (const header of headers) {
    const createdAt = readStringValue(header.createdAt);
    const createdAtMs = createdAt === undefined ? undefined : timestampFromIso(createdAt);
    if (createdAtMs === undefined) {
      hasUnknownDate = true;
    } else if (createdAtMs <= asOfMs) {
      if (createdAtMs >= asOfMs - WINDOWS.hours24) counts.hours24 += 1;
      if (createdAtMs >= asOfMs - WINDOWS.days3) counts.days3 += 1;
      if (createdAtMs >= asOfMs - WINDOWS.days7) counts.days7 += 1;
    }

    const score = readFiniteNumberValue(header.score);
    if (score !== undefined) maxScore = maxScore === undefined ? score : Math.max(maxScore, score);
  }

  return {
    attempts: hasUnknownDate ? UNKNOWN_PERIODS() : counts,
    maxScore: maxScore ?? 'N/A',
  };
};

const emptyCostMicros = (): CostMicrosByPeriod => ({ hours24: 0n, days3: 0n, days7: 0n });

const addCallCost = (
  totals: CostMicrosByPeriod,
  createdAtMs: number,
  asOfMs: number,
  costMicros: number,
): void => {
  if (createdAtMs >= asOfMs - WINDOWS.hours24) totals.hours24 += BigInt(costMicros);
  if (createdAtMs >= asOfMs - WINDOWS.days3) totals.days3 += BigInt(costMicros);
  if (createdAtMs >= asOfMs - WINDOWS.days7) totals.days7 += BigInt(costMicros);
};

const usdPeriodsFromMicros = (totals: CostMicrosByPeriod): MetricPeriods => ({
  hours24: Number(totals.hours24) / 1_000_000,
  days3: Number(totals.days3) / 1_000_000,
  days7: Number(totals.days7) / 1_000_000,
});

const costPeriodsForCalls = (
  users: readonly ConfirmedUser[],
  headers: readonly ScannedHeader[],
  calls: readonly ScannedCall[],
  asOfMs: number,
): { total: MetricPeriods; byUser: Map<string, MetricPeriods> } => {
  const totalMicros = emptyCostMicros();
  const userMicros = new Map(users.map((user) => [user.id, emptyCostMicros()]));
  const ownerByAttemptId = new Map(headers.map((header) => [header.attemptId, header.ownerId]));

  for (const call of calls) {
    const createdAt = readStringValue(call.createdAt);
    const createdAtMs = createdAt === undefined ? undefined : timestampFromIso(createdAt);
    if (createdAtMs === undefined || createdAtMs > asOfMs || createdAtMs < asOfMs - WINDOWS.days7) {
      continue;
    }

    const usage = readUsageValue(call.usage);
    const rates = readRatesValue(call.budget);
    if (usage === undefined || rates === undefined) continue;

    const costMicros = measuredCallCost(usage, rates);
    if (costMicros === undefined) continue;

    addCallCost(totalMicros, createdAtMs, asOfMs, costMicros);
    const ownerId = ownerByAttemptId.get(call.attemptId);
    const ownerMicros = ownerId === undefined ? undefined : userMicros.get(ownerId);
    if (ownerMicros !== undefined) addCallCost(ownerMicros, createdAtMs, asOfMs, costMicros);
  }

  return {
    total: usdPeriodsFromMicros(totalMicros),
    byUser: new Map(
      [...userMicros].map(([userId, totals]) => [userId, usdPeriodsFromMicros(totals)]),
    ),
  };
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
  const { headers, calls } = await scanMetadata(dependencies);
  const completedAt = clock().getTime();
  if (!Number.isFinite(completedAt)) throw new IncompleteInventoryError();

  const headersByOwner = new Map<string, ScannedHeader[]>();
  for (const header of headers) {
    const ownerHeaders = headersByOwner.get(header.ownerId) ?? [];
    ownerHeaders.push(header);
    headersByOwner.set(header.ownerId, ownerHeaders);
  }
  const attemptsByUser = new Map(
    users.map((user) => [
      user.id,
      attemptMetricsForHeaders(headersByOwner.get(user.id) ?? [], asOfMs),
    ]),
  );
  const costs = costPeriodsForCalls(users, headers, calls, asOfMs);

  const newUsers: MetricPeriods = {
    hours24: newUserCount(users, asOfMs, WINDOWS.hours24),
    days3: newUserCount(users, asOfMs, WINDOWS.days3),
    days7: newUserCount(users, asOfMs, WINDOWS.days7),
  };
  const rows: MonitoringUser[] = users.map((user) => {
    const attempts = attemptsByUser.get(user.id);
    if (attempts === undefined) throw new IncompleteScanError();
    const bedrockCostUsd = costs.byUser.get(user.id);
    if (bedrockCostUsd === undefined) throw new IncompleteScanError();

    return {
      id: user.id,
      email: user.email,
      registeredAt:
        user.createdAtMs === undefined ? 'N/A' : new Date(user.createdAtMs).toISOString(),
      lastActiveAt: 'N/A',
      attempts: attempts.attempts,
      bedrockCostUsd,
      maxScore: attempts.maxScore,
    };
  });

  return {
    asOf: asOfDate.toISOString(),
    generatedAt: new Date(Math.max(asOfMs, completedAt)).toISOString(),
    registeredUsers: users.length,
    newUsers,
    activeUsers: UNKNOWN_PERIODS(),
    bedrockCostUsd: costs.total,
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
