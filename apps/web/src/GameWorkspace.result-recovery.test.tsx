// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type RobotDraft } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import type { DecisionIndex } from '../../../shared/attempt.js';
import type { ApiAuthRequired } from './api-auth.js';
import type { AuthSession } from './auth.js';
import {
  AttemptApiFailure,
  createAttemptApiClient,
  type AttemptApi,
  type AttemptSummary,
} from './attempt-api.js';
import type { ReplayRecordView } from '../../../shared/attempt.js';
import { formatDateTime } from './attempt-display.js';
import type { DraftApi } from './draft-api.js';
import {
  GameWorkspace,
  type GameWorkspaceHandle,
  type GameWorkspaceProps,
} from './GameWorkspace.js';
import {
  historyAction,
  historyActionForRow,
  historySection,
  selectHistoryView,
  settle,
} from './History.test-support.js';
import { doorVictoryRecord } from './replay/replay.test-support.js';

vi.mock('./replay/ReplayScene.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replay/ReplayScene.js')>();
  return {
    ...actual,
    ReplayScene: ({ onReady, onComplete }: { onReady: () => void; onComplete: () => void }) => (
      <div>
        <button type="button" onClick={onReady}>
          Recursos listos
        </button>
        <button type="button" onClick={onComplete}>
          Completar reproducción
        </button>
      </div>
    ),
  };
});

const MINUTE = 60_000;
const TEST_NOW = new Date('2026-10-28T12:00:00.000Z');
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

function session(sub = 'subject-a', accessToken = `token-${sub}`): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub, email: `${sub}@example.test` },
    user: new User({
      access_token: accessToken,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: now,
        exp: now + 600,
        sub,
        email: `${sub}@example.test`,
      },
      expires_at: now + 600,
    }),
  };
}

function summary(
  id: string,
  status: AttemptSummary['status'] = 'victory',
  overrides: Partial<AttemptSummary> = {},
): AttemptSummary {
  const active = status === 'pending' || status === 'running';
  return {
    id,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:01.000Z',
    status,
    cancelRequested: false,
    levelId: LEVEL.id,
    modelKey: 'claude-sonnet-4.6',
    modelLabel: 'Claude Sonnet 4.6',
    modelId: 'global.anthropic.claude-sonnet-4-6',
    turnsUsed: active ? 0 : 1,
    maxTurns: LEVEL.maxTurns,
    calls: active ? 0 : 1,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    gameTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    score: status === 'victory' ? 100 : null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: active ? 0 : 1,
    finalSupport: LEVEL.exit.support,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
    ...overrides,
  };
}

function attemptsApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('invalid', 'Unexpected create.')),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'Request not found.', 404)),
    getAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'Attempt not found.', 404)),
    getConfiguration: vi.fn().mockResolvedValue({
      attemptId: 'unexpected-configuration',
      draft: createDefaultDraft(),
    }),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(async (id: string) => ({
      attempt: summary(id, 'running'),
      dispatchConfirmed: true,
    })),
    cancelAttempt: vi.fn(),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(async (id: string): Promise<DecisionIndex> => ({
      attemptId: id,
      levelId: LEVEL.id,
      decisions: [],
    })),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
    putAnimationPreference: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-28',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 30 * 24 * 60 * MINUTE).toISOString(),
    }),
    ...overrides,
  };
}

function draftApi(): DraftApi {
  return {
    getDraft: vi.fn().mockResolvedValue({ version: 4, draft: createDefaultDraft() }),
    putDraft: vi.fn(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
}

function mountWorkspace(
  runnerOverrides: Partial<AttemptApi> = {},
  props: Partial<Pick<GameWorkspaceProps, 'session' | 'authPaused' | 'onAuthRequired'>> = {},
) {
  const runner = attemptsApi(runnerOverrides);
  const drafts = draftApi();
  const editor = { current: null } as unknown as GameWorkspaceProps['editor'];
  const workspaceRef = { current: null } as { current: GameWorkspaceHandle | null };
  let currentProps: GameWorkspaceProps = {
    attemptApi: runner,
    draftApi: drafts,
    session: props.session ?? session(),
    editor,
    accessState: 'ready',
    authPaused: props.authPaused ?? false,
    ...(props.onAuthRequired ? { onAuthRequired: props.onAuthRequired } : {}),
  };
  const element = () => <GameWorkspace ref={workspaceRef} {...currentProps} />;
  const view = render(element());
  return {
    ...view,
    runner,
    drafts,
    workspaceRef,
    update(nextProps: Partial<GameWorkspaceProps>): void {
      currentProps = { ...currentProps, ...nextProps };
      view.rerender(element());
    },
  };
}

function selectSurface(name: 'Preparar' | 'Historial' | 'Mis robots'): void {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Navegación principal' })).getByRole('button', {
      name,
    }),
  );
}

function visibleResultPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Resultado consultado' });
}

function expectTransientResultState(target: AttemptSummary): void {
  const panel = visibleResultPanel();
  expect.soft(within(panel).queryByRole('alert')).toBeNull();
  expect.soft(within(panel).queryByRole('button', { name: /Reintentar consulta/i })).toBeNull();
  expect.soft(within(panel).queryByRole('status')).not.toBeNull();
  expect.soft(within(panel).queryByRole('button', { name: 'Volver al historial' })).not.toBeNull();
  expect
    .soft(within(panel).queryByText(`Historial, ${formatDateTime(target.createdAt)}`))
    .not.toBeNull();
}

function replayFor(target: AttemptSummary): ReplayRecordView {
  const record = doorVictoryRecord();
  return {
    ...record,
    id: target.id,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

async function showHistory(rows: readonly AttemptSummary[]): Promise<void> {
  await settle();
  selectSurface('Historial');
  await settle();
  const section = historySection();
  expect(
    [...section.querySelectorAll<HTMLElement>('[data-history-row-id]')].map(
      (item) => item.dataset.historyRowId,
    ),
  ).toEqual(rows.map((item) => item.id));
}

async function openHistoryResult(rowStatus?: string): Promise<void> {
  const opener = rowStatus
    ? await historyActionForRow('Abrir', rowStatus)
    : await historyAction('Abrir');
  fireEvent.click(opener);
  await settle();
}

function listHistoryRows(rows: readonly AttemptSummary[]) {
  return vi
    .fn<AttemptApi['listAttempts']>()
    .mockResolvedValueOnce({ attempts: rows })
    .mockResolvedValue({ attempts: [] });
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  if (originalVisibilityState) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, 'visibilityState');
  }
  if (originalHidden) {
    Object.defineProperty(document, 'hidden', originalHidden);
  } else {
    Reflect.deleteProperty(document, 'hidden');
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

describe('GameWorkspace queried result recovery', () => {
  it('recovers the same result at 60 seconds without retry UI, keeps context/focus, and stops on success', async () => {
    const target = summary('result-recovery-target', 'victory');
    const refreshedTarget = summary(target.id, 'victory', {
      createdAt: target.createdAt,
      updatedAt: '2026-10-27T12:05:00.000Z',
      score: 125,
    });
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(refreshedTarget);
    const listAttempts = listHistoryRows([target]);
    const mounted = mountWorkspace({ listAttempts, getAttempt });
    await showHistory([target]);
    selectHistoryView('Mejores');
    await openHistoryResult();
    await settle();

    expect(getAttempt).toHaveBeenCalledTimes(1);
    expect(getAttempt.mock.calls[0]?.[0]).toBe(target.id);
    expectTransientResultState(target);
    const historyNavigation = within(
      screen.getByRole('navigation', { name: 'Navegación principal' }),
    ).getByRole('button', { name: 'Historial' });
    historyNavigation.focus();

    await advance(MINUTE - 1);
    expect(getAttempt).toHaveBeenCalledTimes(1);
    await advance(1);
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(document.activeElement).toBe(historyNavigation);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(document.activeElement).toBe(historyNavigation);

    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Volver al historial' }));
    await settle();
    expect(
      within(historySection())
        .getByRole('button', { name: 'Mejores' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(historySection().querySelector(`[data-history-row-id="${target.id}"]`)).toBeTruthy();
    expect(within(historySection()).getByText(/Puntaje: 125/)).toBeTruthy();
    expect(document.activeElement).toBe(
      within(historySection()).getByRole('button', { name: 'Abrir' }),
    );
    expect(listAttempts).toHaveBeenCalledTimes(2);
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
    expect(mounted.runner.cancelAttempt).not.toHaveBeenCalled();
    expect(mounted.runner.completePresentation).not.toHaveBeenCalled();
    expect(mounted.drafts.putDraft).not.toHaveBeenCalled();
    expect(mounted.runner.getQuota).toHaveBeenCalledOnce();
  });

  it('repeats a deferred failure only after it finishes, then uses the same ID and stops at success', async () => {
    const target = summary('result-recovery-deferred', 'victory');
    const request = deferred<AttemptSummary>();
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockReturnValueOnce(request.promise)
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Result service down.', 503))
      .mockRejectedValueOnce(new AttemptApiFailure('attempt_unavailable', 'Gateway busy.', 429))
      .mockResolvedValueOnce(target);
    mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.reject(new AttemptApiFailure('network', 'Late result failure.'));
      await Promise.resolve();
    });
    await settle();
    expectTransientResultState(target);
    await advance(MINUTE - 1);
    expect(getAttempt).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expectTransientResultState(target);
    await advance(MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(3);
    expectTransientResultState(target);
    await advance(MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(4);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual(Array(4).fill(target.id));
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(4);
  });

  it('runs only one overdue result read when visibility or focus returns', async () => {
    const target = summary('result-recovery-wake', 'victory');
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(target);
    mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    await advance(MINUTE + 5_000);
    expect(getAttempt).toHaveBeenCalledOnce();
    expectTransientResultState(target);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();
    await advance(0);
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();

    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
  });

  it('keeps a failed result deadline while access is paused and resumes once when access is ready', async () => {
    const target = summary('result-recovery-access-pause', 'victory');
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(target);
    const mounted = mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();
    expectTransientResultState(target);

    mounted.update({ authPaused: true });
    await settle();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(1);
    mounted.update({ authPaused: false });
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.at(-1)?.[0]).toBe(target.id);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
  });

  it('does not advance or restart a failed result deadline when access resumes before it expires', async () => {
    const target = summary('result-recovery-resume-before-deadline', 'victory');
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(target);
    const mounted = mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();

    await advance(30_000);
    mounted.update({ authPaused: true });
    await advance(10_000);
    mounted.update({ authPaused: false });
    await settle();

    await advance(MINUTE - 40_001);
    expect(getAttempt).toHaveBeenCalledOnce();
    await advance(1);
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
  });

  it('aborts a deferred result read during access pause and resumes one fresh read', async () => {
    const target = summary('result-recovery-deferred-access-pause', 'victory');
    const replacement = summary(target.id, 'victory', { score: 140 });
    const staleRequest = deferred<AttemptSummary>();
    let staleSignal: AbortSignal | undefined;
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockImplementationOnce((_id, signal) => {
        staleSignal = signal;
        return staleRequest.promise;
      })
      .mockResolvedValueOnce(replacement);
    const mounted = mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();
    expect(getAttempt).toHaveBeenCalledOnce();

    mounted.update({ authPaused: true });
    await settle();
    expect.soft(staleSignal?.aborted).toBe(true);
    await act(async () => {
      staleRequest.resolve(target);
      await Promise.resolve();
    });
    await settle();
    expect.soft(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledOnce();

    mounted.update({ authPaused: false });
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(within(visibleResultPanel()).getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    const score = within(visibleResultPanel()).getByLabelText('Puntaje de la victoria');
    expect(within(score).getByText('140,00', { exact: true })).toBeTruthy();
  });

  it('uses current credentials after App declines an obsolete auth context', async () => {
    const target = summary('result-recovery-stale-auth', 'victory');
    const onAuthRequired = vi.fn<ApiAuthRequired>().mockReturnValue(false);
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(
        new AttemptApiFailure('authentication', 'Old session rejected.', 401, false, {
          authContext: 42,
        }),
      )
      .mockResolvedValueOnce(target);
    const mounted = mountWorkspace(
      { listAttempts: listHistoryRows([target]), getAttempt },
      {
        onAuthRequired,
      },
    );
    await showHistory([target]);
    await openHistoryResult();
    expect(onAuthRequired).toHaveBeenCalledWith(42);
    expectTransientResultState(target);

    await advance(MINUTE - 1);
    expect(getAttempt).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    selectSurface('Preparar');
    await settle();
    expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
  });

  it('pauses a current auth rejection until access returns, then resumes the selected result', async () => {
    const target = summary('result-recovery-current-auth', 'victory');
    let mounted: ReturnType<typeof mountWorkspace> | null = null;
    const onAuthRequired = vi.fn<ApiAuthRequired>((authContext) => {
      mounted?.update({ authPaused: true });
      expect(authContext).toBe(84);
      return true;
    });
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(
        new AttemptApiFailure('authentication', 'Session expired.', 401, false, {
          authContext: 84,
        }),
      )
      .mockResolvedValueOnce(target);
    mounted = mountWorkspace(
      { listAttempts: listHistoryRows([target]), getAttempt },
      {
        onAuthRequired,
      },
    );
    await showHistory([target]);
    await openHistoryResult();
    await settle();
    expect(onAuthRequired).toHaveBeenCalledOnce();
    expect(getAttempt).toHaveBeenCalledTimes(1);
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(1);

    mounted.update({ authPaused: false });
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.at(-1)?.[0]).toBe(target.id);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
  });

  it('cancels an overdue result retry when the query is closed', async () => {
    const target = summary('result-recovery-close', 'victory');
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(target);
    mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();
    expectTransientResultState(target);
    fireEvent.click(
      within(visibleResultPanel()).getByRole('button', { name: 'Volver al historial' }),
    );
    await settle();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(screen.queryByRole('region', { name: 'Resultado consultado' })).toBeNull();
  });

  it.each(['close', 'surface', 'identity', 'unmount'] as const)(
    'aborts and invalidates an in-flight result after %s',
    async (abandonment) => {
      const target = summary(`result-recovery-abort-${abandonment}`, 'victory');
      const request = deferred<AttemptSummary>();
      let signal: AbortSignal | undefined;
      const getAttempt = vi.fn<AttemptApi['getAttempt']>((id, nextSignal) => {
        signal = nextSignal;
        return request.promise;
      });
      const mounted = mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
      await showHistory([target]);
      await openHistoryResult();
      expect(getAttempt).toHaveBeenCalledOnce();

      if (abandonment === 'close') {
        fireEvent.click(
          within(visibleResultPanel()).getByRole('button', { name: 'Volver al historial' }),
        );
      } else if (abandonment === 'surface') {
        selectSurface('Preparar');
      } else if (abandonment === 'identity') {
        mounted.update({ session: session('subject-b') });
      } else {
        mounted.unmount();
      }
      await settle();
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        request.resolve(target);
        await Promise.resolve();
      });
      await settle();
      await advance(2 * MINUTE);
      expect(getAttempt).toHaveBeenCalledOnce();
      expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    },
  );

  it('does not let a late result from a closed target replace the newly selected target', async () => {
    const first = summary('result-recovery-target-a', 'defeat', {
      createdAt: '2026-10-25T12:00:00.000Z',
    });
    const second = summary('result-recovery-target-b', 'victory', {
      createdAt: '2026-10-26T12:00:00.000Z',
    });
    const firstRequest = deferred<AttemptSummary>();
    let firstSignal: AbortSignal | undefined;
    const getAttempt = vi.fn<AttemptApi['getAttempt']>((id, signal) => {
      if (id === first.id) {
        firstSignal = signal;
        return firstRequest.promise;
      }
      return Promise.resolve(second);
    });
    mountWorkspace({ listAttempts: listHistoryRows([first, second]), getAttempt });
    await showHistory([first, second]);
    await openHistoryResult('Derrota');
    fireEvent.click(
      within(visibleResultPanel()).getByRole('button', { name: 'Volver al historial' }),
    );
    await settle();
    expect(firstSignal?.aborted).toBe(true);
    await openHistoryResult('Victoria');
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();

    await act(async () => {
      firstRequest.resolve(first);
      await Promise.resolve();
    });
    await settle();
    expect(within(visibleResultPanel()).getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(
      within(visibleResultPanel()).getByText(`Historial, ${formatDateTime(second.createdAt)}`),
    ).toBeTruthy();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
  });

  it('ignores an old target auth rejection while the new target is still loading', async () => {
    const first = summary('result-recovery-auth-target-a', 'defeat', {
      createdAt: '2026-10-25T12:00:00.000Z',
    });
    const second = summary('result-recovery-auth-target-b', 'victory', {
      createdAt: '2026-10-26T12:00:00.000Z',
    });
    const firstRequest = deferred<AttemptSummary>();
    const secondRequest = deferred<AttemptSummary>();
    let firstSignal: AbortSignal | undefined;
    const onAuthRequired = vi.fn<ApiAuthRequired>().mockReturnValue(false);
    const getAttempt = vi.fn<AttemptApi['getAttempt']>((id, signal) => {
      if (id === first.id) {
        firstSignal = signal;
        return firstRequest.promise;
      }
      return secondRequest.promise;
    });
    const mounted = mountWorkspace(
      { listAttempts: listHistoryRows([first, second]), getAttempt },
      { onAuthRequired },
    );
    await showHistory([first, second]);
    await openHistoryResult('Derrota');
    fireEvent.click(
      within(visibleResultPanel()).getByRole('button', { name: 'Volver al historial' }),
    );
    await settle();
    await openHistoryResult('Victoria');
    const historyNavigation = within(
      screen.getByRole('navigation', { name: 'Navegación principal' }),
    ).getByRole('button', { name: 'Historial' });
    historyNavigation.focus();

    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      firstRequest.reject(
        new AttemptApiFailure('authentication', 'Old session rejected.', 401, false, {
          authContext: 17,
        }),
      );
      await Promise.resolve();
    });
    await settle();

    const panel = visibleResultPanel();
    expect(onAuthRequired).not.toHaveBeenCalled();
    expect(within(panel).queryByRole('alert')).toBeNull();
    expect(within(panel).queryByRole('status')).not.toBeNull();
    expect(within(panel).queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(within(panel).getByText(`Historial, ${formatDateTime(second.createdAt)}`)).toBeTruthy();
    expect(document.activeElement).toBe(historyNavigation);

    await act(async () => {
      secondRequest.resolve(second);
      await Promise.resolve();
    });
    await settle();
    expect(within(visibleResultPanel()).getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(
      within(visibleResultPanel()).getByText(`Historial, ${formatDateTime(second.createdAt)}`),
    ).toBeTruthy();
    expect(onAuthRequired).not.toHaveBeenCalled();
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
    mounted.unmount();
  });

  it.each([
    {
      name: '404 not found',
      failure: new AttemptApiFailure('not_found', 'Result not found.', 404),
    },
    {
      name: 'invalid request',
      failure: new AttemptApiFailure('invalid', 'Result request invalid.', 400),
    },
    { name: '409 conflict', failure: new AttemptApiFailure('conflict', 'Result conflict.', 409) },
    {
      name: 'malformed 2xx response',
      failure: new AttemptApiFailure('server', 'Malformed result body.', 200),
    },
  ])('keeps context and does not loop after $name', async ({ failure }) => {
    const target = summary('result-recovery-definitive', 'defeat');
    const getAttempt = vi.fn<AttemptApi['getAttempt']>().mockRejectedValueOnce(failure);
    mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();
    const panel = visibleResultPanel();
    expect(within(panel).getByRole('alert')).toBeTruthy();
    expect(within(panel).getByText(`Historial, ${formatDateTime(target.createdAt)}`)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Volver al historial' })).toBeTruthy();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(getAttempt).toHaveBeenCalledWith(target.id, expect.any(AbortSignal));
  });

  it('treats a wrong-ID 2xx result after a transient failure as a definitive protocol error', async () => {
    const target = summary('result-recovery-protocol-target', 'victory');
    const wrongTarget = summary('result-recovery-protocol-other', 'defeat');
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(wrongTarget);
    mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();
    expectTransientResultState(target);

    await advance(MINUTE);
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(within(visibleResultPanel()).getByRole('alert')).toBeTruthy();
    expect(within(visibleResultPanel()).getByText(/no coincide con el solicitado/i)).toBeTruthy();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(2);
  });

  it('treats a persisted incompatible result as definitive using the real API client', async () => {
    const target = summary('result-recovery-incompatible', 'victory');
    const fetchFixture = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'stored_attempt_incompatible',
          message: 'El intento guardado no es compatible con esta vista.',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = createAttemptApiClient(
      { apiBaseUrl: 'https://api.example.test/' },
      () => 'fixture-token',
      fetchFixture,
    );
    mountWorkspace({
      listAttempts: listHistoryRows([target]),
      getAttempt: client.getAttempt.bind(client),
    });
    await showHistory([target]);
    await openHistoryResult();
    await settle();

    expect(within(visibleResultPanel()).getByRole('alert')).toBeTruthy();
    expect(
      within(visibleResultPanel()).getByText(
        'El intento guardado no es compatible con esta vista.',
      ),
    ).toBeTruthy();
    await advance(2 * MINUTE);
    expect(fetchFixture).toHaveBeenCalledOnce();
  });

  it('hands an active recovered result to the existing activity owner and stops its query timer', async () => {
    const target = summary('result-recovery-active-handoff', 'running');
    const terminal = summary(target.id, 'victory');
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(terminal);
    const mounted = mountWorkspace({ listAttempts: listHistoryRows([target]), getAttempt });
    await showHistory([target]);
    await openHistoryResult();
    expectTransientResultState(target);

    await advance(MINUTE);
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Resultado consultado' })).toBeNull();
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
    expect(mounted.runner.startAttempt).not.toHaveBeenCalled();
    expect(mounted.runner.cancelAttempt).not.toHaveBeenCalled();
    expect(mounted.runner.completePresentation).not.toHaveBeenCalled();

    await advance(2_000);
    expect(getAttempt).toHaveBeenCalledTimes(3);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual(Array(3).fill(target.id));
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(3);
  });

  it('starts a recovered pending result through the existing owner without creating another attempt', async () => {
    const target = summary('result-recovery-pending-handoff', 'pending');
    const running = summary(target.id, 'running');
    const terminal = summary(target.id, 'victory');
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(terminal);
    const startAttempt = vi.fn().mockResolvedValue({ attempt: running, dispatchConfirmed: true });
    const mounted = mountWorkspace({
      listAttempts: listHistoryRows([target]),
      getAttempt,
      startAttempt,
    });
    await showHistory([target]);
    await openHistoryResult();
    expectTransientResultState(target);

    await advance(MINUTE);
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(startAttempt.mock.calls[0]?.[0]).toBe(target.id);
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();

    await advance(2_000);
    expect(getAttempt).toHaveBeenCalledTimes(3);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual(Array(3).fill(target.id));
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(3);
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
  });

  it('replays a recovered terminal result before the result screen and acknowledges once', async () => {
    const replay = doorVictoryRecord();
    const target = summary('result-recovery-presentation-handoff', 'victory', {
      animationEnabled: true,
      presentationComplete: false,
      turnsUsed: replay.actions.length,
    });
    const completed = summary(target.id, 'victory', {
      animationEnabled: true,
      presentationComplete: true,
      turnsUsed: replay.actions.length,
    });
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(target);
    const getReplay = vi.fn().mockResolvedValue(replayFor(target));
    const completePresentation = vi.fn().mockResolvedValue(completed);
    const mounted = mountWorkspace({
      listAttempts: listHistoryRows([target]),
      getAttempt,
      getReplay,
      completePresentation,
    });
    await showHistory([target]);
    await openHistoryResult();
    expectTransientResultState(target);

    await advance(MINUTE);
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getReplay).toHaveBeenCalledOnce();
    expect(getReplay).toHaveBeenCalledWith(target.id);
    expect(screen.getByRole('button', { name: 'Recursos listos' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(completePresentation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(completePresentation.mock.calls[0]?.[0]).toBe(target.id);
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
    expect(mounted.runner.startAttempt).not.toHaveBeenCalled();
    expect(mounted.runner.cancelAttempt).not.toHaveBeenCalled();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    await advance(2 * MINUTE);
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getReplay).toHaveBeenCalledOnce();
    expect(completePresentation).toHaveBeenCalledOnce();
  });
});
