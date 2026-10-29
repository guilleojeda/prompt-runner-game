import {
  InternalServerError,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { captureLambdaStdout } from '../../../shared/testing/lambda-telemetry.js';
import {
  AttemptStoredIncompatibleError,
  AttemptStoreError,
  createDynamoAttemptStore,
  MemoryAttemptStore,
  MemoryBodyStore,
} from './attempt-store.js';
import { handleRequest } from './handler.js';

const OWNER = 'owner';
const PRIVATE_MARKER = 'private-decisions-read-recovery-fixture';

type DecisionRead = Readonly<{
  readonly name: 'index' | 'detail';
  readonly path: (attemptId: string) => string;
  readonly decisionNumber?: string;
}>;

const reads: readonly DecisionRead[] = [
  { name: 'index', path: (attemptId) => `/attempts/${encodeURIComponent(attemptId)}/decisions` },
  {
    name: 'detail',
    path: (attemptId) => `/attempts/${encodeURIComponent(attemptId)}/decisions`,
    decisionNumber: '1',
  },
];

let lambdaStdout: ReturnType<typeof captureLambdaStdout>;

beforeEach(() => {
  lambdaStdout = captureLambdaStdout();
});

afterEach(() => {
  lambdaStdout.mockRestore();
  vi.restoreAllMocks();
});

const eventFor = (read: DecisionRead, attemptId: string, sub = OWNER): APIGatewayProxyEventV2 => {
  const path = read.path(attemptId);
  return {
    version: '2.0',
    routeKey: `GET ${path}`,
    rawPath: path,
    rawQueryString: read.decisionNumber === undefined ? '' : `decision=${read.decisionNumber}`,
    headers: { authorization: 'Bearer access-token' },
    queryStringParameters:
      read.decisionNumber === undefined ? undefined : { decision: read.decisionNumber },
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
  } as unknown as APIGatewayProxyEventV2;
};

const dependencies = (
  attemptStore: MemoryAttemptStore | ReturnType<typeof createDynamoAttemptStore>,
  dispatch = vi.fn(),
  bodyStore = new MemoryBodyStore(),
) => ({
  store: { get: vi.fn(), put: vi.fn() },
  attemptStore,
  bodyStore,
  dispatch,
  fetch: vi.fn(async () => new Response(JSON.stringify({ sub: OWNER, email_verified: true }))),
  clientId: 'client',
  userInfoUrl: 'https://cognito.example.test/userinfo',
});

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const createStore = (bodyStore?: MemoryBodyStore): MemoryAttemptStore => {
  const draft = { ...createDefaultDraft(), instructions: PRIVATE_MARKER };
  return new MemoryAttemptStore({
    draft: { version: 1, draft },
    ...(bodyStore ? { bodyStore } : {}),
  });
};

const admitAttempt = async (store: MemoryAttemptStore, requestKey: string) => {
  const draft = { ...createDefaultDraft(), instructions: PRIVATE_MARKER };
  const admitted = await store.admit({
    owner: OWNER,
    requestKey,
    expectedVersion: 1,
    draft,
    animationEnabled: false,
  });
  return admitted.attempt;
};

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

  public put(value: Record<string, unknown>): void {
    const { PK, SK } = value as { PK: string; SK: string };
    this.items.set(`${PK}\u0000${SK}`, marshall(value, { removeUndefinedValues: true }));
  }
}

const createIncompatibleDynamoStore = async () => {
  const memory = createStore();
  const attempt = await admitAttempt(memory, 'decisions-incompatible-parser');
  const record = await memory.get(OWNER, attempt.id);
  if (!record) throw new Error('The memory fixture did not retain its attempt.');
  const { initialSnapshot, currentSnapshot, ...fields } = record;
  const config = fields.config as Record<string, unknown>;
  const header: Record<string, unknown> = {
    ...fields,
    config: { ...config, engineVersion: PRIVATE_MARKER },
    PK: `USER#${OWNER}`,
    SK: `ATTEMPT#${attempt.id}`,
    initialStateId: 'state-0',
    currentStateId: 'state-0',
  };
  const harness = new DynamoReadHarness();
  harness.put(header);
  harness.put({
    PK: `ATTEMPT#${attempt.id}`,
    SK: 'STATE#state-0',
    stateId: 'state-0',
    snapshot: currentSnapshot ?? initialSnapshot,
  });
  const store = createDynamoAttemptStore({
    client: { send: harness.send } as unknown as DynamoDBClient,
    tableName: 'attempts',
  });
  return { attemptId: attempt.id, harness, store };
};

const createIncompleteTerminalAttempt = async (store: MemoryAttemptStore) => {
  const attempt = await admitAttempt(store, 'decisions-replay-record-incomplete');
  await store.claim(OWNER, attempt.id, 'executor');
  const record = await store.get(OWNER, attempt.id);
  if (!record) throw new Error('The memory fixture did not retain its attempt.');
  const now = '2026-10-28T12:00:00.000Z';
  await store.beginCall(OWNER, attempt.id, 'executor', {
    attemptId: attempt.id,
    seq: 1,
    decisionId: `${attempt.id}-decision-1`,
    requestKey: `attempt/${attempt.id}/request.json`,
    responseKey: `attempt/${attempt.id}/response.json`,
    requestSha256: 'a'.repeat(64),
    requestBytes: 1,
    status: 'started',
    usage: {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      gameTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    },
    modelKey: record.config.model.key,
    modelId: record.config.model.modelId,
    region: record.config.model.region,
    profileVersion: record.config.model.profileVersion,
    createdAt: now,
    updatedAt: now,
  });
  await store.close(OWNER, attempt.id, 'error', 'fixture_incomplete', 'executor', now);
  return attempt.id;
};

describe('decision read recovery API acceptance', () => {
  it.each(reads)(
    'keeps $name pending reads pending and free of execution side effects',
    async (read) => {
      const store = createStore();
      const attempt = await admitAttempt(store, `decisions-pending-${read.name}`);
      const dispatch = vi.fn();
      const deps = dependencies(store, dispatch);
      const claim = vi.spyOn(store, 'claim');
      const close = vi.spyOn(store, 'close');
      const closeExpired = vi.spyOn(store, 'closeExpired');
      const cancel = vi.spyOn(store, 'requestCancel');
      const beginCall = vi.spyOn(store, 'beginCall');
      const finishCall = vi.spyOn(store, 'finishCall');
      const publishAction = vi.spyOn(store, 'publishAction');
      const admit = vi.spyOn(store, 'admit');

      const response = await handleRequest(eventFor(read, attempt.id), deps);

      expect(response.statusCode).toBe(409);
      expect(responseBody(response).code).toBe('decisions_pending');
      expect(await store.get(OWNER, attempt.id)).toMatchObject({ status: 'pending' });
      expect(admit).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(closeExpired).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(beginCall).not.toHaveBeenCalled();
      expect(finishCall).not.toHaveBeenCalled();
      expect(publishAction).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(reads)(
    'returns replay_unavailable for a $name with an incomplete real store record',
    async (read) => {
      const store = createStore();
      const attemptId = await createIncompleteTerminalAttempt(store);

      const response = await handleRequest(eventFor(read, attemptId), dependencies(store));

      expect(response.statusCode).toBe(409);
      expect(responseBody(response).code).toBe('replay_unavailable');
      expect(response.body).not.toContain('private');
    },
  );

  it.each(reads)(
    'sanitizes $name incompatibility raised by the real Dynamo store parser',
    async (read) => {
      const { attemptId, harness, store } = await createIncompatibleDynamoStore();
      await expect(store.get(OWNER, attemptId)).rejects.toBeInstanceOf(
        AttemptStoredIncompatibleError,
      );

      const response = await handleRequest(eventFor(read, attemptId), dependencies(store));

      expect(harness.send).toHaveBeenCalled();
      expect(response.statusCode).toBe(500);
      expect(responseBody(response).code).toBe('stored_attempt_incompatible');
      expect(response.body).not.toContain(PRIVATE_MARKER);
    },
  );

  it.each(reads)('preserves a general AttemptStoreError as temporary for $name', async (read) => {
    const store = createStore();
    const attempt = await admitAttempt(store, `decisions-store-failure-${read.name}`);
    const method = read.name === 'index' ? 'getDecisionIndex' : 'getDecision';
    vi.spyOn(store, method).mockRejectedValue(new AttemptStoreError(PRIVATE_MARKER));

    const response = await handleRequest(eventFor(read, attempt.id), dependencies(store));

    expect(response.statusCode).toBe(503);
    expect(responseBody(response).code).toBe('dependency_unavailable');
  });

  it.each(reads)('keeps a raw Dynamo SDK 500 temporary for $name', async (read) => {
    const sdkFailure = new InternalServerError({
      message: PRIVATE_MARKER,
      $metadata: { httpStatusCode: 500 },
    });
    const send = vi.fn().mockRejectedValue(sdkFailure);
    const store = createDynamoAttemptStore({
      client: { send } as unknown as DynamoDBClient,
      tableName: 'attempts',
    });

    const response = await handleRequest(
      eventFor(read, 'attempt-sdk-failure'),
      dependencies(store),
    );

    expect(send).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(500);
    expect(responseBody(response).code).toBe('internal');
    expect(response.body).not.toContain(PRIVATE_MARKER);
  });

  it.each(reads)(
    'returns 404 for missing or foreign $name without exposing private attempt data',
    async (read) => {
      const store = createStore();
      const attempt = await admitAttempt(store, `decisions-privacy-${read.name}`);
      await store.requestCancel(OWNER, attempt.id);
      const deps = dependencies(store);

      const missing = await handleRequest(eventFor(read, 'missing-attempt'), deps);
      const foreign = await handleRequest(eventFor(read, attempt.id, 'other-owner'), {
        ...deps,
        fetch: vi.fn(
          async () => new Response(JSON.stringify({ sub: 'other-owner', email_verified: true })),
        ),
      });

      expect(missing.statusCode).toBe(404);
      expect(responseBody(missing).code).toBe('not_found');
      expect(foreign.statusCode).toBe(404);
      expect(responseBody(foreign).code).toBe('not_found');
      expect(missing.body).not.toContain(PRIVATE_MARKER);
      expect(foreign.body).not.toContain(PRIVATE_MARKER);
    },
  );

  it('does not start, close, dispatch, mutate, or invoke a model while reading the real index and detail routes', async () => {
    const bodyStore = new MemoryBodyStore();
    const store = createStore(bodyStore);
    const attempt = await admitAttempt(store, 'decisions-read-no-side-effects');
    await store.requestCancel(OWNER, attempt.id);
    const dispatch = vi.fn();
    const bodyGet = vi.spyOn(bodyStore, 'get');
    const deps = dependencies(store, dispatch, bodyStore);
    const mutations = [
      vi.spyOn(store, 'admit'),
      vi.spyOn(store, 'claim'),
      vi.spyOn(store, 'requestCancel'),
      vi.spyOn(store, 'close'),
      vi.spyOn(store, 'closeExpired'),
      vi.spyOn(store, 'beginCall'),
      vi.spyOn(store, 'finishCall'),
      vi.spyOn(store, 'publishAction'),
      vi.spyOn(store, 'markPresentationComplete'),
      vi.spyOn(store, 'putAnimationPreference'),
    ];
    const before = await store.get(OWNER, attempt.id);

    const index = await handleRequest(eventFor(reads[0]!, attempt.id), deps);
    const detail = await handleRequest(eventFor(reads[1]!, attempt.id), deps);

    expect(index.statusCode).toBe(200);
    expect(detail.statusCode).toBe(404);
    expect(responseBody(index).attemptId).toBe(attempt.id);
    expect(responseBody(detail).code).toBe('not_found');
    expect(await store.get(OWNER, attempt.id)).toEqual(before);
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(bodyGet).not.toHaveBeenCalled();
  });

  it('rejects an invalid decision query before reading the store', async () => {
    const store = createStore();
    const attempt = await admitAttempt(store, 'decisions-invalid-query');
    const getDecisionIndex = vi.spyOn(store, 'getDecisionIndex');
    const getDecision = vi.spyOn(store, 'getDecision');
    const read = { ...reads[1]!, decisionNumber: '0' };

    const response = await handleRequest(eventFor(read, attempt.id), dependencies(store));

    expect(response.statusCode).toBe(400);
    expect(responseBody(response).code).toBe('invalid');
    expect(getDecisionIndex).not.toHaveBeenCalled();
    expect(getDecision).not.toHaveBeenCalled();
  });
});
