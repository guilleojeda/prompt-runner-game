import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_KEY,
  AVAILABLE_MODEL_CATALOG,
  AVAILABLE_MODEL_KEYS,
  MODEL_CATALOG,
  MODEL_KEYS,
  resolveAvailableModelProfile,
  modelByKey,
  readModelProfile,
  resolveModelProfile,
} from './models.js';

describe('Bedrock model catalog', () => {
  it('keeps historical profiles while publishing Sonnet 4.6 as the current default', () => {
    expect(MODEL_CATALOG.map((model) => model.key)).toEqual([
      'gpt-5.6-sol',
      'claude-sonnet-4.6',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-5.5',
    ]);
    expect(DEFAULT_MODEL_KEY).toBe('claude-sonnet-4.6');
    expect(modelByKey(DEFAULT_MODEL_KEY)?.modelId).toBe('global.anthropic.claude-sonnet-4-6');
    expect(MODEL_CATALOG.some((model) => model.key.includes('gpt-6'))).toBe(false);
    expect(MODEL_KEYS).toEqual(MODEL_CATALOG.map((model) => model.key));
    expect(AVAILABLE_MODEL_KEYS).toEqual(['claude-sonnet-4.6']);
    expect(AVAILABLE_MODEL_CATALOG.map((model) => model.key)).toEqual(['claude-sonnet-4.6']);
  });

  it('keeps parameters in each typed profile', () => {
    expect(resolveModelProfile('gpt-5.6-sol').protocol).toEqual({
      stream: false,
      thinking: 'omitted',
      toolChoice: 'auto',
    });
    expect(resolveModelProfile('claude-opus-5.5').protocol).toEqual({
      stream: false,
      thinking: 'adaptive',
      reasoningEffort: 'low',
      toolChoice: 'auto',
    });
    expect(() => resolveModelProfile('global.anthropic.claude-sonnet-5')).toThrow();
    expect(resolveAvailableModelProfile('claude-sonnet-4.6').key).toBe('claude-sonnet-4.6');
    expect(() => resolveAvailableModelProfile('claude-sonnet-5')).toThrow();
  });

  it('reads a complete historical profile without consulting current catalog values', () => {
    const stored = {
      ...resolveModelProfile('claude-sonnet-5'),
      label: 'Sonnet 5 historical label',
      modelId: 'us.anthropic.claude-sonnet-5',
      region: 'eu-west-1',
      maxTokens: 777,
      protocol: { stream: false, thinking: 'disabled', toolChoice: 'any' },
    };
    const parsed = readModelProfile(stored);

    expect(parsed).toMatchObject(stored);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.protocol)).toBe(true);
    expect(() => readModelProfile({ ...stored, protocol: { stream: false } })).toThrow();
    expect(() => readModelProfile({ ...stored, modelId: 'arbitrary-model' })).toThrow();
    expect(() => readModelProfile({ ...stored, provider: 'openai' })).toThrow();
    expect(() =>
      readModelProfile({
        ...resolveModelProfile('gpt-5.6-sol'),
        modelId: 'eu.openai.gpt-5.6-sol',
      }),
    ).toThrow();
  });
});
