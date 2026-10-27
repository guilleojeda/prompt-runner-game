// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import { modelByKey } from '../../../shared/models.js';
import type { AuthSession } from './auth.js';
import type { AttemptApi, AttemptSummary, QuotaSummary } from './attempt-api.js';
import { AttemptActivityHarness as AttemptActivity } from './AttemptActivity.test-support.js';
import type { AttemptActivityHandle } from './useAttemptActivity.js';
import type { RobotEditorHandle } from './RobotEditor.js';

function session(sub: string): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub, email: `${sub}@example.com` },
    user: new User({
      access_token: `token-${sub}`,
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

function quota(remaining: number): QuotaSummary {
  return {
    day: new Date(Date.now()).toISOString().slice(0, 10),
    used: 100 - remaining,
    limit: 100,
    remaining,
    resetsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

function runningAttempt(): AttemptSummary {
  const model = modelByKey(createDefaultDraft().modelKey)!;
  const now = new Date().toISOString();
  return {
    id: 'admitted-before-account-change',
    createdAt: now,
    updatedAt: now,
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
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 0 }),
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 24; turn += 1) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('AttemptActivity quota admission lifecycle', () => {
  it('does not continue the old admission refresh into history after identity changes', async () => {
    const pendingAdmissionQuota = deferred<QuotaSummary>();
    const listAttemptsA = vi.fn().mockResolvedValue({ attempts: [] });
    const createAttemptA = vi.fn().mockResolvedValue({
      attempt: runningAttempt(),
      dispatchConfirmed: true,
    });
    const getQuotaA = vi
      .fn()
      .mockResolvedValueOnce(quota(100))
      .mockReturnValueOnce(pendingAdmissionQuota.promise);
    const apiA = api({
      createAttempt: createAttemptA,
      getQuota: getQuotaA,
      listAttempts: listAttemptsA,
    });
    const listAttemptsB = vi.fn().mockResolvedValue({ attempts: [] });
    const apiB = api({
      getQuota: vi.fn().mockResolvedValue(quota(5)),
      listAttempts: listAttemptsB,
    });
    const captureSnapshot = vi.fn().mockResolvedValue({
      version: 4,
      draft: createDefaultDraft(),
    });
    const editor = { current: { captureSnapshot } } as unknown as {
      current: RobotEditorHandle | null;
    };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    const view = render(
      <AttemptActivity
        ref={ref}
        api={apiA}
        editor={editor}
        session={session('subject-a')}
        accessState="ready"
      />,
    );

    await settle();
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    expect(listAttemptsA).toHaveBeenCalledTimes(2);
    await act(async () => {
      ref.current!.start();
      for (let turn = 0; turn < 24; turn += 1) await Promise.resolve();
    });
    expect(createAttemptA).toHaveBeenCalledOnce();
    const admissionQuotaSignal = getQuotaA.mock.calls[1]?.[0];
    expect(admissionQuotaSignal).toBeInstanceOf(AbortSignal);

    view.rerender(
      <AttemptActivity
        ref={ref}
        api={apiB}
        editor={editor}
        session={session('subject-b')}
        accessState="ready"
      />,
    );
    await settle();
    expect(listAttemptsB).toHaveBeenCalledTimes(2);
    const oldHistoryCalls = listAttemptsA.mock.calls.length;
    expect(admissionQuotaSignal?.aborted).toBe(true);

    await act(async () => {
      pendingAdmissionQuota.resolve(quota(99));
      await Promise.resolve();
    });
    await settle();
    expect(listAttemptsA).toHaveBeenCalledTimes(oldHistoryCalls);
    expect(listAttemptsB).toHaveBeenCalledTimes(2);
    expect(createAttemptA).toHaveBeenCalledOnce();
    expect(apiB.createAttempt).not.toHaveBeenCalled();
  });
});
