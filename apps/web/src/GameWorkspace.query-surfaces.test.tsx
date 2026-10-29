// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installHtmlDialogTestShim } from './configuration-confirmation.test-support.js';
import {
  createDefaultDraft,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import { createClosedAttemptRecordFixture } from '../../../shared/attempt.fixture.js';
import { LEVEL } from '../../../shared/game.js';
import type { ReplayRecordView } from '../../../shared/attempt.js';
import { App } from './App.js';
import { type AuthClient, type AuthConfig, type AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type AttemptSummary } from './attempt-api.js';
import { type DraftApi } from './draft-api.js';
import {
  historyAction,
  historyActions,
  historySection,
  openHistoryActionMenus,
  selectHistoryView,
  settle,
} from './History.test-support.js';
import { formatDateTime } from './attempt-display.js';
import { renderResultImage } from './result-sharing.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

vi.mock('./result-sharing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./result-sharing.js')>();
  return { ...actual, renderResultImage: vi.fn() };
});

vi.mock('./replay/ReplayScene.js', () => ({
  CoursePreview: () => (
    <section aria-label="Vista previa del recorrido">
      <h2>Vista completa del terreno</h2>
    </section>
  ),
  ReplayScene: ({ onReady, onComplete }: { onReady: () => void; onComplete: () => void }) => (
    <div>
      <button type="button" onClick={onReady}>
        Escena lista
      </button>
      <button type="button" onClick={onComplete}>
        Terminar escena
      </button>
    </div>
  ),
}));

const config: AuthConfig = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'client-public',
  domain: 'https://prompt-runner.auth.us-east-1.amazoncognito.com',
  redirectUri: 'https://robotrunner.guilleojeda.com/jugar',
  logoutUri: 'https://robotrunner.guilleojeda.com/',
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};

function session(
  sub = 'subject-a',
  accessToken = 'access-token',
  expiresAt = Math.floor(Date.now() / 1000) + 600,
): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub, email: `${sub}@example.test` },
    user: new User({
      access_token: accessToken,
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      session_state: null,
      profile: {
        iss: config.issuer,
        aud: config.clientId,
        iat: now,
        exp: now + 600,
        sub,
        email: `${sub}@example.test`,
      },
      expires_at: expiresAt,
    }),
  };
}

function authClient(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    initialize: vi.fn().mockResolvedValue(session()),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function summary(
  id: string,
  status: AttemptSummary['status'] = 'victory',
  overrides: Partial<AttemptSummary> = {},
): AttemptSummary {
  const active = status === 'pending' || status === 'running';
  return {
    id,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:01.000Z',
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
    score: null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: active ? 0 : 1,
    finalSupport: LEVEL.exit.support,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
    ...overrides,
  };
}

function replayRecord(id: string, status: AttemptSummary['status'] = 'victory'): ReplayRecordView {
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
    closure: { ...source.closure, status, actionCount: source.actions.length },
    metrics: source.metrics,
    score: source.score,
  };
}

function attemptApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('invalid', 'No se esperaba una admisión.')),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'No encontrado.', 404)),
    getAttempt: vi.fn(),
    getConfiguration: vi.fn(),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(async (id: string) => ({
      attempt: summary(id, 'running'),
      dispatchConfirmed: true,
    })),
    cancelAttempt: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 1 }),
    putAnimationPreference: vi
      .fn()
      .mockImplementation(async (animationEnabled: boolean, expectedVersion: number) => ({
        animationEnabled,
        version: expectedVersion + 1,
      })),
    getReplay: vi.fn(async (id: string) => replayRecord(id)),
    getDecisionIndex: vi.fn(),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-27',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
    ...overrides,
  };
}

function draftApi(overrides: Partial<DraftApi> = {}): DraftApi {
  return {
    getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    putDraft: vi.fn(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    })),
    ...overrides,
  };
}

function savedRobotApi(overrides: Partial<SavedRobotApi> = {}): SavedRobotApi {
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [] }),
    getRobot: vi.fn().mockRejectedValue(new Error('No se esperaba consultar una copia.')),
    saveRobot: vi.fn(),
    deleteRobot: vi.fn(),
    ...overrides,
  };
}

function savedCopy(id: string, instructions: string): SavedRobot {
  return {
    id,
    name: 'Copia consultada',
    version: 1,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:01.000Z',
    modelKey: 'claude-sonnet-4.6',
    draft: { ...createDefaultDraft(), instructions },
  };
}

function savedCopySummary(robot: SavedRobot): SavedRobotSummary {
  return {
    id: robot.id,
    name: robot.name,
    version: robot.version,
    createdAt: robot.createdAt,
    updatedAt: robot.updatedAt,
    modelKey: robot.modelKey,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface AppFixture {
  readonly auth?: AuthClient;
  readonly draft?: DraftApi;
  readonly copies?: SavedRobotApi;
  readonly runner?: AttemptApi;
}

function renderApp(fixture: AppFixture = {}) {
  const activeAuth = fixture.auth ?? authClient();
  const activeDraft = fixture.draft ?? draftApi();
  const activeCopies = fixture.copies ?? savedRobotApi();
  const activeRunner = fixture.runner ?? attemptApi();
  const view = render(
    <App
      authClient={activeAuth}
      draftApi={activeDraft}
      savedRobotApi={activeCopies}
      attemptApi={activeRunner}
      configLoader={async () => config}
    />,
  );
  return {
    ...view,
    auth: activeAuth,
    draft: activeDraft,
    copies: activeCopies,
    runner: activeRunner,
  };
}

function navigation(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Navegación principal' });
}

function tab(name: 'Preparar' | 'Historial' | 'Mis robots'): HTMLButtonElement {
  return within(navigation()).getByRole('button', { name }) as HTMLButtonElement;
}

function selectTab(name: 'Preparar' | 'Historial' | 'Mis robots'): void {
  const control = tab(name);
  expect(control.disabled).toBe(false);
  fireEvent.click(control);
}

async function selectSavedCopy(name: RegExp): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('radio', { name }));
  await settle();
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

async function applySavedCopy(name: RegExp): Promise<void> {
  const panel = await selectSavedCopy(name);
  fireEvent.click(within(panel).getByRole('button', { name: 'Usar este robot' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Usar este robot' }));
  await settle();
}

async function replaceSelectedCopy(name: RegExp): Promise<void> {
  const panel = await selectSavedCopy(name);
  fireEvent.click(within(panel).getByText('Más acciones'));
  fireEvent.click(within(panel).getByRole('button', { name: /Reemplazar con mi robot actual/u }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reemplazar copia' }));
  await settle();
}

async function readyForNavigation(): Promise<void> {
  await screen.findByRole('navigation', { name: 'Navegación principal' });
}

async function readyForPreparation(): Promise<HTMLTextAreaElement> {
  await readyForNavigation();
  const instructions = (await screen.findByLabelText(
    'Qué debe tener en cuenta el robot',
  )) as HTMLTextAreaElement;
  const tryButton = screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
  await waitFor(() => expect(tryButton.disabled).toBe(false));
  return instructions;
}

function historyRowsContaining(history: HTMLElement, text: string): HTMLElement[] {
  return within(history)
    .getAllByRole('listitem')
    .filter((row) => row.textContent?.includes(text));
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(renderResultImage).mockReset();
  vi.useRealTimers();
});

function stubObjectUrls() {
  const createUrl = vi.fn(() => 'blob:phase12-result');
  const revokeUrl = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
  return { createUrl, revokeUrl };
}

let restoreHtmlDialogTestShim: (() => void) | undefined;

beforeAll(() => {
  restoreHtmlDialogTestShim = installHtmlDialogTestShim();
});

afterAll(() => {
  restoreHtmlDialogTestShim?.();
});

describe('Phase 12 independent accessible query diagnostics', () => {
  it('keeps the real App history loading view visible during activity bootstrap', async () => {
    const bootstrap = deferred<{ attempts: readonly AttemptSummary[] }>();
    const listAttempts = vi.fn().mockReturnValueOnce(bootstrap.promise).mockResolvedValue({
      attempts: [],
    });
    renderApp({ runner: attemptApi({ listAttempts }) });
    await readyForNavigation();
    await waitFor(() => expect(listAttempts).toHaveBeenCalledOnce());

    selectTab('Historial');
    expect(await screen.findByRole('heading', { name: 'Historial' })).toBeTruthy();
    const historySurface = screen.getByRole('region', { name: 'Historial de intentos' });
    expect(await within(historySurface).findByText('Recuperando tus intentos…')).toBeTruthy();

    await act(async () => {
      bootstrap.resolve({ attempts: [] });
      await bootstrap.promise;
    });
    expect(await screen.findByText('Todavía no hay intentos guardados.')).toBeTruthy();
  });

  it('keeps the initial preparation at its natural focus and scroll position', async () => {
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      renderApp();
      await readyForPreparation();

      expect(document.activeElement).not.toBe(
        screen.getByRole('heading', { name: 'Prepará tu robot' }),
      );
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (previousScroll) HTMLElement.prototype.scrollIntoView = previousScroll;
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('shows configuration as the only active history view', async () => {
    const terminal = summary('review-configuration', 'defeat');
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getConfiguration: vi
          .fn()
          .mockResolvedValue({ attemptId: terminal.id, draft: createDefaultDraft() }),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Ver configuración'));
    await screen.findByRole('heading', { name: 'Configuración del intento' });
    expect(screen.queryByRole('heading', { name: 'Historial' })).toBeNull();
  });
  it('shows inspector as the only active history view', async () => {
    const terminal = summary('review-inspector', 'defeat');
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getDecisionIndex: vi
          .fn()
          .mockResolvedValue({ attemptId: terminal.id, levelId: LEVEL.id, decisions: [] }),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Inspeccionar decisiones'));
    await screen.findByRole('heading', { name: 'Inspeccionar decisiones' });
    expect(screen.queryByRole('heading', { name: 'Historial' })).toBeNull();
  });
  it('hides terminal history result while replay is foreground', async () => {
    const terminal = summary('review-replay', 'defeat', {
      turnsUsed: replayRecord('review-replay', 'defeat').actions.length,
    });
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt: vi.fn().mockResolvedValue(terminal),
        getReplay: vi.fn(async (id: string) => replayRecord(id, 'defeat')),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Abrir'));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver de nuevo' }));
    await screen.findByRole('button', { name: 'Escena lista' });
    expect(screen.queryByRole('button', { name: 'Volver al historial' })).toBeNull();
  });

  it('keeps the activity viewport after replay readiness changes its mode', async () => {
    const terminal = summary('review-replay-no-extra-scroll', 'defeat', {
      turnsUsed: replayRecord('review-replay-no-extra-scroll', 'defeat').actions.length,
    });
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt: vi.fn().mockResolvedValue(terminal),
        getReplay: vi.fn(async (id: string) => replayRecord(id, 'defeat')),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Abrir'));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver de nuevo' }));

    const previousScroll = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const replayReady = await screen.findByRole('button', { name: 'Escena lista' });
      const activityTitle = screen.getByRole('heading', { name: 'Probar al agente' });
      expect(document.activeElement).toBe(activityTitle);
      fireEvent.click(replayReady);
      expect(await screen.findByRole('button', { name: 'Terminar escena' })).toBeTruthy();
      expect(scrollIntoView).not.toHaveBeenCalled();
      act(() => window.dispatchEvent(new Event('resize')));
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (previousScroll) HTMLElement.prototype.scrollIntoView = previousScroll;
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('aborts a pending saved-copy selection when leaving and ignores its late response', async () => {
    const listed = savedCopy('query-copy', 'Contenido consultado.');
    const oldResult = deferred<SavedRobot>();
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockReturnValueOnce(oldResult.promise);
    renderApp({
      copies: savedRobotApi({
        listRobots: vi.fn().mockResolvedValue({ robots: [savedCopySummary(listed)] }),
        getRobot,
      }),
    });
    await readyForPreparation();
    selectTab('Mis robots');

    fireEvent.click(await screen.findByRole('radio', { name: /Copia consultada/u }));
    await settle();
    const abandonedSignal = getRobot.mock.calls[0]?.[1];
    expect(abandonedSignal).toBeInstanceOf(AbortSignal);

    selectTab('Historial');
    expect(abandonedSignal?.aborted).toBe(true);
    await act(async () => {
      oldResult.resolve(savedCopy('query-copy', 'Respuesta obsoleta.'));
      await oldResult.promise;
    });
    expect(screen.queryByText('Respuesta obsoleta.')).toBeNull();
    expect(getRobot).toHaveBeenCalledOnce();
  });

  it('clears a current activity result after a saved-copy application confirms', async () => {
    const currentResult = summary('result-before-copy-application', 'defeat');
    const copiedRobot = savedCopy('copy-after-result', 'Copia confirmada en el editor.');
    const app = renderApp({
      draft: draftApi(),
      copies: savedRobotApi({
        listRobots: vi.fn().mockResolvedValue({ robots: [savedCopySummary(copiedRobot)] }),
        getRobot: vi.fn().mockResolvedValue(copiedRobot),
      }),
      runner: attemptApi({
        createAttempt: vi.fn().mockResolvedValue({
          attempt: currentResult,
          dispatchConfirmed: true,
        }),
        listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
      }),
    });
    await readyForPreparation();

    const advanceDescription = screen.getByRole('textbox', {
      name: 'Descripción de Avanzar para el agente',
    });
    const advanceDetails = advanceDescription.closest('details') as HTMLDetailsElement;
    expect(advanceDetails.open).toBe(true);
    fireEvent.click(advanceDetails.querySelector('summary') as HTMLElement);
    expect(advanceDetails.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    expect(await screen.findByRole('heading', { name: 'Derrota' })).toBeTruthy();
    selectTab('Mis robots');
    await applySavedCopy(/Copia consultada/u);
    await waitFor(() => expect(app.draft.putDraft).toHaveBeenCalledOnce());

    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(instructions.value).toBe('Copia confirmada en el editor.'));
    expect(instructions.closest('[hidden]')).toBeNull();
    const editorHeading = await screen.findByRole('heading', { name: 'Prepará tu robot' });
    expect(document.activeElement).toBe(editorHeading);
    expect(tab('Preparar').getAttribute('aria-current')).toBe('page');
    expect(advanceDetails.open).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Derrota' })).toBeNull();
  });

  it('returns from applying a current-result configuration and keeps its acknowledgement alive', async () => {
    const attemptId = 'result-config-applied-in-place';
    const record = replayRecord(attemptId, 'defeat');
    const currentResult = summary(attemptId, 'defeat', {
      animationEnabled: true,
      presentationComplete: false,
      turnsUsed: record.actions.length,
    });
    const recovered = {
      ...createDefaultDraft(),
      instructions: 'Aplicada desde el resultado actual.',
    };
    const acknowledgement = deferred<AttemptSummary>();
    const putDraft = vi.fn(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    }));
    const draft = draftApi({
      getDraft: vi.fn().mockResolvedValue({ version: 8, draft: createDefaultDraft() }),
      putDraft,
    });
    const completePresentation = vi.fn().mockReturnValue(acknowledgement.promise);
    const app = renderApp({
      draft,
      runner: attemptApi({
        createAttempt: vi
          .fn()
          .mockResolvedValue({ attempt: currentResult, dispatchConfirmed: true }),
        getReplay: vi.fn(async () => record),
        getConfiguration: vi.fn().mockResolvedValue({ attemptId, draft: recovered }),
        completePresentation,
      }),
    });
    await readyForPreparation();

    const advanceDescription = screen.getByRole('textbox', {
      name: 'Descripción de Avanzar para el agente',
    });
    const advanceDetails = advanceDescription.closest('details') as HTMLDetailsElement;
    expect(advanceDetails.open).toBe(true);
    fireEvent.click(advanceDetails.querySelector('summary') as HTMLElement);
    expect(advanceDetails.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar escena' }));
    expect(await screen.findByRole('heading', { name: 'Derrota' })).toBeTruthy();
    await waitFor(() => expect(completePresentation).toHaveBeenCalledOnce());
    const acknowledgementSignal = completePresentation.mock.calls[0]?.[1];
    expect(acknowledgementSignal).toBeInstanceOf(AbortSignal);

    fireEvent.click(screen.getByRole('button', { name: 'Ver configuración' }));
    await screen.findByRole('heading', { name: 'Configuración del intento' });
    fireEvent.click(await screen.findByRole('button', { name: 'Usar esta configuración' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reemplazar mi robot' }));
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce());

    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(instructions.value).toBe(recovered.instructions));
    expect(putDraft).toHaveBeenCalledWith(8, recovered, expect.any(AbortSignal));
    expect(instructions.closest('[hidden]')).toBeNull();
    const editorHeading = screen.getByRole('heading', { name: 'Prepará tu robot' });
    expect(document.activeElement).toBe(editorHeading);
    expect(tab('Preparar').getAttribute('aria-current')).toBe('page');
    expect(advanceDetails.open).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Derrota' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
    expect(acknowledgementSignal?.aborted).toBe(false);
    expect(app.runner.createAttempt).toHaveBeenCalledOnce();

    await act(async () => {
      acknowledgement.resolve({ ...currentResult, presentationComplete: true });
      await acknowledgement.promise;
    });
    expect(instructions.value).toBe(recovered.instructions);
    expect(instructions.closest('[hidden]')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Derrota' })).toBeNull();
  });

  it('returns to Preparar after applying the confirmed remote conflict version', async () => {
    const original = savedCopy('remote-conflict-copy', 'Copia original.');
    const remote = {
      ...original,
      version: 2,
      draft: { ...original.draft, instructions: 'Versión remota confirmada.' },
    };
    const app = renderApp({
      copies: savedRobotApi({
        listRobots: vi.fn().mockResolvedValue({ robots: [savedCopySummary(original)] }),
        getRobot: vi.fn().mockResolvedValue(original),
        saveRobot: vi
          .fn()
          .mockRejectedValue(new SavedRobotApiFailure('conflict', 'Cambio remoto', 409, remote)),
      }),
    });
    await readyForPreparation();
    selectTab('Mis robots');
    await replaceSelectedCopy(/Copia consultada/u);
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar versión remota' }));
    await waitFor(() => expect(app.draft.putDraft).toHaveBeenCalledOnce());

    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(instructions.value).toBe('Versión remota confirmada.'));
    expect(instructions.closest('[hidden]')).toBeNull();
    const editorHeading = await screen.findByRole('heading', { name: 'Prepará tu robot' });
    expect(document.activeElement).toBe(editorHeading);
    expect(tab('Preparar').getAttribute('aria-current')).toBe('page');
  });

  it('scrolls the editor into view once after returning from a cancelled attempt', async () => {
    const active = summary('review-cancel-focus', 'running');
    const cancelled = summary('review-cancel-focus', 'cancelled');
    const createAttempt = vi.fn().mockResolvedValue({ attempt: active, dispatchConfirmed: true });
    const cancelAttempt = vi.fn().mockResolvedValue(cancelled);
    renderApp({ runner: attemptApi({ createAttempt, cancelAttempt }) });
    await readyForPreparation();

    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    const cancelButton = await screen.findByRole('button', { name: 'Cancelar' });
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      fireEvent.click(cancelButton);
      await screen.findByRole('heading', { name: 'Cancelado' });
      expect(scrollIntoView).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole('button', { name: 'Volver al editor' }));
      const editorHeading = await screen.findByRole('heading', { name: 'Prepará tu robot' });
      expect(document.activeElement).toBe(editorHeading);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ block: 'start', behavior: expect.any(String) }),
      );
      act(() => window.dispatchEvent(new Event('resize')));
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Probar' })).toBeTruthy();
      expect(createAttempt).toHaveBeenCalledOnce();
    } finally {
      if (previousScroll) HTMLElement.prototype.scrollIntoView = previousScroll;
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('focuses the editor once when continuing from the logout prompt on Preparar', async () => {
    renderApp();
    const instructions = await readyForPreparation();
    fireEvent.change(instructions, { target: { value: 'Cambios locales sin confirmar.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cuenta' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    await screen.findByRole('heading', { name: 'Tenés cambios sin confirmar' });

    const previousScroll = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));
      const editorHeading = screen.getByRole('heading', { name: 'Prepará tu robot' });
      expect(screen.queryByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeNull();
      expect(document.activeElement).toBe(editorHeading);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(tab('Preparar').getAttribute('aria-current')).toBe('page');
    } finally {
      if (previousScroll) HTMLElement.prototype.scrollIntoView = previousScroll;
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('returns from a replay opened in a history result to its row with one back action', async () => {
    const terminal = summary('review-replay-origin', 'defeat', {
      turnsUsed: replayRecord('review-replay-origin', 'defeat').actions.length,
    });
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [terminal] });
    const getAttempt = vi.fn().mockResolvedValue(terminal);
    const getReplay = vi.fn(async (id: string) => replayRecord(id, 'defeat'));
    renderApp({
      runner: attemptApi({
        listAttempts,
        getAttempt,
        getReplay,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    const historyReadsBeforeReplay = listAttempts.mock.calls.length;
    fireEvent.click(await historyAction('Abrir'));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver de nuevo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar escena' }));

    const backButtons = screen.getAllByRole('button', { name: 'Volver al historial' });
    expect(backButtons).toHaveLength(1);
    fireEvent.click(backButtons[0]!);

    expect(await screen.findByRole('heading', { name: 'Historial' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Derrota' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Volver al historial' })).toBeNull();
    const restoredHistory = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(restoredHistory).not.toBeNull();
    const restoredOpeners = within(restoredHistory as HTMLElement).getAllByRole('button', {
      name: 'Abrir',
    });
    expect(restoredOpeners).toHaveLength(1);
    expect(document.activeElement).toBe(restoredOpeners[0]);
    const returnedFocus = document.activeElement;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(document.activeElement).toBe(returnedFocus);
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforeReplay);
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(getReplay).toHaveBeenCalledOnce();
  });

  it('returns a replay opened from Mejores to the same visible history row', async () => {
    const victory = summary('history-best-replay', 'victory', {
      score: 240,
      turnsUsed: replayRecord('history-best-replay').actions.length,
    });
    const excluded = summary('history-best-replay-excluded', 'defeat');
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [victory, excluded] });
    const getAttempt = vi.fn().mockResolvedValue(victory);
    const getReplay = vi.fn(async (id: string) => replayRecord(id, 'victory'));
    renderApp({ runner: attemptApi({ listAttempts, getAttempt, getReplay }) });
    await readyForPreparation();
    selectTab('Historial');
    await historyActions('Abrir');
    selectHistoryView('Mejores');

    const historyReadsBeforeReplay = listAttempts.mock.calls.length;
    fireEvent.click(await historyAction('Abrir'));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    const result = screen
      .getByRole('heading', { name: 'Victoria' })
      .closest('section') as HTMLElement;
    fireEvent.click(within(result).getByRole('button', { name: 'Ver de nuevo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar escena' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Volver al historial' }));

    const history = historySection();
    const openers = within(history).getAllByRole('button', { name: 'Abrir' });
    expect(openers).toHaveLength(1);
    expect(within(history).queryByText('Derrota')).toBeNull();
    expect(document.activeElement).toBe(openers[0]);
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforeReplay);
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(getReplay).toHaveBeenCalledOnce();
  });

  it('returns focus to the history result action without refocusing on resize or re-reading history', async () => {
    const terminal = summary('history-result-native-focus', 'defeat');
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [terminal] });
    const getAttempt = vi.fn().mockResolvedValue(terminal);
    renderApp({
      runner: attemptApi({
        listAttempts,
        getAttempt,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    const historyReadsBeforeResult = listAttempts.mock.calls.length;

    const opener = await historyAction('Abrir');
    opener.focus();
    fireEvent.click(opener);
    expect(await screen.findByRole('heading', { name: 'Derrota' })).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Volver al historial' }));
    const restored = await historyAction('Abrir');
    await waitFor(() => expect(document.activeElement).toBe(restored));

    act(() => window.dispatchEvent(new Event('resize')));
    expect(document.activeElement).toBe(restored);
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforeResult);
    expect(getAttempt).toHaveBeenCalledOnce();
  });

  it('returns inspector focus into its history row without refocusing on resize or re-reading history', async () => {
    const terminal = summary('history-inspector-native-focus', 'defeat');
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [terminal] });
    renderApp({
      runner: attemptApi({
        listAttempts,
        getDecisionIndex: vi.fn().mockResolvedValue({
          attemptId: terminal.id,
          levelId: LEVEL.id,
          decisions: [],
        }),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');

    const opener = await historyAction('Inspeccionar decisiones');
    opener.focus();
    const historyReadsBeforeInspection = listAttempts.mock.calls.length;
    fireEvent.click(opener);
    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Cerrar inspección' }));
    const history = historySection();
    const historyRowFocusTargets = [
      ...within(history).queryAllByRole('button', { name: 'Abrir' }),
      ...within(history).queryAllByText('Más acciones', { selector: 'summary' }),
      ...within(history).queryAllByRole('button', { name: 'Inspeccionar decisiones' }),
    ];
    await waitFor(() => expect(historyRowFocusTargets).toContain(document.activeElement));
    const returnedFocus = document.activeElement;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(document.activeElement).toBe(returnedFocus);
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforeInspection);
  });

  it('keeps the person’s focus when a delayed history result arrives', async () => {
    const terminal = summary('review-delayed-result-focus', 'defeat');
    let resolveResult!: (value: AttemptSummary) => void;
    const pending = new Promise<AttemptSummary>((resolve) => {
      resolveResult = resolve;
    });
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt: vi.fn().mockReturnValue(pending),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Abrir'));
    const loadingTitle = await screen.findByRole('heading', {
      name: 'Consultando el resultado guardado…',
    });
    expect(document.activeElement).toBe(loadingTitle);
    const account = screen.getByRole('button', { name: 'Cuenta' });
    account.focus();
    await act(async () => {
      resolveResult(terminal);
    });
    const resultTitle = await screen.findByRole('heading', { name: 'Derrota' });
    expect(resultTitle).toBe(loadingTitle);
    expect(document.activeElement).toBe(account);
  });

  it.each(['current activity result', 'historical result'] as const)(
    'abandons a %s and releases its share image when navigating to Mis robots',
    async (resultKind) => {
      const attemptId = `q11-${resultKind.replaceAll(' ', '-')}`;
      const terminal = summary(attemptId, 'defeat');
      const runner = attemptApi({
        ...(resultKind === 'current activity result'
          ? {
              createAttempt: vi.fn().mockResolvedValue({
                attempt: terminal,
                dispatchConfirmed: true,
              }),
            }
          : { listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }) }),
        getAttempt: vi.fn().mockResolvedValue(terminal),
      });
      const { revokeUrl } = stubObjectUrls();
      vi.mocked(renderResultImage).mockResolvedValue(new Blob(['share image']));
      renderApp({ runner });
      await readyForPreparation();

      if (resultKind === 'current activity result') {
        fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      } else {
        selectTab('Historial');
        fireEvent.click(await historyAction('Abrir'));
      }
      await screen.findByRole('heading', { name: 'Derrota' });
      fireEvent.click(screen.getByRole('button', { name: 'Compartir resultado' }));
      await screen.findByRole('link', { name: 'Descargar imagen' });

      selectTab('Mis robots');
      await screen.findByRole('heading', { name: 'Mis robots' });
      expect(screen.queryByRole('heading', { name: 'Derrota' })).toBeNull();
      expect(revokeUrl).toHaveBeenCalledWith('blob:phase12-result');

      selectTab('Preparar');
      const editorHeading = await screen.findByRole('heading', { name: 'Prepará tu robot' });
      expect(document.activeElement).toBe(editorHeading);
      expect(screen.queryByRole('heading', { name: 'Derrota' })).toBeNull();
    },
  );

  it.each(['configuration', 'inspector'] as const)(
    'returns from a %s opened on the current result to the editor without restoring its trigger',
    async (query) => {
      const terminal = summary(`q11-same-preparation-${query}`, 'defeat');
      const runner = attemptApi({
        createAttempt: vi.fn().mockResolvedValue({ attempt: terminal, dispatchConfirmed: true }),
        getConfiguration: vi.fn().mockResolvedValue({
          attemptId: terminal.id,
          draft: createDefaultDraft(),
        }),
        getDecisionIndex: vi.fn().mockResolvedValue({
          attemptId: terminal.id,
          levelId: LEVEL.id,
          decisions: [],
        }),
      });
      renderApp({ runner });
      await readyForPreparation();
      fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      await screen.findByRole('heading', { name: 'Derrota' });
      fireEvent.click(
        screen.getByRole('button', {
          name: query === 'configuration' ? 'Ver configuración' : 'Inspeccionar decisiones',
        }),
      );
      await screen.findByRole('heading', {
        name: query === 'configuration' ? 'Configuración del intento' : 'Inspeccionar decisiones',
      });

      selectTab('Preparar');
      const preparation = await screen.findByRole('region', { name: 'Preparar' });
      const editorHeading = screen.getByRole('heading', { name: 'Prepará tu robot' });
      expect(preparation.hasAttribute('hidden')).toBe(false);
      expect(document.activeElement).toBe(editorHeading);
      expect(screen.queryByRole('heading', { name: 'Derrota' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Inspeccionar decisiones' })).toBeNull();
    },
  );

  it('closes and releases current-result sharing while configuration is open, then returns focus to its trigger', async () => {
    const terminal = summary('q11-current-result-configuration-sharing', 'defeat');
    const runner = attemptApi({
      createAttempt: vi.fn().mockResolvedValue({ attempt: terminal, dispatchConfirmed: true }),
      getConfiguration: vi.fn().mockResolvedValue({
        attemptId: terminal.id,
        draft: createDefaultDraft(),
      }),
    });
    const { revokeUrl } = stubObjectUrls();
    vi.mocked(renderResultImage).mockResolvedValue(new Blob(['share image']));
    renderApp({ runner });
    await readyForPreparation();
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    await screen.findByRole('heading', { name: 'Derrota' });
    fireEvent.click(screen.getByRole('button', { name: 'Compartir resultado' }));
    await screen.findByRole('link', { name: 'Descargar imagen' });

    const configurationTrigger = screen.getByRole('button', { name: 'Ver configuración' });
    configurationTrigger.focus();
    fireEvent.click(configurationTrigger);
    await screen.findByRole('heading', { name: 'Configuración del intento' });
    expect(revokeUrl).toHaveBeenCalledWith('blob:phase12-result');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));

    const restoredTrigger = await screen.findByRole('button', { name: 'Ver configuración' });
    expect(restoredTrigger).toBe(configurationTrigger);
    expect(document.activeElement).toBe(restoredTrigger);
    expect(
      screen.getByRole('button', { name: 'Compartir resultado' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.queryByRole('heading', { name: 'Compartir resultado' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('ignores a late share-image completion while a history result inspector is active', async () => {
    const terminal = summary('q11-history-inspector-share', 'defeat');
    const imageWork = deferred<Blob>();
    const createUrl = vi.fn(() => 'blob:phase12-stale-result');
    const revokeUrl = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createUrl;
        static revokeObjectURL = revokeUrl;
      },
    );
    vi.mocked(renderResultImage).mockReturnValue(imageWork.promise);
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt: vi.fn().mockResolvedValue(terminal),
        getDecisionIndex: vi.fn().mockResolvedValue({
          attemptId: terminal.id,
          levelId: LEVEL.id,
          decisions: [],
        }),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Abrir'));
    await screen.findByRole('heading', { name: 'Derrota' });
    fireEvent.click(screen.getByRole('button', { name: 'Compartir resultado' }));
    await screen.findByRole('heading', { name: 'Compartir resultado' });
    const inspectorTrigger = screen.getByRole('button', { name: 'Inspeccionar decisiones' });
    inspectorTrigger.focus();
    fireEvent.click(inspectorTrigger);
    await screen.findByRole('heading', { name: 'Inspeccionar decisiones' });

    await act(async () => {
      imageWork.resolve(new Blob(['late image']));
      await imageWork.promise;
    });
    expect(createUrl).not.toHaveBeenCalled();
    expect(revokeUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));

    await screen.findByRole('heading', { name: 'Derrota' });
    expect(document.activeElement).toBe(inspectorTrigger);
    expect(
      screen.getByRole('button', { name: 'Compartir resultado' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.queryByRole('heading', { name: 'Compartir resultado' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(renderResultImage).toHaveBeenCalledOnce();
  });

  it('keeps a dismissed result closed when its presentation acknowledgement completes', async () => {
    const attemptId = 'q11-dismissed-result-ack';
    const record = replayRecord(attemptId, 'victory');
    const terminal = summary(attemptId, 'victory', {
      animationEnabled: true,
      presentationComplete: false,
      turnsUsed: record.actions.length,
    });
    const acknowledgement = deferred<AttemptSummary>();
    const createAttempt = vi.fn().mockResolvedValue({ attempt: terminal, dispatchConfirmed: true });
    const completePresentation = vi.fn().mockReturnValue(acknowledgement.promise);
    renderApp({
      runner: attemptApi({
        createAttempt,
        getReplay: vi.fn(async () => record),
        completePresentation,
      }),
    });
    await readyForPreparation();
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar escena' }));
    await screen.findByRole('heading', { name: 'Victoria' });
    await waitFor(() => expect(completePresentation).toHaveBeenCalledOnce());

    selectTab('Mis robots');
    await screen.findByRole('heading', { name: 'Mis robots' });
    await act(async () => {
      acknowledgement.resolve({ ...terminal, presentationComplete: true });
      await acknowledgement.promise;
    });

    expect(createAttempt).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Mis robots' })).toBeTruthy();
  });

  it('focuses the activity once when Probar cancels a pending exit and keeps later focus stable', async () => {
    window.sessionStorage.clear();
    const admission = deferred<{ attempt: AttemptSummary; dispatchConfirmed: boolean }>();
    const poll = deferred<AttemptSummary>();
    const active = summary('review-foreground-focus', 'running');
    const polled = summary('review-foreground-focus', 'running', {
      updatedAt: '2026-10-27T12:00:02.000Z',
    });
    const createAttempt = vi.fn().mockReturnValue(admission.promise);
    const getAttempt = vi.fn().mockReturnValue(poll.promise);
    const logout = vi.fn().mockResolvedValue(undefined);
    renderApp({
      auth: authClient({ logout }),
      runner: attemptApi({ createAttempt, getAttempt }),
    });

    const instructions = await readyForPreparation();
    expect(screen.getByRole('region', { name: 'Preparar' })).toBeTruthy();
    fireEvent.change(instructions, { target: { value: 'Cambios locales para la admisión' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cuenta' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    await screen.findByRole('heading', { name: 'Tenés cambios sin confirmar' });

    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeNull();
    expect(logout).not.toHaveBeenCalled();

    const activityTitle = await screen.findByRole('heading', { name: 'Probar al agente' });
    expect(document.activeElement).toBe(activityTitle);
    expect(activityTitle.getAttribute('tabindex')).toBe('-1');

    vi.useFakeTimers();
    await act(async () => {
      admission.resolve({ attempt: active, dispatchConfirmed: true });
      await admission.promise;
      await Promise.resolve();
    });
    const cancelButton = screen.getByRole('button', { name: 'Cancelar' });
    expect(document.activeElement).toBe(activityTitle);
    cancelButton.focus();
    expect(document.activeElement).toBe(cancelButton);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getAttempt).toHaveBeenCalledWith(active.id, expect.any(AbortSignal));
    act(() => window.dispatchEvent(new Event('resize')));
    expect(document.activeElement).toBe(cancelButton);

    await act(async () => {
      poll.resolve(polled);
      await poll.promise;
      await Promise.resolve();
    });
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(cancelButton);
  });
});

describe('Phase 13 result acceptance', () => {
  const resultDate = '2026-10-27T12:00:00.000Z';
  const savedInstructions = 'Instrucciones guardadas sin cambios.';
  const summaryForResult = (id: string, overrides: Partial<AttemptSummary> = {}) =>
    summary(id, 'victory', {
      createdAt: resultDate,
      updatedAt: '2026-10-27T12:04:00.000Z',
      turnsUsed: replayRecord(id).actions.length,
      score: 321.47,
      gameTokens: 9_868,
      collectedObjectIds: ['recompensa-1', 'llave-1'],
      objectPoints: 25,
      animationEnabled: false,
      presentationComplete: true,
      recordComplete: true,
      ...overrides,
    });

  function precedes(before: Element, after: Element): boolean {
    return Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function activitySurface(source: 'current' | 'history' | 'history-replay'): HTMLElement {
    const name =
      source === 'current'
        ? 'Actividad del intento'
        : source === 'history'
          ? 'Resultado consultado'
          : 'Historial y actividad';
    return screen.getByRole('region', { name });
  }

  function resultContextElement(
    surface: HTMLElement,
    origin: string,
    createdAt: string,
  ): HTMLElement | undefined {
    const expectedOrigin = origin.toLocaleLowerCase('es-AR');
    const expectedDateTime = formatDateTime(createdAt)
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('es-AR');
    return [...surface.querySelectorAll<HTMLElement>('*')].find((element) => {
      const content = (element.textContent ?? '').replace(/\s+/g, ' ').toLocaleLowerCase('es-AR');
      const isHidden = element.closest('[hidden], [aria-hidden="true"], details:not([open])');
      const containsResultContent = element.querySelector('dl, button');
      const originIndex = content.indexOf(expectedOrigin);
      const dateTimeIndex = content.indexOf(expectedDateTime);
      const separator = content.slice(originIndex + expectedOrigin.length, dateTimeIndex);
      const originAndDateAreTogether =
        originIndex >= 0 && dateTimeIndex > originIndex && /^[\s,:]*$/.test(separator);
      return originAndDateAreTogether && !isHidden && !containsResultContent;
    });
  }

  function expectResultContext(surface: HTMLElement, origin: string, createdAt: string): void {
    const context = resultContextElement(surface, origin, createdAt);
    const resultSummary = within(surface).getByText('Turnos').closest('dl');
    expect.soft(context).toBeTruthy();
    if (context && resultSummary) expect.soft(precedes(context, resultSummary)).toBe(true);
    expect(within(surface).getByRole('heading', { name: 'Victoria' })).toBeTruthy();
  }

  function expectActionsBeforeClosedDetails(
    surface: HTMLElement,
    source: 'current' | 'history',
  ): void {
    const resultSummary = within(surface).getByText('Turnos').closest('dl') as HTMLElement;
    const editorButton = within(surface).queryByRole('button', { name: 'Volver al editor' });
    const historyButton = within(surface).queryByRole('button', { name: 'Volver al historial' });
    const replayButton = within(surface).getByRole('button', { name: 'Ver de nuevo' });
    const inspectButton = within(surface).getByRole('button', {
      name: 'Inspeccionar decisiones',
    });
    const shareButton = within(surface).getByRole('button', { name: 'Compartir resultado' });
    const configurationButton = within(surface).getByRole('button', {
      name: 'Ver configuración',
    });
    const secondaryButtons = [replayButton, inspectButton, shareButton, configurationButton];
    const scoreDetails = within(surface).getByText('Desglose del puntaje').closest('details');
    const agentDetails = within(surface).getByText('Detalles del agente').closest('details');

    expect.soft(editorButton).not.toBeNull();
    if (editorButton) {
      expect(precedes(resultSummary, editorButton)).toBe(true);
      for (const action of secondaryButtons) expect(precedes(editorButton, action)).toBe(true);
    }
    if (source === 'history') {
      expect.soft(historyButton).not.toBeNull();
    } else {
      expect(historyButton).toBeNull();
    }
    expect.soft(scoreDetails).not.toBeNull();
    expect.soft(agentDetails).not.toBeNull();
    if (!scoreDetails || !agentDetails) return;
    expect((scoreDetails as HTMLDetailsElement).open).toBe(false);
    expect((agentDetails as HTMLDetailsElement).open).toBe(false);
    expect(precedes(scoreDetails, agentDetails)).toBe(true);
    for (const action of [...secondaryButtons, ...(historyButton ? [historyButton] : [])]) {
      expect(precedes(action, scoreDetails)).toBe(true);
    }

    fireEvent.click(within(scoreDetails as HTMLElement).getByText('Desglose del puntaje'));
    expect((scoreDetails as HTMLDetailsElement).open).toBe(true);
    expect(
      within(scoreDetails as HTMLElement).getByText('Total').nextElementSibling?.textContent,
    ).toBe('321,47 puntos');
  }

  it.each([
    ['current', 'Esta partida'],
    ['history', 'Historial'],
  ] as const)(
    'shows the %s result context, stored score and action hierarchy',
    async (source, origin) => {
      const attemptId = `phase13-${source}-header`;
      const terminal = summaryForResult(attemptId);
      const createAttempt = vi
        .fn()
        .mockResolvedValue({ attempt: terminal, dispatchConfirmed: true });
      const getAttempt = vi.fn().mockResolvedValue(terminal);
      renderApp({
        runner: attemptApi({
          createAttempt,
          listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
          getAttempt,
        }),
      });
      await readyForPreparation();

      if (source === 'current') {
        fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      } else {
        selectTab('Historial');
        fireEvent.click(await historyAction('Abrir'));
      }

      expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
      const result = activitySurface(source);
      expectResultContext(result, origin, resultDate);
      expect(result.textContent).toContain('321,47');
      expectActionsBeforeClosedDetails(result, source);
      if (source === 'current') {
        expect(createAttempt).toHaveBeenCalledOnce();
        expect(getAttempt).not.toHaveBeenCalled();
      } else {
        expect(createAttempt).not.toHaveBeenCalled();
        expect(getAttempt).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    ['current', 'Esta partida'],
    ['history', 'Historial'],
  ] as const)(
    'shows the %s configuration date and origin before its ID without editing the draft',
    async (source, origin) => {
      const attemptId = `phase13-${source}-configuration`;
      const terminal = summaryForResult(attemptId);
      const createAttempt = vi
        .fn()
        .mockResolvedValue({ attempt: terminal, dispatchConfirmed: true });
      const getAttempt = vi.fn().mockResolvedValue(terminal);
      const getConfiguration = vi.fn().mockResolvedValue({
        attemptId,
        draft: { ...createDefaultDraft(), instructions: savedInstructions },
      });
      const putDraft = vi.fn(async (version: number, draft: RobotDraft) => ({
        version: version + 1,
        draft,
      }));
      renderApp({
        draft: draftApi({ putDraft }),
        runner: attemptApi({
          createAttempt,
          listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
          getAttempt,
          getConfiguration,
        }),
      });
      await readyForPreparation();

      if (source === 'current') {
        fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      } else {
        selectTab('Historial');
        fireEvent.click(await historyAction('Abrir'));
      }
      const result = activitySurface(source);
      await within(result).findByRole('heading', { name: 'Victoria' });
      fireEvent.click(within(result).getByRole('button', { name: 'Ver configuración' }));
      const configurationHeading = await screen.findByRole('heading', {
        name: 'Configuración del intento',
      });
      const configuration = configurationHeading.closest('section') as HTMLElement;
      const context = resultContextElement(configuration, origin, resultDate);
      const technicalId = within(configuration).getByText(`Intento: ${attemptId}`);
      expect.soft(context).toBeTruthy();
      if (context) expect(precedes(context, technicalId)).toBe(true);
      expect(within(configuration).getByText(savedInstructions)).toBeTruthy();
      expect(within(configuration).queryByRole('textbox')).toBeNull();
      expect(getConfiguration).toHaveBeenCalledOnce();
      expect(getConfiguration).toHaveBeenCalledWith(attemptId, expect.any(AbortSignal));
      expect(putDraft).not.toHaveBeenCalled();
      expect(createAttempt).toHaveBeenCalledTimes(source === 'current' ? 1 : 0);
      expect(getAttempt).toHaveBeenCalledTimes(source === 'history' ? 1 : 0);
    },
  );

  it.each([
    ['current', 'Esta partida'],
    ['history', 'Historial'],
  ] as const)('retains the %s context and date after manual replay', async (source, origin) => {
    const attemptId = `phase13-${source}-replay`;
    const terminal = summaryForResult(attemptId);
    const createAttempt = vi.fn().mockResolvedValue({ attempt: terminal, dispatchConfirmed: true });
    const getAttempt = vi.fn().mockResolvedValue(terminal);
    const getReplay = vi.fn(async (id: string) => replayRecord(id));
    renderApp({
      runner: attemptApi({
        createAttempt,
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt,
        getReplay,
      }),
    });
    await readyForPreparation();

    if (source === 'current') {
      fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    } else {
      selectTab('Historial');
      fireEvent.click(await historyAction('Abrir'));
    }
    const result = activitySurface(source);
    await within(result).findByRole('heading', { name: 'Victoria' });
    fireEvent.click(within(result).getByRole('button', { name: 'Ver de nuevo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar escena' }));

    const replayResult = activitySurface(source === 'current' ? 'current' : 'history-replay');
    expectResultContext(replayResult, origin, resultDate);
    expect(replayResult.textContent).toContain('321,47');
    expect(getReplay).toHaveBeenCalledOnce();
    expect(getReplay).toHaveBeenCalledWith(attemptId);
    expect(createAttempt).toHaveBeenCalledTimes(source === 'current' ? 1 : 0);
    expect(getAttempt).toHaveBeenCalledTimes(source === 'history' ? 1 : 0);
    expect
      .soft(within(replayResult).queryByRole('button', { name: 'Volver al editor' }))
      .not.toBeNull();
    if (source === 'history') {
      expect
        .soft(within(replayResult).queryByRole('button', { name: 'Volver al historial' }))
        .not.toBeNull();
    } else {
      expect(
        within(replayResult).queryByRole('button', { name: 'Volver al historial' }),
      ).toBeNull();
    }
  });

  it('keeps a current result and its actions available while ACK is pending; manual replay adds no ACK', async () => {
    const attemptId = 'phase13-current-ack-pending';
    const terminal = summaryForResult(attemptId, {
      animationEnabled: true,
      presentationComplete: false,
    });
    const acknowledgement = deferred<AttemptSummary>();
    const createAttempt = vi.fn().mockResolvedValue({ attempt: terminal, dispatchConfirmed: true });
    const getAttempt = vi.fn();
    const getReplay = vi.fn(async (id: string) => replayRecord(id));
    const completePresentation = vi.fn().mockReturnValue(acknowledgement.promise);
    renderApp({
      runner: attemptApi({ createAttempt, getAttempt, getReplay, completePresentation }),
    });
    await readyForPreparation();
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar escena' }));
    await screen.findByRole('heading', { name: 'Victoria' });
    await waitFor(() => expect(completePresentation).toHaveBeenCalledOnce());

    let result = activitySurface('current');
    expectResultContext(result, 'Esta partida', resultDate);
    expect(within(result).getByRole('button', { name: 'Ver de nuevo' })).toBeTruthy();
    expect(within(result).getByRole('button', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect(getReplay).toHaveBeenCalledOnce();

    fireEvent.click(within(result).getByRole('button', { name: 'Ver de nuevo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar escena' }));
    result = activitySurface('current');
    expectResultContext(result, 'Esta partida', resultDate);
    expect(getReplay).toHaveBeenCalledTimes(2);
    expect(getReplay.mock.calls.map(([id]) => id)).toEqual([attemptId, attemptId]);
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(getAttempt).not.toHaveBeenCalled();
    expect(completePresentation).toHaveBeenCalledOnce();

    await act(async () => {
      acknowledgement.resolve({
        ...terminal,
        updatedAt: '2026-10-27T12:05:00.000Z',
        presentationComplete: true,
      });
      await acknowledgement.promise;
    });
    expectResultContext(activitySurface('current'), 'Esta partida', resultDate);
  });

  it.each([
    {
      label: 'incomplete defeat record',
      status: 'defeat' as const,
      recordComplete: false,
      turnsUsed: 3,
      inspectAvailable: false,
      lastStepAvailable: false,
    },
    {
      label: 'complete victory record with zero actions',
      status: 'victory' as const,
      recordComplete: true,
      turnsUsed: 0,
      inspectAvailable: true,
      lastStepAvailable: false,
    },
  ])(
    'shows only supported result actions for a $label',
    async ({ status, recordComplete, turnsUsed, inspectAvailable, lastStepAvailable }) => {
      const attemptId = `phase13-actions-${status}-${recordComplete}-${turnsUsed}`;
      const terminal = summary(attemptId, status, {
        createdAt: resultDate,
        turnsUsed,
        recordComplete,
        presentationComplete: true,
      });
      renderApp({
        runner: attemptApi({
          listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
          getAttempt: vi.fn().mockResolvedValue(terminal),
        }),
      });
      await readyForPreparation();
      selectTab('Historial');
      const row = screen.getByRole('region', { name: 'Historial de intentos' });
      await historyAction('Abrir');
      openHistoryActionMenus(row);
      const rowInspector = within(row).queryByRole('button', { name: 'Inspeccionar decisiones' });
      const rowReplay = within(row).queryByRole('button', { name: 'Ver de nuevo' });
      expect.soft(Boolean(rowInspector)).toBe(inspectAvailable);
      expect(rowReplay).toBeNull();

      fireEvent.click(await historyAction('Abrir'));
      const result = activitySurface('history');
      await within(result).findByRole('heading', {
        name: status === 'victory' ? 'Victoria' : 'Derrota',
      });
      expect
        .soft(Boolean(within(result).queryByRole('button', { name: 'Inspeccionar decisiones' })))
        .toBe(inspectAvailable);
      expect
        .soft(Boolean(within(result).queryByRole('button', { name: 'Ir a la última acción' })))
        .toBe(lastStepAvailable);
      expect(within(result).queryByRole('button', { name: 'Ver de nuevo' })).toBeNull();
      expect(within(result).getByRole('button', { name: 'Compartir resultado' })).toBeTruthy();
    },
  );

  it('keeps history-row inspection hidden until its presentation is complete', async () => {
    const terminal = summary('phase13-presentation-incomplete-row', 'victory', {
      presentationComplete: false,
      recordComplete: true,
      animationEnabled: true,
      turnsUsed: replayRecord('phase13-presentation-incomplete-row').actions.length,
    });
    const getDecisionIndex = vi.fn();
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getDecisionIndex,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    const row = screen.getByRole('region', { name: 'Historial de intentos' });
    await historyAction('Abrir');
    openHistoryActionMenus(row);
    expect(within(row).queryByRole('button', { name: 'Inspeccionar decisiones' })).toBeNull();
    expect(getDecisionIndex).not.toHaveBeenCalled();
  });

  it('returns to the existing editor from a history result without applying or saving its snapshot', async () => {
    const historical = summary('phase13-history-return', 'defeat', {
      createdAt: resultDate,
      turnsUsed: 4,
    });
    const currentDraft = {
      ...createDefaultDraft(),
      instructions: 'Borrador vigente distinto de la configuración histórica.',
    };
    const getDraft = vi.fn().mockResolvedValue({ version: 7, draft: currentDraft });
    const putDraft = vi.fn(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    }));
    const getConfiguration = vi.fn().mockResolvedValue({
      attemptId: historical.id,
      draft: { ...createDefaultDraft(), instructions: 'Configuración histórica.' },
    });
    const getAttempt = vi.fn().mockResolvedValue(historical);
    const createAttempt = vi.fn();
    renderApp({
      draft: draftApi({ getDraft, putDraft }),
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [historical] }),
        getAttempt,
        getConfiguration,
        createAttempt,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Abrir'));
    const result = activitySurface('history');
    await within(result).findByRole('heading', { name: 'Derrota' });
    const returnEditor = within(result).queryByRole('button', { name: 'Volver al editor' });
    expect.soft(returnEditor).not.toBeNull();
    expect(within(result).getByRole('button', { name: 'Volver al historial' })).toBeTruthy();
    if (!returnEditor) return;

    fireEvent.click(returnEditor);
    const editorHeading = await screen.findByRole('heading', { name: 'Prepará tu robot' });
    const instructions = (await screen.findByLabelText(
      'Qué debe tener en cuenta el robot',
    )) as HTMLTextAreaElement;
    expect(instructions.value).toBe(currentDraft.instructions);
    expect(document.activeElement).toBe(editorHeading);
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).not.toHaveBeenCalled();
    expect(getConfiguration).not.toHaveBeenCalled();
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('keeps the current result context and date when an abandoned history query resolves late', async () => {
    const abandoned = summary('phase13-history-a', 'defeat', {
      createdAt: '2026-10-25T12:00:00.000Z',
    });
    const current = summaryForResult('phase13-current-b');
    const abandonedQuery = deferred<AttemptSummary>();
    const getAttempt = vi.fn().mockReturnValue(abandonedQuery.promise);
    const createAttempt = vi.fn().mockResolvedValue({ attempt: current, dispatchConfirmed: true });
    const completePresentation = vi.fn();
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [abandoned] }),
        getAttempt,
        createAttempt,
        completePresentation,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Abrir'));
    await screen.findByRole('heading', { name: 'Consultando el resultado guardado…' });

    selectTab('Preparar');
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    await screen.findByRole('heading', { name: 'Victoria' });
    let result = activitySurface('current');
    expect(within(result).getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(result.textContent).toContain('321,47');

    await act(async () => {
      abandonedQuery.resolve(abandoned);
      await abandonedQuery.promise;
    });
    result = activitySurface('current');
    expect(within(result).getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(result.textContent).toContain('321,47');
    expectResultContext(result, 'Esta partida', resultDate);
    expect(result.textContent).not.toMatch(/25 oct 2026/);
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(completePresentation).not.toHaveBeenCalled();
  });
});

describe('Phase 14 history acceptance', () => {
  it('shows one recent row per loaded attempt and ranks only comparable victories on demand', async () => {
    const recent = [
      summary('history-recent-low', 'victory', {
        createdAt: '2026-10-27T12:00:00.000Z',
        score: 100.25,
        gameTokens: 15,
      }),
      summary('history-tie-b', 'victory', {
        createdAt: '2026-10-27T11:00:00.000Z',
        score: 200,
        gameTokens: 18,
      }),
      summary('history-tie-a', 'victory', {
        createdAt: '2026-10-27T11:00:00.000Z',
        score: 200,
        gameTokens: 18,
      }),
    ];
    const nextPage = [
      summary('history-page-two-best', 'victory', {
        createdAt: '2026-10-27T10:00:00.000Z',
        score: 300,
        gameTokens: 9,
      }),
      summary('history-incomplete-victory', 'victory', {
        createdAt: '2026-10-27T09:00:00.000Z',
        score: 900,
        recordComplete: false,
      }),
      summary('history-unknown-score', 'victory', {
        createdAt: '2026-10-27T08:00:00.000Z',
        score: null,
      }),
      summary('history-page-two-defeat', 'defeat', {
        createdAt: '2026-10-27T07:00:00.000Z',
        score: 500,
      }),
    ];
    const listAttempts = vi.fn(async (cursor?: string) => {
      if (cursor === 'history-next') return { attempts: nextPage, nextCursor: 'history-next-2' };
      if (cursor === 'history-next-2') return { attempts: [] };
      return { attempts: recent, nextCursor: 'history-next' };
    });
    const app = renderApp({
      runner: attemptApi({ listAttempts }),
    });
    await readyForPreparation();
    selectTab('Historial');

    const history = historySection();
    expect(within(history).getByText('Recientes', { exact: true })).toBeTruthy();
    expect(within(history).getByText('Mejores', { exact: true })).toBeTruthy();
    expect(await historyActions('Abrir')).toHaveLength(3);
    const recentRow = historyRowsContaining(history, formatDateTime(recent[0]!.createdAt));
    expect(recentRow).toHaveLength(1);
    expect(recentRow[0]?.textContent).toContain('Victoria');
    expect(recentRow[0]?.textContent).toMatch(/100,25/);

    const historyReadsBeforePagination = listAttempts.mock.calls.length;
    fireEvent.click(within(history).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    expect(historyRowsContaining(history, formatDateTime(nextPage[0]!.createdAt))).toHaveLength(1);
    expect(await historyActions('Abrir')).toHaveLength(7);
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforePagination + 1);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBe('history-next');
    const readsAfterPagination = listAttempts.mock.calls.length;

    selectHistoryView('Mejores');
    const bestActions = within(history).getAllByRole('button', { name: 'Abrir' });
    expect(bestActions).toHaveLength(4);
    expect(within(history).queryByText('Derrota')).toBeNull();
    expect(within(history).queryByText(/fuera de clasificación/i)).toBeNull();
    const bestRows = within(history).getAllByRole('listitem');
    expect(bestRows).toHaveLength(4);
    expect(bestRows[0]?.textContent).toContain('#1');
    expect(bestRows[0]?.textContent).toMatch(/300(?:,00)? puntos/);
    for (const tiedRow of bestRows.slice(1, 3)) {
      expect(tiedRow.textContent).toContain('#2');
      expect(tiedRow.textContent).toMatch(/200(?:,00)? puntos/);
    }
    expect(bestRows[3]?.textContent).toContain('#4');
    expect(bestRows[3]?.textContent).toMatch(/100,25 puntos/);
    const loadedScope = within(history).getByText(/7 cargados.*más/i);
    expect(loadedScope.closest('details')).toBeNull();

    const methodology = within(history).getByText('Cómo se comparan', { selector: 'summary' });
    const methodologyDetails = methodology.closest('details');
    expect(methodologyDetails).not.toBeNull();
    expect((methodologyDetails as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(methodology);
    expect((methodologyDetails as HTMLDetailsElement).open).toBe(true);
    expect(within(methodologyDetails as HTMLElement).getByText(/páginas cargadas/i)).toBeTruthy();
    expect(
      within(methodologyDetails as HTMLElement).getByText(/empates conservan la misma posición/i),
    ).toBeTruthy();
    expect(
      within(methodologyDetails as HTMLElement).getByText(/tokens de juego registrados/i),
    ).toBeTruthy();

    selectHistoryView('Recientes');
    expect(within(history).getAllByRole('button', { name: 'Abrir' })).toHaveLength(7);
    expect(within(history).getByText('Derrota')).toBeTruthy();
    expect(historyRowsContaining(history, formatDateTime(recent[0]!.createdAt))).toHaveLength(1);
    expect(listAttempts).toHaveBeenCalledTimes(readsAfterPagination);
    expect(app.runner.getAttempt).not.toHaveBeenCalled();
    expect(app.runner.getConfiguration).not.toHaveBeenCalled();
    expect(app.runner.getDecisionIndex).not.toHaveBeenCalled();
    expect(app.runner.getReplay).not.toHaveBeenCalled();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
    expect(app.draft.putDraft).not.toHaveBeenCalled();
  });

  it('keeps the selected best view, loaded pages, editor literal, and row focus after opening a result', async () => {
    const firstPage = [
      summary('history-return-recent', 'victory', {
        createdAt: '2026-10-27T12:00:00.000Z',
        score: 120,
      }),
      summary('history-return-defeat', 'defeat', {
        createdAt: '2026-10-27T11:00:00.000Z',
      }),
    ];
    const secondPage = [
      summary('history-return-best', 'victory', {
        createdAt: '2026-10-27T10:00:00.000Z',
        score: 420,
      }),
    ];
    const listAttempts = vi.fn(async (cursor?: string) =>
      cursor === 'history-return-next'
        ? { attempts: secondPage }
        : { attempts: firstPage, nextCursor: 'history-return-next' },
    );
    const getAttempt = vi.fn().mockResolvedValue(secondPage[0]);
    const getDraft = vi.fn().mockResolvedValue({
      version: 1,
      draft: { ...createDefaultDraft(), instructions: 'Texto actual del editor.' },
    });
    const putDraft = vi.fn();
    const app = renderApp({
      draft: draftApi({ getDraft, putDraft }),
      runner: attemptApi({ listAttempts, getAttempt }),
    });
    const instructions = await readyForPreparation();
    await waitFor(() => expect(instructions.value).toBe('Texto actual del editor.'));
    const unsavedLiteral = 'Edición que debe quedar en el editor.';
    fireEvent.change(instructions, { target: { value: unsavedLiteral } });
    selectTab('Historial');
    expect(await historyActions('Abrir')).toHaveLength(2);
    vi.useFakeTimers();
    const history = historySection();
    const loadMore = within(history).getByRole('button', { name: 'Cargar 20 más' });
    const historyReadsBeforePagination = listAttempts.mock.calls.length;
    fireEvent.click(loadMore);
    await settle();
    expect(historyRowsContaining(history, formatDateTime(secondPage[0]!.createdAt))).toHaveLength(
      1,
    );
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforePagination + 1);
    selectHistoryView('Mejores');

    const sortedActions = within(history).getAllByRole('button', { name: 'Abrir' });
    expect(sortedActions).toHaveLength(2);
    const historyReadsAfterPagination = listAttempts.mock.calls.length;
    await act(async () => {
      fireEvent.click(sortedActions[0]!);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getAttempt).toHaveBeenCalledWith('history-return-best', expect.any(AbortSignal));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Volver al historial' })));

    const historyAfterReturn = historySection();
    const restoredActions = within(historyAfterReturn).getAllByRole('button', { name: 'Abrir' });
    expect(restoredActions).toHaveLength(2);
    expect(document.activeElement).toBe(restoredActions[0]);
    expect(within(historyAfterReturn).queryByText('Derrota')).toBeNull();
    expect(instructions.isConnected).toBe(true);
    expect(instructions.value).toBe(unsavedLiteral);
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).not.toHaveBeenCalled();
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsAfterPagination);
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(app.runner.getConfiguration).not.toHaveBeenCalled();
    expect(app.runner.getDecisionIndex).not.toHaveBeenCalled();
    expect(app.runner.getReplay).not.toHaveBeenCalled();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
    expect(app.runner.startAttempt).not.toHaveBeenCalled();
    expect(app.runner.cancelAttempt).not.toHaveBeenCalled();
  });

  it('distinguishes Mejores with no comparable victories from an empty account history', async () => {
    const defeat = summary('history-best-empty-defeat', 'defeat', {
      createdAt: '2026-10-27T12:00:00.000Z',
    });
    const unknownScore = summary('history-best-empty-unknown', 'victory', {
      createdAt: '2026-10-27T11:00:00.000Z',
      score: null,
    });
    const listAttempts = vi.fn(async (cursor?: string) =>
      cursor === 'history-best-empty-next'
        ? { attempts: [] }
        : { attempts: [defeat, unknownScore], nextCursor: 'history-best-empty-next' },
    );
    renderApp({ runner: attemptApi({ listAttempts }) });
    await readyForPreparation();
    selectTab('Historial');
    expect(await historyActions('Abrir')).toHaveLength(2);
    await settle();
    const initialHistoryReads = listAttempts.mock.calls.length;

    selectHistoryView('Mejores');
    const history = historySection();
    expect(within(history).getByText(/no hay victorias comparables/i)).toBeTruthy();
    expect(within(history).queryByText('Todavía no hay intentos guardados.')).toBeNull();
    expect(within(history).getByText(/2 cargados/)).toBeTruthy();
    expect(within(history).queryByText('Derrota')).toBeNull();

    selectHistoryView('Recientes');
    expect(within(history).getAllByRole('button', { name: 'Abrir' })).toHaveLength(2);
    expect(within(history).getByText('Derrota')).toBeTruthy();
    expect(listAttempts).toHaveBeenCalledTimes(initialHistoryReads);
  });

  it.each(['configuration', 'inspector'] as const)(
    'returns from a history %s to its selected best view without another history read',
    async (query) => {
      const victory = summary(`history-${query}-best`, 'victory', { score: 240 });
      const defeat = summary(`history-${query}-excluded`, 'defeat');
      const listAttempts = vi.fn().mockResolvedValue({ attempts: [victory, defeat] });
      const getConfiguration = vi.fn().mockResolvedValue({
        attemptId: victory.id,
        draft: createDefaultDraft(),
      });
      const getDecisionIndex = vi.fn().mockResolvedValue({
        attemptId: victory.id,
        levelId: LEVEL.id,
        decisions: [],
      });
      renderApp({
        runner: attemptApi({ listAttempts, getConfiguration, getDecisionIndex }),
      });
      await readyForPreparation();
      selectTab('Historial');
      await historyActions('Abrir');
      selectHistoryView('Mejores');
      const historyReadsBeforeQuery = listAttempts.mock.calls.length;
      fireEvent.click(
        await historyAction(
          query === 'configuration' ? 'Ver configuración' : 'Inspeccionar decisiones',
        ),
      );
      await screen.findByRole('heading', {
        name: query === 'configuration' ? 'Configuración del intento' : 'Inspeccionar decisiones',
      });
      fireEvent.click(
        screen.getByRole('button', {
          name: query === 'configuration' ? 'Cerrar' : 'Cerrar inspección',
        }),
      );

      const history = historySection();
      const remainingOpeners = within(history).getAllByRole('button', { name: 'Abrir' });
      expect(remainingOpeners).toHaveLength(1);
      expect(within(history).queryByText('Derrota')).toBeNull();
      const historyRowFocusTargets = [
        ...within(history).queryAllByRole('button', { name: 'Abrir' }),
        ...within(history).queryAllByText('Más acciones', { selector: 'summary' }),
        ...within(history).queryAllByRole('button', { name: 'Ver configuración' }),
        ...within(history).queryAllByRole('button', { name: 'Inspeccionar decisiones' }),
      ];
      await waitFor(() => expect(historyRowFocusTargets).toContain(document.activeElement));
      expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforeQuery);
      expect(getConfiguration).toHaveBeenCalledTimes(query === 'configuration' ? 1 : 0);
      expect(getDecisionIndex).toHaveBeenCalledTimes(query === 'inspector' ? 1 : 0);
    },
  );

  it('groups row queries and keeps unsupported replay and inspection actions unavailable', async () => {
    const incomplete = summary('history-incomplete-actions', 'defeat', {
      recordComplete: false,
      presentationComplete: true,
      turnsUsed: 3,
    });
    const getReplay = vi.fn();
    const getDecisionIndex = vi.fn();
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [incomplete] }),
        getReplay,
        getDecisionIndex,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    const history = historySection();
    expect(await historyActions('Abrir')).toHaveLength(1);
    const moreActions = within(history).getByText('Más acciones', { selector: 'summary' });
    const actionsDisclosure = moreActions.closest('details');
    expect(actionsDisclosure).not.toBeNull();
    expect((actionsDisclosure as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(moreActions);

    expect((actionsDisclosure as HTMLDetailsElement).open).toBe(true);
    expect(within(history).getByRole('button', { name: 'Ver configuración' })).toBeTruthy();
    expect(within(history).queryByRole('button', { name: 'Ver de nuevo' })).toBeNull();
    expect(within(history).queryByRole('button', { name: 'Inspeccionar decisiones' })).toBeNull();
    expect(getReplay).not.toHaveBeenCalled();
    expect(getDecisionIndex).not.toHaveBeenCalled();
  });

  it('keeps loading and error distinct from the single empty state that leads to Preparar', async () => {
    const bootstrap = deferred<{ attempts: readonly AttemptSummary[] }>();
    const listAttempts = vi.fn().mockReturnValueOnce(bootstrap.promise).mockResolvedValue({
      attempts: [],
    });
    renderApp({ runner: attemptApi({ listAttempts }) });
    await readyForNavigation();
    selectTab('Historial');
    const history = historySection();
    expect(await within(history).findByText('Recuperando tus intentos…')).toBeTruthy();
    expect(within(history).queryByText(/^Todavía no hay/)).toBeNull();
    expect(within(history).getByText('Recuperando tus intentos…')).toBeTruthy();

    await act(async () => {
      bootstrap.resolve({ attempts: [] });
      await bootstrap.promise;
    });
    await settle();
    expect(within(history).getAllByText('Todavía no hay intentos guardados.')).toHaveLength(1);
    expect(
      within(history).queryByText(
        'Todavía no hay victorias comparables entre los intentos cargados.',
      ),
    ).toBeNull();
    const prepare = within(history).getByText('Preparar', { exact: true });
    const historyReadsBeforePrepare = listAttempts.mock.calls.length;
    fireEvent.click(prepare);
    expect(screen.getByRole('heading', { name: 'Prepará tu robot' })).toBeTruthy();
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforePrepare);
  });

  it('recovers a failed bootstrap into one confirmed empty history and Preparar action', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    const recovery = deferred<{ attempts: readonly AttemptSummary[]; nextCursor?: string }>();
    const listAttempts = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Historial no disponible.', 503))
      .mockResolvedValueOnce({ attempts: [] })
      .mockReturnValueOnce(recovery.promise);
    renderApp({ runner: attemptApi({ listAttempts }) });
    await settle();
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeTruthy();
    expect(listAttempts).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(listAttempts).toHaveBeenCalledTimes(2);
    selectTab('Historial');
    await settle();
    expect(listAttempts).toHaveBeenCalledTimes(3);
    expect(listAttempts.mock.calls.at(-1)?.[0]).toBeUndefined();
    const history = historySection();
    expect(within(history).queryByText('Todavía no hay intentos guardados.')).toBeNull();
    await act(async () => recovery.resolve({ attempts: [] }));
    await settle();

    expect(within(history).getAllByText('Todavía no hay intentos guardados.')).toHaveLength(1);
    expect(
      within(history).queryByText(
        'Todavía no hay victorias comparables entre los intentos cargados.',
      ),
    ).toBeNull();
    expect(within(history).getByText('Preparar', { exact: true })).toBeTruthy();
    const historyReadsBeforePrepare = listAttempts.mock.calls.length;
    fireEvent.click(within(history).getByText('Preparar', { exact: true }));
    expect(screen.getByRole('heading', { name: 'Prepará tu robot' })).toBeTruthy();
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforePrepare);
  });
});
