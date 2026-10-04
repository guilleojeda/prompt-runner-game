import { describe, expect, it } from 'vitest';
import {
  measuredCallCost,
  readExecutionLimits,
  reserveCallCost,
  BudgetUnavailableError,
  type ExecutionLimits,
} from './execution-limits.js';
import type { Usage } from './attempt.js';

// Fictional rates and budgets exercise accounting; these are not deployed prices.
export const TEST_EXECUTION_LIMITS: ExecutionLimits = {
  globalActiveAttempts: 2,
  globalDailyMicros: 10_000,
  userDailyMicros: 8_000,
  rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 },
};
const usage: Usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 10,
  reasoningTokens: 5,
  gameTokens: 120,
};
describe('private inference pricing', () => {
  it('reserves counted input at the highest applicable category and bounded output', () => {
    expect(reserveCallCost(100, 512, TEST_EXECUTION_LIMITS)).toBe(1174);
    expect(() => reserveCallCost(NaN, 512, TEST_EXECUTION_LIMITS)).toThrow(BudgetUnavailableError);
  });
  it('charges cache and reasoning exactly once', () => {
    expect(measuredCallCost(usage, TEST_EXECUTION_LIMITS.rates)).toBe(118);
    expect(measuredCallCost({ ...usage, reasoningTokens: 999 }, TEST_EXECUTION_LIMITS.rates)).toBe(
      118,
    );
  });
  it('keeps uncertain totals and missing cache categories reserved', () => {
    expect(
      measuredCallCost({ ...usage, inputTokens: null }, TEST_EXECUTION_LIMITS.rates),
    ).toBeUndefined();
    expect(
      measuredCallCost({ ...usage, outputTokens: null }, TEST_EXECUTION_LIMITS.rates),
    ).toBeUndefined();
    expect(
      measuredCallCost(
        { ...usage, cacheReadTokens: null, cacheWriteTokens: null },
        TEST_EXECUTION_LIMITS.rates,
      ),
    ).toBeUndefined();
    expect(
      measuredCallCost({ ...usage, cacheReadTokens: 200 }, TEST_EXECUTION_LIMITS.rates),
    ).toBeUndefined();
  });
  it.each(['cacheReadTokens', 'cacheWriteTokens'] as const)(
    'does not price partial ordinary input when %s is unknown',
    (field) => {
      expect(
        measuredCallCost(
          { ...usage, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, [field]: null },
          TEST_EXECUTION_LIMITS.rates,
        ),
      ).toBeUndefined();
    },
  );
  it('has no deployable fallback values', () => {
    expect(() => readExecutionLimits({})).toThrow(BudgetUnavailableError);
  });
});
