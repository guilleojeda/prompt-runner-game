// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createDefaultDraft, type RobotDraft, type SavedRobot } from '../../../shared/robot.js';
import { App } from './App.js';
import type { AuthClient, AuthConfig, AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi } from './attempt-api.js';
import type { DraftApi } from './draft-api.js';
import { installHtmlDialogTestShim } from './configuration-confirmation.test-support.js';
import { type SavedRobotApi } from './saved-robot-api.js';

vi.mock('./replay/ReplayScene.js', () => ({ CoursePreview: () => null, ReplayScene: () => null }));

const config: AuthConfig = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'client-public',
  domain: 'https://prompt-runner.auth.us-east-1.amazoncognito.com',
  redirectUri: 'https://robotrunner.guilleojeda.com/jugar',
  logoutUri: 'https://robotrunner.guilleojeda.com/',
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};

const original = {
  ...createDefaultDraft(),
  instructions: 'Borrador confirmado del editor 🌱\nSe conserva mientras consulto.',
};
const editorDraft: RobotDraft = {
  ...original,
  instructions: 'Texto B del editor 🧭\nConservar al renombrar; reemplazar sólo al confirmar.',
};
const copyDraft: RobotDraft = {
  ...createDefaultDraft(),
  instructions: 'Copia A literal ✨\nConservar espacios finales.  ',
  skills: createDefaultDraft().skills.map((skill, index) =>
    index === 0 ? { ...skill, description: 'Avanzá 👨‍👩‍👧‍👦\nDescripción literal.  ' } : skill,
  ),
};

function robot(id: string, name: string, draft: RobotDraft, version: number): SavedRobot {
  return {
    id,
    name,
    version,
    createdAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T12:00:00.000Z',
    modelKey: draft.modelKey,
    draft,
  };
}

const copyA = robot('123e4567-e89b-12d3-a456-426614174000', 'Copia A', copyDraft, 3);
const copyB = robot(
  '123e4567-e89b-12d3-a456-426614174001',
  'Copia B',
  { ...createDefaultDraft(), instructions: 'Texto de la copia B.' },
  5,
);

function session(sub = 'library-player', expiresInSeconds = 36_000): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  const email = sub + '@example.test';
  return {
    identity: { sub, email },
    user: new User({
      access_token: 'token-' + sub,
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      session_state: null,
      profile: {
        iss: config.issuer,
        aud: config.clientId,
        iat: now,
        exp: now + expiresInSeconds,
        sub,
        email,
      },
      expires_at: now + expiresInSeconds,
    }),
  };
}

function summary(saved: SavedRobot) {
  const { id, name, version, createdAt, updatedAt, modelKey } = saved;
  return { id, name, version, createdAt, updatedAt, modelKey };
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
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function instructions(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>('#robot-instructions');
  if (!field) throw new Error('El editor real no está montado.');
  return field;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

function navigation(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Navegación principal' });
}

function navigate(surface: 'Preparar' | 'Historial' | 'Mis robots'): void {
  const target = within(navigation()).getByRole('button', { name: surface });
  if (target.getAttribute('aria-current') !== 'page') fireEvent.click(target);
}

function activeSurface(): string | null {
  return within(navigation()).getByRole('button', { current: 'page' }).textContent;
}

interface MountOptions {
  readonly auth?: Partial<AuthClient>;
  readonly draftApi?: Partial<DraftApi>;
  readonly savedApi?: Partial<SavedRobotApi>;
  readonly runnerApi?: Partial<AttemptApi>;
}

async function mount(options: MountOptions = {}) {
  const copies = [copyA, copyB];
  const auth: AuthClient = {
    initialize: vi.fn().mockResolvedValue(session()),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...options.auth,
  };
  const draftApi: DraftApi = {
    getDraft: vi.fn().mockResolvedValue({ version: 4, draft: original }),
    putDraft: vi.fn<DraftApi['putDraft']>().mockImplementation(async (expectedVersion, draft) => ({
      version: expectedVersion + 1,
      draft,
    })),
    ...options.draftApi,
  };
  const savedApi: SavedRobotApi = {
    listRobots: vi.fn().mockResolvedValue({ robots: copies.map(summary) }),
    getRobot: vi.fn<SavedRobotApi['getRobot']>().mockImplementation(async (id) => {
      const selected = copies.find((copy) => copy.id === id);
      if (!selected) throw new Error('Copia desconocida: ' + id);
      return selected;
    }),
    saveRobot: vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockImplementation(async (id, expectedVersion, name, draft) =>
        robot(id, name, draft, expectedVersion + 1),
      ),
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    ...options.savedApi,
  };
  const runnerApi: AttemptApi = {
    createAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('invalid', 'No se esperaba una partida.', 400)),
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
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 1 }),
    putAnimationPreference: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-26',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
    ...options.runnerApi,
  };

  render(
    <App
      authClient={auth}
      configLoader={async () => config}
      draftApi={draftApi}
      savedRobotApi={savedApi}
      attemptApi={runnerApi}
    />,
  );
  await settle();
  expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeTruthy();
  expect(button('Probar').disabled).toBe(false);
  expect(instructions().value).toBe(original.instructions);
  return { auth, draftApi, savedApi, runnerApi, copies };
}

async function selectCopy(id = copyA.id): Promise<HTMLElement> {
  navigate('Mis robots');
  await settle();
  const radio = screen.getByRole('radio', {
    name: id === copyA.id ? /Copia A/u : /Copia B/u,
  });
  fireEvent.click(radio);
  await settle();
  const panel = screen.getByRole('region', { name: 'Copia seleccionada' });
  const selected = id === copyA.id ? copyA : copyB;
  expect(
    within(panel).getByText(selected.draft.instructions, { normalizer: (text) => text }),
  ).toBeTruthy();
  return panel;
}

function openMoreActions(panel: HTMLElement): void {
  fireEvent.click(within(panel).getByText('Más acciones', { selector: 'summary' }));
}

async function confirmDialog(action: RegExp): Promise<void> {
  await settle();
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: action }));
}

let restoreDialogShim: (() => void) | undefined;

beforeAll(() => {
  restoreDialogShim = installHtmlDialogTestShim();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => restoreDialogShim?.());

describe('App library integration', () => {
  it('consults one selected copy and cancels Usar without applying or mutating anything', async () => {
    const { savedApi, draftApi, runnerApi } = await mount();
    const panel = await selectCopy();

    expect(screen.getByRole('heading', { name: 'Mis robots' }).id).toBe('saved-robots-title');
    expect(screen.getByRole('list', { name: 'Robots guardados' })).toBeTruthy();
    expect(savedApi.getRobot).toHaveBeenCalledExactlyOnceWith(copyA.id, expect.any(AbortSignal));
    expect(instructions().value).toBe(original.instructions);
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole('button', { name: 'Usar este robot' }));
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Usar.*Copia A/u })).toBeTruthy();
    expect(savedApi.getRobot).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await settle();

    expect(instructions().value).toBe(original.instructions);
    expect(activeSurface()).toBe('Mis robots');
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('abandons a canceled consult and reopens the selected copy without showing its late result', async () => {
    const late = deferred<SavedRobot>();
    const staleCopy = robot(
      copyA.id,
      copyA.name,
      {
        ...copyDraft,
        instructions: 'Resultado tardío de la consulta cancelada.',
      },
      4,
    );
    const reopenedCopy = robot(
      copyA.id,
      copyA.name,
      {
        ...copyDraft,
        instructions: 'Documento nuevo consultado al reabrir.',
      },
      6,
    );
    let readCount = 0;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation(() => {
      readCount += 1;
      if (readCount === 1) return late.promise;
      return Promise.resolve(reopenedCopy);
    });
    const { savedApi, draftApi, runnerApi } = await mount({ savedApi: { getRobot } });

    navigate('Mis robots');
    await settle();
    const firstRadio = screen.getByRole('radio', { name: /Copia A/u });
    expect((firstRadio as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(firstRadio);
    await settle();
    expect(getRobot).toHaveBeenCalledOnce();
    const firstSignal = getRobot.mock.calls[0]?.[1];
    expect(firstSignal).toBeInstanceOf(AbortSignal);

    navigate('Historial');
    await settle();
    expect(firstSignal?.aborted).toBe(true);
    late.resolve(staleCopy);
    await settle();

    navigate('Mis robots');
    await settle();
    const reopenedRadio = screen.getByRole('radio', { name: /Copia A/u });
    expect((reopenedRadio as HTMLInputElement).disabled).toBe(false);
    if (getRobot.mock.calls.length === 1) fireEvent.click(reopenedRadio);
    await settle();

    expect(getRobot).toHaveBeenCalledTimes(2);
    expect(getRobot).toHaveBeenNthCalledWith(1, copyA.id, expect.any(AbortSignal));
    expect(getRobot).toHaveBeenNthCalledWith(2, copyA.id, expect.any(AbortSignal));
    const panel = screen.getByRole('region', { name: 'Copia seleccionada' });
    expect(within(panel).getByText(reopenedCopy.draft.instructions)).toBeTruthy();
    expect(within(panel).queryByText(staleCopy.draft.instructions)).toBeNull();
    expect(instructions().value).toBe(original.instructions);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('replaces the visible draft and returns to Preparar only after the confirmed write', async () => {
    const pending = deferred<{ version: number; draft: RobotDraft }>();
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pending.promise);
    const { savedApi, draftApi, runnerApi } = await mount({ draftApi: { putDraft } });
    const panel = await selectCopy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Usar este robot' }));
    await confirmDialog(/Usar este robot/u);
    await settle();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledWith(4, copyDraft, expect.any(AbortSignal));
    expect(savedApi.getRobot).toHaveBeenCalledOnce();
    expect(instructions().value).toBe(original.instructions);
    expect(activeSurface()).toBe('Mis robots');
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();

    pending.resolve({ version: 5, draft: copyDraft });
    await settle();

    expect(instructions().value).toBe(copyDraft.instructions);
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Descripción de Avanzar para el agente',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(copyDraft.skills[0]?.description);
    expect(activeSurface()).toBe('Preparar');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Prepará tu robot' }));
    expect(draftApi.putDraft).toHaveBeenCalledOnce();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('cancels a pending application when returning to edit and saves later text after its late success', async () => {
    const pending = deferred<{ version: number; draft: RobotDraft }>();
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (expectedVersion, draft) => ({
        version: expectedVersion + 1,
        draft,
      }));
    const { savedApi, runnerApi } = await mount({ draftApi: { putDraft } });
    const panel = await selectCopy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Usar este robot' }));
    await confirmDialog(/Usar este robot/u);
    await settle();
    expect(putDraft).toHaveBeenCalledOnce();
    const signal = putDraft.mock.calls[0]?.[2];
    expect(signal).toBeInstanceOf(AbortSignal);

    navigate('Preparar');
    fireEvent.change(instructions(), { target: { value: editorDraft.instructions } });
    await settle();
    expect(signal?.aborted).toBe(true);

    pending.resolve({ version: 5, draft: copyDraft });
    await settle();
    expect(instructions().value).toBe(editorDraft.instructions);
    expect(activeSurface()).toBe('Preparar');
    expect(screen.queryByText(/Usaste «Copia A»|Cargaste «Copia A»/u)).toBeNull();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
    await advance(600);
    await settle();
    expect(putDraft.mock.calls[0]?.slice(0, 2)).toEqual([4, copyDraft]);
    expect(putDraft.mock.calls[1]?.slice(0, 2)).toEqual([5, editorDraft]);
    expect(instructions().value).toBe(editorDraft.instructions);
  });

  it('drops a pending copy application when session renewal changes identity', async () => {
    const pending = deferred<{ version: number; draft: RobotDraft }>();
    const initialize = vi
      .fn<AuthClient['initialize']>()
      .mockResolvedValueOnce(session('subject-a', 5))
      .mockResolvedValueOnce(session('subject-b'));
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pending.promise);
    const { auth, savedApi, runnerApi } = await mount({
      auth: { initialize },
      draftApi: { putDraft },
    });
    const panel = await selectCopy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Usar este robot' }));
    await confirmDialog(/Usar este robot/u);
    await settle();
    expect(putDraft).toHaveBeenCalledOnce();
    const signal = putDraft.mock.calls[0]?.[2];

    await advance(5_000);
    await settle();
    expect(auth.initialize).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(true);

    pending.resolve({ version: 5, draft: copyDraft });
    await settle();
    expect(screen.queryByText(/Usaste «Copia A»|Cargaste «Copia A»/u)).toBeNull();
    expect(screen.queryByText(copyDraft.instructions, { normalizer: (text) => text })).toBeNull();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('renames copy A with its stored literal while a different editor draft stays untouched', async () => {
    const { draftApi, savedApi, runnerApi } = await mount();
    fireEvent.change(instructions(), { target: { value: editorDraft.instructions } });
    const panel = await selectCopy();
    openMoreActions(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Renombrar' }));

    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Renombrar.*Copia A/u })).toBeTruthy();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Copia A renombrada' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));

    await settle();
    expect(savedApi.saveRobot).toHaveBeenCalledOnce();
    expect(
      (savedApi.saveRobot as Mock<SavedRobotApi['saveRobot']>).mock.calls[0]?.slice(0, 4),
    ).toEqual([copyA.id, copyA.version, 'Copia A renombrada', copyDraft]);
    expect(instructions().value).toBe(editorDraft.instructions);
    expect(activeSurface()).toBe('Mis robots');
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('replaces only copy A with the confirmed editor draft and preserves its name and editor', async () => {
    const { draftApi, savedApi, runnerApi } = await mount();
    fireEvent.change(instructions(), { target: { value: editorDraft.instructions } });
    await advance(600);
    await settle();
    expect(draftApi.putDraft).toHaveBeenCalledOnce();
    const writesBeforeReplacement = (draftApi.putDraft as Mock<DraftApi['putDraft']>).mock.calls
      .length;
    const panel = await selectCopy();
    openMoreActions(panel);
    fireEvent.click(within(panel).getByRole('button', { name: /Reemplazar con mi robot actual/u }));

    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Reemplazar.*Copia A/u })).toBeTruthy();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(draftApi.putDraft).toHaveBeenCalledTimes(writesBeforeReplacement);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reemplazar copia' }));
    await settle();
    expect(savedApi.saveRobot).toHaveBeenCalledOnce();

    expect(
      (savedApi.saveRobot as Mock<SavedRobotApi['saveRobot']>).mock.calls[0]?.slice(0, 4),
    ).toEqual([copyA.id, copyA.version, copyA.name, editorDraft]);
    expect(instructions().value).toBe(editorDraft.instructions);
    expect(activeSurface()).toBe('Mis robots');
    expect(draftApi.putDraft).toHaveBeenCalledTimes(writesBeforeReplacement);
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('creates and deletes only the explicit copy target without applying it or admitting a game', async () => {
    const { savedApi, draftApi, runnerApi } = await mount();

    navigate('Mis robots');
    await settle();
    fireEvent.click(button('Guardar robot actual'));
    await settle();
    const createName = screen.getByRole('textbox');
    fireEvent.change(createName, { target: { value: 'Nueva identidad' } });
    fireEvent.click(button('Guardar una copia'));
    await settle();
    expect(savedApi.saveRobot).toHaveBeenCalledOnce();
    const [createdId, expectedVersion, name, draft] = (
      savedApi.saveRobot as Mock<SavedRobotApi['saveRobot']>
    ).mock.calls[0]!;
    expect(createdId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect([expectedVersion, name, draft]).toEqual([0, 'Nueva identidad', original]);
    expect(instructions().value).toBe(original.instructions);
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();

    const confirmDelete = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const panel = await selectCopy();
    openMoreActions(panel);
    fireEvent.click(within(panel).getByRole('button', { name: /Eliminar copia/u }));
    await settle();
    expect(savedApi.deleteRobot).toHaveBeenCalledOnce();
    expect(
      (savedApi.deleteRobot as Mock<SavedRobotApi['deleteRobot']>).mock.calls[0]?.slice(0, 2),
    ).toEqual([copyA.id, copyA.version]);
    expect(confirmDelete).toHaveBeenCalledOnce();
    expect(confirmDelete.mock.calls[0]?.[0]).toContain(copyA.name);
    expect(instructions().value).toBe(original.instructions);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });
});
