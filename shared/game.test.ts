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
  type LocalObservation,
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
  exit: { support: terrain.length },
});

const stateAt = (
  level: LevelDefinition,
  support: number,
  overrides: Partial<
    Pick<
      GameSnapshot,
      | 'facing'
      | 'turnsUsed'
      | 'phaseTurn'
      | 'status'
      | 'maxSupportReached'
      | 'remainingObjects'
      | 'inventory'
    >
  > = {},
): GameSnapshot => {
  const phaseTurn = overrides.phaseTurn ?? 0;
  const initial = createInitialState(level);
  return {
    ...initial,
    id: `fixture-${support}-${phaseTurn}`,
    support,
    facing: overrides.facing ?? initial.facing,
    phaseTurn,
    terrain: effectiveTerrain(level, phaseTurn),
    turnsUsed: overrides.turnsUsed ?? phaseTurn,
    status: overrides.status ?? 'running',
    maxSupportReached: overrides.maxSupportReached ?? support,
    remainingObjects: overrides.remainingObjects ?? initial.remainingObjects,
    inventory: overrides.inventory ?? initial.inventory,
  };
};

const actionFor = (mode: 'walk' | 'jump' | 'crouch', direction: Direction): NormalizedAction => {
  if (mode === 'walk') return direction === 'right' ? { kind: 'advance' } : { kind: 'retreat' };
  return { kind: mode, direction };
};

const bothDirections = ['left', 'right'] as const;

describe('periodic deterministic game engine', () => {
  it('publishes one immutable ten-segment level and its turn-zero snapshot', () => {
    const initial = createInitialState();

    expect(RULES_VERSION).toBe(4);
    expect(LEVEL).toMatchObject({
      id: 'principal-puerta-v4',
      version: 4,
      maxTurns: 24,
      door: { support: 9, requiredObjectId: 'llave-1' },
      exit: { support: 10 },
    });
    expect(LEVEL.objects).toEqual([
      { id: 'recompensa-1', support: 2, scoreValue: 25 },
      { id: 'llave-1', support: 6, scoreValue: 0 },
    ]);
    expect(LEVEL.segments).toEqual([
      { type: 'ground' },
      { type: 'pit' },
      { type: 'ground' },
      { type: 'branch' },
      { type: 'barrier', phases: ['barrier_low', 'barrier_high'], offset: 0 },
      { type: 'platform', phases: ['ground', 'pit', 'pit'], offset: 0 },
      { type: 'ground' },
      { type: 'ground' },
      { type: 'ground' },
      { type: 'ground' },
    ]);
    expect(initial).toMatchObject({
      id: 'state-0',
      support: 0,
      facing: 'right',
      turnsUsed: 0,
      phaseTurn: 0,
      terrain: [
        'ground',
        'pit',
        'ground',
        'branch',
        'barrier_low',
        'ground',
        'ground',
        'ground',
        'ground',
        'ground',
      ],
      remainingObjects: ['recompensa-1', 'llave-1'],
      inventory: [],
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

  it('validates the door support, required object, and unique object identities', () => {
    expect(() =>
      createInitialState({ ...LEVEL, door: { support: 0, requiredObjectId: 'llave-1' } }),
    ).toThrow(/invalid door/);
    expect(() =>
      createInitialState({ ...LEVEL, door: { support: 9, requiredObjectId: 'missing-key' } }),
    ).toThrow(/invalid door/);
    expect(() =>
      createInitialState({
        ...LEVEL,
        door: { support: LEVEL.exit.support, requiredObjectId: 'llave-1' },
      }),
    ).toThrow(/invalid door/);
    expect(() =>
      createInitialState({
        ...LEVEL,
        objects: [...LEVEL.objects, { id: 'llave-1', support: 7, scoreValue: 0 }],
      }),
    ).toThrow(/invalid object/);
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
        expect(result.after.facing).toBe(direction);
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
          exit: { support: 3 },
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

  it('reaches the closed door after crossing the original seven segments', () => {
    const actions: readonly NormalizedAction[] = [
      { kind: 'jump', direction: 'right' },
      { kind: 'jump', direction: 'right' },
      { kind: 'advance' },
      { kind: 'crouch', direction: 'right' },
      { kind: 'jump', direction: 'right' },
      { kind: 'jump', direction: 'right' },
      { kind: 'advance' },
      { kind: 'advance' },
    ];
    const results: ResolvedAction[] = [];
    let state = createInitialState();
    for (const action of actions) {
      const result = resolveAction(state, action);
      results.push(result);
      state = result.after;
    }

    expect(results.map((result) => result.resolution.outcome)).toEqual(Array(8).fill('moved'));
    expect(results.map((result) => result.before.id)).toEqual([
      'state-0',
      'state-1',
      'state-2',
      'state-3',
      'state-4',
      'state-5',
      'state-6',
      'state-7',
    ]);
    expect(results.map((result) => result.after.id)).toEqual([
      'state-1',
      'state-2',
      'state-3',
      'state-4',
      'state-5',
      'state-6',
      'state-7',
      'state-8',
    ]);
    expect(results[4]?.before.terrain[4]).toBe('barrier_low');
    expect(results[4]?.after.terrain[4]).toBe('barrier_high');
    expect(results[5]?.before.terrain[5]).toBe('pit');
    expect(results[5]?.after.terrain[5]).toBe('ground');
    expect(results.slice(1).every((result, index) => result.before === results[index]?.after)).toBe(
      true,
    );
    expect(state).toMatchObject({
      support: 8,
      maxSupportReached: 8,
      turnsUsed: 8,
      phaseTurn: 8,
      status: 'running',
    });
    expect(progressFor(state)).toBe(0.8);
  });

  it('rejects a running snapshot persisted beyond a locked door', () => {
    const pastLockedDoor = stateAt(LEVEL, 9, { turnsUsed: 9, phaseTurn: 9 });
    expect(() => resolveAction(pastLockedDoor, { kind: 'retreat' })).toThrow(/past a locked door/);

    const atDoorWithKey = stateAt(LEVEL, 9, {
      turnsUsed: 9,
      phaseTurn: 9,
      inventory: ['llave-1'],
      remainingObjects: ['recompensa-1'],
    });
    const validReturn = resolveAction(atDoorWithKey, { kind: 'retreat' });
    const forgedAfter = {
      ...validReturn.after,
      remainingObjects: ['recompensa-1', 'llave-1'],
      inventory: [],
    };
    expect(
      isSemanticallyValidActionResolution(
        validReturn.action,
        pastLockedDoor,
        forgedAfter,
        validReturn.resolution,
      ),
    ).toBe(false);
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
    expect(state).toMatchObject({ status: 'running', support: 7, turnsUsed: 8 });
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
    const right = resolveAction(
      stateAt(level, level.exit.support, { facing: 'left' }),
      { kind: 'advance' },
      level,
    );

    expect(left.resolution).toEqual({ outcome: 'no_op', reason: 'left_boundary' });
    expect(left.after.support).toBe(0);
    expect(left.after.facing).toBe('left');
    expect(right.resolution).toEqual({ outcome: 'no_op', reason: 'right_boundary' });
    expect(right.after.support).toBe(level.exit.support);
    expect(right.after.facing).toBe('right');
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
      facing: 'right',
      here: { objects: [] },
      left: { kind: 'boundary' },
      right: { kind: 'segment', terrain: 'ground' },
    });
    expect(low.right).toEqual({ kind: 'segment', terrain: 'barrier_low' });
    expect(high.right).toEqual({ kind: 'segment', terrain: 'barrier_high' });
    expect(JSON.stringify(high)).not.toMatch(/phase|turn|support|position|inventory|status/i);
    expect(atExit).toEqual({
      facing: 'right',
      here: { objects: [], exit: {} },
      left: { kind: 'segment', terrain: 'ground' },
      right: { kind: 'boundary' },
    });
  });

  it('shows the key only where it is and derives local door state from inventory', () => {
    expect(observe(stateAt(LEVEL, 6)).here.objects).toEqual(['llave-1']);
    expect(observe(stateAt(LEVEL, 7)).here.objects).toEqual([]);
    expect(observe(stateAt(LEVEL, 8)).right).toEqual({
      kind: 'door',
      state: 'locked',
      requiredObjectId: 'llave-1',
    });
    expect(observe(stateAt(LEVEL, 8)).here.objects).toEqual([]);

    const carryingKey = stateAt(LEVEL, 8, {
      inventory: ['llave-1'],
      remainingObjects: ['recompensa-1'],
    });
    expect(observe(carryingKey).right).toEqual({
      kind: 'door',
      state: 'open',
      requiredObjectId: 'llave-1',
    });
    expect(
      observe(
        stateAt(LEVEL, 9, {
          inventory: ['llave-1'],
          remainingObjects: ['recompensa-1'],
          turnsUsed: 9,
          phaseTurn: 9,
        }),
      ).left,
    ).toEqual({ kind: 'door', state: 'open', requiredObjectId: 'llave-1' });
    expect(observe(stateAt(LEVEL, 10)).here.exit).toEqual({});
  });

  it('distinguishes outbound and return observations at support 7 by facing alone', () => {
    const outbound = observe(stateAt(LEVEL, 7, { facing: 'right', turnsUsed: 7, phaseTurn: 7 }));
    const returning = observe(stateAt(LEVEL, 7, { facing: 'left', turnsUsed: 9, phaseTurn: 9 }));

    expect(outbound).toEqual({
      facing: 'right',
      here: { objects: [] },
      left: { kind: 'segment', terrain: 'ground' },
      right: { kind: 'segment', terrain: 'ground' },
    });
    expect({ ...outbound, facing: 'left' }).toEqual(returning);
  });

  it.each([
    { kind: 'advance' },
    { kind: 'jump', direction: 'right' },
    { kind: 'crouch', direction: 'right' },
  ] as const)('blocks $kind at a closed door and rejects forged door records', (action) => {
    const before = stateAt(LEVEL, 8, { facing: 'left', turnsUsed: 8, phaseTurn: 8 });
    const locked = resolveAction(before, action);

    expect(locked.resolution).toEqual({ outcome: 'no_op', reason: 'door_locked' });
    expect(locked.after).toMatchObject({
      support: 8,
      facing: 'right',
      turnsUsed: 9,
      phaseTurn: 9,
      inventory: [],
      status: 'running',
    });
    expect(
      isSemanticallyValidActionResolution(
        locked.action,
        locked.before,
        locked.after,
        locked.resolution,
      ),
    ).toBe(true);
    expect(
      isSemanticallyValidActionResolution(locked.action, locked.before, locked.after, {
        outcome: 'no_op',
        reason: 'right_boundary',
      }),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        locked.action,
        { ...locked.before, exitEnabled: true },
        locked.after,
        locked.resolution,
      ),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        locked.action,
        locked.before,
        { ...locked.after, facing: 'left' },
        locked.resolution,
      ),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        locked.action,
        locked.before,
        { ...locked.after, support: 9, maxSupportReached: 9 },
        { outcome: 'moved', reason: 'moved', segment: 8, targetSupport: 9 },
      ),
    ).toBe(false);

    const openBefore = stateAt(LEVEL, 8, {
      turnsUsed: 8,
      phaseTurn: 8,
      inventory: ['llave-1'],
      remainingObjects: ['recompensa-1'],
    });
    const open = resolveAction(openBefore, action);
    expect(open.resolution).toMatchObject({ outcome: 'moved', targetSupport: 9 });
    expect(
      isSemanticallyValidActionResolution(open.action, open.before, open.after, open.resolution),
    ).toBe(true);
    expect(
      isSemanticallyValidActionResolution(open.action, open.before, open.after, {
        outcome: 'no_op',
        reason: 'door_locked',
      }),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        open.action,
        open.before,
        { ...open.after, status: 'victory' },
        open.resolution,
      ),
    ).toBe(false);
  });

  it.each([false, true])(
    'returns for the key and wins at the exit within 24 turns (optional reward: %s)',
    (collectReward) => {
      const route: NormalizedAction[] = [
        { kind: 'jump', direction: 'right' },
        { kind: 'jump', direction: 'right' },
      ];
      if (collectReward) route.push({ kind: 'collect' });
      route.push(
        { kind: 'advance' },
        { kind: 'crouch', direction: 'right' },
        collectReward
          ? { kind: 'crouch', direction: 'right' }
          : { kind: 'jump', direction: 'right' },
        collectReward ? { kind: 'advance' } : { kind: 'jump', direction: 'right' },
        { kind: 'advance' },
        { kind: 'advance' },
      );
      let state = createInitialState();
      const resolved: ResolvedAction[] = [];
      const act = (action: NormalizedAction): ResolvedAction => {
        const result = resolveAction(state, action);
        expect(
          isSemanticallyValidActionResolution(
            result.action,
            result.before,
            result.after,
            result.resolution,
          ),
        ).toBe(true);
        resolved.push(result);
        state = result.after;
        return result;
      };

      route.forEach(act);
      expect(state.support).toBe(8);
      expect(state.inventory).toEqual(collectReward ? ['recompensa-1'] : []);
      expect(state.remainingObjects).toContain('llave-1');
      expect(observe(state).here.objects).toEqual([]);

      const locked = act({ kind: 'advance' });
      expect(locked.resolution).toEqual({ outcome: 'no_op', reason: 'door_locked' });
      expect(locked.after.support).toBe(8);
      expect(locked.after.phaseTurn).toBe(locked.before.phaseTurn + 1);

      expect(act({ kind: 'retreat' }).after.support).toBe(7);
      const atKey = act({ kind: 'retreat' }).after;
      expect(atKey.support).toBe(6);
      expect(atKey.facing).toBe('left');
      expect(observe(atKey).here.objects).toEqual(['llave-1']);
      expect(atKey.terrain[4]).toBe(collectReward ? 'barrier_low' : 'barrier_high');
      expect(atKey.terrain[5]).toBe(collectReward ? 'ground' : 'pit');

      expect(act({ kind: 'collect' }).resolution).toEqual({
        outcome: 'picked_up',
        objectId: 'llave-1',
      });
      expect(state.inventory).toContain('llave-1');
      expect(observe(state).here.objects).toEqual([]);

      act({ kind: 'advance' });
      act({ kind: 'advance' });
      expect(observe(state).right).toEqual({
        kind: 'door',
        state: 'open',
        requiredObjectId: 'llave-1',
      });
      const crossedDoor = act({ kind: 'advance' });
      expect(crossedDoor.after).toMatchObject({ support: 9, status: 'running' });
      expect(observe(state).left).toEqual({
        kind: 'door',
        state: 'open',
        requiredObjectId: 'llave-1',
      });
      expect(
        isSemanticallyValidActionResolution(
          crossedDoor.action,
          crossedDoor.before,
          { ...crossedDoor.after, status: 'victory' },
          crossedDoor.resolution,
        ),
      ).toBe(false);
      expect(act({ kind: 'advance' }).after).toMatchObject({
        support: 10,
        status: 'victory',
        turnsUsed: collectReward ? 17 : 16,
      });
      expect(resolved.at(-1)?.after.status).toBe('victory');
    },
  );

  it.each([false, true])(
    'solves from local observations with no action history (optional reward: %s)',
    (collectReward) => {
      const choose = (observation: LocalObservation): NormalizedAction => {
        const objects = observation.here.objects;
        if (collectReward && objects.includes('recompensa-1')) return { kind: 'collect' };
        if (observation.facing === 'left' && objects.includes('llave-1')) {
          return observation.left.kind === 'segment' && observation.left.terrain === 'pit'
            ? { kind: 'wait' }
            : { kind: 'collect' };
        }
        if (
          observation.facing === 'left' &&
          !objects.includes('llave-1') &&
          observation.left.kind === 'segment' &&
          observation.left.terrain === 'pit'
        ) {
          return { kind: 'advance' };
        }
        if (
          observation.facing === 'right' &&
          observation.right.kind === 'door' &&
          observation.right.state === 'locked'
        ) {
          return { kind: 'retreat' };
        }

        const direction = observation.facing;
        const side = direction === 'right' ? observation.right : observation.left;
        if (side.kind === 'boundary' || side.kind === 'door' || side.terrain === 'ground') {
          return direction === 'right' ? { kind: 'advance' } : { kind: 'retreat' };
        }
        if (side.terrain === 'pit' || side.terrain === 'barrier_low') {
          return { kind: 'jump', direction };
        }
        if (side.terrain === 'branch' || side.terrain === 'barrier_high') {
          return { kind: 'crouch', direction };
        }
        return direction === 'right' ? { kind: 'advance' } : { kind: 'retreat' };
      };

      let state = createInitialState();
      const actions: NormalizedAction[] = [];
      for (let turn = 0; turn < LEVEL.maxTurns && state.status === 'running'; turn += 1) {
        const action = choose(observe(state));
        const result = resolveAction(state, action);
        expect(
          isSemanticallyValidActionResolution(
            result.action,
            result.before,
            result.after,
            result.resolution,
          ),
        ).toBe(true);
        actions.push(action);
        state = result.after;
      }

      expect(state).toMatchObject({ status: 'victory', support: LEVEL.exit.support });
      expect(state.turnsUsed).toBeLessThanOrEqual(LEVEL.maxTurns);
      expect(state.inventory).toContain('llave-1');
      expect(state.inventory.includes('recompensa-1')).toBe(collectReward);
      expect(actions.some((action) => action.kind === 'retreat')).toBe(true);
      expect(actions.some((action) => action.kind === 'collect')).toBe(true);
    },
  );

  it('preserves victory, fatality, and incomplete precedence on turn 24', () => {
    const atDoor = stateAt(LEVEL, 8, { turnsUsed: 23, phaseTurn: 23 });
    const lockedOnFinalTurn = resolveAction(atDoor, { kind: 'advance' });
    expect(lockedOnFinalTurn.resolution).toEqual({ outcome: 'no_op', reason: 'door_locked' });
    expect(lockedOnFinalTurn.after).toMatchObject({
      support: 8,
      turnsUsed: 24,
      phaseTurn: 23,
      status: 'incomplete',
    });
    expect(
      isSemanticallyValidActionResolution(
        lockedOnFinalTurn.action,
        lockedOnFinalTurn.before,
        lockedOnFinalTurn.after,
        lockedOnFinalTurn.resolution,
      ),
    ).toBe(true);

    const atExit = stateAt(LEVEL, 9, {
      turnsUsed: 23,
      phaseTurn: 23,
      inventory: ['llave-1'],
      remainingObjects: ['recompensa-1'],
    });
    const lastTurnVictory = resolveAction(atExit, { kind: 'advance' });
    expect(lastTurnVictory.after).toMatchObject({
      support: 10,
      turnsUsed: 24,
      phaseTurn: 23,
      status: 'victory',
    });
    expect(
      isSemanticallyValidActionResolution(
        lastTurnVictory.action,
        lastTurnVictory.before,
        lastTurnVictory.after,
        lastTurnVictory.resolution,
      ),
    ).toBe(true);

    const atPit = stateAt(LEVEL, 1, { turnsUsed: 23, phaseTurn: 23 });
    const lastTurnFatality = resolveAction(atPit, { kind: 'advance' });
    expect(lastTurnFatality.after).toMatchObject({
      support: 1,
      turnsUsed: 24,
      phaseTurn: 23,
      status: 'defeat',
    });
    expect(
      isSemanticallyValidActionResolution(
        lastTurnFatality.action,
        lastTurnFatality.before,
        lastTurnFatality.after,
        lastTurnFatality.resolution,
      ),
    ).toBe(true);
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
    expect(passedBy.after.remainingObjects).toEqual(['recompensa-1', 'llave-1']);
    expect(passedBy.after.inventory).toEqual([]);
    expect(observe(passedBy.after).here.objects).toEqual(['recompensa-1']);

    const pickup = resolveAction(stateAt(LEVEL, 2), { kind: 'collect' });
    expect(pickup.resolution).toEqual({ outcome: 'picked_up', objectId: 'recompensa-1' });
    expect(pickup.after).toMatchObject({
      support: 2,
      turnsUsed: 1,
      phaseTurn: 1,
      remainingObjects: ['llave-1'],
      inventory: ['recompensa-1'],
      status: 'running',
    });
    expect(observe(pickup.after).here.objects).toEqual([]);

    const repeated = resolveAction(pickup.after, { kind: 'collect' });
    expect(repeated.resolution).toEqual({ outcome: 'no_op', reason: 'no_object_here' });
    expect(repeated.after.inventory).toEqual(['recompensa-1']);
    expect(repeated.after.remainingObjects).toEqual(['llave-1']);
    expect(repeated.after.phaseTurn).toBe(2);
  });

  it('preserves collected objects after moving away and returning', () => {
    let state = resolveAction(stateAt(LEVEL, 2), { kind: 'collect' }).after;
    state = resolveAction(state, { kind: 'jump', direction: 'left' }).after;
    state = resolveAction(state, { kind: 'jump', direction: 'right' }).after;

    expect(state.support).toBe(2);
    expect(state.inventory).toEqual(['recompensa-1']);
    expect(state.remainingObjects).toEqual(['llave-1']);
    expect(observe(state).here.objects).toEqual([]);
  });

  it('preserves facing through collect, wait, and swim actions', () => {
    let state = stateAt(LEVEL, 6, { facing: 'left', turnsUsed: 4, phaseTurn: 4 });
    for (const action of [{ kind: 'collect' }, { kind: 'wait' }, { kind: 'swim' }] as const) {
      const result = resolveAction(state, action);
      expect(result.after.facing).toBe('left');
      expect(
        isSemanticallyValidActionResolution(
          result.action,
          result.before,
          result.after,
          result.resolution,
        ),
      ).toBe(true);
      state = result.after;
    }
  });

  it('rejects legacy, invalid, and forged facing values in semantic records', () => {
    const initial = createInitialState();
    const move = resolveAction(initial, { kind: 'advance' });
    const legacyBefore: Record<string, unknown> = { ...move.before };
    delete legacyBefore.facing;

    expect(
      isSemanticallyValidActionResolution(move.action, legacyBefore, move.after, move.resolution),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        move.action,
        { ...move.before, facing: 'left' },
        move.after,
        move.resolution,
      ),
    ).toBe(false);
    expect(
      isSemanticallyValidActionResolution(
        move.action,
        move.before,
        { ...move.after, facing: 'forward' },
        move.resolution,
      ),
    ).toBe(false);
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
        { ...pickup.after, remainingObjects: ['recompensa-1', 'llave-1'] },
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
    expect(DEFAULT_SCORE_RULES.objectValues).toEqual({ 'recompensa-1': 25, 'llave-1': 0 });
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
