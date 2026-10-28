// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { User } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import type { AuthSession } from './auth.js';
import {
  AttemptApiFailure,
  type AttemptApi,
  type AttemptConfiguration,
  type AttemptSummary,
} from './attempt-api.js';
import type { DraftApi } from './draft-api.js';
import { GameWorkspace, type GameWorkspaceProps } from './GameWorkspace.js';
import { historyAction, historyActionForRow } from './History.test-support.js';
import { formatDateTime } from './attempt-display.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { installHtmlDialogTestShim } from './configuration-confirmation.test-support.js';

vi.mock('./replay/ReplayScene.js', () => ({ CoursePreview: () => null, ReplayScene: () => null }));

const attemptCreatedAt = '2026-10-27T09:10:11.000Z';
const originalDraft = {
  ...createDefaultDraft(),
  instructions: 'Instrucciones visibles antes de reemplazar 🧭',
};
const editedDraft = {
  ...originalDraft,
  instructions: 'Edición visible confirmada antes de abrir.',
};
const candidateDraft = {
  ...createDefaultDraft(),
  instructions: 'Candidato de la partida elegida ✨',
  skills: createDefaultDraft().skills.map((skill, index) =>
    index === 0 ? { ...skill, enabled: true, description: 'Descripción del intento 👨‍👩‍👧‍👦' } : skill,
  ),
};

let restoreHtmlDialogTestShim: (() => void) | undefined;

beforeAll(() => {
  restoreHtmlDialogTestShim = installHtmlDialogTestShim();
});

afterAll(() => {
  restoreHtmlDialogTestShim?.();
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function session(sub = 'confirmation-player'): AuthSession {
  const email = `${sub}@example.test`;
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub, email },
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
        email,
      },
      expires_at: now + 600,
    }),
  };
}

function summary(id: string, status: AttemptSummary['status'] = 'victory'): AttemptSummary {
  const active = status === 'pending' || status === 'running';
  return {
    id,
    createdAt: attemptCreatedAt,
    updatedAt: '2026-10-27T09:10:12.000Z',
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
  };
}

function configuration(attemptId: string): AttemptConfiguration {
  return { attemptId, draft: candidateDraft };
}

function defaultAttemptApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  const historyAttempt = summary('attempt-history');
  const currentAttempt = summary('attempt-current');
  return {
    createAttempt: vi.fn().mockResolvedValue({ attempt: currentAttempt, dispatchConfirmed: true }),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'No existe.', 404)),
    getAttempt: vi.fn().mockResolvedValue(historyAttempt),
    getConfiguration: vi.fn<AttemptApi['getConfiguration']>((id) =>
      Promise.resolve(configuration(id)),
    ),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [historyAttempt] }),
    startAttempt: vi.fn(async (id: string) => ({
      attempt: summary(id, 'running'),
      dispatchConfirmed: true,
    })),
    cancelAttempt: vi.fn(),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 1 }),
    putAnimationPreference: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-28',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
    ...overrides,
  };
}

function defaultDraftApi(overrides: Partial<DraftApi> = {}): DraftApi {
  return {
    getDraft: vi.fn().mockResolvedValue({ version: 4, draft: originalDraft }),
    putDraft: vi.fn<DraftApi['putDraft']>().mockImplementation(async (version, draft) => ({
      version: version + 1,
      draft,
    })),
    ...overrides,
  };
}

function instructions(): HTMLTextAreaElement {
  const field = document.getElementById('robot-instructions');
  if (!(field instanceof HTMLTextAreaElement)) throw new Error('Falta el campo de instrucciones.');
  return field;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

function workspaceSideEffectCounts(attemptApi: AttemptApi) {
  return {
    create: vi.mocked(attemptApi.createAttempt).mock.calls.length,
    start: vi.mocked(attemptApi.startAttempt).mock.calls.length,
    cancel: vi.mocked(attemptApi.cancelAttempt).mock.calls.length,
    replay: vi.mocked(attemptApi.getReplay).mock.calls.length,
    decisionIndex: vi.mocked(attemptApi.getDecisionIndex).mock.calls.length,
    decision: vi.mocked(attemptApi.getDecision).mock.calls.length,
    presentationAck: vi.mocked(attemptApi.completePresentation).mock.calls.length,
    animationPreferenceWrite: vi.mocked(attemptApi.putAnimationPreference).mock.calls.length,
  };
}

function selectSurface(name: 'Preparar' | 'Historial'): void {
  const tab = button(name);
  if (tab.getAttribute('aria-current') !== 'page') fireEvent.click(tab);
}

async function settleWorkspace(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settleWorkspace();
}

function renderWorkspace(
  options: {
    readonly attemptApi?: Partial<AttemptApi>;
    readonly draftApi?: Partial<DraftApi>;
    readonly authPaused?: boolean;
    readonly sub?: string;
  } = {},
) {
  const editor = createRef<RobotEditorHandle>();
  const attemptApi = defaultAttemptApi(options.attemptApi);
  const draftApi = defaultDraftApi(options.draftApi);
  let props: GameWorkspaceProps = {
    attemptApi,
    draftApi,
    session: session(options.sub),
    editor,
    accessState: 'ready',
    authPaused: options.authPaused ?? false,
  };
  const element = () => <GameWorkspace {...props} />;
  const view = render(element());
  return {
    ...view,
    attemptApi,
    draftApi,
    editor,
    update(next: Partial<GameWorkspaceProps>): void {
      props = { ...props, ...next };
      view.rerender(element());
    },
  };
}

type ConfigurationOpening = 'history-row' | 'history-result' | 'current-result';

async function openConfiguration(opening: ConfigurationOpening): Promise<void> {
  await screen.findByRole('heading', { name: 'Prepará tu robot' });
  if (opening === 'history-row' || opening === 'history-result') {
    selectSurface('Historial');
    await screen.findByRole('heading', { name: 'Historial' });
    if (opening === 'history-result') {
      fireEvent.click(await historyAction('Abrir'));
      await screen.findByRole('heading', { name: 'Victoria' });
      const trigger = button('Ver configuración');
      trigger.focus();
      fireEvent.click(trigger);
      await screen.findByRole('heading', { name: 'Configuración del intento' });
      await screen.findAllByText(candidateDraft.instructions);
      return;
    }

    const trigger = await historyAction('Ver configuración');
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('heading', { name: 'Configuración del intento' });
    await screen.findAllByText(candidateDraft.instructions);
    return;
  }

  await waitFor(() => expect(button('Probar').disabled).toBe(false));
  fireEvent.click(button('Probar'));
  await screen.findByRole('heading', { name: 'Victoria' });
  const trigger = button('Ver configuración');
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole('heading', { name: 'Configuración del intento' });
  await screen.findAllByText(candidateDraft.instructions);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GameWorkspace configuration replacement confirmation', () => {
  it.each([
    ['history-row', 'Historial'],
    ['history-result', 'Historial'],
    ['current-result', 'Esta partida'],
  ] as const)(
    'requires an explicit replacement decision from %s without starting D2',
    async (opening, context) => {
      const mounted = renderWorkspace();
      await openConfiguration(opening);
      const effectsBeforeConfirmation = workspaceSideEffectCounts(mounted.attemptApi);
      const configurationReadsBeforeConfirmation = vi.mocked(mounted.attemptApi.getConfiguration)
        .mock.calls.length;
      const draftReadsBeforeConfirmation = vi.mocked(mounted.draftApi.getDraft).mock.calls.length;
      expect(instructions().value).toBe(originalDraft.instructions);
      expect(screen.getByText(candidateDraft.instructions)).toBeTruthy();

      // Observe only the synchronous public-handle calls caused by this click; later renders replace the handle.
      const applyDraft = vi.spyOn(mounted.editor.current!, 'applyDraft');
      const captureSnapshot = vi.spyOn(mounted.editor.current!, 'captureSnapshot');
      const capturesBeforeConfirmation = captureSnapshot.mock.calls.length;
      fireEvent.click(button('Usar esta configuración'));
      const dialog = screen.getByRole('dialog');
      const cancel = within(dialog).getByRole('button', { name: 'Cancelar' });
      expect(within(dialog).getByRole('heading', { name: '¿Reemplazar tu robot?' })).toBeTruthy();
      expect(dialog.textContent).toContain(context);
      expect(dialog.textContent).toContain(formatDateTime(attemptCreatedAt));
      expect(dialog.textContent?.toLowerCase()).toContain('instrucciones');
      expect(dialog.textContent?.toLowerCase()).toContain('habilidades');
      expect(within(dialog).getByRole('button', { name: 'Reemplazar mi robot' })).toBeTruthy();
      expect(document.activeElement).toBe(cancel);
      expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
      expect(applyDraft).not.toHaveBeenCalled();
      expect(workspaceSideEffectCounts(mounted.attemptApi)).toEqual(effectsBeforeConfirmation);
      expect(mounted.attemptApi.getConfiguration).toHaveBeenCalledTimes(
        configurationReadsBeforeConfirmation,
      );
      expect(mounted.draftApi.getDraft).toHaveBeenCalledTimes(draftReadsBeforeConfirmation);
      expect(captureSnapshot).toHaveBeenCalledTimes(capturesBeforeConfirmation);
      expect(instructions().value).toBe(originalDraft.instructions);

      fireEvent.click(cancel);
      await settleWorkspace();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Usar esta configuración' }),
      );
      expect(screen.getByText(candidateDraft.instructions)).toBeTruthy();
      expect(instructions().value).toBe(originalDraft.instructions);
      expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
      expect(workspaceSideEffectCounts(mounted.attemptApi)).toEqual(effectsBeforeConfirmation);
      expect(mounted.attemptApi.getConfiguration).toHaveBeenCalledTimes(
        configurationReadsBeforeConfirmation,
      );
      expect(mounted.draftApi.getDraft).toHaveBeenCalledTimes(draftReadsBeforeConfirmation);
    },
  );

  it('still asks before replacement when the fetched literal already matches the editor', async () => {
    const getDraft = vi.fn<DraftApi['getDraft']>().mockResolvedValue({
      version: 4,
      draft: candidateDraft,
    });
    const mounted = renderWorkspace({ draftApi: { getDraft } });
    await openConfiguration('history-row');
    expect(instructions().value).toBe(candidateDraft.instructions);
    expect(
      within(screen.getByRole('region', { name: 'Configuración consultada' })).getByText(
        candidateDraft.instructions,
      ),
    ).toBeTruthy();

    // Observe only synchronous calls from Use; the current handle changes on rerender.
    const applyDraft = vi.spyOn(mounted.editor.current!, 'applyDraft');
    const captureSnapshot = vi.spyOn(mounted.editor.current!, 'captureSnapshot');
    const capturesBeforeConfirmation = captureSnapshot.mock.calls.length;
    fireEvent.click(button('Usar esta configuración'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(applyDraft).not.toHaveBeenCalled();
    expect(captureSnapshot).toHaveBeenCalledTimes(capturesBeforeConfirmation);
    expect(getDraft).toHaveBeenCalledOnce();
    expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
  });

  it('treats the dialog cancel event as cancellation and returns focus to the current Use action', async () => {
    const mounted = renderWorkspace();
    await openConfiguration('history-row');
    fireEvent.click(button('Usar esta configuración'));
    const dialog = screen.getByRole('dialog');

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await settleWorkspace();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Usar esta configuración' }),
    );
    expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
    expect(instructions().value).toBe(originalDraft.instructions);
  });

  it('keeps programmatic close neutral and consumes the next affirmative decision once', async () => {
    const mounted = renderWorkspace();
    await openConfiguration('history-row');

    fireEvent.click(button('Usar esta configuración'));
    const closedDialog = screen.getByRole('dialog') as HTMLDialogElement;
    closedDialog.close();
    fireEvent(closedDialog, new Event('close'));
    await settleWorkspace();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
    expect(instructions().value).toBe(originalDraft.instructions);

    fireEvent.click(button('Usar esta configuración'));
    const confirmation = screen.getByRole('dialog');
    const affirm = within(confirmation).getByRole('button', { name: 'Reemplazar mi robot' });
    const applyDraft = vi.fn<RobotEditorHandle['applyDraft']>().mockResolvedValue(true);
    mounted.editor.current!.applyDraft = applyDraft;
    fireEvent.click(affirm);
    fireEvent.click(affirm);
    await settleWorkspace();

    expect(applyDraft).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mounted.attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('keeps a late close from target A from changing or applying target B', async () => {
    const attemptA = summary('attempt-target-a');
    const attemptB = summary('attempt-target-b', 'defeat');
    const draftA = { ...candidateDraft, instructions: 'Literal del intento A.' };
    const draftB = { ...candidateDraft, instructions: 'Literal del intento B.' };
    const putDraft = vi.fn<DraftApi['putDraft']>().mockResolvedValue({
      version: 5,
      draft: draftB,
    });
    const mounted = renderWorkspace({
      attemptApi: {
        listAttempts: vi.fn().mockResolvedValue({ attempts: [attemptA, attemptB] }),
        getConfiguration: vi.fn<AttemptApi['getConfiguration']>((id) =>
          Promise.resolve({ attemptId: id, draft: id === attemptA.id ? draftA : draftB }),
        ),
      },
      draftApi: { putDraft },
    });

    selectSurface('Historial');
    await screen.findByRole('heading', { name: 'Historial' });
    fireEvent.click(await historyActionForRow('Ver configuración', 'Victoria'));
    await screen.findByText(draftA.instructions);
    const effectsBeforeAConfirmation = workspaceSideEffectCounts(mounted.attemptApi);
    fireEvent.click(button('Usar esta configuración'));
    const oldDialog = screen.getByRole('dialog') as HTMLDialogElement;
    oldDialog.close();
    fireEvent(oldDialog, new Event('close'));
    await settleWorkspace();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(putDraft).not.toHaveBeenCalled();
    expect(workspaceSideEffectCounts(mounted.attemptApi)).toEqual(effectsBeforeAConfirmation);
    fireEvent.click(button('Cerrar'));
    await screen.findByRole('heading', { name: 'Historial' });

    fireEvent.click(await historyActionForRow('Ver configuración', 'Derrota'));
    await screen.findByText(draftB.instructions);
    const effectsBeforeBConfirmation = workspaceSideEffectCounts(mounted.attemptApi);
    fireEvent.click(button('Usar esta configuración'));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent(oldDialog, new Event('close'));
    await settleWorkspace();

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(draftB.instructions)).toBeTruthy();
    expect(putDraft).not.toHaveBeenCalled();
    expect(workspaceSideEffectCounts(mounted.attemptApi)).toEqual(effectsBeforeBConfirmation);

    const applyDraft = vi.spyOn(mounted.editor.current!, 'applyDraft');
    fireEvent.click(button('Reemplazar mi robot'));
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce());
    expect(putDraft.mock.calls[0]?.slice(0, 2)).toEqual([4, draftB]);
    expect(applyDraft).toHaveBeenCalledOnce();
    expect(applyDraft.mock.calls[0]?.[0]).toEqual(draftB);
  });

  it('captures the current visible revision only on confirmation and replaces after D2 confirms the write', async () => {
    const visibleSave = deferred<DraftSnapshot>();
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation((version, draft) =>
        draft.instructions === editedDraft.instructions
          ? visibleSave.promise
          : Promise.resolve({ version: version + 1, draft }),
      );
    const mounted = renderWorkspace({ draftApi: { putDraft } });
    await screen.findByRole('heading', { name: 'Prepará tu robot' });
    vi.useFakeTimers();
    fireEvent.change(instructions(), { target: { value: editedDraft.instructions } });
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.slice(0, 2)).toEqual([4, editedDraft]);
    const visibleWriteSignal = putDraft.mock.calls[0]?.[2];
    expect(visibleWriteSignal).toBeInstanceOf(AbortSignal);
    vi.useRealTimers();

    fireEvent.click(button('Historial'));
    await settleWorkspace();
    const historyTrigger = await historyAction('Ver configuración');
    fireEvent.click(historyTrigger);
    await settleWorkspace();
    screen.getByRole('heading', { name: 'Configuración del intento' });
    expect(screen.getByText(candidateDraft.instructions)).toBeTruthy();
    fireEvent.click(button('Usar esta configuración'));
    const dialog = screen.getByRole('dialog');
    expect(putDraft).toHaveBeenCalledOnce();
    expect(visibleWriteSignal?.aborted).toBe(false);
    expect(instructions().value).toBe(editedDraft.instructions);

    visibleSave.resolve({ version: 5, draft: editedDraft });
    await settleWorkspace();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(visibleWriteSignal?.aborted).toBe(false);
    expect(instructions().value).toBe(editedDraft.instructions);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reemplazar mi robot' }));
    await waitFor(() => expect(putDraft).toHaveBeenCalledTimes(2));
    expect(putDraft.mock.calls[1]?.slice(0, 2)).toEqual([5, candidateDraft]);
    await waitFor(() => expect(instructions().value).toBe(candidateDraft.instructions));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preparar' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Prepará tu robot' }));
    expect(mounted.attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(mounted.attemptApi.startAttempt).not.toHaveBeenCalled();
  });

  it('invalidates an unconfirmed replacement on access pause and requires a new human decision after access returns', async () => {
    const mounted = renderWorkspace();
    await openConfiguration('history-row');
    const effectsBeforeConfirmation = workspaceSideEffectCounts(mounted.attemptApi);
    // Observe only synchronous calls from this click; subsequent rerenders replace the handle.
    const applyDraft = vi.spyOn(mounted.editor.current!, 'applyDraft');
    fireEvent.click(button('Usar esta configuración'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(applyDraft).not.toHaveBeenCalled();

    mounted.update({ authPaused: true });
    await settleWorkspace();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
    expect(workspaceSideEffectCounts(mounted.attemptApi)).toEqual(effectsBeforeConfirmation);
    expect(instructions().value).toBe(originalDraft.instructions);

    mounted.update({ authPaused: false });
    await settleWorkspace();
    expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
    expect(workspaceSideEffectCounts(mounted.attemptApi)).toEqual(effectsBeforeConfirmation);
    expect(instructions().value).toBe(originalDraft.instructions);
    const resumedHandleApply = vi.spyOn(mounted.editor.current!, 'applyDraft');
    fireEvent.click(button('Usar esta configuración'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
    expect(resumedHandleApply).not.toHaveBeenCalled();
  });

  it('invalidates an unconfirmed replacement when the authenticated identity changes', async () => {
    const mounted = renderWorkspace();
    await openConfiguration('history-row');
    const effectsBeforeConfirmation = workspaceSideEffectCounts(mounted.attemptApi);
    // Observe only synchronous calls from this click; subsequent rerenders replace the handle.
    const applyDraft = vi.spyOn(mounted.editor.current!, 'applyDraft');
    fireEvent.click(button('Usar esta configuración'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(applyDraft).not.toHaveBeenCalled();

    mounted.update({ session: session('different-confirmation-player') });
    await settleWorkspace();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mounted.draftApi.putDraft).not.toHaveBeenCalled();
    expect(workspaceSideEffectCounts(mounted.attemptApi)).toEqual(effectsBeforeConfirmation);
    expect(instructions().value).toBe(originalDraft.instructions);
  });
});
