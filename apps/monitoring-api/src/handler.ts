import { ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import type {
  CognitoIdentityProviderClient,
  UserType,
} from '@aws-sdk/client-cognito-identity-provider';
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
  readonly userPoolId: string;
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
  const completedAt = clock().getTime();
  if (!Number.isFinite(completedAt)) throw new IncompleteInventoryError();

  const newUsers: MetricPeriods = {
    hours24: newUserCount(users, asOfMs, WINDOWS.hours24),
    days3: newUserCount(users, asOfMs, WINDOWS.days3),
    days7: newUserCount(users, asOfMs, WINDOWS.days7),
  };
  const rows: MonitoringUser[] = users.map((user) => ({
    id: user.id,
    email: user.email,
    registeredAt: user.createdAtMs === undefined ? 'N/A' : new Date(user.createdAtMs).toISOString(),
    lastActiveAt: 'N/A',
    bedrockCostUsd: UNKNOWN_PERIODS(),
  }));

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
    !dependencies.cognito ||
    typeof dependencies.cognito.send !== 'function'
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
