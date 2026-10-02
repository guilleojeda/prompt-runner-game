// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL, PREVIOUS_LEVEL } from '../../../../shared/game.js';
import { prepareReplay } from './prepare.js';
import { ReplayScene } from './ReplayScene.js';
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
      expect(scene.querySelector('[data-terrain-symbol="barrier_high"]')).toBeNull();
      expect(
        scene.querySelector('[data-platform-angle]')?.getAttribute('data-platform-angle'),
      ).toBe(level.version === 4 ? '0' : '90');

      await nextFrame(1720);
      expect(scene.getAttribute('data-terrain-transition-progress')).toBe('0');
      await nextFrame(1830);
      expect(Number(scene.getAttribute('data-terrain-transition-progress'))).toBeCloseTo(0.5);
      expect(scene.querySelectorAll('use[href$="#terrain-barrier-panel"]')).toHaveLength(1);
      expect(scene.querySelector('[data-barrier-y]')?.getAttribute('data-barrier-y')).toBe('199');
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
      const checkpoints = [
        [1000, 224, old ? 0 : 90],
        [1530, 199, old ? 45 : 90],
        [1640, 174, 90],
        [2170, 199, old ? 90 : 45],
        [2281, 224, old ? 90 : 0],
        [2810, 199, 45],
        [2921, 174, old ? 0 : 90],
      ];
      for (const [timestamp, y, angle] of checkpoints) {
        if (timestamp !== 1000) await nextFrame(timestamp!);
        const panel = scene.querySelector('[data-barrier-y]');
        expect(Number(panel?.getAttribute('data-barrier-y'))).toBeCloseTo(y!);
        expect(
          Number(scene.querySelector('[data-platform-angle]')?.getAttribute('data-platform-angle')),
        ).toBeCloseTo(angle!);
        expect(scene.querySelectorAll('use[href$="#terrain-barrier-panel"]')).toHaveLength(1);
        expect(scene.querySelectorAll('use[href$="#terrain-bridge-leaf"]')).toHaveLength(2);
        expect(panel?.getAttribute('opacity')).toBeNull();
        const leaves = scene.querySelectorAll('[data-platform-leaf]');
        expect(leaves[0]?.getAttribute('transform')).toContain('translate(704 250)');
        expect(leaves[1]?.getAttribute('transform')).toContain('translate(776 250) scale(-1 1)');
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
        action.resolution.outcome === 'fall'
          ? 1.08
          : action.resolution.outcome === 'collision'
            ? 0.68
            : action.resolution.outcome === 'no_op'
              ? 0.42
              : action.action.kind === 'collect'
                ? 0.9
                : action.action.kind === 'jump'
                  ? 0.86
                  : 0.72;
      return (
        actionDuration +
        (action.after.status === 'running' &&
        JSON.stringify(action.before.terrain) !== JSON.stringify(action.after.terrain)
          ? 0.22
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

    await nextFrame(1000 + (keyPickupStart + 0.62) * 1000);
    expect(scene.querySelector('[data-door-state="locked"]')).not.toBeNull();
    expect(scene.querySelector('[data-object-id="llave-1"]')).not.toBeNull();
    await nextFrame(1000 + (keyPickupStart + 0.64) * 1000);
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
    await nextFrame(2150);

    const duringWait = screen.getByRole('img');
    const robotDuringWait = duringWait.querySelector('[data-replay-layer="robot"] > g');
    expect(duringWait.getAttribute('data-action-index')).toBe('1');
    expect(robotDuringWait?.getAttribute('data-pose')).toBe('idle');
    expect(robotDuringWait?.getAttribute('data-facing')).toBe('right');
    expect(robotDuringWait?.getAttribute('data-center-x')).toBe(String(80 + 120));
    expect(duringWait.getAttribute('data-terrain-transition-progress')).toBe('');

    await nextFrame(2360);
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
    const pickupStart = 0.72 + 0.22 + 0.86 + 0.22;
    await nextFrame(1000 + (pickupStart + 0.62) * 1000);
    expect(scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-pose')).toBe(
      'collect',
    );
    expect(scene.querySelector('[data-object-id="recompensa-1"]')).not.toBeNull();
    expect(scene.querySelector('[data-effect="pickup"]')).toBeNull();

    await nextFrame(1000 + (pickupStart + 0.72) * 1000);
    expect(scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-pose')).toBe(
      'collect',
    );
    expect(scene.querySelector('[data-object-id="recompensa-1"]')).toBeNull();
    expect(scene.querySelector('[data-effect="pickup"]')).not.toBeNull();

    await nextFrame(1000 + (pickupStart + 0.901) * 1000);
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
      expect(impact?.getAttribute('x')).toBe(left ? '642' : '564');
      expect(impact?.getAttribute('y')).toBe(state === 'barrier_low' ? '218' : '168');
      expect(
        scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-center-x'),
      ).toBe(left ? '678' : '562');
      expect(
        scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-pose'),
      ).toBe('impact');
    },
  );
});
