import { AsyncLocalStorage } from 'node:async_hooks';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

type LogLevel = 'log' | 'error';
type LogValue = string | number | boolean | undefined;
type LambdaLogContext = {
  readonly lambdaRequestId?: string;
  readonly trace_id?: string;
};

const invocationContext = new AsyncLocalStorage<LambdaLogContext>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validTraceId = (span: Span | undefined): string | undefined => {
  if (!span) return undefined;
  const { traceId, spanId } = span.spanContext();
  if (
    !/^[\da-f]{32}$/iu.test(traceId) ||
    !/^[\da-f]{16}$/iu.test(spanId) ||
    /^0+$/u.test(traceId) ||
    /^0+$/u.test(spanId)
  ) {
    return undefined;
  }
  return traceId.toLowerCase();
};

const decorateHandlerSpan = (span: Span | undefined, component: string): void => {
  span?.setAttribute('app.component', component);
};

const statusFrom = (value: unknown): number | undefined => {
  if (!isRecord(value)) return undefined;
  const statusCode = value.statusCode;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : undefined;
};

export const logLambdaRecord = (level: LogLevel, record: Record<string, LogValue>): void => {
  const context = invocationContext.getStore();
  const value = {
    ...record,
    level: level === 'error' ? 'ERROR' : 'INFO',
    ...(context?.lambdaRequestId === undefined ? {} : { lambdaRequestId: context.lambdaRequestId }),
    ...(context?.trace_id === undefined ? {} : { trace_id: context.trace_id }),
  };
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

export const withLambdaTelemetry = async <Result>(
  component: string,
  awsRequestId: unknown,
  operation: () => Result | Promise<Result>,
): Promise<Result> => {
  const activeSpan = trace.getActiveSpan();
  decorateHandlerSpan(activeSpan, component);
  const logContext: LambdaLogContext = {
    ...(typeof awsRequestId === 'string' && awsRequestId.length > 0
      ? { lambdaRequestId: awsRequestId }
      : {}),
    ...(validTraceId(activeSpan) === undefined ? {} : { trace_id: validTraceId(activeSpan) }),
  };

  return invocationContext.run(logContext, async () => {
    try {
      const result = await operation();
      const statusCode = statusFrom(result);
      activeSpan?.setAttribute(
        'app.outcome',
        statusCode === undefined || statusCode < 400 ? 'success' : 'http_error',
      );
      if (statusCode !== undefined && statusCode >= 100 && statusCode <= 599) {
        activeSpan?.setAttribute('http.response.status_code', statusCode);
      }
      return result;
    } catch {
      activeSpan?.setAttribute('app.outcome', 'failure');
      activeSpan?.setStatus({ code: SpanStatusCode.ERROR, message: 'Lambda invocation failed' });
      throw new Error('Lambda invocation failed.');
    }
  });
};
