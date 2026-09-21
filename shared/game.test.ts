import { describe, expect, it } from 'vitest';
import { ROBOT_CATALOG } from './robot.js';
import {
  DEFAULT_SCORE_RULES,
  LEVEL,
  calculateScore,
  createInitialState,
  effectiveTerrain,
  normalizeSelection,
  observe,
  progressFor,
  resolveAction,
  scoreAttempt,
  type Direction,
  type GameSnapshot,
  type LevelDefinition,
  type NormalizedAction,
  type ResolvedAction,
  type TerrainState,
} from './game.js';

const levelWith = (terrain: readonly TerrainState[], maxTurns = 12): LevelDefinition => ({
  id: `test-${terrain.join('-')}`,
  version: 1,
  rulesVersion: 1,
  maxTurns,
  segments: terrain.map((type) => ({ type })),
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
    turnsUsed: overrides.turnsUsed ?? 0,
    status: overrides.status ?? 'running',
    maxSupportReached: overrides.maxSupportReached ?? support,
  };
};

describe('static deterministic game engine', () => {
  it.each([
    ['ground', 'walk', 'moved'],
    ['ground', 'jump', 'moved'],
    ['ground', 'crouch', 'moved'],
    ['pit', 'walk', 'fall'],
    ['pit', 'jump', 'moved'],
    ['pit', 'crouch', 'fall'],
    ['branch', 'walk', 'collision'],
    ['branch', 'jump', 'collision'],
    ['branch', 'crouch', 'moved'],
  ] as const)('%s resolves %s in both directions as %s', (terrain, mode, outcome) => {
    const level = levelWith([terrain, terrain, terrain]);
    const actionFor = (direction: Direction): NormalizedAction => {
      if (mode === 'walk') return direction === 'right' ? { kind: 'advance' } : { kind: 'retreat' };
      return { kind: mode, direction };
    };

    for (const direction of ['left', 'right'] as const) {
      const result = resolveAction(stateAt(level, 1), actionFor(direction), level);
      expect(result.resolution.outcome).toBe(outcome);
      expect('segment' in result.resolution).toBe(true);
      if ('segment' in result.resolution) {
        expect(result.resolution.segment).toBe(direction === 'right' ? 1 : 0);
        expect(result.resolution.targetSupport).toBe(direction === 'right' ? 2 : 0);
      }
      expect(result.after.turnsUsed).toBe(1);
      expect(result.after.status).toBe(outcome === 'moved' ? 'running' : 'defeat');
    }
  });

  it('publishes the approved immutable level and initial snapshot at turn zero', () => {
    const initial = createInitialState();

    expect(LEVEL.id).toBe('principal-estatico-v1');
    expect(LEVEL.segments.map((segment) => segment.type)).toEqual([
      'ground',
      'pit',
      'ground',
      'branch',
      'ground',
    ]);
    expect(initial).toMatchObject({
      id: 'state-0',
      support: 0,
      turnsUsed: 0,
      phaseTurn: 0,
      terrain: ['ground', 'pit', 'ground', 'branch', 'ground'],
      remainingObjects: [],
      inventory: [],
      exitEnabled: true,
      status: 'running',
    });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.terrain)).toBe(true);
    expect(Object.isFrozen(LEVEL)).toBe(true);
  });

  it('resolves the five-action reference chain and keeps chained snapshots consistent', () => {
    const actions: readonly NormalizedAction[] = [
      { kind: 'advance' },
      { kind: 'jump', direction: 'right' },
      { kind: 'advance' },
      { kind: 'crouch', direction: 'right' },
      { kind: 'advance' },
    ];
    const results: ResolvedAction[] = [];
    let state = createInitialState();
    for (const action of actions) {
      const result = resolveAction(state, action);
      results.push(result);
      state = result.after;
    }

    expect(results.map((result) => result.resolution.outcome)).toEqual([
      'moved',
      'moved',
      'moved',
      'moved',
      'moved',
    ]);
    expect(results.map((result) => result.before.id)).toEqual([
      'state-0',
      'state-1',
      'state-2',
      'state-3',
      'state-4',
    ]);
    expect(results.map((result) => result.after.id)).toEqual([
      'state-1',
      'state-2',
      'state-3',
      'state-4',
      'state-5',
    ]);
    expect(results.slice(1).every((result, index) => result.before === results[index].after)).toBe(
      true,
    );
    expect(state).toMatchObject({
      support: 5,
      maxSupportReached: 5,
      turnsUsed: 5,
      phaseTurn: 4,
      status: 'victory',
    });
    expect(progressFor(state)).toBe(1);
  });

  it.each([
    ['fatal', 'defeat', { kind: 'advance' } as const, ['pit'], 'walk_into_pit'],
    ['victory', 'victory', { kind: 'advance' } as const, ['ground'], 'moved'],
    ['no-op', 'incomplete', { kind: 'swim' } as const, ['ground'], 'swim_no_effect'],
  ] as const)(
    'uses %s before the turn limit on the final action',
    (_name, status, action, terrain, reason) => {
      const level = levelWith(terrain, 1);
      const result = resolveAction(createInitialState(level), action, level);
      expect(result.after.status).toBe(status);
      expect(result.resolution.reason).toBe(reason);
      expect(result.after.turnsUsed).toBe(1);
      expect(result.after.phaseTurn).toBe(0);
    },
  );

  it('advances phaseTurn only when play continues, including for no-ops', () => {
    const level = levelWith(['ground', 'ground']);
    const result = resolveAction(createInitialState(level), { kind: 'swim' }, level);

    expect(result.resolution).toEqual({ outcome: 'no_op', reason: 'swim_no_effect' });
    expect(result.after.status).toBe('running');
    expect(result.after.turnsUsed).toBe(1);
    expect(result.after.phaseTurn).toBe(1);
    expect(result.after.terrain).toEqual(['ground', 'ground']);
  });

  it('records distinct boundaries and never moves outside the supports', () => {
    const left = resolveAction(createInitialState(), { kind: 'retreat' });
    const right = resolveAction(stateAt(LEVEL, LEVEL.exit.support), { kind: 'advance' });

    expect(left.resolution).toEqual({ outcome: 'no_op', reason: 'left_boundary' });
    expect(left.after.support).toBe(0);
    expect(right.resolution).toEqual({ outcome: 'no_op', reason: 'right_boundary' });
    expect(right.after.support).toBe(LEVEL.exit.support);
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

  it('projects only local observation fields and keeps the exit local to the current support', () => {
    const initial = observe(createInitialState());
    const atExit = stateAt(LEVEL, LEVEL.exit.support, { maxSupportReached: LEVEL.exit.support });
    const exit = observe(atExit);

    expect(initial).toEqual({
      here: { objects: [] },
      left: { kind: 'boundary' },
      right: { kind: 'segment', terrain: 'ground' },
    });
    expect(exit).toEqual({
      here: { objects: [], exit: { enabled: true } },
      left: { kind: 'segment', terrain: 'ground' },
      right: { kind: 'boundary' },
    });
    expect(JSON.stringify(initial)).not.toMatch(
      /support|position|turn|inventory|metric|status|terrain.*\[/i,
    );
  });

  it('normalizes opaque catalog selections without semantic aliases or extra arguments', () => {
    const snapshot = ROBOT_CATALOG.map((entry) => ({
      id: entry.id,
      opaqueId: entry.opaqueId,
      enabled: entry.id !== 'swim',
    }));

    // Robot catalog direction schemas are Spanish by contract.
    expect(normalizeSelection('tool_3', { direction: 'izquierda' }, snapshot)).toEqual({
      kind: 'jump',
      direction: 'left',
    });
    expect(() => normalizeSelection('tool_3', { direction: 'left' }, snapshot)).toThrow(
      /izquierda or derecha/,
    );
    expect(() => normalizeSelection('tool_5', {}, snapshot)).toThrow(/disabled/);
    expect(() =>
      normalizeSelection('tool_3', { direction: 'derecha', extra: true }, snapshot),
    ).toThrow(/required/);
  });

  it('computes a known score, rounds fractions, preserves negative values, and withholds unknown usage', () => {
    const known = calculateScore({
      status: 'victory',
      turnsUsed: 5,
      collectedObjectIds: ['unused', 'unused'],
      gameTokens: 2500,
    });
    expect(known).toMatchObject({ score: 947.5, availability: 'available' });
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
