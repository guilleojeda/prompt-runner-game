import {
  InternalServerError,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { captureLambdaStdout } from '../../../shared/testing/lambda-telemetry.js';
import type { AttemptStore } from '../../../shared/server/attempt.js';
import {
  AttemptStoreError,
  createDynamoAttemptStore,
  MemoryAttemptStore,
} from './attempt-store.js';
import { handleRequest } from './handler.js';

const PRIVATE_MARKER = 'PRIVATE_CONFIGURATION_MARKER_PHASE17';
const NOW = '2026-10-28T12:00:00.000Z';

type DynamoItem = Record<string, AttributeValue>;
type DynamoCommandLike = {
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

const eventFor = (path: string, owner = 'owner'): APIGatewayProxyEventV2 =>
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
            sub: owner,
            token_use: 'access',
            client_id: 'client',
            scope: 'prompt-runner/robot',
          },
        },
      },
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const dependencies = (attemptStore: AttemptStore) => ({
  store: { get: vi.fn(), put: vi.fn() },
  attemptStore,
  fetch: vi.fn(async () => new Response(JSON.stringify({ sub: 'owner', email_verified: true }))),
  clientId: 'client',
  userInfoUrl: 'https://cognito.example.test/userinfo',
});

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const seedIncompatibleConfiguration = async (): Promise<{
  readonly attemptId: string;
  readonly harness: DynamoReadHarness;
}> => {
  const draft = { ...createDefaultDraft(), instructions: PRIVATE_MARKER };
  const memoryStore = new MemoryAttemptStore({
    draft: { version: 1, draft },
    now: () => new Date(NOW),
  });
  const { attempt } = await memoryStore.admit({
    owner: 'owner',
    requestKey: 'phase17-configuration',
    expectedVersion: 1,
    draft,
    animationEnabled: false,
    now: NOW,
  });
  const record = await memoryStore.get('owner', attempt.id);
  if (!record) throw new Error('The memory fixture did not retain its attempt.');
  const { initialSnapshot, currentSnapshot, ...fields } = record;
  const harness = new DynamoReadHarness();
  harness.put({
    ...fields,
    PK: 'USER#owner',
    SK: `ATTEMPT#${attempt.id}`,
    initialStateId: 'state-0',
    currentStateId: 'state-0',
    config: { ...record.config, engineVersion: 'old-engine' },
  });
  harness.put({
    PK: `ATTEMPT#${attempt.id}`,
    SK: 'STATE#state-0',
    stateId: 'state-0',
    snapshot: currentSnapshot ?? initialSnapshot,
  });
  return { attemptId: attempt.id, harness };
};

describe('attempt configuration API boundary proposal', () => {
  it('keeps running configuration pending without dispatch, admission, expiry closure, or body reads', async () => {
    const draft = createDefaultDraft();
    const bodyStore = { get: vi.fn(), put: vi.fn() };
    const attemptStore = new MemoryAttemptStore({
      draft: { version: 1, draft },
      bodyStore,
      now: () => new Date(NOW),
    });
    const { attempt } = await attemptStore.admit({
      owner: 'owner',
      requestKey: 'phase17-running',
      expectedVersion: 1,
      draft,
      animationEnabled: false,
      now: NOW,
    });
    await attemptStore.claim('owner', attempt.id, 'executor', NOW);

    const admit = vi.spyOn(attemptStore, 'admit');
    const get = vi.spyOn(attemptStore, 'get');
    const closeExpired = vi.spyOn(attemptStore, 'closeExpired');
    const getSnapshot = vi.spyOn(attemptStore, 'getSnapshot');
    const getCalls = vi.spyOn(attemptStore, 'getCalls');
    const getReplayRecord = vi.spyOn(attemptStore, 'getReplayRecord');
    const dispatch = vi.fn();
    const deps = { ...dependencies(attemptStore), dispatch };

    const response = await handleRequest(
      eventFor(`/attempts/${encodeURIComponent(attempt.id)}/configuration`),
      deps,
    );

    expect(response.statusCode).toBe(409);
    expect(responseBody(response)).toEqual({
      code: 'configuration_pending',
      message: 'La configuración solo está disponible para un intento cerrado.',
    });
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('owner', attempt.id);
    expect(admit).not.toHaveBeenCalled();
    expect(closeExpired).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(getCalls).not.toHaveBeenCalled();
    expect(getReplayRecord).not.toHaveBeenCalled();
    expect(bodyStore.get).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a real stored configuration incompatibility sanitized as 409', async () => {
    const { attemptId, harness } = await seedIncompatibleConfiguration();
    const attemptStore = createDynamoAttemptStore({
      client: { send: harness.send } as unknown as DynamoDBClient,
      tableName: 'attempts',
      now: () => new Date(NOW),
    });

    const response = await handleRequest(
      eventFor(`/attempts/${encodeURIComponent(attemptId)}/configuration`),
      dependencies(attemptStore),
    );

    expect(response.statusCode).toBe(409);
    expect(responseBody(response)).toEqual({
      code: 'configuration_incompatible',
      message: 'La configuración del intento no es compatible con la versión actual.',
    });
    expect(response.body).not.toContain(PRIVATE_MARKER);
    expect(response.body).not.toContain('old-engine');
  });

  it('keeps a general AttemptStoreError on the temporary dependency fallback', async () => {
    const draft = createDefaultDraft();
    const attemptStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
    vi.spyOn(attemptStore, 'get').mockRejectedValue(
      new AttemptStoreError('No se pudo consultar el intento.'),
    );

    const response = await handleRequest(
      eventFor('/attempts/attempt-1/configuration'),
      dependencies(attemptStore),
    );

    expect.soft(response.statusCode).toBe(503);
    expect.soft(responseBody(response)).toEqual({
      code: 'dependency_unavailable',
      message: 'No se pudo consultar el intento.',
    });
  });

  it('does not classify an unknown get error as configuration incompatibility', async () => {
    const draft = createDefaultDraft();
    const attemptStore = new MemoryAttemptStore({ draft: { version: 1, draft } });
    vi.spyOn(attemptStore, 'get').mockRejectedValue(new Error('private unknown failure'));

    const response = await handleRequest(
      eventFor('/attempts/attempt-1/configuration'),
      dependencies(attemptStore),
    );

    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toEqual({
      code: 'internal',
      message: 'Ocurrió un error inesperado.',
    });
    expect(response.body).not.toContain('private unknown failure');
  });

  it('keeps a raw DynamoDB SDK get failure on the existing temporary 500 response', async () => {
    const serviceError = new InternalServerError({
      message: 'private DynamoDB get detail',
      $metadata: { httpStatusCode: 500 },
    });
    const attemptStore = createDynamoAttemptStore({
      client: { send: vi.fn().mockRejectedValue(serviceError) } as unknown as DynamoDBClient,
      tableName: 'attempts',
    });

    const response = await handleRequest(
      eventFor('/attempts/attempt-1/configuration'),
      dependencies(attemptStore),
    );

    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toEqual({
      code: 'internal',
      message: 'Ocurrió un error inesperado.',
    });
    expect(response.body).not.toContain('private DynamoDB get detail');
  });
});
