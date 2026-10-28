// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  ROBOT_CATALOG_VERSION,
  ROBOT_SCHEMA_VERSION,
  type RobotDraft,
} from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import type { AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type AttemptSummary } from './attempt-api.js';
import {
  GameWorkspace,
  type GameWorkspaceHandle,
  type GameWorkspaceProps,
} from './GameWorkspace.js';
import {
  historyAction,
  historySection,
  selectHistoryView,
  settle,
} from './History.test-support.js';
import type { DraftApi } from './draft-api.js';
import type { ApiAuthRequired } from './api-auth.js';
import type { DecisionIndex } from '../../../shared/attempt.js';

const MINUTE = 60_000;
const TEST_NOW = new Date('2026-10-28T12:00:00.000Z');
const INITIAL_RECOVERY_KEY = 'prompt-runner:attempt-recovery';
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
    getConfiguration: vi.fn(),
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

function expectTransientHistoryState(section: HTMLElement): void {
  expect(within(section).queryByRole('alert')).toBeNull();
  expect(within(section).queryByRole('button', { name: /Reintentar historial/i })).toBeNull();
  expect(within(section).queryByText('Todavía no hay intentos guardados.')).toBeNull();
  expect(within(section).getByRole('status')).toBeTruthy();
}

function rowIds(section: HTMLElement): string[] {
  return [...section.querySelectorAll<HTMLElement>('[data-history-row-id]')].map(
    (row) => row.dataset.historyRowId!,
  );
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

describe('GameWorkspace history list recovery', () => {
  it('recovers the first page at 60 seconds while Historial is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const listAttempts = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'History unavailable.'))
      .mockResolvedValueOnce({ attempts: [] })
      .mockResolvedValue({ attempts: [] });
    mountWorkspace({ listAttempts });
    await settle();
    expect(listAttempts).toHaveBeenCalledTimes(2);

    selectSurface('Historial');
    await settle();
    const history = historySection();
    expectTransientHistoryState(history);
    const readsAtFailure = listAttempts.mock.calls.length;

    await advance(MINUTE - 1);
    expect(listAttempts).toHaveBeenCalledTimes(readsAtFailure);
    await advance(1);
    expect(listAttempts).toHaveBeenCalledTimes(readsAtFailure + 1);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBeUndefined();
  });

  it('repeats after successive failures and stops after a successful read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const listAttempts = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Bootstrap failed.'))
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'First recovery failed.', 503))
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Second recovery failed.'))
      .mockRejectedValueOnce(new AttemptApiFailure('attempt_unavailable', 'Gateway busy.', 429))
      .mockResolvedValueOnce({ attempts: [] });
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();

    for (let recovery = 0; recovery < 4; recovery += 1) {
      const callsBeforeDeadline = listAttempts.mock.calls.length;
      await advance(MINUTE - 1);
      expect(listAttempts).toHaveBeenCalledTimes(callsBeforeDeadline);
      await advance(1);
      expect(listAttempts).toHaveBeenCalledTimes(callsBeforeDeadline + 1);
      expect(listAttempts.mock.calls.at(-1)?.[0]).toBeUndefined();
    }

    const callsAfterSuccess = listAttempts.mock.calls.length;
    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(callsAfterSuccess);
  });

  it('retries the failed cursor as an append and preserves the selected view and earlier page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const first = summary('history-first', 'victory', { score: 100 });
    const second = summary('history-second', 'victory', { score: 220 });
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [first], nextCursor: 'cursor-page-2' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Page two unavailable.'))
      .mockResolvedValueOnce({ attempts: [second], nextCursor: 'cursor-page-3' });
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    const history = historySection();
    selectHistoryView('Mejores');
    await settle();
    fireEvent.click(within(history).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    expectTransientHistoryState(history);
    expect(rowIds(history)).toEqual(['history-first']);
    expect(
      within(history).getByRole('button', { name: 'Mejores' }).getAttribute('aria-pressed'),
    ).toBe('true');

    await advance(MINUTE);
    expect(listAttempts.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      undefined,
      'cursor-page-2',
      'cursor-page-2',
    ]);
    expect(rowIds(history)).toEqual(['history-second', 'history-first']);
    expect(
      within(history).getByRole('button', { name: 'Mejores' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('does not overlap a deferred page request and starts its deadline after failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const first = summary('deferred-first');
    const page = deferred<{ attempts: readonly AttemptSummary[]; nextCursor?: string }>();
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [first], nextCursor: 'cursor-deferred' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockReturnValueOnce(page.promise)
      .mockResolvedValue({ attempts: [summary('deferred-second')] });
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();

    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(3);
    await act(async () => page.reject(new AttemptApiFailure('network', 'Late failure.')));
    await settle();
    await advance(MINUTE - 1);
    expect(listAttempts).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(listAttempts).toHaveBeenCalledTimes(4);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('cursor-deferred');
  });

  it('stops on an invalid cursor and refreshes from page one only after the named action', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const oldRow = summary('cursor-old-row');
    const initialRefresh = deferred<{ attempts: readonly AttemptSummary[]; nextCursor?: string }>();
    const recoveryRefresh = deferred<{
      attempts: readonly AttemptSummary[];
      nextCursor?: string;
    }>();
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [oldRow], nextCursor: 'cursor-invalid' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('invalid', 'Cursor no longer valid.', 400))
      .mockReturnValueOnce(initialRefresh.promise)
      .mockReturnValueOnce(recoveryRefresh.promise);
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    const history = historySection();
    expect(within(history).queryByRole('button', { name: 'Actualizar historial' })).toBeNull();
    fireEvent.click(within(history).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();

    expect(listAttempts.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      undefined,
      'cursor-invalid',
    ]);
    expect(within(history).getByRole('button', { name: 'Actualizar historial' })).toBeTruthy();
    expect(rowIds(history)).toEqual(['cursor-old-row']);
    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(3);

    fireEvent.click(within(history).getByRole('button', { name: 'Actualizar historial' }));
    await settle();
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBeUndefined();
    expect(rowIds(history)).toEqual(['cursor-old-row']);
    await act(async () =>
      initialRefresh.reject(new AttemptApiFailure('network', 'First-page update unavailable.')),
    );
    await settle();
    expectTransientHistoryState(history);
    expect(rowIds(history)).toEqual(['cursor-old-row']);
    expect(listAttempts.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      undefined,
      'cursor-invalid',
      undefined,
    ]);
    await advance(MINUTE - 1);
    expect(listAttempts).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(listAttempts).toHaveBeenCalledTimes(5);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBeUndefined();
    expect(rowIds(history)).toEqual(['cursor-old-row']);
    await act(async () =>
      recoveryRefresh.resolve({
        attempts: [summary('cursor-fresh-row')],
        nextCursor: 'cursor-new',
      }),
    );
    await settle();
    expect(rowIds(history)).toEqual(['cursor-fresh-row']);
    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(5);
  });

  it('clears an old cursor deadline when a later cursor failure requires a first-page update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const refresh = deferred<{ attempts: readonly AttemptSummary[]; nextCursor?: string }>();
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [summary('old-chain')], nextCursor: 'cursor-retry' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Temporary cursor failure.'))
      .mockRejectedValueOnce(new AttemptApiFailure('invalid', 'Cursor expired.', 400))
      .mockReturnValueOnce(refresh.promise);
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    const history = historySection();
    fireEvent.click(within(history).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    await advance(MINUTE);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('cursor-retry');
    expect(within(history).getByRole('button', { name: 'Actualizar historial' })).toBeTruthy();

    fireEvent.click(within(history).getByRole('button', { name: 'Actualizar historial' }));
    await settle();
    const callsWhileRefreshPending = listAttempts.mock.calls.length;
    await advance(MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(callsWhileRefreshPending);
    await act(async () => refresh.resolve({ attempts: [summary('fresh-chain')] }));
    await settle();
    expect(rowIds(history)).toEqual(['fresh-chain']);
    await advance(MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(callsWhileRefreshPending);
  });

  it.each([
    {
      name: '404 not found',
      failure: new AttemptApiFailure('not_found', 'Attempt no longer exists.', 404),
    },
    {
      name: '409 conflict',
      failure: new AttemptApiFailure('conflict', 'History request conflicted.', 409),
    },
    {
      name: 'malformed success response',
      failure: new AttemptApiFailure('server', 'Invalid response body.', 200),
    },
  ])('keeps a visible error and does not loop after $name', async ({ failure }) => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const existing = summary('definitive-existing');
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [existing], nextCursor: 'cursor-definitive' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(failure);
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    const history = historySection();
    fireEvent.click(within(history).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();

    expect(within(history).getByRole('alert')).toBeTruthy();
    expect(rowIds(history)).toEqual(['definitive-existing']);
    const readsAfterDefinitiveError = listAttempts.mock.calls.length;
    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(readsAfterDefinitiveError);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('cursor-definitive');
    expect(rowIds(history)).toEqual(['definitive-existing']);
  });

  it.each(['known recovery', 'active discovery'] as const)(
    'lets %s continue after a failed bootstrap without holding its promise for recovery',
    async (path) => {
      vi.useFakeTimers();
      vi.setSystemTime(TEST_NOW);
      const active = summary(`bootstrap-${path}`, 'running');
      const listAttempts = vi
        .fn()
        .mockRejectedValueOnce(new AttemptApiFailure('network', 'Bootstrap read failed.'))
        .mockResolvedValueOnce({ attempts: [active] });
      const getAttempt = vi.fn().mockResolvedValue(active);
      if (path === 'known recovery') {
        window.sessionStorage.setItem(
          INITIAL_RECOVERY_KEY,
          JSON.stringify({
            sub: 'subject-a',
            attemptId: active.id,
            draftContract: {
              schemaVersion: ROBOT_SCHEMA_VERSION,
              catalogVersion: ROBOT_CATALOG_VERSION,
            },
          }),
        );
      }
      const { runner } = mountWorkspace({ listAttempts, getAttempt });
      await settle();

      expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
      if (path === 'known recovery') {
        expect(runner.getAttempt).toHaveBeenCalledWith(active.id, expect.any(AbortSignal));
        expect(listAttempts).toHaveBeenCalledOnce();
      } else {
        expect(listAttempts).toHaveBeenCalledTimes(2);
        expect(runner.getAttempt).not.toHaveBeenCalled();
      }
      const readsAfterDiscovery = listAttempts.mock.calls.length;
      await advance(MINUTE);
      expect(listAttempts).toHaveBeenCalledTimes(readsAfterDiscovery);
    },
  );

  it('keeps a failed list deadline while Prepare is open and recovers once on return', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [summary('visible-row')], nextCursor: 'cursor-hidden' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Page failed.'))
      .mockResolvedValue({ attempts: [summary('recovered-row')] });
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    const callsBeforeHiding = listAttempts.mock.calls.length;
    selectSurface('Preparar');
    await advance(MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(callsBeforeHiding);

    selectSurface('Historial');
    await settle();
    expect(listAttempts).toHaveBeenCalledTimes(callsBeforeHiding + 1);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('cursor-hidden');
  });

  it.each([
    {
      panel: 'resultado',
      open: async () => {
        fireEvent.click(await historyAction('Abrir'));
        await settle();
        screen.getByRole('heading', { name: 'Victoria' });
      },
      close: () => fireEvent.click(screen.getByRole('button', { name: 'Volver al historial' })),
      runner: {
        getAttempt: vi.fn(async (id: string) => summary(id)),
      },
    },
    {
      panel: 'configuración',
      open: async () => {
        fireEvent.click(await historyAction('Ver configuración'));
        await settle();
        screen.getByRole('heading', { name: 'Configuración del intento' });
      },
      close: () => fireEvent.click(screen.getByRole('button', { name: 'Cerrar' })),
      runner: {
        getConfiguration: vi.fn(async (id: string) => ({
          attemptId: id,
          draft: createDefaultDraft(),
        })),
      },
    },
    {
      panel: 'inspector',
      open: async () => {
        fireEvent.click(await historyAction('Inspeccionar decisiones'));
        await settle();
        screen.getByRole('heading', { name: 'Inspeccionar decisiones' });
      },
      close: () => fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' })),
      runner: {},
    },
  ] as const)(
    'does not recover a due list behind the open $panel and runs once on return',
    async ({ open, close, runner: overlayRunner }) => {
      vi.useFakeTimers();
      vi.setSystemTime(TEST_NOW);
      const listAttempts = vi
        .fn()
        .mockResolvedValueOnce({ attempts: [summary('overlay-row')], nextCursor: 'cursor-overlay' })
        .mockResolvedValueOnce({ attempts: [] })
        .mockRejectedValueOnce(new AttemptApiFailure('network', 'Page failed.'))
        .mockResolvedValue({ attempts: [summary('after-overlay')] });
      mountWorkspace({ listAttempts, ...overlayRunner });
      await settle();
      selectSurface('Historial');
      await settle();
      const history = historySection();
      fireEvent.click(within(history).getByRole('button', { name: 'Cargar 20 más' }));
      await settle();
      const callsBeforeOverlay = listAttempts.mock.calls.length;
      await open();
      await settle();
      expect(
        screen.getByRole('heading', {
          name: /Victoria|Configuración del intento|Inspeccionar decisiones/,
        }),
      ).toBeTruthy();
      await advance(MINUTE);
      expect(listAttempts).toHaveBeenCalledTimes(callsBeforeOverlay);

      close();
      await settle();
      expect(listAttempts).toHaveBeenCalledTimes(callsBeforeOverlay + 1);
      expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('cursor-overlay');
    },
  );

  it('runs at most one overdue recovery when visibility or focus returns', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [summary('wake-row')], nextCursor: 'cursor-wake' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Wake recovery pending.'))
      .mockResolvedValue({ attempts: [summary('wake-recovered')] });
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    const readsBeforeWake = listAttempts.mock.calls.length;

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    vi.setSystemTime(TEST_NOW.getTime() + MINUTE + 5_000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();
    await advance(0);
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();

    expect(listAttempts).toHaveBeenCalledTimes(readsBeforeWake + 1);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('cursor-wake');
  });

  it('does not reread a healthy history when switching surfaces or views', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [summary('healthy-row')], nextCursor: 'healthy-cursor' })
      .mockResolvedValueOnce({ attempts: [] });
    mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    selectHistoryView('Mejores');
    selectSurface('Preparar');
    selectSurface('Historial');
    await advance(3 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(2);
    expect(rowIds(historySection())).toEqual(['healthy-row']);
  });

  it('preserves a just-edited editor literal across recovery at the minute boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({
        attempts: [summary('draft-preserve-row')],
        nextCursor: 'cursor-draft',
      })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Page failed before editing.'))
      .mockResolvedValueOnce({ attempts: [summary('draft-preserve-second')] });
    const mounted = mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    await advance(MINUTE - 1);

    selectSurface('Preparar');
    await settle();
    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    const editedLiteral = 'Conservar este texto mientras se recupera Historial.';
    fireEvent.change(instructions, { target: { value: editedLiteral } });
    await settle();
    const callsBeforeReturn = listAttempts.mock.calls.length;
    selectSurface('Historial');
    await settle();
    expect(listAttempts).toHaveBeenCalledTimes(callsBeforeReturn);

    await advance(1);
    expect(listAttempts).toHaveBeenCalledTimes(callsBeforeReturn + 1);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('cursor-draft');
    selectSurface('Preparar');
    await settle();
    expect(
      (screen.getByLabelText('Qué debe tener en cuenta el robot') as HTMLTextAreaElement).value,
    ).toBe(editedLiteral);
    expect(mounted.drafts.getDraft).toHaveBeenCalledOnce();
    expect(mounted.drafts.putDraft).not.toHaveBeenCalled();
  });

  it('aborts and invalidates a pending page when identity changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const pending = deferred<{ attempts: readonly AttemptSummary[]; nextCursor?: string }>();
    let cursorSignal: AbortSignal | undefined;
    let unpaged = 0;
    const listAttempts = vi.fn((cursor?: string, signal?: AbortSignal) => {
      if (cursor === 'cursor-identity') {
        cursorSignal = signal;
        return pending.promise;
      }
      unpaged += 1;
      if (unpaged === 1)
        return Promise.resolve({
          attempts: [summary('identity-a')],
          nextCursor: 'cursor-identity',
        });
      return Promise.resolve({ attempts: [] });
    });
    const mounted = mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    mounted.update({ session: session('subject-b') });
    await settle();
    expect(cursorSignal?.aborted).toBe(true);
    await act(async () => pending.resolve({ attempts: [summary('stale-identity-row')] }));
    await settle();
    expect(rowIds(historySection())).not.toContain('stale-identity-row');
    const readsAfterIdentityChange = listAttempts.mock.calls.length;
    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(readsAfterIdentityChange);
  });

  it('aborts a pending list request and cancels its recovery while access is paused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const pending = deferred<{ attempts: readonly AttemptSummary[]; nextCursor?: string }>();
    let cursorSignal: AbortSignal | undefined;
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [summary('pause-row')], nextCursor: 'cursor-pause' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockImplementationOnce((_cursor?: string, signal?: AbortSignal) => {
        cursorSignal = signal;
        return pending.promise;
      });
    const mounted = mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    mounted.update({ authPaused: true });
    await settle();
    expect(cursorSignal?.aborted).toBe(true);
    await act(async () => pending.reject(new AttemptApiFailure('network', 'Late paused failure.')));
    await settle();
    const readsWhilePaused = listAttempts.mock.calls.length;
    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(readsWhilePaused);
  });

  it('resumes one overdue list recovery after access returns to ready', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [summary('resume-row')], nextCursor: 'cursor-resume' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Page failed before pause.'))
      .mockResolvedValueOnce({ attempts: [summary('resumed-row')] });
    const mounted = mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    const callsWhenPaused = listAttempts.mock.calls.length;
    mounted.update({ authPaused: true });
    await advance(MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(callsWhenPaused);

    mounted.update({ authPaused: false });
    await settle();
    expect(listAttempts).toHaveBeenCalledTimes(callsWhenPaused + 1);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('cursor-resume');
    expect(rowIds(historySection())).toEqual(['resume-row', 'resumed-row']);
    await advance(2 * MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(callsWhenPaused + 1);
  });

  it('clears a pending deadline and aborts a deferred page request on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const listAttempts = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Bootstrap failed.'))
      .mockResolvedValueOnce({ attempts: [] })
      .mockResolvedValue({ attempts: [] });
    const mounted = mountWorkspace({ listAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    const readsAtUnmount = listAttempts.mock.calls.length;
    mounted.unmount();
    await advance(MINUTE);
    expect(listAttempts).toHaveBeenCalledTimes(readsAtUnmount);

    const pending = deferred<{ attempts: readonly AttemptSummary[]; nextCursor?: string }>();
    let cursorSignal: AbortSignal | undefined;
    const pendingListAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [summary('unmount-row')], nextCursor: 'cursor-unmount' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockImplementationOnce((_cursor?: string, signal?: AbortSignal) => {
        cursorSignal = signal;
        return pending.promise;
      });
    const secondMount = mountWorkspace({ listAttempts: pendingListAttempts });
    await settle();
    selectSurface('Historial');
    await settle();
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    expect(pendingListAttempts).toHaveBeenCalledTimes(3);
    secondMount.unmount();
    expect(cursorSignal?.aborted).toBe(true);
    await act(async () =>
      pending.reject(new AttemptApiFailure('network', 'Late unmount failure.')),
    );
    await settle();
    await advance(MINUTE);
    expect(pendingListAttempts).toHaveBeenCalledTimes(3);
  });

  it.each([
    { context: 'current', callbackResult: true },
    { context: 'stale', callbackResult: false },
  ])(
    'routes $context authentication failure through the current callback and follows its recovery decision',
    async ({ context, callbackResult }) => {
      vi.useFakeTimers();
      vi.setSystemTime(TEST_NOW);
      const onAuthRequired = vi.fn<ApiAuthRequired>().mockReturnValue(callbackResult);
      const listAttempts = vi
        .fn()
        .mockResolvedValueOnce({
          attempts: [summary(`auth-${context}`)],
          nextCursor: `cursor-${context}`,
        })
        .mockResolvedValueOnce({ attempts: [] })
        .mockRejectedValueOnce(
          new AttemptApiFailure('authentication', 'Session expired.', 401, false, {
            authContext: 42,
          }),
        )
        .mockResolvedValueOnce({ attempts: [summary(`recovered-${context}`)] });
      mountWorkspace({ listAttempts }, { onAuthRequired });
      await settle();
      selectSurface('Historial');
      await settle();
      fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
      await settle();
      expect(onAuthRequired).toHaveBeenCalledOnce();
      expect(onAuthRequired).toHaveBeenCalledWith(42);
      const readsAfterAuthFailure = listAttempts.mock.calls.length;
      if (!callbackResult) {
        await advance(MINUTE - 1);
        expect(listAttempts).toHaveBeenCalledTimes(readsAfterAuthFailure);
        await advance(1);
        expect(listAttempts).toHaveBeenCalledTimes(readsAfterAuthFailure + 1);
        expect(listAttempts.mock.calls.at(-1)?.[0]).toBe(`cursor-${context}`);
        await advance(2 * MINUTE);
        expect(listAttempts).toHaveBeenCalledTimes(readsAfterAuthFailure + 1);
        selectSurface('Preparar');
        await settle();
        expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
          false,
        );
      } else {
        await advance(2 * MINUTE);
        expect(listAttempts).toHaveBeenCalledTimes(readsAfterAuthFailure);
      }
    },
  );

  it('treats gateway 429 as a transient history read without changing quota or starting an attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi.fn().mockResolvedValue({
      day: '2026-10-28',
      used: 83,
      limit: 100,
      remaining: 17,
      resetsAt: new Date(Date.now() + 30 * 24 * 60 * MINUTE).toISOString(),
    });
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [summary('quota-row')], nextCursor: 'cursor-gateway' })
      .mockResolvedValueOnce({ attempts: [] })
      .mockRejectedValueOnce(new AttemptApiFailure('attempt_unavailable', 'Gateway busy.', 429))
      .mockResolvedValueOnce({ attempts: [summary('quota-row-2')] });
    const { runner, drafts } = mountWorkspace({ listAttempts, getQuota });
    await settle();
    selectSurface('Historial');
    await settle();
    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    const draftBefore = instructions.value;
    const quotaCallsBefore = getQuota.mock.calls.length;
    fireEvent.click(within(historySection()).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    expect(screen.getByLabelText('Cuota: 17 de 100 intentos disponibles')).toBeTruthy();
    await advance(MINUTE);

    expect(screen.getByLabelText('Cuota: 17 de 100 intentos disponibles')).toBeTruthy();
    expect(getQuota).toHaveBeenCalledTimes(quotaCallsBefore);
    expect(instructions.value).toBe(draftBefore);
    expect(drafts.putDraft).not.toHaveBeenCalled();
    expect(runner.createAttempt).not.toHaveBeenCalled();
    expect(runner.startAttempt).not.toHaveBeenCalled();
    expect(runner.cancelAttempt).not.toHaveBeenCalled();
    expect(runner.completePresentation).not.toHaveBeenCalled();
    expect(listAttempts.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      undefined,
      'cursor-gateway',
      'cursor-gateway',
    ]);
  });
});
