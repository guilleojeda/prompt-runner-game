// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type DraftSnapshot,
  type RobotDraft,
  type SavedRobot,
} from '../../../shared/robot.js';
import { createClosedAttemptRecordFixture } from '../../../shared/attempt.fixture.js';
import { LEVEL } from '../../../shared/game.js';
import type { ReplayRecordView } from '../../../shared/attempt.js';
import { App } from './App.js';
import { type AuthClient, type AuthConfig, type AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type AttemptSummary } from './attempt-api.js';
import { DraftApiFailure, type DraftApi } from './draft-api.js';
import {
  historyAction,
  historyActionForRow,
  historyActions,
  historySection,
  settle,
} from './History.test-support.js';
import { type SavedRobotApi } from './saved-robot-api.js';

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

function copy(name: string, id: string, instructions: string): SavedRobot {
  const draft = { ...createDefaultDraft(), instructions };
  return {
    id,
    name,
    version: 1,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:00.000Z',
    modelKey: draft.modelKey,
    draft,
  };
}

function copySummary(robot: SavedRobot) {
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('App workspace navigation acceptance', () => {
  it('exposes the three accessible surfaces and only the selected surface', async () => {
    renderApp();
    const preparation = await readyForPreparation();
    const nav = navigation();

    expect(within(nav).getAllByRole('button')).toHaveLength(3);
    expect(tab('Preparar').getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: 'Prepará tu robot' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Historial' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tus robots' })).toBeNull();

    selectTab('Historial');
    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tus robots' })).toBeNull();
    expect(preparation.isConnected).toBe(true);
  });

  it('keeps one editor DOM branch and one control group hidden across surface changes and resize', async () => {
    const getDraft = vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() });
    const app = renderApp({ draft: draftApi({ getDraft }) });
    const instructions = await readyForPreparation();
    const controls = screen.getByRole('group', { name: 'Controles de prueba y animación' });
    expect(screen.getAllByRole('button', { name: 'Probar' })).toHaveLength(1);
    expect(screen.getAllByRole('checkbox', { name: 'Animación' })).toHaveLength(1);
    vi.useFakeTimers();
    const literal = 'Mismo texto con espacios  y\nsalto de línea.';
    fireEvent.change(instructions, { target: { value: literal } });
    instructions.setSelectionRange(7, 18, 'backward');

    selectTab('Historial');
    expect(instructions.isConnected).toBe(true);
    expect(instructions.closest('[hidden]')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Probar' })).toBeNull();

    selectTab('Mis robots');
    expect(instructions.isConnected).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Historial' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
    expect(instructions.value).toBe(literal);
    expect(instructions.selectionStart).toBe(7);
    expect(instructions.selectionEnd).toBe(18);
    expect(instructions.selectionDirection).toBe('backward');

    selectTab('Preparar');
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBe(instructions);
    expect(instructions.closest('[hidden]')).toBeNull();
    expect(instructions.value).toBe(literal);
    expect(instructions.selectionStart).toBe(7);
    expect(instructions.selectionEnd).toBe(18);
    expect(instructions.selectionDirection).toBe('backward');
    expect(screen.getByRole('group', { name: 'Controles de prueba y animación' })).toBe(controls);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBe(instructions);
    expect(instructions.value).toBe(literal);
    expect(instructions.selectionStart).toBe(7);
    expect(instructions.selectionEnd).toBe(18);
    expect(instructions.selectionDirection).toBe('backward');
    expect(getDraft).toHaveBeenCalledOnce();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
  });

  it('reopens active descriptions only on entering Preparar, not after render, save, or resize', async () => {
    const stored = createDefaultDraft();
    const activeDraft: RobotDraft = {
      ...stored,
      skills: stored.skills.map((skill) => ({
        ...skill,
        enabled: skill.id === 'advance' || skill.id === 'jump',
      })),
    };
    const pendingSave = deferred<DraftSnapshot>();
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pendingSave.promise);
    const app = renderApp({
      draft: draftApi({
        getDraft: vi.fn().mockResolvedValue({ version: 1, draft: activeDraft }),
        putDraft,
      }),
    });
    const instructions = await readyForPreparation();
    vi.useFakeTimers();
    const advanceDescription = screen.getByRole('textbox', {
      name: 'Descripción de Avanzar para el agente',
    });
    const advanceDetails = advanceDescription.closest('details') as HTMLDetailsElement;
    expect(advanceDetails.open).toBe(true);
    expect(
      (
        screen
          .getByRole('textbox', { name: 'Descripción de Saltar para el agente' })
          .closest('details') as HTMLDetailsElement
      ).open,
    ).toBe(true);

    const summaryElement = advanceDetails.querySelector('summary');
    expect(summaryElement).not.toBeNull();
    fireEvent.click(summaryElement as HTMLElement);
    expect(advanceDetails.open).toBe(false);
    const retreatToggle = screen.getByRole('checkbox', { name: 'Retroceder' }) as HTMLInputElement;
    fireEvent.click(retreatToggle);
    expect(retreatToggle.checked).toBe(true);
    const retreatDetails = screen
      .getByRole('textbox', { name: 'Descripción de Retroceder para el agente' })
      .closest('details') as HTMLDetailsElement;
    expect(retreatDetails.open).toBe(true);
    expect(advanceDetails.open).toBe(false);
    fireEvent.change(instructions, { target: { value: 'Guardar sin reabrir la habilidad.' } });
    await advance(600);
    selectTab('Preparar');
    act(() => window.dispatchEvent(new Event('resize')));
    expect(advanceDetails.open).toBe(false);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(
      putDraft.mock.calls[0]?.[1]?.skills.find((skill) => skill.id === 'retreat')?.enabled,
    ).toBe(true);

    selectTab('Historial');
    selectTab('Preparar');
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBe(instructions);
    expect((screen.getByRole('checkbox', { name: 'Retroceder' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(advanceDetails.open).toBe(true);
    expect(retreatDetails.open).toBe(true);
    expect(app.runner.createAttempt).not.toHaveBeenCalled();

    fireEvent.click(advanceDetails.querySelector('summary') as HTMLElement);
    expect(advanceDetails.open).toBe(false);
    await act(async () => {
      pendingSave.resolve({
        version: 2,
        draft: {
          ...activeDraft,
          instructions: 'Guardar sin reabrir la habilidad.',
          skills: activeDraft.skills.map((skill) =>
            skill.id === 'retreat' ? { ...skill, enabled: true } : skill,
          ),
        },
      });
      await Promise.resolve();
    });
    expect(advanceDetails.open).toBe(false);
  });

  it('changes local surfaces without changing browser history or starting mutations', async () => {
    const app = renderApp();
    await readyForPreparation();
    const initialUrl = window.location.href;
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');

    selectTab('Historial');
    selectTab('Mis robots');
    selectTab('Preparar');
    act(() => window.dispatchEvent(new Event('resize')));

    expect(window.location.href).toBe(initialUrl);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(app.draft.putDraft).not.toHaveBeenCalled();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
    expect(app.runner.startAttempt).not.toHaveBeenCalled();
    expect(app.runner.cancelAttempt).not.toHaveBeenCalled();

    app.unmount();
    const reloaded = renderApp({
      auth: app.auth,
      draft: app.draft,
      copies: app.copies,
      runner: app.runner,
    });
    await readyForPreparation();
    expect(tab('Preparar').getAttribute('aria-current')).toBe('page');
    expect(reloaded.runner.createAttempt).not.toHaveBeenCalled();
  });

  it('saves an edited literal at its original 600 ms deadline while the editor is hidden', async () => {
    const putDraft = vi.fn(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    }));
    const app = renderApp({ draft: draftApi({ putDraft }) });
    const instructions = await readyForPreparation();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const literal = 'Texto pendiente 🌱\nse conserva tal cual.  ';
    fireEvent.change(instructions, { target: { value: literal } });
    await advance(250);
    selectTab('Historial');
    expect(instructions.closest('[hidden]')).not.toBeNull();
    await advance(349);
    expect(putDraft).not.toHaveBeenCalled();
    await advance(1);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.slice(0, 2)).toEqual([
      1,
      expect.objectContaining({ instructions: literal }),
    ]);
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
    selectTab('Preparar');
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBe(instructions);
    expect(instructions.value).toBe(literal);
  });

  it('preserves a later editor literal when a pending PUT resolves while hidden', async () => {
    const firstSave = deferred<DraftSnapshot>();
    const firstLiteral = 'Primera versión enviada.';
    const laterLiteral = 'Edición posterior 🌱\nno debe perderse.  ';
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(firstSave.promise)
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft }));
    const app = renderApp({ draft: draftApi({ putDraft }) });
    const instructions = await readyForPreparation();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    fireEvent.change(instructions, { target: { value: firstLiteral } });
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    fireEvent.change(instructions, { target: { value: laterLiteral } });
    selectTab('Historial');

    await act(async () => {
      firstSave.resolve({
        version: 2,
        draft: { ...createDefaultDraft(), instructions: firstLiteral },
      });
      await Promise.resolve();
    });
    await settle();
    await advance(600);

    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.slice(0, 2)).toEqual([
      2,
      expect.objectContaining({ instructions: laterLiteral }),
    ]);
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
    selectTab('Preparar');
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBe(instructions);
    expect(instructions.value).toBe(laterLiteral);
  });

  it('keeps the existing 60 second recovery deadline while navigating away and back', async () => {
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(new DraftApiFailure('rate_limited', 'Límite temporal.', 429))
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft }));
    const app = renderApp({ draft: draftApi({ putDraft }) });
    const instructions = await readyForPreparation();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    fireEvent.change(instructions, { target: { value: 'Pendiente mientras se recupera.' } });
    await advance(600);
    await settle();
    expect(putDraft).toHaveBeenCalledOnce();

    selectTab('Historial');
    await advance(30_000);
    selectTab('Mis robots');
    await advance(29_999);
    expect(putDraft).toHaveBeenCalledOnce();
    selectTab('Preparar');
    await advance(1);
    await settle();

    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.slice(0, 2)).toEqual([
      1,
      expect.objectContaining({ instructions: 'Pendiente mientras se recupera.' }),
    ]);
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
  });

  it('preserves the selected surface, editor instance, and text through a same-identity renewal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const original = session('subject-a', 'old-token', Math.floor(Date.now() / 1000) + 2);
    const renewed = session('subject-a', 'new-token', Math.floor(Date.now() / 1000) + 600);
    const initialize = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(renewed);
    const getDraft = vi.fn().mockResolvedValue({
      version: 1,
      draft: { ...createDefaultDraft(), instructions: 'Texto de la misma cuenta.' },
    });
    const app = renderApp({ auth: authClient({ initialize }), draft: draftApi({ getDraft }) });
    await settle();
    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    selectTab('Historial');

    await advance(2_000);
    await settle();
    expect(initialize).toHaveBeenCalledTimes(2);

    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
    expect(instructions.isConnected).toBe(true);
    expect(instructions.closest('[hidden]')).not.toBeNull();
    expect(instructions.value).toBe('Texto de la misma cuenta.');
    expect(getDraft).toHaveBeenCalledOnce();
    expect(app.draft.putDraft).not.toHaveBeenCalled();
  });

  it('returns Seguir editando to Preparar and focuses its heading from another surface', async () => {
    const putDraft = vi.fn(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    }));
    const app = renderApp({ draft: draftApi({ putDraft }) });
    const instructions = await readyForPreparation();
    vi.useFakeTimers();
    fireEvent.change(instructions, { target: { value: 'Pendiente al abrir Historial.' } });
    selectTab('Historial');

    fireEvent.click(screen.getByRole('button', { name: 'Cuenta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));

    const preparationHeading = screen.getByRole('heading', { name: 'Prepará tu robot' });
    expect(tab('Preparar').getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(preparationHeading);
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBe(instructions);
    expect(instructions.value).toBe('Pendiente al abrir Historial.');
    expect(app.auth.logout).not.toHaveBeenCalled();
    expect(putDraft).not.toHaveBeenCalled();
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
  });

  it('preserves loaded history pages when switching away and returning', async () => {
    const first = summary('attempt-first-page');
    const second = summary('attempt-second-page', 'defeat');
    const listAttempts = vi.fn(async (cursor?: string) =>
      cursor === 'history-next'
        ? { attempts: [second] }
        : { attempts: [first], nextCursor: 'history-next' },
    );
    renderApp({ runner: attemptApi({ listAttempts }) });
    await readyForPreparation();
    selectTab('Historial');
    expect(await screen.findByText('Victoria')).toBeTruthy();
    expect(screen.queryByText('Derrota')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar 20 más' }));
    expect(await screen.findByText('Derrota')).toBeTruthy();

    selectTab('Preparar');
    selectTab('Historial');
    expect(screen.getByText('Victoria')).toBeTruthy();
    expect(screen.getByText('Derrota')).toBeTruthy();
  });

  it('preserves the selected copy and loaded library page when returning to Mis robots', async () => {
    const first = copy('Alfa', 'copy-alpha', 'Primera página.');
    const second = copy('Beta', 'copy-beta', 'Segunda página seleccionada.');
    const listRobots = vi.fn(async (cursor?: string) =>
      cursor === 'copies-next'
        ? { robots: [copySummary(second)] }
        : { robots: [copySummary(first)], nextCursor: 'copies-next' },
    );
    const getRobot = vi.fn(async (id: string) => (id === second.id ? second : first));
    const app = renderApp({ copies: savedRobotApi({ listRobots, getRobot }) });
    await readyForPreparation();
    selectTab('Mis robots');
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar más' }));
    await screen.findByRole('button', { name: /Beta.*Cargar/ });
    fireEvent.click(screen.getByRole('button', { name: 'Ver configuración de Beta' }));
    expect(await screen.findByRole('heading', { name: 'Configuración de Beta' })).toBeTruthy();
    expect(screen.getByText('Segunda página seleccionada.')).toBeTruthy();

    selectTab('Historial');
    selectTab('Mis robots');
    expect(screen.getByRole('button', { name: /Beta.*Cargar/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Configuración de Beta' })).toBeTruthy();
    expect(screen.getByText('Segunda página seleccionada.')).toBeTruthy();
    expect(getRobot).toHaveBeenCalledOnce();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
  });

  it('returns a history result to its origin row and restores row focus', async () => {
    const terminal = summary('attempt-result-origin');
    const getAttempt = vi.fn().mockResolvedValue(terminal);
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getAttempt,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    const opener = await historyAction('Abrir');
    fireEvent.click(opener);
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Volver al historial' }));

    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
    const restoredOpener = within(historySection()).getByRole('button', { name: 'Abrir' });
    expect(document.activeElement).toBe(restoredOpener);
    expect(getAttempt).toHaveBeenCalledOnce();
  });

  it('keeps a history configuration read-only and closes back to the same history surface', async () => {
    const terminal = summary('attempt-config-readonly');
    const candidate = { ...createDefaultDraft(), instructions: 'Snapshot de consulta.' };
    const getConfiguration = vi
      .fn()
      .mockResolvedValue({ attemptId: terminal.id, draft: candidate });
    const app = renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getConfiguration,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Ver configuración'));
    expect(await screen.findByRole('heading', { name: 'Configuración del intento' })).toBeTruthy();
    expect(screen.getByText(candidate.instructions)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
    expect(app.draft.putDraft).not.toHaveBeenCalled();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
    expect(app.runner.startAttempt).not.toHaveBeenCalled();
    expect(app.runner.cancelAttempt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    expect(getConfiguration).toHaveBeenCalledOnce();
  });

  it('ignores a closed configuration response after a newer history target is selected', async () => {
    const first = summary('attempt-config-old');
    const second = summary('attempt-config-current', 'defeat');
    const pending = deferred<{ attemptId: string; draft: RobotDraft }>();
    const requestedSignals: AbortSignal[] = [];
    const getConfiguration = vi.fn((id: string, signal?: AbortSignal) => {
      if (signal) requestedSignals.push(signal);
      return id === first.id
        ? pending.promise
        : Promise.resolve({
            attemptId: second.id,
            draft: { ...createDefaultDraft(), instructions: 'Selección vigente.' },
          });
    });
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [first, second] }),
        getConfiguration,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    const configButtons = await historyActions('Ver configuración');
    fireEvent.click(configButtons[0]!);
    expect(await screen.findByText('Cargando la configuración guardada…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(requestedSignals[0]?.aborted).toBe(true);
    fireEvent.click((await historyActions('Ver configuración'))[1]!);
    expect(await screen.findByText('Selección vigente.')).toBeTruthy();
    const focusBeforeLateResponse = document.activeElement;

    await act(async () => {
      pending.resolve({
        attemptId: first.id,
        draft: { ...createDefaultDraft(), instructions: 'Respuesta vieja.' },
      });
      await Promise.resolve();
    });

    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Selección vigente.')).toBeTruthy();
    expect(screen.queryByText('Respuesta vieja.')).toBeNull();
    expect(document.activeElement).toBe(focusBeforeLateResponse);
  });

  it.each([
    ['history', 'Ver configuración'],
    ['copy', 'Cargar'],
  ] as const)(
    'returns to Preparar only after the %s application write confirms',
    async (source, sourceAction) => {
      const candidate = {
        ...createDefaultDraft(),
        instructions: `Aplicación ${source} confirmada.`,
      };
      const pending = deferred<DraftSnapshot>();
      const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pending.promise);
      const terminal = summary(`attempt-apply-${source}`);
      const savedCopy = copy('Robot de prueba', 'copy-apply-source', candidate.instructions);
      const getConfiguration = vi
        .fn()
        .mockResolvedValue({ attemptId: terminal.id, draft: candidate });
      const copies = savedRobotApi({
        listRobots: vi.fn().mockResolvedValue({ robots: [copySummary(savedCopy)] }),
        getRobot: vi.fn().mockResolvedValue(savedCopy),
      });
      const app = renderApp({
        draft: draftApi({ putDraft }),
        copies,
        runner: attemptApi({
          listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
          getConfiguration,
        }),
      });
      await readyForPreparation();
      selectTab(source === 'history' ? 'Historial' : 'Mis robots');
      if (source === 'history') {
        fireEvent.click(await historyAction(sourceAction));
        await screen.findByRole('button', { name: 'Usar esta configuración' });
        fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));
      } else {
        fireEvent.click(await screen.findByRole('button', { name: /Robot de prueba.*Cargar/ }));
      }
      await waitFor(() => expect(putDraft).toHaveBeenCalledOnce());
      expect(
        tab(source === 'history' ? 'Historial' : 'Mis robots').getAttribute('aria-current'),
      ).toBe('page');
      expect(app.runner.createAttempt).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve({ version: 2, draft: candidate });
        await Promise.resolve();
      });
      expect(await screen.findByDisplayValue(candidate.instructions)).toBeTruthy();
      expect(tab('Preparar').getAttribute('aria-current')).toBe('page');
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Prepará tu robot' }),
      );
      expect(app.runner.createAttempt).not.toHaveBeenCalled();
      expect(app.runner.startAttempt).not.toHaveBeenCalled();
    },
  );

  it('cancels a saved-copy application when leaving while its source GET is pending', async () => {
    const pending = deferred<SavedRobot>();
    const savedCopy = copy('Robot pendiente', 'copy-pending-get', 'No importar tarde.');
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockReturnValue(pending.promise);
    const getDraft = vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() });
    const app = renderApp({
      draft: draftApi({ getDraft }),
      copies: savedRobotApi({
        listRobots: vi.fn().mockResolvedValue({ robots: [copySummary(savedCopy)] }),
        getRobot,
      }),
    });
    await readyForPreparation();
    selectTab('Mis robots');
    fireEvent.click(await screen.findByRole('button', { name: /Robot pendiente.*Cargar/ }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledOnce());
    selectTab('Historial');

    await act(async () => {
      pending.resolve(savedCopy);
      await Promise.resolve();
    });

    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
    expect(getRobot.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(app.draft.putDraft).not.toHaveBeenCalled();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
    expect(getDraft).toHaveBeenCalledOnce();
  });

  it.each([
    ['history', 'Mis robots'],
    ['copy', 'Historial'],
  ] as const)(
    'cancels a sent %s application on navigation and preserves the visible editor after late success',
    async (source, destination) => {
      const original = { ...createDefaultDraft(), instructions: 'Visible antes de aplicar.' };
      const candidate = { ...createDefaultDraft(), instructions: `No importar tarde: ${source}.` };
      const pending = deferred<DraftSnapshot>();
      const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pending.promise);
      const terminal = summary(`attempt-apply-pending-${source}`);
      const savedCopy = copy('Robot pendiente', 'copy-pending-put', candidate.instructions);
      const app = renderApp({
        draft: draftApi({
          getDraft: vi.fn().mockResolvedValue({ version: 1, draft: original }),
          putDraft,
        }),
        copies: savedRobotApi({
          listRobots: vi.fn().mockResolvedValue({ robots: [copySummary(savedCopy)] }),
          getRobot: vi.fn().mockResolvedValue(savedCopy),
        }),
        runner: attemptApi({
          listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
          getConfiguration: vi.fn().mockResolvedValue({ attemptId: terminal.id, draft: candidate }),
        }),
      });
      const instructions = await readyForPreparation();
      selectTab(source === 'history' ? 'Historial' : 'Mis robots');
      if (source === 'history') {
        fireEvent.click(await historyAction('Ver configuración'));
        await screen.findByRole('button', { name: 'Usar esta configuración' });
        fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));
      } else {
        fireEvent.click(await screen.findByRole('button', { name: /Robot pendiente.*Cargar/ }));
      }
      await waitFor(() => expect(putDraft).toHaveBeenCalledOnce());
      selectTab(destination);
      expect(putDraft.mock.calls[0]?.[2]?.aborted).toBe(true);
      expect(app.runner.createAttempt).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve({ version: 2, draft: candidate });
        await Promise.resolve();
      });
      expect(tab(destination).getAttribute('aria-current')).toBe('page');
      selectTab('Preparar');
      expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBe(instructions);
      expect(instructions.value).toBe(original.instructions);
      expect(screen.queryByDisplayValue(candidate.instructions)).toBeNull();
      expect(app.runner.createAttempt).not.toHaveBeenCalled();
    },
  );

  it('keeps active work in the foreground and exposes only Cancelar until it settles', async () => {
    const active = summary('attempt-active-navigation', 'pending', { animationEnabled: true });
    const createAttempt = vi.fn().mockResolvedValue({ attempt: active, dispatchConfirmed: true });
    const getAttempt = vi.fn().mockResolvedValue(active);
    const cancelAttempt = vi.fn().mockResolvedValue(summary(active.id, 'cancelled'));
    const app = renderApp({ runner: attemptApi({ createAttempt, getAttempt, cancelAttempt }) });
    await readyForPreparation();
    vi.useFakeTimers();
    const tryButton = screen.getByRole('button', { name: 'Probar' });
    fireEvent.click(tryButton);
    await settle();
    const cancelButton = screen.getByRole('button', { name: 'Cancelar' });

    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Historial' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tus robots' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Probar' })).toBeNull();
    for (const name of ['Preparar', 'Historial', 'Mis robots'] as const) {
      const control = tab(name);
      expect(control.disabled).toBe(true);
      const describedBy = control.getAttribute('aria-describedby')?.trim().split(/\s+/) ?? [];
      expect(describedBy.length).toBeGreaterThan(0);
      for (const id of describedBy) {
        const reason = document.getElementById(id);
        expect(reason).not.toBeNull();
        expect(reason?.hidden).toBe(false);
        expect(reason?.closest('[hidden]')).toBeNull();
        expect(reason?.getAttribute('aria-hidden')).not.toBe('true');
        expect(reason?.textContent?.trim()).not.toBe('');
      }
    }
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(app.runner.startAttempt).not.toHaveBeenCalled();
    expect(cancelAttempt).not.toHaveBeenCalled();

    (cancelButton as HTMLButtonElement).focus();
    await advance(2_000);
    expect(getAttempt).toHaveBeenCalledWith(active.id, expect.any(AbortSignal));
    expect(document.activeElement).toBe(cancelButton);
    fireEvent.click(cancelButton);
    await settle();
    expect(cancelAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledOnce();
  });

  it('reconciles uncertain admission by the same request key while keeping navigation locked', async () => {
    const active = summary('attempt-uncertain-navigation', 'pending');
    const result = deferred<AttemptSummary>();
    const createAttempt = vi
      .fn()
      .mockRejectedValue(
        new AttemptApiFailure('network', 'No se confirmó el inicio.', undefined, true),
      );
    const getAttemptRequest = vi.fn().mockReturnValue(result.promise);
    const app = renderApp({ runner: attemptApi({ createAttempt, getAttemptRequest }) });
    await readyForPreparation();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    const checkStatus = await screen.findByRole('button', { name: 'Comprobar estado' });
    const originalRequestKey = createAttempt.mock.calls[0]?.[0];
    expect(originalRequestKey).toEqual(expect.any(String));
    expect(tab('Preparar').disabled).toBe(true);
    expect(tab('Historial').disabled).toBe(true);
    expect(tab('Mis robots').disabled).toBe(true);

    fireEvent.click(checkStatus);
    await waitFor(() => expect(getAttemptRequest).toHaveBeenCalledOnce());
    expect(getAttemptRequest).toHaveBeenCalledWith(originalRequestKey, expect.any(AbortSignal));
    await act(async () => {
      result.resolve(active);
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(tab('Preparar').disabled).toBe(true);
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(getAttemptRequest).toHaveBeenCalledOnce();
    expect(app.runner.startAttempt).toHaveBeenCalledOnce();
    expect(app.runner.startAttempt).toHaveBeenCalledWith(active.id, expect.any(AbortSignal));
  });

  it('keeps active-attempt selection in the activity surface instead of exposing the other tabs', async () => {
    const first = summary('attempt-choice-a', 'running');
    const second = summary('attempt-choice-b', 'pending');
    const startAttempt = vi.fn(async (id: string) => ({
      attempt: summary(id, 'running'),
      dispatchConfirmed: true,
    }));
    const app = renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [first, second] }),
        getAttempt: vi.fn(async (id: string) => (id === first.id ? first : second)),
        startAttempt,
      }),
    });
    await readyForNavigation();
    expect(
      await screen.findByRole('heading', { name: 'Tenés varios intentos en curso' }),
    ).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Historial' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tus robots' })).toBeNull();
    expect(tab('Preparar').disabled).toBe(true);
    expect(tab('Historial').disabled).toBe(true);
    expect(tab('Mis robots').disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /attempt-choice-b/ }));
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(startAttempt).toHaveBeenCalledWith(second.id, expect.any(AbortSignal));
    expect(startAttempt).toHaveBeenCalledOnce();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
  });

  it('keeps a manual replay foreground and mounted through resize without another replay read', async () => {
    const record = replayRecord('attempt-manual-replay', 'defeat');
    const terminal = summary('attempt-manual-replay', 'defeat', {
      turnsUsed: record.actions.length,
      animationEnabled: false,
      presentationComplete: true,
    });
    const getReplay = vi.fn(async (id: string) => replayRecord(id, 'defeat'));
    renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getReplay,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Ver de nuevo'));
    const readyButton = await screen.findByRole('button', { name: 'Escena lista' });
    fireEvent.click(readyButton);
    const finishButton = await screen.findByRole('button', { name: 'Terminar escena' });
    expect(tab('Preparar').disabled).toBe(true);
    expect(tab('Historial').disabled).toBe(true);
    expect(tab('Mis robots').disabled).toBe(true);

    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.getByRole('button', { name: 'Terminar escena' })).toBe(finishButton);
    expect(getReplay).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
  });

  it('keeps the history surface and current attempt untouched while inspecting another attempt', async () => {
    const terminal = summary('attempt-inspector-navigation', 'defeat', {
      turnsUsed: 3,
      presentationComplete: true,
    });
    const getDecisionIndex = vi.fn().mockResolvedValue({
      attemptId: terminal.id,
      levelId: LEVEL.id,
      decisions: [],
    });
    const app = renderApp({
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [terminal] }),
        getDecisionIndex,
      }),
    });
    await readyForPreparation();
    selectTab('Historial');
    fireEvent.click(await historyAction('Inspeccionar decisiones'));
    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
    expect(getDecisionIndex).toHaveBeenCalledWith(terminal.id, expect.any(AbortSignal));
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
    expect(app.runner.getReplay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));
    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
  });

  it.each([
    ['Animación desactivada', false, 3],
    ['cero acciones', true, 0],
  ] as const)(
    'shows a direct result for %s without replay or delayed presentation',
    async (_label, animationEnabled, turnsUsed) => {
      const terminal = summary('attempt-direct-result', 'victory', {
        animationEnabled,
        turnsUsed,
        presentationComplete: false,
      });
      const createAttempt = vi
        .fn()
        .mockResolvedValue({ attempt: terminal, dispatchConfirmed: true });
      const app = renderApp({
        runner: attemptApi({
          createAttempt,
          getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled, version: 1 }),
        }),
      });
      await readyForPreparation();
      fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
      expect(app.runner.getReplay).not.toHaveBeenCalled();
      expect(app.runner.completePresentation).not.toHaveBeenCalled();
      expect(createAttempt).toHaveBeenCalledOnce();

      selectTab('Preparar');
      expect(await screen.findByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();
    },
  );

  it('keeps acknowledgement retry in the background when navigating away from a locally finished replay', async () => {
    const terminal = summary('attempt-ack-navigation', 'victory', {
      turnsUsed: replayRecord('attempt-ack-navigation').actions.length,
      animationEnabled: true,
      presentationComplete: false,
    });
    const other = summary('attempt-history-current', 'defeat');
    const otherConfiguration = {
      ...createDefaultDraft(),
      instructions: 'La configuración B permanece visible.',
    };
    const firstAcknowledgement = deferred<AttemptSummary>();
    const acknowledged = deferred<AttemptSummary>();
    const getConfiguration = vi.fn().mockResolvedValue({
      attemptId: other.id,
      draft: otherConfiguration,
    });
    const completePresentation = vi
      .fn()
      .mockReturnValueOnce(firstAcknowledgement.promise)
      .mockReturnValueOnce(acknowledged.promise);
    const createAttempt = vi.fn().mockResolvedValue({ attempt: terminal, dispatchConfirmed: true });
    const app = renderApp({
      runner: attemptApi({
        createAttempt,
        listAttempts: vi.fn().mockResolvedValue({ attempts: [other] }),
        getConfiguration,
        completePresentation,
        getReplay: vi.fn(async (id: string) => replayRecord(id, 'victory')),
      }),
    });
    await settle();
    const tryButton = screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
    await waitFor(() => expect(tryButton.disabled).toBe(false));
    fireEvent.click(tryButton);
    await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Escena lista' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminar escena' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    await waitFor(() => expect(completePresentation).toHaveBeenCalledOnce());

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    await act(async () => {
      firstAcknowledgement.reject(
        new AttemptApiFailure('attempt_unavailable', 'Límite temporal.', 429),
      );
      await Promise.resolve();
    });
    await settle();
    selectTab('Historial');
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    await settle();
    expect(screen.getByText('Derrota')).toBeTruthy();
    fireEvent.click(await historyActionForRow('Ver configuración', 'Derrota'));
    await settle();
    expect(screen.getByText(otherConfiguration.instructions)).toBeTruthy();
    expect(getConfiguration).toHaveBeenCalledWith(other.id, expect.any(AbortSignal));
    expect(screen.getByRole('heading', { name: 'Configuración del intento' })).toBeTruthy();
    const focusedConfigurationControl = document.activeElement;

    await advance(59_999);
    expect(completePresentation).toHaveBeenCalledOnce();
    await advance(1);
    await settle();
    expect(completePresentation).toHaveBeenCalledTimes(2);
    expect(completePresentation).toHaveBeenLastCalledWith(terminal.id, expect.any(AbortSignal));
    await act(async () => {
      acknowledged.resolve({ ...terminal, presentationComplete: true });
      await Promise.resolve();
    });
    expect(tab('Historial').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();
    expect(screen.getByText(otherConfiguration.instructions)).toBeTruthy();
    expect(document.activeElement).toBe(focusedConfigurationControl);
    expect(getConfiguration).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(app.runner.getReplay).toHaveBeenCalledOnce();
  });

  it('keeps a deferred configuration query from changing the selected surface after logout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const oldSession = session('subject-old', 'old-token', Math.floor(Date.now() / 1000) + 1);
    const getConfigurationResult = deferred<{ attemptId: string; draft: RobotDraft }>();
    const getConfiguration = vi.fn(() => getConfigurationResult.promise);
    const initialize = vi
      .fn()
      .mockResolvedValueOnce(oldSession)
      .mockResolvedValueOnce(session('subject-new', 'new-token'));
    const app = renderApp({
      auth: authClient({ initialize }),
      runner: attemptApi({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [summary('attempt-old-query')] }),
        getConfiguration,
      }),
    });
    await settle();
    selectTab('Historial');
    fireEvent.click(await historyAction('Ver configuración'));
    expect(getConfiguration).toHaveBeenCalledOnce();

    await advance(1_000);
    await settle();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    await act(async () => {
      getConfigurationResult.resolve({
        attemptId: 'attempt-old-query',
        draft: { ...createDefaultDraft(), instructions: 'No debe reaparecer.' },
      });
      await Promise.resolve();
    });
    expect(screen.queryByText('No debe reaparecer.')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).toBeNull();
    expect(app.draft.putDraft).not.toHaveBeenCalled();
    expect(app.runner.createAttempt).not.toHaveBeenCalled();
  });
});
