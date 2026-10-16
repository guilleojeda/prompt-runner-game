import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
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

const eventFor = (requestId: string): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'GET /api/metrics',
    rawPath: '/api/metrics',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: 'account',
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
      requestId,
      routeKey: 'GET /api/metrics',
      stage: '$default',
      time: '15/Oct/2026:12:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

const lambdaContext = (awsRequestId: string): Context =>
  ({ awsRequestId, functionName: 'prompt-runner-game-monitoring-metrics' }) as unknown as Context;

describe('monitoring API Lambda telemetry context', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('correlates sampled and unsampled outcomes across sequential invocations without changing responses', async () => {
    vi.stubEnv('COGNITO_USER_POOL_ID', 'us-east-1_example');
    vi.stubEnv('DRAFT_TABLE_NAME', 'runner-draft-table');

    const cognitoSend = vi
      .spyOn(CognitoIdentityProviderClient.prototype, 'send')
      .mockResolvedValueOnce({ Users: [] } as never)
      .mockRejectedValueOnce(new Error('private monitoring dependency sentinel'));
    vi.spyOn(DynamoDBClient.prototype, 'send').mockResolvedValue({ Items: [] } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activeSpan: ReturnType<typeof spanFor> | undefined = spanFor(
      '33333333333333333333333333333333',
      '3333333333333333',
      true,
    );
    vi.spyOn(trace, 'getActiveSpan').mockImplementation(() => activeSpan);

    const success = await lambdaHandler(
      eventFor('monitor-gateway-request-1'),
      lambdaContext('monitor-lambda-request-1'),
    );
    activeSpan = spanFor('44444444444444444444444444444444', '4444444444444444', false);
    const dependencyFailure = await lambdaHandler(
      eventFor('monitor-gateway-request-2'),
      lambdaContext('monitor-lambda-request-2'),
    );

    expect(success.statusCode).toBe(200);
    expect(JSON.parse(success.body ?? '{}')).toMatchObject({
      registeredUsers: 0,
      users: [],
    });
    expect(success.headers).toMatchObject({ 'cache-control': 'no-store' });
    expect(dependencyFailure.statusCode).toBe(503);
    expect(JSON.parse(dependencyFailure.body ?? '{}')).toEqual({
      code: 'metrics_unavailable',
      message: 'No se pudieron consultar las métricas.',
    });

    const records = parseConsoleRecords(log.mock.calls, error.mock.calls);
    expect(records.length).toBeGreaterThanOrEqual(2);
    for (const record of records) {
      expect(record).toHaveProperty('lambdaRequestId');
      expect(record).toHaveProperty('trace_id');
    }
    expect(
      records.filter((record) => record.lambdaRequestId === 'monitor-lambda-request-1'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'monitor-gateway-request-1',
          lambdaRequestId: 'monitor-lambda-request-1',
          trace_id: '33333333333333333333333333333333',
          status: 200,
        }),
      ]),
    );
    expect(
      records.filter((record) => record.lambdaRequestId === 'monitor-lambda-request-2'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'monitor-gateway-request-2',
          lambdaRequestId: 'monitor-lambda-request-2',
          trace_id: '44444444444444444444444444444444',
          status: 503,
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain('private monitoring dependency sentinel');
    expect(cognitoSend).toHaveBeenCalledTimes(2);
  });
});
