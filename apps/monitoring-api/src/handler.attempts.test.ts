import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from './handler.js';

const poolId = 'us-east-1_example';
const tableName = 'runner-draft-table';
const cutoff = new Date('2026-10-15T12:00:00.000Z');

type AttributeValue = {
  S?: string;
  N?: string;
  NULL?: boolean;
  [key: string]: unknown;
};
type Item = Record<string, AttributeValue>;
type QueryPage = { Items?: Item[]; LastEvaluatedKey?: Item };
type QueryCommandLike = { constructor: { name: string }; input: Record<string, unknown> };
type ListUsersCommandLike = {
  input: { UserPoolId?: string; PaginationToken?: string };
};
type UserPage = {
  Users?: Array<{
    Username: string;
    Enabled?: boolean;
    UserCreateDate?: Date;
    Attributes?: Array<{ Name?: string; Value?: string }>;
  }>;
  PaginationToken?: string;
};

const user = (
  sub: string,
  email: string,
  createdAt: string,
  enabled = true,
  emailVerified = 'true',
) => ({
  Username: sub,
  Enabled: enabled,
  UserCreateDate: new Date(createdAt),
  Attributes: [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: email },
    { Name: 'email_verified', Value: emailVerified },
  ],
});

const eventFor = (): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'GET /api/metrics',
    rawPath: '/api/metrics',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'monitoring',
      domainName: 'monitoring.example.test',
      domainPrefix: 'monitoring',
      http: {
        method: 'GET',
        path: '/api/metrics',
        protocol: 'https',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-attempts',
      routeKey: 'GET /api/metrics',
      stage: '$default',
      time: '15/Oct/2026:12:00:00 +0000',
      timeEpoch: cutoff.getTime(),
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const periods = (value: number | 'N/A') => ({ hours24: value, days3: value, days7: value });

const attrS = (value: string): AttributeValue => ({ S: value });
const attrN = (value: number): AttributeValue => ({ N: String(value) });

const attempt = (
  owner: string,
  id: string,
  options: { createdAt?: string; score?: AttributeValue; status?: string } = {},
): Item => ({
  PK: attrS(`USER#${owner}`),
  SK: attrS(`ATTEMPT#${id}`),
  ...(options.createdAt === undefined ? {} : { createdAt: attrS(options.createdAt) }),
  ...(options.score === undefined ? {} : { score: options.score }),
  status: attrS(options.status ?? 'admitted'),
  version: attrN(999),
  levelId: attrS('retired-level'),
  privateBody: attrS('private-attempt-body'),
});

const key = (owner: string, sortKey: string): Item => ({
  PK: attrS(`USER#${owner}`),
  SK: attrS(sortKey),
});

const makeDependencies = (
  cognitoSend: (command: ListUsersCommandLike) => Promise<UserPage>,
  dynamoSend: (command: QueryCommandLike) => Promise<QueryPage>,
  now = vi.fn(() => new Date(cutoff)),
) =>
  ({
    cognito: { send: cognitoSend },
    dynamo: { send: dynamoSend },
    userPoolId: poolId,
    tableName,
    now,
  }) as unknown as Parameters<typeof handleRequest>[1];

const ownerFrom = (command: QueryCommandLike): string => {
  const values = command.input.ExpressionAttributeValues as Record<string, AttributeValue>;
  const partition = Object.values(values ?? {}).find(
    (value) => typeof value.S === 'string' && value.S.startsWith('USER#'),
  )?.S;
  if (!partition) throw new Error('La consulta no incluye un propietario USER#.');
  return partition.slice('USER#'.length);
};

const startKeyFrom = (command: QueryCommandLike): string | undefined =>
  (command.input.ExclusiveStartKey as Item | undefined)?.SK?.S;

const resolvedProjection = (command: QueryCommandLike): string[] => {
  const aliases = (command.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  const projection = String(command.input.ProjectionExpression ?? '');
  return projection
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => aliases[part] ?? part);
};

const resolvedKeyCondition = (command: QueryCommandLike): string => {
  const aliases = (command.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  return String(command.input.KeyConditionExpression ?? '').replace(
    /#[\w]+/gu,
    (alias) => aliases[alias] ?? alias,
  );
};

describe('monitoring attempts metrics', () => {
  it('queries every verified owner, paginates through empty pages, and counts all headers on UTC boundaries', async () => {
    const cognitoSend = vi.fn(async ({ input }: ListUsersCommandLike): Promise<UserPage> => {
      if (input.PaginationToken === undefined) {
        return {
          Users: [
            user('owner-a', 'a@example.com', '2026-10-01T00:00:00.000Z', false),
            user('owner-b', 'b@example.com', '2026-10-02T00:00:00.000Z', false),
            user('owner-c', 'c@example.com', '2026-10-03T00:00:00.000Z'),
            user('owner-d', 'd@example.com', '2026-10-04T00:00:00.000Z'),
            user('hidden', 'hidden@example.com', '2026-10-05T00:00:00.000Z', true, 'false'),
          ],
          PaginationToken: 'users-next',
        };
      }
      return { Users: [user('owner-a', 'duplicate@example.com', '2026-10-01T00:00:00.000Z')] };
    });

    const dynamoSend = vi.fn(async (command: QueryCommandLike): Promise<QueryPage> => {
      const owner = ownerFrom(command);
      const startKey = startKeyFrom(command);
      if (owner === 'owner-a') {
        if (startKey === undefined) {
          return {
            Items: [
              attempt('owner-a', 'at-24h', {
                createdAt: new Date(cutoff.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
                score: attrN(-3),
                status: 'error',
              }),
              attempt('owner-a', 'inside-24h', {
                createdAt: new Date(cutoff.getTime() - 24 * 60 * 60 * 1_000 + 1).toISOString(),
                score: attrN(-5),
              }),
              attempt('owner-a', 'outside-24h', {
                createdAt: new Date(cutoff.getTime() - 24 * 60 * 60 * 1_000 - 1).toISOString(),
                score: attrN(-6),
              }),
            ],
            LastEvaluatedKey: key('owner-a', 'ATTEMPT#cursor-1'),
          };
        }
        if (startKey === 'ATTEMPT#cursor-1') {
          return {
            Items: [],
            LastEvaluatedKey: key('owner-a', 'ATTEMPT#cursor-2'),
          };
        }
        if (startKey === 'ATTEMPT#cursor-2') {
          return {
            Items: [
              attempt('owner-a', 'at-72h', {
                createdAt: new Date(cutoff.getTime() - 72 * 60 * 60 * 1_000).toISOString(),
                score: attrN(0),
                status: 'cancelled',
              }),
              attempt('owner-a', 'outside-72h', {
                createdAt: new Date(cutoff.getTime() - 72 * 60 * 60 * 1_000 - 1).toISOString(),
                score: attrN(-8),
              }),
              attempt('owner-a', 'at-168h', {
                createdAt: new Date(cutoff.getTime() - 168 * 60 * 60 * 1_000).toISOString(),
                score: attrN(-9),
              }),
              attempt('owner-a', 'outside-168h', {
                createdAt: new Date(cutoff.getTime() - 168 * 60 * 60 * 1_000 - 1).toISOString(),
                score: attrN(700),
              }),
              attempt('owner-a', 'at-cut-offset', {
                createdAt: '2026-10-15T08:00:00.000-04:00',
                score: attrN(-1),
              }),
              attempt('owner-a', 'future', {
                createdAt: new Date(cutoff.getTime() + 1).toISOString(),
                score: attrN(-100),
              }),
              attempt('owner-a', 'old-score', {
                createdAt: '2026-09-01T00:00:00.000Z',
                score: attrN(800),
              }),
            ],
          };
        }
        throw new Error(`Cursor de prueba inesperado: ${startKey}`);
      }
      if (owner === 'owner-b') return { Items: [] };
      if (owner === 'owner-c') {
        return {
          Items: [
            attempt('owner-c', 'missing-date', { score: attrN(0) }),
            attempt('owner-c', 'invalid-date', { createdAt: 'not-a-date', score: attrN(-5) }),
            attempt('owner-c', 'string-score', {
              createdAt: '2026-10-15T11:00:00.000Z',
              score: attrS('9999'),
            }),
            attempt('owner-c', 'null-score', {
              createdAt: '2026-10-15T10:00:00.000Z',
              score: { NULL: true },
            }),
            attempt('owner-c', 'absent-score', {
              createdAt: '2026-10-15T09:00:00.000Z',
            }),
          ],
        };
      }
      if (owner === 'owner-d') {
        return {
          Items: [
            attempt('owner-d', 'negative-1', {
              createdAt: '2026-10-15T10:00:00.000Z',
              score: attrN(-9),
            }),
            attempt('owner-d', 'negative-2', {
              createdAt: '2026-10-15T11:00:00.000Z',
              score: attrN(-2),
            }),
          ],
        };
      }
      throw new Error(`Se intentó consultar un propietario ajeno: ${owner}`);
    });

    const response = await handleRequest(eventFor(), makeDependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    const body = responseBody(response);
    const rows = body.users as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    expect(rowById.get('owner-a')).toMatchObject({
      attempts: { hours24: 3, days3: 5, days7: 7 },
      maxScore: 800,
    });
    expect(rowById.get('owner-b')).toMatchObject({ attempts: periods(0), maxScore: 'N/A' });
    expect(rowById.get('owner-c')).toMatchObject({ attempts: periods('N/A'), maxScore: 0 });
    expect(rowById.get('owner-d')).toMatchObject({ attempts: periods(2), maxScore: -2 });

    expect(cognitoSend).toHaveBeenCalledTimes(2);
    const queries = dynamoSend.mock.calls.map(([command]) => command);
    expect(queries).toHaveLength(6);
    expect(queries.map(ownerFrom).sort()).toEqual([
      'owner-a',
      'owner-a',
      'owner-a',
      'owner-b',
      'owner-c',
      'owner-d',
    ]);
    for (const query of queries) {
      expect(query.constructor.name).toBe('QueryCommand');
      expect(query.input.TableName).toBe(tableName);
      expect(query.input.ConsistentRead).toBe(true);
      expect(query.input.FilterExpression).toBeUndefined();
      expect(resolvedKeyCondition(query)).toMatch(/\bPK\s*=\s*:/u);
      expect(resolvedKeyCondition(query)).toMatch(/begins_with\s*\(\s*SK\b/u);
      expect(
        Object.values(query.input.ExpressionAttributeValues as Record<string, AttributeValue>),
      ).toContainEqual(attrS('ATTEMPT#'));
      expect(new Set(resolvedProjection(query))).toEqual(
        new Set(['PK', 'SK', 'createdAt', 'score']),
      );
    }
    const pageThree = queries.find(
      (query) => ownerFrom(query) === 'owner-a' && startKeyFrom(query) === 'ATTEMPT#cursor-2',
    );
    expect(pageThree).toBeDefined();
    expect(
      queries.some(
        (query) => ownerFrom(query) === 'owner-a' && startKeyFrom(query) === 'ATTEMPT#cursor-1',
      ),
    ).toBe(true);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('hidden@example.com');
    expect(serialized).not.toContain('USER#');
    expect(serialized).not.toContain('ATTEMPT#');
    expect(serialized).not.toContain('private-attempt-body');
  });

  it('keeps counts numeric but maxScore N/A when no numeric score exists, and treats an empty LastEvaluatedKey as final', async () => {
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({
      Users: [user('unscored-owner', 'unscored@example.com', '2026-10-01T00:00:00.000Z')],
    }));
    const dynamoSend = vi.fn(async (): Promise<QueryPage> => ({
      Items: [
        attempt('unscored-owner', 'string-score', {
          createdAt: '2026-10-15T11:00:00.000Z',
          score: attrS('9999'),
        }),
        attempt('unscored-owner', 'null-score', {
          createdAt: '2026-10-15T10:00:00.000Z',
          score: { NULL: true },
        }),
        attempt('unscored-owner', 'absent-score', {
          createdAt: '2026-10-15T09:00:00.000Z',
        }),
      ],
      LastEvaluatedKey: {},
    }));

    const response = await handleRequest(eventFor(), makeDependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    const row = (responseBody(response).users as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ attempts: periods(3), maxScore: 'N/A' });
    expect(dynamoSend).toHaveBeenCalledTimes(1);
  });

  it('uses one cutoff before reads and stamps generatedAt after the final query completes', async () => {
    const finishedAt = new Date(cutoff.getTime() + 2 * 60 * 60 * 1_000);
    const order: string[] = [];
    let currentTime = new Date(cutoff);
    const now = vi.fn(() => {
      order.push('clock');
      return new Date(currentTime);
    });
    const cognitoSend = vi.fn(async (): Promise<UserPage> => {
      order.push('cognito');
      return {
        Users: [
          user('fast-owner', 'fast@example.com', '2026-10-01T00:00:00.000Z'),
          user('slow-owner', 'slow@example.com', '2026-10-02T00:00:00.000Z'),
        ],
      };
    });

    let slowQueryStarted!: () => void;
    let finishQuery!: (page: QueryPage) => void;
    const slowQuerySignal = new Promise<void>((resolve) => {
      slowQueryStarted = resolve;
    });
    const slowQueryResult = new Promise<QueryPage>((resolve) => {
      finishQuery = resolve;
    });
    const dynamoSend = vi.fn((command: QueryCommandLike) => {
      const owner = ownerFrom(command);
      order.push(`query:${owner}`);
      if (owner === 'slow-owner') {
        slowQueryStarted();
        return slowQueryResult;
      }
      return Promise.resolve({
        Items: [
          attempt('fast-owner', 'after-cutoff', {
            createdAt: new Date(cutoff.getTime() + 30 * 60 * 1_000).toISOString(),
            score: attrN(5),
          }),
        ],
      });
    });

    const request = handleRequest(eventFor(), makeDependencies(cognitoSend, dynamoSend, now));
    let queryWaitTimer: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      slowQuerySignal.then(() => 'query-started'),
      request.then(() => 'request-finished-before-query'),
      new Promise<'query-start-timeout'>((resolve) => {
        queryWaitTimer = setTimeout(() => resolve('query-start-timeout'), 1_000);
      }),
    ]);
    if (queryWaitTimer !== undefined) clearTimeout(queryWaitTimer);
    expect(started).toBe('query-started');
    const firstClockIndex = order.indexOf('clock');
    expect(firstClockIndex).toBeGreaterThanOrEqual(0);
    expect(firstClockIndex).toBeLessThan(order.indexOf('cognito'));
    const pendingResult = await Promise.race([
      request.then(() => 'finished'),
      new Promise<'still-reading'>((resolve) => setImmediate(() => resolve('still-reading'))),
    ]);
    expect(pendingResult).toBe('still-reading');

    currentTime = new Date(finishedAt);
    finishQuery({
      Items: [
        attempt('slow-owner', 'after-cutoff', {
          createdAt: new Date(cutoff.getTime() + 60 * 60 * 1_000).toISOString(),
          score: attrN(5),
        }),
      ],
    });
    const response = await request;

    expect(response.statusCode).toBe(200);
    expect(dynamoSend).toHaveBeenCalledTimes(2);
    expect(order).toContain('query:fast-owner');
    const lastQueryIndex = Math.max(
      order.lastIndexOf('query:fast-owner'),
      order.lastIndexOf('query:slow-owner'),
    );
    expect(order.lastIndexOf('clock')).toBeGreaterThan(lastQueryIndex);
    const body = responseBody(response);
    expect(body).toMatchObject({
      asOf: cutoff.toISOString(),
      generatedAt: finishedAt.toISOString(),
    });
    const slowRow = (body.users as Array<Record<string, unknown>>).find(
      (row) => row.id === 'slow-owner',
    );
    const fastRow = (body.users as Array<Record<string, unknown>>).find(
      (row) => row.id === 'fast-owner',
    );
    expect(slowRow?.attempts).toEqual(periods(0));
    expect(fastRow?.attempts).toEqual(periods(0));
  });

  it('reads attempt rows again on the next request instead of reusing a previous result', async () => {
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({
      Users: [user('owner', 'owner@example.com', '2026-10-01T00:00:00.000Z')],
    }));
    const dynamoSend = vi
      .fn<(command: QueryCommandLike) => Promise<QueryPage>>()
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [
          attempt('owner', 'new-attempt', {
            createdAt: '2026-10-15T11:00:00.000Z',
            score: attrN(12),
          }),
        ],
      });
    const dependencies = makeDependencies(cognitoSend, dynamoSend);

    const first = await handleRequest(eventFor(), dependencies);
    const second = await handleRequest(eventFor(), dependencies);

    const firstRow = (responseBody(first).users as Array<Record<string, unknown>>)[0];
    const secondRow = (responseBody(second).users as Array<Record<string, unknown>>)[0];
    expect(firstRow.attempts).toEqual(periods(0));
    expect(firstRow.maxScore).toBe('N/A');
    expect(secondRow.attempts).toEqual(periods(1));
    expect(secondRow.maxScore).toBe(12);
    expect(dynamoSend).toHaveBeenCalledTimes(2);
    expect(cognitoSend).toHaveBeenCalledTimes(2);
  });

  it.each(['later-page-failure', 'repeated-key'] as const)(
    'returns a controlled failure without partial or private data when pagination has %s',
    async (failureMode) => {
      const cognitoSend = vi.fn(async (): Promise<UserPage> => ({
        Users: [user('private-owner', 'private@example.com', '2026-10-01T00:00:00.000Z')],
      }));
      const repeatedKey = key('private-owner', 'ATTEMPT#same-page');
      const dynamoSend = vi.fn(async (command: QueryCommandLike): Promise<QueryPage> => {
        if (startKeyFrom(command) === undefined) {
          return {
            Items: [
              attempt('private-owner', 'partial', {
                createdAt: '2026-10-15T11:00:00.000Z',
                score: attrN(8),
              }),
            ],
            LastEvaluatedKey: repeatedKey,
          };
        }
        if (failureMode === 'later-page-failure') {
          throw new Error('upstream error containing private@example.com');
        }
        if (dynamoSend.mock.calls.length >= 3) {
          throw new Error('pagination repeated without stopping');
        }
        return { Items: [], LastEvaluatedKey: repeatedKey };
      });

      const response = await handleRequest(eventFor(), makeDependencies(cognitoSend, dynamoSend));

      expect(response.statusCode).toBe(503);
      const serialized = JSON.stringify(responseBody(response));
      expect(serialized).not.toContain('registeredUsers');
      expect(serialized).not.toContain('users');
      expect(serialized).not.toContain('private@example.com');
      expect(serialized).not.toContain('USER#');
      expect(serialized).not.toContain('ATTEMPT#');
      expect(serialized).not.toContain('upstream error');
      expect(serialized).not.toContain('pagination repeated');
      if (failureMode === 'repeated-key') expect(dynamoSend).toHaveBeenCalledTimes(2);
    },
  );
});
