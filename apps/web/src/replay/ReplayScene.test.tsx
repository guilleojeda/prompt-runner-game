// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClosedAttemptRecordFixture } from '../../../../shared/attempt.fixture.js';
import type {
  AttemptRecord,
  AttemptRecordView,
  ReplayRecordView,
} from '../../../../shared/attempt.js';
import { prepareReplay } from './prepare.js';
import { ReplayScene } from './ReplayScene.js';

const publicFixture = (): ReplayRecordView => {
  const record: AttemptRecord = createClosedAttemptRecordFixture();
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
    expect(screen.getByRole('img').getAttribute('data-action-index')).toBe('0');

    const durationMs = prepareReplay(publicFixture()).duration * 1000;
    await nextFrame(1000 + durationMs + 3500);
    expect(screen.getByRole('img').getAttribute('data-complete')).toBe('true');
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
});
