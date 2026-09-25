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

export const doorVictoryActions: readonly NormalizedAction[] = Object.freeze([
  { kind: 'advance' },
  { kind: 'jump', direction: 'right' },
  { kind: 'collect' },
  { kind: 'advance' },
  { kind: 'crouch', direction: 'right' },
  { kind: 'crouch', direction: 'right' },
  { kind: 'jump', direction: 'right' },
  { kind: 'advance' },
  { kind: 'advance' },
  { kind: 'advance' },
  { kind: 'retreat' },
  { kind: 'retreat' },
  { kind: 'collect' },
  { kind: 'advance' },
  { kind: 'advance' },
  { kind: 'advance' },
  { kind: 'advance' },
]);

export const publicReplayView = (record: AttemptRecord): ReplayRecordView => {
  const states = new Map(record.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const actions: AttemptRecordView['actions'] = record.actions.map((action) => {
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
    actions,
    closure: record.closure,
    metrics: record.metrics,
    score: record.score,
  };
};

export const replayRecordForActions = (
  actions: readonly NormalizedAction[],
  closureStatus: AttemptRecord['closure']['status'] = 'cancelled',
): ReplayRecordView => {
  const source = createClosedAttemptRecordFixture();
  const initial = createInitialState(source.config.level);
  const results = [];
  let current = initial;
  for (const action of actions) {
    const result = resolveAction(current, action, source.config.level);
    results.push(result);
    current = result.after;
  }
  const snapshots = [initial, ...results.map((result) => result.after)];
  const recordedActions = results.map((result, index) => ({
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
    snapshots,
    actions: recordedActions,
    closure: {
      status: closureStatus,
      actionCount: actions.length,
      finalStateId: current.id,
      recordComplete: true,
    },
    metrics: { ...source.metrics, calls: actions.length },
    score: null,
  };
  return publicReplayView(record);
};

export const doorVictoryRecord = (): ReplayRecordView =>
  replayRecordForActions(doorVictoryActions, 'victory');
