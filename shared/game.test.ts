import { describe, expect, it } from 'vitest';
import { ROBOT_CATALOG } from './robot.js';
import {
  DEFAULT_SCORE_RULES,
  LEVEL,
  RULES_VERSION,
  calculateScore,
  createInitialState,
  effectiveTerrain,
  isSemanticallyValidActionResolution,
  normalizeSelection,
  observe,
  progressFor,
  resolveAction,
  scoreAttempt,
  type Direction,
  type GameSnapshot,
  type LevelDefinition,
  type LevelSegment,
  type NormalizedAction,
  type ResolvedAction,
  type TerrainState,
} from './game.js';

const segmentFor = (terrain: TerrainState): LevelSegment => {
  if (terrain === 'barrier_low' || terrain === 'barrier_high') {
    return {
      type: 'barrier',
      phases: ['barrier_low', 'barrier_high'],
      offset: terrain === 'barrier_low' ? 0 : 1,
    };
  }
  return { type: terrain };
};

const levelWith = (terrain: readonly TerrainState[], maxTurns = 16): LevelDefinition => ({
  id: `test-${terrain.join('-')}`,
  version: 1,
  rulesVersion: RULES_VERSION,
  maxTurns,
  segments: terrain.map(segmentFor),
  objects: [],
  exit: { support: terrain.length, requiredObjectIds: [] },
});

const stateAt = (
  level: LevelDefinition,
  support: number,
  overrides: Partial<
    Pick<GameSnapshot, 'turnsUsed' | 'phaseTurn' | 'status' | 'maxSupportReached'>
  > = {},
): GameSnapshot => {
  const phaseTurn = overrides.phaseTurn ?? 0;
  return {
    ...createInitialState(level),
    id: `fixture-${support}-${phaseTurn}`,
    support,
    phaseTurn,
    terrain: effectiveTerrain(level, phaseTurn),
    turnsUsed: overrides.turnsUsed ?? phaseTurn,
    status: overrides.status ?? 'running',
    maxSupportReached: overrides.maxSupportReached ?? support,
  };
};

const actionFor = (mode: 'walk' | 'jump' | 'crouch', direction: Direction): NormalizedAction => {
  if (mode === 'walk') return direction === 'right' ? { kind: 'advance' } : { kind: 'retreat' };
  return { kind: mode, direction };
};

const bothDirections = ['left', 'right'] as const;

describe('periodic deterministic game engine', () => {
  it('publishes one immutable seven-segment level and its turn-zero snapshot', () => {
    const initial = createInitialState();

    expect(RULES_VERSION).toBe(3);
    expect(LEVEL).toMatchObject({
      id: 'principal-recompensas-v3',
      version: 3,
      maxTurns: 16,
      exit: { support: 7, requiredObjectIds: [] },
    });
    expect(LEVEL.objects).toEqual([{ id: 'recompensa-1', support: 2, scoreValue: 25 }]);
    expect(LEVEL.segments).toEqual([
      { type: 'ground' },
      { type: 'pit' },
      { type: 'ground' },
      { type: 'branch' },
      { type: 'barrier', phases: ['barrier_low', 'barrier_high'], offset: 0 },
      { type: 'platform', phases: ['ground', 'pit', 'pit'], offset: 0 },
      { type: 'ground' },
    ]);
    expect(initial).toMatchObject({
      id: 'state-0',
      support: 0,
      turnsUsed: 0,
      phaseTurn: 0,
      terrain: ['ground', 'pit', 'ground', 'branch', 'barrier_low', 'ground', 'ground'],
      remainingObjects: ['recompensa-1'],
      inventory: [],
      exitEnabled: true,
      status: 'running',
    });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.terrain)).toBe(true);
    expect(Object.isFrozen(LEVEL)).toBe(true);
  });

  it('derives barrier parity and platform phases from turn and offset data', () => {
    const terrainAt = (turn: number) => effectiveTerrain(LEVEL, turn);

    expect([0, 1, 2, 3, 4].map((turn) => terrainAt(turn)[4])).toEqual([
      'barrier_low',
      'barrier_high',
      'barrier_low',
      'barrier_high',
      'barrier_low',
    ]);
    expect([0, 1, 2, 3, 4, 5].map((turn) => terrainAt(turn)[5])).toEqual([
      'ground',
      'pit',
      'pit',
      'ground',
      'pit',
      'pit',
    ]);

    const shifted: LevelDefinition = {
      ...LEVEL,
      segments: LEVEL.segments.map((segment) =>
        segment.type === 'barrier' ? { ...segment, offset: 1 } : segment,
      ),
    };
    expect(effectiveTerrain(shifted, 0)[4]).toBe('barrier_high');
    expect(effectiveTerrain(shifted, 1)[4]).toBe('barrier_low');
    expect(() => effectiveTerrain(LEVEL, -1)).toThrow(/non-negative integer/);
  });

  it('requires barrier phases to use a periodic segment descriptor', () => {
    const invalidStaticBarrier: LevelDefinition = {
      ...levelWith(['ground']),
      segments: [{ type: 'barrier_low' } as unknown as LevelSegment],
    };

    expect(() => createInitialState(invalidStaticBarrier)).toThrow(/invalid terrain type/);
  });

  it('rejects multiple selectable objects at the same support', () => {
    const ambiguousLevel: LevelDefinition = {
      ...LEVEL,
      objects: [...LEVEL.objects, { id: 'second-reward', support: 2, scoreValue: 5 }],
    };

    expect(() => createInitialState(ambiguousLevel)).toThrow(/invalid object/);
  });

  it.each([
    ['ground', 'walk', 'moved', 'moved'],
    ['ground', 'jump', 'moved', 'moved'],
    ['ground', 'crouch', 'moved', 'moved'],
    ['pit', 'walk', 'fall', 'walk_into_pit'],
    ['pit', 'jump', 'moved', 'moved'],
    ['pit', 'crouch', 'fall', 'crouch_into_pit'],
    ['branch', 'walk', 'collision', 'walk_into_branch'],
    ['branch', 'jump', 'collision', 'jump_into_branch'],
    ['branch', 'crouch', 'moved', 'moved'],
    ['barrier_low', 'walk', 'collision', 'walk_into_barrier'],
    ['barrier_low', 'jump', 'moved', 'moved'],
    ['barrier_low', 'crouch', 'collision', 'crouch_into_low_barrier'],
    ['barrier_high', 'walk', 'collision', 'walk_into_barrier'],
    ['barrier_high', 'jump', 'collision', 'jump_into_high_barrier'],
    ['barrier_high', 'crouch', 'moved', 'moved'],
  ] as const)(
    '%s resolves %s in both directions as %s with reason %s',
    (terrain, mode, outcome, reason) => {
      const level = levelWith([terrain, terrain, terrain]);
      for (const direction of bothDirections) {
        const result = resolveAction(stateAt(level, 1), actionFor(mode, direction), level);
        expect(result.resolution.outcome).toBe(outcome);
        expect('reason' in result.resolution ? result.resolution.reason : undefined).toBe(reason);
        if ('segment' in result.resolution) {
          expect(result.resolution.segment).toBe(direction === 'right' ? 1 : 0);
          expect(result.resolution.targetSupport).toBe(direction === 'right' ? 2 : 0);
        }
        expect(result.after.turnsUsed).toBe(1);
        expect(result.after.status).toBe(outcome === 'moved' ? 'running' : 'defeat');
      }
    },
  );

  it.each([
    [0, 'ground', 'walk', 'moved', 'moved'],
    [0, 'ground', 'jump', 'moved', 'moved'],
    [0, 'ground', 'crouch', 'moved', 'moved'],
    [1, 'pit', 'walk', 'fall', 'walk_into_pit'],
    [1, 'pit', 'jump', 'moved', 'moved'],
    [1, 'pit', 'crouch', 'fall', 'crouch_into_pit'],
  ] as const)(
    'platform descriptor at phase %i materializes as %s and resolves %s in both directions',
    (phaseTurn, terrain, mode, outcome, reason) => {
      for (const direction of bothDirections) {
        const platformIndex = direction === 'right' ? 1 : 0;
        const segments: LevelSegment[] = [
          { type: 'ground' },
          { type: 'ground' },
          { type: 'ground' },
        ];
        segments[platformIndex] = {
          type: 'platform',
          phases: ['ground', 'pit', 'pit'],
          offset: 0,
        };
        const level: LevelDefinition = {
          id: 'platform-test',
          version: 1,
          rulesVersion: RULES_VERSION,
          maxTurns: 16,
          segments,
          objects: [],
          exit: { support: 3, requiredObjectIds: [] },
        };
        const before = stateAt(level, 1, { phaseTurn, turnsUsed: phaseTurn });
        const result = resolveAction(before, actionFor(mode, direction), level);

        expect(before.terrain[platformIndex]).toBe(terrain);
        expect(result.resolution.outcome).toBe(outcome);
        expect('reason' in result.resolution ? result.resolution.reason : undefined).toBe(reason);
        expect(result.after.turnsUsed).toBe(phaseTurn + 1);
        expect(result.after.status).toBe(outcome === 'moved' ? 'running' : 'defeat');
      }
    },
  );

  it('resolves the seven-crossing route against each action-start phase', () => {
    const actions: readonly NormalizedAction[] = [
      { kind: 'advance' },
      { kind: 'jump', direction: 'right' },
      { kind: 'advance' },
      { kind: 'crouch', direction: 'right' },
      { kind: 'jump', direction: 'right' },
      { kind: 'jump', direction: 'right' },
      { kind: 'advance' },
    ];
    const results: ResolvedAction[] = [];
    let state = createInitialState();
    for (const action of actions) {
      const result = resolveAction(state, action);
      results.push(result);
      state = result.after;
    }

    expect(results.map((result) => result.resolution.outcome)).toEqual(Array(7).fill('moved'));
    expect(results.map((result) => result.before.id)).toEqual([
      'state-0',
      'state-1',
      'state-2',
      'state-3',
      'state-4',
      'state-5',
      'state-6',
    ]);
    expect(results.map((result) => result.after.id)).toEqual([
      'state-1',
      'state-2',
      'state-3',
      'state-4',
      'state-5',
      'state-6',
      'state-7',
    ]);
    expect(results[4]?.before.terrain[4]).toBe('barrier_low');
    expect(results[4]?.after.terrain[4]).toBe('barrier_high');
    expect(results[5]?.before.terrain[5]).toBe('pit');
    expect(results[5]?.after.terrain[5]).toBe('ground');
    expect(results.slice(1).every((result, index) => result.before === results[index]?.after)).toBe(
      true,
    );
    expect(state).toMatchObject({
      support: 7,
      maxSupportReached: 7,
      turnsUsed: 7,
      phaseTurn: 6,
      status: 'victory',
    });
    expect(progressFor(state)).toBe(1);
  });

  it('lets waiting advance the platform while the robot stays on a safe support', () => {
    const actions: readonly NormalizedAction[] = [
      { kind: 'advance' },
      { kind: 'jump', direction: 'right' },
      { kind: 'advance' },
      { kind: 'crouch', direction: 'right' },
      { kind: 'jump', direction: 'right' },
      { kind: 'wait' },
      { kind: 'advance' },
      { kind: 'advance' },
    ];
    let state = createInitialState();
    const results = actions.map((action) => {
      const result = resolveAction(state, action);
      state = result.after;
      return result;
    });
    const waiting = results[5];

    expect(waiting?.resolution).toEqual({ outcome: 'no_op', reason: 'wait' });
    expect(waiting?.before.support).toBe(5);
    expect(waiting?.after.support).toBe(5);
    expect(waiting?.before.terrain[5]).toBe('pit');
    expect(waiting?.after.terrain[5]).toBe('ground');
    expect(waiting?.after.phaseTurn).toBe(6);
    expect(state).toMatchObject({ status: 'victory', support: 7, turnsUsed: 8 });
  });

  it('counts wait as a no-op turn and freezes the phase at the turn limit', () => {
    const level = levelWith(['ground', 'ground'], 1);
    const initial = createInitialState(level);
    const result = resolveAction(initial, { kind: 'wait' }, level);

    expect(result.resolution).toEqual({ outcome: 'no_op', reason: 'wait' });
    expect(result.after).toMatchObject({
      support: 0,
      turnsUsed: 1,
      phaseTurn: 0,
      status: 'incomplete',
    });
    expect(result.after.terrain).toEqual(initial.terrain);
  });

  it.each([
    ['fatal', 'defeat', { kind: 'advance' } as const, ['pit'], 'walk_into_pit'],
    ['victory', 'victory', { kind: 'advance' } as const, ['ground'], 'moved'],
    ['no-op', 'incomplete', { kind: 'swim' } as const, ['ground'], 'swim_no_effect'],
    ['wait', 'incomplete', { kind: 'wait' } as const, ['ground'], 'wait'],
  ] as const)(
    'uses %s before the turn limit on the final action',
    (_name, status, action, terrain, reason) => {
      const level = levelWith(terrain, 1);
      const result = resolveAction(createInitialState(level), action, level);
      expect(result.after.status).toBe(status);
      expect('reason' in result.resolution ? result.resolution.reason : undefined).toBe(reason);
      expect(result.after.turnsUsed).toBe(1);
      expect(result.after.phaseTurn).toBe(0);
    },
  );

  it('advances the phase after every continuing action, including no-ops', () => {
    const level: LevelDefinition = {
      ...LEVEL,
      maxTurns: 16,
    };
    const result = resolveAction(createInitialState(level), { kind: 'wait' }, level);

    expect(result.after.status).toBe('running');
    expect(result.after.turnsUsed).toBe(1);
    expect(result.after.phaseTurn).toBe(1);
    expect(result.after.terrain[4]).toBe('barrier_high');
    expect(result.after.terrain[5]).toBe('pit');
  });

  it('keeps supports safe when periodic terrain changes behind the robot', () => {
    const atSupport = stateAt(LEVEL, 5, { phaseTurn: 5, turnsUsed: 5 });
    const waited = resolveAction(atSupport, { kind: 'wait' });

    expect(atSupport.terrain[4]).toBe('barrier_high');
    expect(waited.after.terrain[4]).toBe('barrier_low');
    expect(waited.after.support).toBe(5);
    expect(waited.after.status).toBe('running');
  });

  it('records distinct boundaries and never moves outside supports', () => {
    const level = levelWith(['ground', 'ground']);
    const left = resolveAction(createInitialState(level), { kind: 'retreat' }, level);
    const right = resolveAction(stateAt(level, level.exit.support), { kind: 'advance' }, level);

    expect(left.resolution).toEqual({ outcome: 'no_op', reason: 'left_boundary' });
    expect(left.after.support).toBe(0);
    expect(right.resolution).toEqual({ outcome: 'no_op', reason: 'right_boundary' });
    expect(right.after.support).toBe(level.exit.support);
  });

  it('rejects actions after terminal states and leaves the input snapshot unchanged', () => {
    const terminalLevel = levelWith(['ground'], 1);
    const initial = createInitialState(terminalLevel);
    const before = structuredClone(initial);
    const first = resolveAction(initial, { kind: 'advance' }, terminalLevel);

    expect(initial).toEqual(before);
    expect(() => resolveAction(first.after, { kind: 'advance' }, terminalLevel)).toThrow(
      /terminal/,
    );
  });

  it('projects only local observation fields, including the current barrier phase', () => {
    const initial = observe(createInitialState());
    const low = observe(stateAt(LEVEL, 4, { phaseTurn: 0, turnsUsed: 0 }));
    const high = observe(stateAt(LEVEL, 4, { phaseTurn: 1, turnsUsed: 1 }));
    const atExit = observe(
      stateAt(LEVEL, LEVEL.exit.support, {
        maxSupportReached: LEVEL.exit.support,
      }),
    );

    expect(initial).toEqual({
      here: { objects: [] },
      left: { kind: 'boundary' },
      right: { kind: 'segment', terrain: 'ground' },
    });
    expect(low.right).toEqual({ kind: 'segment', terrain: 'barrier_low' });
    expect(high.right).toEqual({ kind: 'segment', terrain: 'barrier_high' });
    expect(JSON.stringify(high)).not.toMatch(/phase|turn|support|position|inventory|status/i);
    expect(atExit).toEqual({
      here: { objects: [], exit: { enabled: true } },
      left: { kind: 'segment', terrain: 'ground' },
      right: { kind: 'boundary' },
    });
  });

  it('normalizes opaque catalog selections and requires an enabled no-argument wait tool', () => {
    const snapshot = ROBOT_CATALOG.map((entry) => ({
      id: entry.id,
      opaqueId: entry.opaqueId,
      enabled: entry.id !== 'swim' && entry.id !== 'wait' && entry.id !== 'collect',
    }));

    expect(normalizeSelection('tool_3', { direction: 'izquierda' }, snapshot)).toEqual({
      kind: 'jump',
      direction: 'left',
    });
    expect(() => normalizeSelection('tool_3', { direction: 'left' }, snapshot)).toThrow(
      /izquierda or derecha/,
    );
    expect(() => normalizeSelection('tool_5', {}, snapshot)).toThrow(/disabled/);
    expect(() => normalizeSelection('tool_6', {}, snapshot)).toThrow(/disabled/);
    expect(() => normalizeSelection('tool_7', {}, snapshot)).toThrow(/disabled/);
    const enabledWait = snapshot.map((entry) =>
      entry.id === 'wait' ? { ...entry, enabled: true } : entry,
    );
    expect(() => normalizeSelection('tool_6', { extra: true }, enabledWait)).toThrow(
      /takes no arguments/,
    );
    expect(normalizeSelection('tool_6', {}, enabledWait)).toEqual({ kind: 'wait' });
    const enabledCollect = snapshot.map((entry) =>
      entry.id === 'collect' ? { ...entry, enabled: true } : entry,
    );
    expect(() => normalizeSelection('tool_7', { extra: true }, enabledCollect)).toThrow(
      /takes no arguments/,
    );
    expect(normalizeSelection('tool_7', {}, enabledCollect)).toEqual({ kind: 'collect' });
  });

  it('observes only objects at the current support and collects one reward in place', () => {
    expect(observe(stateAt(LEVEL, 1)).here.objects).toEqual([]);
    expect(observe(stateAt(LEVEL, 2)).here.objects).toEqual(['recompensa-1']);

    const passedBy = resolveAction(stateAt(LEVEL, 1), { kind: 'jump', direction: 'right' });
    expect(passedBy.after.support).toBe(2);
    expect(passedBy.after.remainingObjects).toEqual(['recompensa-1']);
    expect(passedBy.after.inventory).toEqual([]);
    expect(observe(passedBy.after).here.objects).toEqual(['recompensa-1']);

    const pickup = resolveAction(stateAt(LEVEL, 2), { kind: 'collect' });
    expect(pickup.resolution).toEqual({ outcome: 'picked_up', objectId: 'recompensa-1' });
    expect(pickup.after).toMatchObject({
      support: 2,
      turnsUsed: 1,
      phaseTurn: 1,
      remainingObjects: [],
      inventory: ['recompensa-1'],
      status: 'running',
    });
    expect(observe(pickup.after).here.objects).toEqual([]);

    const repeated = resolveAction(pickup.after, { kind: 'collect' });
    expect(repeated.resolution).toEqual({ outcome: 'no_op', reason: 'no_object_here' });
    expect(repeated.after.inventory).toEqual(['recompensa-1']);
    expect(repeated.after.remainingObjects).toEqual([]);
    expect(repeated.after.phaseTurn).toBe(2);
  });

  it('preserves collected objects after moving away and returning', () => {
    let state = resolveAction(stateAt(LEVEL, 2), { kind: 'collect' }).after;
    state = resolveAction(state, { kind: 'jump', direction: 'left' }).after;
    state = resolveAction(state, { kind: 'jump', direction: 'right' }).after;

    expect(state.support).toBe(2);
    expect(state.inventory).toEqual(['recompensa-1']);
    expect(state.remainingObjects).toEqual([]);
    expect(observe(state).here.objects).toEqual([]);
  });

  it('validates final-turn pickups and rejects forged object transitions in replay data', () => {
    const before = stateAt(LEVEL, 2, {
      turnsUsed: LEVEL.maxTurns - 1,
      phaseTurn: LEVEL.maxTurns - 1,
    });
    const pickup = resolveAction(before, { kind: 'collect' });

    expect(pickup.after.status).toBe('incomplete');
    expect(pickup.after.phaseTurn).toBe(LEVEL.maxTurns - 1);
    expect(
      isSemanticallyValidActionResolution(
        pickup.action,
        pickup.before,
        pickup.after,
        pickup.resolution,
      ),
    ).toBe(true);
    expect(
      isSemanticallyValidActionResolution(pickup.action, pickup.before, pickup.after, {
        outcome: 'picked_up',
        objectId: 'invented-object',
      }),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        pickup.action,
        pickup.before,
        { ...pickup.after, remainingObjects: ['recompensa-1'] },
        pickup.resolution,
      ),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        pickup.action,
        pickup.before,
        { ...pickup.after, inventory: ['recompensa-1', 'recompensa-1'] },
        pickup.resolution,
      ),
    ).toBe(false);

    const emptySupport = resolveAction(createInitialState(), { kind: 'advance' }).after;
    const noOp = resolveAction(emptySupport, { kind: 'collect' });
    expect(noOp.resolution).toEqual({ outcome: 'no_op', reason: 'no_object_here' });
    expect(
      isSemanticallyValidActionResolution(noOp.action, noOp.before, noOp.after, noOp.resolution),
    ).toBe(true);
    expect(noOp.after.phaseTurn).toBe(2);
    expect(noOp.after.inventory).toEqual(noOp.before.inventory);
    expect(noOp.after.remainingObjects).toEqual(noOp.before.remainingObjects);
    expect(
      isSemanticallyValidActionResolution(noOp.action, noOp.before, noOp.after, {
        outcome: 'no_op',
        reason: 'wait',
      }),
    ).toBe(false);

    const moveOntoReward = resolveAction(emptySupport, {
      kind: 'jump',
      direction: 'right',
    });
    expect(
      isSemanticallyValidActionResolution(
        moveOntoReward.action,
        moveOntoReward.before,
        moveOntoReward.after,
        moveOntoReward.resolution,
      ),
    ).toBe(true);
    expect(
      isSemanticallyValidActionResolution(
        moveOntoReward.action,
        moveOntoReward.before,
        { ...moveOntoReward.after, maxSupportReached: 1 },
        moveOntoReward.resolution,
      ),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        moveOntoReward.action,
        moveOntoReward.before,
        { ...moveOntoReward.after, remainingObjects: [], inventory: ['recompensa-1'] },
        moveOntoReward.resolution,
      ),
    ).toBe(false);

    const initial = createInitialState();
    const initialCollect = resolveAction(initial, { kind: 'collect' });
    expect(initialCollect.resolution).toEqual({ outcome: 'no_op', reason: 'no_object_here' });
    expect(
      isSemanticallyValidActionResolution(
        initialCollect.action,
        initialCollect.before,
        initialCollect.after,
        initialCollect.resolution,
      ),
    ).toBe(true);
    expect(
      isSemanticallyValidActionResolution(
        initialCollect.action,
        initialCollect.before,
        { ...initialCollect.after, maxSupportReached: 7 },
        initialCollect.resolution,
      ),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        initialCollect.action,
        { ...initialCollect.before, maxSupportReached: 7 },
        initialCollect.after,
        initialCollect.resolution,
      ),
    ).toBe(false);
  });

  it('computes score, rounds fractions, preserves negative values, and withholds unknown usage', () => {
    const known = calculateScore({
      status: 'victory',
      turnsUsed: 5,
      collectedObjectIds: ['unused', 'unused'],
      gameTokens: 2500,
    });
    expect(known).toMatchObject({ score: 947.5, availability: 'available' });
    expect(DEFAULT_SCORE_RULES.objectValues).toEqual({ 'recompensa-1': 25 });
    expect(
      scoreAttempt({ status: 'defeat', turnsUsed: 1, collectedObjectIds: [], gameTokens: 1 }),
    ).toBeNull();
    expect(
      scoreAttempt({ status: 'victory', turnsUsed: 1, collectedObjectIds: [], gameTokens: null }),
    ).toBeNull();

    const negativeRules = {
      ...DEFAULT_SCORE_RULES,
      base: 0,
      turnWeight: 10,
      tokenWeight: 1,
      objectValues: { gem: 3.333 },
    };
    const negative = calculateScore(
      {
        status: 'victory',
        turnsUsed: 2,
        collectedObjectIds: ['gem', 'gem'],
        gameTokens: 100_123,
      },
      negativeRules,
    );
    expect(negative.score).toBe(-116.79);
    expect(negative.rules).toBe(negativeRules);
  });
});
