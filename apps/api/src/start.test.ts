import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { trace } from '@opentelemetry/api';
import type { Context } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler, type StarterEvent } from './start.js';
import {
  captureLambdaStdout,
  parseLambdaRecords,
  spanFor,
} from '../../../shared/testing/lambda-telemetry.js';

const closeExpired = vi.hoisted(() => vi.fn());

vi.mock('./attempt-store.js', () => ({
  createDynamoAttemptStore: () => ({ closeExpired }),
}));

const lambdaHandler = handler as unknown as (
  event: StarterEvent,
  context: Context,
) => Promise<void>;
const eventFor = (attemptId: string): StarterEvent => ({ attemptId, owner: 'user-a' });
const lambdaContext = (awsRequestId: string): Context =>
  ({ awsRequestId, functionName: 'prompt-runner-game-attempt-starter' }) as unknown as Context;

const pendingAttempt = (id: string) => ({
  id,
  status: 'pending',
  cancelRequested: false,
  sessionId: `session-${id}`,
});

describe('attempt starter Lambda telemetry context', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it('logs accepted, skipped, and failed invocations with fresh sampled or unsampled context', async () => {
    vi.stubEnv(
      'AGENT_RUNTIME_ARN',
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
    );

    const send = vi.spyOn(BedrockAgentCoreClient.prototype, 'send').mockResolvedValue({
      response: undefined,
      $metadata: { requestId: 'agentcore-request-1' },
    } as never);
    const stdout = captureLambdaStdout();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activeSpan: ReturnType<typeof spanFor> | undefined = spanFor(
      '55555555555555555555555555555555',
      '5555555555555555',
      true,
    );
    vi.spyOn(trace, 'getActiveSpan').mockImplementation(() => activeSpan);

    closeExpired.mockResolvedValueOnce(pendingAttempt('attempt-1'));
    await lambdaHandler(eventFor('attempt-1'), lambdaContext('starter-lambda-request-1'));

    activeSpan = spanFor('66666666666666666666666666666666', '6666666666666666', false);
    closeExpired.mockResolvedValueOnce(undefined);
    await lambdaHandler(eventFor('attempt-2'), lambdaContext('starter-lambda-request-2'));

    activeSpan = spanFor('77777777777777777777777777777777', '7777777777777777', true);
    const privateDependencyError = new Error('private dependency sentinel');
    closeExpired.mockRejectedValueOnce(privateDependencyError);
    let rejection: unknown;
    try {
      await lambdaHandler(eventFor('attempt-3'), lambdaContext('starter-lambda-request-3'));
    } catch (caught) {
      rejection = caught;
    }

    expect(send).toHaveBeenCalledTimes(1);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBe(privateDependencyError);
    expect((rejection as Error).message).not.toContain('private dependency sentinel');
    expect((rejection as Error).stack).not.toContain('private dependency sentinel');
    expect((rejection as Error & { cause?: unknown }).cause).toBeUndefined();

    const records = parseLambdaRecords(stdout.mock.calls);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(records.length).toBeGreaterThanOrEqual(4);
    for (const record of records) {
      expect(record).toHaveProperty('lambdaRequestId');
      expect(record).toHaveProperty('trace_id');
    }

    const accepted = records.filter(
      (record) => record.lambdaRequestId === 'starter-lambda-request-1',
    );
    expect(accepted.length).toBeGreaterThanOrEqual(2);
    expect(accepted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lambdaRequestId: 'starter-lambda-request-1',
          trace_id: '55555555555555555555555555555555',
          stage: 'runtime_invoked',
        }),
        expect.objectContaining({
          lambdaRequestId: 'starter-lambda-request-1',
          trace_id: '55555555555555555555555555555555',
          stage: 'runtime_acknowledged',
          requestId: 'agentcore-request-1',
        }),
      ]),
    );
    expect(
      records.filter((record) => record.lambdaRequestId === 'starter-lambda-request-2'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lambdaRequestId: 'starter-lambda-request-2',
          trace_id: '66666666666666666666666666666666',
          stage: 'dispatch_skipped',
        }),
      ]),
    );
    expect(
      records.filter((record) => record.lambdaRequestId === 'starter-lambda-request-3'),
    ).not.toHaveLength(0);
    expect(JSON.stringify(records)).not.toContain('private dependency sentinel');
  });
});
