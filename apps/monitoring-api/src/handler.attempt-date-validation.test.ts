import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from './handler.js';

const cutoff = new Date('2026-10-15T12:00:00.000Z');
type AttributeValue = { S?: string; N?: string; [key: string]: unknown };
type Item = Record<string, AttributeValue>;
type QueryPage = { Items?: Item[] };
type QueryCommandLike = {
  input: { ExpressionAttributeValues?: Record<string, AttributeValue> };
};

const user = (sub: string, email: string) => ({
  Username: sub,
  UserCreateDate: new Date('2026-10-01T00:00:00.000Z'),
  Attributes: [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: email },
    { Name: 'email_verified', Value: 'true' },
  ],
});

const attempt = (owner: string, id: string, createdAt: string, score: number): Item => ({
  PK: { S: `USER#${owner}` },
  SK: { S: `ATTEMPT#${id}` },
  createdAt: { S: createdAt },
  score: { N: String(score) },
});

const ownerFrom = (command: QueryCommandLike): string => {
  const partition = Object.values(command.input.ExpressionAttributeValues ?? {}).find((value) =>
    value.S?.startsWith('USER#'),
  )?.S;
  if (!partition) throw new Error('La consulta no incluye el propietario.');
  return partition.slice('USER#'.length);
};

const event: APIGatewayProxyEventV2 = {
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
    requestId: 'request-date-validation',
    routeKey: 'GET /api/metrics',
    stage: '$default',
    time: '15/Oct/2026:12:00:00 +0000',
    timeEpoch: cutoff.getTime(),
  },
  isBase64Encoded: false,
};

describe('attempt date validation', () => {
  it('marks impossible calendar dates unknown while accepting a valid offset timestamp', async () => {
    const cognitoSend = vi.fn(async () => ({
      Users: [
        user('impossible-date', 'impossible@example.com'),
        user('offset-date', 'offset@example.com'),
      ],
    }));
    const dynamoSend = vi.fn(async (command: QueryCommandLike): Promise<QueryPage> => {
      if (ownerFrom(command) === 'impossible-date') {
        return {
          Items: [attempt('impossible-date', 'invalid', '2026-02-30T12:00:00.000Z', 17)],
        };
      }
      return {
        Items: [attempt('offset-date', 'valid-offset', '2026-10-15T07:00:00.000-04:00', 0)],
      };
    });
    const dependencies = {
      cognito: { send: cognitoSend },
      dynamo: { send: dynamoSend },
      userPoolId: 'us-east-1_example',
      tableName: 'runner-draft-table',
      now: () => new Date(cutoff),
    } as unknown as Parameters<typeof handleRequest>[1];

    const response = await handleRequest(event, dependencies);

    expect(response.statusCode).toBe(200);
    const rows = JSON.parse(response.body ?? '{}').users as Array<Record<string, unknown>>;
    const invalid = rows.find((row) => row.id === 'impossible-date');
    const offset = rows.find((row) => row.id === 'offset-date');
    expect(invalid).toMatchObject({
      attempts: { hours24: 'N/A', days3: 'N/A', days7: 'N/A' },
      maxScore: 17,
    });
    expect(offset).toMatchObject({
      attempts: { hours24: 1, days3: 1, days7: 1 },
      maxScore: 0,
    });
  });
});
