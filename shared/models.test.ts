import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_KEY,
  MODEL_CATALOG,
  modelByKey,
  readModelProfile,
  resolveModelProfile,
} from './models.js';

describe('Bedrock model catalog', () => {
  it('publishes the finite current catalog with Sonnet 4.6 as its default', () => {
    expect(MODEL_CATALOG.map((model) => model.key)).toEqual([
      'claude-sonnet-4.6',
      'claude-sonnet-5.5',
      'claude-opus-5.5',
      'openai-gpt-6.1-sol',
      'openai-gpt-6-luna',
    ]);
    expect(DEFAULT_MODEL_KEY).toBe('claude-sonnet-4.6');
    expect(modelByKey(DEFAULT_MODEL_KEY)?.modelId).toBe('global.anthropic.claude-sonnet-4-6');
    expect(MODEL_CATALOG.every((model) => model.api === 'converse')).toBe(true);
    expect(MODEL_CATALOG.every((model) => model.protocol.stream === false)).toBe(true);
  });

  it('keeps Sonnet 4.6 unchanged and defines model-specific request protocols', () => {
    expect(resolveModelProfile(DEFAULT_MODEL_KEY)).toEqual({
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

    expect(modelByKey('claude-sonnet-5.5')).toMatchObject({
      provider: 'anthropic',
      modelId: 'global.anthropic.claude-sonnet-5-5',
      maxTokens: 4_096,
      protocol: {
        stream: false,
        thinking: 'adaptive',
        effort: 'low',
        toolChoice: 'auto',
        reasoningContent: 'allowed',
      },
    });
    expect(modelByKey('claude-opus-5.5')).toMatchObject({
      provider: 'anthropic',
      modelId: 'global.anthropic.claude-opus-5-5',
      maxTokens: 4_096,
      protocol: {
        stream: false,
        thinking: 'adaptive',
        effort: 'low',
        toolChoice: 'auto',
        reasoningContent: 'allowed',
      },
    });
    expect(modelByKey('openai-gpt-6.1-sol')).toMatchObject({
      provider: 'openai',
      modelId: 'us.openai.gpt-6.1-sol',
      maxTokens: 4_096,
      protocol: {
        stream: false,
        thinking: 'omitted',
        toolChoice: 'auto',
        reasoningContent: 'allowed',
      },
    });
    expect(modelByKey('openai-gpt-6.1-sol')?.protocol).not.toHaveProperty('effort');
    expect(modelByKey('openai-gpt-6-luna')).toMatchObject({
      provider: 'openai',
      modelId: 'global.openai.gpt-6-luna',
      maxTokens: 4_096,
      protocol: {
        stream: false,
        thinking: 'omitted',
        toolChoice: 'auto',
        reasoningContent: 'allowed',
      },
    });
    expect(modelByKey('openai-gpt-6-luna')?.protocol).not.toHaveProperty('effort');

    for (const profile of MODEL_CATALOG) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.protocol)).toBe(true);
    }
  });

  it('accepts only exact snapshots of profiles in the current catalog', () => {
    for (const profile of MODEL_CATALOG) {
      expect(readModelProfile(profile)).toBe(profile);
      expect(readModelProfile(structuredClone(profile))).toBe(profile);
    }

    const current = resolveModelProfile(DEFAULT_MODEL_KEY);
    const gpt = resolveModelProfile('openai-gpt-6.1-sol');
    const sonnet = resolveModelProfile('claude-sonnet-5.5');
    const changed = [
      { ...current, modelId: 'us.anthropic.claude-sonnet-4-6' },
      { ...current, maxTokens: 777 },
      { ...current, provider: 'openai' },
      { ...current, inactive: true },
      { ...gpt, region: 'us-west-2' },
      { ...gpt, protocol: { ...gpt.protocol, effort: 'low' } },
      { ...gpt, protocol: { ...gpt.protocol, thinking: 'adaptive' } },
      { ...sonnet, protocol: { ...sonnet.protocol, toolChoice: 'any' } },
      { ...sonnet, protocol: { ...sonnet.protocol, reasoningContent: 'forbidden' } },
    ];

    for (const candidate of changed) {
      expect(() => readModelProfile(candidate)).toThrow();
    }
    expect(() => readModelProfile({ modelId: current.modelId })).toThrow();
  });

  it('rejects IDs, removed selections, and arbitrary keys at the model boundary', () => {
    for (const key of [
      'global.anthropic.claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'gpt-5.6-sol',
      'openai-gpt-6-sol',
      'provider-model',
    ]) {
      expect(() => resolveModelProfile(key)).toThrow();
    }
    expect(() => resolveModelProfile(undefined)).toThrow();
  });
});
