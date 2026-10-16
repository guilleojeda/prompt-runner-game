import { trace, type Span } from '@opentelemetry/api';
import { vi } from 'vitest';

export const spanFor = (traceId: string, spanId: string, sampled: boolean): Span => {
  const span = trace.wrapSpanContext({
    traceId,
    spanId,
    traceFlags: sampled ? 1 : 0,
    isRemote: false,
  });
  vi.spyOn(span, 'isRecording').mockReturnValue(sampled);
  return span;
};

export const captureLambdaStdout = () =>
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

export const parseLambdaRecords = (
  writeCalls: readonly (readonly unknown[])[],
): Record<string, unknown>[] =>
  writeCalls.map((args) => {
    if (args.length !== 1) throw new Error('Each application log record must be one stdout write.');
    const line = args[0];
    if (typeof line !== 'string' || !line.endsWith('\n') || /[\r\n]/u.test(line.slice(0, -1))) {
      throw new Error('Each application log record must be one newline-terminated JSON line.');
    }
    const value: unknown = JSON.parse(line.slice(0, -1));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Each application log line must contain one JSON object.');
    }
    return value as Record<string, unknown>;
  });
