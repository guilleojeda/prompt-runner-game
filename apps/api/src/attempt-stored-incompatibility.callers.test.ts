import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { captureLambdaStdout } from '../../../shared/testing/lambda-telemetry.js';
import {
  AttemptStoredIncompatibleError,
  createDynamoAttemptStore,
  MemoryAttemptStore,
  ReplayRecordError,
} from './attempt-store.js';
import { handleRequest } from './handler.js';

let lambdaStdout: ReturnType<typeof captureLambdaStdout>;

beforeEach(() => {
  lambdaStdout = captureLambdaStdout();
});

afterEach(() => {
  lambdaStdout.mockRestore();
});

const eventFor = (path: string): APIGatewayProxyEventV2 =>
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
            sub: 'owner',
            token_use: 'access',
            client_id: 'client',
            scope: 'prompt-runner/robot',
          },
        },
      },
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const dependencies = (attemptStore: MemoryAttemptStore) => ({
  store: { get: vi.fn(), put: vi.fn() },
  attemptStore,
  fetch: vi.fn(async () => new Response(JSON.stringify({ sub: 'owner', email_verified: true }))),
  clientId: 'client',
  userInfoUrl: 'https://cognito.example.test/userinfo',
});

type DynamoItem = Record<string, AttributeValue>;
type DynamoCommandLike = {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
};

class DynamoReadHarness {
  private readonly items = new Map<string, DynamoItem>();

  public readonly send = vi.fn((command: DynamoCommandLike) => {
    if (command.constructor.name !== 'GetItemCommand') {
      throw new Error(`Unexpected DynamoDB command ${command.constructor.name}.`);
    }
    const { PK, SK } = unmarshall(command.input.Key as DynamoItem) as { PK: string; SK: string };
    const item = this.items.get(`${PK}\u0000${SK}`);
    return Promise.resolve(item ? { Item: structuredClone(item) } : {});
  });

  public put(item: Record<string, unknown>): void {
    const { PK, SK } = item as { PK: string; SK: string };
    this.items.set(`${PK}\u0000${SK}`, marshall(item, { removeUndefinedValues: true }));
  }
}

const seedPersistedAttempt = async (mutateHeader: (header: Record<string, unknown>) => void) => {
  const draft = createDefaultDraft();
  const memoryStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
  const { attempt } = await memoryStore.admit({
    owner: 'owner',
    requestKey: 'stored-incompatibility-caller',
    expectedVersion: 1,
    draft,
    animationEnabled: false,
  });
  const record = await memoryStore.get('owner', attempt.id);
  if (!record) throw new Error('The memory fixture did not retain its attempt.');
  const { initialSnapshot, currentSnapshot, ...fields } = record;
  const header: Record<string, unknown> = {
    ...fields,
    PK: 'USER#owner',
    SK: `ATTEMPT#${attempt.id}`,
    initialStateId: 'state-0',
    currentStateId: 'state-0',
  };
  mutateHeader(header);
  const harness = new DynamoReadHarness();
  harness.put(header);
  harness.put({
    PK: `ATTEMPT#${attempt.id}`,
    SK: 'STATE#state-0',
    stateId: 'state-0',
    snapshot: currentSnapshot ?? initialSnapshot,
  });
  return { attemptId: attempt.id, harness };
};

describe('stored incompatibility classification preserves other callers', () => {
  it.each([
    [
      'stored configuration validation',
      (header: Record<string, unknown>) => {
        const config = header.config as Record<string, unknown>;
        header.config = { ...config, engineVersion: 'old-engine' };
      },
    ],
    [
      'summary projection validation',
      (header: Record<string, unknown>) => {
        header.status = 'defeat';
        header.reason = 'invalid-stored-reason';
      },
    ],
  ])('marks %s as stored data incompatibility at the parser boundary', async (_name, mutate) => {
    const { attemptId, harness } = await seedPersistedAttempt(mutate);
    const store = createDynamoAttemptStore({
      client: { send: harness.send } as unknown as DynamoDBClient,
      tableName: 'attempts',
    });

    await expect(store.get('owner', attemptId)).rejects.toBeInstanceOf(
      AttemptStoredIncompatibleError,
    );
  });

  it('keeps configuration reads on their existing sanitized 409 contract', async () => {
    const draft = createDefaultDraft();
    const store = new MemoryAttemptStore({ draft: { version: 1, draft } });
    vi.spyOn(store, 'get').mockRejectedValue(
      new AttemptStoredIncompatibleError('private stored attempt detail'),
    );

    const response = await handleRequest(
      eventFor('/attempts/attempt-1/configuration'),
      dependencies(store),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body ?? '{}')).toEqual({
      code: 'configuration_incompatible',
      message: 'La configuración del intento no es compatible con la versión actual.',
    });
    expect(response.body).not.toContain('private stored attempt detail');
  });

  it('keeps getReplayRecord translating the AttemptStoreError subtype to ReplayRecordError', async () => {
    const store = createDynamoAttemptStore({
      client: { send: vi.fn() } as unknown as DynamoDBClient,
      tableName: 'attempts',
    });
    vi.spyOn(store, 'get').mockRejectedValue(
      new AttemptStoredIncompatibleError('private stored attempt detail'),
    );

    await expect(store.getReplayRecord('owner', 'attempt-1')).rejects.toBeInstanceOf(
      ReplayRecordError,
    );
  });
});
