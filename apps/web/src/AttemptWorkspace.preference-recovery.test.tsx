// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type QuotaSummary } from './attempt-api.js';
import { AttemptWorkspace, type AttemptWorkspaceHandle } from './AttemptWorkspace.js';
import type { RobotEditorHandle } from './RobotEditor.js';

const MINUTE = 60_000;
const healthyPreference = { animationEnabled: true, version: 0 };
const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

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

function quota(): QuotaSummary {
  return {
    day: '2026-10-26',
    used: 0,
    limit: 100,
    remaining: 100,
    resetsAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
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
    getQuota: vi.fn().mockResolvedValue(quota()),
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

function networkFailure(message = 'Network unavailable.') {
  return new AttemptApiFailure('network', message);
}

function uncertainFailure(message = 'The PUT response was lost.') {
  return new AttemptApiFailure('network', message, undefined, true);
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

function mount(
  runner: AttemptApi,
  options: {
    readonly activeSession?: AuthSession;
    readonly authPaused?: boolean;
    readonly onAuthRequired?: (authContext?: number) => boolean | void;
  } = {},
) {
  const captureSnapshot = vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() });
  const editor = {
    current: { captureSnapshot },
  } as unknown as { current: RobotEditorHandle | null };
  const ref = { current: null } as { current: AttemptWorkspaceHandle | null };
  const onTryAvailabilityChange = vi.fn();
  const onAuthRequired = options.onAuthRequired ?? vi.fn();
  const view = render(
    <AttemptWorkspace
      ref={ref}
      api={runner}
      editor={editor}
      session={options.activeSession ?? session()}
      authPaused={options.authPaused}
      accessState="ready"
      onTryAvailabilityChange={onTryAvailabilityChange}
      onAuthRequired={onAuthRequired}
    />,
  );
  return { captureSnapshot, editor, onAuthRequired, onTryAvailabilityChange, ref, view };
}

async function readyForAssertions() {
  await settle();
  expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
}

function animationCheckbox(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
}

function focusWorkspace(): void {
  act(() => window.dispatchEvent(new Event('focus')));
}

function showDocumentVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (visibilityDescriptor) {
    Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
  } else {
    Reflect.deleteProperty(document, 'visibilityState');
  }
});

describe('AttemptWorkspace animation preference recovery acceptance', () => {
  it('keeps the first read mixed until confirmed, then stops without healthy polling or focus refresh', async () => {
    vi.useFakeTimers();
    const initialRead = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi.fn().mockReturnValueOnce(initialRead.promise);
    const runner = api({ getAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();

    expect(animationCheckbox().getAttribute('aria-checked')).toBe('mixed');
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    await advance(3 * MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledOnce();

    await act(async () => {
      initialRead.resolve({ animationEnabled: true, version: 3 });
      await Promise.resolve();
    });
    await settle();
    expect(animationCheckbox().checked).toBe(true);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);

    await advance(3 * MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    focusWorkspace();
    showDocumentVisibility('hidden');
    showDocumentVisibility('visible');
    act(() => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    expect(animationCheckbox().checked).toBe(true);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    await advance(3 * MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledOnce();
  });

  it('retries transient initial reads 60 seconds after failure and continues through 65 mixed transient failures', async () => {
    vi.useFakeTimers();
    const initialRead = deferred<{ animationEnabled: boolean; version: number }>();
    const failures = [
      networkFailure('Temporary network failure.'),
      new AttemptApiFailure('server', 'Temporary server error.', 503),
      new AttemptApiFailure('attempt_unavailable', 'Auxiliary request limited.', 429),
    ];
    const getAnimationPreference = vi.fn().mockReturnValueOnce(initialRead.promise);
    for (let failure = 0; failure < 65; failure += 1) {
      getAnimationPreference.mockRejectedValueOnce(failures[failure % failures.length]);
    }
    getAnimationPreference.mockResolvedValueOnce({ animationEnabled: true, version: 7 });
    const runner = api({ getAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();
    const initialQuotaReads = vi.mocked(runner.getQuota).mock.calls.length;
    const initialHistoryReads = vi.mocked(runner.listAttempts).mock.calls.length;

    await advance(90_000);
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    await act(async () => {
      initialRead.reject(networkFailure('initial request failed'));
      await Promise.resolve();
    });
    await settle();
    await advance(MINUTE - 1);
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    await advance(1);
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);

    for (let retry = 1; retry < 65; retry += 1) await advance(MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledTimes(66);
    await advance(MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledTimes(67);
    expect(animationCheckbox().checked).toBe(true);
    await advance(4 * MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledTimes(67);
    expect(runner.getQuota).toHaveBeenCalledTimes(initialQuotaReads);
    expect(runner.listAttempts).toHaveBeenCalledTimes(initialHistoryReads);
    expect(harness.captureSnapshot).not.toHaveBeenCalled();
    expect(runner.createAttempt).not.toHaveBeenCalled();
    expect(runner.startAttempt).not.toHaveBeenCalled();
    expect(runner.cancelAttempt).not.toHaveBeenCalled();
    expect(runner.completePresentation).not.toHaveBeenCalled();
  });

  it('keeps one preference read in flight across rerender, focus, visibility and an overdue retry', async () => {
    vi.useFakeTimers();
    const focusRead = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(networkFailure())
      .mockReturnValueOnce(focusRead.promise)
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 });
    const runner = api({ getAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();
    await advance(30_000);

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    act(() => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    focusWorkspace();
    showDocumentVisibility('hidden');
    showDocumentVisibility('visible');
    focusWorkspace();
    act(() => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledOnce();

    await advance(30_000);
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    focusWorkspace();
    showDocumentVisibility('visible');
    act(() => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    await act(async () => {
      focusRead.reject(networkFailure());
      await Promise.resolve();
    });
    await settle();
    await advance(MINUTE - 1);
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(animationCheckbox().checked).toBe(true);
  });

  it('resumes one cycle after suspension instead of replaying missed minutes', async () => {
    vi.useFakeTimers();
    const getAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(networkFailure())
      .mockRejectedValueOnce(networkFailure('focus refresh failed'))
      .mockResolvedValueOnce({ animationEnabled: false, version: 1 });
    const runner = api({ getAnimationPreference });
    mount(runner);
    await readyForAssertions();
    vi.setSystemTime(new Date(Date.now() + 5 * MINUTE));

    focusWorkspace();
    await settle();
    await advance(0);
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    await advance(MINUTE - 1);
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(animationCheckbox().checked).toBe(false);
  });

  it('keeps a pending choice visible and only changes Probar availability, never admitting from recovery', async () => {
    vi.useFakeTimers();
    const finishPut = deferred<{ animationEnabled: boolean; version: number }>();
    const createAttempt = vi.fn();
    const startAttempt = vi.fn();
    const getReplay = vi.fn();
    const completePresentation = vi.fn();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValue({ animationEnabled: true, version: 3 });
    const putAnimationPreference = vi.fn(() => finishPut.promise);
    const runner = api({
      createAttempt,
      startAttempt,
      getReplay,
      completePresentation,
      getAnimationPreference,
      putAnimationPreference,
    });
    const harness = mount(runner);
    await readyForAssertions();
    expect(animationCheckbox().checked).toBe(true);
    fireEvent.click(animationCheckbox());
    await settle();

    expect(animationCheckbox().checked).toBe(false);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    act(() => harness.ref.current?.start());
    await settle();
    expect(harness.captureSnapshot).not.toHaveBeenCalled();
    expect(createAttempt).not.toHaveBeenCalled();
    expect(startAttempt).not.toHaveBeenCalled();
    expect(getReplay).not.toHaveBeenCalled();
    expect(completePresentation).not.toHaveBeenCalled();

    await act(async () => {
      finishPut.resolve({ animationEnabled: false, version: 4 });
      await Promise.resolve();
    });
    await settle();
    expect(animationCheckbox().checked).toBe(false);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    await advance(2 * MINUTE);
    expect(createAttempt).not.toHaveBeenCalled();
    expect(startAttempt).not.toHaveBeenCalled();
    expect(completePresentation).not.toHaveBeenCalled();
    expect(harness.captureSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['lost network response', uncertainFailure()],
    ['gateway 5xx response', new AttemptApiFailure('server', 'Gateway error.', 502, true)],
    [
      'malformed successful response',
      new AttemptApiFailure('server', 'Malformed response.', 200, true),
    ],
  ])(
    'reconciles an uncertain PUT (%s) and confirms its target without a duplicate write',
    async (_label, uncertainPutFailure) => {
      vi.useFakeTimers();
      const getAnimationPreference = vi
        .fn()
        .mockResolvedValueOnce({ animationEnabled: true, version: 7 })
        .mockRejectedValueOnce(networkFailure('readback failed'))
        .mockResolvedValueOnce({ animationEnabled: false, version: 9 });
      const putAnimationPreference = vi.fn().mockRejectedValueOnce(uncertainPutFailure);
      const runner = api({ getAnimationPreference, putAnimationPreference });
      const harness = mount(runner);
      await readyForAssertions();

      fireEvent.click(animationCheckbox());
      await settle();
      expect(putAnimationPreference).toHaveBeenCalledWith(false, 7, expect.any(AbortSignal));
      expect(getAnimationPreference).toHaveBeenCalledTimes(2);
      expect(animationCheckbox().checked).toBe(false);
      expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
      expect(putAnimationPreference).toHaveBeenCalledOnce();

      await advance(MINUTE - 1);
      expect(getAnimationPreference).toHaveBeenCalledTimes(2);
      expect(putAnimationPreference).toHaveBeenCalledOnce();
      await advance(1);
      expect(getAnimationPreference).toHaveBeenCalledTimes(3);
      expect(animationCheckbox().checked).toBe(false);
      expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
      await advance(3 * MINUTE);
      expect(getAnimationPreference).toHaveBeenCalledTimes(3);
      expect(putAnimationPreference).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['A committed first', { animationEnabled: true, version: 11 }, 11],
    ['A did not commit yet', { animationEnabled: false, version: 10 }, 10],
  ])(
    'does not write a newer choice blindly after uncertain A; readback (%s) fences B',
    async (_label, readback, expectedVersion) => {
      vi.useFakeTimers();
      const finishPutA = deferred<{ animationEnabled: boolean; version: number }>();
      const getAnimationPreference = vi
        .fn()
        .mockResolvedValueOnce({ animationEnabled: false, version: 10 })
        .mockRejectedValueOnce(networkFailure('first comparison failed'))
        .mockResolvedValueOnce(readback);
      const finishPutB = deferred<{ animationEnabled: boolean; version: number }>();
      const putAnimationPreference = vi
        .fn()
        .mockImplementationOnce(() => finishPutA.promise)
        .mockReturnValueOnce(finishPutB.promise);
      const runner = api({ getAnimationPreference, putAnimationPreference });
      const harness = mount(runner);
      await readyForAssertions();

      fireEvent.click(animationCheckbox()); // A = true at version 10
      await settle();
      fireEvent.click(animationCheckbox()); // B = false remains visible
      await settle();
      expect(animationCheckbox().checked).toBe(false);
      expect(putAnimationPreference).toHaveBeenCalledTimes(1);
      expect(putAnimationPreference).toHaveBeenNthCalledWith(1, true, 10, expect.any(AbortSignal));

      await act(async () => {
        finishPutA.reject(uncertainFailure('A may have committed.'));
        await Promise.resolve();
      });
      await settle();
      expect(getAnimationPreference).toHaveBeenCalledTimes(2);
      expect(putAnimationPreference).toHaveBeenCalledTimes(1);
      expect(animationCheckbox().checked).toBe(false);

      await advance(MINUTE);
      expect(getAnimationPreference).toHaveBeenCalledTimes(3);
      expect(putAnimationPreference).toHaveBeenCalledTimes(2);
      expect(putAnimationPreference).toHaveBeenNthCalledWith(
        2,
        false,
        expectedVersion,
        expect.any(AbortSignal),
      );
      expect(animationCheckbox().checked).toBe(false);
      expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);

      await act(async () => {
        finishPutB.resolve({ animationEnabled: false, version: expectedVersion + 1 });
        await Promise.resolve();
      });
      await settle();
      expect(animationCheckbox().checked).toBe(false);
      expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    },
  );

  it('fences base→uncertain A→base with a conditional write even when readback still shows the base version', async () => {
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 5 })
      .mockResolvedValueOnce({ animationEnabled: true, version: 5 });
    const finishPutA = deferred<{ animationEnabled: boolean; version: number }>();
    const finishFence = deferred<{ animationEnabled: boolean; version: number }>();
    const putAnimationPreference = vi
      .fn()
      .mockReturnValueOnce(finishPutA.promise)
      .mockReturnValueOnce(finishFence.promise);
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();

    fireEvent.click(animationCheckbox()); // A = false
    await settle();
    fireEvent.click(animationCheckbox()); // latest target is the original base = true
    await settle();
    expect(animationCheckbox().checked).toBe(true);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(putAnimationPreference).toHaveBeenNthCalledWith(1, false, 5, expect.any(AbortSignal));

    await act(async () => {
      finishPutA.reject(uncertainFailure('A may still commit after this read.'));
      await Promise.resolve();
    });
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, true, 5, expect.any(AbortSignal));
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    await act(async () => {
      finishFence.resolve({ animationEnabled: true, version: 6 });
      await Promise.resolve();
    });
    await settle();
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
  });

  it('keeps a 409 comparison conflict explicit, including when the rejected PUT is no longer the latest choice', async () => {
    const comparison = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: false, version: 1 })
      .mockReturnValueOnce(comparison.promise)
      .mockResolvedValueOnce({ animationEnabled: true, version: 3 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('conflict', 'Version conflict.', 409))
      .mockRejectedValueOnce(new AttemptApiFailure('conflict', 'Version changed again.', 409))
      .mockResolvedValueOnce({ animationEnabled: false, version: 4 });
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();

    fireEvent.click(animationCheckbox()); // A = true, rejected by the server
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    fireEvent.click(animationCheckbox()); // B = false while the comparison is pending
    await settle();
    expect(animationCheckbox().checked).toBe(false);

    await act(async () => {
      comparison.resolve({ animationEnabled: true, version: 2 });
      await Promise.resolve();
    });
    await settle();
    expect(animationCheckbox().checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Guardar mi selección' })).toBeTruthy();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Guardar mi selección' }));
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 2, expect.any(AbortSignal));
    expect(animationCheckbox().checked).toBe(false);
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Guardar mi selección' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar mi selección' }));
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledTimes(3);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(3, false, 3, expect.any(AbortSignal));
    expect(animationCheckbox().checked).toBe(false);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
  });

  it('retries a transient 409 comparison failure with GET only, then waits for explicit conflict resolution', async () => {
    vi.useFakeTimers();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 4 })
      .mockRejectedValueOnce(networkFailure('comparison unavailable'))
      .mockResolvedValueOnce({ animationEnabled: true, version: 5 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('conflict', 'Version conflict.', 409))
      .mockResolvedValueOnce({ animationEnabled: false, version: 6 });
    const runner = api({ getAnimationPreference, putAnimationPreference });
    mount(runner);
    await readyForAssertions();

    fireEvent.click(animationCheckbox());
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Guardar mi selección' })).toBeNull();

    await advance(MINUTE - 1);
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    await advance(1);
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Guardar mi selección' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar mi selección' }));
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 5, expect.any(AbortSignal));
  });

  it('retries a definitive gateway 429 after a minute without an unnecessary readback or busy loop', async () => {
    vi.useFakeTimers();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('attempt_unavailable', 'Gateway is busy.', 429, false),
      )
      .mockResolvedValueOnce({ animationEnabled: false, version: 3 });
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();

    fireEvent.click(animationCheckbox());
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(animationCheckbox().checked).toBe(false);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);

    await advance(MINUTE - 1);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    await advance(1);
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 2, expect.any(AbortSignal));
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    expect(animationCheckbox().checked).toBe(false);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
  });

  it.each([
    [
      '401 authentication rejection',
      new AttemptApiFailure('authentication', 'Expired.', 401, false, { authContext: 41 }),
    ],
    [
      '403 authentication rejection',
      new AttemptApiFailure('authentication', 'Forbidden.', 403, false, { authContext: 43 }),
    ],
    ['definitive invalid rejection', new AttemptApiFailure('invalid', 'Invalid choice.', 400)],
    [
      'definitive not-found rejection',
      new AttemptApiFailure('not_found', 'Preference missing.', 404),
    ],
  ])(
    'stops on a definitive PUT failure (%s) without a post-failure read or retry',
    async (_label, failure) => {
      vi.useFakeTimers();
      const getAnimationPreference = vi
        .fn()
        .mockResolvedValue({ animationEnabled: true, version: 0 });
      const putAnimationPreference = vi.fn().mockRejectedValue(failure);
      const onAuthRequired = vi.fn();
      const runner = api({ getAnimationPreference, putAnimationPreference });
      const harness = mount(runner, { onAuthRequired });
      await readyForAssertions();

      fireEvent.click(animationCheckbox());
      await settle();
      expect(putAnimationPreference).toHaveBeenCalledOnce();
      expect(getAnimationPreference).toHaveBeenCalledOnce();
      if (failure.code === 'authentication') {
        expect(onAuthRequired).toHaveBeenCalledWith(failure.authContext);
      } else {
        expect(onAuthRequired).not.toHaveBeenCalled();
      }
      await advance(3 * MINUTE);
      expect(getAnimationPreference).toHaveBeenCalledOnce();
      expect(putAnimationPreference).toHaveBeenCalledOnce();
      expect(animationCheckbox().checked).toBe(false);
      expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    },
  );

  it('resumes the same identity after auth pause by reading the current version before a conditional retry', async () => {
    vi.useFakeTimers();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 1 })
      .mockResolvedValueOnce({ animationEnabled: true, version: 1 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('authentication', 'Session expired.', 401, false, {
          authContext: 88,
        }),
      )
      .mockResolvedValueOnce({ animationEnabled: false, version: 2 });
    const onAuthRequired = vi.fn();
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner, { onAuthRequired });
    await readyForAssertions();
    fireEvent.click(animationCheckbox());
    await settle();
    expect(onAuthRequired).toHaveBeenCalledWith(88);
    expect(getAnimationPreference).toHaveBeenCalledOnce();

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={onAuthRequired}
      />,
    );
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused={false}
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={onAuthRequired}
      />,
    );
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 1, expect.any(AbortSignal));
    expect(animationCheckbox().checked).toBe(false);
  });

  it('does not let a stale same-identity auth rejection freeze a target after credentials renew', async () => {
    vi.useFakeTimers();
    const staleReadback = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 6 })
      .mockReturnValueOnce(staleReadback.promise)
      .mockResolvedValueOnce({ animationEnabled: false, version: 8 });
    const putAnimationPreference = vi.fn().mockRejectedValueOnce(uncertainFailure());
    const onAuthRequired = vi.fn(() => false);
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner, { onAuthRequired });
    await readyForAssertions();

    fireEvent.click(animationCheckbox());
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session('subject-a', 'renewed-token-subject-a')}
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={onAuthRequired}
      />,
    );

    await act(async () => {
      staleReadback.reject(
        new AttemptApiFailure('authentication', 'Old credentials expired.', 401, false, {
          authContext: 41,
        }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(animationCheckbox().checked).toBe(false);
    expect(screen.queryByText('Old credentials expired.')).toBeNull();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);

    await advance(MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(animationCheckbox().checked).toBe(false);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(harness.captureSnapshot).not.toHaveBeenCalled();
    expect(runner.createAttempt).not.toHaveBeenCalled();
  });

  it('aborts a paused uncertain readback, then reconciles again before any conditional retry', async () => {
    const pausedRead = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: false, version: 3 })
      .mockReturnValueOnce(pausedRead.promise)
      .mockResolvedValueOnce({ animationEnabled: false, version: 3 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(uncertainFailure())
      .mockResolvedValueOnce({ animationEnabled: true, version: 4 });
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();

    fireEvent.click(animationCheckbox());
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    const pausedReadSignal = getAnimationPreference.mock.calls[1]?.[0];
    expect(pausedReadSignal?.aborted).toBe(false);

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    await settle();
    expect(pausedReadSignal?.aborted).toBe(true);
    await act(async () => {
      pausedRead.resolve({ animationEnabled: true, version: 99 });
      await Promise.resolve();
    });
    await settle();
    expect(animationCheckbox().checked).toBe(true);
    expect(putAnimationPreference).toHaveBeenCalledOnce();

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused={false}
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, true, 3, expect.any(AbortSignal));
  });

  it('aborts a paused PUT, preserves a newer choice, and reconciles before conditionally writing it', async () => {
    const finishPutA = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: false, version: 3 })
      .mockResolvedValueOnce({ animationEnabled: true, version: 4 });
    const putAnimationPreference = vi
      .fn()
      .mockReturnValueOnce(finishPutA.promise)
      .mockResolvedValueOnce({ animationEnabled: false, version: 5 });
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();

    fireEvent.click(animationCheckbox()); // A = true
    await settle();
    const putASignal = putAnimationPreference.mock.calls[0]?.[2];
    fireEvent.click(animationCheckbox()); // latest B = false
    await settle();
    expect(animationCheckbox().checked).toBe(false);
    expect(putAnimationPreference).toHaveBeenCalledOnce();

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    await settle();
    expect(putASignal?.aborted).toBe(true);
    await act(async () => {
      finishPutA.resolve({ animationEnabled: true, version: 4 });
      await Promise.resolve();
    });
    await settle();
    expect(animationCheckbox().checked).toBe(false);
    expect(putAnimationPreference).toHaveBeenCalledOnce();

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused={false}
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 4, expect.any(AbortSignal));
    expect(animationCheckbox().checked).toBe(false);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
  });

  it('does not continue a delayed preference retry after auth pause and reconciles on same-identity resume', async () => {
    vi.useFakeTimers();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 })
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('attempt_unavailable', 'Gateway busy.', 429, false),
      )
      .mockResolvedValueOnce({ animationEnabled: false, version: 3 });
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();
    fireEvent.click(animationCheckbox());
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledOnce();

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    await advance(2 * MINUTE);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(getAnimationPreference).toHaveBeenCalledOnce();

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused={false}
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 2, expect.any(AbortSignal));
  });

  it('requires explicit resolution when a paused definitive PUT retry discovers a changed remote version', async () => {
    vi.useFakeTimers();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 })
      .mockResolvedValueOnce({ animationEnabled: true, version: 3 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('attempt_unavailable', 'Gateway busy.', 429, false),
      )
      .mockResolvedValueOnce({ animationEnabled: false, version: 4 });
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();

    fireEvent.click(animationCheckbox());
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    await advance(2 * MINUTE);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session()}
        authPaused={false}
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={harness.onAuthRequired}
      />,
    );
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(animationCheckbox().checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Guardar mi selección' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar mi selección' }));
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 3, expect.any(AbortSignal));
  });

  it('rejects regressive and same-version-different-content readbacks without lowering the confirmed version', async () => {
    for (const invalidReadback of [
      { label: 'regressive', value: { animationEnabled: false, version: 4 } },
      {
        label: 'same version with different content',
        value: { animationEnabled: false, version: 5 },
      },
    ]) {
      vi.useFakeTimers();
      const getAnimationPreference = vi
        .fn()
        .mockResolvedValueOnce({ animationEnabled: true, version: 5 })
        .mockResolvedValueOnce(invalidReadback.value)
        .mockResolvedValueOnce({ animationEnabled: true, version: 5 });
      const putAnimationPreference = vi
        .fn()
        .mockRejectedValueOnce(uncertainFailure())
        .mockResolvedValueOnce({ animationEnabled: false, version: 6 });
      const runner = api({ getAnimationPreference, putAnimationPreference });
      const harness = mount(runner);
      await readyForAssertions();

      fireEvent.click(animationCheckbox());
      await settle();
      expect(putAnimationPreference).toHaveBeenCalledOnce();
      expect(getAnimationPreference).toHaveBeenCalledTimes(2);
      expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);

      harness.view.rerender(
        <AttemptWorkspace
          ref={harness.ref}
          api={runner}
          editor={harness.editor}
          session={session()}
          authPaused
          accessState="ready"
          onTryAvailabilityChange={harness.onTryAvailabilityChange}
          onAuthRequired={harness.onAuthRequired}
        />,
      );
      await settle();
      harness.view.rerender(
        <AttemptWorkspace
          ref={harness.ref}
          api={runner}
          editor={harness.editor}
          session={session()}
          authPaused={false}
          accessState="ready"
          onTryAvailabilityChange={harness.onTryAvailabilityChange}
          onAuthRequired={harness.onAuthRequired}
        />,
      );
      await settle();
      expect(getAnimationPreference).toHaveBeenCalledTimes(3);
      expect(putAnimationPreference).toHaveBeenCalledTimes(2);
      expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 5, expect.any(AbortSignal));
      expect(animationCheckbox().checked).toBe(false);
      expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
      cleanup();
      vi.clearAllTimers();
    }
  });

  it.each([
    ['401', new AttemptApiFailure('authentication', 'Expired.', 401, false, { authContext: 51 })],
    ['403', new AttemptApiFailure('authentication', 'Forbidden.', 403, false, { authContext: 53 })],
    ['invalid', new AttemptApiFailure('invalid', 'Invalid preference.', 400)],
    ['not found', new AttemptApiFailure('not_found', 'Preference missing.', 404)],
    ['malformed successful response', new AttemptApiFailure('server', 'Malformed response.', 200)],
  ])('stops automatic GET recovery after definitive %s failure', async (_label, failure) => {
    vi.useFakeTimers();
    const getAnimationPreference = vi.fn().mockRejectedValue(failure);
    const onAuthRequired = vi.fn();
    const runner = api({ getAnimationPreference });
    mount(runner, { onAuthRequired });
    await readyForAssertions();
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    if (failure.code === 'authentication') {
      expect(onAuthRequired).toHaveBeenCalledWith(failure.authContext);
    } else {
      expect(onAuthRequired).not.toHaveBeenCalled();
    }
    await advance(4 * MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledOnce();
  });

  it('ignores a late readback from the previous identity without clearing the new identity pending write', async () => {
    vi.useFakeTimers();
    const lateReadback = deferred<{ animationEnabled: boolean; version: number }>();
    const finishPutForB = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 1 })
      .mockReturnValueOnce(lateReadback.promise)
      .mockResolvedValueOnce({ animationEnabled: false, version: 4 })
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Retry me.'));
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(uncertainFailure())
      .mockReturnValueOnce(finishPutForB.promise);
    const onAuthRequired = vi.fn();
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner, { onAuthRequired });
    await readyForAssertions();
    fireEvent.click(animationCheckbox());
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    const staleReadSignal = getAnimationPreference.mock.calls[1]?.[0];

    harness.view.rerender(
      <AttemptWorkspace
        ref={harness.ref}
        api={runner}
        editor={harness.editor}
        session={session('subject-b')}
        accessState="ready"
        onTryAvailabilityChange={harness.onTryAvailabilityChange}
        onAuthRequired={onAuthRequired}
      />,
    );
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(staleReadSignal?.aborted).toBe(true);
    expect(animationCheckbox().checked).toBe(false);
    fireEvent.click(animationCheckbox()); // B's choice is now active and must not be cleared by A.
    await settle();
    expect(animationCheckbox().checked).toBe(true);
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      lateReadback.reject(
        new AttemptApiFailure('authentication', 'Obsolete account expired.', 401, false, {
          authContext: 99,
        }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(onAuthRequired).not.toHaveBeenCalled();
    expect(animationCheckbox().checked).toBe(true);
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      finishPutForB.resolve({ animationEnabled: true, version: 5 });
      await Promise.resolve();
    });
    await settle();
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);

    cleanup();
    const readsAfterUnmount = getAnimationPreference.mock.calls.length;
    await advance(3 * MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledTimes(readsAfterUnmount);
  });

  it('cancels an outstanding preference retry timer when unmounted', async () => {
    vi.useFakeTimers();
    const getAnimationPreference = vi.fn().mockRejectedValue(networkFailure());
    const runner = api({ getAnimationPreference });
    const harness = mount(runner);
    await readyForAssertions();
    expect(getAnimationPreference).toHaveBeenCalledOnce();

    harness.view.unmount();
    await advance(4 * MINUTE);
    expect(getAnimationPreference).toHaveBeenCalledOnce();
  });

  it.each(['PUT', 'readback'] as const)(
    'aborts a pending preference %s and ignores its late auth result on unmount',
    async (pendingOperation) => {
      vi.useFakeTimers();
      const latePut = deferred<{ animationEnabled: boolean; version: number }>();
      const lateReadback = deferred<{ animationEnabled: boolean; version: number }>();
      const getAnimationPreference = vi.fn().mockResolvedValueOnce({
        animationEnabled: true,
        version: 1,
      });
      const putAnimationPreference = vi.fn();
      if (pendingOperation === 'PUT') {
        putAnimationPreference.mockReturnValueOnce(latePut.promise);
      } else {
        getAnimationPreference.mockReturnValueOnce(lateReadback.promise);
        putAnimationPreference.mockRejectedValueOnce(uncertainFailure());
      }
      const onAuthRequired = vi.fn();
      const runner = api({ getAnimationPreference, putAnimationPreference });
      const harness = mount(runner, { onAuthRequired });
      await readyForAssertions();

      fireEvent.click(animationCheckbox());
      await settle();
      const pendingSignal =
        pendingOperation === 'PUT'
          ? putAnimationPreference.mock.calls[0]?.[2]
          : getAnimationPreference.mock.calls[1]?.[0];
      expect(pendingSignal?.aborted).toBe(false);
      const callbacksBeforeUnmount = harness.onTryAvailabilityChange.mock.calls.length;

      harness.view.unmount();
      expect(pendingSignal?.aborted).toBe(true);
      await act(async () => {
        const lateFailure = new AttemptApiFailure(
          'authentication',
          'The old request must be ignored.',
          401,
          false,
          { authContext: 74 },
        );
        if (pendingOperation === 'PUT') latePut.reject(lateFailure);
        else lateReadback.reject(lateFailure);
        await Promise.resolve();
      });
      await settle();
      expect(onAuthRequired).not.toHaveBeenCalled();
      expect(harness.onTryAvailabilityChange).toHaveBeenCalledTimes(callbacksBeforeUnmount);

      const getCallsAfterUnmount = getAnimationPreference.mock.calls.length;
      const putCallsAfterUnmount = putAnimationPreference.mock.calls.length;
      await advance(2 * MINUTE);
      expect(getAnimationPreference).toHaveBeenCalledTimes(getCallsAfterUnmount);
      expect(putAnimationPreference).toHaveBeenCalledTimes(putCallsAfterUnmount);
      expect(runner.createAttempt).not.toHaveBeenCalled();
    },
  );
});
