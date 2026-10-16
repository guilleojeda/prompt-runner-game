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

export const parseConsoleRecords = (
  logCalls: readonly (readonly unknown[])[],
  errorCalls: readonly (readonly unknown[])[],
): Record<string, unknown>[] =>
  [...logCalls, ...errorCalls].map((args) => {
    if (args.length !== 1) throw new Error('Each application log call must write one JSON line.');
    const line = args[0];
    if (typeof line !== 'string' || /[\r\n]/u.test(line)) {
      throw new Error('Each application log record must fit on one string line.');
    }
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Each application log line must contain one JSON object.');
    }
    return value as Record<string, unknown>;
  });
