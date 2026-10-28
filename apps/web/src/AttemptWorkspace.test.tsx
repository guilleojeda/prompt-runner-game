// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  ROBOT_CATALOG_VERSION,
  ROBOT_SCHEMA_VERSION,
  type RobotDraft,
  type DraftSnapshot,
} from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import type { ReplayRecordView } from '../../../shared/attempt.js';
import type { AuthSession } from './auth.js';
import {
  AttemptApiFailure,
  type AttemptApi,
  type AttemptSummary,
  type DecisionDetail,
  type DecisionIndex,
} from './attempt-api.js';
import { AttemptActivityHarness as AttemptActivity } from './AttemptActivity.test-support.js';
import {
  historyAction,
  historyActionForRow,
  historyActions,
  historySection,
  openHistoryActionMenus,
  selectHistoryView,
} from './History.test-support.js';
import type { AttemptActivityHandle } from './useAttemptActivity.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';
import type { DraftApi } from './draft-api.js';
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

const ACK_DELAY = 60_000;

function session(
  email = 'a@example.com',
  expiresAt = Math.floor(Date.now() / 1000) + 600,
  accessToken = 'token',
  sub = 'subject-a',
): AuthSession {
  return {
    identity: { sub, email },
    user: new User({
      access_token: accessToken,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
        sub,
        email,
      },
      expires_at: expiresAt,
    }),
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

async function settleWorkspacePromises(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  });
}

type ApplyOptions = { signal: AbortSignal };
type ApplyDraftMock = (draft: RobotDraft, options: ApplyOptions) => Promise<boolean>;

function summary(status: AttemptSummary['status'] = 'running'): AttemptSummary {
  return {
    id: 'attempt-1',
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:01.000Z',
    status,
    cancelRequested: false,
    levelId: LEVEL.id,
    modelKey: 'claude-sonnet-4.6',
    modelLabel: 'Claude Sonnet 4.6',
    modelId: 'global.anthropic.claude-sonnet-4-6',
    turnsUsed: 2,
    maxTurns: 24,
    calls: 2,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    gameTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    score: null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: 0.4,
    finalSupport: 2,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
  };
}

function replayRecord(id = 'attempt-1'): ReplayRecordView {
  // AttemptActivity mocks ReplayScene; this 8-action transport fixture tests
  // result/recovery plumbing, while semantic replay validation lives in replay tests.
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
      actionCount: actions.length,
      finalStateId: snapshots.at(-1)!.id,
    },
    metrics: source.metrics,
    score: source.score,
  };
}

function setCurrentRecovery(storageKey: string, serializedReference: string): void {
  let value: unknown;
  try {
    value = JSON.parse(serializedReference);
  } catch {
    window.sessionStorage.setItem(storageKey, serializedReference);
    return;
  }
  if (storageKey === 'prompt-runner:attempt-recovery' && value && typeof value === 'object') {
    value = {
      ...value,
      draftContract: {
        schemaVersion: ROBOT_SCHEMA_VERSION,
        catalogVersion: ROBOT_CATALOG_VERSION,
      },
    };
  }
  window.sessionStorage.setItem(storageKey, JSON.stringify(value));
}

function api(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi
      .fn()
      .mockResolvedValue({ attempt: summary('running'), dispatchConfirmed: true }),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404)),
    getAttempt: vi.fn().mockResolvedValue(summary('running')),
    getConfiguration: vi.fn(),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 0 }),
    putAnimationPreference: vi
      .fn()
      .mockImplementation(async (animationEnabled: boolean, expectedVersion: number) => ({
        animationEnabled,
        version: expectedVersion + 1,
      })),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(),
    getDecision: vi.fn(),
    completePresentation: vi.fn().mockImplementation(async (id: string) => ({
      ...summary('victory'),
      id,
      animationEnabled: true,
    })),
    startAttempt: vi
      .fn()
      .mockResolvedValue({ attempt: summary('running'), dispatchConfirmed: true }),
    cancelAttempt: vi.fn().mockResolvedValue(summary('cancelled')),
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

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AttemptActivity', () => {
  it('uses Historial as the bootstrap-ready cue in the controller harness', async () => {
    let finishBootstrap!: (page: { attempts: readonly AttemptSummary[] }) => void;
    const bootstrap = new Promise<{ attempts: readonly AttemptSummary[] }>((resolve) => {
      finishBootstrap = resolve;
    });
    const listAttempts = vi.fn().mockReturnValueOnce(bootstrap).mockResolvedValue({ attempts: [] });
    const attemptApi = api({ listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await waitFor(() => expect(listAttempts).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: 'Historial' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Probar al agente' })).toBeTruthy();

    await act(async () => {
      finishBootstrap({ attempts: [] });
      await bootstrap;
    });
    expect(await screen.findByRole('heading', { name: 'Historial' })).toBeTruthy();
  });

  it('leaves viewport positioning to the workspace during admission, replay, and background loading', async () => {
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const terminal = {
        ...summary('victory'),
        turnsUsed: 8,
        animationEnabled: true,
        presentationComplete: false,
      };
      const attemptApi = api({
        getAttempt: vi.fn().mockResolvedValue(terminal),
        getReplay: vi.fn().mockResolvedValue(replayRecord()),
      });
      let finishCapture!: (snapshot: DraftSnapshot) => void;
      const editor = {
        current: {
          captureSnapshot: vi.fn(
            () =>
              new Promise<DraftSnapshot>((resolve) => {
                finishCapture = resolve;
              }),
          ),
        },
      } as unknown as { current: RobotEditorHandle | null };
      const ref = { current: null } as { current: AttemptActivityHandle | null };
      render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

      await screen.findByRole('heading', { name: 'Historial' });
      await waitFor(() => expect(screen.queryByText('Cargando preferencia guardada…')).toBeNull());
      expect(scroll).not.toHaveBeenCalled();
      act(() => ref.current!.start());
      expect(screen.getByText('Guardando la configuración e iniciando el intento…')).toBeTruthy();
      expect(scroll).not.toHaveBeenCalled();

      await act(async () => finishCapture({ version: 1, draft: createDefaultDraft() }));
      await screen.findByRole('heading', { name: 'Preparando intento' });
      expect(scroll).not.toHaveBeenCalled();
      await screen.findByRole('heading', { name: 'Reproducción del intento' }, { timeout: 4_000 });
      expect(scroll).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
      expect(scroll).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
      await screen.findByRole('heading', { name: 'Victoria' });
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      if (previousScroll) HTMLElement.prototype.scrollIntoView = previousScroll;
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('points an invalid attempt with no skills to enabling a skill and trying again', async () => {
    const createAttempt = vi
      .fn()
      .mockRejectedValue(
        new AttemptApiFailure('conflict', 'Seleccioná al menos una habilidad', 409),
      );
    const attemptApi = api({ createAttempt });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    await waitFor(() => expect(screen.queryByText('Cargando preferencia guardada…')).toBeNull());
    await act(async () => {
      ref.current!.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText('Seleccioná al menos una habilidad')).toBeTruthy();
    expect(
      screen.getByText('Habilitá al menos una habilidad y volvé a pulsar Probar.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar consultas' })).toBeNull();
  });

  it('offers a history-only manual retry after a history query error', async () => {
    const listAttempts = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'No se pudo cargar el historial.'))
      .mockResolvedValue({ attempts: [] });
    const getQuota = vi.fn().mockResolvedValue({
      day: '2026-09-21',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const attemptApi = api({ getQuota, listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    const retry = await screen.findByRole('button', { name: /Reintentar historial/i });
    expect(screen.queryByRole('button', { name: 'Reintentar consultas' })).toBeNull();
    expect(getQuota).toHaveBeenCalledOnce();
    const callsBeforeRetry = listAttempts.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(listAttempts.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Reintentar consultas' })).toBeNull();
    expect(getQuota).toHaveBeenCalledOnce();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('opens decision inspection from history and from the visible result', async () => {
    const terminal = {
      ...summary('victory'),
      turnsUsed: 1,
      animationEnabled: false,
    };
    const decisionIndex: DecisionIndex = {
      attemptId: terminal.id,
      levelId: LEVEL.id,
      decisions: [{ number: 1, decisionId: 'decision-1', originSupport: 0, hasAction: true }],
    };
    const decisionDetail: DecisionDetail = {
      attemptId: terminal.id,
      levelId: LEVEL.id,
      item: decisionIndex.decisions[0]!,
      observation: null,
      availableActions: null,
      choice: { state: 'unknown' },
      result: {
        kind: 'action',
        action: { kind: 'wait' },
        resolution: {},
        beforeSupport: 0,
        afterSupport: 0,
        turnsUsed: 1,
      },
    };
    const getDecisionIndex = vi.fn().mockResolvedValue(decisionIndex);
    const getDecision = vi.fn().mockResolvedValue(decisionDetail);
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getAttempt: vi.fn().mockResolvedValue(terminal),
      getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
      getDecisionIndex,
      getDecision,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click(await historyAction('Inspeccionar decisiones'));
    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    await waitFor(() =>
      expect(getDecisionIndex).toHaveBeenCalledWith(terminal.id, expect.any(AbortSignal)),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));
    fireEvent.click(await historyAction('Abrir'));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Victoria' }).closest('section') as HTMLElement,
      ).getByRole('button', { name: 'Inspeccionar decisiones' }),
    );
    expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();
    expect(getDecision).toHaveBeenCalledWith(terminal.id, 1, expect.any(AbortSignal));
  });

  it('opens the last action from defeat, skips trailing no-action records, and can return to the first decision', async () => {
    const terminal = {
      ...summary('defeat'),
      turnsUsed: 3,
      animationEnabled: false,
      reason: 'walk_into_pit',
    };
    const decisionIndex: DecisionIndex = {
      attemptId: terminal.id,
      levelId: LEVEL.id,
      decisions: [
        { number: 1, decisionId: 'decision-1', originSupport: 0, hasAction: true },
        { number: 2, decisionId: 'decision-2', originSupport: 1, hasAction: false },
      ],
    };
    const getDecision = vi.fn().mockImplementation((_id: string, number: number) => {
      const item = decisionIndex.decisions[number - 1]!;
      const result: DecisionDetail['result'] = item.hasAction
        ? {
            kind: 'action',
            action: { kind: 'advance' },
            resolution: { outcome: 'moved', reason: 'moved' },
            beforeSupport: item.originSupport,
            afterSupport: item.originSupport + 1,
            turnsUsed: number,
          }
        : { kind: 'no-action', reason: 'turn_limit_reached', turnsUsed: 3, status: 'incomplete' };
      return Promise.resolve({
        attemptId: terminal.id,
        levelId: LEVEL.id,
        item,
        observation: null,
        availableActions: null,
        choice: { state: 'unknown' },
        result,
      } satisfies DecisionDetail);
    });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getAttempt: vi.fn().mockResolvedValue(terminal),
      getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
      getDecisionIndex: vi.fn().mockResolvedValue(decisionIndex),
      getDecision,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click(await historyAction('Abrir'));
    const result = await screen.findByRole('heading', { name: 'Derrota' });
    const resultSection = result.closest('section') as HTMLElement;
    fireEvent.click(within(resultSection).getByRole('button', { name: 'Ir a la última acción' }));
    expect(await screen.findByRole('heading', { name: 'Decisión 1, casilla 0' })).toBeTruthy();
    await waitFor(() =>
      expect(getDecision).toHaveBeenLastCalledWith(terminal.id, 1, expect.any(AbortSignal)),
    );

    fireEvent.click(within(resultSection).getByRole('button', { name: 'Inspeccionar decisiones' }));
    expect(await screen.findByRole('heading', { name: 'Decisión 1, casilla 0' })).toBeTruthy();
    fireEvent.click(within(resultSection).getByRole('button', { name: 'Ir a la última acción' }));
    expect(await screen.findByRole('heading', { name: 'Decisión 1, casilla 0' })).toBeTruthy();
  });

  it('opens the final no-action decision from incomplete results and history', async () => {
    const terminal = { ...summary('incomplete'), animationEnabled: false };
    const decisionIndex: DecisionIndex = {
      attemptId: terminal.id,
      levelId: LEVEL.id,
      decisions: [
        { number: 1, decisionId: 'decision-1', originSupport: 3, hasAction: true },
        { number: 2, decisionId: 'decision-2', originSupport: 4, hasAction: false },
      ],
    };
    const decisionDetail: DecisionDetail = {
      attemptId: terminal.id,
      levelId: LEVEL.id,
      item: decisionIndex.decisions[0]!,
      observation: null,
      availableActions: null,
      choice: { state: 'unknown' },
      result: {
        kind: 'action',
        action: { kind: 'advance' },
        resolution: {},
        beforeSupport: 3,
        afterSupport: 4,
        turnsUsed: 2,
      },
    };
    const finalNoActionDetail: DecisionDetail = {
      ...decisionDetail,
      item: decisionIndex.decisions[1]!,
      result: {
        kind: 'no-action',
        reason: 'turn_limit_reached',
        turnsUsed: 2,
        status: 'incomplete',
      },
    };
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getAttempt: vi.fn().mockResolvedValue(terminal),
      getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
      getDecisionIndex: vi.fn().mockResolvedValue(decisionIndex),
      getDecision: vi
        .fn()
        .mockImplementation((_id: string, number: number) =>
          Promise.resolve(number === 2 ? finalNoActionDetail : decisionDetail),
        ),
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click(await historyAction('Ver último paso'));
    expect(await screen.findByRole('heading', { name: 'Decisión 2, casilla 4' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));
    fireEvent.click(await historyAction('Inspeccionar decisiones'));
    expect(await screen.findByRole('heading', { name: 'Decisión 1, casilla 3' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));
    fireEvent.click(await historyAction('Abrir'));
    const result = await screen.findByRole('heading', { name: 'Recorrido incompleto' });
    fireEvent.click(
      within(result.closest('section') as HTMLElement).getByRole('button', {
        name: 'Ver último paso',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Decisión 2, casilla 4' })).toBeTruthy();
  });

  it('inspects history B without replacing result A while A presentation acknowledgement is pending', async () => {
    const attemptA = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    const attemptB = {
      ...summary('incomplete'),
      id: 'attempt-2',
      createdAt: '2026-09-21T12:00:30.000Z',
      turnsUsed: 0,
      animationEnabled: false,
      presentationComplete: true,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: attemptA.id }),
    );
    let finishMark!: (value: AttemptSummary) => void;
    const completePresentation = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishMark = resolve;
        }),
    );
    const getDecisionIndex = vi.fn().mockResolvedValue({
      attemptId: attemptB.id,
      levelId: LEVEL.id,
      decisions: [],
    });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [attemptA, attemptB] }),
      getAttempt: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === attemptB.id ? attemptB : attemptA),
        ),
      getReplay: vi.fn().mockResolvedValue(replayRecord(attemptA.id)),
      completePresentation,
      getDecisionIndex,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    await waitFor(() =>
      expect(completePresentation).toHaveBeenCalledWith(attemptA.id, expect.any(AbortSignal)),
    );

    const history = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(history).not.toBeNull();
    fireEvent.click(await historyActionForRow('Inspeccionar decisiones', 'Recorrido incompleto'));
    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect(
      screen.getByText(/Intento inspeccionado: Recorrido incompleto, 21 sept 2026/),
    ).toBeTruthy();
    expect(screen.queryByText(/Intento inspeccionado: Victoria,/)).toBeNull();
    await waitFor(() =>
      expect(getDecisionIndex).toHaveBeenCalledWith(attemptB.id, expect.any(AbortSignal)),
    );
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Recorrido incompleto' })).toBeNull();

    await act(async () => {
      finishMark({ ...attemptA, presentationComplete: true });
      await Promise.resolve();
    });
    expect(completePresentation).toHaveBeenCalledTimes(1);
    expect(completePresentation).toHaveBeenCalledWith(attemptA.id, expect.any(AbortSignal));
    expect(screen.getByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('retries A in the background after inspecting B without changing the deadline or view', async () => {
    const attemptA = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    const attemptB = {
      ...summary('incomplete'),
      id: 'attempt-2',
      turnsUsed: 0,
      animationEnabled: false,
      presentationComplete: true,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: attemptA.id }),
    );
    const firstMark = deferred<AttemptSummary>();
    const completePresentation = vi
      .fn()
      .mockReturnValueOnce(firstMark.promise)
      .mockResolvedValueOnce({ ...attemptA, presentationComplete: true });
    const getDecisionIndex = vi.fn().mockResolvedValue({
      attemptId: attemptB.id,
      levelId: LEVEL.id,
      decisions: [],
    });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [attemptA, attemptB] }),
      getAttempt: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === attemptB.id ? attemptB : attemptA),
        ),
      getReplay: vi.fn().mockResolvedValue(replayRecord(attemptA.id)),
      completePresentation,
      getDecisionIndex,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('button', { name: 'Completar reproducción' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();

    fireEvent.click(await historyActionForRow('Inspeccionar decisiones', 'Recorrido incompleto'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect(getDecisionIndex).toHaveBeenCalledWith(attemptB.id, expect.any(AbortSignal));
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Recorrido incompleto' })).toBeNull();

    await act(async () => {
      firstMark.reject(new AttemptApiFailure('attempt_unavailable', '429', 429));
      await Promise.resolve();
    });
    await settleWorkspacePromises();
    expect(completePresentation).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(completePresentation).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settleWorkspacePromises();
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenLastCalledWith(attemptA.id, expect.any(AbortSignal));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('keeps inspection available for a complete terminal record through query failures and hides it after auth loss', async () => {
    const completeTerminalRecord = {
      ...summary('victory'),
      turnsUsed: 1,
      animationEnabled: false,
      recordComplete: true,
    };
    const getDecisionIndex = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('server', 'No se pudo consultar el índice de decisiones.', 500),
      )
      .mockRejectedValueOnce(new AttemptApiFailure('authentication', 'La sesión venció.', 401));
    const onAuthRequired = vi.fn();
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [completeTerminalRecord] }),
      getAttempt: vi.fn().mockResolvedValue(completeTerminalRecord),
      getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
      getDecisionIndex,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        authPaused={false}
        onAuthRequired={onAuthRequired}
      />,
    );

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click(await historyAction('Inspeccionar decisiones'));
    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    await screen.findByRole('alert');
    expect(onAuthRequired).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));

    fireEvent.click(await historyAction('Abrir'));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Victoria' }).closest('section') as HTMLElement,
      ).getByRole('button', { name: 'Inspeccionar decisiones' }),
    );
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: 'Inspeccionar decisiones' })).toBeNull();

    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        authPaused
        onAuthRequired={onAuthRequired}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Inspeccionar decisiones' })).toBeNull(),
    );
    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        authPaused={false}
        onAuthRequired={onAuthRequired}
      />,
    );
    expect(screen.queryByRole('heading', { name: 'Inspeccionar decisiones' })).toBeNull();
  });

  it('keeps the inspector open when App rejects a stale auth callback and recovers on retry', async () => {
    const terminal = {
      ...summary('victory'),
      turnsUsed: 1,
      animationEnabled: false,
    };
    const decisionIndex: DecisionIndex = {
      attemptId: terminal.id,
      levelId: LEVEL.id,
      decisions: [{ number: 1, decisionId: 'decision-1', originSupport: 0, hasAction: true }],
    };
    const getDecisionIndex = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('authentication', 'La sesión venció.', 401, false, {
          authContext: 9,
        }),
      )
      .mockResolvedValueOnce(decisionIndex);
    const onAuthRequired = vi.fn().mockReturnValue(false);
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getAttempt: vi.fn().mockResolvedValue(terminal),
      getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
      getDecisionIndex,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click(await historyAction('Inspeccionar decisiones'));
    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('La sesión venció.');
    expect(onAuthRequired).toHaveBeenCalledWith(9);
    expect(screen.getByRole('button', { name: 'Reintentar inspección' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar inspección' }));
    expect(
      await screen.findByRole('button', {
        name: /Casilla 0, Inicio, 1 decisión/,
      }),
    ).toBeTruthy();
  });

  it('closes the inspector before starting a new presentation', async () => {
    const terminal = { ...summary('victory'), turnsUsed: 1, animationEnabled: false };
    const running = { ...summary('running'), id: 'attempt-2', animationEnabled: false };
    const createAttempt = vi.fn().mockResolvedValue({ attempt: running, dispatchConfirmed: true });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getAttempt: vi.fn().mockResolvedValue(terminal),
      createAttempt,
      getDecisionIndex: vi.fn().mockResolvedValue({
        attemptId: terminal.id,
        levelId: LEVEL.id,
        decisions: [],
      }),
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click(await historyAction('Abrir'));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Victoria' }).closest('section') as HTMLElement,
      ).getByRole('button', { name: 'Inspeccionar decisiones' }),
    );
    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();

    act(() => (ref.current as AttemptActivityHandle).start());
    await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: 'Inspeccionar decisiones' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
  });

  it('waits for a confirmed animation choice before admitting the new attempt', async () => {
    let finishPreferenceSave!: (value: { animationEnabled: boolean; version: number }) => void;
    const putAnimationPreference = vi.fn(
      () =>
        new Promise<{ animationEnabled: boolean; version: number }>((resolve) => {
          finishPreferenceSave = resolve;
        }),
    );
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: {
        ...summary('victory'),
        animationEnabled: false,
        presentationComplete: true,
        turnsUsed: 8,
      },
      dispatchConfirmed: true,
    });
    const attemptApi = api({ createAttempt, putAnimationPreference });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 2, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

    await screen.findByText('Historial');
    expect(screen.getByText('Terreno con recompensa y puerta')).toBeTruthy();
    expect(screen.getByText('Probá tu robot para ver cómo recorre el terreno.')).toBeTruthy();
    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    expect(animation.checked).toBe(true);
    fireEvent.click(animation);
    expect(animation.checked).toBe(false);
    expect(await screen.findByText('Guardando preferencia…')).toBeTruthy();

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createAttempt).not.toHaveBeenCalled();
    expect(attemptApi.getReplay).not.toHaveBeenCalled();
    expect(putAnimationPreference).toHaveBeenCalledWith(false, 0, expect.any(AbortSignal));
    await act(async () => {
      finishPreferenceSave({ animationEnabled: false, version: 1 });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText('Guardando preferencia…')).toBeNull());
    expect(createAttempt).not.toHaveBeenCalled();

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createAttempt).toHaveBeenCalledWith(expect.any(String), 2, createDefaultDraft(), false);
    expect(attemptApi.getReplay).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.queryByText(/El robot llegó a la salida del recorrido/)).toBeNull();
    expect(screen.queryByText(/estático/)).toBeNull();
  });

  it('shows and resolves a cross-tab preference conflict without changing the visible choice', async () => {
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 })
      .mockResolvedValueOnce({ animationEnabled: true, version: 3 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('conflict', 'version conflict', 409))
      .mockResolvedValueOnce({ animationEnabled: false, version: 4 });
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    fireEvent.click(animation);
    await screen.findByText(/Otra pestaña|No se guardó tu cambio/);
    expect(animation.checked).toBe(false);
    expect(screen.getByText(/Valor guardado en el servidor: activado/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar mi selección' }));
    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledTimes(2));
    expect(putAnimationPreference.mock.calls.map(([value, version]) => [value, version])).toEqual([
      [false, 2],
      [false, 3],
    ]);
    expect(animation.checked).toBe(false);
    expect(screen.queryByRole('button', { name: 'Guardar mi selección' })).toBeNull();
  });

  it('retries a failed preference conflict comparison after a minute without repeating the PUT', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 })
      .mockRejectedValueOnce(
        new AttemptApiFailure('network', 'No se pudo consultar la preferencia de animación.'),
      )
      .mockResolvedValueOnce({ animationEnabled: true, version: 3 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('conflict', 'version conflict', 409));
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    fireEvent.click(animation);
    await settleWorkspacePromises();
    expect(screen.queryByRole('button', { name: 'Guardar mi selección' })).toBeNull();
    expect(animation.checked).toBe(false);

    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(document.getElementById('attempt-availability-status')?.textContent).toMatch(
      /(?:recuperando|confirmando) tu preferencia/i,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(putAnimationPreference).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settleWorkspacePromises();
    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(document.getElementById('attempt-availability-status')?.textContent).not.toMatch(
      /(?:recuperando|confirmando) tu preferencia/i,
    );
    expect(screen.getByRole('button', { name: 'Guardar mi selección' })).toBeTruthy();
    expect(animation.checked).toBe(false);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
  });

  it('keeps a newer local choice in conflict when comparison GET finds a remote change', async () => {
    let finishComparisonRead!: (value: { animationEnabled: boolean; version: number }) => void;
    const delayedComparisonRead = new Promise<{ animationEnabled: boolean; version: number }>(
      (resolve) => {
        finishComparisonRead = resolve;
      },
    );
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockReturnValueOnce(delayedComparisonRead);
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('conflict', 'Version conflict.', 409))
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 });
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    fireEvent.click(animation);
    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledOnce());
    await waitFor(() => expect(getAnimationPreference).toHaveBeenCalledTimes(2));
    fireEvent.click(animation);
    expect(animation.checked).toBe(true);

    await act(async () => {
      finishComparisonRead({ animationEnabled: false, version: 1 });
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Guardar mi selección' })).toBeTruthy();
    expect(screen.getByText(/Valor guardado en el servidor: desactivado/)).toBeTruthy();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(animation.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Guardar mi selección' }));
    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledTimes(2));

    expect(putAnimationPreference.mock.calls.map(([value, version]) => [value, version])).toEqual([
      [false, 0],
      [true, 1],
    ]);
    expect(animation.checked).toBe(true);
    expect(screen.queryByRole('button', { name: 'Guardar mi selección' })).toBeNull();
  });

  it('keeps the newer choice blocked after a failed conflict comparison until recovery confirms it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockRejectedValueOnce(
        new AttemptApiFailure('network', 'No se pudo consultar la preferencia de animación.'),
      )
      .mockResolvedValueOnce({ animationEnabled: true, version: 1 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('conflict', 'Version conflict.', 409));
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const onTryAvailabilityChange = vi.fn();
    render(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );
    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    fireEvent.click(animation);
    await settleWorkspacePromises();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(document.getElementById('attempt-availability-status')?.textContent).toMatch(
      /(?:recuperando|confirmando) tu preferencia/i,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(animation);
    expect(animation.checked).toBe(true);
    await settleWorkspacePromises();
    expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(animation.checked).toBe(true);
    expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(document.getElementById('attempt-availability-status')?.textContent).toMatch(
      /(?:recuperando|confirmando) tu preferencia/i,
    );
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settleWorkspacePromises();

    expect(getAnimationPreference).toHaveBeenCalledTimes(3);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(animation.checked).toBe(true);
    expect(document.getElementById('attempt-availability-status')?.textContent).not.toMatch(
      /(?:recuperando|confirmando) tu preferencia/i,
    );
    expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
  });

  it('stops a definite preference write auth rejection without a readback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const authError = new AttemptApiFailure(
      'authentication',
      'Tu sesión dejó de ser válida.',
      401,
      false,
      { authContext: 73 },
    );
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 });
    const putAnimationPreference = vi.fn().mockRejectedValue(authError);
    const onAuthRequired = vi.fn();
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );

    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    fireEvent.click(animation);
    await settleWorkspacePromises();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(screen.queryByText('Guardando preferencia…')).toBeNull();
    expect(onAuthRequired).toHaveBeenCalledOnce();
    expect(onAuthRequired).toHaveBeenCalledWith(73);
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    expect(animation.checked).toBe(false);
    expect(screen.getByText('Tu sesión dejó de ser válida.')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
  });

  it('notifies auth recovery when preference readback is rejected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const authError = new AttemptApiFailure(
      'authentication',
      'Tu sesión dejó de ser válida.',
      401,
      false,
      { authContext: 74 },
    );
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockRejectedValueOnce(authError);
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('conflict', 'version conflict', 409));
    const onAuthRequired = vi.fn();
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );

    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Animación' }));
    await settleWorkspacePromises();
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(onAuthRequired).toHaveBeenCalledOnce();
    expect(onAuthRequired).toHaveBeenCalledWith(74);
    expect(screen.getByText('Tu sesión dejó de ser válida.')).toBeTruthy();
    expect(screen.queryByText('version conflict')).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement).checked).toBe(
      false,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
  });

  it('ignores a late auth readback rejection after the account generation changes', async () => {
    let rejectReadback!: (error: unknown) => void;
    const delayedReadback = new Promise<never>((_, reject) => {
      rejectReadback = reject;
    });
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockReturnValueOnce(delayedReadback)
      .mockResolvedValue({ animationEnabled: true, version: 0 });
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('conflict', 'version conflict', 409));
    const onAuthRequired = vi.fn();
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session('a@example.com', undefined, 'token-a', 'subject-a')}
        onAuthRequired={onAuthRequired}
      />,
    );

    await screen.findByText('Historial');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Animación' }));
    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledOnce());
    await waitFor(() => expect(getAnimationPreference).toHaveBeenCalledTimes(2));

    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session('b@example.com', undefined, 'token-b', 'subject-b')}
        onAuthRequired={onAuthRequired}
      />,
    );
    await act(async () => {
      rejectReadback(new AttemptApiFailure('authentication', 'La sesión venció.', 401));
      await Promise.resolve();
    });

    expect(onAuthRequired).not.toHaveBeenCalled();
  });

  it('reconciles the latest preference choice before writing after same-account auth resume', async () => {
    let finishPreferenceSave!: (value: { animationEnabled: boolean; version: number }) => void;
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockResolvedValueOnce({ animationEnabled: false, version: 1 });
    const putAnimationPreference = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ animationEnabled: boolean; version: number }>((resolve) => {
            finishPreferenceSave = resolve;
          }),
      )
      .mockResolvedValueOnce({ animationEnabled: true, version: 2 });
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused={false} />,
    );

    await screen.findByText('Historial');
    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    fireEvent.click(animation);
    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledOnce());
    fireEvent.click(animation);
    expect(animation.checked).toBe(true);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    const sentSignal = putAnimationPreference.mock.calls[0]?.[2];
    view.rerender(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused />,
    );

    expect(animation.disabled).toBe(true);
    expect(animation.checked).toBe(true);
    expect(sentSignal?.aborted).toBe(true);
    await act(async () => {
      finishPreferenceSave({ animationEnabled: false, version: 1 });
      await Promise.resolve();
    });
    expect((screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(putAnimationPreference).toHaveBeenCalledOnce();
    expect(getAnimationPreference).toHaveBeenCalledOnce();

    view.rerender(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused={false} />,
    );
    await waitFor(() =>
      expect(putAnimationPreference).toHaveBeenCalledWith(true, 1, expect.any(AbortSignal)),
    );
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(getAnimationPreference.mock.invocationCallOrder[1]).toBeLessThan(
      putAnimationPreference.mock.invocationCallOrder[1]!,
    );
    expect((screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.queryByText(/Tu selección quedó pendiente/)).toBeNull();
  });

  it('recovers pending playback without exposing the result early and lets the player replay without inference', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    const completePresentation = vi.fn().mockResolvedValue({
      ...pending,
      presentationComplete: true,
    });
    const getReplay = vi.fn().mockResolvedValue(replayRecord());
    const createAttempt = vi.fn();
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay,
      completePresentation,
      createAttempt,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(getReplay).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ver de nuevo' }));
    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getReplay).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('waits for a terminal summary before fetching an automatic replay', async () => {
    const active = {
      ...summary('running'),
      turnsUsed: 2,
      animationEnabled: true,
      presentationComplete: false,
    };
    const terminal = {
      ...active,
      status: 'victory' as const,
      turnsUsed: 8,
      updatedAt: '2026-09-21T12:05:00.000Z',
    };
    const getAttempt = vi.fn().mockResolvedValue(terminal);
    const getReplay = vi.fn().mockResolvedValue(replayRecord());
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [active] }),
      getAttempt,
      getReplay,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(getReplay).not.toHaveBeenCalled();
    await waitFor(() => expect(getReplay).toHaveBeenCalledOnce(), { timeout: 4_000 });
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
  });

  it('refreshes an incomplete automatic summary before retrying the replay', async () => {
    const incomplete = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
      recordComplete: false,
    };
    const complete = { ...incomplete, recordComplete: true };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: incomplete.id }),
    );
    const getAttempt = vi.fn().mockResolvedValueOnce(incomplete).mockResolvedValueOnce(complete);
    const getReplay = vi.fn().mockResolvedValue(replayRecord());
    const attemptApi = api({ getAttempt, getReplay });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByText(/El registro está incompleto/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar reproducción' }));

    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    expect(getAttempt).toHaveBeenCalledTimes(2);
    expect(getReplay).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
  });

  it('keeps the result accessible if the refreshed record remains incomplete', async () => {
    const incomplete = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
      recordComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: incomplete.id }),
    );
    const getAttempt = vi.fn().mockResolvedValue(incomplete);
    const getReplay = vi.fn();
    const attemptApi = api({ getAttempt, getReplay });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByText(/El registro está incompleto/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar reproducción' }));
    expect(await screen.findByText(/El registro sigue incompleto/)).toBeTruthy();
    expect(getReplay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getReplay).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Compartir resultado' })).toBeTruthy();
  });

  it.each([
    ['cancelled', 'Cancelado'],
    ['error', 'Error de ejecución'],
  ] as const)(
    'shows a zero-action %s result directly without replay controls',
    async (status, label) => {
      const terminal = {
        ...summary(status),
        animationEnabled: true,
        presentationComplete: true,
        turnsUsed: 0,
      };
      const attemptApi = api({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt: vi.fn().mockResolvedValue(terminal),
      });
      const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
      render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

      const showResult = await historyAction('Abrir');
      const history = historySection();
      openHistoryActionMenus(history);
      expect(within(history).queryByRole('button', { name: 'Ver de nuevo' })).toBeNull();
      fireEvent.click(showResult);
      expect(await screen.findByRole('heading', { name: label })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Ver de nuevo' })).toBeNull();
      expect(attemptApi.getReplay).not.toHaveBeenCalled();
    },
  );

  it('shows collected object value without presenting it as an awarded score after defeat', async () => {
    const collected = {
      ...summary('defeat'),
      reason: 'walk_into_pit',
      collectedObjectIds: ['recompensa-1'],
      objectPoints: 25,
      animationEnabled: false,
      presentationComplete: true,
      turnsUsed: 6,
    };
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [collected] }),
      getAttempt: vi.fn().mockResolvedValue(collected),
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const history = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(history).not.toBeNull();
    expect(within(history as HTMLElement).getByText('Derrota')).toBeTruthy();

    fireEvent.click(await historyAction('Abrir'));
    await screen.findByRole('heading', { name: 'Derrota' });
    expect(screen.getByText('Avance máximo').nextElementSibling?.textContent).toBe('40%');
    expect(screen.getByText('Recompensa').nextElementSibling?.textContent).toBe(
      'Recogida, 25 puntos',
    );
    expect(screen.getByText('Llave').nextElementSibling?.textContent).toBe('No recogida');
    expect(screen.queryByText('Puntaje')).toBeNull();
    expect(screen.queryByText(/Causa registrada|obstáculo incompatible|cayó/i)).toBeNull();
  });

  it('shows a collected victory result and history values directly with animation disabled', async () => {
    const collected = {
      ...summary('victory'),
      turnsUsed: 8,
      inputTokens: 9000,
      outputTokens: 868,
      gameTokens: 9868,
      score: 935.13,
      collectedObjectIds: ['recompensa-1', 'llave-1'],
      objectPoints: 25,
      animationEnabled: false,
    };
    const getReplay = vi.fn();
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [collected] }),
      getAttempt: vi.fn().mockResolvedValue(collected),
      getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
      getReplay,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    expect((screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement).checked).toBe(
      false,
    );
    const history = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(history).not.toBeNull();
    const historyRows = within(history as HTMLElement).getAllByRole('listitem');
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]?.textContent).toContain('Victoria');
    expect(historyRows[0]?.textContent).toContain('935,13');
    expect(getReplay).not.toHaveBeenCalled();

    fireEvent.click(await historyAction('Abrir'));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    const scoreBreakdown = screen.getByText('Desglose del puntaje').closest('details');
    expect(scoreBreakdown).not.toBeNull();
    expect((scoreBreakdown as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(within(scoreBreakdown as HTMLElement).getByText('Desglose del puntaje'));
    expect((scoreBreakdown as HTMLDetailsElement).open).toBe(true);
    expect(screen.queryByText('Avance máximo')).toBeNull();
    expect(screen.getByText('Turnos').nextElementSibling?.textContent).toBe('8 / 24');
    expect(screen.getByText('Recompensa').nextElementSibling?.textContent).toBe(
      'Recogida, 25 puntos',
    );
    expect(screen.getByText('Llave').nextElementSibling?.textContent).toBe('Recogida');
    const score = screen.getByLabelText('Puntaje de la victoria');
    expect(within(score).getByText('Puntaje')).toBeTruthy();
    expect(within(score).getByText('935,13')).toBeTruthy();
    expect(screen.getByText('Objetos recogidos').nextElementSibling?.textContent).toBe(
      '+25 puntos',
    );
    expect(screen.getByText('Descuento por turnos (8 x 10)').nextElementSibling?.textContent).toBe(
      '-80 puntos',
    );
    expect(
      screen.getByText('Descuento por tokens (9.868 / 1.000)').nextElementSibling?.textContent,
    ).toBe('-9,868 puntos');
    expect(screen.getByText('Total').nextElementSibling?.textContent).toBe('935,13 puntos');
    const agentDetails = screen.getByText('Detalles del agente').closest('details');
    expect(agentDetails).not.toBeNull();
    expect((agentDetails as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(within(agentDetails as HTMLElement).getByText('Detalles del agente'));
    expect(within(agentDetails as HTMLElement).getByText('Claude Sonnet 4.6')).toBeTruthy();
    expect(within(agentDetails as HTMLElement).getByText('9.868')).toBeTruthy();
    expect(getReplay).not.toHaveBeenCalled();
  });

  it('keeps missing token usage unknown while showing the persisted negative score', async () => {
    const collected = {
      ...summary('victory'),
      turnsUsed: 20,
      gameTokens: null,
      score: -37.2,
      objectPoints: 0,
      collectedObjectIds: [],
      animationEnabled: false,
    };
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [collected] }),
      getAttempt: vi.fn().mockResolvedValue(collected),
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click(await historyAction('Abrir'));
    await screen.findByRole('heading', { name: 'Victoria' });
    const scoreBreakdown = screen.getByText('Desglose del puntaje').closest('details');
    expect(scoreBreakdown).not.toBeNull();
    expect((scoreBreakdown as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(within(scoreBreakdown as HTMLElement).getByText('Desglose del puntaje'));
    expect((scoreBreakdown as HTMLDetailsElement).open).toBe(true);
    expect(
      within(screen.getByLabelText('Puntaje de la victoria')).getByText('-37,20'),
    ).toBeTruthy();
    expect(
      screen.getByText('Descuento por tokens (desconocido)').nextElementSibling?.textContent,
    ).toBe('desconocido');
    expect(screen.getByText('Total').nextElementSibling?.textContent).toBe('-37,20 puntos');
    const agentDetails = screen.getByText('Detalles del agente').closest('details');
    expect((agentDetails as HTMLDetailsElement).open).toBe(false);
  });

  it('replays a current history record manually without admitting or marking it again', async () => {
    const historical = { ...summary('victory'), animationEnabled: false, turnsUsed: 8 };
    const getReplay = vi.fn().mockResolvedValue(replayRecord(historical.id));
    const createAttempt = vi.fn();
    const completePresentation = vi.fn();
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [historical] }),
      getAttempt: vi.fn().mockResolvedValue(historical),
      getReplay,
      createAttempt,
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await historyAction('Ver de nuevo'));
    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ver configuración' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getReplay).toHaveBeenCalledWith(historical.id);
    expect(createAttempt).not.toHaveBeenCalled();
    expect(completePresentation).not.toHaveBeenCalled();
  });

  it('keeps replay errors recoverable and lets the player open the stored result', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    let finishMark!: (value: AttemptSummary) => void;
    const completePresentation = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishMark = resolve;
        }),
    );
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay: vi.fn().mockResolvedValue(replayRecord()),
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Fallar reproducción' }));
    expect(await screen.findByText('No se pudo preparar la reproducción.')).toBeTruthy();
    expect(screen.queryByText('Faltan símbolos')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(completePresentation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(await screen.findByText('Guardando el cierre de la presentación…')).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(completePresentation).toHaveBeenCalledWith(pending.id, expect.any(AbortSignal));
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(pending.id);
    expect(screen.queryByRole('button', { name: 'Reintentar cierre de presentación' })).toBeNull();

    await act(async () => {
      finishMark({ ...pending, presentationComplete: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull(),
    );
  });

  it('keeps a transient ACK pending quietly and retries it after one minute', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    const completePresentation = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('attempt_unavailable', 'Están llegando muchas solicitudes.', 429),
      )
      .mockResolvedValueOnce({ ...pending, presentationComplete: true });
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay: vi.fn().mockResolvedValue(replayRecord()),
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('button', { name: 'Completar reproducción' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settleWorkspacePromises();

    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(screen.queryByText(/No se pudo guardar el cierre/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Reintentar cierre/ })).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(completePresentation).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settleWorkspacePromises();
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it.each(['before', 'during'] as const)(
    'retries a failed ACK that happens %s manual replay without ending the replay',
    async (failureTiming) => {
      const pending = {
        ...summary('victory'),
        turnsUsed: 8,
        animationEnabled: true,
        presentationComplete: false,
      };
      setCurrentRecovery(
        'prompt-runner:attempt-recovery',
        JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
      );
      const firstMark = deferred<AttemptSummary>();
      const completePresentation = vi
        .fn()
        .mockReturnValueOnce(firstMark.promise)
        .mockResolvedValueOnce({ ...pending, presentationComplete: true });
      const attemptApi = api({
        getAttempt: vi.fn().mockResolvedValue(pending),
        getReplay: vi.fn().mockResolvedValue(replayRecord()),
        completePresentation,
      });
      const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
      render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

      await screen.findByRole('button', { name: 'Completar reproducción' });
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
      fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
      await settleWorkspacePromises();
      const result = screen.getByRole('heading', { name: 'Victoria' });
      expect(completePresentation).toHaveBeenCalledOnce();

      if (failureTiming === 'during') {
        fireEvent.click(
          within(result.closest('section') as HTMLElement).getByRole('button', {
            name: 'Ver de nuevo',
          }),
        );
        await settleWorkspacePromises();
        expect(screen.getByRole('heading', { name: 'Ver de nuevo' })).toBeTruthy();
      }
      await act(async () => {
        firstMark.reject(
          new AttemptApiFailure('attempt_unavailable', 'Están llegando muchas solicitudes.', 429),
        );
        await Promise.resolve();
      });
      await settleWorkspacePromises();
      expect(completePresentation).toHaveBeenCalledOnce();
      if (failureTiming === 'before') {
        fireEvent.click(
          within(result.closest('section') as HTMLElement).getByRole('button', {
            name: 'Ver de nuevo',
          }),
        );
        await settleWorkspacePromises();
        expect(screen.getByRole('heading', { name: 'Ver de nuevo' })).toBeTruthy();
      }

      await act(async () => vi.advanceTimersByTimeAsync(59_999));
      expect(completePresentation).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      await settleWorkspacePromises();
      expect(completePresentation).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('heading', { name: 'Ver de nuevo' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
      await settleWorkspacePromises();
      expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
      expect(completePresentation).toHaveBeenCalledTimes(2);
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
    },
  );

  it('accepts ACK success during manual replay without ending the replay early', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    let finishMark!: (value: AttemptSummary) => void;
    const completePresentation = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishMark = resolve;
        }),
    );
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay: vi.fn().mockResolvedValue(replayRecord()),
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    const result = await screen.findByRole('heading', { name: 'Victoria' });
    await waitFor(() => expect(completePresentation).toHaveBeenCalledOnce());
    fireEvent.click(
      within(result.closest('section') as HTMLElement).getByRole('button', {
        name: 'Ver de nuevo',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Ver de nuevo' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();

    await act(async () => {
      finishMark({ ...pending, presentationComplete: true });
      await Promise.resolve();
    });
    expect(await screen.findByRole('heading', { name: 'Ver de nuevo' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reintentar cierre de presentación' })).toBeNull();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar cierre de presentación' })).toBeNull();
    expect(completePresentation).toHaveBeenCalledOnce();
  });

  it('preserves a manual replay lookup error when the pending ACK later succeeds', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    let finishMark!: (value: AttemptSummary) => void;
    const completePresentation = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishMark = resolve;
        }),
    );
    const getReplay = vi
      .fn()
      .mockResolvedValueOnce(replayRecord())
      .mockRejectedValueOnce(
        new AttemptApiFailure('server', 'No se pudo consultar el registro.', 500),
      );
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay,
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    const result = await screen.findByRole('heading', { name: 'Victoria' });
    await waitFor(() => expect(completePresentation).toHaveBeenCalledOnce());
    fireEvent.click(
      within(result.closest('section') as HTMLElement).getByRole('button', {
        name: 'Ver de nuevo',
      }),
    );
    expect(await screen.findByText('No se pudo consultar el registro.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar reproducción' })).toBeTruthy();

    await act(async () => {
      finishMark({ ...pending, presentationComplete: true });
      await Promise.resolve();
    });
    expect(screen.getByText('No se pudo consultar el registro.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar reproducción' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver resultado' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Reintentar cierre de presentación' })).toBeNull();
  });

  it('does not duplicate or reset a pending ACK when its attempt is reopened from history', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    const completePresentation = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('attempt_unavailable', 'Gateway limitado.', 429))
      .mockResolvedValueOnce({ ...pending, presentationComplete: true });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay: vi.fn().mockResolvedValue(replayRecord()),
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('button', { name: 'Completar reproducción' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(20_000));

    const history = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(history).not.toBeNull();
    fireEvent.click(await historyAction('Ver de nuevo'));
    await settleWorkspacePromises();
    expect(screen.getByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY - 20_001));
    expect(completePresentation).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settleWorkspacePromises();
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('keeps automatic history replay active when an earlier ACK succeeds as it starts', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    let finishMark!: (value: AttemptSummary) => void;
    const completePresentation = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishMark = resolve;
        }),
    );
    const getReplay = vi
      .fn()
      .mockResolvedValueOnce(replayRecord())
      .mockImplementationOnce(() => {
        finishMark({ ...pending, presentationComplete: true });
        return Promise.resolve(replayRecord());
      });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay,
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    await screen.findByRole('heading', { name: 'Victoria' });
    await waitFor(() => expect(completePresentation).toHaveBeenCalledOnce());
    const history = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(history).not.toBeNull();
    fireEvent.click(await historyAction('Ver de nuevo'));
    expect(await screen.findByRole('heading', { name: 'Reproducción del intento' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Reproducción del intento' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    await waitFor(() =>
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar cierre de presentación' })).toBeNull();
    expect(completePresentation).toHaveBeenCalledOnce();
  });

  it('settles A after switching history replays without ending the current replay', async () => {
    const attemptA = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    const attemptB = {
      ...summary('incomplete'),
      id: 'attempt-2',
      turnsUsed: 8,
      animationEnabled: false,
      presentationComplete: true,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: attemptA.id }),
    );
    let finishMark!: (value: AttemptSummary) => void;
    const completePresentation = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishMark = resolve;
        }),
    );
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [attemptA, attemptB] }),
      getAttempt: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === attemptB.id ? attemptB : attemptA),
        ),
      getReplay: vi.fn().mockImplementation(async (id: string) => {
        const record = replayRecord(id);
        const target = id === attemptB.id ? attemptB : attemptA;
        return { ...record, closure: { ...record.closure, status: target.status } };
      }),
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    await screen.findByRole('heading', { name: 'Victoria' });
    await waitFor(() => expect(completePresentation).toHaveBeenCalledOnce());
    const history = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(history).not.toBeNull();
    fireEvent.click((await historyActions('Ver de nuevo'))[1]!);
    expect(await screen.findByRole('heading', { name: 'Ver de nuevo' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Recorrido incompleto' })).toBeTruthy();

    const historyAfterB = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(historyAfterB).not.toBeNull();
    fireEvent.click((await historyActions('Abrir'))[0]!);
    expect(await screen.findByRole('heading', { name: 'Reproducción del intento' })).toBeTruthy();
    await act(async () => {
      finishMark({ ...attemptA, presentationComplete: true });
      await Promise.resolve();
    });

    expect(await screen.findByRole('heading', { name: 'Reproducción del intento' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Recorrido incompleto' })).toBeNull();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('shows and unlocks the result while the automatic presentation mark is still pending', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    let finishMark!: (value: AttemptSummary) => void;
    const completePresentation = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishMark = resolve;
        }),
    );
    const onBusyChange = vi.fn();
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay: vi.fn().mockResolvedValue(replayRecord()),
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        onBusyChange={onBusyChange}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(await screen.findByText('Guardando el cierre de la presentación…')).toBeTruthy();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(pending.id);

    await act(async () => {
      finishMark({ ...pending, presentationComplete: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull(),
    );
  });

  it('replays from the server snapshot after repeated reloads when ACK confirmation failed', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    const firstApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay: vi.fn().mockResolvedValue(replayRecord()),
      completePresentation: vi
        .fn()
        .mockRejectedValue(new AttemptApiFailure('server', 'Sin confirmación.', 500)),
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const firstRender = render(
      <AttemptActivity api={firstApi} editor={editor} session={session()} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.queryByText(/No se pudo guardar el cierre/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Reintentar cierre/ })).toBeNull();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(pending.id);
    firstRender.unmount();

    for (let reload = 0; reload < 2; reload += 1) {
      const getReplay = vi.fn().mockResolvedValue(replayRecord());
      const retryMark = vi
        .fn()
        .mockRejectedValue(new AttemptApiFailure('server', 'Sigue pendiente.', 500));
      const resumedApi = api({
        getAttempt: vi.fn().mockResolvedValue(pending),
        getReplay,
        completePresentation: retryMark,
      });
      const resumed = render(
        <AttemptActivity api={resumedApi} editor={editor} session={session()} />,
      );
      expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
      expect(getReplay).toHaveBeenCalledOnce();
      expect(retryMark).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(pending.id);
      fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
      expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
      await waitFor(() => expect(retryMark).toHaveBeenCalledOnce());
      expect(screen.queryByText(/No se pudo guardar el cierre/)).toBeNull();
      expect(screen.queryByRole('button', { name: /Reintentar cierre/ })).toBeNull();
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(pending.id);
      resumed.unmount();
    }
  });

  it('uses a completed server summary to open the result directly after reload', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    const completed = { ...pending, presentationComplete: true };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    let finishGetAttempt!: (value: AttemptSummary) => void;
    const getAttempt = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishGetAttempt = resolve;
        }),
    );
    const getReplay = vi.fn();
    const completePresentation = vi.fn();
    const attemptApi = api({ getAttempt, getReplay, completePresentation });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await waitFor(() =>
      expect(getAttempt).toHaveBeenCalledWith(pending.id, expect.any(AbortSignal)),
    );

    await act(async () => {
      finishGetAttempt(completed);
      await Promise.resolve();
    });
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getReplay).not.toHaveBeenCalled();
    expect(completePresentation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('replays a history attempt when the server still reports presentation pending', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    const getReplay = vi.fn().mockResolvedValue(replayRecord(pending.id));
    const completePresentation = vi
      .fn()
      .mockResolvedValue({ ...pending, presentationComplete: true });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay,
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');
    const open = await historyActionForRow('Abrir', 'Recorrido incompleto');
    const history = historySection();
    const incompleteRow = within(history)
      .getAllByRole('listitem')
      .find((row) => row.textContent?.includes('Recorrido incompleto'));
    expect(incompleteRow).toBeTruthy();
    expect(
      within(incompleteRow!).queryByRole('button', { name: 'Inspeccionar decisiones' }),
    ).toBeNull();
    fireEvent.click(open);
    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    expect(getReplay).toHaveBeenCalledWith(pending.id);
    expect(completePresentation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();
  });

  it('recovers B without carrying A as the foreground recovery', async () => {
    const attemptA = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    const attemptB = {
      ...summary('running'),
      id: 'attempt-2',
      animationEnabled: false,
      presentationComplete: true,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: attemptA.id }),
    );
    const firstMark = new Promise<AttemptSummary>(() => undefined);
    const firstApi = api({
      getAttempt: vi.fn().mockResolvedValue(attemptA),
      getReplay: vi.fn().mockResolvedValue(replayRecord(attemptA.id)),
      completePresentation: vi.fn().mockReturnValue(firstMark),
      createAttempt: vi.fn().mockResolvedValue({ attempt: attemptB, dispatchConfirmed: true }),
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 3, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    const firstRender = render(
      <AttemptActivity ref={ref} api={firstApi} editor={editor} session={session()} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(attemptA.id);

    act(() => (ref.current as AttemptActivityHandle).start());
    await waitFor(() => expect(firstApi.createAttempt).toHaveBeenCalledOnce());
    await waitFor(() => {
      const recovery = JSON.parse(
        window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}',
      ) as { attemptId?: string };
      expect(recovery.attemptId).toBe(attemptB.id);
    });
    firstRender.unmount();

    const completePresentation = vi.fn();
    const resumedApi = api({
      getAttempt: vi
        .fn()
        .mockImplementation(async (id: string) => (id === attemptB.id ? attemptB : attemptA)),
      getReplay: vi.fn(),
      completePresentation,
    });

    const secondRender = render(
      <AttemptActivity api={resumedApi} editor={editor} session={session()} />,
    );
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(resumedApi.getAttempt).toHaveBeenCalledWith(attemptB.id, expect.any(AbortSignal));
    expect(resumedApi.getAttempt).not.toHaveBeenCalledWith(attemptA.id, expect.anything());
    expect(resumedApi.getReplay).not.toHaveBeenCalled();
    expect(completePresentation).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toMatchObject({ sub: 'subject-a', attemptId: attemptB.id });
    secondRender.unmount();

    const finalApi = api({
      getAttempt: vi.fn().mockResolvedValue(attemptB),
      getReplay: vi.fn(),
      completePresentation,
    });
    render(<AttemptActivity api={finalApi} editor={editor} session={session()} />);
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(finalApi.getReplay).not.toHaveBeenCalled();
    expect(completePresentation).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toMatchObject({ sub: 'subject-a', attemptId: attemptB.id });
  });

  it('does not replace active B when A ACK settles in the background', async () => {
    const attemptA = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    const attemptB = {
      ...summary('running'),
      id: 'attempt-2',
      animationEnabled: false,
      presentationComplete: true,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: attemptA.id }),
    );
    let finishMark!: (value: AttemptSummary) => void;
    const completePresentation = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          finishMark = resolve;
        }),
    );
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(attemptA),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [attemptA, attemptB] }),
      getReplay: vi.fn().mockResolvedValue(replayRecord(attemptA.id)),
      completePresentation,
      createAttempt: vi.fn().mockResolvedValue({ attempt: attemptB, dispatchConfirmed: true }),
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 3, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    act(() => (ref.current as AttemptActivityHandle).start());
    await waitFor(() => {
      const recovery = JSON.parse(
        window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}',
      ) as { attemptId?: string };
      expect(recovery.attemptId).toBe(attemptB.id);
    });

    await act(async () => {
      finishMark({ ...attemptA, presentationComplete: true });
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(attemptB.id);
  });

  it('replays from the server snapshot even after the result was already shown locally', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    const getReplay = vi.fn().mockResolvedValue(replayRecord(pending.id));
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(getReplay).toHaveBeenCalledWith(pending.id);
    expect(attemptApi.completePresentation).not.toHaveBeenCalled();
  });

  it('shows the result and reconciles an ambiguous completion mark automatically', async () => {
    const pending = {
      ...summary('victory'),
      turnsUsed: 8,
      animationEnabled: true,
      presentationComplete: false,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    const events: string[] = [];
    const getAttempt = vi.fn((id: string) => {
      events.push(`GET:${id}`);
      return Promise.resolve(pending);
    });
    const completePresentation = vi.fn((id: string) => {
      events.push(`POST:${id}`);
      if (completePresentation.mock.calls.length === 1) {
        return Promise.reject(new AttemptApiFailure('server', 'No se guardó.', 500, true));
      }
      return Promise.resolve({ ...pending, presentationComplete: true });
    });
    const attemptApi = api({
      getAttempt,
      getReplay: vi.fn().mockResolvedValue(replayRecord()),
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    const completePlayback = await screen.findByRole('button', { name: 'Completar reproducción' });
    vi.useFakeTimers();
    fireEvent.click(completePlayback);
    await settleWorkspacePromises();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(screen.queryByText(/No se pudo guardar el cierre de la presentación/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reintentar cierre de presentación' })).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY - 1));
    expect(completePresentation).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settleWorkspacePromises();
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(completePresentation.mock.calls.map(([id]) => id)).toEqual([pending.id, pending.id]);
    expect(getAttempt).toHaveBeenCalledWith(pending.id, expect.any(AbortSignal));
    const firstPost = events.indexOf(`POST:${pending.id}`);
    const readback = events.indexOf(`GET:${pending.id}`, firstPost + 1);
    const secondPost = events.indexOf(`POST:${pending.id}`, firstPost + 1);
    expect(firstPost).toBeGreaterThanOrEqual(0);
    expect(readback).toBeGreaterThan(firstPost);
    expect(secondPost).toBeGreaterThan(readback);
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('freezes the current model in the admission payload and labels the returned result', async () => {
    const selectedDraft = createDefaultDraft();
    const completed = {
      ...summary('victory'),
      modelKey: 'claude-sonnet-4.6' as const,
      modelLabel: 'Claude Sonnet 4.6',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      reasoningTokens: 17,
    };
    const createAttempt = vi
      .fn()
      .mockResolvedValue({ attempt: completed, dispatchConfirmed: true });
    const attemptApi = api({ createAttempt });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 4, draft: selectedDraft }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    const onTryAvailabilityChange = vi.fn();
    render(
      <AttemptActivity
        ref={ref}
        api={attemptApi}
        editor={editor}
        session={session()}
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );
    await waitFor(() => expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true));

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      4,
      expect.objectContaining({ modelKey: 'claude-sonnet-4.6' }),
      true,
    );
    const resultDetails = screen.getByText('Detalles del agente').closest('details');
    expect(resultDetails).not.toBeNull();
    expect((resultDetails as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(within(resultDetails as HTMLElement).getByText('Detalles del agente'));
    expect(within(resultDetails as HTMLElement).getByText('Claude Sonnet 4.6')).toBeTruthy();
    expect(
      screen.getByText('Razonamiento (incluido en salida)').parentElement?.textContent,
    ).toContain('17');
  });

  it('keeps the captured key and draft through admission, then exposes cancel and terminal metrics', async () => {
    const attemptApi = api();
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(attemptApi.createAttempt).toHaveBeenCalledOnce();
    expect(attemptApi.createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.objectContaining({
        instructions: expect.stringContaining('Siempre preferí'),
        modelKey: 'claude-sonnet-4.6',
      }),
      true,
    );
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByRole('heading', { name: 'Cancelado' })).toBeTruthy();
    expect(screen.getAllByText('desconocido').length).toBeGreaterThan(0);
  });

  it('flushes A then B before admitting the captured B snapshot with its confirmed version', async () => {
    let resolveA!: (value: DraftSnapshot) => void;
    const draftA = { ...createDefaultDraft(), instructions: 'A' };
    const draftB = { ...createDefaultDraft(), instructions: 'B' };
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(
        new Promise<DraftSnapshot>((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockResolvedValueOnce({ version: 2, draft: draftB });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft,
    };
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: summary('running'),
      dispatchConfirmed: true,
    });
    const attemptApi = api({ createAttempt });
    const editorRef = { current: null } as unknown as { current: RobotEditorHandle | null };
    const workspaceRef = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(
      <>
        <RobotEditor ref={editorRef} api={draftApi} session={session()} />
        <AttemptActivity
          ref={workspaceRef}
          api={attemptApi}
          editor={editorRef}
          session={session()}
        />
      </>,
    );

    const instructions = await screen.findByLabelText('Qué debe tener en cuenta el robot');
    await screen.findByText('Historial');
    fireEvent.change(instructions, { target: { value: 'A' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    fireEvent.change(instructions, { target: { value: 'B' } });
    await act(async () => {
      (workspaceRef.current as AttemptActivityHandle).start();
      await Promise.resolve();
    });
    expect(putDraft).toHaveBeenCalledOnce();

    await act(async () => {
      resolveA({ version: 1, draft: draftA });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await screen.findByRole('button', { name: 'Cancelar' });
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(1);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: 'B' });
    expect(createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      2,
      expect.objectContaining({ instructions: 'B' }),
      true,
    );
  });

  it('resolves an ambiguous admission by request key without creating a second key', async () => {
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'timeout', undefined, true));
    const getAttemptRequest = vi.fn().mockResolvedValue(summary('victory'));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledOnce();
  });

  it('recovers an ambiguous admission from memory when session storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'timeout', undefined, true));
    const getAttemptRequest = vi.fn().mockResolvedValue(summary('victory'));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledOnce();
  });

  it('prefers the current in-memory snapshot over an older persisted recovery hint', async () => {
    const oldAttempt = { ...summary('victory'), id: 'attempt-old' };
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'timeout', undefined, true))
      .mockResolvedValueOnce({ attempt: summary('running'), dispatchConfirmed: true });
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 3, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: oldAttempt.id }),
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    const currentKey = createAttempt.mock.calls[0]?.[0];
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledWith(currentKey, expect.any(AbortSignal));
    expect(getAttemptRequest.mock.calls.map(([attemptId]) => attemptId)).not.toContain(
      oldAttempt.id,
    );
    expect(createAttempt.mock.calls[1]?.[0]).toBe(currentKey);
  });

  it('keeps the current in-memory snapshot ahead of a persisted hint when recovery revalidates', async () => {
    const oldAttempt = { ...summary('running'), id: 'attempt-old-revalidation' };
    const currentAttempt = { ...summary('running'), id: 'attempt-current-revalidation' };
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'timeout', undefined, true));
    const getAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'old attempt not found', 404));
    const getAttemptRequest = vi.fn(async (requestKey: string) => {
      if (requestKey === createAttempt.mock.calls[0]?.[0]) return currentAttempt;
      throw new AttemptApiFailure('not_found', 'request not found', 404);
    });
    const attemptApi = api({ createAttempt, getAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 3, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    const authA = vi.fn();
    const view = render(
      <AttemptActivity
        ref={ref}
        api={attemptApi}
        editor={editor}
        session={session()}
        onAuthRequired={authA}
      />,
    );
    await screen.findByText('Historial');
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: oldAttempt.id }),
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    await act(async () => {
      ref.current?.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    const currentKey = createAttempt.mock.calls[0]?.[0];
    view.rerender(
      <AttemptActivity
        ref={ref}
        api={attemptApi}
        editor={editor}
        session={session()}
        onAuthRequired={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('heading', { name: 'Preparando intento' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledOnce();
    expect(getAttemptRequest).toHaveBeenCalledWith(currentKey, expect.any(AbortSignal));
    expect(getAttempt).not.toHaveBeenCalled();
    expect(createAttempt).toHaveBeenCalledOnce();
  });

  it('keeps the foreground recovery reference when snapshot confirmation fails', async () => {
    const foreground = {
      ...summary('victory'),
      id: 'foreground-attempt',
      animationEnabled: false,
      presentationComplete: true,
    };
    const createAttempt = vi.fn();
    const attemptApi = api({
      createAttempt,
      getAttempt: vi.fn().mockResolvedValue(foreground),
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue(null),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

    await screen.findByText('Historial');
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: foreground.id }),
    );
    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
    });

    expect(
      await screen.findByText(
        'No se pudo confirmar la configuración visible. Revisá el guardado y reintentá.',
      ),
    ).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toEqual(expect.objectContaining({ sub: 'subject-a', attemptId: foreground.id }));
  });

  it('restores the foreground recovery reference after a definitive admission rejection', async () => {
    const foreground = { ...summary('running'), id: 'foreground-running' };
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('conflict', 'draft conflict', 409));
    const attemptApi = api({ createAttempt });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 2, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

    await screen.findByText('Historial');
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: foreground.id }),
    );
    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText('draft conflict')).toBeTruthy();
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toEqual(expect.objectContaining({ sub: 'subject-a', attemptId: foreground.id }));
  });

  it('rediscovers another active attempt after a missing foreground id', async () => {
    const missingId = 'attempt-missing';
    const active = { ...summary('running'), id: 'attempt-active' };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: missingId }),
    );
    const getAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [] })
      .mockResolvedValueOnce({ attempts: [active] });
    const attemptApi = api({ getAttempt, listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(getAttempt).toHaveBeenCalledWith(missingId, expect.any(AbortSignal));
    expect(listAttempts).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toMatchObject({ sub: 'subject-a', attemptId: active.id });
  });

  it('uses state discovery when an initial recovery error has no reference', async () => {
    const active = { ...summary('running'), id: 'attempt-discovered' };
    const discoveryError = new AttemptApiFailure('network', 'history unavailable');
    const listAttempts = vi
      .fn()
      .mockRejectedValueOnce(discoveryError)
      .mockRejectedValueOnce(discoveryError)
      .mockResolvedValueOnce({ attempts: [active] });
    const attemptApi = api({ listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(
      await screen.findByText('Comprobar estado vuelve a consultar el servidor.'),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(listAttempts).toHaveBeenCalledTimes(3);
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('retries the existing start when discovery finds one pending attempt', async () => {
    const pending = { ...summary('pending'), id: 'attempt-discovered-pending' };
    const running = { ...pending, status: 'running' as const };
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [pending] });
    const startAttempt = vi.fn().mockResolvedValue({ attempt: running, dispatchConfirmed: true });
    const attemptApi = api({ listAttempts, startAttempt });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(startAttempt.mock.calls[0]?.[0]).toBe(pending.id);
  });

  it('retries a current frozen admission with animation on after reload and a 404 lookup', async () => {
    const draft = { ...createDefaultDraft(), instructions: 'Snapshot exacto' };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({
        sub: 'subject-a',
        requestKey: 'persisted-key',
        expectedVersion: 7,
        draft,
        animationEnabled: true,
      }),
    );
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: summary('victory'),
      dispatchConfirmed: true,
    });
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const captureSnapshot = vi.fn();
    const editor = {
      current: { captureSnapshot },
    } as unknown as { current: RobotEditorHandle | null };
    render(
      <StrictMode>
        <AttemptActivity api={attemptApi} editor={editor} session={session()} />
      </StrictMode>,
    );

    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledWith('persisted-key', expect.anything());
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledWith('persisted-key', 7, draft, true, expect.anything());
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('keeps a key-only recovery marker without inventing a draft to retry', async () => {
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', requestKey: 'marker-only-key' }),
    );
    const createAttempt = vi.fn();
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    const checkButton = await screen.findByRole('button', { name: 'Comprobar estado' });
    fireEvent.click(checkButton);
    await waitFor(() => expect(getAttemptRequest).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('retries the existing start after recovering a pending admission with a lost response', async () => {
    const pending = { ...summary('pending'), id: 'attempt-start-recovery' };
    const running = { ...pending, status: 'running' as const };
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'timeout', undefined, true));
    const getAttemptRequest = vi.fn().mockResolvedValue(pending);
    const startAttempt = vi.fn().mockResolvedValue({ attempt: running, dispatchConfirmed: true });
    const getQuota = vi.fn().mockResolvedValue({
      day: '2026-09-21',
      used: 1,
      limit: 100,
      remaining: 99,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const attemptApi = api({ createAttempt, getAttemptRequest, startAttempt, getQuota });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(startAttempt.mock.calls[0]?.[0]).toBe(pending.id);
    expect(getQuota.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps an uncertain same-ID start recoverable after a failed and nonconfirmed /start', async () => {
    const pending = { ...summary('pending'), id: 'attempt-start-retry' };
    const startAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'start lost', undefined, true))
      .mockResolvedValueOnce({ attempt: pending, dispatchConfirmed: false })
      .mockResolvedValueOnce({
        attempt: { ...pending, status: 'running' },
        dispatchConfirmed: true,
      });
    const attemptApi = api({
      createAttempt: vi.fn().mockResolvedValue({ attempt: pending, dispatchConfirmed: false }),
      getAttempt: vi.fn().mockResolvedValue(pending),
      startAttempt,
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }));
    await waitFor(() => expect(startAttempt).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    expect(screen.getByText(/mismo inicio/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(startAttempt).toHaveBeenCalledTimes(3);
    expect(attemptApi.createAttempt).toHaveBeenCalledOnce();
    expect(attemptApi.getAttempt).toHaveBeenCalledWith(pending.id, expect.any(AbortSignal));
  });

  it('does not re-admit when the lookup finds the attempt after reload', async () => {
    const draft = createDefaultDraft();
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({
        sub: 'subject-a',
        requestKey: 'found-key',
        expectedVersion: 3,
        draft,
        animationEnabled: false,
      }),
    );
    const createAttempt = vi.fn();
    const getAttemptRequest = vi.fn().mockResolvedValue(summary('running'));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('heading', { name: 'Preparando intento' })).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain('attempt-1');
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toContain(
      'expectedVersion',
    );
  });

  it('retries the existing start for an ID-only pending recovery', async () => {
    const pending = { ...summary('pending'), id: 'attempt-id-only-pending' };
    const running = { ...pending, status: 'running' as const };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    const getAttempt = vi.fn().mockResolvedValue(pending);
    const startAttempt = vi.fn().mockResolvedValue({ attempt: running, dispatchConfirmed: true });
    const attemptApi = api({ getAttempt, startAttempt });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(getAttempt).toHaveBeenCalledWith(pending.id, expect.anything());
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(startAttempt.mock.calls[0]?.[0]).toBe(pending.id);
  });

  it('defers an ID-only pending start while auth is paused and retries it after auth resumes', async () => {
    const pending = { ...summary('pending'), id: 'attempt-auth-paused-start' };
    const running = { ...pending, status: 'running' as const };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: pending.id }),
    );
    const getAttempt = vi.fn().mockResolvedValue(pending);
    const startAttempt = vi.fn().mockResolvedValue({ attempt: running, dispatchConfirmed: true });
    const attemptApi = api({ getAttempt, startAttempt });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused />,
    );

    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    expect(startAttempt).not.toHaveBeenCalled();
    view.rerender(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused={false} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(startAttempt.mock.calls[0]?.[0]).toBe(pending.id);
  });

  it('does not retry a frozen admission after lookup crosses into auth pause', async () => {
    const draft = createDefaultDraft();
    let rejectLookup!: (error: AttemptApiFailure) => void;
    const heldLookup = new Promise<never>((_, reject) => {
      rejectLookup = reject;
    });
    const createAttempt = vi
      .fn()
      .mockResolvedValue({ attempt: summary('running'), dispatchConfirmed: true });
    const getAttemptRequest = vi
      .fn()
      .mockReturnValueOnce(heldLookup)
      .mockRejectedValueOnce(new AttemptApiFailure('not_found', 'not found', 404));
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({
        sub: 'subject-a',
        requestKey: 'frozen-auth-pause-key',
        expectedVersion: 3,
        draft,
        animationEnabled: true,
      }),
    );
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused={false} />,
    );
    await waitFor(() => expect(getAttemptRequest).toHaveBeenCalledOnce());
    view.rerender(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused />,
    );
    await act(async () => {
      rejectLookup(new AttemptApiFailure('not_found', 'not found', 404));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createAttempt).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeTruthy();

    view.rerender(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(createAttempt.mock.calls[0]?.[0]).toBe('frozen-auth-pause-key');
  });

  it('ignores and clears a session reference written without the current draft contract', async () => {
    window.sessionStorage.setItem(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: 'attempt-from-old-contract' }),
    );
    const getAttempt = vi.fn();
    const attemptApi = api({ getAttempt });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };

    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByText('Historial');
    expect(getAttempt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it.each([
    [
      'foreign snapshot',
      {
        sub: 'subject-b',
        requestKey: 'foreign-key',
        expectedVersion: 4,
        draft: createDefaultDraft(),
      },
    ],
    [
      'corrupt snapshot',
      {
        sub: 'subject-a',
        requestKey: 'corrupt-key',
        expectedVersion: 'four',
        draft: createDefaultDraft(),
      },
    ],
    [
      'invalid-schema snapshot',
      {
        sub: 'subject-a',
        requestKey: 'schema-key',
        expectedVersion: 4,
        draft: { ...createDefaultDraft(), schemaVersion: 1 },
      },
    ],
    [
      'oversized snapshot',
      {
        sub: 'subject-a',
        requestKey: 'large-key',
        expectedVersion: 4,
        draft: { ...createDefaultDraft(), instructions: 'x'.repeat(70_000) },
      },
    ],
  ])('does not re-admit a %s from session storage', async (_label, stored) => {
    setCurrentRecovery('prompt-runner:attempt-recovery', JSON.stringify(stored));
    const createAttempt = vi.fn();
    const getAttemptRequest = vi.fn();
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByText('Historial');
    expect(createAttempt).not.toHaveBeenCalled();
    expect(getAttemptRequest).not.toHaveBeenCalled();
    if (_label === 'foreign snapshot') {
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
    }
  });

  it('retries a lost POST with the same request key, version, and frozen draft', async () => {
    const first = new AttemptApiFailure('network', 'timeout', undefined, true);
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(first)
      .mockResolvedValueOnce({ attempt: summary('victory'), dispatchConfirmed: true });
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(createAttempt).toHaveBeenCalledTimes(2);
    expect(createAttempt.mock.calls[1]?.slice(0, 4)).toEqual(createAttempt.mock.calls[0]);
  });

  it('keeps a frozen admission after a definitive retry rejection for a later same-key check', async () => {
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'timeout', undefined, true))
      .mockRejectedValueOnce(new AttemptApiFailure('quota_exceeded', 'quota', 429))
      .mockResolvedValueOnce({ attempt: summary('running'), dispatchConfirmed: true });
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('not_found', 'not found', 404))
      .mockRejectedValueOnce(new AttemptApiFailure('not_found', 'not found', 404));
    const getQuota = vi.fn().mockResolvedValue({
      day: '2026-09-21',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [] });
    const attemptApi = api({ createAttempt, getAttemptRequest, getQuota, listAttempts });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByText('quota')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    const frozenKey = createAttempt.mock.calls[0]?.[0];
    expect(frozenKey).toEqual(expect.any(String));
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(frozenKey);

    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(createAttempt).toHaveBeenCalledTimes(3);
    expect(createAttempt.mock.calls[2]?.[0]).toBe(frozenKey);
    expect(getQuota).toHaveBeenCalled();
    expect(listAttempts).toHaveBeenCalled();
  });

  it('treats a fresh gateway rejection as definitive and allows a new request key', async () => {
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('attempt_unavailable', 'gateway busy', 429))
      .mockResolvedValueOnce({ attempt: summary('running'), dispatchConfirmed: true });
    const attemptApi = api({ createAttempt });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByText('gateway busy')).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createAttempt).toHaveBeenCalledTimes(2);
    expect(createAttempt.mock.calls[1]?.[0]).not.toBe(createAttempt.mock.calls[0]?.[0]);
  });

  it.each([
    ['running', { ...summary('running'), id: 'running-after-recovery' }],
    ['terminal', { ...summary('victory'), id: 'terminal-after-recovery' }],
    [
      'cancel requested',
      { ...summary('pending'), id: 'cancel-after-recovery', cancelRequested: true },
    ],
  ])('does not retry /start for a recovered %s attempt', async (_label, recovered) => {
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: recovered.id }),
    );
    const getAttempt = vi.fn().mockResolvedValue(recovered);
    const startAttempt = vi.fn();
    const attemptApi = api({ getAttempt, startAttempt });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await waitFor(() => expect(getAttempt).toHaveBeenCalledWith(recovered.id, expect.anything()));
    expect(startAttempt).not.toHaveBeenCalled();
  });

  it('keeps cancellation available when a recovered pending start is still uncertain', async () => {
    const pending = { ...summary('pending'), id: 'attempt-cancel-start' };
    const startAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'start lost', undefined, true));
    const cancelAttempt = vi.fn().mockResolvedValue({ ...pending, status: 'cancelled' });
    const attemptApi = api({
      createAttempt: vi.fn().mockResolvedValue({ attempt: pending, dispatchConfirmed: false }),
      startAttempt,
      cancelAttempt,
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByRole('heading', { name: 'Cancelado' })).toBeTruthy();
    expect(cancelAttempt).toHaveBeenCalledWith(pending.id);
    expect(startAttempt).toHaveBeenCalledOnce();
  });

  it('ignores a deferred retry rejection after the session generation changes', async () => {
    let rejectRetry!: (error: AttemptApiFailure) => void;
    const retryPending = new Promise<never>((_, reject) => {
      rejectRetry = reject;
    });
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'timeout', undefined, true))
      .mockReturnValueOnce(retryPending);
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    const view = render(
      <AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />,
    );
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    await waitFor(() => expect(createAttempt).toHaveBeenCalledTimes(2));

    const otherSession = {
      ...session(),
      identity: { sub: 'subject-b', email: 'b@example.com' },
    };
    view.rerender(
      <AttemptActivity ref={ref} api={attemptApi} editor={editor} session={otherSession} />,
    );
    await act(async () => {
      rejectRetry(new AttemptApiFailure('quota_exceeded', 'quota', 429));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('quota')).toBeNull();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('discovers multiple active attempts through paginated history and asks which one to resume', async () => {
    const first = { ...summary('running'), id: 'attempt-a' };
    const second = { ...summary('pending'), id: 'attempt-b' };
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [first], nextCursor: 'next' })
      .mockResolvedValueOnce({ attempts: [first], nextCursor: 'next' })
      .mockResolvedValueOnce({ attempts: [second] });
    const startAttempt = vi
      .fn()
      .mockResolvedValue({ attempt: { ...second, status: 'running' }, dispatchConfirmed: true });
    const attemptApi = api({ listAttempts, startAttempt });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(
      await screen.findByRole('heading', { name: 'Tenés varios intentos en curso' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /attempt-a/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /attempt-b/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /attempt-b/ }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(startAttempt.mock.calls[0]?.[0]).toBe(second.id);
  });

  it('keeps a slow history result from racing with a new admission', async () => {
    const historical = { ...summary('victory'), id: 'history-result-old' };
    const started = { ...summary('running'), id: 'attempt-after-history' };
    let resolveHistory!: (value: AttemptSummary) => void;
    let resultSignal: AbortSignal | undefined;
    const getAttempt = vi.fn((_id: string, signal?: AbortSignal) => {
      resultSignal = signal;
      return new Promise<AttemptSummary>((resolve) => {
        resolveHistory = resolve;
      });
    });
    const createAttempt = vi.fn().mockResolvedValue({ attempt: started, dispatchConfirmed: true });
    const startAttempt = vi.fn();
    const attemptApi = api({
      getAttempt,
      createAttempt,
      startAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [historical] }),
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    const view = render(
      <AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />,
    );
    await historyAction('Abrir');

    fireEvent.click(await historyAction('Abrir'));
    await screen.findByRole('heading', { name: 'Consultando el resultado guardado…' });
    view.rerender(
      <AttemptActivity
        ref={ref}
        api={attemptApi}
        editor={editor}
        session={session()}
        surface="preparar"
      />,
    );
    await waitFor(() => expect(resultSignal?.aborted).toBe(true));
    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
    });
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(startAttempt).not.toHaveBeenCalled();
    await screen.findByRole('heading', { name: 'Preparando intento' });
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();

    await act(async () => resolveHistory(historical));
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Preparando intento' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
  });

  it('syncs the history row when polling changes a pending attempt to terminal', async () => {
    const pending = { ...summary('pending'), id: 'attempt-terminal-sync' };
    const terminal = {
      ...pending,
      status: 'error' as const,
      updatedAt: '2026-09-21T12:05:00.000Z',
      reason: 'provider_error',
    };
    const getAttempt = vi.fn().mockResolvedValue(terminal);
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [pending] })
      .mockResolvedValueOnce({ attempts: [pending] });
    const attemptApi = api({ getAttempt, listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });
    expect(await screen.findByRole('heading', { name: 'Error de ejecución' })).toBeTruthy();
    const historySection = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(historySection).not.toBeNull();
    expect(within(historySection as HTMLElement).getByText('Error de ejecución')).toBeTruthy();
    expect(
      within(historySection as HTMLElement).queryByText('Intento recibido, esperando inicio'),
    ).toBeNull();

    fireEvent.click(await historyAction('Abrir'));
    const result = (await screen.findByRole('heading', { name: 'Error de ejecución' })).closest(
      'section',
    );
    expect(result).not.toBeNull();
    const agentDetails = within(result as HTMLElement)
      .getByText('Detalles del agente')
      .closest('details');
    expect(agentDetails).not.toBeNull();
    expect((agentDetails as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(within(agentDetails as HTMLElement).getByText('Detalles del agente'));
    expect(
      within(agentDetails as HTMLElement).getByText('Error del proveedor del agente'),
    ).toBeTruthy();
    expect(result?.querySelector('.attempt-result-note')?.textContent).toContain(
      'Acción: Podés volver al editor y probar de nuevo; un nuevo intento consume cuota.',
    );
    expect(within(result as HTMLElement).queryByText(/probar otra configuración/)).toBeNull();
    expect(within(result as HTMLElement).queryByText(/Causa registrada/)).toBeNull();
    expect(
      within(historySection as HTMLElement).queryByText('Intento recibido, esperando inicio'),
    ).toBeNull();
  });

  it('does not let a deferred old history page overwrite a polled terminal summary', async () => {
    const pending = { ...summary('pending'), id: 'attempt-deferred-history' };
    const terminal = {
      ...pending,
      status: 'error' as const,
      updatedAt: '2026-09-21T12:05:00.000Z',
      reason: 'provider_error',
    };
    let resolveHistory!: (page: { attempts: readonly AttemptSummary[] }) => void;
    const oldHistoryPage = new Promise<{ attempts: readonly AttemptSummary[] }>((resolve) => {
      resolveHistory = resolve;
    });
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [] })
      .mockResolvedValueOnce({ attempts: [] })
      .mockReturnValueOnce(oldHistoryPage);
    const attemptApi = api({
      createAttempt: vi.fn().mockResolvedValue({ attempt: pending, dispatchConfirmed: true }),
      getAttempt: vi.fn().mockResolvedValue(terminal),
      listAttempts,
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptActivityHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(await screen.findByRole('heading', { name: 'Error de ejecución' })).toBeTruthy();

    resolveHistory({ attempts: [pending] });
    const historySection = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(historySection).not.toBeNull();
    await waitFor(() => {
      expect(within(historySection as HTMLElement).getByText('Error de ejecución')).toBeTruthy();
    });
    expect(
      within(historySection as HTMLElement).queryByText('Intento recibido, esperando inicio'),
    ).toBeNull();
  });

  it('ranks only loaded complete victories, keeps ties and negative/zero scores, and labels scope', async () => {
    const ranked = [
      { ...summary('victory'), id: 'score-200', score: 200, gameTokens: 800 },
      {
        ...summary('victory'),
        id: 'score-100-a',
        createdAt: '2026-09-21T12:00:01.000Z',
        score: 100,
        gameTokens: 900,
      },
      {
        ...summary('victory'),
        id: 'score-100-b',
        createdAt: '2026-09-21T12:00:00.000Z',
        score: 100,
        gameTokens: 1_100,
      },
      { ...summary('victory'), id: 'score-zero', score: 0, gameTokens: 2_000 },
      { ...summary('victory'), id: 'score-negative', score: -37.2, gameTokens: null },
      { ...summary('victory'), id: 'score-unknown', score: null, gameTokens: null },
      {
        ...summary('victory'),
        id: 'score-incomplete-record',
        score: 400,
        gameTokens: 300,
        recordComplete: false,
      },
      { ...summary('defeat'), id: 'defeat-1', score: null, gameTokens: 400 },
      { ...summary('incomplete'), id: 'turn-limit-1', turnsUsed: 24, gameTokens: 500 },
      { ...summary('cancelled'), id: 'cancelled-1', turnsUsed: 1, gameTokens: 200 },
      { ...summary('error'), id: 'error-1', turnsUsed: 3, gameTokens: null },
    ];
    const later = {
      ...summary('victory'),
      id: 'score-300-later',
      score: 300,
      gameTokens: 600,
      createdAt: '2026-09-21T12:02:00.000Z',
    };
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: ranked, nextCursor: 'more' })
      .mockResolvedValueOnce({ attempts: ranked, nextCursor: 'more' })
      .mockResolvedValueOnce({ attempts: [later] })
      .mockResolvedValueOnce({ attempts: [later] });
    const attemptsById = new Map([...ranked, later].map((attempt) => [attempt.id, attempt]));
    const getAttempt = vi.fn(async (id: string) => {
      const attempt = attemptsById.get(id);
      if (!attempt) throw new Error(`Unexpected attempt ${id}`);
      return attempt;
    });
    const attemptApi = api({ listAttempts, getAttempt });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const history = historySection();
    expect(within(history).getByText('Recientes', { exact: true })).toBeTruthy();
    expect(within(history).getByText('Mejores', { exact: true })).toBeTruthy();
    selectHistoryView('Recientes');
    expect(await historyActions('Abrir')).toHaveLength(11);
    expect(within(history).getByText('11 cargados, hay más intentos para consultar')).toBeTruthy();
    expect(within(history).getAllByText('Victoria', { exact: true })).toHaveLength(7);
    for (const status of ['Derrota', 'Recorrido incompleto', 'Cancelado', 'Error de ejecución']) {
      expect(within(history).getByText(status)).toBeTruthy();
    }

    const initialHistoryReads = listAttempts.mock.calls.length;
    selectHistoryView('Mejores');
    const firstPageRankedActions = await historyActions('Abrir');
    expect(firstPageRankedActions).toHaveLength(5);
    const firstPageBestRows = within(history).getAllByRole('listitem');
    expect(firstPageBestRows).toHaveLength(5);
    expect(firstPageBestRows[0]?.textContent).toContain('#1');
    expect(firstPageBestRows[0]?.textContent).toMatch(/200(?:,00)? puntos/);
    for (const tiedRow of firstPageBestRows.slice(1, 3)) {
      expect(tiedRow.textContent).toContain('#2');
      expect(tiedRow.textContent).toMatch(/100(?:,00)? puntos/);
    }
    expect(firstPageBestRows[3]?.textContent).toContain('#4');
    expect(firstPageBestRows[3]?.textContent).toMatch(/0(?:,00)? puntos/);
    expect(firstPageBestRows[4]?.textContent).toContain('#5');
    expect(firstPageBestRows[4]?.textContent).toMatch(/-37(?:,2|,20) puntos/);
    expect(within(history).queryByText('Derrota')).toBeNull();
    expect(within(history).queryByText(/fuera de clasificación/i)).toBeNull();
    expect(listAttempts).toHaveBeenCalledTimes(initialHistoryReads);

    selectHistoryView('Recientes');
    expect(await historyActions('Abrir')).toHaveLength(11);
    const historyReadsBeforeMore = listAttempts.mock.calls.length;
    fireEvent.click(within(history).getByRole('button', { name: 'Cargar 20 más' }));
    await waitFor(() =>
      expect(within(history).getAllByRole('button', { name: 'Abrir' })).toHaveLength(12),
    );
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforeMore + 1);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('more');
    expect(
      within(history).getByText('12 cargados, todo el historial disponible está visible'),
    ).toBeTruthy();
    expect(within(history).queryByRole('button', { name: 'Cargar 20 más' })).toBeNull();

    const readsAfterPagination = listAttempts.mock.calls.length;
    selectHistoryView('Mejores');
    expect(listAttempts).toHaveBeenCalledTimes(readsAfterPagination);
    expect(await historyActions('Abrir')).toHaveLength(6);
    const bestRows = within(history).getAllByRole('listitem');
    expect(bestRows).toHaveLength(6);
    const expectedRanking = [
      { id: later.id, rank: '#1', value: /300(?:,00)? puntos/ },
      { id: 'score-200', rank: '#2', value: /200(?:,00)? puntos/ },
      { id: 'score-100-a', rank: '#3', value: /100(?:,00)? puntos/ },
      { id: 'score-100-b', rank: '#3', value: /100(?:,00)? puntos/ },
      { id: 'score-zero', rank: '#5', value: /0(?:,00)? puntos/ },
      { id: 'score-negative', rank: '#6', value: /-37(?:,2|,20) puntos/ },
    ];
    for (const [index, expected] of expectedRanking.entries()) {
      expect(bestRows[index]?.textContent).toContain(expected.rank);
      expect(bestRows[index]?.textContent).toMatch(expected.value);
    }
    expect(within(history).queryByText('Derrota')).toBeNull();
    expect(within(history).queryByText(/fuera de clasificación/i)).toBeNull();
    expect(within(history).getByText(/12 cargados/)).toBeTruthy();

    for (const [index, expected] of expectedRanking.entries()) {
      const openers = await historyActions('Abrir');
      fireEvent.click(openers[index]!);
      expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
      expect(getAttempt).toHaveBeenNthCalledWith(index + 1, expected.id, expect.any(AbortSignal));
      if (expected.id === 'score-negative') {
        const scoreBreakdown = screen.getByText('Desglose del puntaje').closest('details');
        expect(scoreBreakdown).not.toBeNull();
        fireEvent.click(within(scoreBreakdown as HTMLElement).getByText('Desglose del puntaje'));
        expect(screen.getByText('Total').nextElementSibling?.textContent).toBe('-37,20 puntos');
      }
      fireEvent.click(screen.getByRole('button', { name: 'Volver al historial' }));
      expect(await historyActions('Abrir')).toHaveLength(6);
      expect(listAttempts).toHaveBeenCalledTimes(readsAfterPagination);
    }
  });

  it('keeps a refreshed history sequence when an older page resolves after Probar', async () => {
    const firstPage = { ...summary('victory'), id: 'history-old-1' };
    const newAttempt = { ...summary('victory'), id: 'history-new' };
    const refreshedPage = {
      attempts: [newAttempt, firstPage],
      nextCursor: 'cursor-after-refresh',
    };
    let resolveOlderPage!: (page: {
      attempts: readonly AttemptSummary[];
      nextCursor?: string;
    }) => void;
    const olderPage = new Promise<{ attempts: readonly AttemptSummary[]; nextCursor?: string }>(
      (resolve) => {
        resolveOlderPage = resolve;
      },
    );
    let resolveRefreshedPage!: (page: {
      attempts: readonly AttemptSummary[];
      nextCursor?: string;
    }) => void;
    const pendingRefresh = new Promise<{
      attempts: readonly AttemptSummary[];
      nextCursor?: string;
    }>((resolve) => {
      resolveRefreshedPage = resolve;
    });
    let unpagedCalls = 0;
    let cursorCalls = 0;
    let olderPageSignal: AbortSignal | undefined;
    const listAttempts = vi.fn((cursor?: string, signal?: AbortSignal) => {
      if (cursor === 'cursor-after-refresh') {
        return Promise.resolve({ attempts: [{ ...firstPage, id: 'history-old-2' }] });
      }
      if (cursor === 'cursor-old') {
        cursorCalls += 1;
        if (cursorCalls === 1) return Promise.resolve({ attempts: [] });
        olderPageSignal = signal;
        return olderPage;
      }
      unpagedCalls += 1;
      if (unpagedCalls === 1) {
        return Promise.resolve({ attempts: [firstPage], nextCursor: 'cursor-old' });
      }
      if (unpagedCalls === 2) {
        return Promise.resolve({ attempts: [], nextCursor: 'cursor-old' });
      }
      return pendingRefresh;
    });
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: newAttempt,
      dispatchConfirmed: true,
    });
    const attemptApi = api({ listAttempts, createAttempt });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    const view = render(
      <AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />,
    );

    const history = await screen.findByRole('heading', { name: 'Historial' });
    const historySection = history.closest('section') as HTMLElement;
    const loadMore = await within(historySection).findByRole('button', { name: 'Cargar 20 más' });
    fireEvent.click(loadMore);
    await waitFor(() =>
      expect(listAttempts).toHaveBeenCalledWith('cursor-old', expect.any(AbortSignal)),
    );
    await waitFor(() => expect((loadMore as HTMLButtonElement).disabled).toBe(true));

    await waitFor(() => expect(screen.queryByText('Cargando preferencia guardada…')).toBeNull());
    view.rerender(
      <AttemptActivity
        ref={ref}
        api={attemptApi}
        editor={editor}
        session={session()}
        surface="preparar"
      />,
    );
    await waitFor(() => expect(olderPageSignal?.aborted).toBe(true));
    await waitFor(() => expect((loadMore as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      ref.current!.start();
      await Promise.resolve();
    });
    await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());
    await waitFor(() => expect(unpagedCalls).toBe(3));

    await act(async () => resolveOlderPage({ attempts: [{ ...firstPage, id: 'history-old-2' }] }));
    expect(within(historySection).getAllByRole('listitem')).toHaveLength(1);
    expect(historySection.querySelector('[data-history-attempt-id="history-old-2"]')).toBeNull();
    expect((loadMore as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolveRefreshedPage(refreshedPage));
    await waitFor(() =>
      expect(
        (within(historySection).getByRole('button', { name: 'Cargar 20 más' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(within(historySection).getAllByRole('listitem')).toHaveLength(2);
    expect(historySection.querySelector('[data-history-attempt-id="history-old-2"]')).toBeNull();
    expect(
      await within(historySection).findByRole('button', { name: 'Cargar 20 más' }),
    ).toBeTruthy();
    expect(screen.getByText('2 cargados, hay más intentos para consultar')).toBeTruthy();
    expect(attemptApi.createAttempt).toHaveBeenCalledOnce();
    view.rerender(
      <AttemptActivity
        ref={ref}
        api={attemptApi}
        editor={editor}
        session={session()}
        surface="historial"
      />,
    );
    await waitFor(() => expect((loadMore as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await within(historySection).findByRole('button', { name: 'Cargar 20 más' }));
    await waitFor(() => expect(within(historySection).getAllByRole('listitem')).toHaveLength(3));
    expect(screen.getByText('3 cargados, todo el historial disponible está visible')).toBeTruthy();
  });

  it('ignores an error and finalizer from a paginated history request superseded by refresh', async () => {
    const firstPage = { ...summary('victory'), id: 'history-old-1' };
    const newAttempt = { ...summary('victory'), id: 'history-new' };
    const refreshedPage = {
      attempts: [newAttempt, firstPage],
      nextCursor: 'cursor-after-refresh',
    };
    let rejectOlderPage!: (error: unknown) => void;
    const olderPage = new Promise<never>((_, reject) => {
      rejectOlderPage = reject;
    });
    let unpagedCalls = 0;
    let cursorCalls = 0;
    const listAttempts = vi.fn((cursor?: string) => {
      if (cursor === 'cursor-after-refresh') {
        return Promise.reject(new AttemptApiFailure('network', 'current pagination failed'));
      }
      if (cursor === 'cursor-old') {
        cursorCalls += 1;
        if (cursorCalls === 1) return Promise.resolve({ attempts: [] });
        return olderPage;
      }
      unpagedCalls += 1;
      if (unpagedCalls === 1) {
        return Promise.resolve({ attempts: [firstPage], nextCursor: 'cursor-old' });
      }
      if (unpagedCalls === 2) {
        return Promise.resolve({ attempts: [], nextCursor: 'cursor-old' });
      }
      return Promise.resolve(refreshedPage);
    });
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: newAttempt,
      dispatchConfirmed: true,
    });
    const attemptApi = api({ listAttempts, createAttempt });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

    const history = await screen.findByRole('heading', { name: 'Historial' });
    const historySection = history.closest('section') as HTMLElement;
    fireEvent.click(await within(historySection).findByRole('button', { name: 'Cargar 20 más' }));
    await waitFor(() => expect(cursorCalls).toBe(2));
    await waitFor(() => expect(screen.queryByText('Cargando preferencia guardada…')).toBeNull());
    await act(async () => {
      ref.current!.start();
      await Promise.resolve();
    });
    await waitFor(() => expect(unpagedCalls).toBe(3));
    await waitFor(() => expect(within(historySection).getAllByRole('listitem')).toHaveLength(2));
    const quotaReadsBeforeHistoryRetry = vi.mocked(attemptApi.getQuota).mock.calls.length;

    await act(async () => rejectOlderPage(new Error('old history request failed')));
    await waitFor(() => expect(screen.queryByText('old history request failed')).toBeNull());
    expect(within(historySection).getAllByRole('listitem')).toHaveLength(2);
    expect(
      await within(historySection).findByRole('button', { name: 'Cargar 20 más' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar consultas' })).toBeNull();

    fireEvent.click(await within(historySection).findByRole('button', { name: 'Cargar 20 más' }));
    expect(await screen.findByRole('button', { name: /Reintentar historial/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Reintentar historial/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Reintentar historial/i })).toBeNull(),
    );
    expect(within(historySection).getAllByRole('listitem')).toHaveLength(2);
    expect(attemptApi.getQuota).toHaveBeenCalledTimes(quotaReadsBeforeHistoryRetry);
  });

  it('shows one empty history without starting inference', async () => {
    const attemptApi = api({ listAttempts: vi.fn().mockResolvedValue({ attempts: [] }) });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByText('Todavía no hay intentos guardados.')).toBeTruthy();
    expect(screen.getByText('0 cargados, todo el historial disponible está visible')).toBeTruthy();
    expect(
      screen.queryByText('Todavía no hay victorias comparables entre los intentos cargados.'),
    ).toBeNull();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('previews and applies a history configuration without creating an attempt', async () => {
    const terminal = { ...summary('victory'), id: 'attempt-config', score: 100, gameTokens: 700 };
    const recoveredBase = { ...createDefaultDraft(), instructions: 'Recuperada desde el intento' };
    const recovered = {
      ...recoveredBase,
      skills: recoveredBase.skills.map((skill) =>
        skill.id === 'advance'
          ? { id: skill.id, enabled: true }
          : skill.id === 'retreat'
            ? { id: skill.id, enabled: false, description: '' }
            : skill,
      ),
    };
    const applyDraft = vi.fn().mockResolvedValue(true);
    const getConfiguration = vi
      .fn()
      .mockResolvedValue({ attemptId: terminal.id, draft: recovered });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getConfiguration,
    });
    const editor = { current: { applyDraft } } as unknown as { current: RobotEditorHandle | null };
    const view = render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const configurationButtons = await historyActions('Ver configuración');
    fireEvent.click(configurationButtons[0]!);
    expect(await screen.findByRole('heading', { name: 'Configuración del intento' })).toBeTruthy();
    expect(getConfiguration).toHaveBeenCalledWith(terminal.id, expect.any(AbortSignal));
    expect(screen.getByText('Recuperada desde el intento')).toBeTruthy();
    expect(screen.getByText('Claude Sonnet 4.6')).toBeTruthy();
    const configuration = screen
      .getByRole('heading', { name: 'Configuración del intento' })
      .closest('section') as HTMLElement;
    const configurationRows = within(configuration).getAllByRole('listitem');
    expect(configurationRows[0]?.textContent).toContain('Avanzar');
    expect(configurationRows[0]?.textContent).toContain('enviada al agente');
    expect(configurationRows[0]?.textContent).toContain('descripción: omitida');
    expect(configurationRows[1]?.textContent).toContain('Retroceder');
    expect(configurationRows[1]?.textContent).toContain('no enviada al agente');
    expect(configurationRows[1]?.textContent).toContain('descripción: vacía');
    view.rerender(
      <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused />,
    );
    const applyButton = screen.getByRole('button', { name: 'Usar esta configuración' });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(applyButton);
    expect(applyDraft).not.toHaveBeenCalled();
    view.rerender(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));
    await waitFor(() =>
      expect(applyDraft).toHaveBeenCalledWith(
        recovered,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('keeps Cerrar available during a history application and ignores its late success', async () => {
    const terminal = { ...summary('victory'), id: 'attempt-apply-close', score: 100 };
    const recovered = { ...createDefaultDraft(), instructions: 'Candidato de historial.' };
    const application = deferred<boolean>();
    const applyDraft = vi.fn<ApplyDraftMock>().mockReturnValue(application.promise);
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockResolvedValue({ attemptId: terminal.id, draft: recovered });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getConfiguration,
    });
    const editor = { current: { applyDraft } } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const opener = (await historyActions('Ver configuración'))[0]!;
    opener.focus();
    fireEvent.click(opener);
    await screen.findByText('Candidato de historial.');
    fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));

    expect(applyDraft).toHaveBeenCalledWith(
      recovered,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const signal = applyDraft.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    const close = screen.getByRole('button', { name: 'Cerrar' }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.click(close);

    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
    expect(document.activeElement).toBe(opener);
    await act(async () => {
      application.resolve(true);
      await Promise.resolve();
    });

    expect(
      screen.queryByText('Configuración cargada en el editor. Se guarda como una edición normal.'),
    ).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('lets another history choice cancel an application and close the new loading query', async () => {
    const first = { ...summary('victory'), id: 'attempt-first-apply', score: 100 };
    const second = { ...summary('defeat'), id: 'attempt-second-apply' };
    const firstDraft = { ...createDefaultDraft(), instructions: 'Primera configuración.' };
    const secondDraft = { ...createDefaultDraft(), instructions: 'Segunda configuración.' };
    const firstApplication = deferred<boolean>();
    const secondConfiguration = deferred<Awaited<ReturnType<AttemptApi['getConfiguration']>>>();
    const applyDraft = vi.fn<ApplyDraftMock>().mockReturnValue(firstApplication.promise);
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockImplementation((id) =>
        id === first.id
          ? Promise.resolve({ attemptId: first.id, draft: firstDraft })
          : secondConfiguration.promise,
      );
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [first, second] }),
      getConfiguration,
    });
    const editor = { current: { applyDraft } } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const configurationButtons = await historyActions('Ver configuración');
    const firstOpener = configurationButtons[0]!;
    const secondOpener = configurationButtons[1]!;
    fireEvent.click(firstOpener);
    await screen.findByText('Primera configuración.');
    fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));
    const applicationSignal = applyDraft.mock.calls[0]?.[1]?.signal;
    expect(applicationSignal).toBeInstanceOf(AbortSignal);

    expect((secondOpener as HTMLButtonElement).disabled).toBe(false);
    secondOpener.focus();
    fireEvent.click(secondOpener);
    await waitFor(() => expect(getConfiguration).toHaveBeenCalledTimes(2));
    expect(applicationSignal?.aborted).toBe(true);
    const secondLoadSignal = getConfiguration.mock.calls[1]?.[1];
    expect(secondLoadSignal).toBeInstanceOf(AbortSignal);
    const close = screen.getByRole('button', { name: 'Cerrar' }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(secondLoadSignal?.aborted).toBe(true);
    expect(document.activeElement).toBe(secondOpener);

    await act(async () => {
      firstApplication.resolve(true);
      secondConfiguration.resolve({ attemptId: second.id, draft: secondDraft });
      await Promise.resolve();
    });

    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
    expect(
      screen.queryByText('Configuración cargada en el editor. Se guarda como una edición normal.'),
    ).toBeNull();
    expect(document.activeElement).toBe(secondOpener);
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it.each(['pause', 'unmount'] as const)(
    'aborts a history application on %s and ignores a late success',
    async (abandonment) => {
      const terminal = { ...summary('victory'), id: `attempt-apply-${abandonment}`, score: 100 };
      const recovered = { ...createDefaultDraft(), instructions: 'Aplicación cancelada.' };
      const application = deferred<boolean>();
      const applyDraft = vi.fn<ApplyDraftMock>().mockReturnValue(application.promise);
      const attemptApi = api({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getConfiguration: vi.fn().mockResolvedValue({ attemptId: terminal.id, draft: recovered }),
      });
      const editor = { current: { applyDraft } } as unknown as {
        current: RobotEditorHandle | null;
      };
      const view = render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

      await screen.findByRole('heading', { name: 'Historial' });
      fireEvent.click((await historyActions('Ver configuración'))[0]!);
      await screen.findByText('Aplicación cancelada.');
      fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));
      const signal = applyDraft.mock.calls[0]?.[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);

      if (abandonment === 'pause') {
        view.rerender(
          <AttemptActivity api={attemptApi} editor={editor} session={session()} authPaused />,
        );
      } else {
        view.unmount();
      }
      await waitFor(() => expect(signal?.aborted).toBe(true));
      const focusAfterAbandonment = document.activeElement;
      await act(async () => {
        application.resolve(true);
        await Promise.resolve();
      });

      if (abandonment === 'pause') {
        expect(
          screen.queryByText(
            'Configuración cargada en el editor. Se guarda como una edición normal.',
          ),
        ).toBeNull();
        expect(document.activeElement).toBe(focusAfterAbandonment);
      }
      expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    },
  );

  it('keeps history configuration preview and closing available while the editor is unavailable', async () => {
    const terminal = { ...summary('victory'), id: 'attempt-editor-unavailable' };
    const recovered = { ...createDefaultDraft(), instructions: 'Snapshot consultable' };
    const applyDraft = vi.fn().mockResolvedValue(true);
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getConfiguration: vi.fn().mockResolvedValue({ attemptId: terminal.id, draft: recovered }),
    });
    const editor = { current: { applyDraft } } as unknown as { current: RobotEditorHandle | null };
    render(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session()}
        configurationAvailable={false}
      />,
    );

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click((await historyActions('Ver configuración'))[0]!);
    expect(await screen.findByText('Snapshot consultable')).toBeTruthy();
    const applyButton = screen.getByRole('button', { name: 'Usar esta configuración' });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
    expect(attemptApi.getConfiguration).toHaveBeenCalledWith(terminal.id, expect.any(AbortSignal));
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(applyDraft).not.toHaveBeenCalled();

    const closeButton = screen.getByRole('button', { name: 'Cerrar' });
    expect((closeButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(closeButton);
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
  });

  it('moves keyboard focus into the configuration and returns it to the history control', async () => {
    const terminal = { ...summary('victory'), id: 'attempt-focus', score: 100, gameTokens: 700 };
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getAttempt: vi.fn().mockResolvedValue(terminal),
      getConfiguration: vi
        .fn()
        .mockResolvedValue({ attemptId: terminal.id, draft: createDefaultDraft() }),
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const opener = (await historyActions('Ver configuración'))[0]!;
    opener.focus();
    fireEvent.click(opener);
    const heading = await screen.findByRole('heading', { name: 'Configuración del intento' });
    expect(document.activeElement).toBe(heading);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(document.activeElement).toBe(opener);

    fireEvent.click(await historyAction('Abrir'));
    const result = await screen.findByRole('heading', { name: 'Victoria' });
    const resultOpener = within(result.closest('section') as HTMLElement).getByRole('button', {
      name: 'Ver configuración',
    });
    resultOpener.focus();
    fireEvent.click(resultOpener);
    expect(await screen.findByRole('heading', { name: 'Configuración del intento' })).toBe(
      document.activeElement,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(document.activeElement).toBe(resultOpener);
  });

  it('keeps a failed configuration load in focus and retries it from the panel', async () => {
    const terminal = { ...summary('victory'), id: 'attempt-retry', score: 100, gameTokens: 700 };
    let rejectLoad!: (error: AttemptApiFailure) => void;
    const getConfiguration = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        }),
      )
      .mockResolvedValueOnce({ attemptId: terminal.id, draft: createDefaultDraft() });
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getConfiguration,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const opener = (await historyActions('Ver configuración'))[0]!;
    opener.focus();
    fireEvent.click(opener);
    const heading = await screen.findByRole('heading', { name: 'Configuración del intento' });
    expect(
      within(heading.closest('section') as HTMLElement).getByText(
        'Cargando la configuración guardada…',
      ),
    ).toBeTruthy();
    await act(async () => {
      rejectLoad(new AttemptApiFailure('network', 'No se pudo consultar.'));
    });
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo consultar.');
    expect(document.activeElement).toBe(heading);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar carga' }));
    expect(await screen.findByRole('button', { name: 'Usar esta configuración' })).toBeTruthy();
    expect(getConfiguration).toHaveBeenCalledTimes(2);
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('does not announce an error or success when a history application returns false', async () => {
    const terminal = {
      ...summary('victory'),
      id: 'attempt-config-failure',
      score: 100,
      gameTokens: 700,
    };
    const recovered = { ...createDefaultDraft(), instructions: 'No se puede aplicar' };
    const applyDraft = vi.fn().mockResolvedValue(false);
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getConfiguration: vi.fn().mockResolvedValue({ attemptId: terminal.id, draft: recovered }),
    });
    const editor = { current: { applyDraft } } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click((await historyActions('Ver configuración'))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Usar esta configuración' }));
    await waitFor(() => expect(applyDraft).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Usar esta configuración' })).toBeTruthy(),
    );
    expect(
      screen.queryByText('Configuración cargada en el editor. Se guarda como una edición normal.'),
    ).toBeNull();
    expect(
      screen.queryByText(
        'No se pudo aplicar la configuración. Revisá el estado del editor y volvé a intentarlo.',
      ),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Usar esta configuración' })).toBeTruthy();
    expect(applyDraft).toHaveBeenCalledWith(
      recovered,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('discards a late configuration response after opening another attempt', async () => {
    const first = { ...summary('victory'), id: 'attempt-first', score: 100, gameTokens: 500 };
    const second = { ...summary('defeat'), id: 'attempt-second' };
    let resolveConfiguration!: (value: {
      attemptId: string;
      draft: ReturnType<typeof createDefaultDraft>;
    }) => void;
    const getConfiguration = vi.fn().mockReturnValue(
      new Promise<{ attemptId: string; draft: ReturnType<typeof createDefaultDraft> }>(
        (resolve) => {
          resolveConfiguration = resolve;
        },
      ),
    );
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [first, second] }),
      getAttempt: vi.fn().mockResolvedValue(second),
      getConfiguration,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);
    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click((await historyActions('Ver configuración'))[0]!);
    fireEvent.click((await historyActions('Abrir'))[1]!);
    resolveConfiguration({ attemptId: first.id, draft: createDefaultDraft() });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Derrota' })).toBeTruthy();
  });

  it('discards a late configuration response after the account changes', async () => {
    const terminal = {
      ...summary('victory'),
      id: 'attempt-account-race',
      score: 100,
      gameTokens: 500,
    };
    let resolveConfiguration!: (value: {
      attemptId: string;
      draft: ReturnType<typeof createDefaultDraft>;
    }) => void;
    const getConfiguration = vi.fn().mockReturnValue(
      new Promise<{ attemptId: string; draft: ReturnType<typeof createDefaultDraft> }>(
        (resolve) => {
          resolveConfiguration = resolve;
        },
      ),
    );
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getConfiguration,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const view = render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);
    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click((await historyActions('Ver configuración'))[0]!);
    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session(
          'b@example.com',
          Math.floor(Date.now() / 1000) + 600,
          'token-b',
          'subject-b',
        )}
      />,
    );
    resolveConfiguration({ attemptId: terminal.id, draft: createDefaultDraft() });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
  });

  it('keeps the second account application current when the old account finishes late', async () => {
    const terminal = {
      ...summary('victory'),
      id: 'attempt-apply-race',
      score: 100,
      gameTokens: 700,
    };
    const finishApply: Array<(applied: boolean) => void> = [];
    const applyDraft = vi.fn<ApplyDraftMock>().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishApply.push(resolve);
        }),
    );
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
      getConfiguration: vi
        .fn()
        .mockResolvedValue({ attemptId: terminal.id, draft: createDefaultDraft() }),
    });
    const editor = { current: { applyDraft } } as unknown as { current: RobotEditorHandle | null };
    const view = render(<AttemptActivity api={attemptApi} editor={editor} session={session()} />);
    const openFromHistory = async (): Promise<void> => {
      await screen.findByRole('heading', { name: 'Historial' });
      const button = (await historyActions('Ver configuración'))[0]!;
      await waitFor(() => expect(button.disabled).toBe(false));
      fireEvent.click(button);
      fireEvent.click(await screen.findByRole('button', { name: 'Usar esta configuración' }));
    };

    await openFromHistory();
    await waitFor(() => expect(finishApply).toHaveLength(1));
    const firstSignal = applyDraft.mock.calls[0]?.[1]?.signal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    view.rerender(
      <AttemptActivity
        api={attemptApi}
        editor={editor}
        session={session(
          'b@example.com',
          Math.floor(Date.now() / 1000) + 600,
          'token-b',
          'subject-b',
        )}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull(),
    );
    await openFromHistory();
    await waitFor(() => expect(finishApply).toHaveLength(2));
    const secondSignal = applyDraft.mock.calls[1]?.[1]?.signal;
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal?.aborted).toBe(false);

    await act(async () => {
      finishApply[0]!(false);
      await Promise.resolve();
    });
    expect(screen.getByText('Aplicando configuración…')).toBeTruthy();
    expect(secondSignal?.aborted).toBe(false);
    expect((screen.getByRole('button', { name: 'Cerrar' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await act(async () => {
      finishApply[1]!(true);
      await Promise.resolve();
    });
    expect(screen.queryByText('Aplicando configuración…')).toBeNull();
    expect(
      screen.getByText('Configuración cargada en el editor. Se guarda como una edición normal.'),
    ).toBeTruthy();
  });

  it('uses a confirmed recovered draft for a later Probar request without changing its source', async () => {
    const source = { ...summary('victory'), id: 'attempt-source', score: 321, gameTokens: 700 };
    const recovered = { ...createDefaultDraft(), instructions: 'Desde la victoria' };
    let currentDraft = createDefaultDraft();
    const applyDraft = vi.fn<ApplyDraftMock>().mockImplementation(async (draft) => {
      currentDraft = draft;
      return true;
    });
    const captureSnapshot = vi
      .fn()
      .mockImplementation(async () => ({ version: 4, draft: currentDraft }));
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: { ...summary('running'), id: 'attempt-new' },
      dispatchConfirmed: true,
    });
    const attemptApi = api({
      createAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [source] }),
      getConfiguration: vi.fn().mockResolvedValue({ attemptId: source.id, draft: recovered }),
    });
    const editor = {
      current: { applyDraft, captureSnapshot },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptActivityHandle | null };
    render(<AttemptActivity ref={ref} api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const configurationButtons = await historyActions('Ver configuración');
    fireEvent.click(configurationButtons[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Usar esta configuración' }));
    await waitFor(() =>
      expect(applyDraft).toHaveBeenCalledWith(
        recovered,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      await screen.findByText(
        'Configuración cargada en el editor. Se guarda como una edición normal.',
      ),
    ).toBeTruthy();
    (ref.current as AttemptActivityHandle).start();
    await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());
    const [requestKey, expectedVersion, sentDraft] = createAttempt.mock.calls[0] ?? [];
    expect(requestKey).not.toBe(source.id);
    expect(expectedVersion).toBe(4);
    expect(sentDraft).toEqual(recovered);
    expect(source.score).toBe(321);
    expect(screen.queryByRole('button', { name: 'Ver configuración' })).toBeNull();
  });
});
