/** The finite set of model profiles currently available for new attempts. */
export type ModelKey =
  | 'claude-sonnet-4.6'
  | 'claude-sonnet-5.5'
  | 'claude-opus-5.5'
  | 'openai-gpt-6.1-sol'
  | 'openai-gpt-6-luna';

export type ModelProvider = 'anthropic' | 'openai';

/**
 * Parameters that are part of the frozen, per-attempt inference profile.
 * `thinking: 'omitted'` records that no thinking override is sent; it does not
 * assert a provider default. The optional response flag only permits native
 * reasoning blocks for profiles whose request contract supports them.
 */
export type ModelProtocol =
  | Readonly<{
      stream: false;
      toolChoice: 'any';
      thinking: 'omitted';
      reasoningContent?: 'allowed';
    }>
  | Readonly<{
      stream: false;
      toolChoice: 'auto';
      thinking: 'omitted';
      reasoningContent: 'allowed';
    }>
  | Readonly<{
      stream: false;
      toolChoice: 'auto';
      thinking: 'adaptive';
      effort: 'low';
      reasoningContent: 'allowed';
    }>;

export interface ModelProfile {
  readonly key: ModelKey;
  readonly label: string;
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly region: string;
  readonly api: 'converse';
  readonly profileVersion: string;
  readonly maxTokens: number;
  readonly protocol: ModelProtocol;
}

export class ModelProfileError extends Error {
  public constructor(message = 'El perfil de modelo no es válido.') {
    super(message);
    this.name = 'ModelProfileError';
  }
}

const sonnet46: Readonly<ModelProfile> = Object.freeze({
  key: 'claude-sonnet-4.6',
  label: 'Claude Sonnet 4.6',
  provider: 'anthropic',
  modelId: 'global.anthropic.claude-sonnet-4-6',
  region: 'us-east-1',
  api: 'converse',
  profileVersion: 'claude-sonnet-4.6-global-v1',
  maxTokens: 512,
  protocol: Object.freeze({ stream: false, thinking: 'omitted', toolChoice: 'any' }),
});

const sonnet55: Readonly<ModelProfile> = Object.freeze({
  key: 'claude-sonnet-5.5',
  label: 'Claude Sonnet 5.5',
  provider: 'anthropic',
  modelId: 'global.anthropic.claude-sonnet-5-5',
  region: 'us-east-1',
  api: 'converse',
  profileVersion: 'claude-sonnet-5.5-global-v1',
  maxTokens: 4_096,
  protocol: Object.freeze({
    stream: false,
    thinking: 'adaptive',
    effort: 'low',
    toolChoice: 'auto',
    reasoningContent: 'allowed',
  }),
});

const opus55: Readonly<ModelProfile> = Object.freeze({
  key: 'claude-opus-5.5',
  label: 'Claude Opus 5.5',
  provider: 'anthropic',
  modelId: 'global.anthropic.claude-opus-5-5',
  region: 'us-east-1',
  api: 'converse',
  profileVersion: 'claude-opus-5.5-global-v1',
  maxTokens: 4_096,
  protocol: Object.freeze({
    stream: false,
    thinking: 'adaptive',
    effort: 'low',
    toolChoice: 'auto',
    reasoningContent: 'allowed',
  }),
});

const gpt61Sol: Readonly<ModelProfile> = Object.freeze({
  key: 'openai-gpt-6.1-sol',
  label: 'GPT-6.1 Sol',
  provider: 'openai',
  modelId: 'us.openai.gpt-6.1-sol',
  region: 'us-east-1',
  api: 'converse',
  profileVersion: 'openai-gpt-6.1-sol-us-v1',
  maxTokens: 4_096,
  protocol: Object.freeze({
    stream: false,
    thinking: 'omitted',
    toolChoice: 'auto',
    reasoningContent: 'allowed',
  }),
});

const gpt6Luna: Readonly<ModelProfile> = Object.freeze({
  key: 'openai-gpt-6-luna',
  label: 'GPT-6 Luna',
  provider: 'openai',
  modelId: 'global.openai.gpt-6-luna',
  region: 'us-east-1',
  api: 'converse',
  profileVersion: 'openai-gpt-6-luna-global-v1',
  maxTokens: 4_096,
  protocol: Object.freeze({
    stream: false,
    thinking: 'omitted',
    toolChoice: 'auto',
    reasoningContent: 'allowed',
  }),
});

export const MODEL_CATALOG: readonly Readonly<ModelProfile>[] = Object.freeze([
  sonnet46,
  sonnet55,
  opus55,
  gpt61Sol,
  gpt6Luna,
]);
export const DEFAULT_MODEL_KEY: ModelKey = 'claude-sonnet-4.6';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const profilesByKey: ReadonlyMap<ModelKey, Readonly<ModelProfile>> = new Map(
  MODEL_CATALOG.map((profile) => [profile.key, profile]),
);

const exactSnapshotMatch = (actual: unknown, expected: unknown): boolean => {
  if (
    actual === null ||
    expected === null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  ) {
    return Object.is(actual, expected);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((item, index) => exactSnapshotMatch(item, expected[index]))
    );
  }
  if (!isRecord(actual) || !isRecord(expected)) return false;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(expected, key) &&
        exactSnapshotMatch(actual[key], expected[key]),
    )
  );
};

export const isModelKey = (value: unknown): value is ModelKey =>
  typeof value === 'string' && profilesByKey.has(value as ModelKey);

/** Read a frozen model snapshot only when it is a current, code-owned profile. */
export const readModelProfile = (value: unknown): Readonly<ModelProfile> => {
  if (!isRecord(value) || !isModelKey(value.key)) {
    throw new ModelProfileError('La selección de modelo no pertenece al catálogo publicado.');
  }
  const profile = profilesByKey.get(value.key);
  if (!profile || !exactSnapshotMatch(value, profile)) {
    throw new ModelProfileError('El perfil de modelo guardado no coincide con el catálogo actual.');
  }
  return profile;
};

export const modelByKey = (key: ModelKey): Readonly<ModelProfile> | undefined =>
  profilesByKey.get(key);

/** Resolve a user supplied key at the server boundary. */
export const resolveModelProfile = (key: unknown): Readonly<ModelProfile> => {
  if (!isModelKey(key)) throw new Error('La selección de modelo no es válida.');
  return profilesByKey.get(key)!;
};
