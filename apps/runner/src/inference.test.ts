import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { HttpRequest, HttpResponse } from '@smithy/core/transport';
import type { HttpHandlerOptions, RequestHandler, RequestHandlerOutput } from '@smithy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CATALOG, type ModelProfile } from '../../../shared/models.js';
import {
  AuditedRequestHandler,
  DECISION_INFERENCE_IMPLEMENTATION,
  DEFAULT_DECISION_MODEL_CONFIG,
  DecisionFailure,
  executeDecision,
  type DecisionAudit,
  type DecisionInput,
  type TransportReceipt,
} from './inference.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const noArguments = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const directionArguments = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['izquierda', 'derecha'] },
  },
  required: ['direction'],
  additionalProperties: false,
} as const;

const input = (observation: unknown = { actual: 'suelo', derecha: 'pozo' }): DecisionInput => ({
  instructions: '  texto literal\n🦾  ',
  tools: [
    { name: 'tool_1', description: '', inputSchema: noArguments },
    { name: 'tool_2', inputSchema: noArguments },
    {
      name: 'tool_3',
      description: 'Saltá sólo si así lo escribió la persona 🦾',
      inputSchema: directionArguments,
    },
  ],
  observation,
  modelConfig: DEFAULT_DECISION_MODEL_CONFIG,
});

const inputForModel = (modelConfig: Readonly<ModelProfile>): DecisionInput => ({
  ...input(),
  modelConfig,
});

const responseBytes = (
  content: readonly Record<string, unknown>[],
  stopReason = 'tool_use',
  extra: Record<string, unknown> = {},
): Uint8Array =>
  encoder.encode(
    JSON.stringify({
      output: { message: { role: 'assistant', content } },
      stopReason,
      usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
      metrics: { latencyMs: 4 },
      ...extra,
    }),
  );

const toolUse = (name: string, toolInput: Record<string, unknown>, id = 'call-1') => ({
  toolUse: { toolUseId: id, name, input: toolInput },
});

const reasoning = (text = 'evaluación interna') => ({
  reasoningContent: { reasoningText: { text } },
});

type HandlerAction =
  | {
      readonly bytes: Uint8Array;
      readonly statusCode?: number;
      readonly headers?: Record<string, string>;
    }
  | {
      readonly run: (
        request: HttpRequest,
        options: HttpHandlerOptions,
      ) => Promise<RequestHandlerOutput<HttpResponse>>;
    };

class QueueHandler implements RequestHandler<HttpRequest, HttpResponse, HttpHandlerOptions> {
  public readonly metadata = { handlerProtocol: 'test' };
  public readonly requests: HttpRequest[] = [];

  public constructor(private readonly actions: HandlerAction[]) {}

  public async handle(
    request: HttpRequest,
    options: HttpHandlerOptions = {},
  ): Promise<RequestHandlerOutput<HttpResponse>> {
    this.requests.push(request);
    const action = this.actions.shift();
    if (!action) {
      throw new Error('Unexpected extra HTTP request.');
    }
    if ('run' in action) {
      return action.run(request, options);
    }
    return {
      response: new HttpResponse({
        statusCode: action.statusCode ?? 200,
        headers: {
          'content-type': 'application/json',
          'x-amzn-requestid': 'request-123',
          ...action.headers,
        },
        body: Readable.from([action.bytes]),
      }),
    };
  }
}

const recordingAudit = () => {
  const requests: Uint8Array[] = [];
  const receipts: TransportReceipt[] = [];
  const audit: DecisionAudit = {
    beforeSend: async (bytes) => {
      requests.push(bytes.slice());
    },
    afterReceive: async (receipt) => {
      receipts.push({ ...receipt, bytes: receipt.bytes?.slice() ?? null });
    },
  };
  return { audit, requests, receipts };
};

const readStream = async (body: unknown): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

describe('auditable Strands Bedrock decision', () => {
  beforeEach(() => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-access-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret-key');
    vi.stubEnv('AWS_SESSION_TOKEN', 'test-session-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(MODEL_CATALOG)(
    'projects the complete $key profile into one native Converse request',
    async (profile) => {
      const content = [
        ...(profile.provider === 'openai' || profile.protocol.thinking === 'adaptive'
          ? [reasoning()]
          : []),
        toolUse('tool_1', {}),
      ];
      const response = responseBytes(content);
      const handler = new QueueHandler([{ bytes: response }]);
      const recorded = recordingAudit();

      await expect(
        executeDecision(inputForModel(profile), recorded.audit, { requestHandler: handler }),
      ).resolves.toMatchObject({ action: { name: 'tool_1', input: {} } });

      expect(handler.requests).toHaveLength(1);
      expect(handler.requests[0]?.path).toContain(`/model/${profile.modelId}/converse`);
      const body = JSON.parse(decoder.decode(recorded.requests[0] ?? new Uint8Array())) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        inferenceConfig: { maxTokens: profile.maxTokens },
        toolConfig: {
          toolChoice: profile.protocol.toolChoice === 'any' ? { any: {} } : { auto: {} },
        },
      });
      expect(body).not.toHaveProperty('cacheConfig');
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('topP');
      expect(body).not.toHaveProperty('stopSequences');
      if (profile.protocol.thinking === 'omitted') {
        expect(body).not.toHaveProperty('additionalModelRequestFields');
      } else if (profile.protocol.thinking === 'disabled') {
        expect(body).toMatchObject({
          additionalModelRequestFields: { thinking: { type: 'disabled' } },
        });
      } else {
        expect(body).toMatchObject({
          additionalModelRequestFields: {
            thinking: { type: 'adaptive' },
            output_config: { effort: profile.protocol.reasoningEffort },
          },
        });
      }
    },
  );

  it('rejects a changed or arbitrary model profile before any network request', async () => {
    const handler = new QueueHandler([]);
    const recorded = recordingAudit();
    const candidates = [
      { ...DEFAULT_DECISION_MODEL_CONFIG, maxTokens: 0 },
      { ...DEFAULT_DECISION_MODEL_CONFIG, modelId: 'arbitrary-model' },
      { ...DEFAULT_DECISION_MODEL_CONFIG, temperature: 0 },
    ];

    for (const candidate of candidates) {
      await expect(
        executeDecision(inputForModel(candidate), recorded.audit, { requestHandler: handler }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(handler.requests).toHaveLength(0);
    expect(recorded.requests).toHaveLength(0);
  });

  it('executes an admitted versioned snapshot with its original values after catalog changes', async () => {
    const historical = {
      ...DEFAULT_DECISION_MODEL_CONFIG,
      label: 'Claude Sonnet 5 histórico',
      modelId: 'us.anthropic.claude-sonnet-5',
      region: 'us-west-2',
      maxTokens: 2_048,
      profileVersion: 'claude-sonnet-5-global-v1',
    } as const;
    const response = responseBytes([toolUse('tool_1', {})]);
    const handler = new QueueHandler([{ bytes: response }]);
    const recorded = recordingAudit();

    await expect(
      executeDecision(inputForModel(historical), recorded.audit, { requestHandler: handler }),
    ).resolves.toMatchObject({ action: { name: 'tool_1' } });

    expect(handler.requests[0]?.hostname).toContain('us-west-2');
    expect(handler.requests[0]?.path).toContain('/model/us.anthropic.claude-sonnet-5/converse');
    const body = JSON.parse(decoder.decode(recorded.requests[0] ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ inferenceConfig: { maxTokens: 2_048 } });
  });

  it('accepts native reasoning blocks for GPT defaults and adaptive profiles', async () => {
    const response = responseBytes([reasoning('decido'), toolUse('tool_1', {})]);
    for (const model of [
      MODEL_CATALOG.find((profile) => profile.key === 'gpt-5.6-sol')!,
      MODEL_CATALOG.find((profile) => profile.key === 'claude-opus-5.5')!,
    ]) {
      const handler = new QueueHandler([{ bytes: response }]);
      await expect(
        executeDecision(inputForModel(model), recordingAudit().audit, { requestHandler: handler }),
      ).resolves.toMatchObject({ action: { name: 'tool_1' } });
    }

    const disabledHandler = new QueueHandler([{ bytes: response }]);
    await expect(
      executeDecision(input(), recordingAudit().audit, { requestHandler: disabledHandler }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    { name: 'no tool', content: [reasoning()] },
    {
      name: 'two tools',
      content: [reasoning(), toolUse('tool_1', {}, 'one'), toolUse('tool_2', {}, 'two')],
    },
    { name: 'text plus tool', content: [reasoning(), { text: 'plan' }, toolUse('tool_1', {})] },
    {
      name: 'unknown block',
      content: [reasoning(), { unsupported: { value: true } }, toolUse('tool_1', {})],
    },
  ])('rejects adaptive $name without publishing an action', async ({ content }) => {
    const handler = new QueueHandler([{ bytes: responseBytes(content) }]);
    const recorded = recordingAudit();
    const model = MODEL_CATALOG.find((profile) => profile.key === 'claude-opus-5.5')!;

    await expect(
      executeDecision(inputForModel(model), recorded.audit, { requestHandler: handler }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(handler.requests).toHaveLength(1);
    expect(recorded.receipts).toHaveLength(1);
  });

  it('uses one native Converse call per fresh decision and stops before tool execution', async () => {
    expect(DECISION_INFERENCE_IMPLEMENTATION).toMatchObject({
      explicitPromptCache: 'disabled',
      implicitPromptCache: 'provider-managed-if-eligible',
      responseAuditTimeoutMs: 30_000,
    });
    expect(DECISION_INFERENCE_IMPLEMENTATION).not.toHaveProperty('promptCache');
    const firstResponse = responseBytes([toolUse('tool_3', { direction: 'derecha' }, 'first')]);
    const secondResponse = responseBytes([toolUse('tool_1', {}, 'second')]);
    const handler = new QueueHandler([{ bytes: firstResponse }, { bytes: secondResponse }]);
    const recorded = recordingAudit();

    const first = await executeDecision(input({ derecha: 'pozo' }), recorded.audit, {
      requestHandler: handler,
    });
    const second = await executeDecision(input({ derecha: 'suelo' }), recorded.audit, {
      requestHandler: handler,
    });

    expect(first.action).toEqual({
      name: 'tool_3',
      input: { direction: 'derecha' },
      toolUseId: 'first',
    });
    expect(second.action).toEqual({ name: 'tool_1', input: {}, toolUseId: 'second' });
    expect(first.usage).toMatchObject({
      original: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
      normalized: { inputTokens: 20, outputTokens: 3, gameTokens: 23 },
    });
    expect(first.requestId).toBe('request-123');
    expect(handler.requests).toHaveLength(2);
    expect(handler.requests.every((request) => request.path.endsWith('/converse'))).toBe(true);
    expect(handler.requests.every((request) => !request.path.includes('converse-stream'))).toBe(
      true,
    );
    expect(recorded.requests).toHaveLength(2);
    expect(recorded.receipts.map((receipt) => receipt.bytes)).toEqual([
      firstResponse,
      secondResponse,
    ]);

    const bodies = recorded.requests.map(
      (bytes) => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>,
    );
    for (const body of bodies) {
      expect(body).toMatchObject({
        inferenceConfig: { maxTokens: 512 },
        additionalModelRequestFields: { thinking: { type: 'disabled' } },
        toolConfig: { toolChoice: { any: {} } },
      });
      expect(body).not.toHaveProperty('cacheConfig');
      expect(JSON.stringify(body)).not.toContain('cachePoint');
      const messages = body.messages as Array<{ role: string; content: unknown[] }>;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
      expect(JSON.stringify(messages)).not.toContain('toolResult');
      const tools = (body.toolConfig as { tools: Array<{ toolSpec: Record<string, unknown> }> })
        .tools;
      expect(tools.map(({ toolSpec }) => toolSpec.name)).toEqual(['tool_1', 'tool_2', 'tool_3']);
      expect(tools[0]?.toolSpec).not.toHaveProperty('description');
      expect(tools[1]?.toolSpec).not.toHaveProperty('description');
      expect(tools[2]?.toolSpec.description).toBe('Saltá sólo si así lo escribió la persona 🦾');
      expect(JSON.stringify(tools)).not.toContain('Avanzar');
      expect(JSON.stringify(tools)).not.toContain('Saltar');
    }
    const firstMessage = (bodies[0]?.messages as Array<{ content: Array<{ text: string }> }>)[0]
      ?.content[0]?.text;
    const secondMessage = (bodies[1]?.messages as Array<{ content: Array<{ text: string }> }>)[0]
      ?.content[0]?.text;
    const firstSystem = (bodies[0]?.system as Array<{ text: string }>)[0]?.text;
    expect(firstMessage).toContain('"derecha":"pozo"');
    expect(secondMessage).toContain('"derecha":"suelo"');
    expect(secondMessage).not.toContain('"derecha":"pozo"');
    expect(firstSystem).toContain('  texto literal\n🦾  ');
  });

  it.each([
    {
      name: 'plain text alongside a tool',
      content: [{ text: 'un plan' }, toolUse('tool_1', {})],
      expected: 'invalid_response',
    },
    {
      name: 'multiple tools',
      content: [toolUse('tool_1', {}, 'one'), toolUse('tool_2', {}, 'two')],
      expected: 'invalid_response',
    },
    {
      name: 'a disabled tool',
      content: [toolUse('tool_9', {})],
      expected: 'invalid_response',
    },
    {
      name: 'extra schema properties',
      content: [toolUse('tool_3', { direction: 'derecha', extra: true })],
      expected: 'invalid_response',
    },
    {
      name: 'a wrong schema enum',
      content: [toolUse('tool_3', { direction: 'arriba' })],
      expected: 'invalid_response',
    },
  ])(
    'rejects $name after persisting one response and without continuing',
    async ({ content, expected }) => {
      const bytes = responseBytes(content);
      const handler = new QueueHandler([{ bytes }]);
      const recorded = recordingAudit();

      await expect(
        executeDecision(input(), recorded.audit, { requestHandler: handler }),
      ).rejects.toMatchObject({ code: expected });
      expect(handler.requests).toHaveLength(1);
      expect(recorded.receipts).toHaveLength(1);
      expect(recorded.receipts[0]?.bytes).toEqual(bytes);
    },
  );

  it('classifies truncation without a semantic retry and keeps reported usage', async () => {
    const bytes = responseBytes([{ text: 'partial' }], 'max_tokens');
    const handler = new QueueHandler([{ bytes }]);
    const recorded = recordingAudit();

    const failure = await executeDecision(input(), recorded.audit, {
      requestHandler: handler,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DecisionFailure);
    expect(failure).toMatchObject({
      code: 'truncated',
      usage: { normalized: { gameTokens: 23 } },
    });
    expect(handler.requests).toHaveLength(1);
  });

  it('persists HTTP error bytes before surfacing an un-retried throttle', async () => {
    const bytes = encoder.encode(
      JSON.stringify({ message: 'slow down', padding: 'x'.repeat(409_700) }),
    );
    const handler = new QueueHandler([
      { bytes, statusCode: 429, headers: { 'x-amzn-errortype': 'ThrottlingException' } },
    ]);
    const recorded = recordingAudit();

    await expect(
      executeDecision(input(), recorded.audit, { requestHandler: handler }),
    ).rejects.toMatchObject({
      code: 'throttled',
      usage: { normalized: { inputTokens: null, outputTokens: null, gameTokens: null } },
    });
    expect(handler.requests).toHaveLength(1);
    expect(recorded.receipts[0]).toMatchObject({ statusCode: 429, complete: true });
    expect(Buffer.compare(recorded.receipts[0]?.bytes ?? new Uint8Array(), bytes)).toBe(0);
    expect(recorded.receipts[0]?.bytes?.byteLength).toBeGreaterThan(400 * 1024);
  });

  it.each([
    {
      name: 'context overflow mentioning max_tokens',
      statusCode: 400,
      errorType: 'ValidationException',
      message: 'input length and `max_tokens` exceed context limit',
    },
    {
      name: 'access denial mentioning service quota',
      statusCode: 403,
      errorType: 'AccessDeniedException',
      message: 'Account verification blocks this service quota request',
    },
    {
      name: 'ordinary validation failure',
      statusCode: 400,
      errorType: 'ValidationException',
      message: 'The tool schema is invalid',
    },
    {
      name: 'non-transient service quota error',
      statusCode: 400,
      errorType: 'ServiceQuotaExceededException',
      message: 'Service quota exceeded',
    },
  ])('does not infer retry or truncation from $name text', async (testCase) => {
    const bytes = encoder.encode(JSON.stringify({ message: testCase.message }));
    const handler = new QueueHandler([
      {
        bytes,
        statusCode: testCase.statusCode,
        headers: { 'x-amzn-errortype': testCase.errorType },
      },
    ]);
    const recorded = recordingAudit();

    await expect(
      executeDecision(input(), recorded.audit, { requestHandler: handler }),
    ).rejects.toMatchObject({ code: 'provider_error' });
    expect(handler.requests).toHaveLength(1);
    expect(recorded.receipts[0]?.bytes).toEqual(bytes);
  });

  it('uses an exact AWS retryable throttling trait without retrying inside the adapter', async () => {
    const throttled = Object.assign(new Error('opaque provider failure'), {
      name: 'UnrecognizedProviderError',
      $retryable: { throttling: true },
    });
    const handler = new QueueHandler([
      {
        run: async () => {
          throw throttled;
        },
      },
    ]);
    const recorded = recordingAudit();

    await expect(
      executeDecision(input(), recorded.audit, { requestHandler: handler }),
    ).rejects.toMatchObject({ code: 'throttled' });
    expect(handler.requests).toHaveLength(1);
    expect(recorded.receipts).toEqual([
      expect.objectContaining({ bytes: null, statusCode: null, complete: false }),
    ]);
  });

  it('recognizes the exact Bedrock throttling exception name without relying on message text', async () => {
    const bytes = encoder.encode(JSON.stringify({ message: 'opaque provider rejection' }));
    const handler = new QueueHandler([
      {
        bytes,
        statusCode: 400,
        headers: { 'x-amzn-errortype': 'ThrottlingException' },
      },
    ]);
    const recorded = recordingAudit();

    await expect(
      executeDecision(input(), recorded.audit, { requestHandler: handler }),
    ).rejects.toMatchObject({ code: 'throttled' });
    expect(handler.requests).toHaveLength(1);
    expect(recorded.receipts[0]?.bytes).toEqual(bytes);
  });

  it('keeps an ambiguous transport error non-retryable', async () => {
    const handler = new QueueHandler([
      {
        run: async () => {
          throw new Error(
            'socket closed after an unknown write state mentioning throttling, service quota, and max_tokens',
          );
        },
      },
    ]);
    const recorded = recordingAudit();

    await expect(
      executeDecision(input(), recorded.audit, { requestHandler: handler }),
    ).rejects.toMatchObject({ code: 'provider_error' });
    expect(handler.requests).toHaveLength(1);
  });

  it('authorizes before network send and does not send when request persistence fails', async () => {
    const handler = new QueueHandler([{ bytes: responseBytes([toolUse('tool_1', {})]) }]);
    const audit: DecisionAudit = {
      beforeSend: async () => {
        throw new Error('database unavailable');
      },
      afterReceive: vi.fn(),
    };

    await expect(
      executeDecision(input(), audit, { requestHandler: handler }),
    ).rejects.toMatchObject({
      code: 'audit_failed',
    });
    expect(handler.requests).toHaveLength(0);
    expect(audit.afterReceive).not.toHaveBeenCalled();
  });

  it('does not return an action when response persistence fails', async () => {
    const handler = new QueueHandler([{ bytes: responseBytes([toolUse('tool_1', {})]) }]);
    const audit: DecisionAudit = {
      beforeSend: async () => undefined,
      afterReceive: async () => {
        throw new Error('object store unavailable');
      },
    };

    await expect(
      executeDecision(input(), audit, { requestHandler: handler }),
    ).rejects.toMatchObject({
      code: 'audit_failed',
    });
    expect(handler.requests).toHaveLength(1);
  });

  it('bounds response persistence with the separate save reserve', async () => {
    const handler = new QueueHandler([{ bytes: responseBytes([toolUse('tool_1', {})]) }]);
    const audit: DecisionAudit = {
      beforeSend: async () => undefined,
      afterReceive: async () => new Promise<void>(() => undefined),
    };

    await expect(
      executeDecision(input(), audit, {
        requestHandler: handler,
        timeoutMs: 1_000,
        responseAuditTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: 'audit_failed' });
    expect(handler.requests).toHaveLength(1);
  });

  it('uses an absolute deadline and records an ambiguous post-send transport failure', async () => {
    const handler = new QueueHandler([
      {
        run: async (_request, options) =>
          new Promise<RequestHandlerOutput<HttpResponse>>((_resolve, reject) => {
            const signal = options.abortSignal as AbortSignal;
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted after send', 'AbortError')),
              { once: true },
            );
          }),
      },
    ]);
    const recorded = recordingAudit();

    await expect(
      executeDecision(input(), recorded.audit, { requestHandler: handler, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(handler.requests).toHaveLength(1);
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.receipts).toEqual([
      expect.objectContaining({ bytes: null, statusCode: null, complete: false }),
    ]);
  });

  it.each(['deadline', 'cancellation'] as const)(
    'finishes complete response persistence within the save reserve after %s',
    async (abortMode) => {
      const bytes = responseBytes([toolUse('tool_1', {})]);
      const handler = new QueueHandler([{ bytes }]);
      let resolveAuditStarted: (() => void) | undefined;
      const auditStarted = new Promise<void>((resolve) => {
        resolveAuditStarted = resolve;
      });
      let releaseAudit: (() => void) | undefined;
      const audit: DecisionAudit = {
        beforeSend: async () => undefined,
        afterReceive: async () => {
          resolveAuditStarted?.();
          await new Promise<void>((resolve) => {
            releaseAudit = resolve;
          });
        },
      };
      const controller = new AbortController();
      const resultPromise = executeDecision(input(), audit, {
        requestHandler: handler,
        signal: controller.signal,
        timeoutMs: abortMode === 'deadline' ? 20 : 1_000,
        responseAuditTimeoutMs: 250,
      }).catch((error: unknown) => error);

      await auditStarted;
      if (abortMode === 'cancellation') {
        controller.abort(new DOMException('cancelled while saving', 'AbortError'));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      releaseAudit?.();
      const failure = await resultPromise;

      expect(failure).toBeInstanceOf(DecisionFailure);
      expect(failure).toMatchObject({
        code: abortMode === 'deadline' ? 'timeout' : 'cancelled',
        receipt: { bytes, complete: true },
        usage: { normalized: { gameTokens: 23 } },
      });
      expect(handler.requests).toHaveLength(1);
    },
  );

  it('buffers response bytes for audit and restores them for downstream deserialization', async () => {
    const largeBytes = encoder.encode(JSON.stringify({ value: '🦾'.repeat(150_000) }));
    const delegate = new QueueHandler([{ bytes: largeBytes }]);
    const recorded = recordingAudit();
    const handler = new AuditedRequestHandler(delegate, recorded.audit);
    const request = new HttpRequest({
      protocol: 'https:',
      hostname: 'example.test',
      method: 'POST',
      path: '/',
      headers: {},
      body: Readable.from([encoder.encode('{"request":true}')]),
    });

    const output = await handler.handle(request);
    const downstream = await readStream(output.response.body);

    expect(recorded.requests[0]).toEqual(encoder.encode('{"request":true}'));
    expect(Buffer.compare(recorded.receipts[0]?.bytes ?? new Uint8Array(), largeBytes)).toBe(0);
    expect(Buffer.compare(downstream, largeBytes)).toBe(0);
    expect(largeBytes.byteLength).toBeGreaterThan(400 * 1024);
  });
});
