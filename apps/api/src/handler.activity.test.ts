import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot';
import type { DraftStore } from './draft';
import { handleRequest } from './handler';
import type { SavedRobotStore } from './saved-robots';

const TABLE = 'game-table';
const NOW = '2026-10-01T00:00:00.000Z';
const SNAPSHOT = {
  version: 3,
  updatedAt: '2026-09-30T09:00:00.000Z',
  draft: createDefaultDraft(),
};

const identity = {
  sub: 'user-a',
  token_use: 'access',
  client_id: 'client-1',
  scope: 'openid email prompt-runner/robot',
};

type DynamoCommand = {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
};

type Item = Record<string, AttributeValue>;

const eventFor = (
  options: {
    method?: 'GET' | 'PUT';
    path?: string;
    body?: string;
    claims?: Record<string, unknown>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): APIGatewayProxyEventV2 => {
  const method = options.method ?? 'GET';
  const path = options.path ?? '/draft';
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { authorization: 'Bearer access-token', ...options.headers },
    queryStringParameters: options.query,
    requestContext: {
      http: { method, path },
      requestId: 'request',
      authorizer: { jwt: { claims: options.claims ?? identity } },
    },
    body: options.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
};

const userInfoFetch = (
  value: Record<string, unknown> = { sub: 'user-a', email_verified: true },
  status = 200,
) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

const dependencies = (fetch = userInfoFetch()) => ({ fetch });

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const unixSeconds = (isoTimestamp: string): number => Date.parse(isoTimestamp) / 1_000;

const itemFrom = (value: unknown): Record<string, unknown> =>
  unmarshall(value as Item) as Record<string, unknown>;

/** A narrow SDK spy for the public API handler: draft reads plus activity updates only. */
class ApiDynamoSpy {
  public readonly requests: DynamoCommand[] = [];
  public readonly activity = new Map<string, string>();
  public updateFailure: unknown;
  public draftReadFailure: unknown;
  public updateNeverResolves = false;

  public constructor() {
    vi.spyOn(DynamoDBClient.prototype, 'send').mockImplementation(
      async (command, options) =>
        this.handle(
          command as unknown as DynamoCommand,
          options as { readonly abortSignal?: AbortSignal } | undefined,
        ) as never,
    );
  }

  public calls(name: string): DynamoCommand[] {
    return this.requests.filter((request) => request.constructor.name === name);
  }

  public lastLoginAt(sub: string): string | undefined {
    return this.activity.get(`USER#${sub}\u0000ACTIVITY`);
  }

  private async handle(
    command: DynamoCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    this.requests.push(command);
    const { input } = command;
    if (command.constructor.name === 'GetItemCommand') {
      if (this.draftReadFailure !== undefined) throw this.draftReadFailure;
      const key = itemFrom(input.Key);
      if (typeof key.PK !== 'string' || !key.PK.startsWith('USER#') || key.SK !== 'DRAFT') {
        throw new Error('Unexpected GetItem key in activity acceptance test.');
      }
      return {
        Item: marshall({
          PK: key.PK,
          SK: key.SK,
          ...SNAPSHOT,
        }),
      };
    }
    if (command.constructor.name === 'UpdateItemCommand') {
      if (this.updateFailure !== undefined) throw this.updateFailure;
      if (this.updateNeverResolves) {
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) return;
          const rejectForAbort = () =>
            reject(signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
          if (signal.aborted) {
            rejectForAbort();
            return;
          }
          signal.addEventListener('abort', rejectForAbort, { once: true });
        });
      }
      const key = itemFrom(input.Key);
      if (typeof key.PK !== 'string' || key.SK !== 'ACTIVITY') {
        throw new Error('Unexpected UpdateItem key in activity acceptance test.');
      }
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      const values = input.ExpressionAttributeValues
        ? (unmarshall(input.ExpressionAttributeValues as Item) as Record<string, unknown>)
        : {};
      const assignment = String(input.UpdateExpression).match(/(?:#\w+|lastLoginAt)\s*=\s*(:\w+)/);
      const fieldToken = String(input.UpdateExpression).match(/(#\w+|lastLoginAt)\s*=/)?.[1];
      const field = fieldToken ? (names[fieldToken] ?? fieldToken) : undefined;
      const candidate = assignment ? values[assignment[1]] : undefined;
      if (field !== 'lastLoginAt' || typeof candidate !== 'string') {
        throw new Error('Activity update must set lastLoginAt to an ISO timestamp.');
      }

      const mapKey = `${key.PK}\u0000ACTIVITY`;
      const previous = this.activity.get(mapKey);
      if (previous !== undefined && previous >= candidate) {
        throw new ConditionalCheckFailedException({
          message: 'Activity timestamp must increase.',
          $metadata: {},
        });
      }
      this.activity.set(mapKey, candidate);
      return {};
    }
    throw new Error(`Unexpected DynamoDB command ${command.constructor.name}.`);
  }
}

const normalizedExpression = (input: Record<string, unknown>, expressionName: string): string => {
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  const values = input.ExpressionAttributeValues
    ? (unmarshall(input.ExpressionAttributeValues as Item) as Record<string, unknown>)
    : {};
  return String(input[expressionName])
    .replace(/#[\w]+/g, (token) => names[token] ?? token)
    .replace(/:[\w]+/g, (token) =>
      Object.prototype.hasOwnProperty.call(values, token) ? JSON.stringify(values[token]) : token,
    )
    .replace(/\s+/g, ' ')
    .trim();
};

const expectActivityUpdate = (request: DynamoCommand, sub: string, timestamp: string): void => {
  expect(request.input.TableName).toBe(TABLE);
  expect(itemFrom(request.input.Key)).toEqual({ PK: `USER#${sub}`, SK: 'ACTIVITY' });
  expect(normalizedExpression(request.input, 'UpdateExpression')).toBe(
    `SET lastLoginAt = ${JSON.stringify(timestamp)}`,
  );

  const condition = normalizedExpression(request.input, 'ConditionExpression')
    .replace(/\s+/g, '')
    .toUpperCase();
  const missing = 'ATTRIBUTE_NOT_EXISTS(LASTLOGINAT)';
  const strictlyEarlier = `LASTLOGINAT<${JSON.stringify(timestamp).toUpperCase()}`;
  expect([
    `${missing}OR${strictlyEarlier}`,
    `${strictlyEarlier}OR${missing}`,
    `(${missing}OR${strictlyEarlier})`,
    `(${strictlyEarlier}OR${missing})`,
  ]).toContain(condition);
};

const expectSuccessfulDraftRead = (
  response: { statusCode?: number; body?: string },
  dynamo: ApiDynamoSpy,
  sub = 'user-a',
): void => {
  expect(response.statusCode).toBe(200);
  expect(responseBody(response)).toEqual(SNAPSHOT);
  const read = dynamo.calls('GetItemCommand').at(-1);
  expect(read?.input.TableName).toBe(TABLE);
  expect(itemFrom(read?.input.Key)).toEqual({ PK: `USER#${sub}`, SK: 'DRAFT' });
};

let dynamo: ApiDynamoSpy;

beforeEach(() => {
  vi.stubEnv('DRAFT_TABLE_NAME', TABLE);
  vi.stubEnv('COGNITO_CLIENT_ID', 'client-1');
  vi.stubEnv('COGNITO_USERINFO_URL', 'https://cognito.example.test/userinfo');
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  dynamo = new ApiDynamoSpy();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET /draft login activity acceptance', () => {
  it.each([
    {
      label: 'numeric auth_time',
      authTime: unixSeconds('2026-09-30T12:34:56.000Z'),
      expected: '2026-09-30T12:34:56.000Z',
    },
    {
      label: 'decimal string auth_time',
      authTime: String(unixSeconds('2026-09-30T12:34:56.000Z')),
      expected: '2026-09-30T12:34:56.000Z',
    },
  ])('stores verified authorizer $label as a UTC ISO date', async ({ authTime, expected }) => {
    const sub = 'account-42';
    const response = await handleRequest(
      eventFor({ claims: { ...identity, sub, auth_time: authTime, iat: unixSeconds(NOW) - 2 } }),
      dependencies(userInfoFetch({ sub, email_verified: true })),
    );

    expectSuccessfulDraftRead(response, dynamo, sub);
    const updates = dynamo.calls('UpdateItemCommand');
    expect(updates).toHaveLength(1);
    expectActivityUpdate(updates[0], sub, expected);
    expect(dynamo.lastLoginAt(sub)).toBe(expected);
    expect(dynamo.calls('PutItemCommand')).toHaveLength(0);
    expect(dynamo.calls('DeleteItemCommand')).toHaveLength(0);
    expect(dynamo.calls('TransactWriteItemsCommand')).toHaveLength(0);
  });

  it('keeps the greatest authentication time for repeats, refreshes, and old sessions', async () => {
    const sub = 'account-42';
    const earlier = unixSeconds('2026-09-30T10:00:00.000Z');
    const later = unixSeconds('2026-09-30T11:00:00.000Z');
    const latest = unixSeconds('2026-09-30T12:00:00.000Z');
    const sessions = [
      { auth_time: later, iat: later },
      { auth_time: later, iat: later + 10 },
      { auth_time: String(later), iat: later + 20 },
      { auth_time: earlier, iat: later + 30 },
      { auth_time: latest, iat: latest },
    ];

    for (const session of sessions) {
      const response = await handleRequest(
        eventFor({ claims: { ...identity, sub, ...session } }),
        dependencies(userInfoFetch({ sub, email_verified: true })),
      );
      expectSuccessfulDraftRead(response, dynamo, sub);
    }

    const updates = dynamo.calls('UpdateItemCommand');
    expect(updates).toHaveLength(sessions.length);
    [later, later, later, earlier, latest].forEach((seconds, index) =>
      expectActivityUpdate(updates[index], sub, new Date(seconds * 1_000).toISOString()),
    );
    expect(dynamo.lastLoginAt(sub)).toBe(new Date(latest * 1_000).toISOString());
  });

  it('keeps activity rows isolated by validated subject', async () => {
    const sessions = [
      { sub: 'account-a', authTime: unixSeconds('2026-09-30T10:00:00.000Z') },
      { sub: 'account-b', authTime: unixSeconds('2026-09-30T11:00:00.000Z') },
      { sub: 'account-a', authTime: unixSeconds('2026-09-30T12:00:00.000Z') },
    ];

    for (const session of sessions) {
      const response = await handleRequest(
        eventFor({
          claims: { ...identity, sub: session.sub, auth_time: session.authTime },
        }),
        dependencies(userInfoFetch({ sub: session.sub, email_verified: true })),
      );
      expectSuccessfulDraftRead(response, dynamo, session.sub);
    }

    const updates = dynamo.calls('UpdateItemCommand');
    expect(updates).toHaveLength(sessions.length);
    sessions.forEach(({ sub, authTime }, index) =>
      expectActivityUpdate(updates[index], sub, new Date(authTime * 1_000).toISOString()),
    );
    expect(dynamo.lastLoginAt('account-a')).toBe('2026-09-30T12:00:00.000Z');
    expect(dynamo.lastLoginAt('account-b')).toBe('2026-09-30T11:00:00.000Z');
  });

  it('does not record activity on draft saves or other authenticated routes', async () => {
    const draftStore: DraftStore = {
      get: vi.fn().mockResolvedValue(SNAPSHOT),
      put: vi.fn().mockResolvedValue(SNAPSHOT),
    };
    const save = await handleRequest(
      eventFor({
        method: 'PUT',
        body: JSON.stringify({ expectedVersion: 3, draft: createDefaultDraft() }),
        claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') },
      }),
      { ...dependencies(), store: draftStore },
    );
    expect(save.statusCode).toBe(200);
    expect(draftStore.put).toHaveBeenCalledTimes(1);

    const savedRobotStore: SavedRobotStore = {
      list: vi.fn().mockResolvedValue({ robots: [] }),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const list = await handleRequest(
      eventFor({
        path: '/robots',
        claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') },
      }),
      { ...dependencies(), savedRobotStore },
    );
    expect(list.statusCode).toBe(200);
    expect(savedRobotStore.list).toHaveBeenCalledWith('user-a', undefined, 20);
    expect(dynamo.calls('UpdateItemCommand')).toHaveLength(0);
    expect(dynamo.requests).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty string', ''],
    ['unreadable string', 'yesterday'],
    ['object', { seconds: unixSeconds('2026-09-30T12:00:00.000Z') }],
    ['negative number', -1],
    ['negative decimal string', '-1'],
    ['fractional number', unixSeconds('2026-09-30T12:00:00.000Z') + 0.5],
    ['fractional decimal string', `${unixSeconds('2026-09-30T12:00:00.000Z')}.5`],
    ['future number', unixSeconds(NOW) + 1],
    ['future decimal string', String(unixSeconds(NOW) + 1)],
  ])('ignores %s auth_time and still returns the draft', async (_label, authTime) => {
    const claims: Record<string, unknown> = { ...identity, iat: unixSeconds(NOW) - 1 };
    if (authTime !== undefined) claims.auth_time = authTime;
    const response = await handleRequest(
      eventFor({ claims }),
      dependencies(userInfoFetch({ sub: 'user-a', email_verified: true })),
    );

    expectSuccessfulDraftRead(response, dynamo);
    expect(dynamo.calls('UpdateItemCommand')).toHaveLength(0);
    expect(dynamo.lastLoginAt('user-a')).toBeUndefined();
  });

  it('uses authorizer sub and auth_time even when the request contains a different auth_time', async () => {
    const sub = 'verified-sub';
    const expected = '2026-09-30T12:34:56.000Z';
    const response = await handleRequest(
      eventFor({
        claims: {
          ...identity,
          sub,
          auth_time: String(unixSeconds(expected)),
          iat: unixSeconds(NOW) - 1,
        },
        query: { auth_time: String(unixSeconds('2026-09-30T20:00:00.000Z')) },
        headers: { 'x-auth-time': String(unixSeconds('2026-09-30T21:00:00.000Z')) },
      }),
      dependencies(userInfoFetch({ sub, email_verified: true })),
    );

    expectSuccessfulDraftRead(response, dynamo, sub);
    const updates = dynamo.calls('UpdateItemCommand');
    expect(updates).toHaveLength(1);
    expectActivityUpdate(updates[0], sub, expected);
    expect(dynamo.lastLoginAt(sub)).toBe(expected);
    expect(
      dynamo.requests.some((request) => itemFrom(request.input.Key).PK === 'USER#user-a'),
    ).toBe(false);
  });

  it.each([
    {
      label: 'non-access token',
      claims: { ...identity, token_use: 'id', auth_time: unixSeconds('2026-09-30T12:00:00.000Z') },
      info: { sub: 'user-a', email_verified: true },
      headers: undefined,
      statusCode: 403,
    },
    {
      label: 'blank authorizer subject',
      claims: { ...identity, sub: ' ', auth_time: unixSeconds('2026-09-30T12:00:00.000Z') },
      info: { sub: 'user-a', email_verified: true },
      headers: undefined,
      statusCode: 403,
    },
    {
      label: 'wrong application client',
      claims: {
        ...identity,
        client_id: 'another-client',
        auth_time: unixSeconds('2026-09-30T12:00:00.000Z'),
      },
      info: { sub: 'user-a', email_verified: true },
      headers: undefined,
      statusCode: 403,
    },
    {
      label: 'missing application scope',
      claims: {
        ...identity,
        scope: 'openid email',
        auth_time: unixSeconds('2026-09-30T12:00:00.000Z'),
      },
      info: { sub: 'user-a', email_verified: true },
      headers: undefined,
      statusCode: 403,
    },
    {
      label: 'unverified account',
      claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') },
      info: { sub: 'user-a', email_verified: false },
      headers: undefined,
      statusCode: 403,
    },
    {
      label: 'identity mismatch',
      claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') },
      info: { sub: 'other-user', email_verified: true },
      headers: undefined,
      statusCode: 403,
    },
    {
      label: 'missing bearer token',
      claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') },
      info: { sub: 'user-a', email_verified: true },
      headers: { authorization: '' },
      statusCode: 401,
    },
  ])('does not persist activity for $label', async ({ claims, info, headers, statusCode }) => {
    const fetch = userInfoFetch(info);
    const response = await handleRequest(eventFor({ claims, headers }), dependencies(fetch));

    expect(response.statusCode).toBe(statusCode);
    expect(dynamo.calls('UpdateItemCommand')).toHaveLength(0);
    expect(dynamo.requests).toHaveLength(0);
    if (
      claims.token_use === 'id' ||
      claims.sub.trim() === '' ||
      claims.client_id !== 'client-1' ||
      claims.scope === 'openid email'
    ) {
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('rejects a request-supplied sub before touching DynamoDB', async () => {
    const fetch = userInfoFetch();
    const response = await handleRequest(
      eventFor({
        claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') },
        query: { sub: 'attacker', auth_time: String(unixSeconds('2026-09-30T20:00:00.000Z')) },
      }),
      dependencies(fetch),
    );

    expect(response.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(dynamo.requests).toHaveLength(0);
  });

  it('records verified authentication before the draft read can fail', async () => {
    dynamo.draftReadFailure = new Error('Draft table unavailable');
    const response = await handleRequest(
      eventFor({ claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') } }),
      dependencies(),
    );

    expect(response.statusCode).toBe(503);
    expect(responseBody(response).code).toBe('dependency_unavailable');
    expect(dynamo.requests.map((request) => request.constructor.name)).toEqual([
      'UpdateItemCommand',
      'GetItemCommand',
    ]);
    expectActivityUpdate(
      dynamo.calls('UpdateItemCommand')[0],
      'user-a',
      '2026-09-30T12:00:00.000Z',
    );
    expect(dynamo.lastLoginAt('user-a')).toBe('2026-09-30T12:00:00.000Z');
  });

  it.each([
    ['storage error', new Error('DynamoDB unavailable')],
    [
      'conditional conflict',
      new ConditionalCheckFailedException({ message: 'Already updated.', $metadata: {} }),
    ],
  ])('keeps GET /draft successful after an activity %s', async (_label, failure) => {
    dynamo.updateFailure = failure;
    const response = await handleRequest(
      eventFor({ claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') } }),
      dependencies(),
    );

    expectSuccessfulDraftRead(response, dynamo);
    expect(dynamo.calls('UpdateItemCommand')).toHaveLength(1);
    expectActivityUpdate(
      dynamo.calls('UpdateItemCommand')[0],
      'user-a',
      '2026-09-30T12:00:00.000Z',
    );
  });

  it('returns the draft when the activity write never answers, before the API timeout', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
        milliseconds,
      );
      return controller.signal;
    });
    dynamo.updateNeverResolves = true;
    const pending = handleRequest(
      eventFor({ claims: { ...identity, auth_time: unixSeconds('2026-09-30T12:00:00.000Z') } }),
      dependencies(),
    );
    let response: Awaited<typeof pending> | undefined;
    void pending.then((result) => {
      response = result;
    });

    await vi.advanceTimersByTimeAsync(14_999);

    expect(response).toBeDefined();
    if (response) expectSuccessfulDraftRead(response, dynamo);
    expect(dynamo.calls('UpdateItemCommand')).toHaveLength(1);
    expect(dynamo.calls('GetItemCommand')).toHaveLength(1);
  });
});
