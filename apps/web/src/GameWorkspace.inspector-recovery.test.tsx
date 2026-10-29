// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type RobotDraft } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import {
  AttemptApiFailure,
  type AttemptApi,
  type AttemptSummary,
  type DecisionDetail,
  type DecisionIndex,
} from './attempt-api.js';
import type { AuthSession } from './auth.js';
import type { DraftApi } from './draft-api.js';
import { GameWorkspace, type GameWorkspaceProps } from './GameWorkspace.js';
import { historyAction, historySection, settle } from './History.test-support.js';

const MINUTE = 60_000;
const TEST_NOW = new Date('2026-10-28T12:00:00.000Z');
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

const decisions: DecisionIndex['decisions'] = [
  { number: 1, decisionId: 'decision-1', originSupport: 2, hasAction: true },
  { number: 2, decisionId: 'decision-2', originSupport: 2, hasAction: false },
];

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

function summary(id: string): AttemptSummary {
  return {
    id,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:01.000Z',
    status: 'defeat',
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
    score: null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: 1,
    finalSupport: LEVEL.exit.support,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
  };
}

function decisionIndex(id: string): DecisionIndex {
  return { attemptId: id, levelId: LEVEL.id, decisions };
}

function decisionDetail(id: string, number: number): DecisionDetail {
  const item = decisions[number - 1]!;
  return {
    attemptId: id,
    levelId: LEVEL.id,
    item,
    observation: {
      facing: 'right',
      here: { objects: [], exit: false },
      left: { kind: 'segment', terrain: 'ground' },
      right: { kind: 'boundary' },
    },
    availableActions: [],
    choice: { state: 'invalid' },
    result: { kind: 'no-action', reason: 'invalid_response', turnsUsed: 1, status: 'error' },
  };
}

function attemptsApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('invalid', 'No se esperaba crear un intento.')),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'No se encontró la solicitud.', 404)),
    getAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'No se encontró el intento.', 404)),
    getConfiguration: vi.fn().mockResolvedValue({
      attemptId: 'unexpected-configuration',
      draft: createDefaultDraft(),
    }),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(async (id: string) => decisionIndex(id)),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
    putAnimationPreference: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-28',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 30 * 24 * MINUTE).toISOString(),
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function mountWorkspace(
  runnerOverrides: Partial<AttemptApi> = {},
  props: Partial<Pick<GameWorkspaceProps, 'session' | 'authPaused' | 'onAuthRequired'>> = {},
) {
  const runner = attemptsApi(runnerOverrides);
  const drafts = draftApi();
  const editor = { current: null } as unknown as GameWorkspaceProps['editor'];
  let currentProps: GameWorkspaceProps = {
    attemptApi: runner,
    draftApi: drafts,
    session: props.session ?? session(),
    editor,
    accessState: 'ready',
    authPaused: props.authPaused ?? false,
    ...(props.onAuthRequired ? { onAuthRequired: props.onAuthRequired } : {}),
  };
  const element = () => <GameWorkspace {...currentProps} />;
  const view = render(element());
  return {
    ...view,
    runner,
    drafts,
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

async function openInspector(target: AttemptSummary): Promise<void> {
  await settle();
  selectSurface('Historial');
  await settle();
  expect(
    [...historySection().querySelectorAll<HTMLElement>('[data-history-row-id]')].map(
      (row) => row.dataset.historyRowId,
    ),
  ).toEqual([target.id]);
  fireEvent.click(await historyAction('Inspeccionar decisiones'));
  await advance(0);
  await settle();
  expect(screen.getByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
}

function inspector(): HTMLElement {
  return screen.getByRole('region', { name: 'Inspector de decisiones' });
}

function selectDecision(number: number): void {
  fireEvent.click(
    within(inspector()).getAllByRole('button', { name: new RegExp(`Decisión ${number}`) })[0]!,
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

describe('GameWorkspace inspector recovery acceptance', () => {
  it('keeps the same-account selection through auth pause and resumes only its failed detail', async () => {
    const target = summary('inspector-auth-recovery');
    const mountedRef: { current: ReturnType<typeof mountWorkspace> | undefined } = {
      current: undefined,
    };
    const onAuthRequired = vi.fn(() => {
      mountedRef.current?.update({ authPaused: true });
      return true;
    });
    const getDecisionIndex = vi
      .fn<AttemptApi['getDecisionIndex']>()
      .mockResolvedValue(decisionIndex(target.id));
    const getDecision = vi
      .fn<AttemptApi['getDecision']>()
      .mockImplementation(async (id, number) => {
        if (
          number === 2 &&
          getDecision.mock.calls.filter(([, candidate]) => candidate === 2).length === 1
        ) {
          throw new AttemptApiFailure('authentication', 'Acceso rechazado.', 401, false, {
            authContext: 27,
          });
        }
        return decisionDetail(id, number);
      });
    const mounted = mountWorkspace(
      {
        listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
        getDecisionIndex,
        getDecision,
      },
      { onAuthRequired },
    );
    mountedRef.current = mounted;
    await openInspector(target);
    expect(screen.getByRole('heading', { name: 'Observación' })).toBeTruthy();
    selectDecision(2);
    await settle();

    expect(onAuthRequired).toHaveBeenCalledWith(27);
    expect.soft(screen.queryByRole('heading', { name: 'Decisión 2, casilla 2' })).not.toBeNull();
    expect.soft(screen.queryByRole('region', { name: 'Inspector de decisiones' })).not.toBeNull();
    const sideEffectBaseline = {
      createAttempt: vi.mocked(mounted.runner.createAttempt).mock.calls.length,
      getAttemptRequest: vi.mocked(mounted.runner.getAttemptRequest).mock.calls.length,
      getAttempt: vi.mocked(mounted.runner.getAttempt).mock.calls.length,
      listAttempts: vi.mocked(mounted.runner.listAttempts).mock.calls.length,
      startAttempt: vi.mocked(mounted.runner.startAttempt).mock.calls.length,
      cancelAttempt: vi.mocked(mounted.runner.cancelAttempt).mock.calls.length,
      getReplay: vi.mocked(mounted.runner.getReplay).mock.calls.length,
      completePresentation: vi.mocked(mounted.runner.completePresentation).mock.calls.length,
      getAnimationPreference: vi.mocked(mounted.runner.getAnimationPreference).mock.calls.length,
      putAnimationPreference: vi.mocked(mounted.runner.putAnimationPreference).mock.calls.length,
      getQuota: vi.mocked(mounted.runner.getQuota).mock.calls.length,
      putDraft: vi.mocked(mounted.drafts.putDraft).mock.calls.length,
    };

    await advance(MINUTE);
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    expect(getDecision).toHaveBeenCalledTimes(2);
    expect(vi.mocked(mounted.runner.getQuota)).toHaveBeenCalledTimes(sideEffectBaseline.getQuota);

    mounted.update({ session: session('subject-a', 'token-refreshed') });
    await settle();
    expect(vi.mocked(mounted.runner.getQuota)).toHaveBeenCalledTimes(sideEffectBaseline.getQuota);
    mounted.update({ authPaused: false });
    await settle();

    expect(getDecisionIndex).toHaveBeenCalledOnce();
    expect.soft(getDecision.mock.calls.map(([, number]) => number)).toEqual([1, 2, 2]);
    expect.soft(screen.queryByRole('heading', { name: 'Decisión 2, casilla 2' })).not.toBeNull();
    expect.soft(screen.queryByRole('heading', { name: 'Observación' })).not.toBeNull();
    expect(vi.mocked(mounted.runner.createAttempt)).toHaveBeenCalledTimes(
      sideEffectBaseline.createAttempt,
    );
    expect(vi.mocked(mounted.runner.getAttemptRequest)).toHaveBeenCalledTimes(
      sideEffectBaseline.getAttemptRequest,
    );
    expect(vi.mocked(mounted.runner.getAttempt)).toHaveBeenCalledTimes(
      sideEffectBaseline.getAttempt,
    );
    expect(vi.mocked(mounted.runner.listAttempts)).toHaveBeenCalledTimes(
      sideEffectBaseline.listAttempts,
    );
    expect(vi.mocked(mounted.runner.startAttempt)).toHaveBeenCalledTimes(
      sideEffectBaseline.startAttempt,
    );
    expect(vi.mocked(mounted.runner.cancelAttempt)).toHaveBeenCalledTimes(
      sideEffectBaseline.cancelAttempt,
    );
    expect(vi.mocked(mounted.runner.getReplay)).toHaveBeenCalledTimes(sideEffectBaseline.getReplay);
    expect(vi.mocked(mounted.runner.completePresentation)).toHaveBeenCalledTimes(
      sideEffectBaseline.completePresentation,
    );
    expect(vi.mocked(mounted.runner.getAnimationPreference)).toHaveBeenCalledTimes(
      sideEffectBaseline.getAnimationPreference,
    );
    expect(vi.mocked(mounted.runner.putAnimationPreference)).toHaveBeenCalledTimes(
      sideEffectBaseline.putAnimationPreference,
    );
    expect(vi.mocked(mounted.drafts.putDraft)).toHaveBeenCalledTimes(sideEffectBaseline.putDraft);
  });

  it('keeps the failed deadline when a stale auth rejection returns false and API/callback/token change', async () => {
    const target = summary('inspector-stale-auth-recovery');
    const oldIndex = vi
      .fn<AttemptApi['getDecisionIndex']>()
      .mockResolvedValue(decisionIndex(target.id));
    const oldDetail = vi.fn<AttemptApi['getDecision']>().mockImplementation(async (id, number) => {
      if (number === 2) {
        throw new AttemptApiFailure('authentication', 'Contexto anterior rechazado.', 401, false, {
          authContext: 31,
        });
      }
      return decisionDetail(id, number);
    });
    const newIndex = vi
      .fn<AttemptApi['getDecisionIndex']>()
      .mockResolvedValue(decisionIndex(target.id));
    let newDetailStartedAt: number | null = null;
    const newDetail = vi.fn<AttemptApi['getDecision']>().mockImplementation(async (id, number) => {
      newDetailStartedAt = Date.now();
      return decisionDetail(id, number);
    });
    const oldCallback = vi.fn(() => false);
    const newCallback = vi.fn(() => false);
    const mounted = mountWorkspace(
      {
        listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
        getDecisionIndex: oldIndex,
        getDecision: oldDetail,
      },
      { onAuthRequired: oldCallback },
    );
    await openInspector(target);
    expect(screen.getByRole('heading', { name: 'Observación' })).toBeTruthy();
    selectDecision(2);
    await settle();
    expect(oldCallback).toHaveBeenCalledWith(31);
    expect(oldDetail).toHaveBeenCalledTimes(2);
    expect.soft(screen.queryByRole('alert')).toBeNull();
    expect.soft(screen.queryByRole('button', { name: /Reintentar/i })).toBeNull();

    await advance(30_000);
    mounted.update({ session: session('subject-a', 'token-new') });
    await settle();
    expect.soft(newIndex).not.toHaveBeenCalled();
    expect.soft(newDetail).not.toHaveBeenCalled();
    mounted.update({ onAuthRequired: newCallback });
    await settle();
    expect.soft(newIndex).not.toHaveBeenCalled();
    expect.soft(newDetail).not.toHaveBeenCalled();
    mounted.update({
      attemptApi: attemptsApi({ getDecisionIndex: newIndex, getDecision: newDetail }),
    });
    await settle();
    expect(oldIndex).toHaveBeenCalledOnce();
    expect.soft(newIndex).not.toHaveBeenCalled();
    expect.soft(newDetail).not.toHaveBeenCalled();

    await advance(29_999);
    expect.soft(newDetail).not.toHaveBeenCalled();
    await advance(1);

    expect(oldIndex).toHaveBeenCalledOnce();
    expect(newIndex).not.toHaveBeenCalled();
    expect(newDetail).toHaveBeenCalledOnce();
    expect(newDetailStartedAt).toBe(TEST_NOW.getTime() + MINUTE);
    expect(newDetail.mock.calls[0]?.[0]).toBe(target.id);
    expect(newDetail.mock.calls[0]?.[1]).toBe(2);
    expect(newCallback).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Observación' })).toBeTruthy();
  });

  it.each(['close', 'surface', 'identity', 'unmount'] as const)(
    'aborts and ignores a late detail when the inspector is removed by %s',
    async (cause) => {
      const target = summary(`inspector-abort-${cause}`);
      const pendingDetail = deferred<DecisionDetail>();
      const getDecision = vi.fn<AttemptApi['getDecision']>().mockReturnValue(pendingDetail.promise);
      const mounted = mountWorkspace({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
        getDecisionIndex: vi.fn().mockResolvedValue(decisionIndex(target.id)),
        getDecision,
      });
      await openInspector(target);
      await settle();
      expect(getDecision).toHaveBeenCalledOnce();
      const signal = getDecision.mock.calls[0]?.[2];

      if (cause === 'close') {
        fireEvent.click(within(inspector()).getByRole('button', { name: 'Cerrar inspección' }));
      } else if (cause === 'surface') {
        selectSurface('Mis robots');
      } else if (cause === 'identity') {
        mounted.update({ session: session('subject-b', 'token-subject-b') });
      } else {
        mounted.unmount();
      }
      await settle();

      expect(signal?.aborted).toBe(true);
      await act(async () => {
        pendingDetail.resolve(decisionDetail(target.id, 1));
        await Promise.resolve();
      });
      await settle();
      expect(screen.queryByRole('heading', { name: 'Observación' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Inspector de decisiones' })).toBeNull();
      await advance(MINUTE);
      expect(getDecision).toHaveBeenCalledOnce();
    },
  );
});
