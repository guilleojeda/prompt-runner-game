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
type UserPage = {
  Users?: Array<{
    Username: string;
    UserCreateDate?: Date;
    Attributes?: Array<{ Name?: string; Value?: string }>;
  }>;
  PaginationToken?: string;
};

type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};
type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };

const attrS = (value: string): AttributeValue => ({ S: value });
const attrN = (value: number): AttributeValue => ({ N: String(value) });
const attrTokenCount = (value: number | null): AttributeValue =>
  value === null ? { NULL: true } : attrN(value);
const nestedMap = (value: Record<string, AttributeValue>): AttributeValue => ({ M: value });

const user = (sub: string) => ({
  Username: sub,
  UserCreateDate: new Date('2026-10-01T00:00:00.000Z'),
  Attributes: [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: `${sub}@example.com` },
    { Name: 'email_verified', Value: 'true' },
  ],
});

const header = (
  owner: string,
  attemptId: string,
  options: { createdAt?: string; score?: number } = {},
): Item => ({
  PK: attrS(`USER#${owner}`),
  SK: attrS(`ATTEMPT#${attemptId}`),
  createdAt: attrS(options.createdAt ?? '2026-10-15T06:00:00.000Z'),
  ...(options.score === undefined ? {} : { score: attrN(options.score) }),
});

const call = (
  attemptId: string,
  seq: number,
  options: {
    createdAt?: string | null;
    decisionId?: string;
    status?: string;
    usage?: Partial<Usage>;
    rawUsage?: Partial<Record<keyof Usage, AttributeValue>>;
    rates?: Partial<Rates> | null;
    rawRates?: Partial<Record<keyof Rates, AttributeValue>>;
    reservedMicros?: number;
    settledMicros?: number;
  } = {},
): Item => {
  const usage: Usage = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    ...options.usage,
  };
  const budgetValues: Record<string, AttributeValue> = {};
  if (options.reservedMicros !== undefined)
    budgetValues.reservedMicros = attrN(options.reservedMicros);
  if (options.settledMicros !== undefined)
    budgetValues.settledMicros = attrN(options.settledMicros);
  if (options.rates !== null && options.rates !== undefined) {
    const rateValues = Object.fromEntries(
      Object.entries(options.rates).map(([name, value]) => [name, attrN(value)]),
    ) as Record<string, AttributeValue>;
    Object.assign(rateValues, options.rawRates);
    budgetValues.rates = nestedMap(rateValues);
  } else if (options.rawRates !== undefined) {
    budgetValues.rates = nestedMap(options.rawRates as Record<string, AttributeValue>);
  }

  const usageValues = Object.fromEntries(
    Object.entries(usage).map(([name, value]) => [name, attrTokenCount(value)]),
  ) as Record<string, AttributeValue>;
  Object.assign(usageValues, options.rawUsage);

  return {
    PK: attrS(`ATTEMPT#${attemptId}`),
    SK: attrS(`CALL#${String(seq).padStart(8, '0')}`),
    ...(options.createdAt === null
      ? {}
      : { createdAt: attrS(options.createdAt ?? '2026-10-15T11:00:00.000Z') }),
    decisionId: attrS(options.decisionId ?? `decision-${seq}`),
    status: attrS(options.status ?? 'received'),
    usage: nestedMap(usageValues),
    ...(Object.keys(budgetValues).length === 0 ? {} : { budget: nestedMap(budgetValues) }),
    rawAction: nestedMap({ text: attrS('private-action') }),
    responseBody: attrS('private-response'),
  };
};

const key = (partition: string, sort: string): Item => ({ PK: attrS(partition), SK: attrS(sort) });

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
      requestId: 'request-costs',
      routeKey: 'GET /api/metrics',
      stage: '$default',
      time: '15/Oct/2026:12:00:00 +0000',
      timeEpoch: cutoff.getTime(),
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

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

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const periods = (value: number) => ({ hours24: value, days3: value, days7: value });

const readOnlyScan = (...items: Item[]) =>
  vi.fn<(command: ScanCommandLike) => Promise<ScanPage>>(async () => ({ Items: items }));

describe('monitoring Bedrock costs', () => {
  it('sums each measured retry from stored cache rates, ignoring reservations and unmapped owners only for rows', async () => {
    const rates = { input: 0.25, output: 0.5, cacheRead: 0.1, cacheWrite: 0.7 };
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({ Users: [user('visible-owner')] }));
    const dynamoSend = readOnlyScan(
      // Calls can be scanned before their attempt headers.
      call('old-attempt', 1, {
        decisionId: 'same-decision',
        status: 'cancelled',
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 2 },
        rates,
        reservedMicros: 900_000,
        settledMicros: 800_000,
      }),
      call('old-attempt', 2, {
        decisionId: 'same-decision',
        status: 'error',
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates,
        reservedMicros: 700_000,
        settledMicros: 600_000,
      }),
      call('old-attempt', 3, {
        decisionId: 'same-decision',
        status: 'error',
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates,
      }),
      call('old-attempt', 4, {
        usage: { inputTokens: null, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates,
        settledMicros: 500_000,
      }),
      call('orphan-attempt', 1, {
        usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      call('hidden-attempt', 1, {
        usage: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      header('not-in-cognito', 'hidden-attempt', { createdAt: '2020-01-01T00:00:00.000Z' }),
      header('visible-owner', 'old-attempt', { createdAt: '2020-01-01T00:00:00.000Z', score: 14 }),
    );

    const response = await handleRequest(event(), dependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    const body = responseBody(response);
    expect(body.asOf).toBe(cutoff.toISOString());
    expect(body.bedrockCostUsd).toEqual(periods(0.000021));
    const rows = body.users as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'visible-owner',
      attempts: periods(0),
      maxScore: 14,
      bedrockCostUsd: periods(0.000005),
    });
    // The cached call costs 3 microdollars; each 0.25-microdollar retry rounds to 1.
    // Rounding the combined retries would produce 1 instead of 2 microdollars.
    // CALL sequence, rather than decisionId, defines a distinct billable record.
    expect(JSON.stringify(body)).not.toMatch(
      /private-action|private-response|rawAction|reservedMicros|settledMicros|coverage|estimate/iu,
    );
    expect(dynamoSend).toHaveBeenCalledTimes(1);
    expect(dynamoSend.mock.calls[0]?.[0].constructor.name).toBe('ScanCommand');
  });

  it('uses inclusive call-createdAt windows even when the parent attempt is old', async () => {
    const rates = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    const usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const times = [
      cutoff.toISOString(),
      new Date(cutoff.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
      new Date(cutoff.getTime() - 24 * 60 * 60 * 1_000 - 1).toISOString(),
      new Date(cutoff.getTime() - 72 * 60 * 60 * 1_000).toISOString(),
      new Date(cutoff.getTime() - 72 * 60 * 60 * 1_000 - 1).toISOString(),
      new Date(cutoff.getTime() - 168 * 60 * 60 * 1_000).toISOString(),
      new Date(cutoff.getTime() - 168 * 60 * 60 * 1_000 - 1).toISOString(),
      new Date(cutoff.getTime() + 1).toISOString(),
      '2026-02-30T12:00:00.000Z',
      null,
    ];
    const calls = times.map((createdAt, index) =>
      call('long-lived-attempt', index + 1, {
        createdAt,
        usage,
        rates,
      }),
    );
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({ Users: [user('owner')] }));
    const dynamoSend = readOnlyScan(
      header('owner', 'long-lived-attempt', { createdAt: '2019-01-01T00:00:00.000Z', score: 42 }),
      ...calls,
    );

    const response = await handleRequest(event(), dependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    expect(responseBody(response).bedrockCostUsd).toEqual({
      hours24: 0.000002,
      days3: 0.000004,
      days7: 0.000006,
    });
    const row = (responseBody(response).users as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({
      attempts: periods(0),
      maxScore: 42,
      bedrockCostUsd: { hours24: 0.000002, days3: 0.000004, days7: 0.000006 },
    });
  });

  it('returns numeric zero when every call lacks usable usage or stored rates, regardless of settled value', async () => {
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({ Users: [user('owner')] }));
    const dynamoSend = readOnlyScan(
      header('owner', 'only-unknown-costs'),
      call('only-unknown-costs', 1, {
        usage: { inputTokens: null, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        reservedMicros: 100_000,
        settledMicros: 90_000,
      }),
      call('only-unknown-costs', 2, {
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates: null,
        reservedMicros: 200_000,
        settledMicros: 180_000,
      }),
      call('only-unknown-costs', 3, {
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0 },
        rates: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      }),
      call('only-unknown-costs', 4, {
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates: { input: 1, output: 1, cacheRead: 1 },
      }),
      call('only-unknown-costs', 5, {
        usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      }),
    );

    const response = await handleRequest(event(), dependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    const body = responseBody(response);
    expect(body.bedrockCostUsd).toEqual(periods(0));
    expect((body.users as Array<Record<string, unknown>>)[0]).toMatchObject({
      bedrockCostUsd: periods(0),
    });
    expect(body).not.toHaveProperty('costCoverage');
    expect(body).not.toHaveProperty('omittedCalls');
  });

  it('skips malformed token counts and rates while retaining a call with a valid UTC offset', async () => {
    const knownUsage = {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const knownRates = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    const invalidCases: Array<{
      rawUsage?: Partial<Record<keyof Usage, AttributeValue>>;
      rawRates?: Partial<Record<keyof Rates, AttributeValue>>;
    }> = [
      { rawUsage: { inputTokens: attrN(1.5) } },
      { rawUsage: { cacheReadTokens: attrS('0') } },
      { rawUsage: { outputTokens: attrN(Number.MAX_SAFE_INTEGER + 1) } },
      { rawUsage: { cacheWriteTokens: attrN(-1) } },
      { rawRates: { input: attrN(-1) } },
      { rawRates: { input: attrN(Number.NaN) } },
      { rawRates: { input: attrS('1') } },
    ];
    const calls = [
      call('attempt', 1, {
        createdAt: '2026-10-15T07:00:00.000-04:00',
        usage: knownUsage,
        rates: knownRates,
      }),
      ...invalidCases.map((overrides, index) =>
        call('attempt', index + 2, {
          usage: knownUsage,
          rates: knownRates,
          ...overrides,
        }),
      ),
    ];
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({ Users: [user('owner')] }));
    const dynamoSend = readOnlyScan(header('owner', 'attempt'), ...calls);

    const response = await handleRequest(event(), dependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    expect(responseBody(response).bedrockCostUsd).toEqual(periods(0.000001));
    const row = (responseBody(response).users as Array<Record<string, unknown>>)[0];
    expect(row?.bedrockCostUsd).toEqual(periods(0.000001));
  });

  it('keeps global cost when Cognito is empty and calls have no surviving attempt header', async () => {
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({ Users: [] }));
    const dynamoSend = readOnlyScan(
      call('deleted-account-attempt', 1, {
        createdAt: '2026-10-15T10:00:00.000Z',
        usage: { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        rates: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    );

    const response = await handleRequest(event(), dependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toMatchObject({
      registeredUsers: 0,
      users: [],
      bedrockCostUsd: periods(0.000014),
    });
    expect(dynamoSend).toHaveBeenCalledTimes(1);
  });

  it('uses the last value for duplicate physical keys regardless of header and call order', async () => {
    const rates = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
    const cognitoSend = vi.fn(async (): Promise<UserPage> => ({ Users: [user('owner')] }));
    const dynamoSend = vi.fn(async (command: ScanCommandLike): Promise<ScanPage> => {
      const cursor = command.input.ExclusiveStartKey as Item | undefined;
      if (cursor === undefined) {
        return {
          Items: [
            call('duplicate-attempt', 1, {
              usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              rates,
            }),
            header('owner', 'duplicate-attempt', {
              createdAt: '2019-01-01T00:00:00.000Z',
              score: 1,
            }),
          ],
          LastEvaluatedKey: key('USER#owner', 'ATTEMPT#cursor'),
        };
      }
      return {
        Items: [
          header('owner', 'duplicate-attempt', {
            createdAt: '2026-10-15T11:00:00.000Z',
            score: 7,
          }),
          call('duplicate-attempt', 1, {
            createdAt: cutoff.toISOString(),
            usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            rates: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0 },
          }),
        ],
      };
    });

    const response = await handleRequest(event(), dependencies(cognitoSend, dynamoSend));

    expect(response.statusCode).toBe(200);
    expect(responseBody(response).bedrockCostUsd).toEqual(periods(0.000001));
    const row = (responseBody(response).users as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({
      attempts: periods(1),
      maxScore: 7,
      bedrockCostUsd: periods(0.000001),
    });
    expect(dynamoSend).toHaveBeenCalledTimes(2);
    expect(
      dynamoSend.mock.calls.every(([command]) => command.constructor.name === 'ScanCommand'),
    ).toBe(true);
  });
});
