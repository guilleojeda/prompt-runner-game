import type { RobotSkillId } from './robot.js';

/** Version of the deterministic rules used by the published level. */
export const RULES_VERSION = 2 as const;

export type GameStatus = 'running' | 'victory' | 'defeat' | 'incomplete';
export type Direction = 'left' | 'right';
export type TerrainState = 'ground' | 'pit' | 'branch' | 'barrier_low' | 'barrier_high';

export type StaticTerrainState = 'ground' | 'pit' | 'branch';

export interface StaticLevelSegment {
  readonly type: StaticTerrainState;
}

export interface PeriodicLevelSegment {
  readonly type: 'barrier' | 'platform';
  readonly phases: readonly TerrainState[];
  readonly offset: number;
}

export type LevelSegment = StaticLevelSegment | PeriodicLevelSegment;

export interface LevelObject {
  readonly id: string;
  readonly support: number;
  readonly scoreValue: number;
  readonly requiredForExit?: boolean;
}

export interface LevelExit {
  readonly support: number;
  readonly requiredObjectIds: readonly string[];
}

export interface LevelDefinition {
  readonly id: string;
  readonly version: number;
  readonly rulesVersion: typeof RULES_VERSION;
  readonly maxTurns: number;
  readonly segments: readonly LevelSegment[];
  readonly objects: readonly LevelObject[];
  readonly exit: LevelExit;
}

export interface ScoreRules {
  readonly base: number;
  readonly turnWeight: number;
  readonly tokenWeight: number;
  readonly tokenUnit: number;
  readonly decimalPlaces: number;
  readonly allowNegative: boolean;
  readonly objectValues: Readonly<Record<string, number>>;
}

export const DEFAULT_SCORE_RULES: ScoreRules = Object.freeze({
  base: 1000,
  turnWeight: 10,
  tokenWeight: 1,
  tokenUnit: 1000,
  decimalPlaces: 2,
  allowNegative: true,
  objectValues: Object.freeze({}),
});

export interface GameRules {
  readonly version: typeof RULES_VERSION;
  readonly maxTurns: number;
  readonly score: ScoreRules;
}

export const RULES: GameRules = Object.freeze({
  version: RULES_VERSION,
  maxTurns: 16,
  score: DEFAULT_SCORE_RULES,
});

/** The single current level: ground, pit, ground, branch, barrier, platform, ground. */
export const LEVEL: LevelDefinition = Object.freeze({
  id: 'principal-periodico-v2',
  version: 2,
  rulesVersion: RULES_VERSION,
  maxTurns: RULES.maxTurns,
  segments: Object.freeze([
    Object.freeze({ type: 'ground' as const }),
    Object.freeze({ type: 'pit' as const }),
    Object.freeze({ type: 'ground' as const }),
    Object.freeze({ type: 'branch' as const }),
    Object.freeze({
      type: 'barrier' as const,
      phases: Object.freeze(['barrier_low', 'barrier_high'] as const),
      offset: 0,
    }),
    Object.freeze({
      type: 'platform' as const,
      phases: Object.freeze(['ground', 'pit', 'pit'] as const),
      offset: 0,
    }),
    Object.freeze({ type: 'ground' as const }),
  ]),
  objects: Object.freeze([]),
  exit: Object.freeze({ support: 7, requiredObjectIds: Object.freeze([]) }),
});

export interface GameSnapshot {
  readonly id: string;
  /** Internal support index. It is never included in an agent observation. */
  readonly support: number;
  readonly turnsUsed: number;
  /** The phase used to evaluate the current/last action. */
  readonly phaseTurn: number;
  /** Effective state of every level segment at phaseTurn. */
  readonly terrain: readonly TerrainState[];
  readonly remainingObjects: readonly string[];
  readonly inventory: readonly string[];
  readonly exitEnabled: boolean;
  readonly status: GameStatus;
  /** Highest support reached, used for incomplete-attempt progress. */
  readonly maxSupportReached: number;
}

export type NormalizedAction =
  | { readonly kind: 'advance' }
  | { readonly kind: 'retreat' }
  | { readonly kind: 'jump'; readonly direction: Direction }
  | { readonly kind: 'crouch'; readonly direction: Direction }
  | { readonly kind: 'swim' }
  | { readonly kind: 'wait' };

export type ResolutionOutcome = 'moved' | 'no_op' | 'fall' | 'collision';

export type ResolutionReason =
  | 'moved'
  | 'left_boundary'
  | 'right_boundary'
  | 'swim_no_effect'
  | 'wait'
  | 'walk_into_pit'
  | 'crouch_into_pit'
  | 'walk_into_branch'
  | 'jump_into_branch'
  | 'walk_into_barrier'
  | 'crouch_into_low_barrier'
  | 'jump_into_high_barrier';

export interface ActionResolutionBase {
  readonly outcome: ResolutionOutcome;
  readonly reason: ResolutionReason;
}

export interface MovementResolution extends ActionResolutionBase {
  readonly outcome: 'moved' | 'fall' | 'collision';
  readonly segment: number;
  readonly targetSupport: number;
}

export interface NoOpResolution extends ActionResolutionBase {
  readonly outcome: 'no_op';
}

export type ActionResolution = MovementResolution | NoOpResolution;

export interface ResolvedAction {
  readonly action: NormalizedAction;
  readonly before: GameSnapshot;
  readonly after: GameSnapshot;
  readonly resolution: ActionResolution;
}

export interface LocalSegmentObservation {
  readonly kind: 'segment';
  readonly terrain: TerrainState;
}

export interface BoundaryObservation {
  readonly kind: 'boundary';
}

export type LocalSideObservation = LocalSegmentObservation | BoundaryObservation;

export interface LocalObservation {
  /** Only objects at the current support and a local exit marker are exposed. */
  readonly here: {
    readonly objects: readonly string[];
    readonly exit?: { readonly enabled: boolean };
  };
  readonly left: LocalSideObservation;
  readonly right: LocalSideObservation;
}

export interface SelectionSnapshotEntry {
  readonly id: RobotSkillId;
  readonly opaqueId: string;
  readonly enabled?: boolean;
}

export type SelectionSnapshot = readonly SelectionSnapshotEntry[];

export type SelectionErrorCode =
  'invalid_tool' | 'unknown_tool' | 'disabled_tool' | 'invalid_arguments';

export class SelectionValidationError extends Error {
  public readonly code: SelectionErrorCode;

  public constructor(code: SelectionErrorCode, message: string) {
    super(message);
    this.name = 'SelectionValidationError';
    this.code = code;
  }
}

export class GameStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GameStateError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isResolutionReason = (value: unknown): value is ResolutionReason =>
  value === 'moved' ||
  value === 'left_boundary' ||
  value === 'right_boundary' ||
  value === 'swim_no_effect' ||
  value === 'wait' ||
  value === 'walk_into_pit' ||
  value === 'crouch_into_pit' ||
  value === 'walk_into_branch' ||
  value === 'jump_into_branch' ||
  value === 'walk_into_barrier' ||
  value === 'crouch_into_low_barrier' ||
  value === 'jump_into_high_barrier';

/** Type guard for the single normalized action contract used by game and replay records. */
export const isNormalizedAction = (value: unknown): value is NormalizedAction => {
  if (!isRecord(value)) return false;
  if (
    value.kind === 'advance' ||
    value.kind === 'retreat' ||
    value.kind === 'swim' ||
    value.kind === 'wait'
  ) {
    return !hasOwn(value, 'direction');
  }
  return (
    (value.kind === 'jump' || value.kind === 'crouch') &&
    (value.direction === 'left' || value.direction === 'right')
  );
};

/** Type guard for the single action resolution contract used by durable and public records. */
export const isActionResolution = (value: unknown): value is ActionResolution => {
  if (!isRecord(value) || !isResolutionReason(value.reason)) return false;
  if (value.outcome === 'no_op') return true;
  return (
    (value.outcome === 'moved' || value.outcome === 'fall' || value.outcome === 'collision') &&
    typeof value.segment === 'number' &&
    Number.isSafeInteger(value.segment) &&
    value.segment >= 0 &&
    typeof value.targetSupport === 'number' &&
    Number.isSafeInteger(value.targetSupport) &&
    value.targetSupport >= 0
  );
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
};

const cloneAndFreeze = <T extends object>(value: T): Readonly<T> => deepFreeze(value);

const validTerrain = (value: unknown): value is TerrainState =>
  value === 'ground' ||
  value === 'pit' ||
  value === 'branch' ||
  value === 'barrier_low' ||
  value === 'barrier_high';

const validStaticTerrain = (value: unknown): value is StaticTerrainState =>
  value === 'ground' || value === 'pit' || value === 'branch';

export const effectiveTerrain = (
  level: LevelDefinition,
  phaseTurn: number,
): readonly TerrainState[] => {
  if (!Number.isInteger(phaseTurn) || phaseTurn < 0) {
    throw new GameStateError('The phase turn must be a non-negative integer.');
  }
  return Object.freeze(
    level.segments.map((segment) => {
      if (segment.type !== 'barrier' && segment.type !== 'platform') return segment.type;
      const phaseIndex =
        (((phaseTurn + segment.offset) % segment.phases.length) + segment.phases.length) %
        segment.phases.length;
      return segment.phases[phaseIndex] as TerrainState;
    }),
  );
};

const validateLevel = (level: LevelDefinition): void => {
  if (
    !level ||
    typeof level.id !== 'string' ||
    !Number.isInteger(level.version) ||
    level.rulesVersion !== RULES_VERSION ||
    !Number.isInteger(level.maxTurns) ||
    level.maxTurns < 1 ||
    !Array.isArray(level.segments) ||
    level.segments.length === 0 ||
    level.exit.support !== level.segments.length
  ) {
    throw new GameStateError('The level definition is invalid.');
  }
  for (const segment of level.segments) {
    if (
      !segment ||
      (segment.type !== 'barrier' &&
        segment.type !== 'platform' &&
        !validStaticTerrain(segment.type))
    ) {
      throw new GameStateError('The level contains an invalid terrain type.');
    }
    if (segment.type === 'barrier' || segment.type === 'platform') {
      if (
        !Array.isArray(segment.phases) ||
        segment.phases.length === 0 ||
        !Number.isInteger(segment.offset) ||
        segment.phases.some((phase: unknown) => {
          if (!validTerrain(phase)) return true;
          return segment.type === 'barrier'
            ? phase !== 'barrier_low' && phase !== 'barrier_high'
            : phase !== 'ground' && phase !== 'pit';
        })
      ) {
        throw new GameStateError('The level contains an invalid periodic segment.');
      }
    }
  }
  const objectIds = new Set<string>();
  for (const object of level.objects) {
    if (
      !object.id ||
      objectIds.has(object.id) ||
      !Number.isInteger(object.support) ||
      object.support < 0 ||
      object.support > level.segments.length ||
      !Number.isFinite(object.scoreValue)
    ) {
      throw new GameStateError('The level contains an invalid object.');
    }
    objectIds.add(object.id);
  }
  for (const requiredId of level.exit.requiredObjectIds) {
    if (!objectIds.has(requiredId)) {
      throw new GameStateError('The exit requires an object missing from the level.');
    }
  }
};

const exitIsEnabled = (level: LevelDefinition, inventory: readonly string[]): boolean => {
  const inventoryIds = new Set(inventory);
  return level.exit.requiredObjectIds.every((id) => inventoryIds.has(id));
};

const stateIdForTurns = (turnsUsed: number): string => `state-${turnsUsed}`;

const createSnapshot = (value: Omit<GameSnapshot, 'id'> & { readonly id: string }): GameSnapshot =>
  cloneAndFreeze({
    ...value,
    terrain: Object.freeze([...value.terrain]),
    remainingObjects: Object.freeze([...value.remainingObjects]),
    inventory: Object.freeze([...value.inventory]),
  }) as GameSnapshot;

export const createInitialState = (level: LevelDefinition = LEVEL): GameSnapshot => {
  validateLevel(level);
  const terrain = effectiveTerrain(level, 0);
  const remainingObjects = level.objects.map((object) => object.id);
  return createSnapshot({
    id: stateIdForTurns(0),
    support: 0,
    turnsUsed: 0,
    phaseTurn: 0,
    terrain,
    remainingObjects,
    inventory: [],
    exitEnabled: exitIsEnabled(level, []),
    status: 'running',
    maxSupportReached: 0,
  });
};

const exactArgumentKeys = (args: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return (
    Object.keys(args).every((key) => allowed.has(key)) && keys.every((key) => hasOwn(args, key))
  );
};

const normalizedDirection = (value: unknown): Direction | undefined =>
  value === 'izquierda' ? 'left' : value === 'derecha' ? 'right' : undefined;

/**
 * Validate one opaque tool selection against the fixed catalog snapshot.
 * The snapshot contains only the entries offered to the model, with enabled
 * omitted meaning enabled; catalog entries from robot.ts are structurally
 * compatible and may be passed directly when all entries are enabled.
 */
export const normalizeSelection = (
  opaqueTool: unknown,
  args: unknown,
  snapshot: SelectionSnapshot,
): NormalizedAction => {
  if (typeof opaqueTool !== 'string') {
    throw new SelectionValidationError('invalid_tool', 'The selected tool ID must be a string.');
  }
  const entry = snapshot.find((candidate) => candidate.opaqueId === opaqueTool);
  if (!entry) {
    throw new SelectionValidationError('unknown_tool', 'The selected tool is not in the snapshot.');
  }
  if (entry.enabled === false) {
    throw new SelectionValidationError('disabled_tool', 'The selected tool is disabled.');
  }
  if (!isRecord(args)) {
    throw new SelectionValidationError('invalid_arguments', 'Tool arguments must be an object.');
  }

  if (
    entry.id === 'advance' ||
    entry.id === 'retreat' ||
    entry.id === 'swim' ||
    entry.id === 'wait'
  ) {
    if (!exactArgumentKeys(args, [])) {
      throw new SelectionValidationError('invalid_arguments', 'This tool takes no arguments.');
    }
    return { kind: entry.id };
  }

  if (!exactArgumentKeys(args, ['direction'])) {
    throw new SelectionValidationError('invalid_arguments', 'The direction argument is required.');
  }
  const direction = normalizedDirection(args.direction);
  if (!direction) {
    throw new SelectionValidationError(
      'invalid_arguments',
      'Direction must be izquierda or derecha.',
    );
  }
  return { kind: entry.id, direction };
};

const isMovementAction = (
  action: NormalizedAction,
): action is
  | { readonly kind: 'advance' }
  | { readonly kind: 'retreat' }
  | { readonly kind: 'jump'; readonly direction: Direction }
  | { readonly kind: 'crouch'; readonly direction: Direction } =>
  action.kind === 'advance' ||
  action.kind === 'retreat' ||
  action.kind === 'jump' ||
  action.kind === 'crouch';

const modeForAction = (
  action: Exclude<NormalizedAction, { readonly kind: 'wait' }>,
): 'walk' | 'jump' | 'crouch' | 'swim' => {
  if (action.kind === 'jump') return 'jump';
  if (action.kind === 'crouch') return 'crouch';
  if (action.kind === 'swim') return 'swim';
  return 'walk';
};

type MovementMode = 'walk' | 'jump' | 'crouch';
type MovementCompatibility = {
  readonly outcome: 'moved' | 'fall' | 'collision';
  readonly reason: ResolutionReason;
};

const MOVEMENT_COMPATIBILITY = {
  ground: {
    walk: { outcome: 'moved', reason: 'moved' },
    jump: { outcome: 'moved', reason: 'moved' },
    crouch: { outcome: 'moved', reason: 'moved' },
  },
  pit: {
    walk: { outcome: 'fall', reason: 'walk_into_pit' },
    jump: { outcome: 'moved', reason: 'moved' },
    crouch: { outcome: 'fall', reason: 'crouch_into_pit' },
  },
  branch: {
    walk: { outcome: 'collision', reason: 'walk_into_branch' },
    jump: { outcome: 'collision', reason: 'jump_into_branch' },
    crouch: { outcome: 'moved', reason: 'moved' },
  },
  barrier_low: {
    walk: { outcome: 'collision', reason: 'walk_into_barrier' },
    jump: { outcome: 'moved', reason: 'moved' },
    crouch: { outcome: 'collision', reason: 'crouch_into_low_barrier' },
  },
  barrier_high: {
    walk: { outcome: 'collision', reason: 'walk_into_barrier' },
    jump: { outcome: 'collision', reason: 'jump_into_high_barrier' },
    crouch: { outcome: 'moved', reason: 'moved' },
  },
} satisfies Record<TerrainState, Record<MovementMode, MovementCompatibility>>;

const directionForAction = (action: NormalizedAction): Direction | undefined => {
  if (action.kind === 'advance') return 'right';
  if (action.kind === 'retreat') return 'left';
  if (action.kind === 'jump' || action.kind === 'crouch') return action.direction;
  return undefined;
};

const movementCompatibility = (terrain: TerrainState, mode: MovementMode): MovementCompatibility =>
  MOVEMENT_COMPATIBILITY[terrain][mode];

type SemanticSnapshot = {
  readonly support: number;
  readonly turnsUsed: number;
  readonly phaseTurn: number;
  readonly terrain: readonly TerrainState[];
  readonly exitEnabled: boolean;
  readonly status: GameStatus;
};

const isGameStatus = (value: unknown): value is GameStatus =>
  value === 'running' || value === 'victory' || value === 'defeat' || value === 'incomplete';

const isSemanticSnapshot = (value: unknown): value is SemanticSnapshot =>
  isRecord(value) &&
  typeof value.support === 'number' &&
  Number.isSafeInteger(value.support) &&
  value.support >= 0 &&
  value.support <= LEVEL.segments.length &&
  typeof value.turnsUsed === 'number' &&
  Number.isSafeInteger(value.turnsUsed) &&
  value.turnsUsed >= 0 &&
  typeof value.phaseTurn === 'number' &&
  Number.isSafeInteger(value.phaseTurn) &&
  value.phaseTurn >= 0 &&
  Array.isArray(value.terrain) &&
  value.terrain.length === LEVEL.segments.length &&
  value.terrain.every(validTerrain) &&
  typeof value.exitEnabled === 'boolean' &&
  isGameStatus(value.status);

const sameTerrain = (value: unknown, expected: readonly TerrainState[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);

/**
 * Checks a recorded action against the current contract without reconstructing game state.
 * The compatibility table is also the game engine's declarative terrain/action matrix.
 */
export const isSemanticallyValidActionResolution = (
  actionValue: unknown,
  beforeValue: unknown,
  afterValue: unknown,
  resolutionValue: unknown,
): boolean => {
  if (
    !isNormalizedAction(actionValue) ||
    !isActionResolution(resolutionValue) ||
    !isSemanticSnapshot(beforeValue) ||
    !isSemanticSnapshot(afterValue)
  ) {
    return false;
  }

  const before = beforeValue;
  const after = afterValue;
  const resolution = resolutionValue;
  if (before.status !== 'running') return false;
  if (
    before.turnsUsed >= LEVEL.maxTurns ||
    after.turnsUsed !== before.turnsUsed + 1 ||
    before.phaseTurn !== before.turnsUsed ||
    after.exitEnabled !== before.exitEnabled ||
    !sameTerrain(before.terrain, effectiveTerrain(LEVEL, before.phaseTurn))
  ) {
    return false;
  }

  let expectedSupport = before.support;
  if (actionValue.kind === 'wait') {
    if (resolution.outcome !== 'no_op' || resolution.reason !== 'wait') return false;
  } else if (actionValue.kind === 'swim') {
    if (resolution.outcome !== 'no_op' || resolution.reason !== 'swim_no_effect') return false;
  } else {
    const direction = directionForAction(actionValue);
    if (!direction) return false;
    const targetSupport = before.support + (direction === 'right' ? 1 : -1);
    if (targetSupport < 0 || targetSupport > LEVEL.segments.length) {
      if (
        resolution.outcome !== 'no_op' ||
        resolution.reason !== (direction === 'right' ? 'right_boundary' : 'left_boundary')
      ) {
        return false;
      }
    } else {
      const segment = direction === 'right' ? before.support : targetSupport;
      const terrain = before.terrain[segment];
      if (terrain === undefined) return false;
      const mode = modeForAction(actionValue);
      if (mode === 'swim') return false;
      const expected = movementCompatibility(terrain, mode);
      if (
        resolution.outcome !== expected.outcome ||
        resolution.reason !== expected.reason ||
        resolution.segment !== segment ||
        resolution.targetSupport !== targetSupport
      ) {
        return false;
      }
      if (expected.outcome === 'moved') expectedSupport = targetSupport;
    }
  }

  if (after.support !== expectedSupport) return false;
  const fatal = resolution.outcome === 'fall' || resolution.outcome === 'collision';
  const reachesEnabledExit =
    resolution.outcome === 'moved' &&
    expectedSupport === LEVEL.exit.support &&
    before.exitEnabled === true;
  const expectedStatus: GameStatus = fatal
    ? 'defeat'
    : reachesEnabledExit
      ? 'victory'
      : before.turnsUsed + 1 >= LEVEL.maxTurns
        ? 'incomplete'
        : 'running';
  if (after.status !== expectedStatus) return false;

  const expectedPhaseTurn = expectedStatus === 'running' ? before.phaseTurn + 1 : before.phaseTurn;
  return (
    after.phaseTurn === expectedPhaseTurn &&
    sameTerrain(after.terrain, effectiveTerrain(LEVEL, expectedPhaseTurn))
  );
};

const validateAction = (action: NormalizedAction): void => {
  if (!isNormalizedAction(action)) throw new GameStateError('The action is not normalized.');
};

const afterTurn = (
  before: GameSnapshot,
  level: LevelDefinition,
  status: GameStatus,
  support: number,
  maxSupportReached: number,
  terminal: boolean,
): GameSnapshot => {
  const turnsUsed = before.turnsUsed + 1;
  const phaseTurn = terminal ? before.phaseTurn : before.phaseTurn + 1;
  return createSnapshot({
    id: stateIdForTurns(turnsUsed),
    support,
    turnsUsed,
    phaseTurn,
    terrain: terminal ? before.terrain : effectiveTerrain(level, phaseTurn),
    remainingObjects: before.remainingObjects,
    inventory: before.inventory,
    exitEnabled: before.exitEnabled,
    status,
    maxSupportReached,
  });
};

/** Resolve exactly one already-normalized action without mutating its input. */
export const resolveAction = (
  state: GameSnapshot,
  action: NormalizedAction,
  level: LevelDefinition = LEVEL,
): ResolvedAction => {
  validateLevel(level);
  validateAction(action);
  if (state.status !== 'running') {
    throw new GameStateError('No action can be resolved after a terminal state.');
  }
  if (state.turnsUsed >= level.maxTurns) {
    throw new GameStateError('No action can be resolved after the turn limit.');
  }

  // The caller's snapshot is immutable by contract. Returning this exact
  // object keeps before/after references chainable without mutating it.
  const before = state;
  if (action.kind === 'wait') {
    const resolution: NoOpResolution = { outcome: 'no_op', reason: 'wait' };
    const status: GameStatus = before.turnsUsed + 1 >= level.maxTurns ? 'incomplete' : 'running';
    return {
      action,
      before,
      after: afterTurn(
        before,
        level,
        status,
        before.support,
        before.maxSupportReached,
        status !== 'running',
      ),
      resolution,
    };
  }
  const mode = modeForAction(action);
  const direction = directionForAction(action);

  if (mode === 'swim') {
    const resolution: NoOpResolution = { outcome: 'no_op', reason: 'swim_no_effect' };
    const status: GameStatus = before.turnsUsed + 1 >= level.maxTurns ? 'incomplete' : 'running';
    return {
      action,
      before,
      after: afterTurn(
        before,
        level,
        status,
        before.support,
        before.maxSupportReached,
        status !== 'running',
      ),
      resolution,
    };
  }

  if (!isMovementAction(action) || !direction) {
    throw new GameStateError('A movement action requires a direction.');
  }
  const targetSupport = direction === 'right' ? before.support + 1 : before.support - 1;
  if (targetSupport < 0 || targetSupport > level.segments.length) {
    const resolution: NoOpResolution = {
      outcome: 'no_op',
      reason: direction === 'right' ? 'right_boundary' : 'left_boundary',
    };
    const status: GameStatus = before.turnsUsed + 1 >= level.maxTurns ? 'incomplete' : 'running';
    return {
      action,
      before,
      after: afterTurn(
        before,
        level,
        status,
        before.support,
        before.maxSupportReached,
        status !== 'running',
      ),
      resolution,
    };
  }

  const segment = direction === 'right' ? before.support : targetSupport;
  const compatibility = movementCompatibility(before.terrain[segment], mode);
  const resolution: MovementResolution = {
    ...compatibility,
    segment,
    targetSupport,
  };
  if (compatibility.outcome === 'fall' || compatibility.outcome === 'collision') {
    return {
      action,
      before,
      after: afterTurn(before, level, 'defeat', before.support, before.maxSupportReached, true),
      resolution,
    };
  }

  const nextMaxSupport = Math.max(before.maxSupportReached, targetSupport);
  const reachesEnabledExit = targetSupport === level.exit.support && before.exitEnabled;
  const reachesTurnLimit = before.turnsUsed + 1 >= level.maxTurns;
  const status: GameStatus = reachesEnabledExit
    ? 'victory'
    : reachesTurnLimit
      ? 'incomplete'
      : 'running';
  return {
    action,
    before,
    after: afterTurn(before, level, status, targetSupport, nextMaxSupport, status !== 'running'),
    resolution,
  };
};

const objectsAtSupport = (state: GameSnapshot, level: LevelDefinition): readonly string[] => {
  const remaining = new Set(state.remainingObjects);
  return Object.freeze(
    level.objects
      .filter((object) => object.support === state.support && remaining.has(object.id))
      .map((object) => object.id),
  );
};

/** Project only the local fields allowed in a model decision. */
export const observe = (state: GameSnapshot, level: LevelDefinition = LEVEL): LocalObservation => {
  validateLevel(level);
  const left: LocalSideObservation =
    state.support === 0
      ? { kind: 'boundary' }
      : { kind: 'segment', terrain: state.terrain[state.support - 1] };
  const right: LocalSideObservation =
    state.support === level.segments.length
      ? { kind: 'boundary' }
      : { kind: 'segment', terrain: state.terrain[state.support] };
  const exit = state.support === level.exit.support ? { enabled: state.exitEnabled } : undefined;
  return cloneAndFreeze({
    here: {
      objects: objectsAtSupport(state, level),
      ...(exit ? { exit } : {}),
    },
    left,
    right,
  }) as LocalObservation;
};

export interface ScoreInput {
  readonly status: GameStatus | 'cancelled' | 'error';
  readonly turnsUsed: number;
  readonly collectedObjectIds: readonly string[];
  readonly gameTokens: number | null;
}

export type ScoreAvailability = 'available' | 'not_victory' | 'unknown_tokens';

export interface ScoreResult {
  readonly score: number | null;
  readonly availability: ScoreAvailability;
  readonly rules: ScoreRules;
}

const rounded = (value: number, decimalPlaces: number): number => {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
};

/** Calculate the immutable score result using the supplied effective rules. */
export const calculateScore = (
  input: ScoreInput,
  rules: ScoreRules = DEFAULT_SCORE_RULES,
): ScoreResult => {
  if (input.status !== 'victory') {
    return { score: null, availability: 'not_victory', rules };
  }
  if (input.gameTokens === null || !Number.isFinite(input.gameTokens)) {
    return { score: null, availability: 'unknown_tokens', rules };
  }
  if (!Number.isFinite(input.turnsUsed) || rules.tokenUnit <= 0 || rules.decimalPlaces < 0) {
    throw new GameStateError('Score inputs are invalid.');
  }
  const uniqueObjects = [...new Set(input.collectedObjectIds)];
  const objectPoints = uniqueObjects.reduce(
    (sum, objectId) => sum + (rules.objectValues[objectId] ?? 0),
    0,
  );
  const raw =
    rules.base +
    objectPoints -
    rules.turnWeight * input.turnsUsed -
    rules.tokenWeight * (input.gameTokens / rules.tokenUnit);
  const score = rounded(raw, rules.decimalPlaces);
  return {
    score: rules.allowNegative ? score : Math.max(0, score),
    availability: 'available',
    rules,
  };
};

/** Convenience form for callers that only need the numeric score. */
export const scoreAttempt = (
  input: ScoreInput,
  rules: ScoreRules = DEFAULT_SCORE_RULES,
): number | null => calculateScore(input, rules).score;

export const progressFor = (state: GameSnapshot, level: LevelDefinition = LEVEL): number => {
  return Math.max(0, Math.min(1, state.maxSupportReached / level.segments.length));
};
