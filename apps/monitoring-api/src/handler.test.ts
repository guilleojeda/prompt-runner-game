import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from './handler.js';

const poolId = 'us-east-1_example';
const cutoff = new Date('2026-10-15T12:00:00.000Z');

type CognitoUser = {
  Username: string;
  Enabled?: boolean;
  UserCreateDate?: Date;
  Attributes?: Array<{ Name?: string; Value?: string }>;
};

type UserPage = { Users?: CognitoUser[]; PaginationToken?: string };
type ListUsersCommandLike = {
  input: { UserPoolId?: string; PaginationToken?: string };
};
type DynamoAttributeValue = {
  S?: string;
  N?: string;
  NULL?: boolean;
  [key: string]: unknown;
};
type DynamoItem = Record<string, DynamoAttributeValue>;
type QueryPage = { Items?: DynamoItem[]; LastEvaluatedKey?: DynamoItem };
type QueryCommandLike = { input: Record<string, unknown> };

const user = (
  sub: string,
  email: string,
  emailVerified: string,
  createdAt?: string,
  enabled = true,
): CognitoUser => ({
  Username: sub,
  Enabled: enabled,
  ...(createdAt ? { UserCreateDate: new Date(createdAt) } : {}),
  Attributes: [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: email },
    { Name: 'email_verified', Value: emailVerified },
  ],
});

const eventFor = (method = 'GET', path = '/api/metrics'): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'monitoring',
      domainName: 'monitoring.example.test',
      domainPrefix: 'monitoring',
      http: { method, path, protocol: 'https', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: 'request-1',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: '15/Oct/2026:12:00:00 +0000',
      timeEpoch: cutoff.getTime(),
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const responseHeader = (
  response: { headers?: Record<string, string | number | boolean> },
  name: string,
): string => {
  const value = Object.entries(response.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return value === undefined ? '' : String(value);
};

const periodValues = (value: number | 'N/A') => ({ hours24: value, days3: value, days7: value });

const dependencies = (
  send: (command: ListUsersCommandLike) => Promise<UserPage>,
  now = vi.fn(() => new Date(cutoff)),
  dynamoSend: (command: QueryCommandLike) => Promise<QueryPage> = vi.fn(async () => ({
    Items: [],
  })),
) =>
  ({
    cognito: { send },
    dynamo: { send: dynamoSend },
    userPoolId: poolId,
    tableName: 'runner-draft-table',
    now,
  }) as unknown as Parameters<typeof handleRequest>[1];

describe('monitoring metrics handler', () => {
  it('paginates the verified Cognito inventory, deduplicates by sub, and counts inclusive UTC windows', async () => {
    const send = vi.fn(async ({ input }: ListUsersCommandLike): Promise<UserPage> => {
      if (input.PaginationToken === undefined) {
        return {
          Users: [
            user('at-24h', 'at-24h@example.com', 'true', '2026-10-14T12:00:00.000Z', false),
            user('at-72h', 'at-72h@example.com', 'true', '2026-10-12T12:00:00.000Z'),
            user('at-168h', 'at-168h@example.com', 'true', '2026-10-08T12:00:00.000Z'),
            user('too-old', 'too-old@example.com', 'true', '2026-10-08T11:59:59.999Z'),
            user('future', 'future@example.com', 'true', '2026-10-15T12:00:00.001Z'),
            user('unverified', 'unverified@example.com', 'false', '2026-10-15T11:00:00.000Z'),
            {
              ...user('missing-verification', 'missing-verification@example.com', 'true'),
              Attributes: [
                { Name: 'sub', Value: 'missing-verification' },
                { Name: 'email', Value: 'missing-verification@example.com' },
              ],
            },
          ],
          PaginationToken: 'next-page',
        };
      }
      return {
        Users: [
          user('at-24h', 'different-email@example.com', 'true', '2026-10-14T12:00:00.000Z'),
          user('also-verified', 'also-verified@example.com', 'true', '2026-10-15T11:00:00.000Z'),
        ],
      };
    });
    const now = vi.fn(() => new Date(cutoff));

    const response = await handleRequest(eventFor(), dependencies(send, now));

    expect(response.statusCode).toBe(200);
    const body = responseBody(response);
    expect(body.registeredUsers).toBe(6);
    expect(body.newUsers).toEqual({ hours24: 2, days3: 3, days7: 4 });
    expect(body.activeUsers).toEqual(periodValues('N/A'));
    expect(body.bedrockCostUsd).toEqual(periodValues('N/A'));
    expect(body.asOf).toBe(cutoff.toISOString());
    const generatedAt = Date.parse(String(body.generatedAt));
    expect(Number.isFinite(generatedAt)).toBe(true);
    expect(generatedAt).toBeGreaterThanOrEqual(cutoff.getTime());
    expect(responseHeader(response, 'content-type')).toMatch(/application\/json/i);
    expect(responseHeader(response, 'cache-control')).toContain('no-store');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ input: expect.objectContaining({ UserPoolId: poolId }) }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        input: expect.objectContaining({ UserPoolId: poolId, PaginationToken: 'next-page' }),
      }),
    );

    const rows = body.users as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.lastActiveAt).toBe('N/A');
      expect(row.bedrockCostUsd).toEqual(periodValues('N/A'));
    }
    expect(rows.map((row) => row.email)).toEqual(
      expect.arrayContaining([
        'also-verified@example.com',
        'at-168h@example.com',
        'at-72h@example.com',
        'future@example.com',
        'too-old@example.com',
      ]),
    );
    expect(rows.filter((row) => row.id === 'at-24h')).toHaveLength(1);
    expect(rows.find((row) => row.id === 'at-24h')).toMatchObject({
      id: 'at-24h',
      lastActiveAt: 'N/A',
      bedrockCostUsd: periodValues('N/A'),
    });
    expect(rows.find((row) => row.id === 'at-24h')?.registeredAt).toBe('2026-10-14T12:00:00.000Z');
    expect(rows.find((row) => row.id === 'at-72h')?.registeredAt).toBe('2026-10-12T12:00:00.000Z');
    expect(rows.find((row) => row.id === 'at-168h')?.registeredAt).toBe('2026-10-08T12:00:00.000Z');
  });

  it.each([
    {
      windowHours: 24,
      expected: { hours24: 2, days3: 3, days7: 3 },
    },
    {
      windowHours: 72,
      expected: { hours24: 0, days3: 2, days7: 3 },
    },
    {
      windowHours: 168,
      expected: { hours24: 0, days3: 0, days7: 2 },
    },
  ])(
    'includes the exact and inside edge but excludes the outside edge of the $windowHours-hour window',
    async ({ windowHours, expected }) => {
      const edge = cutoff.getTime() - windowHours * 60 * 60 * 1_000;
      const dates = [edge + 1, edge, edge - 1];
      const send = vi.fn(async (): Promise<UserPage> => ({
        Users: dates.map((timestamp, index) =>
          user(
            `${windowHours}-${index}`,
            `${windowHours}-${index}@example.com`,
            'true',
            new Date(timestamp).toISOString(),
          ),
        ),
      }));

      const response = await handleRequest(eventFor(), dependencies(send));

      expect(response.statusCode).toBe(200);
      const body = responseBody(response);
      expect(body.newUsers).toEqual(expected);
      expect(body.registeredUsers).toBe(3);
      const rows = body.users as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.registeredAt)).toEqual(
        expect.arrayContaining(dates.map((timestamp) => new Date(timestamp).toISOString())),
      );
    },
  );

  it('includes a signup at the request cutoff and excludes one millisecond in the future', async () => {
    const send = vi.fn(async (): Promise<UserPage> => ({
      Users: [
        user('at-cutoff', 'at-cutoff@example.com', 'true', cutoff.toISOString()),
        user(
          'future-by-one-ms',
          'future-by-one-ms@example.com',
          'true',
          new Date(cutoff.getTime() + 1).toISOString(),
        ),
      ],
    }));

    const response = await handleRequest(eventFor(), dependencies(send));

    expect(response.statusCode).toBe(200);
    const body = responseBody(response);
    expect(body.newUsers).toEqual({ hours24: 1, days3: 1, days7: 1 });
    expect(
      (body.users as Array<Record<string, unknown>>).find((row) => row.id === 'at-cutoff'),
    ).toMatchObject({ registeredAt: cutoff.toISOString() });
  });

  it('keeps valid zero counts separate from unknown login and cost metrics', async () => {
    const send = vi.fn(async (): Promise<UserPage> => ({ Users: [] }));

    const response = await handleRequest(eventFor(), dependencies(send));

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toMatchObject({
      registeredUsers: 0,
      newUsers: periodValues(0),
      activeUsers: periodValues('N/A'),
      bedrockCostUsd: periodValues('N/A'),
      users: [],
    });
  });

  it('returns N/A for new-user windows when a verified user has no creation date', async () => {
    const send = vi.fn(async (): Promise<UserPage> => ({
      Users: [user('date-missing', 'date-missing@example.com', 'true')],
    }));

    const response = await handleRequest(eventFor(), dependencies(send));

    expect(response.statusCode).toBe(200);
    const body = responseBody(response);
    expect(body.registeredUsers).toBe(1);
    expect(body.newUsers).toEqual(periodValues('N/A'));
    expect((body.users as Array<Record<string, unknown>>)[0]).toMatchObject({
      email: 'date-missing@example.com',
      registeredAt: 'N/A',
    });
  });

  it('reads Cognito again on the next request and returns the changed cohort', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Users: [user('first', 'first@example.com', 'true', '2026-10-14T12:00:00.000Z')],
      })
      .mockResolvedValueOnce({
        Users: [
          user('first', 'first@example.com', 'true', '2026-10-14T12:00:00.000Z'),
          user('second', 'second@example.com', 'true', '2026-10-15T11:00:00.000Z'),
        ],
      });
    const deps = dependencies(send);

    const first = await handleRequest(eventFor(), deps);
    const second = await handleRequest(eventFor(), deps);

    expect(responseBody(first).registeredUsers).toBe(1);
    expect(responseBody(second).registeredUsers).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails the request rather than returning a partial inventory after a later page fails', async () => {
    const send = vi.fn(async ({ input }: ListUsersCommandLike): Promise<UserPage> => {
      if (input.PaginationToken === undefined) {
        return {
          Users: [user('partial', 'partial@example.com', 'true', '2026-10-15T11:00:00.000Z')],
          PaginationToken: 'next-page',
        };
      }
      throw new Error('Cognito unavailable');
    });

    const response = await handleRequest(eventFor(), dependencies(send));

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.statusCode).toBeLessThan(600);
    expect(responseBody(response)).not.toHaveProperty('registeredUsers');
    expect(responseBody(response)).not.toHaveProperty('users');
  });
});
