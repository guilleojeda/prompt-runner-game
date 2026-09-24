import type { AttemptActionView, ReplayRecordView } from '../../../../shared/attempt.js';
import {
  LEVEL,
  type Direction,
  type GameSnapshot,
  type TerrainState,
} from '../../../../shared/game.js';

export type ReplayPose =
  'idle' | 'step-a' | 'step-b' | 'jump' | 'crouch' | 'fall' | 'impact' | 'celebrate';

export interface ReplaySample {
  readonly time: number;
  /** World-space support coordinate; fractions are presentation-only. */
  readonly support: number;
  /** Pixels below the support line, used by the authored fall clip. */
  readonly drop: number;
  readonly facing: Direction;
  readonly pose: ReplayPose;
  readonly terrain: readonly TerrainState[];
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

interface ActionCue {
  readonly start: number;
  readonly end: number;
  readonly action: AttemptActionView;
  readonly index: number;
  readonly direction: Direction | null;
  readonly facing: Direction;
}

export const REPLAY_PROFILE_VERSION = 'v1' as const;

const TIMING = Object.freeze({
  walk: 0.72,
  jump: 0.86,
  crouch: 0.72,
  noOp: 0.42,
  fall: 1.08,
  impact: 0.68,
  victory: 1.02,
});

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
  'terrain-pit-edge',
  'terrain-branch-back',
  'terrain-branch-front',
  'terrain-exit',
  'effect-impact',
  'effect-victory',
]);

const terminalStatuses = new Set(['victory', 'defeat', 'incomplete', 'cancelled', 'error']);
const supportedActions = new Set(['advance', 'retreat', 'jump', 'crouch', 'swim']);
const supportedOutcomes = new Set(['moved', 'no_op', 'fall', 'collision']);
const supportedReasons = new Set([
  'moved',
  'left_boundary',
  'right_boundary',
  'swim_no_effect',
  'walk_into_pit',
  'crouch_into_pit',
  'walk_into_branch',
  'jump_into_branch',
]);

const fail = (message: string): never => {
  throw new Error(`No se puede reproducir este intento: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const validateSnapshot = (
  snapshot: GameSnapshot,
  levelTerrain: readonly TerrainState[],
  expectedIndex: number,
): void => {
  if (!isRecord(snapshot) || typeof snapshot.id !== 'string' || !snapshot.id) {
    fail(`el estado ${expectedIndex} no tiene un identificador válido`);
  }
  if (
    snapshot.turnsUsed !== expectedIndex ||
    !Array.isArray(snapshot.terrain) ||
    snapshot.terrain.length !== levelTerrain.length
  ) {
    fail(`el estado ${expectedIndex} no coincide con el nivel estático`);
  }
  if (!sameValue(snapshot.terrain, levelTerrain)) {
    fail('la fase de terreno no pertenece al perfil estático v1');
  }
  if (
    !Number.isInteger(snapshot.support) ||
    snapshot.support < 0 ||
    snapshot.support > levelTerrain.length ||
    !Number.isInteger(snapshot.phaseTurn) ||
    typeof snapshot.exitEnabled !== 'boolean' ||
    !Array.isArray(snapshot.remainingObjects) ||
    !Array.isArray(snapshot.inventory) ||
    !Number.isInteger(snapshot.maxSupportReached) ||
    !['running', 'victory', 'defeat', 'incomplete'].includes(snapshot.status)
  ) {
    fail(`el estado ${expectedIndex} tiene campos incompatibles`);
  }
  if (snapshot.remainingObjects.length > 0 || snapshot.inventory.length > 0) {
    fail('el perfil estático v1 no interpreta objetos ni inventario');
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
  if (!isRecord(record) || record.recordVersion !== 1) fail('versión de registro no compatible');
  if (!isRecord(record.config) || !isRecord(record.config.level)) fail('falta el nivel fijado');
  if (!isRecord(record.closure)) fail('falta el cierre del intento');
  const level = record.config.level;
  if (
    level.id !== LEVEL.id ||
    level.version !== LEVEL.version ||
    level.rulesVersion !== LEVEL.rulesVersion ||
    !sameValue(level.segments, LEVEL.segments) ||
    !sameValue(level.objects, LEVEL.objects) ||
    !sameValue(level.exit, LEVEL.exit)
  ) {
    fail('nivel o mecánica no compatible con el perfil estático v1');
  }
  if (!Array.isArray(record.snapshots) || !Array.isArray(record.actions)) {
    fail('faltan acciones o estados del registro');
  }
  if (!terminalStatuses.has(record.closure.status)) fail('el intento todavía no tiene cierre');
  if (!record.closure.recordComplete) fail('el registro está incompleto');
  if (record.closure.actionCount !== record.actions.length)
    fail('el contador de acciones no coincide');
  if (record.snapshots.length !== record.actions.length + 1)
    fail('falta un estado de la secuencia');
  if (record.snapshots.length === 0) fail('falta el estado inicial');

  const terrain = LEVEL.segments.map((segment) => segment.type);
  record.snapshots.forEach((snapshot, index) => validateSnapshot(snapshot, terrain, index));
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
    if (!supportedActions.has(action.action.kind)) fail(`la acción ${index + 1} no está soportada`);
    if (
      !supportedOutcomes.has(action.resolution.outcome) ||
      !supportedReasons.has(action.resolution.reason)
    ) {
      fail(`la resolución ${index + 1} no está soportada`);
    }
    if (
      (action.action.kind === 'jump' || action.action.kind === 'crouch') &&
      action.action.direction !== 'left' &&
      action.action.direction !== 'right'
    ) {
      fail(`la dirección de la acción ${index + 1} no es válida`);
    }
    if (
      action.resolution.outcome === 'moved' ||
      action.resolution.outcome === 'fall' ||
      action.resolution.outcome === 'collision'
    ) {
      if (
        !('segment' in action.resolution) ||
        !Number.isInteger(action.resolution.segment) ||
        !Number.isInteger(action.resolution.targetSupport)
      ) {
        fail(`la resolución ${index + 1} no tiene tramo y apoyo válidos`);
      }
      const direction = directionOf(action.action);
      const expectedSegment =
        direction === 'left' ? action.before.support - 1 : action.before.support;
      const expectedTarget = action.before.support + (direction === 'left' ? -1 : 1);
      if (
        direction === null ||
        action.resolution.segment !== expectedSegment ||
        action.resolution.targetSupport !== expectedTarget ||
        action.resolution.segment < 0 ||
        action.resolution.segment >= terrain.length ||
        action.resolution.targetSupport < 0 ||
        action.resolution.targetSupport > terrain.length ||
        action.before.status !== 'running'
      ) {
        fail(`la resolución ${index + 1} contradice el movimiento registrado`);
      }
      if (
        (action.resolution.outcome === 'moved' && action.after.support !== expectedTarget) ||
        (action.resolution.outcome !== 'moved' && action.after.support !== action.before.support)
      ) {
        fail(`la resolución ${index + 1} no coincide con sus estados`);
      }
    } else if (
      action.action.kind !== 'swim' &&
      action.resolution.reason !== 'left_boundary' &&
      action.resolution.reason !== 'right_boundary'
    ) {
      fail(`la acción sin movimiento ${index + 1} tiene una causa incompatible`);
    } else if (action.action.kind === 'swim' && action.resolution.reason !== 'swim_no_effect') {
      fail(`la acción sin efecto ${index + 1} tiene una causa incompatible`);
    }
    if (index < record.actions.length - 1 && after?.status !== 'running') {
      fail(`hay acciones publicadas después del cierre del juego en el turno ${index + 1}`);
    }
  });

  const lastState = record.snapshots.at(-1);
  if (record.closure.finalStateId !== lastState?.id)
    fail('el estado final no coincide con el cierre');
  if (
    ['victory', 'defeat', 'incomplete'].includes(record.closure.status) &&
    lastState?.status !== record.closure.status
  ) {
    fail('el cierre no coincide con el estado terminal del juego');
  }
  if (record.actions.length === 0 && record.closure.status === 'victory') {
    fail('una victoria sin acciones no pertenece al juego estático v1');
  }
};

/**
 * Validate a closed public record once and produce a pure time sampler.
 * The sampler never advances hidden state, so dropped animation frames do not
 * change which registered action or pose is shown.
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
    cues.push({ start: cursor, end: cursor + duration, action, index, direction, facing });
    cursor += duration;
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
    const cue = cues.find(({ end }) => time < end);
    if (cue) {
      const action = cue.action;
      const p = Math.max(0, Math.min(1, (time - cue.start) / (cue.end - cue.start)));
      const from = action.before.support;
      const to = action.after.support;
      const direction = cue.direction ?? cue.facing;
      const common = {
        time,
        terrain: action.before.terrain,
        actionIndex: cue.index,
        actionNumber: cue.index + 1,
        closureStatus: record.closure.status,
        complete: false,
      } as const;

      if (action.resolution.outcome === 'fall') {
        const nearEdge = from + (cue.direction === 'left' ? -0.42 : 0.42);
        const approach = Math.min(1, p / 0.28);
        const fallProgress = Math.max(0, (p - 0.28) / 0.72);
        return {
          ...common,
          support: from + (nearEdge - from) * ease(approach),
          drop: 116 * ease(fallProgress),
          facing: direction,
          pose: 'fall',
          effect: 'none',
        };
      }
      if (action.resolution.outcome === 'collision') {
        const contact = from + (cue.direction === 'left' ? -0.3 : 0.3);
        return {
          ...common,
          support: from + (contact - from) * ease(Math.min(1, p / 0.58)),
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
      const travel = from + (to - from) * amount;
      if (action.action.kind === 'jump') {
        return {
          ...common,
          support: travel,
          drop: -Math.sin(Math.PI * p) * 66,
          facing: direction,
          pose: 'jump',
          effect: 'none',
        };
      }
      if (action.action.kind === 'crouch') {
        return {
          ...common,
          support: travel,
          drop: 0,
          facing: direction,
          pose: p < 0.18 || p > 0.82 ? 'idle' : 'crouch',
          effect: 'none',
        };
      }
      return {
        ...common,
        support: travel,
        drop: 0,
        facing: direction,
        pose: p >= 0.84 ? 'idle' : p < 0.5 ? 'step-a' : 'step-b',
        effect: 'none',
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
    return {
      time,
      support:
        terminalPose === 'fall'
          ? lastState.support + (terminalCue?.direction === 'left' ? -0.42 : 0.42)
          : terminalPose === 'impact'
            ? lastState.support + (terminalCue?.direction === 'left' ? -0.3 : 0.3)
            : lastState.support,
      drop: terminalPose === 'fall' ? 116 : 0,
      facing: endingFacing,
      pose: terminalPose,
      terrain: terminalAction?.before.terrain ?? lastState.terrain,
      actionIndex: terminalCue?.index ?? null,
      actionNumber: record.actions.length,
      closureStatus: record.closure.status,
      effect: terminalPose === 'impact' ? 'impact' : 'none',
      complete: true,
    };
  };

  return Object.freeze({ duration, requiredSymbols: SYMBOLS, sample });
};
