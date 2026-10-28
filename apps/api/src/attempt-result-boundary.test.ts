import {
  InternalServerError,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { captureLambdaStdout } from '../../../shared/testing/lambda-telemetry.js';
import { createDynamoAttemptStore, MemoryAttemptStore, S3BodyStore } from './attempt-store.js';
import { handleRequest } from './handler.js';

const NOW = '2026-10-28T12:00:00.000Z';
const PRIVATE_MARKER = 'PRIVATE_ATTEMPT_DRAFT_MARKER_PHASE16';

type Item = Record<string, AttributeValue>;
type CommandLike = {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
};

let lambdaStdout: ReturnType<typeof captureLambdaStdout>;

beforeEach(() => {
  lambdaStdout = captureLambdaStdout();
});

afterEach(() => {
  lambdaStdout.mockRestore();
});

class DynamoReadHarness {
  public readonly items = new Map<string, Item>();
  public readonly send = vi.fn((command: CommandLike) => this.handle(command));

  public put(value: Record<string, unknown>): void {
    const { PK, SK } = value as { PK: string; SK: string };
    this.items.set(`${PK}\u0000${SK}`, marshall(value, { removeUndefinedValues: true }));
  }

  private async handle(command: CommandLike): Promise<Record<string, unknown>> {
    if (command.constructor.name === 'GetItemCommand') {
      const { PK, SK } = unmarshall(command.input.Key as Item) as { PK: string; SK: string };
      const item = this.items.get(`${PK}\u0000${SK}`);
      return item ? { Item: structuredClone(item) } : {};
    }
    if (command.constructor.name === 'QueryCommand') {
      const values = unmarshall(command.input.ExpressionAttributeValues as Item) as {
        ':pk': string;
        ':prefix': string;
      };
      const Items = [...this.items.entries()]
        .filter(([key]) => {
          const [pk, sk] = key.split('\u0000');
          return pk === values[':pk'] && sk.startsWith(values[':prefix']);
        })
        .map(([, item]) => structuredClone(item));
      return { Items };
    }
    throw new Error(`Unexpected DynamoDB command ${command.constructor.name}.`);
  }
}

const createStoredAttempt = async (owner: string, terminal = false) => {
  const draft = { ...createDefaultDraft(), instructions: PRIVATE_MARKER };
  const memoryStore = new MemoryAttemptStore({
    draft: { version: 1, draft },
    now: () => new Date(NOW),
  });
  const { attempt } = await memoryStore.admit({
    owner,
    requestKey: `phase16-${owner}-${terminal ? 'terminal' : 'active'}`,
    expectedVersion: 1,
    draft,
    animationEnabled: false,
    now: NOW,
  });
  if (terminal)
    await memoryStore.close(owner, attempt.id, 'error', 'fixture_error', undefined, NOW);
  const record = await memoryStore.get(owner, attempt.id);
  if (!record) throw new Error('The memory fixture did not retain its attempt.');
  const summary = (await memoryStore.list(owner)).attempts.find(({ id }) => id === attempt.id);
  if (!summary) throw new Error('The memory fixture did not project its attempt.');
  const { initialSnapshot, currentSnapshot, ...persistedFields } = record;
  const header = {
    ...persistedFields,
    PK: `USER#${owner}`,
    SK: `ATTEMPT#${attempt.id}`,
    initialStateId: 'state-0',
    currentStateId: 'state-0',
  };
  const state = {
    PK: `ATTEMPT#${attempt.id}`,
    SK: 'STATE#state-0',
    stateId: 'state-0',
    snapshot: currentSnapshot ?? initialSnapshot,
  };
  return { draft, header, id: attempt.id, state, summary };
};

const eventFor = (path: string, sub = 'owner'): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: `GET ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { authorization: 'Bearer access-token' },
    requestContext: {
      http: { method: 'GET', path },
      requestId: 'request',
      authorizer: {
        jwt: {
          claims: {
            sub,
            token_use: 'access',
            client_id: 'client',
            scope: 'prompt-runner/robot',
          },
        },
      },
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const dependencies = (
  attemptStore: ReturnType<typeof createDynamoAttemptStore>,
  authenticatedOwner = 'owner',
) => ({
  store: { get: vi.fn(), put: vi.fn() },
  attemptStore,
  fetch: vi.fn(
    async () => new Response(JSON.stringify({ sub: authenticatedOwner, email_verified: true })),
  ),
  clientId: 'client',
  userInfoUrl: 'https://cognito.example.test/userinfo',
});

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const storeFor = (client: { send: unknown }, bodyStore?: S3BodyStore) =>
  createDynamoAttemptStore({
    client: client as unknown as DynamoDBClient,
    tableName: 'attempts',
    bodyStore,
    now: () => new Date(NOW),
  });

const seedAttempt = (
  harness: DynamoReadHarness,
  fixture: { header: Record<string, unknown>; state: Record<string, unknown> },
): void => {
  harness.put(fixture.header);
  harness.put(fixture.state);
};

describe('consulted attempt result backend boundary', () => {
  it('keeps the valid summary unchanged and preserves sanitized 404 for missing or foreign attempts', async () => {
    const valid = await createStoredAttempt('owner');
    const foreign = await createStoredAttempt('another-owner');
    const harness = new DynamoReadHarness();
    seedAttempt(harness, valid);
    seedAttempt(harness, foreign);
    const store = storeFor({ send: harness.send });
    const deps = dependencies(store);

    const success = await handleRequest(
      eventFor(`/attempts/${encodeURIComponent(valid.id)}`),
      deps,
    );
    expect(success.statusCode).toBe(200);
    expect(responseBody(success)).toEqual({ attempt: valid.summary });
    expect(JSON.stringify(responseBody(success))).not.toContain(PRIVATE_MARKER);

    for (const id of ['missing-attempt', foreign.id]) {
      const response = await handleRequest(eventFor(`/attempts/${encodeURIComponent(id)}`), deps);
      expect(response.statusCode, id).toBe(404);
      expect(responseBody(response), id).toEqual({
        code: 'not_found',
        message: 'Intento no encontrado.',
      });
      expect(JSON.stringify(responseBody(response)), id).not.toContain(id);
    }
  });

  it.each([2, 3])(
    'proposes a definitive sanitized response for stored record version %s',
    async (version) => {
      const fixture = await createStoredAttempt('owner');
      const harness = new DynamoReadHarness();
      seedAttempt(harness, { ...fixture, header: { ...fixture.header, recordVersion: version } });
      const response = await handleRequest(
        eventFor(`/attempts/${encodeURIComponent(fixture.id)}`),
        dependencies(storeFor({ send: harness.send })),
      );

      expect(response.statusCode).toBe(500);
      expect(responseBody(response)).toMatchObject({ code: 'stored_attempt_incompatible' });
      expect(JSON.stringify(responseBody(response))).not.toContain(PRIVATE_MARKER);
      expect(JSON.stringify(responseBody(response))).not.toContain('AttemptStoreError');
    },
  );

  it('proposes a definitive response when the persisted state reference is invalid', async () => {
    const fixture = await createStoredAttempt('owner');
    const harness = new DynamoReadHarness();
    seedAttempt(harness, {
      ...fixture,
      header: { ...fixture.header, currentStateId: 'state-1' },
    });
    const response = await handleRequest(
      eventFor(`/attempts/${encodeURIComponent(fixture.id)}`),
      dependencies(storeFor({ send: harness.send })),
    );

    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toMatchObject({ code: 'stored_attempt_incompatible' });
    expect(JSON.stringify(responseBody(response))).not.toContain(PRIVATE_MARKER);
  });

  it('proposes a definitive response when a referenced state row is missing', async () => {
    const fixture = await createStoredAttempt('owner');
    const harness = new DynamoReadHarness();
    harness.put(fixture.header);
    const response = await handleRequest(
      eventFor(`/attempts/${encodeURIComponent(fixture.id)}`),
      dependencies(storeFor({ send: harness.send })),
    );

    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toMatchObject({ code: 'stored_attempt_incompatible' });
    expect(JSON.stringify(responseBody(response))).not.toContain(PRIVATE_MARKER);
  });

  it('proposes a definitive response for an incompatible attempt header in the list', async () => {
    const fixture = await createStoredAttempt('owner');
    const harness = new DynamoReadHarness();
    harness.put({ ...fixture.header, recordVersion: 2 });
    const response = await handleRequest(
      eventFor('/attempts'),
      dependencies(storeFor({ send: harness.send })),
    );

    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toMatchObject({ code: 'stored_attempt_incompatible' });
    expect(JSON.stringify(responseBody(response))).not.toContain(PRIVATE_MARKER);
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send.mock.calls[0]?.[0].constructor.name).toBe('QueryCommand');
  });

  it('preserves a temporary response for a real DynamoDB Query service error', async () => {
    const serviceFailure = new InternalServerError({
      message: 'private query service detail',
      $metadata: { httpStatusCode: 500 },
    });
    const send = vi.fn().mockRejectedValue(serviceFailure);
    const response = await handleRequest(eventFor('/attempts'), dependencies(storeFor({ send })));

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toMatchObject({ code: 'dependency_unavailable' });
    expect(JSON.stringify(responseBody(response))).not.toContain('private query service detail');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].constructor.name).toBe('QueryCommand');
  });

  it('proposes a definitive response for a stored draft rejected by its current parser', async () => {
    const fixture = await createStoredAttempt('owner');
    const harness = new DynamoReadHarness();
    seedAttempt(harness, {
      ...fixture,
      header: {
        ...fixture.header,
        draft: { ...fixture.draft, catalogVersion: 0 },
      },
    });
    const response = await handleRequest(
      eventFor(`/attempts/${encodeURIComponent(fixture.id)}`),
      dependencies(storeFor({ send: harness.send })),
    );

    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toMatchObject({ code: 'stored_attempt_incompatible' });
    expect(JSON.stringify(responseBody(response))).not.toContain(PRIVATE_MARKER);
  });

  it.each([
    [
      'DynamoDB InternalServerError',
      new InternalServerError({
        message: 'private service detail',
        $metadata: { httpStatusCode: 500 },
      }),
    ],
    [
      'DynamoDB timeout',
      Object.assign(new Error('private transport detail'), {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
      }),
    ],
  ])('keeps %s as a temporary server response', async (_label, error) => {
    const send = vi.fn().mockRejectedValue(error);
    const response = await handleRequest(
      eventFor('/attempts/temporary-failure'),
      dependencies(storeFor({ send })),
    );

    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toEqual({
      code: 'internal',
      message: 'Ocurrió un error inesperado.',
    });
    expect(JSON.stringify(responseBody(response))).not.toContain('private');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps private-body storage failure as a temporary dependency response', async () => {
    const fixture = await createStoredAttempt('owner', true);
    const harness = new DynamoReadHarness();
    seedAttempt(harness, fixture);
    harness.put({
      PK: `ATTEMPT#${fixture.id}`,
      SK: 'CALL#00000001',
      attemptId: fixture.id,
      seq: 1,
      status: 'invalid',
      responseKey: 'private/response.json',
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        gameTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    });
    const privateStoreError = Object.assign(new Error('private S3 endpoint detail'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
    });
    const s3Send = vi.fn().mockRejectedValue(privateStoreError);
    const bodyStore = new S3BodyStore({
      client: { send: s3Send } as unknown as S3Client,
      bucket: 'attempt-bodies',
    });
    const response = await handleRequest(
      eventFor(`/attempts/${encodeURIComponent(fixture.id)}`),
      dependencies(storeFor({ send: harness.send }, bodyStore)),
    );

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toEqual({
      code: 'dependency_unavailable',
      message: 'No se pudo leer el cuerpo privado.',
    });
    expect(JSON.stringify(responseBody(response))).not.toContain('private S3 endpoint detail');
    expect(s3Send).toHaveBeenCalledOnce();
  });
});
