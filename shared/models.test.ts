import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_KEY,
  MODEL_CATALOG,
  modelByKey,
  readModelProfile,
  resolveModelProfile,
} from './models.js';

describe('Bedrock model catalog', () => {
  it('publishes only Sonnet 4.6 for current drafts and attempts', () => {
    expect(MODEL_CATALOG.map((model) => model.key)).toEqual(['claude-sonnet-4.6']);
    expect(DEFAULT_MODEL_KEY).toBe('claude-sonnet-4.6');
    expect(modelByKey(DEFAULT_MODEL_KEY)?.modelId).toBe('global.anthropic.claude-sonnet-4-6');
  });

  it('keeps the effective Sonnet 4.6 Converse profile code-owned and immutable', () => {
    const profile = resolveModelProfile(DEFAULT_MODEL_KEY);
    expect(profile).toEqual({
      key: 'claude-sonnet-4.6',
      label: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      region: 'us-east-1',
      api: 'converse',
      profileVersion: 'claude-sonnet-4.6-global-v1',
      maxTokens: 512,
      protocol: { stream: false, thinking: 'omitted', toolChoice: 'any' },
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.protocol)).toBe(true);
    expect(() => resolveModelProfile('claude-sonnet-5')).toThrow();
    expect(() => resolveModelProfile('gpt-5.6-sol')).toThrow();
    expect(() => resolveModelProfile('claude-opus-5.5')).toThrow();
  });

  it('accepts only an exact snapshot of the current profile', () => {
    const current = resolveModelProfile(DEFAULT_MODEL_KEY);
    expect(readModelProfile(current)).toBe(current);
    expect(() =>
      readModelProfile({ ...current, modelId: 'us.anthropic.claude-sonnet-4-6' }),
    ).toThrow();
    expect(() => readModelProfile({ ...current, maxTokens: 777 })).toThrow();
    expect(() =>
      readModelProfile({ ...current, protocol: { ...current.protocol, thinking: 'disabled' } }),
    ).toThrow();
    expect(() => readModelProfile({ ...current, provider: 'openai' })).toThrow();
    expect(() => readModelProfile({ ...current, key: 'claude-sonnet-5' })).toThrow();
    expect(() => readModelProfile({ ...current, inactive: true })).toThrow();
  });
});
