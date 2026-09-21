export type CacheAccounting = 'separate' | 'included';

export interface NormalizedUsage {
  /** Canonical input volume, with cache content counted exactly once. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly inputWithoutCacheTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** A reported subset of output tokens. It is never added to gameTokens. */
  readonly reasoningTokens: number | null;
  readonly gameTokens: number | null;
}

export interface ProviderUsage {
  /** The provider object as received, including fields this version does not normalize. */
  readonly original: Readonly<Record<string, unknown>> | null;
  readonly normalized: NormalizedUsage;
}

const UNKNOWN_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  inputWithoutCacheTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  gameTokens: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const tokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const checkedSum = (...values: number[]): number | null => {
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
};

/**
 * Normalize a Bedrock Converse usage object without treating its `totalTokens`
 * aggregate as another token category. Bedrock's documented cache counters are
 * disjoint from ordinary input; `included` is retained for fixtures or provider
 * revisions whose input aggregate already includes those categories.
 */
export const normalizeBedrockUsage = (
  value: unknown,
  cacheAccounting: CacheAccounting = 'separate',
): ProviderUsage => {
  if (!isRecord(value)) {
    return { original: null, normalized: UNKNOWN_USAGE };
  }

  const inputWithoutCacheTokens = tokenCount(value.inputTokens);
  const outputTokens = tokenCount(value.outputTokens);
  const cacheReadTokens = tokenCount(value.cacheReadInputTokens);
  const cacheWriteTokens = tokenCount(value.cacheWriteInputTokens);
  const reasoningTokens = tokenCount(value.reasoningTokens);

  let inputTokens: number | null = inputWithoutCacheTokens;
  if (inputTokens !== null && cacheAccounting === 'separate') {
    inputTokens = checkedSum(inputTokens, cacheReadTokens ?? 0, cacheWriteTokens ?? 0);
  }
  const gameTokens =
    inputTokens === null || outputTokens === null ? null : checkedSum(inputTokens, outputTokens);

  return {
    original: value,
    normalized: {
      inputTokens,
      outputTokens,
      inputWithoutCacheTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      gameTokens,
    },
  };
};

export const usageFromBedrockResponseBytes = (
  bytes: Uint8Array | null,
  cacheAccounting: CacheAccounting = 'separate',
): ProviderUsage => {
  if (bytes === null) {
    return normalizeBedrockUsage(undefined, cacheAccounting);
  }
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return normalizeBedrockUsage(isRecord(payload) ? payload.usage : undefined, cacheAccounting);
  } catch {
    return normalizeBedrockUsage(undefined, cacheAccounting);
  }
};
