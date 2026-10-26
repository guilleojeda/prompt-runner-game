// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot.js';
import { App } from './App.js';
import type { AttemptApi } from './attempt-api.js';
import type { AuthClient, AuthConfig, AuthSession } from './auth.js';
import { DraftApiFailure, type DraftApi } from './draft-api.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

vi.mock('./replay/ReplayScene.js', () => ({
  CoursePreview: () => null,
  ReplayScene: () => null,
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

function session(expiresAt = Date.now() / 1000 + 3_600): AuthSession {
  const sub = 'phase6-account';
  const email = 'player@example.com';
  return {
    identity: { sub, email },
    user: new User({
      access_token: 'access-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      session_state: null,
      profile: {
        iss: config.issuer,
        aud: config.clientId,
        sub,
        email,
        exp: expiresAt,
        iat: Date.now() / 1000,
      },
      expires_at: expiresAt,
    }),
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
    for (let count = 0; count < 12; count += 1) await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function attemptApi(): AttemptApi {
  return {
    createAttempt: vi.fn(),
    getAttemptRequest: vi.fn(),
    getAttempt: vi.fn(),
    getConfiguration: vi.fn(),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 0 }),
    putAnimationPreference: vi.fn(),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-25',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: '2026-10-26T03:00:00.000Z',
    }),
  };
}

async function mount(
  options: {
    draftApi?: Partial<DraftApi>;
    runnerApi?: Partial<AttemptApi>;
    savedApi?: Partial<SavedRobotApi>;
    authClient?: Partial<AuthClient>;
  } = {},
) {
  const currentDraft = { ...createDefaultDraft(), instructions: 'Base confirmada' };
  const api: DraftApi = {
    getDraft: vi.fn().mockResolvedValue({ version: 4, draft: currentDraft }),
    putDraft: vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft })),
    ...options.draftApi,
  };
  const auth: AuthClient = {
    initialize: vi.fn().mockResolvedValue(session()),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...options.authClient,
  };
  const runner = { ...attemptApi(), ...options.runnerApi };
  render(
    <App
      authClient={auth}
      draftApi={api}
      attemptApi={runner}
      savedRobotApi={{
        listRobots: vi.fn().mockResolvedValue({ robots: [] }),
        getRobot: vi.fn(),
        saveRobot: vi.fn(),
        deleteRobot: vi.fn(),
        ...options.savedApi,
      }}
      configLoader={async () => config}
    />,
  );
  await settle();
  return { api, auth, runner, currentDraft };
}

function instructions(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Qué debe tener en cuenta el robot' });
}

function edit(value = 'Edición local'): void {
  fireEvent.change(instructions(), { target: { value } });
}

function requestLogout(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Cuenta' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
}

// Accept the previous label in behavioral cases so the baseline reaches the transition.
// The first test independently requires the approved complete action label.
function waitAndLogout(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Esperar guardado(?: y salir)?$/ }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('draft recovery and account departure', () => {
  it('offers the three approved pending-change choices without manual save retry', async () => {
    const { auth } = await mount();
    edit();
    requestLogout();

    expect(screen.getByRole('button', { name: 'Seguir editando' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Esperar guardado y salir' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Descartar cambios locales y salir' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Reintentar guardado/i })).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('joins the existing recovery deadline while waiting to exit instead of forcing another save', async () => {
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(new DraftApiFailure('rate_limited', 'Temporal', 429))
      .mockRejectedValueOnce(new DraftApiFailure('rate_limited', 'Temporal otra vez', 429))
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft }));
    const { auth, api, currentDraft } = await mount({ draftApi: { putDraft } });
    edit();
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    requestLogout();
    waitAndLogout();
    await settle();

    expect(putDraft).toHaveBeenCalledOnce();
    expect((instructions().closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    await advance(59_999);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(auth.logout).not.toHaveBeenCalled();
    await advance(1);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(auth.logout).not.toHaveBeenCalled();
    edit('Texto posterior durante la espera');
    await advance(59_999);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(auth.logout).not.toHaveBeenCalled();
    await advance(1);
    expect(putDraft).toHaveBeenCalledTimes(3);
    expect(putDraft.mock.calls[2]?.slice(0, 2)).toEqual([
      4,
      { ...currentDraft, instructions: 'Texto posterior durante la espera' },
    ]);
    expect(api.getDraft).toHaveBeenCalledOnce();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
  });

  it('cancels waiting via Seguir editando without canceling autosave or letting its late reply log out', async () => {
    const pending = deferred<DraftSnapshot>();
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft }));
    const { auth, currentDraft } = await mount({ draftApi: { putDraft } });
    const field = instructions();
    edit('A enviada');
    await advance(600);
    requestLogout();
    waitAndLogout();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));
    edit('B posterior');
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    pending.resolve({ version: 5, draft: { ...currentDraft, instructions: 'A enviada' } });
    await settle();
    await advance(600);

    expect(instructions()).toBe(field);
    expect(instructions().value).toBe('B posterior');
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.slice(0, 2)).toEqual([
      5,
      { ...currentDraft, instructions: 'B posterior' },
    ]);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeNull();
    await advance(120_000);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('can cancel a waiting exit while a conflict still requires a human decision', async () => {
    const other = { ...createDefaultDraft(), instructions: 'Otra pestaña' };
    const putDraft = vi.fn<DraftApi['putDraft']>().mockRejectedValue(
      new DraftApiFailure('conflict', 'Otra pestaña guardó cambios', 409, {
        version: 7,
        draft: other,
      }),
    );
    const { auth } = await mount({ draftApi: { putDraft } });
    edit();
    await advance(600);
    expect(screen.getByText('Conflicto de edición')).toBeTruthy();
    requestLogout();
    waitAndLogout();
    await settle();
    await advance(120_000);

    expect(putDraft).toHaveBeenCalledOnce();
    expect(auth.logout).not.toHaveBeenCalled();
    const cancel = screen.getByRole('button', {
      name: 'Seguir editando',
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(instructions().value).toBe('Edición local');
    expect(screen.getByText('Conflicto de edición')).toBeTruthy();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('keeps a waiting exit cancelable if access is rejected while the save is pending', async () => {
    const pending = deferred<DraftSnapshot>();
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pending.promise);
    const { auth } = await mount({ draftApi: { putDraft } });
    const field = instructions();
    edit('Pendiente durante el rechazo de acceso');
    await advance(600);
    requestLogout();
    waitAndLogout();
    await settle();
    pending.reject(new DraftApiFailure('authentication', 'Acceso rechazado', 401));
    await settle();
    await advance(120_000);

    expect(auth.logout).not.toHaveBeenCalled();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();
    const cancel = screen.getByRole('button', { name: 'Seguir editando' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await settle();
    expect(instructions()).toBe(field);
    expect(instructions().value).toBe('Pendiente durante el rechazo de acceso');
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('invalidates and aborts a sent save synchronously before discard calls logout', async () => {
    const pending = deferred<DraftSnapshot>();
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pending.promise);
    let abortedAtLogout = false;
    const logout = vi.fn(async () => {
      abortedAtLogout = putDraft.mock.calls[0]?.[2]?.aborted === true;
    });
    const { api, currentDraft } = await mount({ draftApi: { putDraft }, authClient: { logout } });
    edit('Enviada antes de descartar');
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    requestLogout();
    waitAndLogout();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar cambios locales y salir' }));
    await settle();

    expect(abortedAtLogout).toBe(true);
    expect(logout).toHaveBeenCalledOnce();
    pending.resolve({
      version: 5,
      draft: { ...currentDraft, instructions: 'Enviada antes de descartar' },
    });
    await settle();
    await advance(120_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(api.getDraft).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox', { name: 'Qué debe tener en cuenta el robot' })).toBeNull();
  });

  it('protects pending text before changing to signing-in and permits canceling that redirect', async () => {
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValue(new DraftApiFailure('authentication', 'Acceso rechazado', 401));
    const { auth } = await mount({ draftApi: { putDraft } });
    const field = instructions();
    edit('Texto que todavía no se confirmó');
    await advance(600);
    expect(screen.getByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a ingresar' }));
    await settle();

    expect(auth.beginLogin).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Abriendo acceso…' })).toBeNull();
    expect(instructions()).toBe(field);
    expect(instructions().value).toBe('Texto que todavía no se confirmó');
    expect(
      screen.getByRole('button', {
        name: 'Ingresar y descartar cambios sin confirmar',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Esperar guardado y salir' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await settle();
    expect(auth.beginLogin).not.toHaveBeenCalled();
    expect(instructions()).toBe(field);
    expect(instructions().value).toBe('Texto que todavía no se confirmó');
    expect(
      screen.queryByRole('button', {
        name: 'Ingresar y descartar cambios sin confirmar',
      }),
    ).toBeNull();
    await advance(120_000);
    expect(putDraft).toHaveBeenCalledOnce();
  });

  it('preserves the paused draft when renewal returns no session until the user decides to discard', async () => {
    const initialize = vi
      .fn<AuthClient['initialize']>()
      .mockResolvedValueOnce(session(Date.now() / 1000 + 1))
      .mockResolvedValueOnce(null);
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValue(new DraftApiFailure('rate_limited', 'Temporal', 429));
    const { auth } = await mount({ authClient: { initialize }, draftApi: { putDraft } });
    const field = instructions();
    edit('Conservar aunque la renovación no devuelva sesión');
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(400);
    expect(initialize).toHaveBeenCalledTimes(2);

    expect(instructions()).toBe(field);
    expect(instructions().value).toBe('Conservar aunque la renovación no devuelva sesión');
    expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText('Tu cuenta está confirmada y la sesión es válida.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a ingresar' }));
    await settle();
    expect(auth.beginLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await settle();
    await advance(120_000);
    expect(instructions()).toBe(field);
    expect(instructions().value).toBe('Conservar aunque la renovación no devuelva sesión');
    expect(putDraft).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(auth.beginLogin).not.toHaveBeenCalled();
  });

  it('explains rejected access as requiring sign-in rather than claiming a session check is running', async () => {
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValue(new DraftApiFailure('authentication', 'Acceso rechazado', 401));
    await mount({ draftApi: { putDraft } });
    edit();
    await advance(600);

    expect(screen.getByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();
    expect(instructions().value).toBe('Edición local');
    expect(screen.queryAllByText(/Verificando tu sesión/)).toHaveLength(0);
    await advance(120_000);
    expect(putDraft).toHaveBeenCalledOnce();
  });

  it('aborts and invalidates the old draft before a confirmed re-entry redirect, even with a sent PUT', async () => {
    const pendingSave = deferred<DraftSnapshot>();
    const pendingAccess = deferred<Awaited<ReturnType<SavedRobotApi['listRobots']>>>();
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pendingSave.promise);
    let abortedAtLogin = false;
    const beginLogin = vi.fn(async () => {
      abortedAtLogin = putDraft.mock.calls[0]?.[2]?.aborted === true;
    });
    const { currentDraft } = await mount({
      draftApi: { putDraft },
      savedApi: { listRobots: vi.fn().mockReturnValue(pendingAccess.promise) },
      authClient: { beginLogin },
    });
    expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    edit('Enviada y pendiente al volver a ingresar');
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    pendingAccess.reject(new SavedRobotApiFailure('authentication', 'Acceso rechazado', 401));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a ingresar' }));
    await settle();
    expect(beginLogin).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ingresar y descartar cambios sin confirmar',
      }),
    );
    await settle();

    expect(abortedAtLogin).toBe(true);
    expect(beginLogin).toHaveBeenCalledOnce();
    pendingSave.resolve({
      version: 5,
      draft: { ...currentDraft, instructions: 'Enviada y pendiente al volver a ingresar' },
    });
    await settle();
    await advance(120_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(beginLogin).toHaveBeenCalledOnce();
  });

  it('allows normal re-entry without a discard prompt when no draft changes are pending', async () => {
    const { auth } = await mount({
      draftApi: {
        getDraft: vi
          .fn()
          .mockRejectedValue(new DraftApiFailure('authentication', 'Acceso rechazado', 401)),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Volver a ingresar' }));
    await settle();

    expect(auth.beginLogin).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', {
        name: 'Ingresar y descartar cambios sin confirmar',
      }),
    ).toBeNull();
  });

  it('does not schedule admission when Probar fails to confirm its snapshot and autosave later recovers', async () => {
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(new DraftApiFailure('rate_limited', 'Temporal', 429))
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft }));
    const createAttempt = vi
      .fn<AttemptApi['createAttempt']>()
      .mockReturnValue(new Promise<never>(() => undefined));
    const { auth, currentDraft } = await mount({
      draftApi: { putDraft },
      runnerApi: { createAttempt },
    });
    edit('Snapshot que requería guardado');
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    await settle();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(createAttempt).not.toHaveBeenCalled();
    await advance(60_000);

    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(createAttempt).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    await settle();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      5,
      { ...currentDraft, instructions: 'Snapshot que requería guardado' },
      true,
    );
  });
});
