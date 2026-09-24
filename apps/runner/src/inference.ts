import { Readable } from 'node:stream';
import type { HttpRequest, HttpResponse } from '@smithy/core/transport';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { HttpHandlerOptions, RequestHandler, RequestHandlerOutput } from '@smithy/types';
import {
  Agent,
  BedrockModel,
  InvokeModelStage,
  MaxTokensError,
  ModelThrottledError,
  Tool,
  type JSONSchema,
  type JSONValue,
  type ToolSpec,
  type ToolStreamEvent,
  type ToolStreamGenerator,
} from '@strands-agents/sdk';
import {
  DEFAULT_MODEL_KEY,
  modelByKey,
  readModelProfile,
  type ModelProfile,
} from '../../../shared/models.js';
import { usageFromBedrockResponseBytes, type ProviderUsage } from './usage.js';

export const INFERENCE_PROTOCOL_VERSION = 1 as const;
export const STRANDS_SDK_VERSION = '1.18.0' as const;
export const BEDROCK_RUNTIME_SDK_VERSION = '3.1136.0' as const;
export const DEFAULT_RESPONSE_AUDIT_TIMEOUT_MS = 30_000;

export const DEFAULT_DECISION_MODEL_CONFIG: Readonly<ModelProfile> = modelByKey(DEFAULT_MODEL_KEY)!;

export const DECISION_INFERENCE_IMPLEMENTATION = Object.freeze({
  protocolVersion: INFERENCE_PROTOCOL_VERSION,
  provider: 'bedrock-converse',
  stream: false,
  thinking: 'profile-defined',
  explicitPromptCache: 'disabled',
  implicitPromptCache: 'provider-managed-if-eligible',
  clientMaxAttempts: 1,
  responseAuditTimeoutMs: DEFAULT_RESPONSE_AUDIT_TIMEOUT_MS,
  strandsVersion: STRANDS_SDK_VERSION,
  bedrockRuntimeVersion: BEDROCK_RUNTIME_SDK_VERSION,
});

/** The server-resolved, immutable profile for one admitted attempt. */
export type DecisionModelConfig = Readonly<ModelProfile>;

export interface DecisionTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface DecisionInput {
  readonly instructions: string;
  readonly tools: readonly DecisionTool[];
  readonly observation: unknown;
  readonly modelConfig: DecisionModelConfig;
}

export interface TransportReceipt {
  readonly bytes: Uint8Array | null;
  readonly statusCode: number | null;
  readonly requestId: string | null;
  /** False means no complete HTTP body was available (for example, a transport timeout). */
  readonly complete: boolean;
  readonly error?: Readonly<{ name: string; message: string }>;
}

export interface DecisionAudit {
  /** Must persist and conditionally authorize the call before resolving. */
  beforeSend(requestBytes: Uint8Array): Promise<void>;
  /** Must persist the complete response/error bytes before resolving. */
  afterReceive(receipt: TransportReceipt): Promise<void>;
}

export interface DecisionExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Separate reserve for persisting a response after the provider deadline or cancellation. */
  readonly responseAuditTimeoutMs?: number;
  /** Public for a real SDK transport test; production omits it and uses NodeHttpHandler. */
  readonly requestHandler?: RequestHandler<HttpRequest, HttpResponse, HttpHandlerOptions>;
}

export interface DecisionAction {
  readonly name: string;
  readonly input: JSONValue;
  readonly toolUseId: string;
}

export interface DecisionResult {
  readonly action: DecisionAction;
  readonly usage: ProviderUsage;
  readonly requestId: string | null;
  readonly durationMs: number;
}

export type DecisionFailureCode =
  | 'invalid_input'
  | 'invalid_response'
  | 'truncated'
  | 'throttled'
  | 'timeout'
  | 'cancelled'
  | 'audit_failed'
  | 'provider_error';

export class DecisionFailure extends Error {
  public constructor(
    public readonly code: DecisionFailureCode,
    message: string,
    public readonly usage: ProviderUsage,
    public readonly receipt: TransportReceipt | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DecisionFailure';
  }
}

class AuditFailure extends Error {
  public constructor(
    public readonly phase: 'beforeSend' | 'afterReceive',
    cause: unknown,
  ) {
    super(`The ${phase} audit callback failed.`, { cause });
    this.name = 'AuditFailure';
  }
}

class BodyReadFailure extends Error {
  public constructor(
    public readonly partialBytes: Uint8Array,
    cause: unknown,
  ) {
    super('The HTTP body could not be read completely.', { cause });
    this.name = 'BodyReadFailure';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const jsonClone = (value: unknown, label: string): JSONValue => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new DecisionFailure(
      'invalid_input',
      `${label} must be JSON serializable.`,
      usageFromBedrockResponseBytes(null),
      null,
      { cause: error },
    );
  }
  if (serialized === undefined) {
    throw new DecisionFailure(
      'invalid_input',
      `${label} must be a JSON value.`,
      usageFromBedrockResponseBytes(null),
    );
  }
  return JSON.parse(serialized) as JSONValue;
};

const supportedPropertySchema = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value) || value.type !== 'string') {
    return false;
  }
  if (value.enum !== undefined) {
    if (
      !Array.isArray(value.enum) ||
      value.enum.length === 0 ||
      !value.enum.every((candidate) => typeof candidate === 'string')
    ) {
      return false;
    }
  }
  return Object.keys(value).every((key) => key === 'type' || key === 'enum');
};

const validatePublishedSchema = (value: Readonly<Record<string, unknown>>): void => {
  if (
    value.type !== 'object' ||
    !isRecord(value.properties) ||
    value.additionalProperties !== false ||
    !Object.values(value.properties).every(supportedPropertySchema)
  ) {
    throw new DecisionFailure(
      'invalid_input',
      'A tool has an unsupported input schema.',
      usageFromBedrockResponseBytes(null),
    );
  }
  const required = value.required;
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      !required.every((name) => typeof name === 'string' && own(value.properties as object, name)))
  ) {
    throw new DecisionFailure(
      'invalid_input',
      'A tool has an invalid required-property list.',
      usageFromBedrockResponseBytes(null),
    );
  }
};

const matchesPublishedSchema = (
  value: JSONValue,
  schema: Readonly<Record<string, unknown>>,
): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = (schema.required as readonly string[] | undefined) ?? [];
  if (required.some((name) => !own(value, name))) {
    return false;
  }
  if (Object.keys(value).some((name) => !own(properties, name))) {
    return false;
  }
  return Object.entries(value).every(([name, propertyValue]) => {
    const property = properties[name];
    if (!property || typeof propertyValue !== 'string') {
      return false;
    }
    const allowed = property.enum;
    return !Array.isArray(allowed) || allowed.includes(propertyValue);
  });
};

const profileFromSnapshot = (value: unknown): Readonly<ModelProfile> | null => {
  try {
    return readModelProfile(value);
  } catch {
    return null;
  }
};

const validateInput = (
  input: DecisionInput,
): {
  observation: JSONValue;
  model: Readonly<ModelProfile>;
} => {
  if (typeof input.instructions !== 'string' || input.tools.length === 0) {
    throw new DecisionFailure(
      'invalid_input',
      'A decision needs literal instructions and at least one enabled tool.',
      usageFromBedrockResponseBytes(null),
    );
  }
  const model = profileFromSnapshot(input.modelConfig);
  if (!model) {
    throw new DecisionFailure(
      'invalid_input',
      'The decision model profile snapshot is not valid or has been modified.',
      usageFromBedrockResponseBytes(null),
    );
  }
  const seen = new Set<string>();
  for (const tool of input.tools) {
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(tool.name) ||
      seen.has(tool.name) ||
      (tool.description !== undefined && typeof tool.description !== 'string')
    ) {
      throw new DecisionFailure(
        'invalid_input',
        'Enabled tools must have unique valid opaque names and literal descriptions.',
        usageFromBedrockResponseBytes(null),
      );
    }
    seen.add(tool.name);
    validatePublishedSchema(tool.inputSchema);
  }
  return { observation: jsonClone(input.observation, 'The local observation'), model };
};

/**
 * Strands' runtime registry and Bedrock serializer accept an omitted description,
 * while ToolSpec's public TypeScript shape still marks it required. The assertions
 * below bridge only that upstream type mismatch; the effective request is tested.
 */
const blockedSelectionToolStream = async function* (): ToolStreamGenerator {
  const events: ToolStreamEvent[] = [];
  yield* events;
  throw new Error('Decision selection tools must never execute.');
};

class SelectionTool extends Tool {
  public readonly name: string;
  public readonly description: string;
  public readonly toolSpec: ToolSpec;

  public constructor(tool: DecisionTool) {
    super();
    this.name = tool.name;
    const description =
      tool.description === undefined || tool.description === '' ? undefined : tool.description;
    this.description = description as string;
    this.toolSpec = {
      name: tool.name,
      ...(description === undefined ? {} : { description }),
      inputSchema: tool.inputSchema as JSONSchema,
    } as ToolSpec;
  }

  public stream(): ToolStreamGenerator {
    return blockedSelectionToolStream();
  }
}

const bytesForChunk = (chunk: unknown): Uint8Array => {
  if (typeof chunk === 'string') {
    return new TextEncoder().encode(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return chunk.slice();
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk.slice(0));
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
  }
  throw new TypeError('Unsupported HTTP body chunk.');
};

const concatenate = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readBody = async (body: unknown): Promise<Uint8Array> => {
  if (body === undefined || body === null) {
    return new Uint8Array();
  }
  if (
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return bytesForChunk(body);
  }
  if (isRecord(body) && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    try {
      for await (const chunk of body as AsyncIterable<unknown>) {
        chunks.push(bytesForChunk(chunk));
      }
      return concatenate(chunks);
    } catch (error) {
      throw new BodyReadFailure(concatenate(chunks), error);
    }
  }
  throw new BodyReadFailure(new Uint8Array(), new TypeError('Unsupported HTTP body.'));
};

const errorDetails = (error: unknown): Readonly<{ name: string; message: string }> =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };

const abortReason = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('The operation was aborted.');
};

const platformAbortSignal = (signal: HttpHandlerOptions['abortSignal']): AbortSignal | undefined =>
  signal && 'addEventListener' in signal && typeof signal.addEventListener === 'function'
    ? signal
    : undefined;

const abortable = async <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const runAudit = async (
  phase: 'beforeSend' | 'afterReceive',
  operation: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> => {
  try {
    await abortable(operation(), signal);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new AuditFailure(phase, error);
  }
};

const runResponseAudit = async (
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Response audit reserve expired.', 'TimeoutError')),
    timeoutMs,
  );
  try {
    await abortable(operation(), controller.signal);
  } catch (error) {
    throw new AuditFailure('afterReceive', error);
  } finally {
    clearTimeout(timer);
  }
};

const header = (
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): string | null => {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(headers)) {
    if (accepted.has(name.toLowerCase())) {
      return value;
    }
  }
  return null;
};

export class AuditedRequestHandler implements RequestHandler<
  HttpRequest,
  HttpResponse,
  HttpHandlerOptions
> {
  public readonly metadata;
  private readonly receipts: TransportReceipt[] = [];
  private auditFailure: AuditFailure | null = null;

  public constructor(
    private readonly delegate: RequestHandler<HttpRequest, HttpResponse, HttpHandlerOptions>,
    private readonly audit: DecisionAudit,
    private readonly responseAuditTimeoutMs = DEFAULT_RESPONSE_AUDIT_TIMEOUT_MS,
  ) {
    this.metadata = delegate.metadata;
  }

  public destroy(): void {
    this.delegate.destroy?.();
  }

  public latestReceipt(): TransportReceipt | null {
    return this.receipts.at(-1) ?? null;
  }

  public latestAuditFailure(): AuditFailure | null {
    return this.auditFailure;
  }

  public async handle(
    request: HttpRequest,
    options: HttpHandlerOptions = {},
  ): Promise<RequestHandlerOutput<HttpResponse>> {
    const signal = platformAbortSignal(options.abortSignal);
    const requestBytes = await readBody(request.body);
    try {
      await runAudit('beforeSend', () => this.audit.beforeSend(requestBytes.slice()), signal);
    } catch (error) {
      if (error instanceof AuditFailure) {
        this.auditFailure = error;
      }
      throw error;
    }
    if (options.abortSignal?.aborted) {
      throw signal ? abortReason(signal) : new Error('The operation was aborted.');
    }
    request.body = requestBytes;

    let output: RequestHandlerOutput<HttpResponse>;
    try {
      output = await this.delegate.handle(request, options);
    } catch (error) {
      const receipt: TransportReceipt = {
        bytes: null,
        statusCode: null,
        requestId: null,
        complete: false,
        error: errorDetails(error),
      };
      try {
        await runResponseAudit(
          () => this.audit.afterReceive({ ...receipt }),
          this.responseAuditTimeoutMs,
        );
      } catch (auditError) {
        if (auditError instanceof AuditFailure) {
          this.auditFailure = auditError;
        }
        throw auditError;
      }
      this.receipts.push(receipt);
      throw error;
    }

    let responseBytes: Uint8Array;
    try {
      responseBytes = await readBody(output.response.body);
    } catch (error) {
      const failure =
        error instanceof BodyReadFailure ? error : new BodyReadFailure(new Uint8Array(), error);
      const receipt: TransportReceipt = {
        bytes: failure.partialBytes,
        statusCode: output.response.statusCode,
        requestId: header(output.response.headers, ['x-amzn-requestid', 'x-amz-request-id']),
        complete: false,
        error: errorDetails(failure.cause),
      };
      try {
        await runResponseAudit(
          () => this.audit.afterReceive({ ...receipt, bytes: receipt.bytes?.slice() ?? null }),
          this.responseAuditTimeoutMs,
        );
      } catch (auditError) {
        if (auditError instanceof AuditFailure) {
          this.auditFailure = auditError;
        }
        throw auditError;
      }
      this.receipts.push(receipt);
      throw failure;
    }

    const receipt: TransportReceipt = {
      bytes: responseBytes,
      statusCode: output.response.statusCode,
      requestId: header(output.response.headers, ['x-amzn-requestid', 'x-amz-request-id']),
      complete: true,
    };
    try {
      await runResponseAudit(
        () => this.audit.afterReceive({ ...receipt, bytes: responseBytes.slice() }),
        this.responseAuditTimeoutMs,
      );
    } catch (error) {
      if (error instanceof AuditFailure) {
        this.auditFailure = error;
      }
      throw error;
    }
    this.receipts.push(receipt);
    output.response.body = Readable.from([responseBytes]);
    return output;
  }
}

const systemPrompt = (instructions: string): string =>
  [
    'Elegí exactamente una herramienta habilitada para actuar sobre la observación presente.',
    'Respondé únicamente con esa llamada y respetá exactamente su esquema.',
    'Instrucciones del jugador (texto literal):',
    instructions,
  ].join('\n');

const observationMessage = (observation: JSONValue): string =>
  `Observación local presente:\n${JSON.stringify(observation)}`;

const receiptUsage = (receipt: TransportReceipt | null): ProviderUsage =>
  usageFromBedrockResponseBytes(receipt?.bytes ?? null, 'separate');

const errorChain = (error: unknown): readonly unknown[] => {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length < 12) {
    chain.push(current);
    seen.add(current);
    current = isRecord(current) || current instanceof Error ? current.cause : undefined;
  }
  return chain;
};

const errorName = (error: unknown): string | null =>
  (error instanceof Error || isRecord(error)) && typeof error.name === 'string' ? error.name : null;

const isProviderThrottle = (error: unknown, receipt: TransportReceipt | null): boolean => {
  if (receipt?.statusCode === 429) return true;
  const throttleNames = new Set([
    'ModelThrottledError',
    'ThrottlingException',
    'TooManyRequestsException',
  ]);
  return errorChain(error).some((candidate) => {
    if (candidate instanceof ModelThrottledError || throttleNames.has(errorName(candidate) ?? '')) {
      return true;
    }
    if (!isRecord(candidate)) return false;
    const retryable = candidate.$retryable;
    const metadata = candidate.$metadata;
    return (
      (isRecord(retryable) && retryable.throttling === true) ||
      (isRecord(metadata) && metadata.httpStatusCode === 429)
    );
  });
};

const isOutputTruncation = (error: unknown): boolean =>
  errorChain(error).some(
    (candidate) => candidate instanceof MaxTokensError || errorName(candidate) === 'MaxTokensError',
  );

const classifyProviderFailure = (
  error: unknown,
  receipt: TransportReceipt | null,
): DecisionFailure => {
  const usage = receiptUsage(receipt);
  if (error instanceof AuditFailure) {
    return new DecisionFailure(
      'audit_failed',
      `Inference stopped because ${error.phase} audit persistence failed.`,
      usage,
      receipt,
      { cause: error },
    );
  }
  if (isOutputTruncation(error)) {
    return new DecisionFailure(
      'truncated',
      'The model response reached its output limit.',
      usage,
      receipt,
      { cause: error },
    );
  }
  if (isProviderThrottle(error, receipt)) {
    return new DecisionFailure(
      'throttled',
      'Bedrock throttled the decision call.',
      usage,
      receipt,
      {
        cause: error,
      },
    );
  }
  return new DecisionFailure(
    'provider_error',
    'Bedrock could not complete the decision call.',
    usage,
    receipt,
    {
      cause: error,
    },
  );
};

/**
 * Strands intentionally skips unknown Bedrock content keys while mapping a
 * response. Inspect the captured native envelope first so a skipped block
 * cannot turn an invalid response into an executable one.
 */
const validateNativeResponseContent = (
  bytes: Uint8Array,
  usage: ProviderUsage,
  receipt: TransportReceipt,
): void => {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return;
  }
  if (!isRecord(payload) || !isRecord(payload.output) || !isRecord(payload.output.message)) {
    return;
  }
  const content = payload.output.message.content;
  if (!Array.isArray(content)) return;
  const recognized = new Set(['toolUse', 'reasoningContent', 'text']);
  const blocks = content.filter(isRecord);
  if (
    blocks.length !== content.length ||
    blocks.some((block) => {
      const keys = Object.keys(block);
      return keys.length !== 1 || !recognized.has(keys[0] ?? '');
    })
  ) {
    throw new DecisionFailure(
      'invalid_response',
      'The model response contained an unknown content block.',
      usage,
      receipt,
    );
  }
  const toolCount = blocks.filter((block) => own(block, 'toolUse')).length;
  const textCount = blocks.filter((block) => own(block, 'text')).length;
  if (toolCount !== 1 || textCount > 0 || blocks.some((block) => own(block, 'reasoningContent'))) {
    throw new DecisionFailure(
      'invalid_response',
      'The model response must contain exactly one tool and only permitted reasoning blocks.',
      usage,
      receipt,
    );
  }
};

const validateResponse = (
  result: Awaited<ReturnType<Agent['invoke']>>,
  tools: readonly DecisionTool[],
  usage: ProviderUsage,
  receipt: TransportReceipt,
): DecisionAction => {
  if (result.stopReason === 'maxTokens') {
    throw new DecisionFailure(
      'truncated',
      'The model response reached its output limit.',
      usage,
      receipt,
    );
  }
  if (result.stopReason !== 'checkpoint') {
    throw new DecisionFailure(
      'invalid_response',
      'The model did not return exactly one tool selection.',
      usage,
      receipt,
    );
  }
  const content = result.lastMessage.content;
  const toolBlocks = content.filter((block) => block.type === 'toolUseBlock');
  const nonToolBlocks = content.filter((block) => block.type !== 'toolUseBlock');
  if (toolBlocks.length !== 1 || nonToolBlocks.length > 0) {
    throw new DecisionFailure(
      'invalid_response',
      'The model response must contain exactly one tool and only permitted reasoning blocks.',
      usage,
      receipt,
    );
  }
  const block = toolBlocks[0];
  if (
    !block ||
    block.type !== 'toolUseBlock' ||
    typeof block.toolUseId !== 'string' ||
    block.toolUseId === ''
  ) {
    throw new DecisionFailure(
      'invalid_response',
      'The model response did not contain one valid tool selection.',
      usage,
      receipt,
    );
  }
  const tool = tools.find((candidate) => candidate.name === block.name);
  if (!tool) {
    throw new DecisionFailure(
      'invalid_response',
      'The model selected a tool that was not enabled.',
      usage,
      receipt,
    );
  }
  if (!matchesPublishedSchema(block.input, tool.inputSchema)) {
    throw new DecisionFailure(
      'invalid_response',
      'The model tool arguments do not match the enabled schema.',
      usage,
      receipt,
    );
  }
  return {
    name: block.name,
    input: block.input,
    toolUseId: block.toolUseId,
  };
};

export const executeDecision = async (
  input: DecisionInput,
  audit: DecisionAudit,
  options: DecisionExecutionOptions = {},
): Promise<DecisionResult> => {
  const { observation, model } = validateInput(input);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const responseAuditTimeoutMs =
    options.responseAuditTimeoutMs ?? DEFAULT_RESPONSE_AUDIT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(responseAuditTimeoutMs) ||
    responseAuditTimeoutMs < 1
  ) {
    throw new DecisionFailure(
      'invalid_input',
      'The provider deadline and response audit reserve must be positive integers.',
      usageFromBedrockResponseBytes(null),
    );
  }

  const startedAt = performance.now();
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new DOMException('Decision deadline exceeded.', 'TimeoutError')),
    timeoutMs,
  );
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  const delegate = options.requestHandler ?? new NodeHttpHandler({ requestTimeout: timeoutMs });
  const transport = new AuditedRequestHandler(delegate, audit, responseAuditTimeoutMs);

  try {
    const bedrockModel = new BedrockModel({
      modelId: model.modelId,
      region: model.region,
      maxTokens: model.maxTokens,
      stream: model.protocol.stream,
      clientConfig: {
        maxAttempts: 1,
        requestHandler: transport,
      },
    });
    const agent = new Agent({
      model: bedrockModel,
      tools: input.tools.map((tool) => new SelectionTool(tool)),
      systemPrompt: systemPrompt(input.instructions),
      printer: false,
      retryStrategy: null,
      contextManager: false,
      checkpointing: true,
      toolExecutor: 'sequential',
    });
    agent.addMiddleware(InvokeModelStage.Input, (context) => ({
      ...context,
      toolChoice: model.protocol.toolChoice === 'any' ? { any: {} } : { auto: {} },
    }));

    const result = await agent.invoke(observationMessage(observation), { cancelSignal: signal });
    const receipt = transport.latestReceipt();
    if (timeoutController.signal.aborted) {
      throw new DecisionFailure(
        'timeout',
        'The absolute decision deadline expired.',
        receiptUsage(receipt),
        receipt,
      );
    }
    if (options.signal?.aborted || result.stopReason === 'cancelled') {
      throw new DecisionFailure(
        'cancelled',
        'The decision call was cancelled.',
        receiptUsage(receipt),
        receipt,
      );
    }
    if (!receipt || !receipt.complete || receipt.bytes === null) {
      throw new DecisionFailure(
        'provider_error',
        'Bedrock returned no complete auditable response body.',
        receiptUsage(receipt),
        receipt,
      );
    }
    const usage = receiptUsage(receipt);
    validateNativeResponseContent(receipt.bytes, usage, receipt);
    const action = validateResponse(result, input.tools, usage, receipt);
    return {
      action,
      usage,
      requestId: receipt.requestId,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof DecisionFailure) {
      throw error;
    }
    const receipt = transport.latestReceipt();
    if (timeoutController.signal.aborted) {
      throw new DecisionFailure(
        'timeout',
        'The absolute decision deadline expired.',
        receiptUsage(receipt),
        receipt,
        { cause: error },
      );
    }
    if (options.signal?.aborted) {
      throw new DecisionFailure(
        'cancelled',
        'The decision call was cancelled.',
        receiptUsage(receipt),
        receipt,
        { cause: error },
      );
    }
    const auditFailure = transport.latestAuditFailure();
    if (auditFailure) {
      throw classifyProviderFailure(auditFailure, receipt);
    }
    throw classifyProviderFailure(error, receipt);
  } finally {
    clearTimeout(timer);
    transport.destroy();
  }
};
