// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  ROBOT_CATALOG_VERSION,
  ROBOT_SCHEMA_VERSION,
  type DraftSnapshot,
} from '../../../shared/robot.js';
import { createClosedAttemptRecordFixture } from '../../../shared/attempt.fixture.js';
import { LEVEL } from '../../../shared/game.js';
import type { ReplayRecordView } from '../../../shared/attempt.js';
import type { AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type AttemptSummary } from './attempt-api.js';
import { AttemptWorkspace, type AttemptWorkspaceHandle } from './AttemptWorkspace.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';
import type { DraftApi } from './draft-api.js';

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

function session(): AuthSession {
  return {
    identity: { sub: 'subject-a', email: 'a@example.com' },
    user: new User({
      access_token: 'token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
        sub: 'subject-a',
        email: 'a@example.com',
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

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
    maxTurns: 16,
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
  const source = createClosedAttemptRecordFixture();
  const states = new Map(source.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  return {
    recordVersion: source.recordVersion,
    id,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    config: { level: source.config.level },
    snapshots: source.snapshots,
    actions: source.actions.map((action) => ({
      ...action,
      before: states.get(action.beforeStateId)!,
      after: states.get(action.afterStateId)!,
    })),
    closure: source.closure,
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
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 0 }),
    putAnimationPreference: vi
      .fn()
      .mockImplementation(async (animationEnabled: boolean, expectedVersion: number) => ({
        animationEnabled,
        version: expectedVersion + 1,
      })),
    getReplay: vi.fn(),
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
      resetsAt: '2026-09-22T03:00:00.000Z',
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

describe('AttemptWorkspace', () => {
  it('persists the visible animation choice and freezes that value for the new attempt', async () => {
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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);

    await screen.findByText('Historial');
    expect(screen.getByText('Terreno con recompensa')).toBeTruthy();
    expect(screen.getByText(/cambia entre suelo, pozo, rama, barrera y plataforma/)).toBeTruthy();
    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    expect(animation.checked).toBe(true);
    fireEvent.click(animation);
    expect(animation.checked).toBe(false);
    expect(await screen.findByText('Guardando preferencia…')).toBeTruthy();

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createAttempt).toHaveBeenCalledWith(expect.any(String), 2, createDefaultDraft(), false);
    expect(attemptApi.getReplay).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.getByText('El robot llegó a la salida del recorrido.')).toBeTruthy();
    expect(screen.queryByText(/estático/)).toBeNull();
    expect(putAnimationPreference).toHaveBeenCalledWith(false, 0, expect.any(AbortSignal));
    await act(async () => {
      finishPreferenceSave({ animationEnabled: false, version: 1 });
      await Promise.resolve();
    });
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);
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

  it('ignores an older focus read that resolves after this tab saves a newer preference', async () => {
    let finishFocusRead!: (value: { animationEnabled: boolean; version: number }) => void;
    const delayedFocusRead = new Promise<{ animationEnabled: boolean; version: number }>(
      (resolve) => {
        finishFocusRead = resolve;
      },
    );
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockReturnValueOnce(delayedFocusRead);
    const putAnimationPreference = vi
      .fn()
      .mockResolvedValue({ animationEnabled: false, version: 1 });
    const attemptApi = api({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(getAnimationPreference).toHaveBeenCalledTimes(2));
    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    fireEvent.click(animation);
    await waitFor(() =>
      expect(putAnimationPreference).toHaveBeenCalledWith(false, 0, expect.any(AbortSignal)),
    );
    await waitFor(() => expect(screen.queryByText('Guardando preferencia…')).toBeNull());

    await act(async () => {
      finishFocusRead({ animationEnabled: true, version: 0 });
      await Promise.resolve();
    });

    expect(animation.checked).toBe(false);
    expect(screen.getByText('El resultado aparece directamente.')).toBeTruthy();
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByText(/El registro está incompleto/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar reproducción' }));
    expect(await screen.findByText(/El registro sigue incompleto/)).toBeTruthy();
    expect(getReplay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getReplay).not.toHaveBeenCalled();
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
      render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

      const showResult = await screen.findByRole('button', { name: 'Ver resultado' });
      expect(screen.queryByRole('button', { name: 'Ver de nuevo' })).toBeNull();
      fireEvent.click(showResult);
      expect(await screen.findByRole('heading', { name: label })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Ver de nuevo' })).toBeNull();
      expect(attemptApi.getReplay).not.toHaveBeenCalled();
    },
  );

  it('shows collected object value without presenting it as an awarded score after defeat', async () => {
    const collected = {
      ...summary('defeat'),
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    await screen.findByRole('heading', { name: 'Historial' });
    const history = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(history).not.toBeNull();
    expect(
      within(history as HTMLElement).getByText('Objetos: 1 · valor recogido: 25 puntos'),
    ).toBeTruthy();

    fireEvent.click(within(history as HTMLElement).getByRole('button', { name: 'Ver resultado' }));
    await screen.findByRole('heading', { name: 'Derrota' });
    expect(screen.getByText('Objetos').nextElementSibling?.textContent).toBe('1');
    expect(screen.getByText('Valor de objetos recogidos').nextElementSibling?.textContent).toBe(
      '25 puntos',
    );
    expect(screen.queryByText('Puntaje')).toBeNull();
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ver de nuevo' }));
    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Fallar reproducción' }));
    expect(await screen.findByText('Faltan símbolos')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(await screen.findByText('Guardando el cierre de la presentación…')).toBeTruthy();
    expect(completePresentation).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(pending.id);
    expect(
      (
        screen.getByRole('button', {
          name: 'Reintentar cierre de presentación',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      finishMark({ ...pending, presentationComplete: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull(),
    );
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
      <AttemptWorkspace
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
      <AttemptWorkspace api={firstApi} editor={editor} session={session()} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(await screen.findByText(/No se pudo guardar el cierre/)).toBeTruthy();
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
        <AttemptWorkspace api={resumedApi} editor={editor} session={session()} />,
      );
      expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
      expect(getReplay).toHaveBeenCalledOnce();
      expect(retryMark).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(pending.id);
      fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
      expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
      await waitFor(() => expect(retryMark).toHaveBeenCalledOnce());
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

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
    const attemptApi = api({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [pending] }),
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');
    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    expect(getReplay).toHaveBeenCalledWith(pending.id);
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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    const firstRender = render(
      <AttemptWorkspace ref={ref} api={firstApi} editor={editor} session={session()} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(attemptA.id);

    act(() => (ref.current as AttemptWorkspaceHandle).start());
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
      <AttemptWorkspace api={resumedApi} editor={editor} session={session()} />,
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
    render(<AttemptWorkspace api={finalApi} editor={editor} session={session()} />);
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(finalApi.getReplay).not.toHaveBeenCalled();
    expect(completePresentation).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.sessionStorage.getItem('prompt-runner:attempt-recovery') ?? '{}'),
    ).toMatchObject({ sub: 'subject-a', attemptId: attemptB.id });
  });

  it('ignores a late successful ACK callback from A after B becomes current', async () => {
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
      getReplay: vi.fn().mockResolvedValue(replayRecord(attemptA.id)),
      completePresentation,
      createAttempt: vi.fn().mockResolvedValue({ attempt: attemptB, dispatchConfirmed: true }),
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 3, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    act(() => (ref.current as AttemptWorkspaceHandle).start());
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Completar reproducción' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(getReplay).toHaveBeenCalledWith(pending.id);
    expect(attemptApi.completePresentation).not.toHaveBeenCalled();
  });

  it('shows the result after playback even when the completion mark needs a retry', async () => {
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
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'No se guardó.', 500))
      .mockResolvedValueOnce({ ...pending, presentationComplete: true });
    const attemptApi = api({
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay: vi.fn().mockResolvedValue(replayRecord()),
      completePresentation,
    });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Completar reproducción' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.getByText(/No se pudo guardar el cierre de la presentación/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar cierre de presentación' }));
    await waitFor(() => expect(completePresentation).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/No se pudo guardar el cierre de la presentación/)).toBeNull();
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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
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
    expect(await screen.findByText('Modelo: Claude Sonnet 4.6')).toBeTruthy();
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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      (ref.current as AttemptWorkspaceHandle).start();
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
    const workspaceRef = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(
      <>
        <RobotEditor ref={editorRef} api={draftApi} session={session()} />
        <AttemptWorkspace
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
      (workspaceRef.current as AttemptWorkspaceHandle).start();
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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledOnce();
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
        <AttemptWorkspace api={attemptApi} editor={editor} session={session()} />
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    const checkButton = await screen.findByRole('button', { name: 'Comprobar estado' });
    fireEvent.click(checkButton);
    await waitFor(() => expect(getAttemptRequest).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('heading', { name: 'Preparando intento' })).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain('attempt-1');
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toContain(
      'expectedVersion',
    );
  });

  it('ignores and clears a session reference written without the current draft contract', async () => {
    window.sessionStorage.setItem(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId: 'attempt-from-old-contract' }),
    );
    const getAttempt = vi.fn();
    const attemptApi = api({ getAttempt });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };

    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(createAttempt).toHaveBeenCalledTimes(2);
    expect(createAttempt.mock.calls[1]?.slice(0, 4)).toEqual(createAttempt.mock.calls[0]);
  });

  it('clears a frozen admission after a definitive retry rejection and unlocks a new start', async () => {
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'timeout', undefined, true))
      .mockRejectedValueOnce(new AttemptApiFailure('quota_exceeded', 'quota', 429))
      .mockResolvedValueOnce({ attempt: summary('running'), dispatchConfirmed: true });
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('button', { name: 'Reintentar consultas' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createAttempt).toHaveBeenCalledTimes(3);
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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    const view = render(
      <AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />,
    );
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
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
      <AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={otherSession} />,
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
    const attemptApi = api({ listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    expect(
      await screen.findByRole('heading', { name: 'Tenés varios intentos en curso' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /attempt-a/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /attempt-b/ })).toBeTruthy();
  });

  it('keeps a slow history result from racing with a new admission', async () => {
    let resolveHistory!: (value: AttemptSummary) => void;
    const getAttempt = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: summary('running'),
      dispatchConfirmed: true,
    });
    const attemptApi = api({
      getAttempt,
      createAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [summary('victory')] }),
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByRole('button', { name: 'Ver resultado' });

    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
    });
    expect(createAttempt).not.toHaveBeenCalled();

    resolveHistory(summary('victory'));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
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
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });
    expect(await screen.findByRole('heading', { name: 'Error de ejecución' })).toBeTruthy();
    const historySection = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(historySection).not.toBeNull();
    expect(within(historySection as HTMLElement).getByText('Error de ejecución')).toBeTruthy();
    expect(
      within(historySection as HTMLElement).queryByText('Admitido, esperando inicio'),
    ).toBeNull();

    fireEvent.click(
      within(historySection as HTMLElement).getByRole('button', { name: 'Ver resultado' }),
    );
    expect(
      await screen.findByText(
        'Causa registrada: El proveedor del agente no pudo completar la llamada.',
      ),
    ).toBeTruthy();
    expect(
      within(historySection as HTMLElement).queryByText('Admitido, esperando inicio'),
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
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
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
      within(historySection as HTMLElement).queryByText('Admitido, esperando inicio'),
    ).toBeNull();
  });
});
