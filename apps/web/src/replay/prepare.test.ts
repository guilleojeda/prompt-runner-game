import { describe, expect, it } from 'vitest';
import { createClosedAttemptRecordFixture } from '../../../../shared/attempt.fixture.js';
import {
  effectiveTerrain,
  isSemanticallyValidActionResolution,
  LEVEL,
  type TerrainState,
} from '../../../../shared/game.js';
import {
  prepareReplay,
  REPLAY_SEGMENT_WIDTH,
  REPLAY_SUPPORT_START_X,
  REPLAY_VIEW_WIDTH,
} from './prepare.js';
import { publicReplayView, replayRecordForActions } from './replay.test-support.js';

const toLowBarrier: Parameters<typeof replayRecordForActions>[0] = [
  { kind: 'advance' },
  { kind: 'jump', direction: 'right' },
  { kind: 'advance' },
  { kind: 'crouch', direction: 'right' },
  { kind: 'advance' },
];

describe('prepareReplay', () => {
  it('keeps the recorded terrain during an action and samples a transition after it', () => {
    const record = replayRecordForActions([{ kind: 'advance' }]);
    const prepared = prepareReplay(record);
    const before = record.actions[0]!.before.terrain;
    const after = record.actions[0]!.after.terrain;

    expect(prepared.sample(0.36)).toMatchObject({
      actionIndex: 0,
      support: 0.5,
      pose: 'step-b',
      terrain: before,
      terrainTransition: null,
    });
    expect(prepared.sample(0.72)).toMatchObject({
      actionIndex: 0,
      terrain: before,
      terrainTransition: { to: after, progress: 0 },
    });
    expect(prepared.sample(0.83).terrainTransition?.progress).toBeCloseTo(0.5);
    expect(prepared.sample(prepared.duration)).toMatchObject({
      actionIndex: 0,
      actionNumber: 1,
      support: 1,
      terrain: after,
      terrainTransition: null,
      complete: true,
      closureStatus: 'cancelled',
    });
  });

  it('keeps wait still, preserves the prior facing, and applies the saved phase after wait', () => {
    const record = replayRecordForActions([{ kind: 'advance' }, { kind: 'wait' }]);
    const prepared = prepareReplay(record);
    const wait = record.actions[1]!;
    const waitStart = 0.94;
    const duringWait = prepared.sample(waitStart + 0.21);

    expect(duringWait).toMatchObject({
      actionIndex: 1,
      actionNumber: 2,
      support: 1,
      pose: 'idle',
      facing: 'right',
      terrain: wait.before.terrain,
      terrainTransition: null,
    });
    expect(prepared.sample(waitStart + 0.42)).toMatchObject({
      actionIndex: 1,
      terrain: wait.before.terrain,
      terrainTransition: { to: wait.after.terrain, progress: 0 },
    });
    expect(prepared.sample(prepared.duration)).toMatchObject({
      terrain: wait.after.terrain,
      facing: 'right',
      support: 1,
      complete: true,
    });
  });

  it('shows a terminal collision using its evaluated terrain without adding a phase', () => {
    const record = replayRecordForActions(toLowBarrier, 'defeat');
    const prepared = prepareReplay(record);
    const terminalAction = record.actions.at(-1)!;

    expect(terminalAction.before.terrain[4]).toBe('barrier_low');
    expect(terminalAction.resolution).toMatchObject({
      outcome: 'collision',
      reason: 'walk_into_barrier',
    });
    expect(terminalAction.after.phaseTurn).toBe(terminalAction.before.phaseTurn);
    expect(terminalAction.after.terrain).toEqual(terminalAction.before.terrain);
    expect(prepared.sample(prepared.duration)).toMatchObject({
      actionIndex: 4,
      pose: 'impact',
      effect: 'impact',
      terrain: terminalAction.before.terrain,
      terrainTransition: null,
      complete: true,
      closureStatus: 'defeat',
    });
  });

  it.each([
    {
      name: 'a ground advance labeled as a barrier collision',
      makeRecord: () => replayRecordForActions([{ kind: 'advance' }]),
      corrupt: (record: ReturnType<typeof replayRecordForActions>) => ({
        ...record,
        actions: record.actions.map((action, index) =>
          index === 0
            ? {
                ...action,
                resolution: {
                  outcome: 'collision',
                  reason: 'walk_into_barrier',
                  segment: 0,
                  targetSupport: 1,
                } as never,
              }
            : action,
        ),
      }),
    },
    {
      name: 'an advance into a low barrier labeled as a branch jump',
      makeRecord: () => replayRecordForActions(toLowBarrier, 'defeat'),
      corrupt: (record: ReturnType<typeof replayRecordForActions>) => ({
        ...record,
        actions: record.actions.map((action, index) =>
          index === record.actions.length - 1
            ? {
                ...action,
                resolution: { ...action.resolution, reason: 'jump_into_branch' } as never,
              }
            : action,
        ),
      }),
    },
    {
      name: 'a ground advance labeled as falling into a pit',
      makeRecord: () => replayRecordForActions([{ kind: 'advance' }]),
      corrupt: (record: ReturnType<typeof replayRecordForActions>) => ({
        ...record,
        actions: record.actions.map((action, index) =>
          index === 0
            ? {
                ...action,
                resolution: { ...action.resolution, reason: 'walk_into_pit' } as never,
              }
            : action,
        ),
      }),
    },
  ])('rejects $name', ({ makeRecord, corrupt }) => {
    expect(() => prepareReplay(corrupt(makeRecord()))).toThrow('contradice el contrato del juego');
  });

  it('accepts a real fatal resolution, a victory at the exit, and the turn-limit ending', () => {
    expect(() => prepareReplay(replayRecordForActions(toLowBarrier, 'defeat'))).not.toThrow();
    expect(() => prepareReplay(publicReplayView(createClosedAttemptRecordFixture()))).not.toThrow();
    expect(() =>
      prepareReplay(
        replayRecordForActions(
          Array.from({ length: LEVEL.maxTurns }, () => ({ kind: 'wait' as const })),
          'incomplete',
        ),
      ),
    ).not.toThrow();
  });

  it('allows a running arrival at a disabled exit and rejects a victory before the enabled exit', () => {
    const winningRecord = publicReplayView(createClosedAttemptRecordFixture());
    const action = winningRecord.actions.at(-1)!;
    const before = { ...action.before, exitEnabled: false };
    const runningAfter = {
      ...action.after,
      exitEnabled: false,
      status: 'running' as const,
      phaseTurn: before.phaseTurn + 1,
      terrain: effectiveTerrain(LEVEL, before.phaseTurn + 1),
    };
    const falseVictory = {
      ...action.after,
      exitEnabled: false,
      status: 'victory' as const,
      phaseTurn: before.phaseTurn,
      terrain: before.terrain,
    };

    expect(
      isSemanticallyValidActionResolution(action.action, before, runningAfter, action.resolution),
    ).toBe(true);
    expect(
      isSemanticallyValidActionResolution(action.action, before, falseVictory, action.resolution),
    ).toBe(false);
  });

  it('rejects defeat on safe ground and incomplete before consuming the turn limit', () => {
    const record = replayRecordForActions([{ kind: 'advance' }]);
    const action = record.actions[0]!;
    const defeat = {
      ...action.after,
      support: action.before.support,
      status: 'defeat' as const,
      phaseTurn: action.before.phaseTurn,
      terrain: action.before.terrain,
    };
    const incomplete = {
      ...action.after,
      status: 'incomplete' as const,
      phaseTurn: action.before.phaseTurn,
      terrain: action.before.terrain,
    };

    expect(
      isSemanticallyValidActionResolution(action.action, action.before, defeat, {
        outcome: 'collision',
        reason: 'walk_into_barrier',
        segment: 0,
        targetSupport: 1,
      }),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        action.action,
        action.before,
        incomplete,
        action.resolution,
      ),
    ).toBe(false);
  });

  it.each(['victory', 'defeat', 'incomplete'] as const)(
    'rejects a false %s state after a safe ground advance',
    (status) => {
      const record = replayRecordForActions([{ kind: 'advance' }], status);
      const before = record.snapshots[0]!;
      const after = {
        ...record.snapshots[1]!,
        status,
        phaseTurn: before.phaseTurn,
        terrain: before.terrain,
        ...(status === 'defeat' ? { support: before.support } : {}),
      };
      const corrupted = {
        ...record,
        snapshots: [before, after],
        actions: [{ ...record.actions[0]!, after }],
        closure: { ...record.closure, status, finalStateId: after.id },
      };

      expect(() => prepareReplay(corrupted)).toThrow('contradice el contrato del juego');
    },
  );

  it('rejects a record whose phase counter moves at a terminal action', () => {
    const record = replayRecordForActions(toLowBarrier, 'defeat');
    const lastIndex = record.snapshots.length - 1;
    const snapshots = record.snapshots.map((snapshot, index) =>
      index === lastIndex ? { ...snapshot, phaseTurn: snapshot.phaseTurn + 1 } : snapshot,
    );
    const actions = record.actions.map((action, index) =>
      index === record.actions.length - 1 ? { ...action, after: snapshots[lastIndex]! } : action,
    );

    expect(() => prepareReplay({ ...record, snapshots, actions })).toThrow(
      'no coincide con la fase y el nivel',
    );
  });

  it('rejects a changed terrain that is not supported by its level descriptor', () => {
    const record = replayRecordForActions([{ kind: 'advance' }]);
    const snapshots = record.snapshots.map((snapshot, index) =>
      index === 1
        ? {
            ...snapshot,
            terrain: ['ground', 'ground', ...snapshot.terrain.slice(2)] as typeof snapshot.terrain,
          }
        : snapshot,
    );
    const actions = record.actions.map((action, index) =>
      index === 0 ? { ...action, after: snapshots[1]! } : action,
    );

    expect(() => prepareReplay({ ...record, snapshots, actions })).toThrow(
      'no coincide con la fase y el nivel',
    );
  });

  it.each([
    { name: 'barrier', segmentIndex: 4, terrain: 'barrier_low' },
    { name: 'platform', segmentIndex: 5, terrain: 'ground' },
  ] as const)(
    'rejects a saved $name state that is allowed by the level but mismatches phaseTurn',
    ({ segmentIndex, terrain: mismatchedState }) => {
      const record = replayRecordForActions([{ kind: 'advance' }]);
      const snapshots = record.snapshots.map((snapshot, index) => {
        if (index !== 1) return snapshot;
        const terrain = [...snapshot.terrain];
        terrain[segmentIndex] = mismatchedState as TerrainState;
        return { ...snapshot, terrain };
      });
      const actions = record.actions.map((action, index) =>
        index === 0 ? { ...action, after: snapshots[1]! } : action,
      );

      expect(() => prepareReplay({ ...record, snapshots, actions })).toThrow(
        'no coincide con la fase y el nivel',
      );
    },
  );

  it('uses the same pure elapsed-time sample after omitted or out-of-order frames', () => {
    const prepared = prepareReplay(publicReplayView(createClosedAttemptRecordFixture()));
    const lateSample = prepared.sample(prepared.duration * 0.73);
    prepared.sample(prepared.duration);
    prepared.sample(0.25);

    expect(prepared.sample(prepared.duration * 0.73)).toEqual(lateSample);
    expect(prepared.sample(Number.NaN)).toEqual(prepared.sample(0));
  });

  it('follows the robot across the seven-segment level while keeping it in the viewport', () => {
    const prepared = prepareReplay(publicReplayView(createClosedAttemptRecordFixture()));
    const beginning = prepared.sample(0);
    const ending = prepared.sample(prepared.duration);
    const robotWorldX = REPLAY_SUPPORT_START_X + ending.support * REPLAY_SEGMENT_WIDTH;
    const robotScreenX = robotWorldX - ending.cameraX;

    expect(beginning.cameraX).toBe(0);
    expect(ending.cameraX).toBeGreaterThan(beginning.cameraX);
    expect(robotScreenX).toBeGreaterThan(0);
    expect(robotScreenX).toBeLessThan(REPLAY_VIEW_WIDTH);
    expect(ending.terrain).toEqual(createClosedAttemptRecordFixture().snapshots.at(-1)?.terrain);
    expect(ending.terrainTransition).toBeNull();
  });

  it('rejects incomplete, stale, unsupported, or mismatched records explicitly', () => {
    const current = publicReplayView(createClosedAttemptRecordFixture());
    expect(() =>
      prepareReplay({ ...current, closure: { ...current.closure, recordComplete: false } }),
    ).toThrow('registro está incompleto');
    expect(() => prepareReplay({ ...current, recordVersion: 1 as 2 })).toThrow(
      'versión de registro no compatible',
    );
    expect(() =>
      prepareReplay({
        ...current,
        config: { level: { ...current.config.level, id: 'obsolete-level' } },
      }),
    ).toThrow('nivel o mecánica no compatible');

    const unsupportedAction = {
      ...current,
      actions: current.actions.map((action, index) =>
        index === 0 ? { ...action, action: { kind: 'teleport' } as never } : action,
      ),
    };
    expect(() => prepareReplay(unsupportedAction)).toThrow('la acción 1 no está soportada');
  });
});
