import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from './handler.js';

const poolId = 'us-east-1_example';
const tableName = 'runner-draft-table';
const cutoff = new Date('2026-10-15T12:00:00.000Z');
const day = 24 * 60 * 60 * 1_000;

type AttributeValue = {
  S?: string;
  N?: string;
  NULL?: boolean;
  M?: Record<string, AttributeValue>;
};
type Item = Record<string, AttributeValue>;
type ScanPage = { Items?: Item[]; LastEvaluatedKey?: Item };
type ScanCommandLike = { constructor: { name: string }; input: Record<string, unknown> };
type ListUsersCommandLike = { input: { UserPoolId?: string; PaginationToken?: string } };
type CognitoUser = {
  Username: string;
  Enabled?: boolean;
  UserCreateDate?: Date;
  Attributes?: Array<{ Name?: string; Value?: string }>;
};
type UserPage = { Users?: CognitoUser[]; PaginationToken?: string };

const attrS = (value: string): AttributeValue => ({ S: value });

const user = (sub: string, emailVerified = 'true', enabled = true): CognitoUser => ({
  Username: sub,
  Enabled: enabled,
  UserCreateDate: new Date('2026-10-01T00:00:00.000Z'),
  Attributes: [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: `${sub}@example.com` },
    { Name: 'email_verified', Value: emailVerified },
  ],
});

const event = (): APIGatewayProxyEventV2 =>
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
      requestId: 'request-activity',
      routeKey: 'GET /api/metrics',
      stage: '$default',
      time: '15/Oct/2026:12:00:00 +0000',
      timeEpoch: cutoff.getTime(),
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const periods = <T extends number | 'N/A'>(value: T) => ({
  hours24: value,
  days3: value,
  days7: value,
});

const dependencies = (
  cognitoSend: (command: ListUsersCommandLike) => Promise<UserPage>,
  dynamoSend: (command: ScanCommandLike) => Promise<ScanPage>,
  now = vi.fn(() => new Date(cutoff)),
) =>
  ({
    cognito: { send: cognitoSend },
    dynamo: { send: dynamoSend },
    userPoolId: poolId,
    tableName,
    now,
  }) as unknown as Parameters<typeof handleRequest>[1];

const activity = (owner: string, lastLoginAt?: string): Item => ({
  PK: attrS(`USER#${owner}`),
  SK: attrS('ACTIVITY'),
  ...(lastLoginAt === undefined ? {} : { lastLoginAt: attrS(lastLoginAt) }),
});

const key = (partition: string, sort: string): Item => ({ PK: attrS(partition), SK: attrS(sort) });

const resolvedExpression = (command: ScanCommandLike, field: string): string => {
  const aliases = (command.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  return String(command.input[field] ?? '').replace(/#[\w]+/gu, (alias) => aliases[alias] ?? alias);
};

const resolvedProjection = (command: ScanCommandLike): string[] =>
  resolvedExpression(command, 'ProjectionExpression')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

describe('monitoring login activity', () => {
  it('counts unique verified users in inclusive windows from exact activity rows in the shared paginated scan', async () => {
    const ids = [
      'inside-24',
      'at-24-disabled',
      'outside-24',
      'inside-72',
      'at-72',
      'outside-72',
      'inside-168',
      'at-168',
      'outside-168',
      'older-than-seven-days',
      'missing-date',
      'invalid-date',
      'future-date',
      'attempt-only',
      'unverified',
    ];
    const firstPage = ids
      .slice(0, -1)
      .map((id) => user(id, id === 'unverified' ? 'false' : 'true', id !== 'at-24-disabled'));
    const cognitoSend = vi.fn(async ({ input }: ListUsersCommandLike): Promise<UserPage> =>
      input.PaginationToken === undefined
        ? { Users: firstPage, PaginationToken: 'users-next' }
        : { Users: [user('at-24-disabled', 'true', false), user('unverified', 'false')] },
    );
    const dynamoSend = vi.fn(async (command: ScanCommandLike): Promise<ScanPage> => {
      const start = command.input.ExclusiveStartKey as Item | undefined;
      const sort = start?.SK?.S;
      if (sort === undefined) {
        return {
          Items: [
            activity('inside-24', new Date(cutoff.getTime() - day + 1).toISOString()),
            activity('at-24-disabled', '2026-10-14T08:00:00.000-04:00'),
            activity('outside-24', new Date(cutoff.getTime() - day - 1).toISOString()),
            activity('inside-72', new Date(cutoff.getTime() - 3 * day + 1).toISOString()),
            activity('at-72', '2026-10-12T08:00:00.000-04:00'),
            activity('outside-72', new Date(cutoff.getTime() - 3 * day - 1).toISOString()),
            activity('inside-168', new Date(cutoff.getTime() - 7 * day + 1).toISOString()),
            {
              PK: attrS('USER#attempt-only'),
              SK: attrS('ATTEMPT#recent'),
              createdAt: attrS(new Date(cutoff.getTime() - 60 * 60 * 1_000).toISOString()),
              score: { N: '5' },
            },
            {
              PK: attrS('ATTEMPT#attempt'),
              SK: attrS('CALL#00000001'),
              createdAt: attrS(new Date(cutoff.getTime() - 60 * 60 * 1_000).toISOString()),
            },
          ],
          LastEvaluatedKey: key('USER#inside-24', 'ATTEMPT#cursor-1'),
        };
      }
      if (sort === 'ATTEMPT#cursor-1') {
        return { Items: [], LastEvaluatedKey: key('USER#inside-24', 'ATTEMPT#cursor-2') };
      }
      if (sort === 'ATTEMPT#cursor-2') {
        return {
          Items: [
            activity('at-168', new Date(cutoff.getTime() - 7 * day).toISOString()),
            activity('outside-168', new Date(cutoff.getTime() - 7 * day - 1).toISOString()),
            activity('older-than-seven-days', '2026-10-07T11:00:00.000Z'),
            activity('missing-date'),
            activity('invalid-date', '2026-02-30T12:00:00.000Z'),
            activity('future-date', new Date(cutoff.getTime() + 1).toISOString()),
            // Page order varies around each user's maximum: older after newer, newer after older.
            activity('inside-24', new Date(cutoff.getTime() - 2 * day).toISOString()),
            activity('inside-72', new Date(cutoff.getTime() - 2 * day).toISOString()),
            activity('unverified', new Date(cutoff.getTime() - 60 * 60 * 1_000).toISOString()),
            activity(
              'unknown-cognito-user',
              new Date(cutoff.getTime() - 60 * 60 * 1_000).toISOString(),
            ),
            activity('', new Date(cutoff.getTime() - 60 * 60 * 1_000).toISOString()),
            {
              PK: attrS('USER#at-24-disabled'),
              SK: attrS('ACTIVITY#not-exact'),
              lastLoginAt: attrS(new Date(cutoff.getTime() + 60 * 60 * 1_000).toISOString()),
            },
            {
              PK: attrS('USER#at-24-disabled'),
              SK: attrS('ATTEMPT#old'),
              createdAt: attrS(new Date(cutoff.getTime() + 60 * 60 * 1_000).toISOString()),
            },
            {
              PK: attrS('OTHER#at-24-disabled'),
              SK: attrS('ACTIVITY'),
              lastLoginAt: attrS(new Date(cutoff.getTime() + 60 * 60 * 1_000).toISOString()),
            },
          ],
        };
      }
      throw new Error(`Unexpected scan cursor: ${sort}`);
    });

    const response = await handleRequest(event(), dependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    const body = responseBody(response);
    expect(body.asOf).toBe(cutoff.toISOString());
    expect(body.registeredUsers).toBe(14);
    expect(body.newUsers).toEqual(periods(0));
    expect(body.activeUsers).toEqual({ hours24: 2, days3: 5, days7: 8 });
    expect(body.bedrockCostUsd).toEqual(periods(0));
    const rows = body.users as Array<Record<string, unknown>>;
    const rowById = new Map(rows.map((row) => [row.id, row]));
    expect(rows).toHaveLength(14);
    expect(rowById.has('unverified')).toBe(false);
    expect(rowById.has('unknown-cognito-user')).toBe(false);
    expect(rows.filter((row) => row.id === 'at-24-disabled')).toHaveLength(1);
    expect(rowById.get('inside-24')?.lastActiveAt).toBe(
      new Date(cutoff.getTime() - day + 1).toISOString(),
    );
    expect(rowById.get('inside-72')?.lastActiveAt).toBe(
      new Date(cutoff.getTime() - 2 * day).toISOString(),
    );
    expect(rowById.get('at-24-disabled')?.lastActiveAt).toBe('2026-10-14T12:00:00.000Z');
    expect(rowById.get('at-72')?.lastActiveAt).toBe('2026-10-12T12:00:00.000Z');
    expect(rowById.get('at-168')?.lastActiveAt).toBe('2026-10-08T12:00:00.000Z');
    expect(rowById.get('older-than-seven-days')?.lastActiveAt).toBe('2026-10-07T11:00:00.000Z');
    expect(rowById.get('missing-date')?.lastActiveAt).toBe('N/A');
    expect(rowById.get('invalid-date')?.lastActiveAt).toBe('N/A');
    expect(rowById.get('future-date')?.lastActiveAt).toBe(
      new Date(cutoff.getTime() + 1).toISOString(),
    );
    expect(rowById.get('attempt-only')).toMatchObject({
      lastActiveAt: 'N/A',
      attempts: periods(1),
    });

    const scans = dynamoSend.mock.calls.map(([command]) => command);
    expect(scans).toHaveLength(3);
    expect(scans.every((command) => command.constructor.name === 'ScanCommand')).toBe(true);
    expect(scans.every((command) => command.input.TableName === tableName)).toBe(true);
    expect(scans.every((command) => command.input.ConsistentRead === true)).toBe(true);
    expect(scans[1]?.input.ExclusiveStartKey).toEqual(key('USER#inside-24', 'ATTEMPT#cursor-1'));
    expect(scans[2]?.input.ExclusiveStartKey).toEqual(key('USER#inside-24', 'ATTEMPT#cursor-2'));
    for (const scan of scans) {
      const projection = resolvedProjection(scan);
      expect(projection).toEqual(
        expect.arrayContaining([
          'PK',
          'SK',
          'createdAt',
          'score',
          'usage.inputTokens',
          'usage.outputTokens',
          'usage.cacheReadTokens',
          'usage.cacheWriteTokens',
          'budget.rates',
          'lastLoginAt',
        ]),
      );
      expect(projection).toHaveLength(10);
      const filter = resolvedExpression(scan, 'FilterExpression');
      expect(filter).toMatch(/SK\s*=/u);
      expect(filter).toMatch(/begins_with\(PK,/iu);
      expect(filter).toMatch(/begins_with/iu);
      const values = Object.values(
        scan.input.ExpressionAttributeValues as Record<string, AttributeValue>,
      );
      expect(values).toEqual(expect.arrayContaining([attrS('USER#'), attrS('ACTIVITY')]));
      const expressionValues = scan.input.ExpressionAttributeValues as Record<
        string,
        AttributeValue
      >;
      const activityPlaceholder = Object.entries(expressionValues).find(
        ([, value]) => value.S === 'ACTIVITY',
      )?.[0];
      expect(activityPlaceholder).toBeDefined();
      expect(filter.replace(/\s+/gu, '')).toContain(`SK=${activityPlaceholder}`);
    }
  });

  it('returns no partial metrics when a later page of the shared scan fails after activity was read', async () => {
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({ Users: [user('owner')] }));
    const dynamoSend = vi.fn(async (command: ScanCommandLike): Promise<ScanPage> => {
      if (command.input.ExclusiveStartKey === undefined) {
        return {
          Items: [activity('owner', '2026-10-15T11:00:00.000Z')],
          LastEvaluatedKey: key('USER#owner', 'ATTEMPT#cursor'),
        };
      }
      throw new Error('Scan unavailable after activity page');
    });

    const response = await handleRequest(event(), dependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).not.toHaveProperty('activeUsers');
    expect(responseBody(response)).not.toHaveProperty('users');
    expect(dynamoSend).toHaveBeenCalledTimes(2);
  });

  it('rereads activity on each request and returns zero for the next empty scan', async () => {
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({ Users: [user('owner')] }));
    const dynamoSend = vi
      .fn<(command: ScanCommandLike) => Promise<ScanPage>>()
      .mockResolvedValueOnce({ Items: [activity('owner', '2026-10-14T13:00:00.000Z')] })
      .mockResolvedValueOnce({ Items: [] });
    const deps = dependencies(cognitoSend, dynamoSend);

    const first = await handleRequest(event(), deps);
    const second = await handleRequest(event(), deps);

    const firstBody = responseBody(first);
    const secondBody = responseBody(second);
    expect(firstBody.activeUsers).toEqual({ hours24: 1, days3: 1, days7: 1 });
    expect((firstBody.users as Array<Record<string, unknown>>)[0]?.lastActiveAt).toBe(
      '2026-10-14T13:00:00.000Z',
    );
    expect(secondBody.activeUsers).toEqual(periods(0));
    expect((secondBody.users as Array<Record<string, unknown>>)[0]?.lastActiveAt).toBe('N/A');
    expect(dynamoSend).toHaveBeenCalledTimes(2);
    expect(cognitoSend).toHaveBeenCalledTimes(2);
  });
});
