// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClosedAttemptRecordFixture } from '../../../../shared/attempt.fixture.js';
import { LEVEL } from '../../../../shared/game.js';
import { prepareReplay } from './prepare.js';
import { ReplayScene } from './ReplayScene.js';
import { publicReplayView, replayRecordForActions } from './replay.test-support.js';

const publicFixture = () => publicReplayView(createClosedAttemptRecordFixture());

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
  it('preflights current symbols, transitions terrain together, follows seven segments, and completes after a time jump', async () => {
    const record = publicFixture();
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
    ).toEqual(['backdrop', 'terrain-back', 'rewards', 'robot', 'terrain-front']);
    expect(scene.querySelector('[data-object-id="recompensa-1"]')).not.toBeNull();
    expect(scene.querySelector('[data-terrain-symbol="barrier_low"]')).not.toBeNull();
    expect(scene.querySelector('[data-terrain-symbol="barrier_high"]')).toBeNull();
    expect(scene.querySelector('[data-terrain-art="platform-ground"]')).not.toBeNull();

    await nextFrame(1720);
    expect(scene.getAttribute('data-terrain-transition-progress')).toBe('0');
    await nextFrame(1830);
    expect(Number(scene.getAttribute('data-terrain-transition-progress'))).toBeCloseTo(0.5);
    expect(
      scene.querySelector('[data-terrain-symbol="barrier_low"]')?.getAttribute('opacity'),
    ).toBe('0.5');
    expect(
      scene.querySelector('[data-terrain-symbol="barrier_high"]')?.getAttribute('opacity'),
    ).toBe('0.5');
    const platform = scene.querySelector(
      '[data-replay-layer="terrain-back"] [data-segment-type="platform"]',
    );
    expect(
      [...platform!.querySelectorAll('[data-terrain-state]')].map((tile) =>
        tile.getAttribute('data-terrain-state'),
      ),
    ).toEqual(['ground', 'pit']);

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
        record={publicFixture()}
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

  it('keeps a terminal barrier collision on the before terrain without a transition', async () => {
    const record = replayRecordForActions(toLowBarrier, 'defeat');
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
    expect(scene.querySelector('[data-terrain-symbol="barrier_low"]')).not.toBeNull();
    expect(scene.querySelector('[data-terrain-symbol="barrier_high"]')).toBeNull();
    expect(scene.querySelector('[data-replay-layer="robot"] > g')?.getAttribute('data-pose')).toBe(
      'impact',
    );
  });
});
