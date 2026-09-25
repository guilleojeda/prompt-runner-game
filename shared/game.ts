import type { RobotSkillId } from './robot.js';

/** Version of the deterministic rules used by the published level. */
export const RULES_VERSION = 4 as const;

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
}

export interface LevelExit {
  readonly support: number;
}

export interface LevelDoor {
  /** Support reached by crossing the doorway from the preceding support. */
  readonly support: number;
  readonly requiredObjectId: string;
}

export interface LevelDefinition {
  readonly id: string;
  readonly version: number;
  readonly rulesVersion: typeof RULES_VERSION;
  readonly maxTurns: number;
  readonly segments: readonly LevelSegment[];
  readonly objects: readonly LevelObject[];
  readonly door?: LevelDoor;
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

export interface GameRules {
  readonly version: typeof RULES_VERSION;
  readonly maxTurns: number;
  readonly score: ScoreRules;
}

/** The current level: seven original segments followed by three clear ground segments. */
export const LEVEL: LevelDefinition = Object.freeze({
  id: 'principal-puerta-v4',
  version: 4,
  rulesVersion: RULES_VERSION,
  maxTurns: 24,
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
    Object.freeze({ type: 'ground' as const }),
    Object.freeze({ type: 'ground' as const }),
    Object.freeze({ type: 'ground' as const }),
  ]),
  objects: Object.freeze([
    Object.freeze({ id: 'recompensa-1', support: 2, scoreValue: 25 }),
    Object.freeze({ id: 'llave-1', support: 6, scoreValue: 0 }),
  ]),
  door: Object.freeze({ support: 9, requiredObjectId: 'llave-1' }),
  exit: Object.freeze({ support: 10 }),
});

const BASE_SCORE_RULES = {
  base: 1000,
  turnWeight: 10,
  tokenWeight: 1,
  tokenUnit: 1000,
  decimalPlaces: 2,
  allowNegative: true,
} as const;

/** Derive effective object points from the level snapshot used by an attempt. */
export const scoreRulesForLevel = (level: LevelDefinition): ScoreRules =>
  Object.freeze({
    ...BASE_SCORE_RULES,
    objectValues: Object.freeze(
      Object.fromEntries(level.objects.map((object) => [object.id, object.scoreValue])),
    ),
  });

export const DEFAULT_SCORE_RULES: ScoreRules = scoreRulesForLevel(LEVEL);

export const RULES: GameRules = Object.freeze({
  version: RULES_VERSION,
  maxTurns: LEVEL.maxTurns,
  score: DEFAULT_SCORE_RULES,
});

export interface GameSnapshot {
  readonly id: string;
  /** Internal support index. It is never included in an agent observation. */
  readonly support: number;
  /** Direction most recently attempted by a movement action. */
  readonly facing: Direction;
  readonly turnsUsed: number;
  /** The phase used to evaluate the current/last action. */
  readonly phaseTurn: number;
  /** Effective state of every level segment at phaseTurn. */
  readonly terrain: readonly TerrainState[];
  readonly remainingObjects: readonly string[];
  readonly inventory: readonly string[];
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
  | { readonly kind: 'wait' }
  | { readonly kind: 'collect' };

export type ResolutionOutcome = 'moved' | 'no_op' | 'fall' | 'collision' | 'picked_up';

export type ResolutionReason =
  | 'moved'
  | 'left_boundary'
  | 'right_boundary'
  | 'swim_no_effect'
  | 'wait'
  | 'no_object_here'
  | 'door_locked'
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

export interface PickedUpResolution {
  readonly outcome: 'picked_up';
  readonly objectId: string;
}

export type ActionResolution = MovementResolution | NoOpResolution | PickedUpResolution;

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

export interface DoorObservation {
  readonly kind: 'door';
  readonly state: 'locked' | 'open';
  readonly requiredObjectId: string;
}

export type LocalSideObservation = LocalSegmentObservation | BoundaryObservation | DoorObservation;

export interface LocalObservation {
  /** Only objects at the current support and a local exit marker are exposed. */
  readonly facing: Direction;
  readonly here: {
    readonly objects: readonly string[];
    readonly exit?: Readonly<Record<string, never>>;
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

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => hasOwn(value, key));

const isResolutionReason = (value: unknown): value is ResolutionReason =>
  value === 'moved' ||
  value === 'left_boundary' ||
  value === 'right_boundary' ||
  value === 'swim_no_effect' ||
  value === 'wait' ||
  value === 'no_object_here' ||
  value === 'door_locked' ||
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
    value.kind === 'wait' ||
    value.kind === 'collect'
  ) {
    return hasExactKeys(value, ['kind']);
  }
  return (
    (value.kind === 'jump' || value.kind === 'crouch') &&
    hasExactKeys(value, ['kind', 'direction']) &&
    (value.direction === 'left' || value.direction === 'right')
  );
};

/** Type guard for the single action resolution contract used by durable and public records. */
export const isActionResolution = (value: unknown): value is ActionResolution => {
  if (!isRecord(value)) return false;
  if (value.outcome === 'picked_up') {
    return (
      hasExactKeys(value, ['outcome', 'objectId']) &&
      typeof value.objectId === 'string' &&
      value.objectId.length > 0
    );
  }
  if (value.outcome === 'no_op' && !hasExactKeys(value, ['outcome', 'reason'])) {
    return false;
  }
  if (
    (value.outcome === 'moved' || value.outcome === 'fall' || value.outcome === 'collision') &&
    !hasExactKeys(value, ['outcome', 'reason', 'segment', 'targetSupport'])
  ) {
    return false;
  }
  if (!isResolutionReason(value.reason)) return false;
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
    !Array.isArray(level.objects) ||
    !level.exit ||
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
  const objectSupports = new Set<number>();
  for (const object of level.objects) {
    if (
      typeof object.id !== 'string' ||
      !object.id ||
      objectIds.has(object.id) ||
      !Number.isInteger(object.support) ||
      object.support < 0 ||
      object.support > level.segments.length ||
      !Number.isFinite(object.scoreValue) ||
      objectSupports.has(object.support)
    ) {
      throw new GameStateError('The level contains an invalid object.');
    }
    objectIds.add(object.id);
    objectSupports.add(object.support);
  }
  if (
    level.door !== undefined &&
    (!Number.isInteger(level.door.support) ||
      level.door.support < 1 ||
      level.door.support >= level.exit.support ||
      typeof level.door.requiredObjectId !== 'string' ||
      level.door.requiredObjectId.length === 0 ||
      !objectIds.has(level.door.requiredObjectId))
  ) {
    throw new GameStateError('The level contains an invalid door.');
  }
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
    facing: 'right',
    turnsUsed: 0,
    phaseTurn: 0,
    terrain,
    remainingObjects,
    inventory: [],
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
    entry.id === 'wait' ||
    entry.id === 'collect'
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
  action: Exclude<NormalizedAction, { readonly kind: 'wait' | 'collect' }>,
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

const observeDoor = (door: LevelDoor, inventory: readonly string[]): DoorObservation => ({
  kind: 'door',
  state: inventory.includes(door.requiredObjectId) ? 'open' : 'locked',
  requiredObjectId: door.requiredObjectId,
});

type SemanticSnapshot = {
  readonly support: number;
  readonly facing: Direction;
  readonly maxSupportReached: number;
  readonly turnsUsed: number;
  readonly phaseTurn: number;
  readonly terrain: readonly TerrainState[];
  readonly remainingObjects: readonly string[];
  readonly inventory: readonly string[];
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
  (value.facing === 'left' || value.facing === 'right') &&
  typeof value.maxSupportReached === 'number' &&
  Number.isSafeInteger(value.maxSupportReached) &&
  value.maxSupportReached >= value.support &&
  value.maxSupportReached <= LEVEL.segments.length &&
  typeof value.turnsUsed === 'number' &&
  Number.isSafeInteger(value.turnsUsed) &&
  value.turnsUsed >= 0 &&
  typeof value.phaseTurn === 'number' &&
  Number.isSafeInteger(value.phaseTurn) &&
  value.phaseTurn >= 0 &&
  Array.isArray(value.terrain) &&
  value.terrain.length === LEVEL.segments.length &&
  value.terrain.every(validTerrain) &&
  Array.isArray(value.remainingObjects) &&
  value.remainingObjects.every((id) => typeof id === 'string') &&
  Array.isArray(value.inventory) &&
  value.inventory.every((id) => typeof id === 'string') &&
  !hasOwn(value, 'exitEnabled') &&
  isGameStatus(value.status);

const sameTerrain = (value: unknown, expected: readonly TerrainState[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);

const isValidObjectPartition = (
  snapshot: Pick<SemanticSnapshot, 'remainingObjects' | 'inventory'>,
  level: LevelDefinition = LEVEL,
): boolean => {
  const expectedIds = level.objects.map((object) => object.id);
  const allIds = [...snapshot.remainingObjects, ...snapshot.inventory];
  return (
    new Set(snapshot.remainingObjects).size === snapshot.remainingObjects.length &&
    new Set(snapshot.inventory).size === snapshot.inventory.length &&
    new Set(allIds).size === allIds.length &&
    allIds.length === expectedIds.length &&
    expectedIds.every((id) => allIds.includes(id))
  );
};

const isPastClosedDoor = (
  support: number,
  inventory: readonly string[],
  level: LevelDefinition,
): boolean =>
  level.door !== undefined &&
  support >= level.door.support &&
  !inventory.includes(level.door.requiredObjectId);

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

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
    !isSemanticSnapshot(afterValue) ||
    !isValidObjectPartition(beforeValue, LEVEL) ||
    !isValidObjectPartition(afterValue, LEVEL)
  ) {
    return false;
  }

  const before = beforeValue;
  const after = afterValue;
  const resolution = resolutionValue;
  if (before.status !== 'running' || isPastClosedDoor(before.support, before.inventory, LEVEL)) {
    return false;
  }
  if (
    before.turnsUsed === 0 &&
    (before.support !== 0 ||
      before.facing !== 'right' ||
      before.maxSupportReached !== 0 ||
      before.inventory.length !== 0 ||
      !sameIds(
        before.remainingObjects,
        LEVEL.objects.map((object) => object.id),
      ))
  ) {
    return false;
  }
  if (
    before.turnsUsed >= LEVEL.maxTurns ||
    after.turnsUsed !== before.turnsUsed + 1 ||
    before.phaseTurn !== before.turnsUsed ||
    !sameTerrain(before.terrain, effectiveTerrain(LEVEL, before.phaseTurn))
  ) {
    return false;
  }

  let expectedSupport = before.support;
  let expectedFacing = before.facing;
  let expectedMaxSupportReached = before.maxSupportReached;
  let expectedRemainingObjects = before.remainingObjects;
  let expectedInventory = before.inventory;
  if (actionValue.kind === 'collect') {
    const object = LEVEL.objects.find(
      (candidate) =>
        candidate.support === before.support && before.remainingObjects.includes(candidate.id),
    );
    if (object) {
      if (resolution.outcome !== 'picked_up' || resolution.objectId !== object.id) return false;
      expectedRemainingObjects = before.remainingObjects.filter((id) => id !== object.id);
      expectedInventory = [...before.inventory, object.id];
    } else if (resolution.outcome !== 'no_op' || resolution.reason !== 'no_object_here') {
      return false;
    }
  } else if (actionValue.kind === 'wait') {
    if (resolution.outcome !== 'no_op' || resolution.reason !== 'wait') return false;
  } else if (actionValue.kind === 'swim') {
    if (resolution.outcome !== 'no_op' || resolution.reason !== 'swim_no_effect') return false;
  } else {
    const direction = directionForAction(actionValue);
    if (!direction) return false;
    expectedFacing = direction;
    const targetSupport = before.support + (direction === 'right' ? 1 : -1);
    if (targetSupport < 0 || targetSupport > LEVEL.segments.length) {
      if (
        resolution.outcome !== 'no_op' ||
        resolution.reason !== (direction === 'right' ? 'right_boundary' : 'left_boundary')
      ) {
        return false;
      }
    } else {
      const door = LEVEL.door;
      if (door?.support === targetSupport && !before.inventory.includes(door.requiredObjectId)) {
        if (resolution.outcome !== 'no_op' || resolution.reason !== 'door_locked') return false;
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
        if (expected.outcome === 'moved') {
          expectedSupport = targetSupport;
          expectedMaxSupportReached = Math.max(before.maxSupportReached, targetSupport);
        }
      }
    }
  }

  if (
    after.support !== expectedSupport ||
    after.facing !== expectedFacing ||
    after.maxSupportReached !== expectedMaxSupportReached ||
    !sameIds(after.remainingObjects, expectedRemainingObjects) ||
    !sameIds(after.inventory, expectedInventory)
  ) {
    return false;
  }
  const fatal = resolution.outcome === 'fall' || resolution.outcome === 'collision';
  const reachesExit = resolution.outcome === 'moved' && expectedSupport === LEVEL.exit.support;
  const expectedStatus: GameStatus = fatal
    ? 'defeat'
    : reachesExit
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
  facing: Direction = before.facing,
  remainingObjects: readonly string[] = before.remainingObjects,
  inventory: readonly string[] = before.inventory,
): GameSnapshot => {
  const turnsUsed = before.turnsUsed + 1;
  const phaseTurn = terminal ? before.phaseTurn : before.phaseTurn + 1;
  return createSnapshot({
    id: stateIdForTurns(turnsUsed),
    support,
    facing,
    turnsUsed,
    phaseTurn,
    terrain: terminal ? before.terrain : effectiveTerrain(level, phaseTurn),
    remainingObjects,
    inventory,
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
  if (state.facing !== 'left' && state.facing !== 'right') {
    throw new GameStateError('The snapshot facing is invalid.');
  }
  if (!isValidObjectPartition(state, level)) {
    throw new GameStateError('The snapshot object state does not match the level.');
  }
  if (isPastClosedDoor(state.support, state.inventory, level)) {
    throw new GameStateError('The running snapshot is past a locked door.');
  }

  // The caller's snapshot is immutable by contract. Returning this exact
  // object keeps before/after references chainable without mutating it.
  const before = state;
  if (action.kind === 'collect') {
    const object = level.objects.find(
      (candidate) =>
        candidate.support === before.support && before.remainingObjects.includes(candidate.id),
    );
    const remainingObjects = object
      ? before.remainingObjects.filter((id) => id !== object.id)
      : before.remainingObjects;
    const inventory = object ? [...before.inventory, object.id] : before.inventory;
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
        before.facing,
        remainingObjects,
        inventory,
      ),
      resolution: object
        ? { outcome: 'picked_up', objectId: object.id }
        : { outcome: 'no_op', reason: 'no_object_here' },
    };
  }
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
        direction,
      ),
      resolution,
    };
  }

  const segment = direction === 'right' ? before.support : targetSupport;
  if (
    level.door?.support === targetSupport &&
    !before.inventory.includes(level.door.requiredObjectId)
  ) {
    const resolution: NoOpResolution = { outcome: 'no_op', reason: 'door_locked' };
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
        direction,
      ),
      resolution,
    };
  }

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
      after: afterTurn(
        before,
        level,
        'defeat',
        before.support,
        before.maxSupportReached,
        true,
        direction,
      ),
      resolution,
    };
  }

  const nextMaxSupport = Math.max(before.maxSupportReached, targetSupport);
  const reachesExit = targetSupport === level.exit.support;
  const reachesTurnLimit = before.turnsUsed + 1 >= level.maxTurns;
  const status: GameStatus = reachesExit ? 'victory' : reachesTurnLimit ? 'incomplete' : 'running';
  return {
    action,
    before,
    after: afterTurn(
      before,
      level,
      status,
      targetSupport,
      nextMaxSupport,
      status !== 'running',
      direction,
    ),
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
  const door = level.door;
  const left: LocalSideObservation =
    state.support === 0
      ? { kind: 'boundary' }
      : door?.support === state.support
        ? observeDoor(door, state.inventory)
        : { kind: 'segment', terrain: state.terrain[state.support - 1] };
  const right: LocalSideObservation =
    state.support === level.segments.length
      ? { kind: 'boundary' }
      : door?.support === state.support + 1
        ? observeDoor(door, state.inventory)
        : { kind: 'segment', terrain: state.terrain[state.support] };
  const exit = state.support === level.exit.support ? {} : undefined;
  return cloneAndFreeze({
    facing: state.facing,
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
