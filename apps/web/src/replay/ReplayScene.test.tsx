// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClosedAttemptRecordFixture } from '../../../../shared/attempt.fixture.js';
import { prepareReplay } from './prepare.js';
import { ReplayScene } from './ReplayScene.js';
import { publicReplayView, replayRecordForActions } from './replay.test-support.js';

const publicFixture = () => publicReplayView(createClosedAttemptRecordFixture());

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
  it('preflights the actual SVG symbols and calls completion after a time jump to the final frame', async () => {
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

    expect(screen.getByRole('status').textContent).toContain('Preparando animación');
    await waitFor(() => expect(pendingFrames.size).toBe(1));
    expect(fetch).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();

    await nextFrame(1000);
    expect(ready).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    const scene = screen.getByRole('img');
    expect(scene.getAttribute('data-action-index')).toBe('0');
    expect(
      [...scene.querySelectorAll('[data-replay-layer]')].map((layer) =>
        layer.getAttribute('data-replay-layer'),
      ),
    ).toEqual(['backdrop', 'terrain-back', 'robot', 'terrain-front']);
    expect(
      scene.querySelector('[data-replay-layer="terrain-front"] use[href$="#terrain-pit-edge"]'),
    ).not.toBeNull();
    expect(
      scene.querySelector('[data-replay-layer="terrain-front"] use[href$="#terrain-branch-front"]'),
    ).not.toBeNull();
    const standingRobot = scene.querySelector('[data-replay-layer="robot"] > g');
    expect(standingRobot?.getAttribute('data-facing')).toBe('right');
    expect(standingRobot?.getAttribute('data-pose')).toBe('step-a');

    const durationMs = prepareReplay(publicFixture()).duration * 1000;
    await nextFrame(1000 + durationMs + 3500);
    const completedScene = screen.getByRole('img');
    expect(completedScene.getAttribute('data-complete')).toBe('true');
    expect(completedScene.querySelectorAll('use[href$="#effect-victory"]')).toHaveLength(1);
    expect(complete).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(pendingFrames.size).toBe(0);
  });

  it('reports an absent artwork symbol and never starts the replay', async () => {
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

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Faltan símbolos del perfil visual v1',
    );
    expect(error).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(pendingFrames.size).toBe(0);
  });

  it('renders a left jump with the mirrored master sprite', async () => {
    const record = replayRecordForActions([
      { kind: 'advance' },
      { kind: 'jump', direction: 'right' },
      { kind: 'jump', direction: 'left' },
    ]);
    const ready = vi.fn();
    render(<ReplayScene record={record} onReady={ready} onComplete={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(pendingFrames.size).toBe(1));
    await nextFrame(1000);
    await nextFrame(3010);

    const scene = screen.getByRole('img');
    expect(scene.getAttribute('data-action-index')).toBe('2');
    const robot = scene.querySelector('[data-replay-layer="robot"] > g');
    expect(robot?.getAttribute('data-pose')).toBe('jump');
    expect(robot?.getAttribute('data-facing')).toBe('left');
    expect(robot?.getAttribute('transform')).toContain('scale(-0.62 0.62)');
    expect(ready).toHaveBeenCalledOnce();
  });

  it('plays several recorded actions before an error closure and reports the last frame', async () => {
    const record = replayRecordForActions(
      [{ kind: 'advance' }, { kind: 'jump', direction: 'right' }, { kind: 'advance' }],
      'error',
    );
    const ready = vi.fn();
    const complete = vi.fn();
    const error = vi.fn();
    render(<ReplayScene record={record} onReady={ready} onComplete={complete} onError={error} />);
    await waitFor(() => expect(pendingFrames.size).toBe(1));
    await nextFrame(0);
    await nextFrame(1150);
    expect(screen.getByRole('img').getAttribute('data-action-index')).toBe('1');
    expect(
      screen
        .getByRole('img')
        .querySelector('[data-replay-layer="robot"] > g')
        ?.getAttribute('data-pose'),
    ).toBe('jump');
    await nextFrame(2300);

    const scene = screen.getByRole('img');
    expect(scene.getAttribute('data-complete')).toBe('true');
    expect(scene.getAttribute('data-closure-status')).toBe('error');
    expect(scene.getAttribute('data-action-index')).toBe('2');
    expect(ready).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
});
