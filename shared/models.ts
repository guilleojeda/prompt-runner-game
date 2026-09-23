/**
 * The finite Bedrock model catalog used by the product.
 *
 * These values are code owned. Callers may choose a key, but they cannot
 * provide an arbitrary Bedrock identifier or inference parameter object.
 */

export const MODEL_CATALOG_VERSION = 1 as const;

/** Known product keys remain readable even if a profile is temporarily inactive. */
export const MODEL_KEYS = [
  'gpt-5.6-sol',
  'claude-sonnet-4.6',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-5.5',
] as const;

export type ModelKey = (typeof MODEL_KEYS)[number];

/** Models selectable for new drafts and admissions in the current phase. */
export const AVAILABLE_MODEL_KEYS = ['claude-sonnet-4.6'] as const;
export type AvailableModelKey = (typeof AVAILABLE_MODEL_KEYS)[number];

export type ModelProvider = 'openai' | 'anthropic';
export type ModelToolChoice = 'auto' | 'any';
export type ModelThinking = 'omitted' | 'disabled' | 'adaptive';
export type ModelReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isAwsRegion = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}$/u.test(value);

const modelIdentity = (key: ModelKey): { provider: ModelProvider; baseId: string } => {
  if (key === 'gpt-5.6-sol') return { provider: 'openai', baseId: 'gpt-5.6-sol' };
  return {
    provider: 'anthropic',
    baseId: key.replace('.', '-'),
  };
};

const isHistoricalModelId = (key: ModelKey, provider: ModelProvider, modelId: string): boolean => {
  const identity = modelIdentity(key);
  if (identity.provider !== provider) return false;
  const foundationId = `${provider}.${identity.baseId}`;
  const profilePrefixes =
    key === 'gpt-5.6-sol' ? ['global', 'us'] : ['global', 'us', 'eu', 'au', 'jp'];
  return (
    modelId === foundationId ||
    profilePrefixes.some((prefix) => modelId === `${prefix}.${foundationId}`)
  );
};

/** Parameters that are part of the frozen, per-attempt inference profile. */
export interface ModelProtocol {
  readonly stream: false;
  readonly thinking: ModelThinking;
  readonly toolChoice: ModelToolChoice;
  readonly reasoningEffort?: ModelReasoningEffort;
}

export interface ModelProfile {
  readonly key: ModelKey;
  readonly label: string;
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly region: string;
  readonly api: 'converse';
  readonly profileVersion: string;
  readonly maxTokens: number;
  readonly protocol: Readonly<ModelProtocol>;
}

export class ModelProfileError extends Error {
  public constructor(message = 'El perfil de modelo no es válido.') {
    super(message);
    this.name = 'ModelProfileError';
  }
}

const profile = (value: ModelProfile): Readonly<ModelProfile> =>
  Object.freeze({ ...value, protocol: Object.freeze({ ...value.protocol }) });

/** Known model profiles; new-admission availability is the separate allowlist below. */
export const MODEL_CATALOG: readonly ModelProfile[] = Object.freeze([
  profile({
    key: 'gpt-5.6-sol',
    label: 'GPT-5.6 (Sol)',
    provider: 'openai',
    modelId: 'global.openai.gpt-5.6-sol',
    region: 'us-east-1',
    api: 'converse',
    profileVersion: 'gpt-5.6-sol-global-v1',
    maxTokens: 4096,
    protocol: { stream: false, thinking: 'omitted', toolChoice: 'auto' },
  }),
  profile({
    key: 'claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    modelId: 'global.anthropic.claude-sonnet-4-6',
    region: 'us-east-1',
    api: 'converse',
    profileVersion: 'claude-sonnet-4.6-global-v1',
    maxTokens: 512,
    protocol: { stream: false, thinking: 'omitted', toolChoice: 'any' },
  }),
  profile({
    key: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    modelId: 'global.anthropic.claude-sonnet-5',
    region: 'us-east-1',
    api: 'converse',
    profileVersion: 'claude-sonnet-5-global-v1',
    maxTokens: 512,
    protocol: { stream: false, thinking: 'disabled', toolChoice: 'any' },
  }),
  profile({
    key: 'claude-opus-5',
    label: 'Claude Opus 5',
    provider: 'anthropic',
    modelId: 'global.anthropic.claude-opus-5',
    region: 'us-east-1',
    api: 'converse',
    profileVersion: 'claude-opus-5-global-v1',
    maxTokens: 512,
    protocol: { stream: false, thinking: 'disabled', toolChoice: 'any' },
  }),
  profile({
    key: 'claude-opus-5.5',
    label: 'Claude Opus 5.5',
    provider: 'anthropic',
    modelId: 'global.anthropic.claude-opus-5-5',
    region: 'us-east-1',
    api: 'converse',
    profileVersion: 'claude-opus-5.5-global-v1',
    maxTokens: 4096,
    protocol: {
      stream: false,
      thinking: 'adaptive',
      reasoningEffort: 'low',
      toolChoice: 'auto',
    },
  }),
]);

export const DEFAULT_MODEL_KEY: ModelKey = 'claude-sonnet-4.6';
/** Historical v1 drafts and attempts always used this key. */
export const LEGACY_MODEL_KEY: ModelKey = 'claude-sonnet-5';

const profilesByKey = new Map<ModelKey, ModelProfile>(
  MODEL_CATALOG.map((entry) => [entry.key, entry]),
);
const knownModelKeys = new Set<ModelKey>(MODEL_KEYS);
const availableModelKeys = new Set<ModelKey>(AVAILABLE_MODEL_KEYS);

export const AVAILABLE_MODEL_CATALOG: readonly ModelProfile[] = Object.freeze(
  MODEL_CATALOG.filter((entry) => availableModelKeys.has(entry.key)),
);

export const isModelKey = (value: unknown): value is ModelKey =>
  typeof value === 'string' && knownModelKeys.has(value as ModelKey);

export const isAvailableModelKey = (value: unknown): value is AvailableModelKey =>
  typeof value === 'string' && availableModelKeys.has(value as ModelKey);

/**
 * Parse a frozen profile from a stored attempt or a trusted server boundary.
 * This validates the profile's own shape and protocol invariants without
 * looking up current catalog values, so historical snapshots remain stable.
 */
export const readModelProfile = (value: unknown): Readonly<ModelProfile> => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'key',
      'label',
      'provider',
      'modelId',
      'region',
      'api',
      'profileVersion',
      'maxTokens',
      'protocol',
    ]) ||
    !isModelKey(value.key) ||
    !nonEmptyString(value.label) ||
    (value.provider !== 'openai' && value.provider !== 'anthropic') ||
    !nonEmptyString(value.modelId) ||
    !isHistoricalModelId(value.key, value.provider, value.modelId) ||
    !isAwsRegion(value.region) ||
    value.api !== 'converse' ||
    !nonEmptyString(value.profileVersion) ||
    typeof value.maxTokens !== 'number' ||
    !Number.isSafeInteger(value.maxTokens) ||
    value.maxTokens < 1 ||
    value.maxTokens > 128_000 ||
    !isRecord(value.protocol)
  ) {
    throw new ModelProfileError();
  }
  const protocol = value.protocol;
  const thinking = protocol.thinking;
  const toolChoice = protocol.toolChoice;
  const reasoningEffort = protocol.reasoningEffort;
  const protocolKeys =
    protocol.reasoningEffort === undefined
      ? ['stream', 'thinking', 'toolChoice']
      : ['stream', 'thinking', 'toolChoice', 'reasoningEffort'];
  if (
    !hasExactKeys(protocol, protocolKeys) ||
    protocol.stream !== false ||
    (protocol.thinking !== 'omitted' &&
      protocol.thinking !== 'disabled' &&
      protocol.thinking !== 'adaptive') ||
    (protocol.toolChoice !== 'auto' && protocol.toolChoice !== 'any') ||
    (protocol.thinking === 'adaptive' &&
      (protocol.toolChoice !== 'auto' ||
        (protocol.reasoningEffort !== 'low' &&
          protocol.reasoningEffort !== 'medium' &&
          protocol.reasoningEffort !== 'high' &&
          protocol.reasoningEffort !== 'xhigh' &&
          protocol.reasoningEffort !== 'max'))) ||
    (protocol.thinking !== 'adaptive' && protocol.reasoningEffort !== undefined)
  ) {
    throw new ModelProfileError('La combinación de parámetros del perfil no es válida.');
  }
  return Object.freeze({
    key: value.key,
    label: value.label,
    provider: value.provider,
    modelId: value.modelId,
    region: value.region,
    api: 'converse',
    profileVersion: value.profileVersion,
    maxTokens: value.maxTokens,
    protocol: Object.freeze({
      stream: false,
      thinking: thinking as ModelThinking,
      toolChoice: toolChoice as ModelToolChoice,
      ...(reasoningEffort === undefined
        ? {}
        : { reasoningEffort: reasoningEffort as ModelReasoningEffort }),
    }),
  });
};

export const modelByKey = (key: ModelKey): Readonly<ModelProfile> | undefined =>
  profilesByKey.get(key);

/** Resolve a user supplied key at the server boundary. */
export const resolveModelProfile = (key: unknown): Readonly<ModelProfile> => {
  if (!isModelKey(key)) throw new Error('La selección de modelo no es válida.');
  const resolved = profilesByKey.get(key);
  if (!resolved) throw new Error('El modelo seleccionado no está disponible.');
  return resolved;
};

/** Resolve a profile for a new admission; historical keys remain parseable above. */
export const resolveAvailableModelProfile = (key: unknown): Readonly<ModelProfile> => {
  if (!isAvailableModelKey(key)) {
    throw new Error('El modelo seleccionado no está disponible para nuevos intentos.');
  }
  return resolveModelProfile(key);
};
