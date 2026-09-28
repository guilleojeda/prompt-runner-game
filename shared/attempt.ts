import type {
  ActionResolution,
  GameSnapshot,
  LevelDefinition,
  NormalizedAction,
  ScoreRules,
} from './game.js';
import { ROBOT_CATALOG_VERSION, ROBOT_SCHEMA_VERSION, type RobotSkillId } from './robot.js';
import type { ModelKey } from './models.js';

/** Version of the durable attempt record, independent of game rules versions. */
export const ATTEMPT_RECORD_VERSION = 4 as const;

export type AttemptStatus =
  'pending' | 'running' | 'victory' | 'defeat' | 'incomplete' | 'cancelled' | 'error';

/** Provider usage normalized for the attempt summary. Unknown values stay null. */
export interface AttemptMetrics {
  readonly calls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly gameTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

export interface AttemptSummary extends AttemptMetrics {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: AttemptStatus;
  readonly cancelRequested: boolean;
  readonly reason?: string;
  readonly levelId: string;
  readonly modelKey: ModelKey;
  readonly modelLabel: string;
  readonly modelId: string;
  readonly turnsUsed: number;
  readonly maxTurns: number;
  readonly score: number | null;
  /** Object IDs in the attempt's persisted inventory, in collection order. */
  readonly collectedObjectIds: readonly string[];
  /** Points contributed by the collected objects under the fixed level definition. */
  readonly objectPoints: number;
  /** Highest support reached divided by the number of level segments. */
  readonly progress: number;
  readonly finalSupport: number;
  readonly animationEnabled: boolean;
  readonly presentationComplete: boolean;
  readonly recordComplete: boolean;
}

/** Fixed copy of the catalog data applied to an attempt. */
export interface AttemptRobotSkillSnapshot {
  readonly id: RobotSkillId;
  readonly opaqueId: string;
  readonly enabled: boolean;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface AttemptRobotSnapshot {
  readonly schemaVersion: typeof ROBOT_SCHEMA_VERSION;
  readonly catalogVersion: typeof ROBOT_CATALOG_VERSION;
  readonly instructions: string;
  readonly skills: readonly AttemptRobotSkillSnapshot[];
}

export interface AttemptConfigSnapshot {
  readonly level: LevelDefinition;
  readonly scoreRules: ScoreRules;
  readonly robot: AttemptRobotSnapshot;
  readonly animationEnabled: boolean;
}

/**
 * One published action. States are referenced by ID so each posterior is
 * materialized only once in AttemptRecord.snapshots.
 */
export interface AttemptActionRecord {
  readonly seq: number;
  readonly decisionId: string;
  readonly beforeStateId: string;
  readonly afterStateId: string;
  readonly action: NormalizedAction;
  readonly resolution: ActionResolution;
}

export interface AttemptClosure {
  readonly status: AttemptStatus;
  readonly reason?: string;
  readonly actionCount: number;
  readonly finalStateId: string;
  readonly recordComplete: boolean;
}

export interface AttemptRecord {
  readonly recordVersion: typeof ATTEMPT_RECORD_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly config: AttemptConfigSnapshot;
  /** Includes the initial state and each posterior state exactly once. */
  readonly snapshots: readonly GameSnapshot[];
  readonly actions: readonly AttemptActionRecord[];
  readonly closure: AttemptClosure;
  readonly metrics: AttemptMetrics;
  readonly score: number | null;
}

/** A compact read view can add the referenced snapshots without changing storage. */
export interface AttemptActionView extends AttemptActionRecord {
  readonly before: GameSnapshot;
  readonly after: GameSnapshot;
}

export interface AttemptRecordView extends Omit<AttemptRecord, 'actions'> {
  readonly actions: readonly AttemptActionView[];
}

/** Public, replay-safe preference state. Version zero represents the default. */
export interface AnimationPreference {
  readonly animationEnabled: boolean;
  readonly version: number;
}

/** Narrow public projection used to render a replay without exposing robot prompts or audit data. */
export interface ReplayRecordView {
  readonly recordVersion: typeof ATTEMPT_RECORD_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly config: Readonly<{ level: LevelDefinition }>;
  readonly snapshots: readonly GameSnapshot[];
  readonly actions: readonly AttemptActionView[];
  readonly closure: AttemptClosure;
  readonly metrics: AttemptMetrics;
  readonly score: number | null;
}

/** Small, map-friendly navigation item for decision inspection. */
export interface DecisionIndexItem {
  readonly number: number;
  readonly decisionId: string;
  readonly originSupport: number;
  readonly hasAction: boolean;
}

/** Public index for the authenticated owner's terminal attempt. */
export interface DecisionIndex {
  readonly attemptId: string;
  readonly levelId: string;
  readonly decisions: readonly DecisionIndexItem[];
}

/** Local observation projected from one effective Converse request. */
export type DecisionObservationSide =
  | { readonly kind: 'boundary' }
  | { readonly kind: 'segment'; readonly terrain: string }
  | {
      readonly kind: 'door';
      readonly state: 'locked' | 'open';
      readonly requiredObjectId: string;
    };

export interface DecisionObservation {
  readonly facing: 'left' | 'right';
  readonly here: {
    readonly objects: readonly string[];
    readonly exit: boolean;
  };
  readonly left: DecisionObservationSide;
  readonly right: DecisionObservationSide;
}

/** One tool as actually serialized in the effective request. */
export interface DecisionAvailableAction {
  readonly opaqueId: string;
  readonly label: string;
  /** Omitted when the provider request omitted the description. */
  readonly description?: string;
  readonly skillId?: RobotSkillId;
}

export type DecisionChoice =
  | {
      readonly state: 'selected';
      readonly opaqueId: string;
      readonly action: unknown;
      readonly parameters: unknown;
    }
  | {
      readonly state: 'invalid';
      readonly opaqueId?: string;
      readonly parameters?: unknown;
    }
  | { readonly state: 'unknown' };

export type DecisionResult =
  | {
      readonly kind: 'action';
      readonly action: unknown;
      readonly resolution: unknown;
      readonly beforeSupport: number;
      readonly afterSupport: number;
      readonly turnsUsed: number;
      readonly status?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: 'no-action';
      readonly turnsUsed: number;
      readonly status: string;
      readonly reason?: string;
    };

/** Public detail for one grouped model decision. */
export interface DecisionDetail {
  readonly attemptId: string;
  readonly levelId: string;
  readonly item: DecisionIndexItem;
  readonly observation: DecisionObservation | null;
  readonly availableActions: readonly DecisionAvailableAction[] | null;
  readonly choice: DecisionChoice | null;
  readonly result: DecisionResult;
}
