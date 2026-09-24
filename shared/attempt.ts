import type {
  ActionResolution,
  GameSnapshot,
  LevelDefinition,
  NormalizedAction,
  ScoreRules,
} from './game.js';
import type { RobotSkillId } from './robot.js';
import type { ModelKey } from './models.js';

/** Version of the durable attempt record, independent of game rules versions. */
export const ATTEMPT_RECORD_VERSION = 1 as const;

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
  readonly schemaVersion: number;
  readonly catalogVersion: number;
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
