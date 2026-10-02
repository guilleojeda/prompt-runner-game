// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL, PREVIOUS_LEVEL } from '../../../../shared/game.js';
import { prepareReplay, REPLAY_TIMING } from './prepare.js';
import { CoursePreview, ReplayScene } from './ReplayScene.js';
import {
  doorVictoryActions,
  doorVictoryRecord,
  replayRecordForActions,
} from './replay.test-support.js';

const toLowBarrier = [
  { kind: 'advance' },
  { kind: 'jump', direction: 'right' },
  { kind: 'advance' },
  { kind: 'crouch', direction: 'right' },
  { kind: 'advance' },
] as const;

let pendingFrames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let svgSource: string;

const nextFrame = async (timestamp: number): Promise<void> => {
  const entry = pendingFrames.entries().next().value as [number, FrameRequestCallback] | undefined;
  if (!entry) throw new Error('there is no animation frame pending');
  pendingFrames.delete(entry[0]);
  await act(async () => entry[1](timestamp));
};

beforeEach(async () => {
  pendingFrames = new Map();
  nextFrameId = 0;
  svgSource = await readFile(`${process.cwd()}/apps/web/src/replay/art/replay-symbols.svg`, 'utf8');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => svgSource,
    })),
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    pendingFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingFrames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReplayScene', () => {
  it('shows a static full-course preview with the initial phase and every tile label', () => {
    render(<CoursePreview />);

    const preview = screen.getByRole('img', { name: /Recorrido completo desde la casilla 0/ });
    expect(preview.getAttribute('data-course-preview')).toBe('static');
    expect(preview.getAttribute('data-preview-phase')).toBe('0');
    expect(
      [...preview.querySelectorAll('[data-tile-number]')].map((tile) =>
        tile.getAttribute('data-tile-number'),
      ),
    ).toEqual(Array.from({ length: 11 }, (_, tile) => String(tile)));
    expect(preview.querySelector('[data-object-id="recompensa-1"]')).not.toBeNull();
    expect(preview.querySelector('[data-object-id="llave-1"]')).not.toBeNull();
    expect(preview.querySelector('[data-door-state="locked"]')).not.toBeNull();
    expect(
      preview.querySelector('[data-exit-state="free"][data-exit-support="10"]'),
    ).not.toBeNull();
    expect(preview.querySelector('[data-terrain-symbol="barrier_low"]')).not.toBeNull();
    expect(
      preview.querySelector('[data-segment-type="platform"]')?.getAttribute('data-terrain-state'),
    ).toBe('pit');
    expect(screen.getByText(/recompensa opcional de 25 puntos/)).toBeTruthy();
    expect(pendingFrames.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([PREVIOUS_LEVEL, LEVEL])(
    'preflights symbols, draws timing version $version faithfully, and completes',
    async (level) => {
      const record = doorVictoryRecord(level);
      const prepared = prepareReplay(record);
      const ready = vi.fn();
      const complete = vi.fn();
      const error = vi.fn();
      render(<ReplayScene record={record} onReady={ready} onComplete={complete} onError={error} />);

      expect(screen.getByRole('status').textContent).toContain('Preparando animación');
      await waitFor(() => expect(pendingFrames.size).toBe(1));
      expect(fetch).toHaveBeenCalledOnce();
      await nextFrame(1000);
      expect(ready).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();

      const scene = screen.getByRole('img');
      expect(scene.getAttribute('data-profile')).toBe(LEVEL.id);
      expect(scene.getAttribute('data-action-index')).toBe('0');
      expect(scene.querySelector('text')?.textContent).toBe(`Turno 1 / ${record.actions.length}`);
      expect(scene.getAttribute('data-camera-x')).toBe('0');
      expect(
        [...scene.querySelectorAll('[data-replay-layer]')].map((layer) =>
          layer.getAttribute('data-replay-layer'),
        ),
      ).toEqual(['backdrop', 'terrain-back', 'objects', 'robot', 'terrain-front']);
      expect(scene.querySelector('[data-object-id="recompensa-1"]')).not.toBeNull();
      expect(scene.querySelector('[data-object-id="llave-1"]')?.getAttribute('href')).toContain(
        '#key-object',
      );
      expect(
        scene.querySelector('[data-door-state="locked"]')?.getAttribute('data-door-support'),
      ).toBe('9');
      expect(
        scene.querySelector('[data-exit-state="free"]')?.getAttribute('data-exit-support'),
      ).toBe('10');
      expect(scene.querySelector('[data-terrain-symbol="barrier_low"]')).not.toBeNull();
      const tree = scene.querySelector('[data-terrain-symbol="branch-tree"]');
      const branch = scene.querySelector('[data-terrain-symbol="branch-front"]');
      expect(tree?.closest('[data-replay-layer]')?.getAttribute('data-replay-layer')).toBe(
        'terrain-back',
      );
      expect(branch?.closest('[data-replay-layer]')?.getAttribute('data-replay-layer')).toBe(
        'terrain-front',
      );
      expect(tree?.getAttribute('x')).toBe(branch?.getAttribute('x'));
      expect(tree?.getAttribute('y')).toBe(branch?.getAttribute('y'));
      expect(scene.querySelector('[data-terrain-symbol="barrier_high"]')).toBeNull();
      expect(
        scene.querySelector('[data-platform-angle]')?.getAttribute('data-platform-angle'),
      ).toBe(level.version === 4 ? '0' : '90');

      await nextFrame(1000 + REPLAY_TIMING.walk * 1000);
      expect(scene.getAttribute('data-terrain-transition-progress')).toBe('0');
      await nextFrame(1000 + (REPLAY_TIMING.walk + REPLAY_TIMING.phase / 2) * 1000);
      expect(Number(scene.getAttribute('data-terrain-transition-progress'))).toBeCloseTo(0.5);
      expect(scene.querySelectorAll('use[href$="#terrain-barrier-panel"]')).toHaveLength(1);
      expect(scene.querySelector('[data-barrier-y]')?.getAttribute('data-barrier-y')).toBe('196');
      expect(
        scene.querySelector('[data-platform-angle]')?.getAttribute('data-platform-angle'),
      ).toBe(level.version === 4 ? '45' : '90');
      const platform = scene.querySelector(
        '[data-replay-layer="terrain-back"] [data-segment-type="platform"]',
      );
      expect(platform?.getAttribute('data-terrain-state')).toBe(
        level.version === 4 ? 'ground' : 'pit',
      );

      await nextFrame(1000 + prepared.duration * 1000 + 3000);
      const completed = screen.getByRole('img');
      expect(completed.getAttribute('data-complete')).toBe('true');
      expect(completed.getAttribute('data-action-index')).toBe('');
      expect(Number(completed.getAttribute('data-camera-x'))).toBeGreaterThan(0);
      expect(completed.querySelector('text')?.textContent).toBe(
        `Turno ${record.actions.length} / ${record.actions.length}`,
      );
      expect(completed.querySelectorAll('use[href$="#effect-victory"]')).toHaveLength(1);
      expect(complete).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
      expect(pendingFrames.size).toBe(0);
    },
  );

  it.each([PREVIOUS_LEVEL, LEVEL])(
    'moves the same panel and hinged leaves in both directions for timing version $version',
    async (level) => {
      const record = replayRecordForActions(
        [{ kind: 'wait' }, { kind: 'wait' }, { kind: 'wait' }, { kind: 'wait' }],
        'cancelled',
        level,
      );
      render(
        <ReplayScene record={record} onReady={vi.fn()} onComplete={vi.fn()} onError={vi.fn()} />,
      );
      await waitFor(() => expect(pendingFrames.size).toBe(1));
      await nextFrame(1000);
      const scene = screen.getByRole('img');
      const old = level.version === 4;
      const cycle = REPLAY_TIMING.noOp + REPLAY_TIMING.phase;
      const middle = REPLAY_TIMING.noOp + REPLAY_TIMING.phase / 2;
      const checkpoints = [
        [0, 224, old ? 0 : 90],
        [middle, 196, old ? 45 : 90],
        [cycle, 168, 90],
        [cycle + middle, 196, old ? 90 : 45],
        [cycle * 2, 224, old ? 90 : 0],
        [cycle * 2 + middle, 196, 45],
        [cycle * 3, 168, old ? 0 : 90],
      ];
      for (const [elapsed, y, angle] of checkpoints) {
        if (elapsed !== 0) await nextFrame(1000 + elapsed! * 1000);
        const panel = scene.querySelector('[data-barrier-y]');
        expect(Number(panel?.getAttribute('data-barrier-y'))).toBeCloseTo(y!);
        expect(
          Number(scene.querySelector('[data-platform-angle]')?.getAttribute('data-platform-angle')),
        ).toBeCloseTo(angle!);
        expect(scene.querySelectorAll('use[href$="#terrain-barrier-panel"]')).toHaveLength(1);
        expect(scene.querySelectorAll('use[href$="#terrain-bridge-leaf"]')).toHaveLength(2);
        expect(panel?.getAttribute('opacity')).toBeNull();
        const leaves = scene.querySelectorAll('[data-platform-leaf]');
        expect(leaves[0]?.getAttribute('transform')).toContain('translate(710 250)');
        expect(leaves[1]?.getAttribute('transform')).toContain('translate(770 250) scale(-1 1)');
        expect(
          scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-center-x'),
        ).toBe('80');
      }
    },
  );

  it('keeps a closed-door gesture at support 8 and opens the door at the key pickup marker', async () => {
    const record = doorVictoryRecord();
    const prepared = prepareReplay(record);
    const durationOf = (action: (typeof record.actions)[number]): number => {
      const actionDuration =
        action.action.kind === 'collect'
          ? REPLAY_TIMING.collect
          : action.resolution.outcome === 'fall'
            ? REPLAY_TIMING.fall
            : action.resolution.outcome === 'collision'
              ? REPLAY_TIMING.impact
              : action.resolution.outcome === 'no_op'
                ? REPLAY_TIMING.noOp
                : action.action.kind === 'jump'
                  ? REPLAY_TIMING.jump
                  : action.action.kind === 'crouch'
                    ? REPLAY_TIMING.crouch
                    : REPLAY_TIMING.walk;
      return (
        actionDuration +
        (action.after.status === 'running' &&
        JSON.stringify(action.before.terrain) !== JSON.stringify(action.after.terrain)
          ? REPLAY_TIMING.phase
          : 0)
      );
    };
    const blockedStart = record.actions
      .slice(0, 9)
      .reduce((sum, action) => sum + durationOf(action), 0);
    const keyPickupIndex = record.actions.findIndex(
      (action) =>
        action.resolution.outcome === 'picked_up' && action.resolution.objectId === 'llave-1',
    );
    const keyPickupStart = record.actions
      .slice(0, keyPickupIndex)
      .reduce((sum, action) => sum + durationOf(action), 0);
    const blockedSamples = [0.05, 0.21, 0.4].map((offset) =>
      prepared.sample(blockedStart + offset),
    );
    const ready = vi.fn();
    const error = vi.fn();
    render(<ReplayScene record={record} onReady={ready} onComplete={vi.fn()} onError={error} />);
    await waitFor(() => expect(pendingFrames.size).toBe(1));
    await nextFrame(1000);
    const scene = screen.getByRole('img');

    await nextFrame(1000 + (blockedStart + 0.21) * 1000);
    const blockedRobot = scene.querySelector('[data-replay-layer="robot"] > g');
    expect(
      blockedSamples.map(({ support, drop, effect, doorState }) => ({
        support,
        drop,
        effect,
        doorState,
      })),
    ).toEqual([
      { support: 8, drop: 0, effect: 'none', doorState: 'locked' },
      { support: 8, drop: 0, effect: 'none', doorState: 'locked' },
      { support: 8, drop: 0, effect: 'none', doorState: 'locked' },
    ]);
    expect(blockedRobot?.getAttribute('data-center-x')).toBe(String(80 + 8 * 120));
    expect(scene.querySelector('[data-effect="impact"], [data-effect="victory"]')).toBeNull();
    expect(scene.querySelector('[data-door-state="locked"]')).not.toBeNull();

    await nextFrame(1000 + (keyPickupStart + REPLAY_TIMING.collect * 0.69) * 1000);
    expect(scene.querySelector('[data-door-state="locked"]')).not.toBeNull();
    expect(scene.querySelector('[data-object-id="llave-1"]')).not.toBeNull();
    await nextFrame(1000 + (keyPickupStart + REPLAY_TIMING.collect * 0.71) * 1000);
    expect(scene.querySelector('[data-door-state="open"]')).not.toBeNull();
    expect(scene.querySelector('[data-object-id="llave-1"]')).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('renders wait without moving or changing facing, then shows the recorded phase', async () => {
    const record = replayRecordForActions([{ kind: 'advance' }, { kind: 'wait' }]);
    render(
      <ReplayScene record={record} onReady={vi.fn()} onComplete={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() => expect(pendingFrames.size).toBe(1));
    await nextFrame(1000);
    await nextFrame(
      1000 + (REPLAY_TIMING.walk + REPLAY_TIMING.phase + REPLAY_TIMING.noOp / 2) * 1000,
    );

    const duringWait = screen.getByRole('img');
    const robotDuringWait = duringWait.querySelector('[data-replay-layer="robot"] > g');
    expect(duringWait.getAttribute('data-action-index')).toBe('1');
    expect(robotDuringWait?.getAttribute('data-pose')).toBe('idle');
    expect(robotDuringWait?.getAttribute('data-facing')).toBe('right');
    expect(robotDuringWait?.getAttribute('data-center-x')).toBe(String(80 + 120));
    expect(duringWait.getAttribute('data-terrain-transition-progress')).toBe('');

    await nextFrame(1000 + (REPLAY_TIMING.walk + REPLAY_TIMING.phase + REPLAY_TIMING.noOp) * 1000);
    expect(
      Number(screen.getByRole('img').getAttribute('data-terrain-transition-progress')),
    ).toBeCloseTo(0);
    const duration = prepareReplay(record).duration;
    await nextFrame(1000 + duration * 1000 + 10);
    expect(screen.getByRole('img').getAttribute('data-complete')).toBe('true');
    expect(
      screen
        .getByRole('img')
        .querySelector('[data-replay-layer="robot"] > g')
        ?.getAttribute('data-facing'),
    ).toBe('right');
  });

  it('removes the recorded reward at its pickup marker during the gesture', async () => {
    const record = replayRecordForActions([
      { kind: 'advance' },
      { kind: 'jump', direction: 'right' },
      { kind: 'collect' },
    ]);
    render(
      <ReplayScene record={record} onReady={vi.fn()} onComplete={vi.fn()} onError={vi.fn()} />,
    );
    await waitFor(() => expect(pendingFrames.size).toBe(1));
    await nextFrame(1000);

    const scene = screen.getByRole('img');
    expect(scene.querySelector('[data-object-id="recompensa-1"]')).not.toBeNull();
    const pickupStart =
      REPLAY_TIMING.walk + REPLAY_TIMING.phase + REPLAY_TIMING.jump + REPLAY_TIMING.phase;
    await nextFrame(1000 + (pickupStart + REPLAY_TIMING.collect * 0.69) * 1000);
    expect(scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-pose')).toBe(
      'collect',
    );
    expect(scene.querySelector('[data-object-id="recompensa-1"]')).not.toBeNull();
    expect(scene.querySelector('[data-effect="pickup"]')).toBeNull();

    await nextFrame(1000 + (pickupStart + REPLAY_TIMING.collect * 0.72) * 1000);
    expect(scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-pose')).toBe(
      'collect',
    );
    expect(scene.querySelector('[data-object-id="recompensa-1"]')).toBeNull();
    expect(scene.querySelector('[data-effect="pickup"]')).not.toBeNull();

    await nextFrame(1000 + (pickupStart + REPLAY_TIMING.collect + 0.001) * 1000);
    expect(scene.querySelector('[data-object-id="recompensa-1"]')).toBeNull();
    expect(scene.querySelector('[data-effect="pickup"]')).toBeNull();
    expect(Number(scene.getAttribute('data-terrain-transition-progress'))).toBeGreaterThan(0);
  });

  it('reports a missing current artwork symbol before starting the replay', async () => {
    svgSource = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="robot-idle" /></svg>';
    const ready = vi.fn();
    const complete = vi.fn();
    const error = vi.fn();
    render(
      <ReplayScene
        record={doorVictoryRecord()}
        onReady={ready}
        onComplete={complete}
        onError={error}
      />,
    );

    expect((await screen.findByRole('alert')).textContent).toContain('catálogo gráfico actual');
    expect(error).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(pendingFrames.size).toBe(0);
  });

  it.each(['right', 'left'] as const)(
    'shows a branch collision at the overhanging limb when approaching %s',
    async (direction) => {
      const actions =
        direction === 'right'
          ? ([...toLowBarrier.slice(0, 3), { kind: 'advance' }] as const)
          : ([...toLowBarrier.slice(0, 4), { kind: 'retreat' }] as const);
      const record = replayRecordForActions(actions, 'defeat');
      const prepared = prepareReplay(record);
      render(
        <ReplayScene record={record} onReady={vi.fn()} onComplete={vi.fn()} onError={vi.fn()} />,
      );
      await waitFor(() => expect(pendingFrames.size).toBe(1));
      await nextFrame(1000);
      await nextFrame(1000 + prepared.duration * 1000);

      const scene = screen.getByRole('img');
      expect(scene.getAttribute('data-closure-status')).toBe('defeat');
      expect(scene.querySelector('[data-terrain-symbol="branch-front"]')).not.toBeNull();
      const impact = scene.querySelector('[data-effect="impact"]');
      expect(impact?.getAttribute('x')).toBe(direction === 'right' ? '459' : '507');
      expect(impact?.getAttribute('y')).toBe('168');
      expect(
        scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-center-x'),
      ).toBe(direction === 'right' ? '476' : '524');
    },
  );

  it.each([
    { state: 'barrier_low', left: false, actions: toLowBarrier },
    {
      state: 'barrier_high',
      left: false,
      actions: [...toLowBarrier.slice(0, 4), { kind: 'wait' }, { kind: 'advance' }] as const,
    },
    {
      state: 'barrier_low',
      left: true,
      actions: [...doorVictoryActions.slice(0, 6), { kind: 'retreat' }] as const,
    },
    {
      state: 'barrier_high',
      left: true,
      actions: [...doorVictoryActions.slice(0, 6), { kind: 'wait' }, { kind: 'retreat' }] as const,
    },
  ])(
    'aligns a terminal $state collision with the panel, approaching from left=$left',
    async ({ state, left, actions }) => {
      const record = replayRecordForActions(actions, 'defeat');
      const duration = prepareReplay(record).duration;
      render(
        <ReplayScene record={record} onReady={vi.fn()} onComplete={vi.fn()} onError={vi.fn()} />,
      );
      await waitFor(() => expect(pendingFrames.size).toBe(1));
      await nextFrame(1000);
      await nextFrame(1000 + duration * 1000);

      const scene = screen.getByRole('img');
      expect(scene.getAttribute('data-complete')).toBe('true');
      expect(scene.getAttribute('data-closure-status')).toBe('defeat');
      expect(scene.getAttribute('data-terrain-transition-progress')).toBe('');
      expect(scene.querySelector(`[data-terrain-symbol="${state}"]`)).not.toBeNull();
      expect(scene.querySelectorAll('use[href$="#terrain-barrier-panel"]')).toHaveLength(1);
      const impact = scene.querySelector('[data-effect="impact"]');
      expect(impact?.getAttribute('x')).toBe(left ? '633' : '573');
      expect(impact?.getAttribute('y')).toBe(state === 'barrier_low' ? '218' : '162');
      expect(
        scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-center-x'),
      ).toBe(left ? '669' : '571');
      expect(
        scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-pose'),
      ).toBe('impact');
    },
  );
});
