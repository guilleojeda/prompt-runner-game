import { DEFAULT_MODEL_KEY, isModelKey, LEGACY_MODEL_KEY, type ModelKey } from './models.js';

/**
 * The versioned draft contract shared by the editor and the API.
 *
 * The catalog is code owned. A draft may select and describe catalog entries,
 * but it cannot replace their identity, schema, or implementation metadata.
 */

export const MAX_DRAFT_BYTES = 65_536;
export const ROBOT_SCHEMA_VERSION = 2 as const;
export const ROBOT_V1_SCHEMA_VERSION = 1 as const;
export const ROBOT_CATALOG_VERSION = 1 as const;

export type RobotSkillId = 'advance' | 'retreat' | 'jump' | 'crouch' | 'swim';

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

/** Shape persisted by phase 2 before model selection was added. */
export interface LegacyRobotDraft {
  readonly schemaVersion: typeof ROBOT_V1_SCHEMA_VERSION;
  readonly catalogVersion: typeof ROBOT_CATALOG_VERSION;
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

/**
 * Published order is part of the serialized draft contract. Keep IDs and
 * opaque IDs stable when adding future catalog entries in a later version.
 */
const freezeCatalogEntry = (entry: RobotCatalogEntry): Readonly<RobotCatalogEntry> =>
  Object.freeze(entry);

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
];

export const ROBOT_CATALOG: readonly RobotCatalogEntry[] = Object.freeze(
  catalogEntries.map(freezeCatalogEntry),
);

const DEFAULT_INSTRUCTIONS =
  'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo';

export type DraftValidationCode = 'invalid' | 'too_large';

export interface DraftValidationOptions {
  /** Permit the v2 model key overhead only when the legacy projection fits. */
  readonly allowLegacyMetadataOverflow?: boolean;
}

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

const cloneSkill = (skill: RobotDraftSkill): RobotDraftSkill =>
  hasOwn(skill, 'description')
    ? { ...skill, description: skill.description }
    : { id: skill.id, enabled: skill.enabled };

const canonicalDraftForSerialization = (
  draft: RobotDraft | LegacyRobotDraft,
): Record<string, unknown> => ({
  schemaVersion: draft.schemaVersion,
  catalogVersion: draft.catalogVersion,
  ...(draft.schemaVersion === ROBOT_SCHEMA_VERSION ? { modelKey: draft.modelKey } : {}),
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

/** Canonical semantic identity treats a legacy draft as the default model. */
const canonicalDraftForComparison = (
  draft: RobotDraft | LegacyRobotDraft,
): Record<string, unknown> =>
  canonicalDraftForSerialization(
    draft.schemaVersion === ROBOT_SCHEMA_VERSION
      ? draft
      : {
          schemaVersion: ROBOT_SCHEMA_VERSION,
          catalogVersion: draft.catalogVersion,
          modelKey: LEGACY_MODEL_KEY,
          instructions: draft.instructions,
          skills: draft.skills,
        },
  );

/** Return the exact UTF-8 byte size of the canonical, expanded draft. */
export const draftByteLength = (draft: RobotDraft | LegacyRobotDraft): number =>
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

/**
 * Validate and canonicalize an untrusted draft. The returned value is a new
 * object in published catalog order and preserves omitted descriptions.
 */
export const validateDraft = (value: unknown, options: DraftValidationOptions = {}): RobotDraft => {
  if (!isRecord(value)) {
    return invalid('La configuración del robot no tiene una forma válida.');
  }
  const legacy = value.schemaVersion === ROBOT_V1_SCHEMA_VERSION;
  const current = value.schemaVersion === ROBOT_SCHEMA_VERSION;
  if ((!legacy && !current) || value.catalogVersion !== ROBOT_CATALOG_VERSION) {
    return invalid('La versión de la configuración no es compatible.');
  }
  const expectedKeys = legacy
    ? ['schemaVersion', 'catalogVersion', 'instructions', 'skills']
    : ['schemaVersion', 'catalogVersion', 'modelKey', 'instructions', 'skills'];
  if (!exactKeys(value, expectedKeys)) {
    return invalid('La configuración del robot no tiene una forma válida.');
  }
  if (current && !isModelKey(value.modelKey)) {
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

  const legacyDraft: LegacyRobotDraft = {
    schemaVersion: ROBOT_V1_SCHEMA_VERSION,
    catalogVersion: ROBOT_CATALOG_VERSION,
    instructions: value.instructions,
    skills: ROBOT_CATALOG.map((entry) => {
      const skill = parsed.find((candidate) => candidate.id === entry.id);
      if (!skill) {
        return invalid(`Falta la habilidad ${entry.id}.`);
      }
      return cloneSkill(skill);
    }),
  };
  // A v1 item was measured without model metadata. Keep it readable at the
  // old 65,536-byte boundary; adding the v2 key must never reject or truncate
  // an otherwise valid stored draft during a GET or admission.
  if (legacy && draftByteLength(legacyDraft) > MAX_DRAFT_BYTES) {
    throw new DraftValidationError(
      'too_large',
      `La configuración supera el límite de ${MAX_DRAFT_BYTES} bytes UTF-8.`,
    );
  }
  const canonical: RobotDraft = {
    schemaVersion: ROBOT_SCHEMA_VERSION,
    catalogVersion: ROBOT_CATALOG_VERSION,
    modelKey: legacy ? LEGACY_MODEL_KEY : (value.modelKey as ModelKey),
    instructions: value.instructions,
    skills: legacyDraft.skills,
  };
  const legacyProjection: LegacyRobotDraft = {
    schemaVersion: ROBOT_V1_SCHEMA_VERSION,
    catalogVersion: canonical.catalogVersion,
    instructions: canonical.instructions,
    skills: canonical.skills,
  };
  const currentTooLarge = draftByteLength(canonical) > MAX_DRAFT_BYTES;
  const legacyMetadataOverflowAllowed =
    options.allowLegacyMetadataOverflow === true &&
    canonical.modelKey === LEGACY_MODEL_KEY &&
    draftByteLength(legacyProjection) <= MAX_DRAFT_BYTES;
  if (!legacy && currentTooLarge && !legacyMetadataOverflowAllowed) {
    throw new DraftValidationError(
      'too_large',
      `La configuración supera el límite de ${MAX_DRAFT_BYTES} bytes UTF-8.`,
    );
  }
  return canonical;
};

export const draftsEqual = (
  left: RobotDraft | LegacyRobotDraft,
  right: RobotDraft | LegacyRobotDraft,
): boolean => {
  try {
    return (
      JSON.stringify(canonicalDraftForComparison(left)) ===
      JSON.stringify(canonicalDraftForComparison(right))
    );
  } catch {
    return false;
  }
};
