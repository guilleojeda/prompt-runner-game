import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

type MiddlewareArgs = { readonly input: unknown };
type MiddlewareOutput = { readonly response?: unknown; readonly output?: unknown };
type MiddlewareContext = { readonly commandName?: string };
type MiddlewareHandler = (args: MiddlewareArgs) => Promise<MiddlewareOutput>;

type InstrumentableClient = {
  readonly config: { readonly serviceId?: string };
  readonly middlewareStack: {
    add(
      middleware: (
        next: MiddlewareHandler,
        middlewareContext: MiddlewareContext,
      ) => MiddlewareHandler,
      options: { readonly name: string; readonly step: 'initialize' },
    ): void;
  };
};

const attachedClients = new WeakSet<object>();
const tracer = trace.getTracer('prompt-runner-game-aws-client');
const MIDDLEWARE_NAME = 'promptRunnerAwsClientTelemetry';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validSpanContext = (span: ReturnType<typeof trace.getActiveSpan>): boolean => {
  if (!span) return false;
  const spanContext = span.spanContext();
  return (
    /^[\da-f]{32}$/iu.test(spanContext.traceId) &&
    /^[\da-f]{16}$/iu.test(spanContext.spanId) &&
    !/^0+$/u.test(spanContext.traceId) &&
    !/^0+$/u.test(spanContext.spanId)
  );
};

const boundedName = (value: string | undefined, fallback: string): string => {
  if (!value) return fallback;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(normalized) ? normalized : fallback;
};

const httpStatusFrom = (value: MiddlewareOutput): number | undefined => {
  if (!isRecord(value.output) || !isRecord(value.output.$metadata)) return undefined;
  const status = value.output.$metadata.httpStatusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
};

const httpStatusFromError = (value: unknown): number | undefined => {
  if (!isRecord(value) || !isRecord(value.$metadata)) return undefined;
  const status = value.$metadata.httpStatusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
};

export const instrumentAwsClient = <Client extends object>(client: Client): Client => {
  if (attachedClients.has(client)) return client;

  if (!isRecord(client) || !isRecord(client.config) || !isRecord(client.middlewareStack)) {
    throw new TypeError('AWS SDK client does not expose its middleware stack.');
  }
  const add = client.middlewareStack.add;
  if (typeof add !== 'function') {
    throw new TypeError('AWS SDK client does not expose middleware registration.');
  }

  // AWS SDK v3 clients share this public initialize-middleware shape. The narrow
  // local view avoids depending on Smithy's transitive type package at runtime.
  const instrumentable = client as Client & InstrumentableClient;
  instrumentable.middlewareStack.add(
    (next, middlewareContext) => async (args) => {
      const parent = trace.getActiveSpan();
      if (!validSpanContext(parent)) return next(args);

      const service = boundedName(instrumentable.config.serviceId, 'AWS');
      const operation = boundedName(
        middlewareContext.commandName?.replace(/Command$/u, ''),
        'UnknownOperation',
      );
      const span = tracer.startSpan(`${service}.${operation}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'aws.service': service,
          'aws.operation': operation,
        },
      });

      try {
        const result = await context.with(trace.setSpan(context.active(), span), () => next(args));
        const status = httpStatusFrom(result);
        if (status !== undefined) span.setAttribute('http.response.status_code', status);
        return result;
      } catch (error) {
        const status = httpStatusFromError(error);
        if (status !== undefined) span.setAttribute('http.response.status_code', status);
        span.setAttribute('aws.error.type', 'dependency_error');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'AWS SDK operation failed' });
        throw error;
      } finally {
        span.end();
      }
    },
    { name: MIDDLEWARE_NAME, step: 'initialize' },
  );
  attachedClients.add(client);
  return client;
};
