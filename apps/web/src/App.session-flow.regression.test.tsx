// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot.js';
import { App } from './App.js';
import type { AuthClient, AuthConfig, AuthSession } from './auth.js';
import type { DraftApi } from './draft-api.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';
import type { AttemptApi } from './attempt-api.js';

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

function session(options: { expiresInSeconds?: number; accessToken?: string } = {}): AuthSession {
  const sub = 'phase6-session-flow';
  const email = 'player@example.com';
  const expiresAt = Date.now() / 1000 + (options.expiresInSeconds ?? 3_600);
  return {
    identity: { sub, email },
    user: new User({
      access_token: options.accessToken ?? 'access-token',
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

function runnerApi(): AttemptApi {
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
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
  };
}

function savedRobotApi(listRobots: SavedRobotApi['listRobots']): SavedRobotApi {
  return {
    listRobots,
    getRobot: vi.fn(),
    saveRobot: vi.fn(),
    deleteRobot: vi.fn(),
  };
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

describe('App session and draft transitions', () => {
  it('does not restore a renewed session after confirmed re-entry invalidates renewal', async () => {
    const renewalPending = deferred<AuthSession | null>();
    const loginPending = deferred<void>();
    const listPending = deferred<Awaited<ReturnType<SavedRobotApi['listRobots']>>>();
    const savePending = deferred<DraftSnapshot>();
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(savePending.promise);
    const beginLogin = vi.fn(() => loginPending.promise);
    const auth: AuthClient = {
      initialize: vi
        .fn()
        .mockResolvedValueOnce(session({ expiresInSeconds: 5 }))
        .mockReturnValueOnce(renewalPending.promise),
      beginLogin,
      logout: vi.fn().mockResolvedValue(undefined),
    };
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({
        version: 4,
        draft: { ...createDefaultDraft(), instructions: 'Base confirmada' },
      }),
      putDraft,
    };
    const listRobots = vi.fn<SavedRobotApi['listRobots']>().mockReturnValue(listPending.promise);
    const savedApi = savedRobotApi(listRobots);
    render(
      <App
        authClient={auth}
        draftApi={draftApi}
        savedRobotApi={savedApi}
        attemptApi={runnerApi()}
        configLoader={async () => config}
      />,
    );
    await settle();
    expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    const field = screen.getByRole('textbox', {
      name: 'Qué debe tener en cuenta el robot',
    }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Edición que el acceso rechazó' } });
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Mis robots' }));
    await settle();
    expect(listRobots).toHaveBeenCalledOnce();
    expect(auth.initialize).toHaveBeenCalledOnce();
    listPending.reject(new SavedRobotApiFailure('authentication', 'Acceso rechazado', 401));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Preparar' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();

    await advance(4_400);
    expect(auth.initialize).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Volver a ingresar' }));
    await settle();
    expect(beginLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Volver a ingresar' }));
    await settle();
    fireEvent.click(
      screen.getByRole('button', { name: 'Ingresar y descartar cambios sin confirmar' }),
    );
    await settle();

    expect(beginLogin).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(field.value).toBe('Base confirmada');
    expect(screen.getByRole('button', { name: 'Abriendo acceso…' })).toBeTruthy();

    renewalPending.resolve(session({ accessToken: 'renewed-access-token' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Abriendo acceso…' })).toBeTruthy();
    expect(field.readOnly).toBe(true);
    expect(screen.queryByText('Tu cuenta está confirmada y la sesión es válida.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();

    savePending.resolve({
      version: 5,
      draft: { ...createDefaultDraft(), instructions: 'Edición que el acceso rechazó' },
    });
    await advance(1_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(field.value).toBe('Base confirmada');

    fireEvent.click(screen.getByRole('button', { name: 'Cuenta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();

    loginPending.reject(new Error('late login failure'));
    await settle();
    expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(screen.queryByText('No se pudo completar la operación. Intentá de nuevo.')).toBeNull();
    expect(putDraft).toHaveBeenCalledOnce();
  });
});
