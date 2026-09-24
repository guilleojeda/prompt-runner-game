/** The only model profile offered for new attempts in the current contract. */
export type ModelKey = 'claude-sonnet-4.6';

/** Parameters that are part of the frozen, per-attempt inference profile. */
export interface ModelProtocol {
  readonly stream: false;
  readonly thinking: 'omitted';
  readonly toolChoice: 'any';
}

export interface ModelProfile {
  readonly key: ModelKey;
  readonly label: string;
  readonly provider: 'anthropic';
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

const profile: Readonly<ModelProfile> = Object.freeze({
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

export const MODEL_CATALOG: readonly ModelProfile[] = Object.freeze([profile]);
export const DEFAULT_MODEL_KEY: ModelKey = 'claude-sonnet-4.6';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return (
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

export const isModelKey = (value: unknown): value is ModelKey => value === DEFAULT_MODEL_KEY;

/** Read a frozen model snapshot only when it is the current, code-owned profile. */
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
    !isRecord(value.protocol) ||
    !hasExactKeys(value.protocol, ['stream', 'thinking', 'toolChoice']) ||
    value.key !== profile.key ||
    value.label !== profile.label ||
    value.provider !== profile.provider ||
    value.modelId !== profile.modelId ||
    value.region !== profile.region ||
    value.api !== profile.api ||
    value.profileVersion !== profile.profileVersion ||
    value.maxTokens !== profile.maxTokens ||
    value.protocol.stream !== profile.protocol.stream ||
    value.protocol.thinking !== profile.protocol.thinking ||
    value.protocol.toolChoice !== profile.protocol.toolChoice
  ) {
    throw new ModelProfileError('El perfil de modelo guardado no coincide con el catálogo actual.');
  }
  return profile;
};

export const modelByKey = (key: ModelKey): Readonly<ModelProfile> | undefined =>
  key === profile.key ? profile : undefined;

/** Resolve a user supplied key at the server boundary. */
export const resolveModelProfile = (key: unknown): Readonly<ModelProfile> => {
  if (!isModelKey(key)) throw new Error('La selección de modelo no es válida.');
  return profile;
};
