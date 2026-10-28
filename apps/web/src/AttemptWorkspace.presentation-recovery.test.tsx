// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { StrictMode, type RefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import type { AttemptSummary, DecisionIndex, ReplayRecordView } from '../../../shared/attempt.js';
import type { AuthSession } from './auth.js';
import { AttemptApiFailure, isTransientReadFailure, type AttemptApi } from './attempt-api.js';
import { AttemptActivityHarness as AttemptActivity } from './AttemptActivity.test-support.js';
import {
  historyActionForRow,
  historySection,
  openHistoryActionMenus,
} from './History.test-support.js';
import type { AttemptActivityHandle } from './useAttemptActivity.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { writeAttemptRecovery } from './attempt-recovery.js';
import { doorVictoryRecord } from './replay/replay.test-support.js';

vi.mock('./replay/ReplayScene.js', () => ({
  ReplayScene: ({
    onReady,
    onComplete,
    onError,
  }: {
    onReady: () => void;
    onComplete: () => void;
    onError: (error: Error) => void;
  }) => (
    <div>
      <button type="button" onClick={onReady}>
        Recursos listos
      </button>
      <button type="button" onClick={onComplete}>
        Completar reproducción
      </button>
      <button type="button" onClick={() => onError(new Error('Faltan símbolos'))}>
        Fallar reproducción
      </button>
    </div>
  ),
}));

const ACCOUNT = 'subject-a';
const ACK_DELAY = 60_000;

function session(sub = ACCOUNT): AuthSession {
  return {
    identity: { sub, email: `${sub}@example.com` },
    user: new User({
      access_token: `token-${sub}`,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
        sub,
        email: `${sub}@example.com`,
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

function attempt(
  id: string,
  status: AttemptSummary['status'] = 'victory',
  presentationComplete = false,
): AttemptSummary {
  return {
    id,
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:01.000Z',
    status,
    cancelRequested: false,
    levelId: LEVEL.id,
    modelKey: 'claude-sonnet-4.6',
    modelLabel: 'Claude Sonnet 4.6',
    modelId: 'global.anthropic.claude-sonnet-4-6',
    turnsUsed: 8,
    maxTurns: LEVEL.maxTurns,
    calls: 8,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    gameTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    score: null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: 1,
    finalSupport: LEVEL.exit.support,
    animationEnabled: true,
    presentationComplete,
    recordComplete: true,
  };
}

function replayRecord(id: string, status: AttemptSummary['status'] = 'victory'): ReplayRecordView {
  const source = doorVictoryRecord();
  const snapshots = source.snapshots.slice(0, 9);
  const actions = source.actions.slice(0, 8);
  return {
    recordVersion: source.recordVersion,
    id,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    config: { level: source.config.level },
    snapshots,
    actions,
    closure: {
      ...source.closure,
      status,
      actionCount: actions.length,
      finalStateId: snapshots.at(-1)!.id,
    },
    metrics: source.metrics,
    score: source.score,
  };
}

function api(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi.fn().mockResolvedValue({
      attempt: attempt('attempt-b', 'running', true),
      dispatchConfirmed: true,
    }),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'No se encontró.', 404)),
    getAttempt: vi.fn().mockImplementation((id: string) => Promise.resolve(attempt(id))),
    getConfiguration: vi.fn(),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 0 }),
    putAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 1 }),
    startAttempt: vi.fn().mockResolvedValue({
      attempt: attempt('attempt-b', 'running', true),
      dispatchConfirmed: true,
    }),
    cancelAttempt: vi.fn().mockResolvedValue(attempt('attempt-b', 'cancelled', true)),
    getReplay: vi.fn().mockImplementation((id: string) => Promise.resolve(replayRecord(id))),
    getDecisionIndex: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve<DecisionIndex>({ attemptId: id, levelId: LEVEL.id, decisions: [] }),
      ),
    getDecision: vi.fn(),
    completePresentation: vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(attempt(id, 'victory', true))),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-09-21',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
    ...overrides,
  };
}

function editorWithSnapshot(): RefObject<RobotEditorHandle | null> {
  return {
    current: {
      captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    } as unknown as RobotEditorHandle,
  } as RefObject<RobotEditorHandle | null>;
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

function storeForegroundAttempt(id: string, sub = ACCOUNT): void {
  writeAttemptRecovery({ sub, attemptId: id });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 32; index += 1) await Promise.resolve();
  });
}

async function mountAndFinish(
  apiClient: AttemptApi,
  pending: AttemptSummary,
  options: {
    readonly ref?: RefObject<AttemptActivityHandle | null>;
    readonly editor?: RefObject<RobotEditorHandle | null>;
    readonly onAuthRequired?: (authContext?: number) => boolean | void;
    readonly authPaused?: boolean;
    readonly strict?: boolean;
    readonly fakeTimersBeforeFinish?: boolean;
  } = {},
) {
  storeForegroundAttempt(pending.id);
  const editor = options.editor ?? ({ current: null } as RefObject<RobotEditorHandle | null>);
  const workspace = (
    <AttemptActivity
      ref={options.ref}
      api={apiClient}
      editor={editor}
      session={session()}
      accessState="ready"
      authPaused={options.authPaused}
      onAuthRequired={options.onAuthRequired}
    />
  );
  const view = render(options.strict ? <StrictMode>{workspace}</StrictMode> : workspace);
  await screen.findByRole('button', { name: 'Completar reproducción' });
  if (options.fakeTimersBeforeFinish) vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
  fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
  await settle();
  expect(
    screen.getByRole('heading', {
      name: pending.status === 'victory' ? 'Victoria' : 'Recorrido incompleto',
    }),
  ).toBeTruthy();
  return view;
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AttemptActivity presentation ACK recovery', () => {
  it('retries a known transient POST rejection every minute without exhaustion or a manual retry', async () => {
    const pending = attempt('attempt-a');
    const completed = attempt('attempt-a', 'victory', true);
    const firstPost = deferred<AttemptSummary>();
    const completePresentation = vi.fn();
    completePresentation.mockReturnValueOnce(firstPost.promise);
    for (let failure = 0; failure < 8; failure += 1) {
      completePresentation.mockRejectedValueOnce(
        new AttemptApiFailure('attempt_unavailable', 'Gateway limitado.', 429),
      );
    }
    completePresentation.mockResolvedValueOnce(completed);
    const getAttempt = vi.fn().mockResolvedValue(pending);
    const getReplay = vi.fn().mockResolvedValue(replayRecord(pending.id));
    const editor = editorWithSnapshot();
    const attemptApi = api({
      getAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      getReplay,
      completePresentation,
    });

    await mountAndFinish(attemptApi, pending, {
      editor,
      fakeTimersBeforeFinish: true,
    });
    await settle();
    expect(completePresentation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();

    const recovery = JSON.parse(
      window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}',
    ) as Record<string, unknown>;
    expect(recovery).toMatchObject({ sub: ACCOUNT, attemptId: pending.id });
    expect(recovery).not.toHaveProperty('presentationSeen');
    expect(recovery).not.toHaveProperty('acknowledgedLocally');

    await act(async () => vi.advanceTimersByTimeAsync(35_000));
    expect(completePresentation).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstPost.reject(new AttemptApiFailure('attempt_unavailable', 'Gateway limitado.', 429));
      await Promise.resolve();
    });
    await settle();

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('resize'));
    });
    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY - 20_001));
    expect(completePresentation).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(completePresentation).toHaveBeenCalledTimes(2);

    for (let retry = 0; retry < 7; retry += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY));
      await settle();
      expect(completePresentation).toHaveBeenCalledTimes(retry + 3);
    }
    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY));
    await settle();
    expect(completePresentation).toHaveBeenCalledTimes(10);
    expect(completePresentation.mock.calls.every(([id]) => id === pending.id)).toBe(true);
    expect(getAttempt).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(3 * ACK_DELAY));
    await settle();
    expect(completePresentation).toHaveBeenCalledTimes(10);
    expect(getAttempt).toHaveBeenCalledTimes(1);
    expect(getReplay).toHaveBeenCalledOnce();
    expect(editor.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(attemptApi.startAttempt).not.toHaveBeenCalled();
    expect(attemptApi.cancelAttempt).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a malformed 2xx response',
      true,
      1,
      new AttemptApiFailure('server', 'Malformed success.', 200, true),
    ],
    [
      'the server still reports pending after network loss',
      false,
      2,
      new AttemptApiFailure('network', 'Respuesta perdida.', undefined, true),
    ],
  ])(
    'reconciles an uncertain POST after %s',
    async (_label, readbackComplete, expectedPosts, ambiguousPost) => {
      const pending = attempt('attempt-a');
      const confirmed = attempt('attempt-a', 'victory', true);
      if (ambiguousPost.code === 'server') {
        expect(isTransientReadFailure(ambiguousPost)).toBe(false);
      }
      const completePresentation = vi
        .fn()
        .mockRejectedValueOnce(ambiguousPost)
        .mockResolvedValueOnce(confirmed);
      const getAttempt = vi
        .fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(attempt('attempt-a', 'victory', readbackComplete));
      const attemptApi = api({
        getAttempt,
        listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
        completePresentation,
      });

      await mountAndFinish(attemptApi, pending, { fakeTimersBeforeFinish: true });
      await settle();
      expect(completePresentation).toHaveBeenCalledOnce();
      expect(getAttempt).toHaveBeenCalledTimes(1);

      await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY - 1));
      expect(getAttempt).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      await settle();

      expect(getAttempt).toHaveBeenCalledTimes(2);
      expect(getAttempt.mock.calls[1]).toEqual([pending.id, expect.any(AbortSignal)]);
      expect(completePresentation).toHaveBeenCalledTimes(expectedPosts);
      if (readbackComplete) {
        await act(async () => vi.advanceTimersByTimeAsync(2 * ACK_DELAY));
        await settle();
        expect(getAttempt).toHaveBeenCalledTimes(2);
        expect(completePresentation).toHaveBeenCalledTimes(1);
      } else {
        expect(completePresentation.mock.calls.at(-1)?.[0]).toBe(pending.id);
      }
      expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Reintentar cierre/ })).toBeNull();
    },
  );

  it('keeps one reconciliation GET in flight across rerender, focus, and resize', async () => {
    const pending = attempt('attempt-a');
    const readback = deferred<AttemptSummary>();
    const completePresentation = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('network', 'Respuesta perdida.', undefined, true),
      );
    const getAttempt = vi.fn().mockResolvedValueOnce(pending).mockReturnValueOnce(readback.promise);
    const attemptApi = api({
      getAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation,
    });
    storeForegroundAttempt(pending.id);
    const editor = { current: null } as RefObject<RobotEditorHandle | null>;
    const props = {
      api: attemptApi,
      editor,
      session: session(),
      accessState: 'ready' as const,
    };
    const view = render(<AttemptActivity {...props} />);
    await screen.findByRole('button', { name: 'Completar reproducción' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settle();
    expect(completePresentation).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY));
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenCalledOnce();
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('resize'));
    });
    view.rerender(<AttemptActivity {...props} />);
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenCalledOnce();

    await act(async () => {
      readback.resolve(attempt(pending.id, 'victory', true));
      await Promise.resolve();
    });
    await settle();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(3 * ACK_DELAY));
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenCalledOnce();
  });

  it.each(['focus', 'visibilitychange'] as const)(
    'runs one overdue ACK retry on %s without advancing the timer queue',
    async (wakeEvent) => {
      const pending = attempt('attempt-a');
      const completePresentation = vi
        .fn()
        .mockRejectedValueOnce(new AttemptApiFailure('attempt_unavailable', '429', 429))
        .mockResolvedValueOnce(attempt(pending.id, 'victory', true));
      const attemptApi = api({
        getAttempt: vi.fn().mockResolvedValue(pending),
        listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
        completePresentation,
      });

      await mountAndFinish(attemptApi, pending, { fakeTimersBeforeFinish: true });
      expect(completePresentation).toHaveBeenCalledOnce();
      // Simulate a public browser wake event after moving wall time past the deadline.
      await act(async () => {
        vi.setSystemTime(Date.now() + ACK_DELAY + 1);
        if (wakeEvent === 'focus') {
          window.dispatchEvent(new Event('focus'));
        } else {
          document.dispatchEvent(new Event('visibilitychange'));
        }
        await Promise.resolve();
      });
      await settle();
      expect(completePresentation).toHaveBeenCalledTimes(2);
      act(() => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('resize'));
      });
      await settle();
      expect(completePresentation).toHaveBeenCalledTimes(2);
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
    },
  );

  it('reconciles a transient GET failure, retries the same POST, and ignores a foreign POST summary', async () => {
    const pending = attempt('attempt-a');
    const foreignPost = attempt('attempt-b', 'incomplete', true);
    const completePresentation = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Respuesta incierta.', 503, true))
      .mockResolvedValueOnce(foreignPost);
    const getAttempt = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'GET falló.', 503))
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(attempt('attempt-a', 'victory', true));
    const attemptApi = api({
      getAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation,
    });

    await mountAndFinish(attemptApi, pending, { fakeTimersBeforeFinish: true });
    await settle();

    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY - 1));
    expect(getAttempt).toHaveBeenCalledTimes(1);
    expect(completePresentation).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY));
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(3);
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(completePresentation.mock.calls.map(([id]) => id)).toEqual([pending.id, pending.id]);
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY));
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(4);
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recorrido incompleto' })).toBeNull();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(attemptApi.startAttempt).not.toHaveBeenCalled();
    expect(attemptApi.cancelAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['a foreign attempt', attempt('attempt-b', 'incomplete', true)],
    ['a nonterminal summary', attempt('attempt-a', 'running', false)],
  ])('stops reconciliation when GET returns %s', async (_label, invalidReadback) => {
    const pending = attempt('attempt-a');
    const pendingB = attempt('attempt-b', 'incomplete', false);
    const completePresentation = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'Respuesta incierta.', undefined, true));
    const getAttempt = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(invalidReadback);
    const attemptApi = api({
      getAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending, pendingB] }),
      completePresentation,
    });

    await mountAndFinish(attemptApi, pending, { fakeTimersBeforeFinish: true });
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY));
    await settle();

    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Recorrido incompleto' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reintentar cierre/ })).toBeNull();
    expect(screen.getByRole('alert').textContent?.trim()).not.toBe('');
    const history = historySection();
    await historyActionForRow('Abrir', 'Recorrido incompleto');
    const incompleteRow = within(history)
      .getAllByRole('listitem')
      .find((row) => row.textContent?.includes('Recorrido incompleto'));
    expect(incompleteRow).toBeTruthy();
    openHistoryActionMenus(incompleteRow!);
    expect(
      within(incompleteRow!).queryByRole('button', { name: 'Inspeccionar decisiones' }),
    ).toBeNull();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(attemptApi.startAttempt).not.toHaveBeenCalled();
    expect(attemptApi.cancelAttempt).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(3 * ACK_DELAY));
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenCalledOnce();
  });

  it('keeps A and B ACKs independent while C is inspected; A settlement updates only A', async () => {
    const pendingA = attempt('attempt-a');
    const pendingB = attempt('attempt-b', 'incomplete');
    const completeC = attempt('attempt-c', 'defeat', true);
    const aFirst = deferred<AttemptSummary>();
    const bFirst = deferred<AttemptSummary>();
    const aRetry = deferred<AttemptSummary>();
    const bRetry = deferred<AttemptSummary>();
    let aCalls = 0;
    let bCalls = 0;
    const completePresentation = vi.fn((id: string) => {
      if (id === pendingA.id) {
        aCalls += 1;
        return aCalls === 1 ? aFirst.promise : aRetry.promise;
      }
      if (id === pendingB.id) {
        bCalls += 1;
        return bCalls === 1 ? bFirst.promise : bRetry.promise;
      }
      return Promise.reject(new Error(`Unexpected ACK for ${id}`));
    });
    const attemptApi = api({
      createAttempt: vi.fn().mockResolvedValue({ attempt: pendingB, dispatchConfirmed: true }),
      getAttempt: vi.fn().mockResolvedValue(pendingA),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pendingA, pendingB, completeC] }),
      getReplay: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(replayRecord(id, id === pendingB.id ? 'incomplete' : 'victory')),
        ),
      completePresentation,
      getDecisionIndex: vi.fn().mockResolvedValue({
        attemptId: completeC.id,
        levelId: LEVEL.id,
        decisions: [],
      }),
    });
    const ref = { current: null } as RefObject<AttemptActivityHandle | null>;
    const editor = editorWithSnapshot();
    await mountAndFinish(attemptApi, pendingA, {
      ref,
      editor,
      fakeTimersBeforeFinish: true,
    });
    await settle();
    expect(completePresentation).toHaveBeenCalledTimes(1);

    act(() => ref.current?.start());
    await settle();
    expect(attemptApi.createAttempt).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Recorrido incompleto' })).toBeTruthy();
    expect(completePresentation.mock.calls.map(([id]) => id)).toEqual([pendingA.id, pendingB.id]);
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toMatchObject({ sub: ACCOUNT, attemptId: pendingB.id });

    fireEvent.click(await historyActionForRow('Inspeccionar decisiones', 'Derrota'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await settle();
    expect(screen.getByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    const focusBeforeA = document.activeElement;

    await act(async () => {
      aFirst.reject(new AttemptApiFailure('attempt_unavailable', '429', 429));
      await Promise.resolve();
    });
    await settle();
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => {
      bFirst.reject(new AttemptApiFailure('attempt_unavailable', '429', 429));
      await Promise.resolve();
    });
    await settle();
    expect(completePresentation.mock.calls.map(([id]) => id)).toEqual([pendingA.id, pendingB.id]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toMatchObject({ sub: ACCOUNT, attemptId: pendingB.id });

    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    await settle();
    expect(completePresentation.mock.calls.map(([id]) => id)).toEqual([
      pendingA.id,
      pendingB.id,
      pendingA.id,
    ]);
    await act(async () => {
      aRetry.resolve(attempt(pendingA.id, 'victory', true));
      await Promise.resolve();
    });
    await settle();
    await waitForHistoryAction('Inspeccionar decisiones');
    expect(screen.getByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recorrido incompleto' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(focusBeforeA);
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toMatchObject({ sub: ACCOUNT, attemptId: pendingB.id });

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    await settle();
    expect(completePresentation.mock.calls.map(([id]) => id)).toEqual([
      pendingA.id,
      pendingB.id,
      pendingA.id,
      pendingB.id,
    ]);
    await act(async () => {
      bRetry.resolve(attempt(pendingB.id, 'incomplete', true));
      await Promise.resolve();
    });
    await settle();
    expect(attemptApi.createAttempt).toHaveBeenCalledOnce();
    expect(editor.current?.captureSnapshot).toHaveBeenCalledOnce();
    expect(attemptApi.startAttempt).not.toHaveBeenCalled();
    expect(attemptApi.cancelAttempt).not.toHaveBeenCalled();
    expect(attemptApi.getDecisionIndex).toHaveBeenCalledOnce();
  });

  it('pauses a scheduled retry, then reconciles the same identity once on resume', async () => {
    const pending = attempt('attempt-a');
    const confirmed = attempt(pending.id, 'victory', true);
    let readback = pending;
    const getAttempt = vi.fn<AttemptApi['getAttempt']>(() => Promise.resolve(readback));
    const completePresentation = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('attempt_unavailable', 'Gateway limitado.', 429),
      );
    const attemptApi = api({
      getAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation,
    });
    storeForegroundAttempt(pending.id);
    const editor = { current: null } as RefObject<RobotEditorHandle | null>;
    const view = render(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} accessState="ready" />,
    );
    await screen.findByRole('button', { name: 'Completar reproducción' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settle();
    expect(completePresentation).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    const getCallsBeforePause = getAttempt.mock.calls.length;
    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        accessState="ready"
        authPaused
      />,
    );
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(getCallsBeforePause);
    expect(completePresentation).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY + 1));
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(getCallsBeforePause);
    expect(completePresentation).toHaveBeenCalledOnce();

    readback = confirmed;
    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        accessState="ready"
        authPaused={false}
      />,
    );
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(getCallsBeforePause + 1);
    expect(getAttempt).toHaveBeenLastCalledWith(pending.id, expect.any(AbortSignal));
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(3 * ACK_DELAY));
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(getCallsBeforePause + 1);
    expect(completePresentation).toHaveBeenCalledOnce();
  });

  it('aborts a POST on auth pause and resumes the same identity with GET before POST', async () => {
    const pending = attempt('attempt-a');
    const completed = attempt('attempt-a', 'victory', true);
    const postSignals: AbortSignal[] = [];
    const firstPost = vi.fn((_id: string, signal?: AbortSignal) => {
      if (signal) postSignals.push(signal);
      return new Promise<AttemptSummary>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    });
    const eventOrder: string[] = [];
    const resumedApi = api({
      getAttempt: vi.fn<AttemptApi['getAttempt']>(() => {
        eventOrder.push('GET');
        return Promise.resolve(pending);
      }),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation: vi.fn<AttemptApi['completePresentation']>(() => {
        eventOrder.push('POST');
        return Promise.resolve(completed);
      }),
    });
    const initialApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation: firstPost,
    });
    storeForegroundAttempt(pending.id);
    const editor = { current: null } as RefObject<RobotEditorHandle | null>;
    const view = render(
      <AttemptActivity api={initialApi} editor={editor} session={session()} accessState="ready" />,
    );
    await screen.findByRole('button', { name: 'Completar reproducción' });
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await screen.findByRole('heading', { name: 'Victoria' });
    await settle();
    expect(firstPost).toHaveBeenCalledOnce();
    expect(postSignals[0]).toBeInstanceOf(AbortSignal);

    view.rerender(
      <AttemptActivity
        api={resumedApi}
        editor={editor}
        session={session()}
        accessState="ready"
        authPaused
      />,
    );
    await settle();
    expect(postSignals[0]?.aborted).toBe(true);
    expect(resumedApi.getAttempt).not.toHaveBeenCalled();
    expect(resumedApi.completePresentation).not.toHaveBeenCalled();

    view.rerender(
      <AttemptActivity
        api={resumedApi}
        editor={editor}
        session={session()}
        accessState="ready"
        authPaused={false}
      />,
    );
    await settle();
    expect(eventOrder[0]).toBe('GET');
    expect(eventOrder.indexOf('GET')).toBeLessThan(eventOrder.indexOf('POST'));
    expect(resumedApi.getAttempt).toHaveBeenCalledWith(pending.id, expect.any(AbortSignal));
    expect(resumedApi.completePresentation).toHaveBeenCalledWith(
      pending.id,
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
  });

  it('aborts a reconciliation GET on auth pause and resumes with a fresh GET before POST', async () => {
    const pending = attempt('attempt-a');
    const firstRead = deferred<AttemptSummary>();
    const getSignals: AbortSignal[] = [];
    let getCalls = 0;
    const getAttempt = vi.fn((_id: string, signal?: AbortSignal) => {
      getCalls += 1;
      if (getCalls === 1 || getCalls >= 3) return Promise.resolve(pending);
      if (signal) getSignals.push(signal);
      return new Promise<AttemptSummary>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
        firstRead.promise.then(_resolve, reject);
      });
    });
    const completePresentation = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('network', 'Respuesta perdida.', undefined, true),
      )
      .mockResolvedValueOnce(attempt(pending.id, 'victory', true));
    const attemptApi = api({
      getAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation,
    });
    storeForegroundAttempt(pending.id);
    const editor = { current: null } as RefObject<RobotEditorHandle | null>;
    const view = render(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} accessState="ready" />,
    );
    await screen.findByRole('button', { name: 'Completar reproducción' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settle();
    expect(completePresentation).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY));
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getSignals[0]).toBeInstanceOf(AbortSignal);

    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        accessState="ready"
        authPaused
      />,
    );
    await settle();
    expect(getSignals[0]?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(2 * ACK_DELAY));
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenCalledOnce();

    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        accessState="ready"
        authPaused={false}
      />,
    );
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(3);
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(completePresentation.mock.calls.map(([id]) => id)).toEqual([pending.id, pending.id]);
  });

  it('does not pause for a stale authContext and retries through the current API', async () => {
    const pending = attempt('attempt-a');
    const onAuthRequired = vi.fn().mockReturnValue(false);
    const oldApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation: vi.fn().mockRejectedValue(
        new AttemptApiFailure('authentication', 'Old token.', 401, false, {
          authContext: 1,
        }),
      ),
    });
    const currentApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation: vi.fn().mockResolvedValue(attempt(pending.id, 'victory', true)),
    });

    await mountAndFinish(oldApi, pending, {
      onAuthRequired,
      fakeTimersBeforeFinish: true,
    });
    await settle();
    expect(onAuthRequired).toHaveBeenCalledWith(1);
    expect(oldApi.completePresentation).toHaveBeenCalledOnce();

    Object.assign(oldApi, {
      completePresentation: currentApi.completePresentation,
    });
    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY));
    await settle();
    expect(oldApi.completePresentation).toHaveBeenCalledWith(pending.id, expect.any(AbortSignal));
    expect(oldApi.completePresentation).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'authentication',
      new AttemptApiFailure('authentication', 'Rejected.', 401, false, { authContext: 19 }),
    ],
    ['invalid input', new AttemptApiFailure('invalid', 'Invalid.', 400)],
    ['missing attempt', new AttemptApiFailure('not_found', 'Missing.', 404)],
    ['conflict', new AttemptApiFailure('conflict', 'Conflict.', 409)],
  ])('does not retry a definitive %s ACK rejection', async (label, failure) => {
    const pending = attempt('attempt-a');
    const onAuthRequired = vi.fn().mockReturnValue(true);
    const completePresentation = vi.fn().mockRejectedValue(failure);
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation,
    });

    await mountAndFinish(attemptApi, pending, {
      onAuthRequired,
      fakeTimersBeforeFinish: true,
    });
    expect(completePresentation).toHaveBeenCalledOnce();
    if (label === 'authentication') expect(onAuthRequired).toHaveBeenCalledWith(19);
    await act(async () => vi.advanceTimersByTimeAsync(5 * ACK_DELAY));
    await settle();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Reintentar cierre/ })).toBeNull();
  });

  it.each(['identity change', 'unmount'] as const)(
    'aborts the old identity ACK and ignores its late result after %s',
    async (exit) => {
      const pending = attempt('attempt-a');
      const lateResult = deferred<AttemptSummary>();
      const postSignals: AbortSignal[] = [];
      const completePresentation = vi.fn((_id: string, signal?: AbortSignal) => {
        if (signal) postSignals.push(signal);
        return lateResult.promise;
      });
      const attemptApi = api({
        getAttempt: vi.fn().mockResolvedValue(pending),
        listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
        completePresentation,
      });
      storeForegroundAttempt(pending.id);
      const editor = { current: null } as RefObject<RobotEditorHandle | null>;
      const view = render(
        <AttemptActivity
          api={attemptApi}
          editor={editor}
          session={session()}
          accessState="ready"
        />,
      );
      await screen.findByRole('button', { name: 'Completar reproducción' });
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
      fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
      await settle();
      expect(completePresentation).toHaveBeenCalledOnce();
      expect(postSignals[0]).toBeInstanceOf(AbortSignal);

      if (exit === 'identity change') {
        view.rerender(
          <AttemptActivity
            api={attemptApi}
            editor={editor}
            session={session('subject-b')}
            accessState="ready"
          />,
        );
        await settle();
        expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
      } else {
        view.unmount();
        expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toBeNull();
      }
      expect(postSignals[0]?.aborted).toBe(true);

      await act(async () => {
        lateResult.resolve(attempt(pending.id, 'victory', true));
        await Promise.resolve();
      });
      await act(async () => vi.advanceTimersByTimeAsync(3 * ACK_DELAY));
      expect(completePresentation).toHaveBeenCalledOnce();
      if (exit === 'unmount') {
        expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toBeNull();
      }
    },
  );

  it('registers one ACK in StrictMode after local automatic presentation completion', async () => {
    const pending = attempt('attempt-a');
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      completePresentation: vi.fn().mockResolvedValue(attempt(pending.id, 'victory', true)),
    });

    await mountAndFinish(attemptApi, pending, { strict: true });
    expect(attemptApi.completePresentation).toHaveBeenCalledOnce();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(attemptApi.startAttempt).not.toHaveBeenCalled();
    expect(attemptApi.cancelAttempt).not.toHaveBeenCalled();
  });
});

async function waitForHistoryAction(actionName: string): Promise<HTMLButtonElement> {
  return historyActionForRow(actionName, 'Victoria');
}
