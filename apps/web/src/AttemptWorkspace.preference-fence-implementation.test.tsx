// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type QuotaSummary } from './attempt-api.js';
import { AttemptActivityHarness as AttemptActivity } from './AttemptActivity.test-support.js';
import type { RobotEditorHandle } from './RobotEditor.js';

const MINUTE = 60_000;
const basePreference = { animationEnabled: false, version: 10 };

function session(): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub: 'subject-a', email: 'a@example.com' },
    user: new User({
      access_token: 'token-a',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: now,
        exp: now + 600,
        sub: 'subject-a',
        email: 'a@example.com',
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
    createAttempt: vi.fn(),
    getAttemptRequest: vi.fn(),
    getAttempt: vi.fn(),
    getConfiguration: vi.fn(),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue(basePreference),
    putAnimationPreference: vi
      .fn()
      .mockImplementation(async (animationEnabled, expectedVersion) => ({
        animationEnabled,
        version: expectedVersion + 1,
      })),
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

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  });
}

function mount(
  runner: AttemptApi,
  options: { readonly authPaused?: boolean; readonly onAuthRequired?: () => boolean } = {},
) {
  const editor = {
    current: {
      captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    },
  } as unknown as { current: RobotEditorHandle | null };
  const onTryAvailabilityChange = vi.fn();
  const onAuthRequired = options.onAuthRequired ?? vi.fn(() => true);
  const view = render(
    <AttemptActivity
      api={runner}
      editor={editor}
      session={session()}
      authPaused={options.authPaused}
      accessState="ready"
      onTryAvailabilityChange={onTryAvailabilityChange}
      onAuthRequired={onAuthRequired}
    />,
  );
  return { editor, onAuthRequired, onTryAvailabilityChange, view };
}

async function ready(): Promise<void> {
  await settle();
  expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
}

function animationCheckbox(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('AttemptActivity uncertain preference fence implementation', () => {
  it('keeps the base→uncertain A→base fence through a definitive gateway 429', async () => {
    vi.useFakeTimers();
    const uncertainA = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi.fn().mockResolvedValue(basePreference);
    const putAnimationPreference = vi
      .fn()
      .mockReturnValueOnce(uncertainA.promise)
      .mockRejectedValueOnce(
        new AttemptApiFailure('attempt_unavailable', 'Gateway busy.', 429, false),
      )
      .mockResolvedValueOnce({ animationEnabled: false, version: 11 });
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner);
    await ready();

    fireEvent.click(animationCheckbox()); // A = true
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledWith(true, 10, expect.any(AbortSignal));
    fireEvent.click(animationCheckbox()); // latest choice returns to base = false
    expect(animationCheckbox().checked).toBe(false);

    await act(async () => {
      uncertainA.reject(new AttemptApiFailure('network', 'Lost response.', undefined, true));
      await Promise.resolve();
    });
    await settle();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 10, expect.any(AbortSignal));
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(runner.createAttempt).not.toHaveBeenCalled();
    expect(harness.editor.current?.captureSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE - 1);
    });
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledTimes(3);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(3, false, 10, expect.any(AbortSignal));
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(runner.createAttempt).not.toHaveBeenCalled();
  });

  it('rechecks an unchanged fence version after auth pause before retrying its conditional write', async () => {
    vi.useFakeTimers();
    const uncertainA = deferred<{ animationEnabled: boolean; version: number }>();
    const fenceWrite = deferred<{ animationEnabled: boolean; version: number }>();
    const getAnimationPreference = vi.fn().mockResolvedValue(basePreference);
    const putAnimationPreference = vi
      .fn()
      .mockReturnValueOnce(uncertainA.promise)
      .mockRejectedValueOnce(
        new AttemptApiFailure('authentication', 'Session expired.', 401, false, {
          authContext: 81,
        }),
      )
      .mockReturnValueOnce(fenceWrite.promise);
    const onAuthRequired = vi.fn(() => true);
    const runner = api({ getAnimationPreference, putAnimationPreference });
    const harness = mount(runner, { onAuthRequired });
    await ready();

    fireEvent.click(animationCheckbox()); // A = true
    await settle();
    fireEvent.click(animationCheckbox()); // latest choice returns to base = false
    await act(async () => {
      uncertainA.reject(new AttemptApiFailure('network', 'Lost response.', undefined, true));
      await Promise.resolve();
    });
    await settle();
    expect(putAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 10, expect.any(AbortSignal));
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);

    harness.view.rerender(
      <AttemptActivity
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
    harness.view.rerender(
      <AttemptActivity
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

    expect(onAuthRequired).toHaveBeenCalledWith(81);
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(putAnimationPreference).toHaveBeenCalledTimes(3);
    expect(putAnimationPreference).toHaveBeenNthCalledWith(3, false, 10, expect.any(AbortSignal));
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(runner.createAttempt).not.toHaveBeenCalled();

    await act(async () => {
      fenceWrite.resolve({ animationEnabled: false, version: 11 });
      await Promise.resolve();
    });
    await settle();
    expect(harness.onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(runner.createAttempt).not.toHaveBeenCalled();
  });
});
