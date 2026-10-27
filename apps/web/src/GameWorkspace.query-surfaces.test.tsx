// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function historyButton(name: string): Promise<HTMLButtonElement> {
  const heading = await screen.findByRole('heading', { name: 'Historial' });
  const section = heading.closest('section');
  expect(section).not.toBeNull();
  return (await within(section as HTMLElement).findByRole('button', { name })) as HTMLButtonElement;
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
    fireEvent.click(await historyButton('Ver configuración'));
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
    fireEvent.click(await historyButton('Inspeccionar decisiones'));
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
    fireEvent.click(await historyButton('Ver resultado'));
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
    fireEvent.click(await historyButton('Ver resultado'));
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

  it('aborts a pending saved-copy inspection when leaving and starts a fresh query on return', async () => {
    const listed = savedCopy('query-copy', 'Contenido consultado.');
    const oldResult = deferred<SavedRobot>();
    const newResult = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockReturnValueOnce(oldResult.promise)
      .mockReturnValueOnce(newResult.promise);
    renderApp({
      copies: savedRobotApi({
        listRobots: vi.fn().mockResolvedValue({ robots: [savedCopySummary(listed)] }),
        getRobot,
      }),
    });
    await readyForPreparation();
    selectTab('Mis robots');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Ver configuración de Copia consultada' }),
    );
    await screen.findByText('Consultando la copia…');
    const abandonedSignal = getRobot.mock.calls[0]?.[1];
    expect(abandonedSignal).toBeInstanceOf(AbortSignal);

    selectTab('Historial');
    expect(abandonedSignal?.aborted).toBe(true);
    await act(async () => {
      oldResult.resolve(savedCopy('query-copy', 'Respuesta obsoleta.'));
      await oldResult.promise;
    });
    expect(screen.queryByText('Respuesta obsoleta.')).toBeNull();

    selectTab('Mis robots');
    expect(screen.queryByText('Consultando la copia…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver configuración de Copia consultada' }));
    await screen.findByText('Consultando la copia…');
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    const currentSignal = getRobot.mock.calls[1]?.[1];
    expect(currentSignal).toBeInstanceOf(AbortSignal);
    expect(currentSignal?.aborted).toBe(false);

    await act(async () => {
      newResult.resolve(savedCopy('query-copy', 'Respuesta vigente.'));
      await newResult.promise;
    });
    expect(await screen.findByText('Respuesta vigente.')).toBeTruthy();
    expect(screen.queryByText('Respuesta obsoleta.')).toBeNull();
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
    fireEvent.click(await screen.findByRole('button', { name: /Copia consultada.*Cargar/ }));
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
    fireEvent.click(await screen.findByRole('button', { name: /Copia consultada.*Cargar/ }));
    await waitFor(() => expect(tab('Preparar').getAttribute('aria-current')).toBe('page'));

    selectTab('Mis robots');
    fireEvent.change(screen.getByLabelText('Nombre de esta copia'), {
      target: { value: 'Nombre local cambiado' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar versión remota' }));
    await waitFor(() => expect(app.draft.putDraft).toHaveBeenCalledTimes(2));

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
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt: vi.fn().mockResolvedValue(terminal),
        getReplay: vi.fn(async (id: string) => replayRecord(id, 'defeat')),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    const history = await screen.findByRole('heading', { name: 'Historial' });
    const historySection = history.closest('section') as HTMLElement;
    fireEvent.click(within(historySection).getByRole('button', { name: 'Ver resultado' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver de nuevo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar escena' }));

    const backButtons = screen.getAllByRole('button', { name: 'Volver al historial' });
    expect(backButtons).toHaveLength(1);
    const focusSpy = vi.spyOn(HTMLButtonElement.prototype, 'focus');
    fireEvent.click(backButtons[0]!);

    expect(await screen.findByRole('heading', { name: 'Historial' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Derrota' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Volver al historial' })).toBeNull();
    const restoredHistory = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(restoredHistory).not.toBeNull();
    const restoredReplay = within(restoredHistory as HTMLElement).getByRole('button', {
      name: 'Ver de nuevo',
    });
    expect(document.activeElement).toBe(restoredReplay);
    expect(focusSpy.mock.calls).toEqual([[]]);
  });

  it('uses native scrolling focus when a history-result query returns to its row', async () => {
    const terminal = summary('history-result-native-focus', 'defeat');
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt: vi.fn().mockResolvedValue(terminal),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');

    const opener = await historyButton('Ver resultado');
    opener.focus();
    fireEvent.click(opener);
    expect(await screen.findByRole('heading', { name: 'Derrota' })).toBeTruthy();

    const focusSpy = vi.spyOn(HTMLButtonElement.prototype, 'focus');
    fireEvent.click(await screen.findByRole('button', { name: 'Volver al historial' }));
    const restored = await historyButton('Ver resultado');
    await waitFor(() => expect(document.activeElement).toBe(restored));

    expect(restored.dataset.historyAttemptId).toBe(terminal.id);
    expect(restored.dataset.historyAction).toBe('result');
    expect(focusSpy.mock.calls).toEqual([[]]);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(focusSpy.mock.calls).toEqual([[]]);
  });

  it('uses native scrolling focus when a history inspector closes to its opener', async () => {
    const terminal = summary('history-inspector-native-focus', 'defeat');
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getDecisionIndex: vi.fn().mockResolvedValue({
          attemptId: terminal.id,
          levelId: LEVEL.id,
          decisions: [],
        }),
      }),
    });
    await readyForPreparation();
    selectTab('Historial');

    const opener = await historyButton('Inspeccionar decisiones');
    opener.focus();
    fireEvent.click(opener);
    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();

    const focusSpy = vi.spyOn(HTMLButtonElement.prototype, 'focus');
    fireEvent.click(await screen.findByRole('button', { name: 'Cerrar inspección' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(focusSpy.mock.calls).toEqual([[]]);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(focusSpy.mock.calls).toEqual([[]]);
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
    fireEvent.click(await historyButton('Ver resultado'));
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
        fireEvent.click(await historyButton('Ver resultado'));
      }
      await screen.findByRole('heading', { name: 'Derrota' });
      fireEvent.click(screen.getByRole('button', { name: 'Compartir resultado' }));
      await screen.findByRole('link', { name: 'Descargar imagen' });

      selectTab('Mis robots');
      await screen.findByRole('heading', { name: 'Tus robots' });
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
    fireEvent.click(await historyButton('Ver resultado'));
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
    await screen.findByRole('heading', { name: 'Tus robots' });
    await act(async () => {
      acknowledgement.resolve({ ...terminal, presentationComplete: true });
      await acknowledgement.promise;
    });

    expect(createAttempt).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Tus robots' })).toBeTruthy();
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
