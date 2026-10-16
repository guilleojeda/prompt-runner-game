import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { trace } from '@opentelemetry/api';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from './index.js';
import { parseConsoleRecords, spanFor } from '../../../shared/testing/lambda-telemetry.js';

const lambdaHandler = handler as unknown as (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

const identityClaims = {
  sub: 'user-a',
  token_use: 'access',
  client_id: 'client-1',
  scope: 'openid email prompt-runner/robot',
};

const eventFor = (requestId: string): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'GET /draft',
    rawPath: '/draft',
    rawQueryString: '',
    headers: { authorization: 'Bearer private-access-token' },
    requestContext: {
      accountId: 'account',
      apiId: 'api',
      domainName: 'api.example.test',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/draft',
        protocol: 'https',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId,
      routeKey: 'GET /draft',
      stage: '$default',
      time: '21/Sep/2026:00:00:00 +0000',
      timeEpoch: 0,
      authorizer: { jwt: { claims: identityClaims } },
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const lambdaContext = (awsRequestId: string): Context =>
  ({ awsRequestId, functionName: 'prompt-runner-game-draft-api' }) as unknown as Context;

describe('game API Lambda telemetry context', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('correlates sampled and unsampled outcomes across sequential invocations without changing responses', async () => {
    vi.stubEnv('COGNITO_CLIENT_ID', 'client-1');
    vi.stubEnv('COGNITO_USERINFO_URL', 'https://identity.example.test/oauth2/userInfo');
    vi.stubEnv('DRAFT_TABLE_NAME', 'runner-draft-table');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ sub: 'user-a', email_verified: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const send = vi.spyOn(DynamoDBClient.prototype, 'send');
    send
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('private dependency sentinel'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activeSpan: ReturnType<typeof spanFor> | undefined = spanFor(
      '11111111111111111111111111111111',
      '1111111111111111',
      true,
    );
    vi.spyOn(trace, 'getActiveSpan').mockImplementation(() => activeSpan);

    const success = await lambdaHandler(
      eventFor('gateway-request-1'),
      lambdaContext('lambda-request-1'),
    );
    activeSpan = spanFor('22222222222222222222222222222222', '2222222222222222', false);
    const dependencyFailure = await lambdaHandler(
      eventFor('gateway-request-2'),
      lambdaContext('lambda-request-2'),
    );

    expect(success.statusCode).toBe(200);
    expect(JSON.parse(success.body ?? '{}')).toMatchObject({ version: 0 });
    expect(dependencyFailure.statusCode).toBe(503);
    expect(JSON.parse(dependencyFailure.body ?? '{}')).toMatchObject({
      code: 'dependency_unavailable',
    });

    const records = parseConsoleRecords(log.mock.calls, error.mock.calls);
    expect(records.length).toBeGreaterThanOrEqual(2);
    for (const record of records) {
      expect(record).toHaveProperty('lambdaRequestId');
      expect(record).toHaveProperty('trace_id');
    }
    expect(records.filter((record) => record.lambdaRequestId === 'lambda-request-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'gateway-request-1',
          lambdaRequestId: 'lambda-request-1',
          trace_id: '11111111111111111111111111111111',
          status: 200,
          code: 'ok',
        }),
      ]),
    );
    expect(records.filter((record) => record.lambdaRequestId === 'lambda-request-2')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'gateway-request-2',
          lambdaRequestId: 'lambda-request-2',
          trace_id: '22222222222222222222222222222222',
          status: 503,
          code: 'dependency_unavailable',
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain('private-access-token');
    expect(JSON.stringify(records)).not.toContain('private dependency sentinel');
  });
});
