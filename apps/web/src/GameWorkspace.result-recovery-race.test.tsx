// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type RobotDraft } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import type { AttemptAdmission, AttemptApi, AttemptSummary } from './attempt-api.js';
import { AttemptApiFailure } from './attempt-api.js';
import type { AuthSession } from './auth.js';
import type { DraftApi } from './draft-api.js';
import { GameWorkspace, type GameWorkspaceProps } from './GameWorkspace.js';
import { historyAction, historySection, settle } from './History.test-support.js';

const TEST_NOW = new Date('2026-10-28T12:00:00.000Z');
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

function session(): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub: 'subject-a', email: 'subject-a@example.test' },
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
        email: 'subject-a@example.test',
      },
      expires_at: now + 600,
    }),
  };
}

function summary(id: string, score: number): AttemptSummary {
  return {
    id,
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
    score,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: 1,
    finalSupport: LEVEL.exit.support,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function attemptApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
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
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
    putAnimationPreference: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-28',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    }),
    ...overrides,
  };
}

function draftApi(): DraftApi {
  return {
    getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    putDraft: vi.fn(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    })),
  };
}

function mountWorkspace(runnerOverrides: Partial<AttemptApi> = {}) {
  const runner = attemptApi(runnerOverrides);
  const editor = { current: null } as unknown as GameWorkspaceProps['editor'];
  const view = render(
    <GameWorkspace
      attemptApi={runner}
      draftApi={draftApi()}
      session={session()}
      editor={editor}
      accessState="ready"
      authPaused={false}
    />,
  );
  return { ...view, runner };
}

async function showHistory(rows: readonly AttemptSummary[]): Promise<void> {
  await settle();
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Navegación principal' })).getByRole('button', {
      name: 'Historial',
    }),
  );
  await settle();
  expect(
    [...historySection().querySelectorAll<HTMLElement>('[data-history-row-id]')].map(
      (item) => item.dataset.historyRowId,
    ),
  ).toEqual(rows.map((item) => item.id));
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
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

describe('GameWorkspace result processing race', () => {
  it('re-reads once when a result resolves after document hiding but before processing', async () => {
    const target = summary('result-race-hidden', 100);
    const staleResult = summary(target.id, 100);
    const currentResult = summary(target.id, 140);
    const request = deferred<AttemptSummary>();
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce(currentResult);
    mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getAttempt,
    });
    await showHistory([target]);
    fireEvent.click(await historyAction('Abrir'));
    await settle();
    expect(getAttempt).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => {
      request.resolve(staleResult);
      await Promise.resolve();
    });
    await settle();

    const panel = screen.getByRole('region', { name: 'Resultado consultado' });
    expect(within(panel).queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(getAttempt).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();

    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getAttempt.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(within(panel).getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(within(panel).getByLabelText('Puntaje de la victoria').textContent).toContain('140,00');
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();
    expect(getAttempt).toHaveBeenCalledTimes(2);
  });

  it('keeps a recovered pending start under activity ownership across document hide/show', async () => {
    const target = summary('result-race-pending-handoff', 100);
    const pending = { ...target, status: 'pending' as const, score: null, turnsUsed: 0, calls: 0 };
    const running = { ...pending, status: 'running' as const, turnsUsed: 1, calls: 1 };
    const terminal = summary(target.id, 160);
    const start = deferred<AttemptAdmission>();
    let startSignal: AbortSignal | undefined;
    let activityReads = 0;
    const getAttempt = vi
      .fn<AttemptApi['getAttempt']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Result unavailable.'))
      .mockResolvedValueOnce(pending)
      .mockImplementation(async () => {
        activityReads += 1;
        return activityReads === 1 ? running : terminal;
      });
    const startAttempt = vi.fn((_id: string, signal?: AbortSignal) => {
      startSignal = signal;
      return start.promise;
    });
    const listAttempts = vi
      .fn<AttemptApi['listAttempts']>()
      .mockResolvedValueOnce({ attempts: [pending] })
      .mockResolvedValueOnce({ attempts: [] })
      .mockResolvedValue({ attempts: [pending] });
    const mounted = mountWorkspace({
      listAttempts,
      getAttempt,
      startAttempt,
    });
    await showHistory([pending]);
    fireEvent.click(await historyAction('Abrir'));
    await settle();
    expect(getAttempt).toHaveBeenCalledOnce();

    await advance(60_000);
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(startAttempt.mock.calls[0]?.[0]).toBe(pending.id);
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Resultado consultado' })).toBeNull();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    await settle();
    await advance(10_000);
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(startAttempt).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    await settle();
    expect(startSignal?.aborted).toBe(false);
    expect(getAttempt).toHaveBeenCalledTimes(2);

    await act(async () => {
      start.resolve({ attempt: running, dispatchConfirmed: true });
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    await advance(2_100);
    expect(getAttempt).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    await advance(2_100);
    expect(getAttempt).toHaveBeenCalledTimes(4);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
    expect(startAttempt).toHaveBeenCalledOnce();

    await advance(2 * 60_000);
    expect(getAttempt).toHaveBeenCalledTimes(4);
  });
});
