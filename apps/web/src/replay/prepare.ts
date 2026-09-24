import {
  ATTEMPT_RECORD_VERSION,
  type AttemptActionView,
  type ReplayRecordView,
} from '../../../../shared/attempt.js';
import {
  isActionResolution,
  isNormalizedAction,
  isSemanticallyValidActionResolution,
  LEVEL,
  type Direction,
  type LevelSegment,
  type TerrainState,
} from '../../../../shared/game.js';

export type ReplayPose =
  'idle' | 'step-a' | 'step-b' | 'jump' | 'crouch' | 'fall' | 'impact' | 'celebrate';

export interface ReplayTerrainTransition {
  readonly to: readonly TerrainState[];
  readonly progress: number;
}

export interface ReplaySample {
  readonly time: number;
  /** World-space support coordinate; fractions are presentation-only. */
  readonly support: number;
  /** Pixels below the support line, used by the authored fall clip. */
  readonly drop: number;
  readonly facing: Direction;
  readonly pose: ReplayPose;
  /** The terrain saved before the current action remains visible during its gesture. */
  readonly terrain: readonly TerrainState[];
  /** Set only during a transition following a continuing action. */
  readonly terrainTransition: ReplayTerrainTransition | null;
  /** Horizontal world offset for the viewport camera. */
  readonly cameraX: number;
  readonly actionIndex: number | null;
  readonly actionNumber: number;
  readonly closureStatus: ReplayRecordView['closure']['status'];
  readonly effect: 'none' | 'impact' | 'victory';
  readonly complete: boolean;
}

export interface PreparedReplay {
  readonly duration: number;
  readonly requiredSymbols: readonly string[];
  readonly sample: (elapsedSeconds: number) => ReplaySample;
}

interface PhaseTransitionCue {
  readonly start: number;
  readonly end: number;
  readonly to: readonly TerrainState[];
}

interface ActionCue {
  readonly start: number;
  readonly end: number;
  readonly action: AttemptActionView;
  readonly index: number;
  readonly direction: Direction | null;
  readonly facing: Direction;
  readonly transition: PhaseTransitionCue | null;
}

export const REPLAY_VIEW_WIDTH = 760;
export const REPLAY_SUPPORT_START_X = 80;
export const REPLAY_SEGMENT_WIDTH = 120;
export const REPLAY_WORLD_WIDTH =
  REPLAY_SUPPORT_START_X + LEVEL.segments.length * REPLAY_SEGMENT_WIDTH + 240;

const TIMING = Object.freeze({
  walk: 0.72,
  jump: 0.86,
  crouch: 0.72,
  noOp: 0.42,
  phase: 0.22,
  fall: 1.08,
  impact: 0.68,
  victory: 1.02,
});
// Keeps the terminal sprite inside the viewBox while placing its anchor below the ledge.
const FALL_DEPTH = 70;

const SYMBOLS = Object.freeze([
  'body',
  'robot-head',
  'robot-torso',
  'robot-arm',
  'robot-leg',
  'robot-standing',
  'robot-idle',
  'robot-step-a',
  'robot-step-b',
  'robot-jump',
  'robot-crouch',
  'robot-fall',
  'robot-impact',
  'robot-celebrate',
  'terrain-ground',
  'terrain-platform-ground',
  'terrain-platform-frame',
  'terrain-pit-edge',
  'terrain-branch-back',
  'terrain-branch-front',
  'terrain-barrier-low',
  'terrain-barrier-high',
  'terrain-exit',
  'effect-impact',
  'effect-victory',
]);

const terminalStatuses = new Set(['victory', 'defeat', 'incomplete', 'cancelled', 'error']);

const fail = (message: string): never => {
  throw new Error(`No se puede reproducir este intento: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
};

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const isPeriodicSegment = (
  segment: LevelSegment,
): segment is Extract<LevelSegment, { readonly phases: readonly TerrainState[] }> =>
  segment.type === 'barrier' || segment.type === 'platform';

const terrainAllowedByLevel = (
  terrain: unknown,
  segments: readonly LevelSegment[],
  phaseTurn: number,
): terrain is readonly TerrainState[] =>
  Array.isArray(terrain) &&
  terrain.length === segments.length &&
  segments.every((segment, index) => {
    const state = terrain[index];
    if (!isPeriodicSegment(segment)) return state === segment.type;
    const phaseIndex =
      (((phaseTurn + segment.offset) % segment.phases.length) + segment.phases.length) %
      segment.phases.length;
    return state === segment.phases[phaseIndex];
  });

const validateSnapshot = (
  value: unknown,
  segments: readonly LevelSegment[],
  expectedIndex: number,
): void => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    fail(`el estado ${expectedIndex} no tiene un identificador válido`);
  }
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.turnsUsed !== expectedIndex ||
    !Number.isInteger(snapshot.phaseTurn) ||
    (snapshot.phaseTurn as number) < 0 ||
    !terrainAllowedByLevel(snapshot.terrain, segments, snapshot.phaseTurn as number)
  ) {
    fail(`el estado ${expectedIndex} no coincide con la fase y el nivel fijados`);
  }
  if (
    !Number.isInteger(snapshot.support) ||
    (snapshot.support as number) < 0 ||
    (snapshot.support as number) > segments.length ||
    typeof snapshot.exitEnabled !== 'boolean' ||
    !Array.isArray(snapshot.remainingObjects) ||
    !Array.isArray(snapshot.inventory) ||
    !Number.isInteger(snapshot.maxSupportReached) ||
    (snapshot.maxSupportReached as number) < (snapshot.support as number) ||
    !['running', 'victory', 'defeat', 'incomplete'].includes(String(snapshot.status))
  ) {
    fail(`el estado ${expectedIndex} tiene campos incompatibles`);
  }
  if (
    (snapshot.remainingObjects as readonly unknown[]).length > 0 ||
    (snapshot.inventory as readonly unknown[]).length > 0 ||
    snapshot.exitEnabled !== true
  ) {
    fail('el recorrido vigente no interpreta objetos ni inventario');
  }
};

const directionOf = (action: AttemptActionView['action']): Direction | null => {
  if (action.kind === 'advance') return 'right';
  if (action.kind === 'retreat') return 'left';
  if (action.kind === 'jump' || action.kind === 'crouch') return action.direction;
  return null;
};

const ease = (value: number): number => value * value * (3 - 2 * value);

const cueDuration = (action: AttemptActionView): number => {
  if (action.resolution.outcome === 'fall') return TIMING.fall;
  if (action.resolution.outcome === 'collision') return TIMING.impact;
  if (action.resolution.outcome === 'no_op') return TIMING.noOp;
  if (action.action.kind === 'jump') return TIMING.jump;
  if (action.action.kind === 'crouch') return TIMING.crouch;
  return TIMING.walk;
};

const validateRecord = (record: ReplayRecordView): void => {
  if (!isRecord(record) || record.recordVersion !== ATTEMPT_RECORD_VERSION) {
    fail('versión de registro no compatible');
  }
  if (!isRecord(record.config) || !isRecord(record.config.level)) fail('falta el nivel fijado');
  if (!isRecord(record.closure)) fail('falta el cierre del intento');
  if (!sameValue(record.config.level, LEVEL))
    fail('nivel o mecánica no compatible con el recorrido vigente');
  if (!Array.isArray(record.snapshots) || !Array.isArray(record.actions)) {
    fail('faltan acciones o estados del registro');
  }
  if (!terminalStatuses.has(record.closure.status)) fail('el intento todavía no tiene cierre');
  if (!record.closure.recordComplete) fail('el registro está incompleto');
  if (record.closure.actionCount !== record.actions.length)
    fail('el contador de acciones no coincide');
  if (record.actions.length > LEVEL.maxTurns) fail('el registro excede el límite de acciones');
  if (record.snapshots.length !== record.actions.length + 1)
    fail('falta un estado de la secuencia');
  if (record.snapshots.length === 0) fail('falta el estado inicial');

  record.snapshots.forEach((snapshot, index) => validateSnapshot(snapshot, LEVEL.segments, index));
  if (record.snapshots[0]?.status !== 'running' || record.snapshots[0]?.phaseTurn !== 0) {
    fail('el estado inicial no pertenece al recorrido vigente');
  }
  const seenStateIds = new Set(record.snapshots.map((snapshot) => snapshot.id));
  if (seenStateIds.size !== record.snapshots.length)
    fail('hay identificadores de estado duplicados');

  record.actions.forEach((action, index) => {
    const before = record.snapshots[index];
    const after = record.snapshots[index + 1];
    if (
      !isRecord(action) ||
      !isRecord(action.action) ||
      !isRecord(action.resolution) ||
      !isRecord(action.before) ||
      !isRecord(action.after)
    ) {
      fail(`la acción ${index + 1} no tiene todos sus campos`);
    }
    if (
      action.seq !== index + 1 ||
      action.beforeStateId !== before?.id ||
      action.afterStateId !== after?.id ||
      action.before.id !== before?.id ||
      action.after.id !== after?.id ||
      !sameValue(action.before, before) ||
      !sameValue(action.after, after)
    ) {
      fail(`la acción ${index + 1} tiene referencias rotas`);
    }
    if (!isNormalizedAction(action.action)) fail(`la acción ${index + 1} no está soportada`);
    if (!isActionResolution(action.resolution)) {
      fail(`la resolución ${index + 1} no está soportada`);
    }
    if (
      !isSemanticallyValidActionResolution(
        action.action,
        action.before,
        action.after,
        action.resolution,
      )
    ) {
      fail(`la acción ${index + 1} contradice el contrato del juego`);
    }
    if (index < record.actions.length - 1 && action.after.status !== 'running') {
      fail(`hay acciones publicadas después del cierre del juego en el turno ${index + 1}`);
    }
  });

  const lastState = record.snapshots.at(-1);
  if (record.closure.finalStateId !== lastState?.id)
    fail('el estado final no coincide con el cierre');
  if (['victory', 'defeat', 'incomplete'].includes(record.closure.status)) {
    if (lastState?.status !== record.closure.status)
      fail('el cierre no coincide con el estado terminal del juego');
  } else if (lastState?.status !== 'running') {
    fail('el cierre operativo no puede agregar otro estado de juego terminal');
  }
  if (
    record.actions.length === 0 &&
    record.closure.status !== 'cancelled' &&
    record.closure.status !== 'error'
  ) {
    fail('un cierre de juego requiere al menos una acción');
  }
};

const cameraForSupport = (support: number): number => {
  const robotX = REPLAY_SUPPORT_START_X + support * REPLAY_SEGMENT_WIDTH;
  return Math.max(
    0,
    Math.min(REPLAY_WORLD_WIDTH - REPLAY_VIEW_WIDTH, robotX - REPLAY_VIEW_WIDTH / 2),
  );
};

/**
 * Validate a closed public record once and produce a pure time sampler.
 * The sampler reads phases from saved before/after snapshots; it never reruns game rules.
 */
export const prepareReplay = (record: ReplayRecordView): PreparedReplay => {
  validateRecord(record);
  const cues: ActionCue[] = [];
  let cursor = 0;
  let facing: Direction = 'right';
  for (const [index, action] of record.actions.entries()) {
    const direction = directionOf(action.action);
    if (direction) facing = direction;
    const duration = cueDuration(action);
    const start = cursor;
    const end = start + duration;
    cursor = end;
    let transition: PhaseTransitionCue | null = null;
    if (
      action.after.status === 'running' &&
      !sameValue(action.before.terrain, action.after.terrain)
    ) {
      transition = { start: cursor, end: cursor + TIMING.phase, to: action.after.terrain };
      cursor = transition.end;
    }
    cues.push({ start, end, action, index, direction, facing, transition });
  }
  const victory = record.closure.status === 'victory';
  const actionDuration = cursor;
  if (victory) cursor += TIMING.victory;
  const duration = cursor;
  const lastState = record.snapshots.at(-1)!;
  const endingFacing = facing;

  const sample = (elapsedSeconds: number): ReplaySample => {
    const time = Number.isFinite(elapsedSeconds)
      ? Math.max(0, Math.min(duration, elapsedSeconds))
      : 0;
    const cue = cues.find(({ start, end }) => time >= start && time < end);
    if (cue) {
      const action = cue.action;
      const p = Math.max(0, Math.min(1, (time - cue.start) / (cue.end - cue.start)));
      const from = action.before.support;
      const to = action.after.support;
      const direction = cue.direction ?? cue.facing;
      const common = {
        time,
        terrain: action.before.terrain,
        terrainTransition: null,
        cameraX: cameraForSupport(from),
        actionIndex: cue.index,
        actionNumber: cue.index + 1,
        closureStatus: record.closure.status,
        complete: false,
      } as const;

      if (action.resolution.outcome === 'fall') {
        const nearEdge = from + (cue.direction === 'left' ? -0.42 : 0.42);
        const approach = Math.min(1, p / 0.28);
        const fallProgress = Math.max(0, (p - 0.28) / 0.72);
        const support = from + (nearEdge - from) * ease(approach);
        return {
          ...common,
          support,
          cameraX: cameraForSupport(support),
          drop: FALL_DEPTH * ease(fallProgress),
          facing: direction,
          pose: 'fall',
          effect: 'none',
        };
      }
      if (action.resolution.outcome === 'collision') {
        const contact = from + (cue.direction === 'left' ? -0.3 : 0.3);
        const support = from + (contact - from) * ease(Math.min(1, p / 0.58));
        return {
          ...common,
          support,
          cameraX: cameraForSupport(support),
          drop: 0,
          facing: direction,
          pose: p < 0.58 ? (p < 0.3 ? 'step-a' : 'step-b') : 'impact',
          effect: p >= 0.58 ? 'impact' : 'none',
        };
      }
      if (action.resolution.outcome === 'no_op') {
        return {
          ...common,
          support: from,
          drop: 0,
          facing: direction,
          pose: p < 0.55 && cue.direction !== null ? (p < 0.28 ? 'step-a' : 'step-b') : 'idle',
          effect: 'none',
        };
      }

      const amount = ease(p);
      const support = from + (to - from) * amount;
      if (action.action.kind === 'jump') {
        return {
          ...common,
          support,
          cameraX: cameraForSupport(support),
          drop: -Math.sin(Math.PI * p) * 66,
          facing: direction,
          pose: 'jump',
          effect: 'none',
        };
      }
      if (action.action.kind === 'crouch') {
        return {
          ...common,
          support,
          cameraX: cameraForSupport(support),
          drop: 0,
          facing: direction,
          pose: p < 0.18 || p > 0.82 ? 'idle' : 'crouch',
          effect: 'none',
        };
      }
      return {
        ...common,
        support,
        cameraX: cameraForSupport(support),
        drop: 0,
        facing: direction,
        pose: p >= 0.84 ? 'idle' : p < 0.5 ? 'step-a' : 'step-b',
        effect: 'none',
      };
    }

    const transitioning = cues.find(
      (candidate) =>
        candidate.transition &&
        time >= candidate.transition.start &&
        time < candidate.transition.end,
    );
    if (transitioning?.transition) {
      const phase = transitioning.transition;
      const progress = Math.max(0, Math.min(1, (time - phase.start) / (phase.end - phase.start)));
      const support = transitioning.action.after.support;
      return {
        time,
        support,
        drop: 0,
        facing: transitioning.facing,
        pose: 'idle',
        terrain: transitioning.action.before.terrain,
        terrainTransition: { to: phase.to, progress: ease(progress) },
        cameraX: cameraForSupport(support),
        actionIndex: transitioning.index,
        actionNumber: transitioning.index + 1,
        closureStatus: record.closure.status,
        effect: 'none',
        complete: false,
      };
    }

    if (victory && time >= actionDuration) {
      return {
        time,
        support: lastState.support,
        drop: 0,
        facing: endingFacing,
        pose: 'celebrate',
        terrain: lastState.terrain,
        terrainTransition: null,
        cameraX: cameraForSupport(lastState.support),
        actionIndex: null,
        actionNumber: record.actions.length,
        closureStatus: record.closure.status,
        effect: 'victory',
        complete: time >= duration,
      };
    }
    const terminalCue = cues.at(-1);
    const terminalAction = terminalCue?.action;
    const terminalPose: ReplayPose =
      terminalAction?.resolution.outcome === 'fall'
        ? 'fall'
        : terminalAction?.resolution.outcome === 'collision'
          ? 'impact'
          : 'idle';
    const support =
      terminalPose === 'fall'
        ? lastState.support + (terminalCue?.direction === 'left' ? -0.42 : 0.42)
        : terminalPose === 'impact'
          ? lastState.support + (terminalCue?.direction === 'left' ? -0.3 : 0.3)
          : lastState.support;
    return {
      time,
      support,
      drop: terminalPose === 'fall' ? FALL_DEPTH : 0,
      facing: endingFacing,
      pose: terminalPose,
      terrain: lastState.terrain,
      terrainTransition: null,
      cameraX: cameraForSupport(support),
      actionIndex: terminalCue?.index ?? null,
      actionNumber: record.actions.length,
      closureStatus: record.closure.status,
      effect: terminalPose === 'impact' ? 'impact' : 'none',
      complete: true,
    };
  };

  return Object.freeze({ duration, requiredSymbols: SYMBOLS, sample });
};
