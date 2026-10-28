import { DynamoDBClient, InternalServerError } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLambdaStdout } from '../../../shared/testing/lambda-telemetry.js';
import { createDynamoAttemptStore } from './attempt-store.js';
import { handleRequest } from './handler.js';

let lambdaStdout: ReturnType<typeof captureLambdaStdout>;

beforeEach(() => {
  lambdaStdout = captureLambdaStdout();
});

afterEach(() => {
  lambdaStdout.mockRestore();
});

const eventFor = (cursor?: string): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'GET /attempts',
    rawPath: '/attempts',
    rawQueryString: cursor === undefined ? '' : `cursor=${encodeURIComponent(cursor)}`,
    queryStringParameters: cursor === undefined ? undefined : { cursor },
    headers: { authorization: 'Bearer access-token' },
    requestContext: {
      http: { method: 'GET', path: '/attempts' },
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

const dependencies = (attemptStore: ReturnType<typeof createDynamoAttemptStore>) => ({
  store: { get: vi.fn(), put: vi.fn() },
  attemptStore,
  fetch: vi.fn(async () => new Response(JSON.stringify({ sub: 'owner', email_verified: true }))),
  clientId: 'client',
  userInfoUrl: 'https://cognito.example.test/userinfo',
});

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

describe('attempt list storage boundary', () => {
  it('rejects an extra cursor key as invalid before querying', async () => {
    const send = vi.fn();
    const store = createDynamoAttemptStore({
      client: { send } as unknown as DynamoDBClient,
      tableName: 'attempts',
    });
    const cursor = Buffer.from(
      JSON.stringify({
        owner: 'owner',
        key: marshall({
          PK: 'USER#owner',
          SK: 'ATTEMPT#attempt-1',
          extra: 'not-a-table-key',
        }),
      }),
      'utf8',
    ).toString('base64url');

    const response = await handleRequest(eventFor(cursor), dependencies(store));

    expect({
      statusCode: response.statusCode,
      body: responseBody(response),
      queryCount: send.mock.calls.length,
    }).toEqual({
      statusCode: 400,
      body: { code: 'invalid', message: 'El cursor no es válido.' },
      queryCount: 0,
    });
  });

  it('maps a DynamoDB InternalServerError from list to dependency_unavailable', async () => {
    const serviceError = new InternalServerError({
      message: 'DynamoDB internal error',
      $metadata: { httpStatusCode: 500 },
    });
    const send = vi.fn().mockRejectedValue(serviceError);
    const store = createDynamoAttemptStore({
      client: { send } as unknown as DynamoDBClient,
      tableName: 'attempts',
    });

    const response = await handleRequest(eventFor(), dependencies(store));

    expect(response.statusCode).toBe(503);
    expect(responseBody(response)).toEqual({
      code: 'dependency_unavailable',
      message: 'No se pudo consultar los intentos.',
    });
    expect(JSON.stringify(responseBody(response))).not.toContain('DynamoDB internal error');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('maps a real SDK transport timeout from list to dependency_unavailable', async () => {
    const timeoutError = Object.assign(new Error('Local request handler timed out.'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
    });
    const requestHandler = {
      handle: vi.fn(async () => {
        throw timeoutError;
      }),
      destroy: vi.fn(),
    };
    const client = new DynamoDBClient({
      region: 'us-east-1',
      endpoint: 'http://localhost:8000',
      credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test' },
      maxAttempts: 1,
      requestHandler,
    });
    const store = createDynamoAttemptStore({ client, tableName: 'attempts' });

    try {
      const response = await handleRequest(eventFor(), dependencies(store));

      expect(response.statusCode).toBe(503);
      expect(responseBody(response)).toEqual({
        code: 'dependency_unavailable',
        message: 'No se pudo consultar los intentos.',
      });
      expect(requestHandler.handle).toHaveBeenCalledTimes(1);
    } finally {
      client.destroy();
    }
  });
});
