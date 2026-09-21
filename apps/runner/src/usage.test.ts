import { describe, expect, it } from 'vitest';
import { normalizeBedrockUsage, usageFromBedrockResponseBytes } from './usage.js';

describe('Bedrock usage normalization', () => {
  it('adds disjoint cache categories once and ignores overlapping aggregates', () => {
    const original = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 10,
      futureProviderField: 7,
    };

    expect(normalizeBedrockUsage(original, 'separate')).toEqual({
      original,
      normalized: {
        inputTokens: 130,
        outputTokens: 50,
        inputWithoutCacheTokens: 100,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: null,
        gameTokens: 180,
      },
    });
  });

  it('does not add cache details to an input aggregate that already includes them', () => {
    const usage = normalizeBedrockUsage(
      {
        inputTokens: 130,
        outputTokens: 50,
        totalTokens: 180,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 10,
        reasoningTokens: 12,
      },
      'included',
    );

    expect(usage.normalized).toEqual({
      inputTokens: 130,
      outputTokens: 50,
      inputWithoutCacheTokens: 130,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      reasoningTokens: 12,
      gameTokens: 180,
    });
  });

  it('keeps absent or incomplete provider usage unknown instead of inventing zero', () => {
    expect(normalizeBedrockUsage(undefined).normalized).toEqual({
      inputTokens: null,
      outputTokens: null,
      inputWithoutCacheTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      gameTokens: null,
    });
    expect(normalizeBedrockUsage({ inputTokens: 12 }).normalized).toMatchObject({
      inputTokens: 12,
      outputTokens: null,
      gameTokens: null,
    });
  });

  it('extracts the original usage object byte response and preserves unknown fields', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        output: { message: { role: 'assistant', content: [] } },
        usage: { inputTokens: 9, outputTokens: 4, vendorDetail: { class: 'future' } },
      }),
    );

    expect(usageFromBedrockResponseBytes(bytes)).toEqual({
      original: {
        inputTokens: 9,
        outputTokens: 4,
        vendorDetail: { class: 'future' },
      },
      normalized: {
        inputTokens: 9,
        outputTokens: 4,
        inputWithoutCacheTokens: 9,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        gameTokens: 13,
      },
    });
    expect(usageFromBedrockResponseBytes(new TextEncoder().encode('{invalid')).original).toBeNull();
  });
});
