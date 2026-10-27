// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type RobotDraft, type SavedRobot } from '../../../shared/robot.js';
import { App } from './App.js';
import { type AuthClient, type AuthConfig, type AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type QuotaSummary } from './attempt-api.js';
import { type DraftApi } from './draft-api.js';
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
  email = 'a@example.com',
  expiresAt = Math.floor(Date.now() / 1000) + 600,
  accessToken = 'access-token',
  sub = 'subject-a',
): AuthSession {
  return {
    identity: { sub, email },
    user: new User({
      access_token: accessToken,
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      session_state: null,
      profile: {
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
        aud: 'client-public',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        sub,
        email,
      },
      expires_at: expiresAt,
    }),
  };
}

function authClient(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    initialize: vi.fn().mockResolvedValue(null),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function attemptApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('invalid', 'El doble detuvo la admisión.', 400)),
    getAttemptRequest: vi.fn(),
    getAttempt: vi.fn(),
    getConfiguration: vi.fn(),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 0 }),
    putAnimationPreference: vi
      .fn()
      .mockImplementation(async (animationEnabled, expectedVersion) => ({
        animationEnabled,
        version: expectedVersion + 1,
      })),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-09-21',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
    ...overrides,
  };
}

function draftApi(): DraftApi {
  return {
    getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
    putDraft: vi.fn(async (expectedVersion: number, draft: RobotDraft) => ({
      version: expectedVersion + 1,
      draft,
    })),
  };
}

function savedRobotApi(robot?: SavedRobot): SavedRobotApi {
  return {
    listRobots: vi.fn().mockResolvedValue({
      robots: robot
        ? [
            {
              id: robot.id,
              name: robot.name,
              version: robot.version,
              createdAt: robot.createdAt,
              updatedAt: robot.updatedAt,
              modelKey: robot.modelKey,
            },
          ]
        : [],
    }),
    getRobot: vi.fn(async () => {
      if (!robot) throw new Error('No se esperaba cargar una copia guardada.');
      return robot;
    }),
    saveRobot: vi.fn(),
    deleteRobot: vi.fn(),
  };
}

function renderApp(runner: AttemptApi, editorApi = draftApi(), copies = savedRobotApi()) {
  return render(
    <App
      authClient={authClient({ initialize: vi.fn().mockResolvedValue(session()) })}
      draftApi={editorApi}
      savedRobotApi={copies}
      attemptApi={runner}
      configLoader={async () => config}
    />,
  );
}

function navigate(surface: 'Preparar' | 'Historial' | 'Mis robots'): HTMLButtonElement {
  const navigation = screen.getByRole('navigation', { name: 'Navegación principal' });
  const destination = within(navigation).getByRole('button', {
    name: surface,
  }) as HTMLButtonElement;
  const current = destination.getAttribute('aria-current');
  if (!current || current === 'false') fireEvent.click(destination);
  return destination;
}

async function settlePreparationPromises(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe('preparation availability integration', () => {
  it('keeps editing, help, and saved copies available after a preference read fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const savedDraft = { ...createDefaultDraft(), instructions: 'Copia para usar mientras carga.' };
    const savedCopy: SavedRobot = {
      id: 'saved-copy-availability',
      name: 'Explorador disponible',
      version: 1,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      modelKey: savedDraft.modelKey,
      draft: savedDraft,
    };
    const getAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('server', 'No se pudo consultar la preferencia.', 500),
      )
      .mockResolvedValueOnce({ animationEnabled: false, version: 1 });
    const runner = attemptApi({ getAnimationPreference });
    const copies = savedRobotApi(savedCopy);
    const editorApi = draftApi();
    renderApp(runner, editorApi, copies);

    await settlePreparationPromises();
    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    const tryButton = screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
    const controls = screen.getByRole('group', { name: 'Controles de prueba y animación' });
    expect(screen.getAllByRole('group', { name: 'Controles de prueba y animación' })).toHaveLength(
      1,
    );
    expect(within(controls).getAllByRole('button', { name: 'Probar' })).toHaveLength(1);
    expect(tryButton.disabled).toBe(true);
    expect(instructions.readOnly).toBe(false);
    expect(instructions.matches(':disabled')).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole('button', { name: 'Guardar como nueva' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      screen.getByText(
        /^Estamos recuperando tu preferencia de animación\. Podés seguir preparando el robot\.?$/,
      ),
    ).toBeTruthy();

    const helpSummary = screen.getByText('Ayuda para empezar');
    fireEvent.click(helpSummary);
    expect((helpSummary.closest('details') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText('Qué recibe el agente')).toBeTruthy();

    expect(screen.queryByRole('button', { name: /Explorador disponible.*Cargar/ })).toBeNull();
    navigate('Mis robots');
    const loadCopy = screen.getByRole('button', {
      name: /Explorador disponible.*Cargar/,
    });
    expect((loadCopy as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(loadCopy);
    await settlePreparationPromises();
    expect(copies.getRobot).toHaveBeenCalledOnce();
    const navigation = screen.getByRole('navigation', { name: 'Navegación principal' });
    expect(
      within(navigation).getByRole('button', { name: 'Preparar' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByDisplayValue(savedDraft.instructions)).toBeTruthy();
    expect(runner.createAttempt).not.toHaveBeenCalled();

    expect(getAnimationPreference).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settlePreparationPromises();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    expect(tryButton.disabled).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(runner.createAttempt).not.toHaveBeenCalled();

    fireEvent.click(tryButton);
    await settlePreparationPromises();
    expect(runner.createAttempt).toHaveBeenCalledOnce();
    expect(runner.createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ instructions: savedDraft.instructions }),
      false,
    );
  });

  it('keeps the preparation editable while the initial preference read is pending', async () => {
    let finishPreference!: (value: { animationEnabled: boolean; version: number }) => void;
    const getAnimationPreference = vi.fn(
      () =>
        new Promise<{ animationEnabled: boolean; version: number }>((resolve) => {
          finishPreference = resolve;
        }),
    );
    const runner = attemptApi({ getAnimationPreference });
    renderApp(runner);

    const instructions = (await screen.findByLabelText(
      'Qué debe tener en cuenta el robot',
    )) as HTMLTextAreaElement;
    const tryButton = (await screen.findByRole('button', { name: 'Probar' })) as HTMLButtonElement;
    await waitFor(() => expect(getAnimationPreference).toHaveBeenCalledOnce());
    expect(tryButton.disabled).toBe(true);
    expect(instructions.readOnly).toBe(false);
    expect(instructions.matches(':disabled')).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement).disabled).toBe(
      false,
    );
    fireEvent.click(tryButton);
    expect(runner.createAttempt).not.toHaveBeenCalled();

    await act(async () => {
      finishPreference({ animationEnabled: false, version: 1 });
      await Promise.resolve();
    });
    await waitFor(() => expect(tryButton.disabled).toBe(false));
    expect(runner.createAttempt).not.toHaveBeenCalled();

    fireEvent.click(tryButton);
    await waitFor(() => expect(runner.createAttempt).toHaveBeenCalledOnce());
    expect(runner.createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      1,
      createDefaultDraft(),
      false,
    );
  });

  it('holds Probar until the selected animation value and any conflict are confirmed', async () => {
    let finishReadback!: (value: { animationEnabled: boolean; version: number }) => void;
    let finishResolution!: (value: { animationEnabled: boolean; version: number }) => void;
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 4 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReadback = resolve;
          }),
      );
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('conflict', 'Version conflict.', 409))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishResolution = resolve;
          }),
      );
    const runner = attemptApi({ getAnimationPreference, putAnimationPreference });
    const copies = savedRobotApi();
    renderApp(runner, draftApi(), copies);

    const tryButton = (await screen.findByRole('button', { name: 'Probar' })) as HTMLButtonElement;
    const instructions = (await screen.findByLabelText(
      'Qué debe tener en cuenta el robot',
    )) as HTMLTextAreaElement;
    const animation = screen.getByRole('checkbox', { name: 'Animación' });
    await waitFor(() => expect(tryButton.disabled).toBe(false));
    fireEvent.click(animation);
    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledOnce());
    await waitFor(() => expect(getAnimationPreference).toHaveBeenCalledTimes(2));
    expect(tryButton.disabled).toBe(true);
    expect(instructions.readOnly).toBe(false);
    expect(instructions.matches(':disabled')).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole('button', { name: 'Guardar como nueva' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(tryButton);
    expect(runner.createAttempt).not.toHaveBeenCalled();

    await act(async () => {
      finishReadback({ animationEnabled: true, version: 5 });
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Guardar mi selección' })).toBeTruthy();
    expect(tryButton.disabled).toBe(true);
    expect(instructions.readOnly).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(runner.createAttempt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar mi selección' }));
    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledTimes(2));
    expect(putAnimationPreference).toHaveBeenNthCalledWith(2, false, 5, expect.any(AbortSignal));
    expect(tryButton.disabled).toBe(true);
    await act(async () => {
      finishResolution({ animationEnabled: false, version: 6 });
      await Promise.resolve();
    });
    await waitFor(() => expect(tryButton.disabled).toBe(false));
    expect(runner.createAttempt).not.toHaveBeenCalled();

    fireEvent.click(tryButton);
    await waitFor(() => expect(runner.createAttempt).toHaveBeenCalledOnce());
    expect(runner.createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      1,
      createDefaultDraft(),
      false,
    );
  });

  it('waits for a matching readback after an uncertain preference write without starting by itself', async () => {
    let finishReadback!: (value: { animationEnabled: boolean; version: number }) => void;
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockImplementationOnce(
        () =>
          new Promise<{ animationEnabled: boolean; version: number }>((resolve) => {
            finishReadback = resolve;
          }),
      );
    const putAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(
        new AttemptApiFailure('network', 'Write response lost.', undefined, true),
      );
    const runner = attemptApi({ getAnimationPreference, putAnimationPreference });
    renderApp(runner);

    const tryButton = (await screen.findByRole('button', { name: 'Probar' })) as HTMLButtonElement;
    const instructions = (await screen.findByLabelText(
      'Qué debe tener en cuenta el robot',
    )) as HTMLTextAreaElement;
    const animation = screen.getByRole('checkbox', { name: 'Animación' });
    await waitFor(() => expect(tryButton.disabled).toBe(false));
    fireEvent.click(animation);
    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledOnce());
    await waitFor(() => expect(getAnimationPreference).toHaveBeenCalledTimes(2));
    expect(tryButton.disabled).toBe(true);
    expect(instructions.readOnly).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(runner.createAttempt).not.toHaveBeenCalled();

    await act(async () => {
      finishReadback({ animationEnabled: false, version: 1 });
      await Promise.resolve();
    });
    await waitFor(() => expect(tryButton.disabled).toBe(false));
    expect(runner.createAttempt).not.toHaveBeenCalled();

    fireEvent.click(tryButton);
    await waitFor(() => expect(runner.createAttempt).toHaveBeenCalledOnce());
    expect(runner.createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      1,
      createDefaultDraft(),
      false,
    );
  });

  it.each(['pending', 'network failure', '429 auxiliary response'] as const)(
    'allows an explicit attempt while auxiliary quota lookup is %s',
    async (quotaState) => {
      let finishQuota!: (value: QuotaSummary) => void;
      const getQuota =
        quotaState === 'pending'
          ? vi.fn(
              () =>
                new Promise<QuotaSummary>((resolve) => {
                  finishQuota = resolve;
                }),
            )
          : vi
              .fn()
              .mockRejectedValue(
                quotaState === 'network failure'
                  ? new AttemptApiFailure('network', 'Quota network failure.')
                  : new AttemptApiFailure('attempt_unavailable', 'Rate limited.', 429),
              );
      const createAttempt = vi
        .fn()
        .mockRejectedValue(new AttemptApiFailure('quota_exceeded', 'No quedan partidas.', 429));
      const listAttempts = vi.fn().mockResolvedValue({ attempts: [] });
      const runner = attemptApi({ getQuota, listAttempts, createAttempt });
      renderApp(runner);

      const tryButton = (await screen.findByRole('button', {
        name: 'Probar',
      })) as HTMLButtonElement;
      await screen.findByText(/^Disponibilidad sin confirmar\. La comprobamos al iniciar\.?$/);
      await waitFor(() => expect(listAttempts).toHaveBeenCalledTimes(2));
      expect(tryButton.disabled).toBe(false);
      expect(screen.queryByLabelText(/Cuota: 0 de/)).toBeNull();

      fireEvent.click(tryButton);
      await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());
      expect(createAttempt).toHaveBeenCalledWith(expect.any(String), 1, createDefaultDraft(), true);
      expect(await screen.findByText('No quedan partidas.')).toBeTruthy();

      if (quotaState === 'pending') {
        await act(async () => {
          finishQuota({
            day: '2026-09-21',
            used: 0,
            limit: 100,
            remaining: 100,
            resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          });
          await Promise.resolve();
        });
      }
      expect(createAttempt).toHaveBeenCalledOnce();
    },
  );

  it('blocks only Probar when the server confirms that quota is zero', async () => {
    const runner = attemptApi({
      getQuota: vi.fn().mockResolvedValue({
        day: '2026-09-21',
        used: 100,
        limit: 100,
        remaining: 0,
        resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    });
    const copies = savedRobotApi();
    renderApp(runner, draftApi(), copies);

    const tryButton = (await screen.findByRole('button', { name: 'Probar' })) as HTMLButtonElement;
    expect(await screen.findByText(/^No quedan partidas disponibles\.?$/)).toBeTruthy();
    expect(tryButton.disabled).toBe(true);
    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    expect(instructions.readOnly).toBe(false);
    expect(instructions.matches(':disabled')).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole('button', { name: 'Guardar como nueva' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(runner.createAttempt).not.toHaveBeenCalled();
  });

  it('lets the user make an explicit attempt after a zero balance expires and its refresh fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    const createAttempt = vi
      .fn()
      .mockRejectedValue(
        new AttemptApiFailure('attempt_unavailable', 'No se puede iniciar por ahora.', 429),
      );
    const getQuota = vi
      .fn()
      .mockResolvedValueOnce({
        day: '2026-10-26',
        used: 100,
        limit: 100,
        remaining: 0,
        resetsAt,
      })
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Quota refresh unavailable.'))
      .mockResolvedValue({
        day: '2026-10-27',
        used: 0,
        limit: 100,
        remaining: 100,
        resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [] });
    const runner = attemptApi({ createAttempt, getQuota, listAttempts });
    renderApp(runner);

    await settlePreparationPromises();
    const tryButton = screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
    expect(tryButton.disabled).toBe(true);
    expect(screen.getByText(/^No quedan partidas disponibles\.?$/)).toBeTruthy();
    expect(getQuota).toHaveBeenCalledOnce();
    expect(createAttempt).not.toHaveBeenCalled();
    const historyCallsBeforeExpiry = listAttempts.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await settlePreparationPromises();
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(tryButton.disabled).toBe(false);
    expect(
      screen.getByText(/^Disponibilidad sin confirmar\. La comprobamos al iniciar\.?$/),
    ).toBeTruthy();
    expect(screen.queryByText(/^No quedan partidas disponibles\.?$/)).toBeNull();
    expect(screen.getByLabelText(/0 de 100 intentos disponibles/i).textContent).toMatch(
      /anterior|previa|no confirmada/i,
    );
    expect(createAttempt).not.toHaveBeenCalled();
    expect(listAttempts).toHaveBeenCalledTimes(historyCallsBeforeExpiry);

    fireEvent.click(tryButton);
    await settlePreparationPromises();
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No se puede iniciar por ahora.')).toBeTruthy();
  });
});
