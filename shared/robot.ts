import { DEFAULT_MODEL_KEY, isModelKey, type ModelKey } from './models.js';

/** The single current draft contract shared by the editor and the API. */
export const MAX_DRAFT_BYTES = 65_536;
export const ROBOT_SCHEMA_VERSION = 3 as const;
export const ROBOT_CATALOG_VERSION = 2 as const;

export type RobotSkillId = 'advance' | 'retreat' | 'jump' | 'crouch' | 'swim' | 'wait';

export interface RobotDraftSkill {
  readonly id: RobotSkillId;
  readonly enabled: boolean;
  readonly description?: string;
}

export interface RobotDraft {
  readonly schemaVersion: typeof ROBOT_SCHEMA_VERSION;
  readonly catalogVersion: typeof ROBOT_CATALOG_VERSION;
  readonly modelKey: ModelKey;
  readonly instructions: string;
  readonly skills: readonly RobotDraftSkill[];
}

export interface DraftSnapshot {
  readonly version: number;
  readonly updatedAt?: string;
  readonly draft: RobotDraft;
}

export interface RobotCatalogEntry {
  readonly id: RobotSkillId;
  readonly name: string;
  /** The model sees this stable identifier; its meaning is deliberately opaque. */
  readonly opaqueId: string;
  /** Human help for the editor, never copied into a user's description. */
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const noArguments = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: false,
});

const directionArguments = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    direction: Object.freeze({
      type: 'string',
      enum: Object.freeze(['izquierda', 'derecha']),
    }),
  }),
  required: Object.freeze(['direction']),
  additionalProperties: false,
});

/** Published order and opaque IDs are part of the current serialized contract. */
const catalogEntries: RobotCatalogEntry[] = [
  {
    id: 'advance',
    name: 'Avanzar',
    opaqueId: 'tool_1',
    description: 'Avanza un tramo.',
    inputSchema: noArguments,
  },
  {
    id: 'retreat',
    name: 'Retroceder',
    opaqueId: 'tool_2',
    description: 'Retrocede un tramo.',
    inputSchema: noArguments,
  },
  {
    id: 'jump',
    name: 'Saltar',
    opaqueId: 'tool_3',
    description: 'Salta en la dirección indicada.',
    inputSchema: directionArguments,
  },
  {
    id: 'crouch',
    name: 'Agacharse y avanzar',
    opaqueId: 'tool_4',
    description: 'Cruza un tramo agachado en la dirección indicada.',
    inputSchema: directionArguments,
  },
  {
    id: 'swim',
    name: 'Nadar',
    opaqueId: 'tool_5',
    description: 'No produce ningún efecto en este recorrido.',
    inputSchema: noArguments,
  },
  {
    id: 'wait',
    name: 'Esperar',
    opaqueId: 'tool_6',
    description: 'Deja pasar un turno sin moverse.',
    inputSchema: noArguments,
  },
];

export const ROBOT_CATALOG: readonly RobotCatalogEntry[] = Object.freeze(
  catalogEntries.map((entry) => Object.freeze(entry)),
);

const DEFAULT_INSTRUCTIONS =
  'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo';

export type DraftValidationCode = 'invalid' | 'too_large';

export class DraftValidationError extends Error {
  public readonly code: DraftValidationCode;

  public constructor(code: DraftValidationCode, message: string) {
    super(message);
    this.name = 'DraftValidationError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const invalid = (message: string): never => {
  throw new DraftValidationError('invalid', message);
};

const catalogEntryById = new Map(ROBOT_CATALOG.map((entry) => [entry.id, entry]));

const canonicalDraftForSerialization = (draft: RobotDraft): Record<string, unknown> => ({
  schemaVersion: draft.schemaVersion,
  catalogVersion: draft.catalogVersion,
  modelKey: draft.modelKey,
  instructions: draft.instructions,
  skills: ROBOT_CATALOG.map((entry) => {
    const selected = draft.skills.find((skill) => skill.id === entry.id);
    if (!selected) {
      throw new DraftValidationError('invalid', `Falta la habilidad ${entry.id}.`);
    }
    return hasOwn(selected, 'description')
      ? { id: entry.id, enabled: selected.enabled, description: selected.description }
      : { id: entry.id, enabled: selected.enabled };
  }),
  catalog: ROBOT_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    opaqueId: entry.opaqueId,
    description: entry.description,
    inputSchema: entry.inputSchema,
  })),
});

/** Return the exact UTF-8 byte size of the canonical, expanded current draft. */
export const draftByteLength = (draft: RobotDraft): number =>
  new TextEncoder().encode(JSON.stringify(canonicalDraftForSerialization(draft))).byteLength;

export const createDefaultDraft = (): RobotDraft => ({
  schemaVersion: ROBOT_SCHEMA_VERSION,
  catalogVersion: ROBOT_CATALOG_VERSION,
  modelKey: DEFAULT_MODEL_KEY,
  instructions: DEFAULT_INSTRUCTIONS,
  skills: ROBOT_CATALOG.map((entry) => ({
    id: entry.id,
    enabled: entry.id === 'advance',
    description: '',
  })),
});

/** Validate and canonicalize an untrusted current draft in published catalog order. */
export const validateDraft = (value: unknown): RobotDraft => {
  if (!isRecord(value)) {
    return invalid('La configuración del robot no tiene una forma válida.');
  }
  if (
    value.schemaVersion !== ROBOT_SCHEMA_VERSION ||
    value.catalogVersion !== ROBOT_CATALOG_VERSION
  ) {
    return invalid('La versión de la configuración no es compatible.');
  }
  if (
    !exactKeys(value, ['schemaVersion', 'catalogVersion', 'modelKey', 'instructions', 'skills'])
  ) {
    return invalid('La configuración del robot no tiene una forma válida.');
  }
  if (!isModelKey(value.modelKey)) {
    return invalid('El modelo seleccionado no pertenece al catálogo publicado.');
  }
  if (typeof value.instructions !== 'string') {
    return invalid('Las instrucciones deben ser texto.');
  }
  if (!Array.isArray(value.skills) || value.skills.length !== ROBOT_CATALOG.length) {
    return invalid('La configuración debe incluir exactamente el catálogo publicado.');
  }

  const seen = new Set<string>();
  const parsed = value.skills.map((rawSkill, index): RobotDraftSkill => {
    if (!isRecord(rawSkill) || !exactKeys(rawSkill, ['id', 'enabled', 'description'])) {
      return invalid(`La habilidad ${index + 1} no tiene una forma válida.`);
    }
    if (typeof rawSkill.id !== 'string' || !catalogEntryById.has(rawSkill.id as RobotSkillId)) {
      return invalid(`La habilidad ${index + 1} no pertenece al catálogo publicado.`);
    }
    if (seen.has(rawSkill.id)) {
      return invalid(`La habilidad ${rawSkill.id} está repetida.`);
    }
    seen.add(rawSkill.id);
    if (typeof rawSkill.enabled !== 'boolean') {
      return invalid(`La habilidad ${rawSkill.id} debe indicar si está habilitada.`);
    }
    if (hasOwn(rawSkill, 'description') && typeof rawSkill.description !== 'string') {
      return invalid(`La descripción de ${rawSkill.id} debe ser texto.`);
    }
    return hasOwn(rawSkill, 'description')
      ? {
          id: rawSkill.id as RobotSkillId,
          enabled: rawSkill.enabled,
          description: rawSkill.description as string,
        }
      : { id: rawSkill.id as RobotSkillId, enabled: rawSkill.enabled };
  });
  if (seen.size !== ROBOT_CATALOG.length) {
    return invalid('La configuración no incluye todas las habilidades publicadas.');
  }

  const canonical: RobotDraft = {
    schemaVersion: ROBOT_SCHEMA_VERSION,
    catalogVersion: ROBOT_CATALOG_VERSION,
    modelKey: value.modelKey,
    instructions: value.instructions,
    skills: ROBOT_CATALOG.map((entry) => {
      const skill = parsed.find((candidate) => candidate.id === entry.id);
      if (!skill) return invalid(`Falta la habilidad ${entry.id}.`);
      return hasOwn(skill, 'description')
        ? { id: entry.id, enabled: skill.enabled, description: skill.description }
        : { id: entry.id, enabled: skill.enabled };
    }),
  };
  if (draftByteLength(canonical) > MAX_DRAFT_BYTES) {
    throw new DraftValidationError(
      'too_large',
      `La configuración supera el límite de ${MAX_DRAFT_BYTES} bytes UTF-8.`,
    );
  }
  return canonical;
};

export const draftsEqual = (left: RobotDraft, right: RobotDraft): boolean => {
  try {
    return (
      JSON.stringify(canonicalDraftForSerialization(left)) ===
      JSON.stringify(canonicalDraftForSerialization(right))
    );
  } catch {
    return false;
  }
};
