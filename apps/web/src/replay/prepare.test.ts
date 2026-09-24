import { describe, expect, it } from 'vitest';
import { createClosedAttemptRecordFixture } from '../../../../shared/attempt.fixture.js';
import { prepareReplay } from './prepare.js';
import { publicReplayView, replayRecordForActions } from './replay.test-support.js';

describe('prepareReplay', () => {
  it('samples walking, jump, crouch and the victory end pose at fixed elapsed times', () => {
    const prepared = prepareReplay(publicReplayView(createClosedAttemptRecordFixture()));

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
      publicReplayView(createClosedAttemptRecordFixture()).actions[1]?.before.terrain,
    );
    expect(prepared.sample(0.719).support).toBeCloseTo(1);
    const jumpStart = prepared.sample(0.72);
    expect(jumpStart).toMatchObject({ actionIndex: 1, support: 1, facing: 'right' });
    expect(jumpStart.drop).toBeCloseTo(0);
    expect(prepared.sample(1.58)).toMatchObject({ actionIndex: 2, support: 2, facing: 'right' });

    const crouching = prepared.sample(2.66);
    expect(crouching).toMatchObject({ actionIndex: 3, pose: 'crouch', facing: 'right' });
    expect(crouching.support).toBeCloseTo(3.5);
    expect(prepared.sample(2.3)).toMatchObject({ actionIndex: 3, support: 3, pose: 'idle' });
    expect(prepared.sample(3.02)).toMatchObject({ actionIndex: 4, support: 4, facing: 'right' });

    const ending = prepared.sample(prepared.duration);
    expect(ending).toMatchObject({
      pose: 'celebrate',
      effect: 'victory',
      complete: true,
      closureStatus: 'victory',
    });
  });

  it('reflects the same walk poses for a move to the left', () => {
    const prepared = prepareReplay(
      replayRecordForActions([{ kind: 'advance' }, { kind: 'retreat' }]),
    );
    const retreat = prepared.sample(0.72 + 0.36);
    expect(retreat).toMatchObject({ actionIndex: 1, pose: 'step-b', facing: 'left' });
    expect(retreat.support).toBeCloseTo(0.5);
  });

  it('jumps left across the pit with the same arc and opposite facing', () => {
    const prepared = prepareReplay(
      replayRecordForActions([
        { kind: 'advance' },
        { kind: 'jump', direction: 'right' },
        { kind: 'jump', direction: 'left' },
      ]),
    );
    expect(prepared.sample(1.579)).toMatchObject({ actionIndex: 1, facing: 'right' });
    const jumpMidpoint = prepared.sample(2.01);
    expect(jumpMidpoint).toMatchObject({
      actionIndex: 2,
      drop: -66,
      pose: 'jump',
      facing: 'left',
    });
    expect(jumpMidpoint.support).toBeCloseTo(1.5);
    expect(prepared.sample(2.44)).toMatchObject({
      complete: true,
      support: 1,
      pose: 'idle',
      facing: 'left',
    });
  });

  it('crouches left under the branch and returns to a standing terminal pose', () => {
    const prepared = prepareReplay(
      replayRecordForActions([
        { kind: 'advance' },
        { kind: 'jump', direction: 'right' },
        { kind: 'advance' },
        { kind: 'crouch', direction: 'right' },
        { kind: 'crouch', direction: 'left' },
      ]),
    );
    expect(prepared.sample(3.019)).toMatchObject({ actionIndex: 3, facing: 'right' });
    expect(prepared.sample(3.02)).toMatchObject({
      actionIndex: 4,
      support: 4,
      pose: 'idle',
      facing: 'left',
    });
    const crouchMidpoint = prepared.sample(3.38);
    expect(crouchMidpoint).toMatchObject({
      actionIndex: 4,
      pose: 'crouch',
      facing: 'left',
    });
    expect(crouchMidpoint.support).toBeCloseTo(3.5);
    expect(prepared.sample(3.74)).toMatchObject({
      complete: true,
      support: 3,
      pose: 'idle',
      facing: 'left',
    });
  });

  it('keeps no-op actions on their support instead of inventing travel', () => {
    const prepared = prepareReplay(replayRecordForActions([{ kind: 'swim' }]));
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
    const prepared = prepareReplay(replayRecordForActions([{ kind: 'retreat' }]));
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
      replayRecordForActions([{ kind: 'advance' }, { kind: 'swim' }, { kind: 'retreat' }]),
    );
    const noOp = prepared.sample(0.72 + 0.21);
    expect(noOp).toMatchObject({ actionIndex: 1, pose: 'idle', support: 1, facing: 'right' });
    expect(prepared.sample(1.14).facing).toBe('left');
  });

  it('walks to the edge and preserves the falling pose after a pit resolution', () => {
    const prepared = prepareReplay(
      replayRecordForActions([{ kind: 'advance' }, { kind: 'advance' }], 'defeat'),
    );
    const falling = prepared.sample(0.72 + 0.54);
    expect(falling.actionIndex).toBe(1);
    expect(falling.pose).toBe('fall');
    expect(falling.support).toBeCloseTo(1.42);
    expect(falling.drop).toBeGreaterThan(0);
    expect(prepared.sample(0.719).support).toBeCloseTo(1);
    expect(prepared.sample(0.72)).toMatchObject({
      actionIndex: 1,
      support: 1,
      drop: 0,
      pose: 'fall',
    });

    const terminal = prepared.sample(prepared.duration);
    expect(terminal).toMatchObject({ pose: 'fall', complete: true, closureStatus: 'defeat' });
    expect(terminal.support).toBeCloseTo(1.42);
    expect(terminal.drop).toBe(116);
  });

  it('falls left from the far side of the pit without crossing the gap on a walk', () => {
    const prepared = prepareReplay(
      replayRecordForActions(
        [{ kind: 'advance' }, { kind: 'jump', direction: 'right' }, { kind: 'retreat' }],
        'defeat',
      ),
    );
    const beforeFall = prepared.sample(1.579);
    expect(beforeFall).toMatchObject({ actionIndex: 1, pose: 'jump' });
    expect(beforeFall.support).toBeCloseTo(2);
    const fallStart = prepared.sample(1.58);
    expect(fallStart).toMatchObject({ actionIndex: 2, support: 2, pose: 'fall', facing: 'left' });
    expect(fallStart.drop).toBeCloseTo(0);
    expect(prepared.sample(2.12)).toMatchObject({
      actionIndex: 2,
      support: 1.58,
      pose: 'fall',
      facing: 'left',
    });
    expect(prepared.sample(2.66)).toMatchObject({
      complete: true,
      support: 1.58,
      drop: 116,
      closureStatus: 'defeat',
    });
  });

  it('stops at the branch collision and keeps its impact end pose', () => {
    const prepared = prepareReplay(
      replayRecordForActions(
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
    expect(prepared.sample(2.299)).toMatchObject({ actionIndex: 2, facing: 'right' });
    expect(prepared.sample(2.3)).toMatchObject({ actionIndex: 3, pose: 'step-a', support: 3 });

    const terminal = prepared.sample(prepared.duration);
    expect(terminal).toMatchObject({ pose: 'impact', effect: 'impact', complete: true });
    expect(terminal.support).toBeCloseTo(3.3);
  });

  it('collides while moving left into the branch and keeps the impact over its contact point', () => {
    const prepared = prepareReplay(
      replayRecordForActions(
        [
          { kind: 'advance' },
          { kind: 'jump', direction: 'right' },
          { kind: 'advance' },
          { kind: 'crouch', direction: 'right' },
          { kind: 'retreat' },
        ],
        'defeat',
      ),
    );
    const beforeCollision = prepared.sample(3.019);
    expect(beforeCollision).toMatchObject({ actionIndex: 3, pose: 'idle' });
    expect(beforeCollision.support).toBeCloseTo(4);
    expect(prepared.sample(3.02)).toMatchObject({ actionIndex: 4, support: 4, facing: 'left' });
    expect(prepared.sample(3.02 + 0.68 * 0.8)).toMatchObject({
      actionIndex: 4,
      support: 3.7,
      pose: 'impact',
      effect: 'impact',
      facing: 'left',
    });
    expect(prepared.sample(3.7)).toMatchObject({
      complete: true,
      support: 3.7,
      pose: 'impact',
      effect: 'impact',
    });
  });

  it('uses only the sampled elapsed time, even when frames were skipped', () => {
    const prepared = prepareReplay(publicReplayView(createClosedAttemptRecordFixture()));
    const firstRead = prepared.sample(1.15);
    prepared.sample(4.4);
    expect(prepared.sample(1.15)).toEqual(firstRead);
    expect(prepared.sample(Number.NaN)).toEqual(prepared.sample(0));
  });

  it('replays several published actions before an error closure without inventing a defeat', () => {
    const record = replayRecordForActions(
      [{ kind: 'advance' }, { kind: 'jump', direction: 'right' }, { kind: 'advance' }],
      'error',
    );
    const prepared = prepareReplay(record);
    expect(prepared.sample(0)).toMatchObject({ actionIndex: 0, closureStatus: 'error' });
    expect(prepared.sample(1.15)).toMatchObject({
      actionIndex: 1,
      pose: 'jump',
      closureStatus: 'error',
    });
    expect(prepared.sample(2.3)).toMatchObject({
      actionIndex: 2,
      closureStatus: 'error',
      complete: true,
      pose: 'idle',
      support: 3,
      effect: 'none',
    });
    expect(record.actions).toHaveLength(3);
    expect(record.score).toBeNull();
  });

  it('accepts an empty cancellation and rejects an incomplete or unsupported record explicitly', () => {
    const empty = prepareReplay(replayRecordForActions([]));
    expect(empty.duration).toBe(0);
    expect(empty.sample(0)).toMatchObject({
      complete: true,
      closureStatus: 'cancelled',
      pose: 'idle',
    });

    const cancelledAfterMovement = prepareReplay(replayRecordForActions([{ kind: 'advance' }]));
    expect(cancelledAfterMovement.sample(cancelledAfterMovement.duration)).toMatchObject({
      complete: true,
      closureStatus: 'cancelled',
      pose: 'idle',
      support: 1,
    });

    const incomplete = publicReplayView(createClosedAttemptRecordFixture());
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

    const unsupportedAction = {
      ...incomplete,
      actions: incomplete.actions.map((action, index) =>
        index === 0 ? { ...action, action: { kind: 'teleport' } as never } : action,
      ),
    };
    expect(() => prepareReplay(unsupportedAction)).toThrow('la acción 1 no está soportada');
  });

  it('shows a completed turn limit distinctly from a victory', () => {
    const prepared = prepareReplay(
      replayRecordForActions(
        Array.from({ length: 12 }, () => ({ kind: 'swim' as const })),
        'incomplete',
      ),
    );
    expect(prepared.sample(4.619)).toMatchObject({
      actionIndex: 10,
      closureStatus: 'incomplete',
      complete: false,
    });
    expect(prepared.sample(4.83)).toMatchObject({
      actionIndex: 11,
      closureStatus: 'incomplete',
      complete: false,
      pose: 'idle',
    });
    expect(prepared.sample(prepared.duration)).toMatchObject({
      actionIndex: 11,
      closureStatus: 'incomplete',
      complete: true,
      pose: 'idle',
      effect: 'none',
    });
  });
});
