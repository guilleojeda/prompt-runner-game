import { describe, expect, it } from 'vitest';
import { createClosedAttemptRecordFixture } from '../../../../shared/attempt.fixture.js';
import type {
  AttemptRecord,
  AttemptRecordView,
  ReplayRecordView,
} from '../../../../shared/attempt.js';
import {
  createInitialState,
  resolveAction,
  type NormalizedAction,
} from '../../../../shared/game.js';
import { prepareReplay } from './prepare.js';

const publicView = (record: AttemptRecord): ReplayRecordView => {
  const states = new Map(record.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const expanded: AttemptRecordView['actions'] = record.actions.map((action) => {
    const before = states.get(action.beforeStateId);
    const after = states.get(action.afterStateId);
    if (!before || !after) throw new Error('fixture action is missing a state');
    return { ...action, before, after };
  });
  return {
    recordVersion: record.recordVersion,
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    config: { level: record.config.level },
    snapshots: record.snapshots,
    actions: expanded,
    closure: record.closure,
    metrics: record.metrics,
    score: record.score,
  };
};

const recordFor = (
  actions: readonly NormalizedAction[],
  closureStatus: AttemptRecord['closure']['status'] = 'cancelled',
): ReplayRecordView => {
  const source = createClosedAttemptRecordFixture();
  const state = createInitialState(source.config.level);
  const results = [];
  let current = state;
  for (const action of actions) {
    const result = resolveAction(current, action, source.config.level);
    results.push(result);
    current = result.after;
  }
  const snapshots = [state, ...results.map((result) => result.after)];
  const actionsWithStates = results.map((result, index) => ({
    seq: index + 1,
    decisionId: `decision-${index + 1}`,
    beforeStateId: result.before.id,
    afterStateId: result.after.id,
    action: result.action,
    resolution: result.resolution,
  }));
  const record: AttemptRecord = {
    ...source,
    id: `replay-${closureStatus}-${actions.length}`,
    config: source.config,
    snapshots,
    actions: actionsWithStates,
    closure: {
      status: closureStatus,
      actionCount: actions.length,
      finalStateId: current.id,
      recordComplete: true,
    },
    metrics: { ...source.metrics, calls: actions.length },
    score: null,
  };
  return publicView(record);
};

describe('prepareReplay', () => {
  it('samples walking, jump, crouch and the victory end pose at fixed elapsed times', () => {
    const prepared = prepareReplay(publicView(createClosedAttemptRecordFixture()));

    const walking = prepared.sample(0.36);
    expect(walking).toMatchObject({
      actionIndex: 0,
      support: 0.5,
      pose: 'step-b',
      facing: 'right',
    });

    const jumping = prepared.sample(1.15);
    expect(jumping.actionIndex).toBe(1);
    expect(jumping.pose).toBe('jump');
    expect(jumping.support).toBeCloseTo(1.5);
    expect(jumping.drop).toBeCloseTo(-66);
    expect(jumping.terrain).toEqual(
      publicView(createClosedAttemptRecordFixture()).actions[1]?.before.terrain,
    );

    const crouching = prepared.sample(2.66);
    expect(crouching).toMatchObject({ actionIndex: 3, pose: 'crouch', facing: 'right' });
    expect(crouching.support).toBeCloseTo(3.5);

    const ending = prepared.sample(prepared.duration);
    expect(ending).toMatchObject({
      pose: 'celebrate',
      effect: 'victory',
      complete: true,
      closureStatus: 'victory',
    });
  });

  it('reflects the same walk poses for a move to the left', () => {
    const prepared = prepareReplay(recordFor([{ kind: 'advance' }, { kind: 'retreat' }]));
    const retreat = prepared.sample(0.72 + 0.36);
    expect(retreat).toMatchObject({ actionIndex: 1, pose: 'step-b', facing: 'left' });
    expect(retreat.support).toBeCloseTo(0.5);
  });

  it('keeps no-op actions on their support instead of inventing travel', () => {
    const prepared = prepareReplay(recordFor([{ kind: 'swim' }]));
    const noOp = prepared.sample(0.2);
    expect(noOp).toMatchObject({
      actionIndex: 0,
      actionNumber: 1,
      support: 0,
      pose: 'idle',
      effect: 'none',
    });
  });

  it('shows a boundary no-op without moving through the edge', () => {
    const prepared = prepareReplay(recordFor([{ kind: 'retreat' }]));
    expect(prepared.sample(0.2)).toMatchObject({
      actionIndex: 0,
      support: 0,
      facing: 'left',
      effect: 'none',
    });
    expect(prepared.sample(prepared.duration)).toMatchObject({
      complete: true,
      support: 0,
      pose: 'idle',
    });
  });

  it('uses the facing at the no-op turn instead of a later direction', () => {
    const prepared = prepareReplay(
      recordFor([{ kind: 'advance' }, { kind: 'swim' }, { kind: 'retreat' }]),
    );
    const noOp = prepared.sample(0.72 + 0.21);
    expect(noOp).toMatchObject({ actionIndex: 1, pose: 'idle', support: 1, facing: 'right' });
    expect(prepared.sample(1.14).facing).toBe('left');
  });

  it('walks to the edge and preserves the falling pose after a pit resolution', () => {
    const prepared = prepareReplay(recordFor([{ kind: 'advance' }, { kind: 'advance' }], 'defeat'));
    const falling = prepared.sample(0.72 + 0.54);
    expect(falling.actionIndex).toBe(1);
    expect(falling.pose).toBe('fall');
    expect(falling.support).toBeCloseTo(1.42);
    expect(falling.drop).toBeGreaterThan(0);

    const terminal = prepared.sample(prepared.duration);
    expect(terminal).toMatchObject({ pose: 'fall', complete: true, closureStatus: 'defeat' });
    expect(terminal.support).toBeCloseTo(1.42);
    expect(terminal.drop).toBe(116);
  });

  it('stops at the branch collision and keeps its impact end pose', () => {
    const prepared = prepareReplay(
      recordFor(
        [
          { kind: 'advance' },
          { kind: 'jump', direction: 'right' },
          { kind: 'advance' },
          { kind: 'advance' },
        ],
        'defeat',
      ),
    );
    const contact = prepared.sample(2.3 + 0.68 * 0.8);
    expect(contact).toMatchObject({ actionIndex: 3, pose: 'impact', effect: 'impact' });
    expect(contact.support).toBeCloseTo(3.3);

    const terminal = prepared.sample(prepared.duration);
    expect(terminal).toMatchObject({ pose: 'impact', effect: 'impact', complete: true });
    expect(terminal.support).toBeCloseTo(3.3);
  });

  it('uses only the sampled elapsed time, even when frames were skipped', () => {
    const prepared = prepareReplay(publicView(createClosedAttemptRecordFixture()));
    const firstRead = prepared.sample(1.15);
    prepared.sample(4.4);
    expect(prepared.sample(1.15)).toEqual(firstRead);
    expect(prepared.sample(Number.NaN)).toEqual(prepared.sample(0));
  });

  it('accepts an empty cancellation and rejects an incomplete or unsupported record explicitly', () => {
    const empty = prepareReplay(recordFor([]));
    expect(empty.duration).toBe(0);
    expect(empty.sample(0)).toMatchObject({
      complete: true,
      closureStatus: 'cancelled',
      pose: 'idle',
    });

    const cancelledAfterMovement = prepareReplay(recordFor([{ kind: 'advance' }]));
    expect(cancelledAfterMovement.sample(cancelledAfterMovement.duration)).toMatchObject({
      complete: true,
      closureStatus: 'cancelled',
      pose: 'idle',
      support: 1,
    });

    const incomplete = publicView(createClosedAttemptRecordFixture());
    expect(() =>
      prepareReplay({ ...incomplete, closure: { ...incomplete.closure, recordComplete: false } }),
    ).toThrow('registro está incompleto');
    expect(() => prepareReplay({ ...incomplete, recordVersion: 2 as 1 })).toThrow(
      'versión de registro no compatible',
    );
    expect(() =>
      prepareReplay({
        ...incomplete,
        config: { level: { ...incomplete.config.level, id: 'future-level' } },
      }),
    ).toThrow('nivel o mecánica no compatible');
  });
});
