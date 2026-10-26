// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import {
  createDefaultDraft,
  type DraftSnapshot,
  type RobotDraft,
  type SavedRobot,
} from '../../../shared/robot.js';
import { App } from './App.js';
import type { AuthClient, AuthConfig, AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type AttemptSummary } from './attempt-api.js';
import { DraftApiFailure, type DraftApi } from './draft-api.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

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
  instructions: 'Mi robot confirmado 🧭\nSin reemplazar.',
};
const candidate = {
  ...createDefaultDraft(),
  instructions: 'Configuración elegida ✨\nConservar el literal y sus espacios.  ',
  skills: createDefaultDraft().skills.map((skill, index) =>
    index === 0 ? { ...skill, description: 'Avanzá 👨‍👩‍👧‍👦\nSólo una casilla.  ' } : skill,
  ),
};

function session(): AuthSession {
  const sub = 'application-player';
  const email = 'player@example.com';
  const now = Date.now() / 1000;
  return {
    identity: { sub, email },
    user: new User({
      access_token: 'test-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      session_state: null,
      profile: {
        iss: config.issuer,
        aud: config.clientId,
        sub,
        email,
        iat: now,
        exp: now + 36_000,
      },
      expires_at: now + 36_000,
    }),
  };
}

function summary(id: string): AttemptSummary {
  return {
    id,
    createdAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T12:00:01.000Z',
    status: 'cancelled',
    cancelRequested: true,
    levelId: LEVEL.id,
    modelKey: 'claude-sonnet-4.6',
    modelLabel: 'Claude Sonnet 4.6',
    modelId: 'global.anthropic.claude-sonnet-4-6',
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
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
  };
}

function copy(id: string, name: string, draft: RobotDraft): SavedRobot {
  return {
    id,
    name,
    version: 3,
    createdAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T12:00:00.000Z',
    modelKey: draft.modelKey,
    draft,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let count = 0; count < 16; count += 1) await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function instructions(): HTMLTextAreaElement {
  return screen.getByRole('textbox', {
    name: 'Qué debe tener en cuenta el robot',
  }) as HTMLTextAreaElement;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

async function mount(
  overrides: {
    draftApi?: Partial<DraftApi>;
    savedApi?: Partial<SavedRobotApi>;
    auth?: Partial<AuthClient>;
  } = {},
) {
  const copies = [copy('copy-a', 'Copia A', candidate), copy('copy-b', 'Copia B', original)];
  const draftApi: DraftApi = {
    getDraft: vi.fn().mockResolvedValue({ version: 4, draft: original }),
    putDraft: vi.fn<DraftApi['putDraft']>().mockImplementation(async (version, draft) => ({
      version: version + 1,
      draft,
    })),
    ...overrides.draftApi,
  };
  const savedApi: SavedRobotApi = {
    listRobots: vi.fn().mockResolvedValue({ robots: copies }),
    getRobot: vi
      .fn()
      .mockImplementation(async (id: string) => copies.find((item) => item.id === id)),
    saveRobot: vi.fn(),
    deleteRobot: vi.fn(),
    ...overrides.savedApi,
  };
  const runnerApi: AttemptApi = {
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 1 }),
    putAnimationPreference: vi.fn(),
    createAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('invalid', 'Admisión de prueba rechazada.', 400)),
    getAttemptRequest: vi.fn(),
    getAttempt: vi.fn(),
    getConfiguration: vi.fn().mockResolvedValue({ attemptId: 'history-a', draft: candidate }),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [summary('history-a')] }),
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-26',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: '2026-10-27T03:00:00.000Z',
    }),
  };
  const auth: AuthClient = {
    initialize: vi.fn().mockResolvedValue(session()),
    beginLogin: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides.auth,
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
  expect(instructions().value).toBe(original.instructions);
  expect(button('Probar').disabled).toBe(false);
  return { draftApi, savedApi, runnerApi, auth, copies };
}

type Source = 'history' | 'saved copy';

async function apply(source: Source): Promise<void> {
  if (source === 'history') {
    const history = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(history).not.toBeNull();
    fireEvent.click(within(history!).getByRole('button', { name: 'Ver configuración' }));
    await settle();
    fireEvent.click(button('Usar esta configuración'));
  } else {
    fireEvent.click(screen.getByRole('button', { name: /Copia A.*Cargar/ }));
  }
  await settle();
}

function expectEditable(): void {
  expect(instructions().disabled).toBe(false);
  expect(instructions().readOnly).toBe(false);
  expect(button('Cuenta').disabled).toBe(false);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// These cases exercise D2 through both real callers and the real draft owner, not a mocked handle.
describe.each<Source>(['history', 'saved copy'])('configuration application from %s', (source) => {
  it('imports the complete literal only after its conditional write confirms, without admission', async () => {
    const pending = deferred<DraftSnapshot>();
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pending.promise);
    const { runnerApi } = await mount({ draftApi: { putDraft } });
    await apply(source);

    expect(putDraft).toHaveBeenCalledWith(4, candidate, expect.any(AbortSignal));
    expect(instructions().value).toBe(original.instructions);
    expectEditable();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();

    pending.resolve({ version: 5, draft: candidate });
    await settle();
    expect(instructions().value).toBe(candidate.instructions);
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Descripción de Avanzar para el agente',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(candidate.skills[0]?.description);
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('recovers a definite transient rejection at the original minute while editing and cancellation stay usable', async () => {
    const pending = deferred<DraftSnapshot>();
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(new DraftApiFailure('rate_limited', 'Límite temporal.', 429))
      .mockReturnValueOnce(pending.promise);
    const { runnerApi, savedApi } = await mount({ draftApi: { putDraft } });
    await apply(source);

    expect(instructions().value).toBe(original.instructions);
    expectEditable();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /Reintentar guardado/ })).toBeNull();
    await advance(59_999);
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(1);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.slice(0, 2)).toEqual([4, candidate]);
    expect(instructions().value).toBe(original.instructions);

    pending.resolve({ version: 5, draft: candidate });
    await settle();
    expect(instructions().value).toBe(candidate.instructions);
    if (source === 'saved copy') expect(savedApi.getRobot).toHaveBeenCalledOnce();
    else expect(runnerApi.getConfiguration).toHaveBeenCalledOnce();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
    expect(runnerApi.startAttempt).not.toHaveBeenCalled();
  });

  it('cancels the candidate when typing during recovery and saves the new visible text at the same deadline', async () => {
    const edited = { ...original, instructions: 'Mi edición posterior 🌱\nNo importar la copia.' };
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(new DraftApiFailure('rate_limited', 'Límite temporal.', 429))
      .mockResolvedValueOnce({ version: 5, draft: edited });
    const { runnerApi } = await mount({ draftApi: { putDraft } });
    await apply(source);
    await advance(20_000);
    expectEditable();
    fireEvent.change(instructions(), { target: { value: edited.instructions } });
    await settle();
    await advance(39_999);
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(1);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.slice(0, 2)).toEqual([4, edited]);
    expect(instructions().value).toBe(edited.instructions);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('allows an explicit Probar to cancel a definite rejected candidate without scheduling any later admission', async () => {
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValue(new DraftApiFailure('rate_limited', 'Límite temporal.', 429));
    const { runnerApi } = await mount({ draftApi: { putDraft } });
    await apply(source);
    expect(button('Probar').disabled).toBe(false);
    fireEvent.click(button('Probar'));
    await settle();
    expect(runnerApi.createAttempt).toHaveBeenCalledWith(expect.any(String), 4, original, false);
    await advance(180_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructions().value).toBe(original.instructions);
    expect(runnerApi.createAttempt).toHaveBeenCalledOnce();
  });

  it('cancels an unresolved candidate PUT before bounded Probar and never admits after its late success', async () => {
    const pending = deferred<DraftSnapshot>();
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft }));
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce({ version: 4, draft: original })
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Todavía no se puede comprobar la escritura.'),
      )
      .mockResolvedValue({ version: 5, draft: candidate });
    const { runnerApi } = await mount({ draftApi: { putDraft, getDraft } });
    await apply(source);
    expect(putDraft).toHaveBeenCalledOnce();
    const signal = putDraft.mock.calls[0]?.[2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(button('Probar').disabled).toBe(false);
    fireEvent.click(button('Probar'));
    await settle();

    expect(signal?.aborted).toBe(true);
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
    expect(button('Probar').disabled).toBe(false);
    expectEditable();
    pending.resolve({ version: 5, draft: candidate });
    await settle();
    await advance(180_000);
    expect(instructions().value).toBe(original.instructions);
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
    expect(runnerApi.startAttempt).not.toHaveBeenCalled();
    expect(
      putDraft.mock.calls
        .slice(1)
        .every(([, draft]) => draft.instructions === original.instructions),
    ).toBe(true);
    expect(screen.queryByText('Cargaste «Copia A».')).toBeNull();
  });

  it('keeps sign-out available and never resumes a candidate after the session has ended', async () => {
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValue(new DraftApiFailure('rate_limited', 'Límite temporal.', 429));
    const { auth, runnerApi } = await mount({ draftApi: { putDraft } });
    await apply(source);
    expect(button('Cuenta').disabled).toBe(false);
    fireEvent.click(button('Cuenta'));
    fireEvent.click(button('Cerrar sesión'));
    await settle();
    // The visible positive snapshot is clean and the rejected PUT is definite.
    expect(auth.logout).toHaveBeenCalledOnce();
    await advance(180_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });
});

describe('candidate source and history cancellation', () => {
  it('lets the player explicitly cancel a saved-copy application without waiting for its loader', async () => {
    const pending = deferred<SavedRobot>();
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockReturnValue(pending.promise);
    const { copies, draftApi, runnerApi } = await mount({ savedApi: { getRobot } });
    await apply('saved copy');
    const signal = getRobot.mock.calls[0]?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
    const cancel = button('Cancelar aplicación');
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await settle();

    expect(signal?.aborted).toBe(true);
    expectEditable();
    expect(
      (screen.getByRole('button', { name: /Copia B.*Cargar/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    pending.resolve(copies[0]!);
    await settle();
    await advance(180_000);
    expect(instructions().value).toBe(original.instructions);
    expect(screen.queryByText('Cargaste «Copia A».')).toBeNull();
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('preserves access recovery when the real saved-copy loader rejects authentication', async () => {
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValue(new SavedRobotApiFailure('authentication', 'Acceso rechazado.', 401));
    const { draftApi, runnerApi } = await mount({ savedApi: { getRobot } });
    await apply('saved copy');

    expect(button('Volver a ingresar')).toBeTruthy();
    expect(instructions().value).toBe(original.instructions);
    expect(instructions().readOnly).toBe(true);
    await advance(180_000);
    expect(getRobot).toHaveBeenCalledOnce();
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('keeps a historical over-limit copy fully consultable without applying or truncating it', async () => {
    const historical = { ...candidate, instructions: 'Á'.repeat(1001) };
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockResolvedValue(copy('copy-a', 'Copia A', historical));
    const { draftApi, runnerApi } = await mount({ savedApi: { getRobot } });
    await apply('saved copy');

    expect(instructions().value).toBe(original.instructions);
    expect(screen.getByText(historical.instructions)).toBeTruthy();
    expect(screen.getByText(/Esta copia supera los límites actuales/)).toBeTruthy();
    await advance(180_000);
    expect(getRobot).toHaveBeenCalledOnce();
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('retries the active saved-copy loader after a minute, keeping edits available before the GET succeeds', async () => {
    const pending = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'Copia temporalmente inaccesible.'),
      )
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('server', 'Sigue temporalmente inaccesible.', 503),
      )
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('rate_limited', 'Copia limitada temporalmente.', 429),
      )
      .mockReturnValueOnce(pending.promise);
    const { copies, draftApi, runnerApi } = await mount({ savedApi: { getRobot } });
    await apply('saved copy');
    expectEditable();
    expect(screen.queryByRole('alert')).toBeNull();
    for (let failures = 1; failures <= 3; failures += 1) {
      await advance(59_999);
      expect(getRobot).toHaveBeenCalledTimes(failures);
      expect(draftApi.putDraft).not.toHaveBeenCalled();
      await advance(1);
      expect(getRobot).toHaveBeenCalledTimes(failures + 1);
    }

    pending.resolve(copies[0]!);
    await settle();
    expect(draftApi.putDraft).toHaveBeenCalledWith(4, candidate, expect.any(AbortSignal));
    expect(instructions().value).toBe(candidate.instructions);
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('protects a monotonic visible revision from before the saved-copy GET, including A to B to A', async () => {
    const pending = deferred<SavedRobot>();
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockReturnValue(pending.promise);
    const { copies, draftApi } = await mount({ savedApi: { getRobot } });
    await apply('saved copy');
    expectEditable();
    fireEvent.change(instructions(), { target: { value: 'B durante GET' } });
    fireEvent.change(instructions(), { target: { value: original.instructions } });
    await settle();
    expect(getRobot.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(getRobot.mock.calls[0]?.[1]?.aborted).toBe(true);

    pending.resolve(copies[0]!);
    await settle();
    await advance(180_000);
    expect(instructions().value).toBe(original.instructions);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
  });

  it('closes an applying historical configuration without waiting for the PUT and ignores its late success', async () => {
    const pending = deferred<DraftSnapshot>();
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft }));
    const { runnerApi } = await mount({
      draftApi: {
        putDraft,
        getDraft: vi
          .fn<DraftApi['getDraft']>()
          .mockResolvedValueOnce({ version: 4, draft: original })
          .mockResolvedValue({ version: 5, draft: candidate }),
      },
    });
    await apply('history');
    expect(button('Cerrar').disabled).toBe(false);
    fireEvent.click(button('Cerrar'));
    await settle();
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
    expect(putDraft.mock.calls[0]?.[2]?.aborted).toBe(true);
    const field = instructions();
    field.focus();

    pending.resolve({ version: 5, draft: candidate });
    await settle();
    expect(instructions().value).toBe(original.instructions);
    expect(document.activeElement).toBe(field);
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });
});
