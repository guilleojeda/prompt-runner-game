// @vitest-environment jsdom

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import { AttemptApiFailure, type AttemptApi, type AttemptSummary } from './attempt-api.js';
import { HistoryList } from './AttemptActivityViews.js';
import { settle } from './History.test-support.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { useAttemptHistory } from './useAttemptHistory.js';

const MINUTE = 60_000;

const row: AttemptSummary = {
  id: 'history-pause-update-row',
  createdAt: '2026-10-27T12:00:00.000Z',
  updatedAt: '2026-10-27T12:00:01.000Z',
  status: 'victory',
  cancelRequested: false,
  levelId: LEVEL.id,
  modelKey: 'claude-sonnet-4.6',
  modelLabel: 'Claude Sonnet 4.6',
  modelId: 'global.anthropic.claude-sonnet-4-6',
  turnsUsed: 1,
  maxTurns: LEVEL.maxTurns,
  calls: 1,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  gameTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  score: 100,
  collectedObjectIds: [],
  objectPoints: 0,
  progress: 1,
  finalSupport: LEVEL.exit.support,
  animationEnabled: false,
  presentationComplete: true,
  recordComplete: true,
};

interface HistoryRecoveryHandle {
  updateHistory(): void;
}

const HistoryRecoveryHarness = forwardRef<
  HistoryRecoveryHandle,
  { readonly api: AttemptApi; readonly authPaused: boolean }
>(function HistoryRecoveryHarness({ api, authPaused }, ref) {
  const currentAttempt = useRef<AttemptSummary | null>(null);
  const editor = useRef<RobotEditorHandle | null>(null);
  const activityBusy = useRef(false);
  const history = useAttemptHistory({
    api,
    identity: 'history-update-auth-test',
    currentAttempt,
    historyVisible: true,
    surface: 'historial',
    editor,
    configurationAvailable: true,
    authPaused,
    activityBusy,
  });
  const { loadBootstrapPage } = history;

  useImperativeHandle(ref, () => ({ updateHistory: history.updateHistory }), [
    history.updateHistory,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    void loadBootstrapPage(controller.signal, () => true);
    return () => controller.abort();
  }, [loadBootstrapPage]);

  return (
    <HistoryList
      attempts={history.history}
      view={history.historyView}
      nextCursor={history.historyCursor}
      error={history.historyError}
      loading={history.loadingHistory}
      recovering={history.historyRecovering}
      recoveryMessage={history.historyRecoveryMessage}
      invalidCursor={history.invalidHistoryCursor}
      busy={history.loadingHistory}
      onOpen={() => undefined}
      onReplay={() => undefined}
      onConfiguration={() => undefined}
      configurationBusyId={null}
      onMore={() => void history.loadMore()}
      onUpdate={history.updateHistory}
      onSelectView={history.selectHistoryView}
    />
  );
});

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
});

describe('useAttemptHistory recovery implementation', () => {
  it('keeps an explicit first-page update pending through an access pause and runs it on resume', async () => {
    const listAttempts = vi
      .fn<AttemptApi['listAttempts']>()
      .mockResolvedValueOnce({ attempts: [row], nextCursor: 'cursor-expired' })
      .mockRejectedValueOnce(new AttemptApiFailure('invalid', 'Cursor expired.', 400))
      .mockResolvedValueOnce({ attempts: [row] });
    const api = { listAttempts } as unknown as AttemptApi;
    const historyRef = { current: null as HistoryRecoveryHandle | null };
    const element = (authPaused: boolean) => (
      <HistoryRecoveryHarness ref={historyRef} api={api} authPaused={authPaused} />
    );
    const view = render(element(false));
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    expect(listAttempts.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      'cursor-expired',
    ]);
    expect(screen.getByRole('button', { name: 'Actualizar historial' })).toBeTruthy();

    view.rerender(element(true));
    await settle();
    act(() => historyRef.current?.updateHistory());
    await settle();
    expect(listAttempts).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toContain('reanudará');
    expect(screen.getByRole('button', { name: 'Abrir' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recientes' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(2);

    view.rerender(element(false));
    await settle();
    expect(listAttempts).toHaveBeenCalledTimes(3);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Abrir' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
