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
const attrN = (value: number): AttributeValue => ({ N: String(value) });

const user = (
  sub: string,
  email: string,
  createdAt: string,
  enabled = true,
  emailVerified = 'true',
): CognitoUser => ({
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

const header = (
  owner: string,
  id: string,
  options: { createdAt?: string; score?: AttributeValue; status?: string } = {},
): Item => ({
  PK: attrS(`USER#${owner}`),
  SK: attrS(`ATTEMPT#${id}`),
  ...(options.createdAt === undefined ? {} : { createdAt: attrS(options.createdAt) }),
  ...(options.score === undefined ? {} : { score: options.score }),
  status: attrS(options.status ?? 'admitted'),
  privateBody: attrS('private-attempt-body'),
});

const key = (partition: string, sort: string): Item => ({ PK: attrS(partition), SK: attrS(sort) });

const makeDependencies = (
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

const startKeyFrom = (command: ScanCommandLike): Item | undefined =>
  command.input.ExclusiveStartKey as Item | undefined;

const resolvedExpression = (command: ScanCommandLike, field: string): string => {
  const aliases = (command.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  return String(command.input[field] ?? '').replace(/#[\w]+/gu, (alias) => aliases[alias] ?? alias);
};

const resolvedProjection = (command: ScanCommandLike): string[] =>
  resolvedExpression(command, 'ProjectionExpression')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

describe('monitoring attempts metrics', () => {
  it('scans once across verified owners, continues after an empty page, and preserves attempt windows and scores', async () => {
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

    const dynamoSend = vi.fn(async (command: ScanCommandLike): Promise<ScanPage> => {
      const startKey = startKeyFrom(command)?.SK?.S;
      if (startKey === undefined) {
        return {
          Items: [
            header('owner-a', 'at-24h', {
              createdAt: new Date(cutoff.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
              score: attrN(-3),
              status: 'error',
            }),
            header('owner-a', 'inside-24h', {
              createdAt: new Date(cutoff.getTime() - 24 * 60 * 60 * 1_000 + 1).toISOString(),
              score: attrN(-5),
            }),
            header('owner-a', 'outside-24h', {
              createdAt: new Date(cutoff.getTime() - 24 * 60 * 60 * 1_000 - 1).toISOString(),
              score: attrN(-6),
            }),
          ],
          LastEvaluatedKey: key('USER#owner-a', 'ATTEMPT#cursor-1'),
        };
      }
      if (startKey === 'ATTEMPT#cursor-1') {
        return { Items: [], LastEvaluatedKey: key('USER#owner-a', 'ATTEMPT#cursor-2') };
      }
      if (startKey === 'ATTEMPT#cursor-2') {
        return {
          Items: [
            header('owner-a', 'at-72h', {
              createdAt: new Date(cutoff.getTime() - 72 * 60 * 60 * 1_000).toISOString(),
              score: attrN(0),
              status: 'cancelled',
            }),
            header('owner-a', 'outside-72h', {
              createdAt: new Date(cutoff.getTime() - 72 * 60 * 60 * 1_000 - 1).toISOString(),
              score: attrN(-8),
            }),
            header('owner-a', 'at-168h', {
              createdAt: new Date(cutoff.getTime() - 168 * 60 * 60 * 1_000).toISOString(),
              score: attrN(-9),
            }),
            header('owner-a', 'outside-168h', {
              createdAt: new Date(cutoff.getTime() - 168 * 60 * 60 * 1_000 - 1).toISOString(),
              score: attrN(700),
            }),
            header('owner-a', 'at-cut-offset', {
              createdAt: '2026-10-15T08:00:00.000-04:00',
              score: attrN(-1),
            }),
            header('owner-a', 'future', {
              createdAt: new Date(cutoff.getTime() + 1).toISOString(),
              score: attrN(-100),
            }),
            header('owner-a', 'old-score', {
              createdAt: '2026-09-01T00:00:00.000Z',
              score: attrN(800),
            }),
            header('owner-c', 'missing-date', { score: attrN(0) }),
            header('owner-c', 'invalid-date', { createdAt: 'not-a-date', score: attrN(-5) }),
            header('owner-c', 'string-score', {
              createdAt: '2026-10-15T11:00:00.000Z',
              score: attrS('9999'),
            }),
            {
              ...header('owner-c', 'null-score', { createdAt: '2026-10-15T10:00:00.000Z' }),
              score: { NULL: true },
            },
            header('owner-c', 'absent-score', { createdAt: '2026-10-15T09:00:00.000Z' }),
            header('owner-d', 'negative-1', {
              createdAt: '2026-10-15T10:00:00.000Z',
              score: attrN(-9),
            }),
            header('owner-d', 'negative-2', {
              createdAt: '2026-10-15T11:00:00.000Z',
              score: attrN(-2),
            }),
            header('hidden', 'unverified-owner', {
              createdAt: '2026-10-15T11:00:00.000Z',
              score: attrN(1000),
            }),
          ],
        };
      }
      throw new Error(`Unexpected scan cursor: ${startKey}`);
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
    const scans = dynamoSend.mock.calls.map(([command]) => command);
    expect(scans).toHaveLength(3);
    expect(scans.every((command) => command.constructor.name === 'ScanCommand')).toBe(true);
    expect(scans.map((command) => command.input.TableName)).toEqual(Array(3).fill(tableName));
    expect(scans.every((command) => command.input.ConsistentRead === true)).toBe(true);
    expect(scans[1]?.input.ExclusiveStartKey).toEqual(key('USER#owner-a', 'ATTEMPT#cursor-1'));
    expect(scans[2]?.input.ExclusiveStartKey).toEqual(key('USER#owner-a', 'ATTEMPT#cursor-2'));
    for (const scan of scans) {
      expect(resolvedProjection(scan)).toEqual(
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
        ]),
      );
      const projection = resolvedProjection(scan);
      expect(projection).toHaveLength(9);
      expect(projection.join(',')).not.toMatch(
        /body|rawAction|reservedMicros|settledMicros|ledger/iu,
      );
      expect(resolvedExpression(scan, 'FilterExpression')).toMatch(/PK/u);
      expect(resolvedExpression(scan, 'FilterExpression')).toMatch(/SK/u);
      expect(resolvedExpression(scan, 'FilterExpression')).toMatch(/begins_with/iu);
      const filterValues = Object.values(
        scan.input.ExpressionAttributeValues as Record<string, AttributeValue>,
      );
      expect(filterValues).toEqual(
        expect.arrayContaining([attrS('USER#'), attrS('ATTEMPT#'), attrS('CALL#')]),
      );
    }

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('hidden@example.com');
    expect(serialized).not.toContain('USER#');
    expect(serialized).not.toContain('ATTEMPT#');
    expect(serialized).not.toContain('private-attempt-body');
  });

  it('keeps counts numeric but maxScore N/A when no numeric score exists and treats an empty cursor as final', async () => {
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({
      Users: [user('unscored-owner', 'unscored@example.com', '2026-10-01T00:00:00.000Z')],
    }));
    const dynamoSend = vi.fn(async (): Promise<ScanPage> => ({
      Items: [
        header('unscored-owner', 'string-score', {
          createdAt: '2026-10-15T11:00:00.000Z',
          score: attrS('9999'),
        }),
        {
          ...header('unscored-owner', 'null-score', { createdAt: '2026-10-15T10:00:00.000Z' }),
          score: { NULL: true },
        },
        header('unscored-owner', 'absent-score', { createdAt: '2026-10-15T09:00:00.000Z' }),
      ],
      LastEvaluatedKey: {},
    }));

    const response = await handleRequest(eventFor(), makeDependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    const row = (responseBody(response).users as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ attempts: periods(3), maxScore: 'N/A' });
    expect(dynamoSend).toHaveBeenCalledTimes(1);
  });

  it('takes one cutoff before reads and stamps generatedAt after the last Scan page', async () => {
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

    let finalPageStarted!: () => void;
    let finishPage!: (page: ScanPage) => void;
    const finalPageSignal = new Promise<void>((resolve) => {
      finalPageStarted = resolve;
    });
    const finalPageResult = new Promise<ScanPage>((resolve) => {
      finishPage = resolve;
    });
    const dynamoSend = vi.fn((command: ScanCommandLike) => {
      const startKey = startKeyFrom(command)?.SK?.S;
      order.push(`scan:${startKey ?? 'first'}`);
      if (startKey === undefined) {
        return Promise.resolve({
          Items: [],
          LastEvaluatedKey: key('USER#fast-owner', 'ATTEMPT#cursor'),
        });
      }
      finalPageStarted();
      return finalPageResult;
    });

    const request = handleRequest(eventFor(), makeDependencies(cognitoSend, dynamoSend, now));
    await finalPageSignal;
    expect(order[0]).toBe('clock');
    expect(order.indexOf('cognito')).toBeGreaterThan(order.indexOf('clock'));
    const pendingResult = await Promise.race([
      request.then(() => 'finished'),
      new Promise<'still-reading'>((resolve) => setImmediate(() => resolve('still-reading'))),
    ]);
    expect(pendingResult).toBe('still-reading');

    currentTime = new Date(finishedAt);
    finishPage({
      Items: [
        header('slow-owner', 'after-cutoff', {
          createdAt: new Date(cutoff.getTime() + 60 * 60 * 1_000).toISOString(),
          score: attrN(5),
        }),
      ],
    });
    const response = await request;

    expect(response.statusCode).toBe(200);
    expect(dynamoSend).toHaveBeenCalledTimes(2);
    expect(order[order.length - 1]).toBe('clock');
    expect(responseBody(response)).toMatchObject({
      asOf: cutoff.toISOString(),
      generatedAt: finishedAt.toISOString(),
    });
    const rows = responseBody(response).users as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.id === 'slow-owner')?.attempts).toEqual(periods(0));
    expect(rows.find((row) => row.id === 'fast-owner')?.attempts).toEqual(periods(0));
  });

  it('reads table rows again on the next request instead of reusing a previous result', async () => {
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({
      Users: [user('owner', 'owner@example.com', '2026-10-01T00:00:00.000Z')],
    }));
    const dynamoSend = vi
      .fn<(command: ScanCommandLike) => Promise<ScanPage>>()
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [
          header('owner', 'new-attempt', {
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
    expect(firstRow?.attempts).toEqual(periods(0));
    expect(firstRow?.maxScore).toBe('N/A');
    expect(secondRow?.attempts).toEqual(periods(1));
    expect(secondRow?.maxScore).toBe(12);
    expect(dynamoSend).toHaveBeenCalledTimes(2);
    expect(cognitoSend).toHaveBeenCalledTimes(2);
  });

  it.each(['later-page-failure', 'repeated-key', 'malformed-key', 'invalid-items'] as const)(
    'returns a controlled failure without partial or private data when Scan pagination has %s',
    async (failureMode) => {
      const cognitoSend = vi.fn(async (): Promise<UserPage> => ({
        Users: [user('private-owner', 'private@example.com', '2026-10-01T00:00:00.000Z')],
      }));
      const repeatedKey = key('USER#private-owner', 'ATTEMPT#same-page');
      const dynamoSend = vi.fn(async (command: ScanCommandLike): Promise<ScanPage> => {
        if (startKeyFrom(command) === undefined) {
          return {
            Items: [
              header('private-owner', 'partial', {
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
        if (failureMode === 'malformed-key')
          return { Items: [], LastEvaluatedKey: { PK: attrN(3), SK: attrS('bad') } };
        if (failureMode === 'invalid-items')
          return { Items: { invalid: true } as unknown as Item[] };
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
      if (failureMode !== 'later-page-failure') expect(dynamoSend).toHaveBeenCalledTimes(2);
    },
  );
});
