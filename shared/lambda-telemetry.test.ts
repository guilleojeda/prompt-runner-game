import { afterEach, describe, expect, it, vi } from 'vitest';
import { logLambdaRecord } from './lambda-telemetry.js';
import { captureLambdaStdout, parseLambdaRecords } from './testing/lambda-telemetry.js';

describe('Lambda structured log output', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one top-level JSON object directly to stdout with its severity', () => {
    const stdout = captureLambdaStdout();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logLambdaRecord('log', { requestId: 'gateway-request', lambdaRequestId: 'lambda-request' });
    logLambdaRecord('error', { component: 'attempt-starter', stage: 'invocation_failed' });

    expect(parseLambdaRecords(stdout.mock.calls)).toEqual([
      {
        requestId: 'gateway-request',
        lambdaRequestId: 'lambda-request',
        level: 'INFO',
      },
      {
        component: 'attempt-starter',
        stage: 'invocation_failed',
        level: 'ERROR',
      },
    ]);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
