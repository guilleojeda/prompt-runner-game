// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type RobotDraft, type SavedRobot } from '../../../shared/robot.js';
import { App } from './App.js';
import type { AuthClient, AuthConfig, AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi } from './attempt-api.js';
import type { DraftApi } from './draft-api.js';
import type { SavedRobotApi } from './saved-robot-api.js';

vi.mock('./replay/ReplayScene.js', () => ({ CoursePreview: () => null, ReplayScene: () => null }));

const config: AuthConfig = {
  issuer: 'https://issuer.example.test',
  clientId: 'client-public',
  domain: 'https://auth.example.test',
  redirectUri: 'https://game.example.test/jugar',
  logoutUri: 'https://game.example.test/',
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};

const initialDraft = {
  ...createDefaultDraft(),
  instructions: 'Borrador persistido antes de editar.',
};
const editedDraft: RobotDraft = {
  ...initialDraft,
  instructions: 'Último borrador ✨\nConservar los espacios finales.  ',
};

function session(): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  const sub = 'create-app-user';
  const email = `${sub}@example.test`;
  return {
    identity: { sub, email },
    user: new User({
      access_token: 'create-app-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: config.issuer,
        aud: config.clientId,
        iat: now,
        exp: now + 3_600,
        sub,
        email,
      },
      expires_at: now + 3_600,
    }),
  };
}

function robot(id: string, name: string, draft: RobotDraft, version: number): SavedRobot {
  return {
    id,
    name,
    version,
    createdAt: '2026-10-30T12:00:00.000Z',
    updatedAt: '2026-10-30T12:00:01.000Z',
    modelKey: draft.modelKey,
    draft,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function instructions(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>('#robot-instructions');
  if (!field) throw new Error('El editor real no está montado.');
  return field;
}

function navigate(surface: 'Preparar' | 'Mis robots'): void {
  const navigation = screen.getByRole('navigation', { name: 'Navegación principal' });
  const target = within(navigation).getByRole('button', { name: surface });
  if (target.getAttribute('aria-current') !== 'page') fireEvent.click(target);
}

async function mountApp(putDraft: DraftApi['putDraft']) {
  const getDraft = vi.fn<DraftApi['getDraft']>().mockResolvedValue({
    version: 4,
    draft: initialDraft,
  });
  const draftApi: DraftApi = { getDraft, putDraft };
  const saveRobot = vi
    .fn<SavedRobotApi['saveRobot']>()
    .mockImplementation(async (id, version, name, draft) => robot(id, name, draft, version + 1));
  const savedApi: SavedRobotApi = {
    listRobots: vi.fn().mockResolvedValue({ robots: [] }),
    getRobot: vi.fn(),
    saveRobot,
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
  };
  const authClient: AuthClient = {
    initialize: vi.fn().mockResolvedValue(session()),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  const attemptApi: AttemptApi = {
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
      day: '2026-10-30',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  };

  render(
    <App
      authClient={authClient}
      configLoader={async () => config}
      draftApi={draftApi}
      savedRobotApi={savedApi}
      attemptApi={attemptApi}
    />,
  );
  await screen.findByRole('navigation', { name: 'Navegación principal' });
  await waitFor(() => expect(instructions().value).toBe(initialDraft.instructions));
  return { draftApi, getDraft, savedApi, saveRobot, attemptApi };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('App create intent integration', () => {
  it('creates from the latest editor snapshot after its visible autosave is confirmed', async () => {
    window.sessionStorage.clear();

    const autosave = deferred<{ version: number; draft: RobotDraft }>();
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(autosave.promise)
      .mockImplementation(async (expectedVersion, draft) => ({
        version: expectedVersion + 1,
        draft,
      }));
    const { draftApi, getDraft, saveRobot, attemptApi } = await mountApp(putDraft);
    expect(instructions().value).toBe(initialDraft.instructions);

    fireEvent.change(instructions(), { target: { value: editedDraft.instructions } });
    await waitFor(() => expect(draftApi.putDraft).toHaveBeenCalledOnce());
    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.slice(0, 2)).toEqual([4, editedDraft]);

    navigate('Mis robots');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Guardar robot actual' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    const name = screen.getByRole('textbox', { name: 'Nombre para la nueva copia' });
    fireEvent.change(name, { target: { value: 'Copia del último borrador' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar una copia' }));
    expect(saveRobot).not.toHaveBeenCalled();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(instructions().value).toBe(editedDraft.instructions);

    autosave.resolve({ version: 5, draft: editedDraft });
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());

    expect(saveRobot).toHaveBeenCalledOnce();
    const [id, expectedVersion, savedName, snapshot] = saveRobot.mock.calls[0]!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/iu);
    expect([expectedVersion, savedName, snapshot]).toEqual([
      0,
      'Copia del último borrador',
      editedDraft,
    ]);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(getDraft).toHaveBeenCalledOnce();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(instructions().value).toBe(editedDraft.instructions);
    expect(
      screen
        .getByRole('navigation', { name: 'Navegación principal' })
        .querySelector('[aria-current="page"]')?.textContent,
    ).toBe('Mis robots');
  });

  it('cancels a library create that is waiting for the real editor autosave', async () => {
    const autosave = deferred<{ version: number; draft: RobotDraft }>();
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(autosave.promise)
      .mockImplementation(async (expectedVersion, draft) => ({
        version: expectedVersion + 1,
        draft,
      }));
    const { savedApi, attemptApi } = await mountApp(putDraft);

    fireEvent.change(instructions(), { target: { value: editedDraft.instructions } });
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce());
    navigate('Mis robots');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Guardar robot actual' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    const name = screen.getByRole('textbox', { name: 'Nombre para la nueva copia' });
    fireEvent.change(name, { target: { value: 'Copia cancelada antes del snapshot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar una copia' }));

    const cancel = screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement;
    expect.soft(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByLabelText('Nombre para la nueva copia')).toBeNull());
    navigate('Preparar');

    await act(async () => {
      autosave.resolve({ version: 5, draft: editedDraft });
      await autosave.promise;
    });
    await waitFor(() => expect(screen.getByText('Guardado')).toBeTruthy());

    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.slice(0, 2)).toEqual([4, editedDraft]);
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
    expect(instructions().value).toBe(editedDraft.instructions);
  });
});
