import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { HttpResponse } from '@smithy/protocol-http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { instrumentAwsClient } from './aws-client-telemetry.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer('prompt-runner-game-aws-client-tests');

const jsonResponse = (statusCode: number, body: unknown): HttpResponse =>
  new HttpResponse({
    statusCode,
    headers: { 'content-type': 'application/x-amz-json-1.0' },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  });

const fakeRequestHandler = (responses: readonly HttpResponse[]) => {
  let responseIndex = 0;
  return {
    handle: vi.fn(async () => {
      const response = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;
      if (!response) throw new Error('No fake DynamoDB response was configured.');
      return { response };
    }),
    destroy: vi.fn(),
  };
};

const fakeClient = (
  requestHandler: ReturnType<typeof fakeRequestHandler>,
  maxAttempts = 1,
): DynamoDBClient =>
  new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    endpoint: 'https://dynamodb.example.test',
    maxAttempts,
    requestHandler: requestHandler as never,
  });

const sendPrivateRequest = (client: DynamoDBClient) =>
  client.send(
    new GetItemCommand({
      TableName: 'PRIVATE_TABLE_SENTINEL',
      Key: { PK: { S: 'PRIVATE_INPUT_SENTINEL' } },
    }),
  );

const withLambdaSpan = async <T>(run: () => Promise<T>) => {
  const parent = tracer.startSpan('lambda-invocation', { kind: SpanKind.SERVER });
  const parentContext = parent.spanContext();
  try {
    const result = await context.with(trace.setSpan(context.active(), parent), run);
    return { parentContext, result };
  } finally {
    parent.end();
  }
};

const clientSpans = () =>
  exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.CLIENT);

const serializedTelemetry = (span: ReturnType<typeof clientSpans>[number]): string =>
  JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status });

describe('AWS SDK client telemetry', () => {
  beforeAll(() => provider.register());
  afterEach(() => exporter.reset());
  afterAll(async () => provider.shutdown());

  it('creates one child CLIENT span on send and attaches idempotently without capturing payloads', async () => {
    const requestHandler = fakeRequestHandler([
      jsonResponse(200, {
        Item: { value: { S: 'PRIVATE_OUTPUT_SENTINEL' } },
      }),
    ]);
    const client = fakeClient(requestHandler);

    expect(instrumentAwsClient(client)).toBe(client);
    expect(instrumentAwsClient(client)).toBe(client);
    const { parentContext, result } = await withLambdaSpan(() => sendPrivateRequest(client));

    expect(result.Item?.value?.S).toBe('PRIVATE_OUTPUT_SENTINEL');
    const spans = clientSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      kind: SpanKind.CLIENT,
      parentSpanContext: expect.objectContaining({
        traceId: parentContext.traceId,
        spanId: parentContext.spanId,
      }),
    });
    const operationMetadata = JSON.stringify({
      name: spans[0]?.name,
      attributes: spans[0]?.attributes,
    });
    expect(operationMetadata).toContain('DynamoDB');
    expect(operationMetadata).toContain('GetItem');
    expect(spans[0]?.attributes['http.response.status_code']).toBe(200);
    expect(serializedTelemetry(spans[0]!)).not.toMatch(
      /PRIVATE_TABLE_SENTINEL|PRIVATE_INPUT_SENTINEL|PRIVATE_OUTPUT_SENTINEL/u,
    );
    expect(requestHandler.handle).toHaveBeenCalledTimes(1);
  });

  it('keeps SDK retries inside one child CLIENT span', async () => {
    const requestHandler = fakeRequestHandler([
      jsonResponse(500, {
        __type: 'InternalServerError',
        message: 'PRIVATE_RETRY_ERROR_SENTINEL',
      }),
      jsonResponse(200, {}),
    ]);
    const client = fakeClient(requestHandler, 2);
    instrumentAwsClient(client);

    const { parentContext } = await withLambdaSpan(() => sendPrivateRequest(client));

    expect(requestHandler.handle).toHaveBeenCalledTimes(2);
    const spans = clientSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe(SpanKind.CLIENT);
    expect(spans[0]?.parentSpanContext?.traceId).toBe(parentContext.traceId);
    expect(spans[0]?.parentSpanContext?.spanId).toBe(parentContext.spanId);
    expect(spans[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(serializedTelemetry(spans[0]!)).not.toContain('PRIVATE_RETRY_ERROR_SENTINEL');
  });

  it('marks failure and rethrows the original dependency error without exposing its message', async () => {
    const requestHandler = fakeRequestHandler([]);
    const dependencyError = new Error('PRIVATE_DEPENDENCY_ERROR_SENTINEL');
    requestHandler.handle.mockRejectedValue(dependencyError);
    const client = fakeClient(requestHandler);
    instrumentAwsClient(client);

    await expect(withLambdaSpan(() => sendPrivateRequest(client))).rejects.toBe(dependencyError);

    const spans = clientSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(serializedTelemetry(spans[0]!)).not.toMatch(
      /PRIVATE_TABLE_SENTINEL|PRIVATE_INPUT_SENTINEL|PRIVATE_DEPENDENCY_ERROR_SENTINEL/u,
    );
  });

  it('does not create client spans outside an active Lambda or application context', async () => {
    const requestHandler = fakeRequestHandler([jsonResponse(200, {})]);
    const client = fakeClient(requestHandler);
    instrumentAwsClient(client);

    await sendPrivateRequest(client);

    expect(requestHandler.handle).toHaveBeenCalledTimes(1);
    expect(clientSpans()).toHaveLength(0);
  });
});
