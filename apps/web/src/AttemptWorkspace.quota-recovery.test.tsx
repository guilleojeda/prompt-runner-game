// @vitest-environment jsdom

import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import { modelByKey } from '../../../shared/models.js';
import type { AuthSession } from './auth.js';
import {
  AttemptApiFailure,
  type AttemptApi,
  type AttemptSummary,
  type QuotaSummary,
} from './attempt-api.js';
import { AttemptActivityHarness as AttemptActivity } from './AttemptActivity.test-support.js';
import type { AttemptActivityHandle } from './useAttemptActivity.js';
import type { RobotEditorHandle } from './RobotEditor.js';

const MINUTE = 60_000;
const LONG_RENEWAL = 30 * 24 * 60 * 60_000;
const TEST_NOW = new Date('2026-10-26T12:00:00.000Z');
const healthyPreference = { animationEnabled: true, version: 0 };

function session(sub = 'subject-a', accessToken = `token-${sub}`): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub, email: `${sub}@example.com` },
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
        email: `${sub}@example.com`,
      },
    }),
  };
}

function quota(
  remaining: number,
  resetsAt = new Date(Date.now() + LONG_RENEWAL).toISOString(),
): QuotaSummary {
  return {
    day: new Date(Date.now()).toISOString().slice(0, 10),
    used: 100 - remaining,
    limit: 100,
    remaining,
    resetsAt,
  };
}

function runningAttempt(): AttemptSummary {
  const model = modelByKey(createDefaultDraft().modelKey)!;
  return {
    id: 'quota-recovery-admitted-attempt',
    createdAt: new Date(Date.now()).toISOString(),
    updatedAt: new Date(Date.now()).toISOString(),
    status: 'running',
    cancelRequested: false,
    levelId: LEVEL.id,
    modelKey: model.key,
    modelLabel: model.label,
    modelId: model.modelId,
    turnsUsed: 0,
    maxTurns: LEVEL.maxTurns,
    calls: 0,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    gameTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    score: null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: 0,
    finalSupport: 0,
    animationEnabled: true,
    presentationComplete: true,
    recordComplete: true,
  };
}

function api(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    getAnimationPreference: vi.fn().mockResolvedValue(healthyPreference),
    putAnimationPreference: vi
      .fn()
      .mockImplementation(async (animationEnabled, expectedVersion) => ({
        animationEnabled,
        version: expectedVersion + 1,
      })),
    createAttempt: vi.fn(),
    getAttemptRequest: vi.fn(),
    getAttempt: vi.fn(),
    getConfiguration: vi.fn(),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getQuota: vi.fn().mockResolvedValue(quota(100)),
    ...overrides,
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

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
}

function mount(
  runner: AttemptApi,
  options: { activeSession?: AuthSession; authPaused?: boolean } = {},
) {
  const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
  return render(
    <AttemptActivity
      api={runner}
      editor={editor}
      session={options.activeSession ?? session()}
      authPaused={options.authPaused}
      accessState="ready"
    />,
  );
}

async function readyForAssertions(): Promise<void> {
  await settle();
  expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AttemptActivity quota recovery', () => {
  it('retries temporary quota failures every minute without a retry button or game side effects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    let readCount = 0;
    const transientFailures = [
      new AttemptApiFailure('network', 'Network unavailable.'),
      new AttemptApiFailure('server', 'Temporary server failure.', 503),
      new AttemptApiFailure('attempt_unavailable', 'Rate limited.', 429),
      new AttemptApiFailure('network', 'Gateway unavailable.'),
      new AttemptApiFailure('server', 'Temporary server failure.', 502),
    ];
    const getQuota = vi.fn().mockImplementation(async () => {
      readCount += 1;
      if (readCount <= 66) {
        throw transientFailures[(readCount - 1) % transientFailures.length];
      }
      return quota(17, new Date(Date.now() + 5 * MINUTE).toISOString());
    });
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [] });
    const captureSnapshot = vi.fn().mockResolvedValue({
      version: 1,
      draft: createDefaultDraft(),
    });
    const runner = api({ getQuota, listAttempts });
    const editor = { current: { captureSnapshot } } as unknown as {
      current: RobotEditorHandle | null;
    };
    render(
      <AttemptActivity api={runner} editor={editor} session={session()} accessState="ready" />,
    );

    await readyForAssertions();
    expect(getQuota).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/Cuota: 0 de/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Reintentar consultas|reintentar cuota/i }),
    ).toBeNull();

    for (let retryNumber = 2; retryNumber <= 67; retryNumber += 1) {
      await advance(MINUTE - 1);
      expect(getQuota).toHaveBeenCalledTimes(retryNumber - 1);
      await advance(1);
      expect(getQuota).toHaveBeenCalledTimes(retryNumber);
    }

    expect(screen.getByLabelText('Cuota: 17 de 100 intentos disponibles')).toBeTruthy();
    expect(listAttempts).toHaveBeenCalledTimes(2);
    expect(runner.createAttempt).not.toHaveBeenCalled();
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(runner.startAttempt).not.toHaveBeenCalled();
    expect(runner.cancelAttempt).not.toHaveBeenCalled();
    expect(runner.completePresentation).not.toHaveBeenCalled();
    expect(runner.getReplay).not.toHaveBeenCalled();
    expect(runner.getAnimationPreference).toHaveBeenCalledOnce();
    expect(runner.putAnimationPreference).not.toHaveBeenCalled();
  });

  it('starts its retry deadline when the failed request finishes and never overlaps a pending read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const failedRead = deferred<QuotaSummary>();
    const getQuota = vi
      .fn()
      .mockResolvedValueOnce(quota(9, new Date(Date.now() + 15_000).toISOString()))
      .mockReturnValueOnce(failedRead.promise)
      .mockResolvedValue(quota(8, new Date(Date.now() + 5 * MINUTE).toISOString()));
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [] });
    const runner = api({ getQuota, listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const activeSession = session();
    const view = render(
      <AttemptActivity api={runner} editor={editor} session={activeSession} accessState="ready" />,
    );

    await readyForAssertions();
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => window.dispatchEvent(new Event('resize')));
    expect(getQuota).toHaveBeenCalledTimes(1);
    await advance(15_000);
    expect(getQuota).toHaveBeenCalledTimes(2);

    act(() => window.dispatchEvent(new Event('focus')));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(3 * MINUTE);
    expect(getQuota).toHaveBeenCalledTimes(2);

    await act(async () => {
      failedRead.reject(new AttemptApiFailure('network', 'Delayed failure.'));
      await Promise.resolve();
    });
    await settle();
    const retainedBalance = screen.getByLabelText(/9 de 100 intentos disponibles/i);
    expect(retainedBalance.textContent).toMatch(/anterior|previa|no confirmada/i);
    expect(screen.queryByLabelText(/0 de 100 intentos disponibles/i)).toBeNull();

    await advance(30_000);
    view.rerender(
      <AttemptActivity api={runner} editor={editor} session={activeSession} accessState="ready" />,
    );
    act(() => window.dispatchEvent(new Event('resize')));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Animación' }));
    await settle();
    expect(runner.putAnimationPreference).toHaveBeenCalledOnce();
    expect(getQuota).toHaveBeenCalledTimes(2);
    await advance(29_999);
    expect(getQuota).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getQuota).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('Cuota: 8 de 100 intentos disponibles')).toBeTruthy();
    expect(listAttempts).toHaveBeenCalledTimes(2);
  });

  it('schedules each healthy refresh at the resetsAt returned by that response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi
      .fn()
      .mockImplementationOnce(async () => quota(12, new Date(Date.now() + 15_000).toISOString()))
      .mockImplementationOnce(async () => quota(11, new Date(Date.now() + 30_000).toISOString()))
      .mockImplementation(async () => quota(10, new Date(Date.now() + LONG_RENEWAL).toISOString()));
    mount(api({ getQuota }));

    await readyForAssertions();
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(getQuota).toHaveBeenCalledTimes(1);
    await advance(14_999);
    expect(getQuota).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Cuota: 11 de 100 intentos disponibles')).toBeTruthy();

    act(() => window.dispatchEvent(new Event('focus')));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => window.dispatchEvent(new Event('resize')));
    await advance(29_999);
    expect(getQuota).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getQuota).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('Cuota: 10 de 100 intentos disponibles')).toBeTruthy();
  });

  it('does not accept an already-expired successful response or immediately repeat it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi
      .fn()
      .mockResolvedValueOnce(quota(0, new Date(Date.now() - 1).toISOString()))
      .mockResolvedValue(quota(4, new Date(Date.now() + LONG_RENEWAL).toISOString()));
    mount(api({ getQuota }));

    await readyForAssertions();
    expect(getQuota).toHaveBeenCalledOnce();
    const previousZero = screen.getByLabelText(/0 de 100 intentos disponibles/i);
    expect(previousZero.textContent).toMatch(/anterior|previa|no confirmada/i);
    expect(screen.queryByText('No quedan partidas disponibles.')).toBeNull();
    await advance(MINUTE - 1);
    expect(getQuota).toHaveBeenCalledOnce();
    await advance(1);
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Cuota: 4 de 100 intentos disponibles')).toBeTruthy();
  });

  it('handles an overdue wake with one read and does not retain an expired timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const overdueRead = deferred<QuotaSummary>();
    const getQuota = vi
      .fn()
      .mockResolvedValueOnce(quota(5, new Date(Date.now() + MINUTE).toISOString()))
      .mockReturnValueOnce(overdueRead.promise)
      .mockResolvedValue(quota(4, new Date(Date.now() + 30_000).toISOString()));
    mount(api({ getQuota }));

    await readyForAssertions();
    vi.setSystemTime(new Date(TEST_NOW.getTime() + MINUTE));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(getQuota).toHaveBeenCalledTimes(2);

    await advance(MINUTE);
    expect(getQuota).toHaveBeenCalledTimes(2);
    await act(async () => {
      overdueRead.resolve(quota(4, new Date(Date.now() + 30_000).toISOString()));
      await Promise.resolve();
    });
    await settle();
    await advance(30_000);
    expect(getQuota).toHaveBeenCalledTimes(3);
  });

  it('aborts and invalidates an old account read without replacing the newer balance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const oldRead = deferred<QuotaSummary>();
    const getQuota = vi
      .fn()
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(quota(7, new Date(Date.now() + LONG_RENEWAL).toISOString()));
    const runner = api({ getQuota });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptActivity api={runner} editor={editor} session={session()} accessState="ready" />,
    );

    await readyForAssertions();
    const oldSignal = getQuota.mock.calls[0]?.[0];
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    view.rerender(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session('subject-b', 'token-subject-b')}
        accessState="ready"
      />,
    );
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    expect(getQuota).toHaveBeenCalledTimes(2);
    const newSignal = getQuota.mock.calls[1]?.[0];
    expect(newSignal).toBeInstanceOf(AbortSignal);
    expect(screen.getByLabelText('Cuota: 7 de 100 intentos disponibles')).toBeTruthy();

    await act(async () => {
      oldRead.resolve(quota(99));
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Cuota: 7 de 100 intentos disponibles')).toBeTruthy();
    expect(screen.queryByLabelText('Cuota: 99 de 100 intentos disponibles')).toBeNull();

    expect(newSignal?.aborted).toBe(false);
  });

  it('aborts an outstanding quota read when the workspace unmounts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const pendingRead = deferred<QuotaSummary>();
    const getQuota = vi.fn().mockReturnValue(pendingRead.promise);
    const view = mount(api({ getQuota }));

    await readyForAssertions();
    const signal = getQuota.mock.calls[0]?.[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      pendingRead.resolve(quota(100));
      await Promise.resolve();
    });
  });

  it('pauses a same-identity quota read and refreshes after access resumes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const pausedRead = deferred<QuotaSummary>();
    const getQuota = vi
      .fn()
      .mockReturnValueOnce(pausedRead.promise)
      .mockResolvedValueOnce(quota(23, new Date(Date.now() + 5 * MINUTE).toISOString()));
    const runner = api({ getQuota });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptActivity api={runner} editor={editor} session={session()} accessState="ready" />,
    );

    await readyForAssertions();
    const firstSignal = getQuota.mock.calls[0]?.[0];
    view.rerender(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session()}
        authPaused
        accessState="required"
      />,
    );
    await settle();
    expect(firstSignal?.aborted).toBe(true);

    view.rerender(
      <AttemptActivity api={runner} editor={editor} session={session()} accessState="ready" />,
    );
    await settle();
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Cuota: 23 de 100 intentos disponibles')).toBeTruthy();
    await act(async () => {
      pausedRead.resolve(quota(100));
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Cuota: 23 de 100 intentos disponibles')).toBeTruthy();
  });

  it('cancels a scheduled expiry read while access is paused and reads again after resuming', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi
      .fn()
      .mockResolvedValueOnce(quota(8, new Date(Date.now() + 5_000).toISOString()))
      .mockResolvedValue(quota(7, new Date(Date.now() + LONG_RENEWAL).toISOString()));
    const runner = api({ getQuota });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptActivity api={runner} editor={editor} session={session()} accessState="ready" />,
    );
    await readyForAssertions();

    view.rerender(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session()}
        authPaused
        accessState="required"
      />,
    );
    await settle();
    await advance(5_000);
    expect(getQuota).toHaveBeenCalledOnce();

    view.rerender(
      <AttemptActivity api={runner} editor={editor} session={session()} accessState="ready" />,
    );
    await settle();
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Cuota: 7 de 100 intentos disponibles')).toBeTruthy();
  });

  it('lets an expired zero stay previous through a failed read backoff without advancing its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi
      .fn()
      .mockResolvedValueOnce(quota(0, new Date(Date.now() + 5_000).toISOString()))
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Quota read failed.'))
      .mockResolvedValue(quota(0, new Date(Date.now() + LONG_RENEWAL).toISOString()));
    const runner = api({ getQuota });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const onTryAvailabilityChange = vi.fn();
    const view = render(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session()}
        accessState="ready"
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );
    await readyForAssertions();
    expect(screen.getByText('No quedan partidas disponibles.')).toBeTruthy();

    view.rerender(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session()}
        authPaused
        accessState="required"
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );
    await settle();
    view.rerender(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session()}
        accessState="ready"
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );
    await settle();
    expect(getQuota).toHaveBeenCalledTimes(2);

    await advance(5_000);
    expect(screen.queryByText('No quedan partidas disponibles.')).toBeNull();
    expect(screen.getByLabelText(/0 de 100 intentos disponibles/i).textContent).toMatch(
      /anterior|previa|no confirmada/i,
    );
    expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    await advance(MINUTE - 5_001);
    expect(getQuota).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getQuota).toHaveBeenCalledTimes(3);
    expect(screen.getByText('No quedan partidas disponibles.')).toBeTruthy();
  });

  it.each([
    [
      'access rejection',
      new AttemptApiFailure('authentication', 'Expired.', 401, false, { authContext: 73 }),
    ],
    ['missing quota', new AttemptApiFailure('not_found', 'Quota not found.', 404)],
    ['invalid request', new AttemptApiFailure('invalid', 'Quota request rejected.', 400)],
    ['malformed success', new AttemptApiFailure('server', 'Malformed quota response.', 200)],
  ] as const)('does not retry a definitive %s failure', async (failureKind, failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi.fn().mockRejectedValue(failure);
    const onAuthRequired = vi.fn(() => true);
    const onTryAvailabilityChange = vi.fn();
    const runner = api({ getQuota });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session()}
        accessState="ready"
        onAuthRequired={onAuthRequired}
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );

    await readyForAssertions();
    expect(getQuota).toHaveBeenCalledOnce();
    if (failureKind === 'access rejection') {
      expect(onAuthRequired).toHaveBeenCalledOnce();
      expect(onAuthRequired).toHaveBeenCalledWith(73);
      expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    } else {
      expect(onAuthRequired).not.toHaveBeenCalled();
    }
    await advance(3 * MINUTE);
    expect(getQuota).toHaveBeenCalledOnce();
  });

  it('refreshes with current credentials after App declines an obsolete auth context', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('authentication', 'Old credentials expired.', 401, false, {
          authContext: 73,
        }),
      )
      .mockResolvedValue(quota(23, new Date(Date.now() + LONG_RENEWAL).toISOString()));
    const onAuthRequired = vi.fn(() => false);
    const onTryAvailabilityChange = vi.fn();
    const runner = api({ getQuota });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session()}
        accessState="ready"
        onAuthRequired={onAuthRequired}
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );

    await readyForAssertions();
    expect(onAuthRequired).toHaveBeenCalledWith(73);
    expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText('Old credentials expired.')).toBeNull();
    await advance(MINUTE - 1);
    expect(getQuota).toHaveBeenCalledOnce();
    await advance(1);
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Cuota: 23 de 100 intentos disponibles')).toBeTruthy();
    expect(screen.queryByText('Old credentials expired.')).toBeNull();
    expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
  });

  it('forwards a current auth context from a superseded quota read without replacing the newer balance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const staleRead = deferred<QuotaSummary>();
    const getQuota = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Initial quota failure.'))
      .mockReturnValueOnce(staleRead.promise)
      .mockResolvedValue(quota(99, new Date(Date.now() + LONG_RENEWAL).toISOString()));
    const onAuthRequired = vi.fn(() => false);
    const captureSnapshot = vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() });
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: runningAttempt(),
      dispatchConfirmed: true,
    });
    const runner = api({ createAttempt, getQuota });
    const editor = { current: { captureSnapshot } } as unknown as {
      current: RobotEditorHandle | null;
    };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    render(
      <AttemptActivity
        ref={ref}
        api={runner}
        editor={editor}
        session={session()}
        accessState="ready"
        onAuthRequired={onAuthRequired}
      />,
    );
    await readyForAssertions();
    await advance(MINUTE);
    expect(getQuota).toHaveBeenCalledTimes(2);

    await act(async () => ref.current!.start());
    await settle();
    expect(screen.getByLabelText('Cuota: 99 de 100 intentos disponibles')).toBeTruthy();
    expect(getQuota).toHaveBeenCalledTimes(3);
    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      9,
      createDefaultDraft(),
      true,
    );

    await act(async () => {
      staleRead.reject(
        new AttemptApiFailure('authentication', 'La sesión venció.', 401, false, {
          authContext: 73,
        }),
      );
      await Promise.resolve();
    });
    expect(onAuthRequired).toHaveBeenCalledOnce();
    expect(onAuthRequired).toHaveBeenCalledWith(73);
    expect(screen.getByLabelText('Cuota: 99 de 100 intentos disponibles')).toBeTruthy();
    expect(screen.queryByText('La sesión venció.')).toBeNull();
  });

  it('keeps history recovery manual and independent when quota recovery succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Quota unavailable.'))
      .mockResolvedValue(quota(16, new Date(Date.now() + 5 * MINUTE).toISOString()));
    const listAttempts = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'History unavailable.'))
      .mockResolvedValue({ attempts: [] });
    mount(api({ getQuota, listAttempts }));

    await readyForAssertions();
    expect(screen.getByText('History unavailable.')).toBeTruthy();
    const retryHistory = screen.getByRole('button', { name: /Reintentar historial/i });
    await advance(MINUTE);
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByText('History unavailable.')).toBeTruthy();
    expect(screen.getByLabelText('Cuota: 16 de 100 intentos disponibles')).toBeTruthy();

    const quotaCallsBeforeHistoryRetry = getQuota.mock.calls.length;
    fireEvent.click(retryHistory);
    await settle();
    expect(getQuota).toHaveBeenCalledTimes(quotaCallsBeforeHistoryRetry);
    expect(listAttempts.mock.calls.length).toBeGreaterThan(2);
    expect(screen.queryByText('History unavailable.')).toBeNull();
  });

  it('keeps a newer quota failure visible after the history-only retry succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const getQuota = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Earlier quota failure.'))
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Quota retry failed.'))
      .mockResolvedValue(quota(16, new Date(Date.now() + LONG_RENEWAL).toISOString()));
    const listAttempts = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'History unavailable.'))
      .mockResolvedValue({ attempts: [] });
    mount(api({ getQuota, listAttempts }));

    await readyForAssertions();
    await advance(MINUTE);
    expect(document.getElementById('attempt-availability-status')?.textContent).toMatch(
      /sin confirmar/i,
    );
    const retryHistory = screen.getByRole('button', { name: /Reintentar historial/i });
    fireEvent.click(retryHistory);
    await settle();
    expect(document.getElementById('attempt-availability-status')?.textContent).toMatch(
      /sin confirmar/i,
    );
    expect(screen.queryByText('History unavailable.')).toBeNull();
    await advance(MINUTE - 1);
    expect(getQuota).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getQuota).toHaveBeenCalledTimes(3);
  });

  it('rechecks quota after a definite quota-exceeded admission without repeating the captured admission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('quota_exceeded', 'No quedan partidas.', 429));
    const getQuota = vi
      .fn()
      .mockResolvedValueOnce(quota(8, new Date(Date.now() + 5 * MINUTE).toISOString()))
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Quota refresh unavailable.'))
      .mockResolvedValueOnce(quota(0, new Date(Date.now() + 5 * MINUTE).toISOString()));
    const captureSnapshot = vi.fn().mockResolvedValue({ version: 7, draft: createDefaultDraft() });
    const runner = api({ createAttempt, getQuota });
    const editor = { current: { captureSnapshot } } as unknown as {
      current: RobotEditorHandle | null;
    };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    render(
      <AttemptActivity
        ref={ref}
        api={runner}
        editor={editor}
        session={session()}
        accessState="ready"
      />,
    );

    await readyForAssertions();
    expect(screen.getByLabelText('Cuota: 8 de 100 intentos disponibles')).toBeTruthy();
    await act(async () => ref.current!.start());
    await settle();

    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      7,
      createDefaultDraft(),
      true,
    );
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No quedan partidas.')).toBeTruthy();
    expect(screen.getByLabelText(/8 de 100 intentos disponibles/i).textContent).toMatch(
      /anterior|previa|no confirmada/i,
    );
    expect(createAttempt).toHaveBeenCalledOnce();
    await advance(MINUTE);
    expect(getQuota).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('Cuota: 0 de 100 intentos disponibles')).toBeTruthy();
    expect(screen.getByText('No quedan partidas disponibles.')).toBeTruthy();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /Reintentar consultas/i })).toBeNull();
    expect(runner.startAttempt).not.toHaveBeenCalled();
    expect(runner.cancelAttempt).not.toHaveBeenCalled();
  });

  it('keeps a POST gateway rate limit distinct from quota zero until another explicit attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('attempt_unavailable', 'Rate limited.', 429));
    const getQuota = vi
      .fn()
      .mockResolvedValue(quota(8, new Date(Date.now() + 5 * MINUTE).toISOString()));
    const captureSnapshot = vi.fn().mockResolvedValue({ version: 4, draft: createDefaultDraft() });
    const runner = api({ createAttempt, getQuota });
    const editor = { current: { captureSnapshot } } as unknown as {
      current: RobotEditorHandle | null;
    };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    render(
      <AttemptActivity
        ref={ref}
        api={runner}
        editor={editor}
        session={session()}
        accessState="ready"
      />,
    );

    await readyForAssertions();
    await act(async () => ref.current!.start());
    await settle();
    expect(screen.getByLabelText('Cuota: 8 de 100 intentos disponibles')).toBeTruthy();
    expect(screen.queryByText('No quedan partidas disponibles.')).toBeNull();
    expect(getQuota).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledOnce();

    await act(async () => ref.current!.start());
    await settle();
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
    expect(createAttempt).toHaveBeenCalledTimes(2);
    expect(createAttempt.mock.calls[0]?.[0]).not.toBe(createAttempt.mock.calls[1]?.[0]);
    expect(getQuota).toHaveBeenCalledOnce();
  });
});
