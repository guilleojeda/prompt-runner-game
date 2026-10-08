// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AuthFailure, type AuthClient, type AuthConfig, type AuthSession } from './auth.js';
import { DraftApiClient, type DraftApi } from './draft-api.js';
import type { SavedRobotApi } from './saved-robot-api.js';
import { AttemptApiFailure, type AttemptApi, type AttemptSummary } from './attempt-api.js';
import {
  CognitoPendingConfirmationClient,
  type PendingConfirmationClient,
} from './pending-confirmation.js';
import {
  createDefaultDraft,
  ROBOT_CATALOG_VERSION,
  ROBOT_SCHEMA_VERSION,
  type DraftSnapshot,
  type SavedRobot,
} from '../../../shared/robot.js';
import { createClosedAttemptRecordFixture } from '../../../shared/attempt.fixture.js';
import { LEVEL } from '../../../shared/game.js';
import type { ReplayRecordView } from '../../../shared/attempt.js';

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

const invalidConfirmationConfig: AuthConfig = {
  ...config,
  issuer: 'https://invalid.example/us-east-1_test',
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

function client(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    initialize: vi.fn().mockResolvedValue(null),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function emptyAttemptApi(): AttemptApi {
  return {
    createAttempt: vi.fn(),
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
      resetsAt: '2026-09-22T03:00:00.000Z',
    }),
  };
}

function replayRecord(id: string): ReplayRecordView {
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
    closure: source.closure,
    metrics: source.metrics,
    score: source.score,
  };
}

function setCurrentRecovery(storageKey: string, serializedReference: string): void {
  let value: unknown;
  try {
    value = JSON.parse(serializedReference);
  } catch {
    window.sessionStorage.setItem(storageKey, serializedReference);
    return;
  }
  if (storageKey === 'prompt-runner:attempt-recovery' && value && typeof value === 'object') {
    value = {
      ...value,
      draftContract: {
        schemaVersion: ROBOT_SCHEMA_VERSION,
        catalogVersion: ROBOT_CATALOG_VERSION,
      },
    };
  }
  window.sessionStorage.setItem(storageKey, JSON.stringify(value));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flushAuthMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

describe('access screen', () => {
  it('keeps the guest brand linked to the Robot Runner home page', async () => {
    render(<App authClient={client()} />);

    const homeLink = await screen.findByRole('link', { name: 'Acerca de Robot Runner' });
    expect(homeLink.getAttribute('href')).toBe('/');
  });

  it('places the static course preview before the editor without starting an inference', async () => {
    const createAttempt = vi.fn();
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn(),
    };
    const savedRobotApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    const attemptApi = { ...emptyAttemptApi(), createAttempt };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        savedRobotApi={savedRobotApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    const preview = await screen.findByRole('heading', { name: 'Vista completa del terreno' });
    const editor = await screen.findByRole('heading', { name: 'Prepará tu robot' });
    expect(preview.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
    expect(attemptApi.getReplay).not.toHaveBeenCalled();
  });

  it('keeps the editor control bar mounted when the draft arrives after attempt data', async () => {
    let releaseDraft!: (snapshot: DraftSnapshot) => void;
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn(
        () =>
          new Promise<DraftSnapshot>((resolve) => {
            releaseDraft = resolve;
          }),
      ),
      putDraft: vi.fn(),
    };
    const attemptApi = emptyAttemptApi();
    const savedRobotApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        savedRobotApi={savedRobotApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    const controls = await waitFor(() => {
      const host = document.querySelector('#attempt-controls-slot');
      if (!host) throw new Error('Todavía no existe el pie del editor.');
      return host as HTMLElement;
    });
    expect(within(controls).getByRole('checkbox', { name: 'Animación' })).toBeTruthy();
    const tryButton = within(controls).getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
    expect(tryButton.disabled).toBe(true);

    await screen.findByText('Todavía no hay intentos guardados.');
    await within(controls).findByText('de 100 intentos disponibles');
    await within(controls).findByText('El resultado aparece después de la reproducción.');
    expect(document.querySelector('#attempt-controls-slot')).toBe(controls);
    expect(controls.isConnected).toBe(true);
    expect(within(controls).getByRole('checkbox', { name: 'Animación' })).toBeTruthy();
    expect(tryButton.disabled).toBe(true);

    releaseDraft({ version: 0, draft: createDefaultDraft() });
    await waitFor(() => expect(tryButton.disabled).toBe(false));
  });

  it('keeps saved-copy actions unavailable until the editor configuration loads', async () => {
    const savedDraft = { ...createDefaultDraft(), instructions: 'Configuración guardada.' };
    const savedCopy: SavedRobot = {
      id: 'saved-copy',
      name: 'Explorador guardado',
      version: 1,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      modelKey: savedDraft.modelKey,
      draft: savedDraft,
    };
    const getDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error('No se pudo cargar.'))
      .mockResolvedValueOnce({ version: 0, draft: createDefaultDraft() });
    const draftApi: DraftApi = { getDraft, putDraft: vi.fn() };
    const listRobots = vi
      .fn()
      .mockRejectedValueOnce(new Error('No se pudo cargar la lista.'))
      .mockResolvedValueOnce({
        robots: [
          {
            id: savedCopy.id,
            name: savedCopy.name,
            version: savedCopy.version,
            createdAt: savedCopy.createdAt,
            updatedAt: savedCopy.updatedAt,
            modelKey: savedCopy.modelKey,
          },
        ],
      });
    const savedRobotApi: SavedRobotApi = {
      listRobots,
      getRobot: vi.fn().mockResolvedValue(savedCopy),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    render(
      <App
        authClient={client({ initialize: vi.fn().mockResolvedValue(session()) })}
        draftApi={draftApi}
        savedRobotApi={savedRobotApi}
        attemptApi={emptyAttemptApi()}
        configLoader={async () => config}
      />,
    );

    const savedSection = (await screen.findByRole('heading', { name: 'Tus robots' })).closest(
      'section',
    ) as HTMLElement;
    const retryList = await within(savedSection).findByRole('button', {
      name: 'Reintentar lista',
    });
    await waitFor(() => expect((retryList as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retryList);
    const copyButton = await within(savedSection).findByRole('button', {
      name: /Explorador guardado.*Cargar/,
    });
    const createButton = within(savedSection).getByRole('button', {
      name: 'Guardar como nueva',
    }) as HTMLButtonElement;
    expect((copyButton as HTMLButtonElement).disabled).toBe(true);
    expect(createButton.disabled).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar carga' }));
    await screen.findByDisplayValue(createDefaultDraft().instructions);
    await waitFor(() => {
      expect((copyButton as HTMLButtonElement).disabled).toBe(false);
      expect(createButton.disabled).toBe(false);
    });
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(listRobots).toHaveBeenCalledTimes(2);
  });

  it('preserves an edit made during a saved-copy load and applies it after an explicit retry', async () => {
    const loadedDraft = { ...createDefaultDraft(), instructions: 'Copia guardada.' };
    const localDraft = { ...createDefaultDraft(), instructions: 'Edición posterior.' };
    const savedCopy: SavedRobot = {
      id: 'saved-copy-late',
      name: 'Explorador tardío',
      version: 1,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      modelKey: loadedDraft.modelKey,
      draft: loadedDraft,
    };
    let resolveRobot!: (robot: SavedRobot) => void;
    const getRobot = vi.fn().mockReturnValue(
      new Promise<SavedRobot>((resolve) => {
        resolveRobot = resolve;
      }),
    );
    const putDraft = vi
      .fn()
      .mockImplementation(async (version: number, draft: typeof localDraft) => ({
        version: version + 1,
        draft,
      }));
    const savedRobotApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({
        robots: [
          {
            id: savedCopy.id,
            name: savedCopy.name,
            version: savedCopy.version,
            createdAt: savedCopy.createdAt,
            updatedAt: savedCopy.updatedAt,
            modelKey: savedCopy.modelKey,
          },
        ],
      }),
      getRobot,
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft,
    };
    render(
      <App
        authClient={client({ initialize: vi.fn().mockResolvedValue(session()) })}
        draftApi={draftApi}
        savedRobotApi={savedRobotApi}
        attemptApi={emptyAttemptApi()}
        configLoader={async () => config}
      />,
    );

    const instructions = await screen.findByLabelText('Qué debe tener en cuenta el robot');
    await waitFor(() =>
      expect((instructions.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false),
    );
    const copyButton = await screen.findByRole('button', {
      name: /Explorador tardío.*Cargar/,
    });
    await waitFor(() => expect((copyButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(copyButton);
    await waitFor(() => expect(getRobot).toHaveBeenCalledOnce());
    fireEvent.change(instructions, { target: { value: localDraft.instructions } });
    await act(async () => {
      resolveRobot(savedCopy);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByDisplayValue(localDraft.instructions)).toBeTruthy());
    expect(screen.queryByDisplayValue(loadedDraft.instructions)).toBeNull();
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(putDraft.mock.calls[0]?.[1]).toMatchObject({ instructions: localDraft.instructions });
    expect(putDraft.mock.calls[0]?.[1]).not.toMatchObject({
      instructions: loadedDraft.instructions,
    });
    expect(screen.queryByText(`Cargaste «${savedCopy.name}».`)).toBeNull();

    getRobot.mockResolvedValueOnce(savedCopy);
    fireEvent.click(copyButton);
    await waitFor(() => expect(screen.getByDisplayValue(loadedDraft.instructions)).toBeTruthy());
    expect(await screen.findByText(`Cargaste «${savedCopy.name}».`)).toBeTruthy();
  });

  it('rejects a saved-copy response that arrives after Probar starts', async () => {
    const loadedDraft = { ...createDefaultDraft(), instructions: 'No debe entrar.' };
    const savedCopy: SavedRobot = {
      id: 'saved-copy-locked',
      name: 'Explorador bloqueado',
      version: 1,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      modelKey: loadedDraft.modelKey,
      draft: loadedDraft,
    };
    let resolveRobot!: (robot: SavedRobot) => void;
    const getRobot = vi.fn().mockReturnValue(
      new Promise<SavedRobot>((resolve) => {
        resolveRobot = resolve;
      }),
    );
    const createAttempt = vi.fn(() => new Promise<never>(() => undefined));
    const putDraft = vi.fn().mockImplementation(async (version: number, draft) => ({
      version: version + 1,
      draft,
    }));
    const savedRobotApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({
        robots: [
          {
            id: savedCopy.id,
            name: savedCopy.name,
            version: savedCopy.version,
            createdAt: savedCopy.createdAt,
            updatedAt: savedCopy.updatedAt,
            modelKey: savedCopy.modelKey,
          },
        ],
      }),
      getRobot,
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft,
    };
    render(
      <App
        authClient={client({ initialize: vi.fn().mockResolvedValue(session()) })}
        draftApi={draftApi}
        savedRobotApi={savedRobotApi}
        attemptApi={{ ...emptyAttemptApi(), createAttempt }}
        configLoader={async () => config}
      />,
    );

    const instructions = await screen.findByLabelText('Qué debe tener en cuenta el robot');
    fireEvent.click(await screen.findByRole('button', { name: /Explorador bloqueado.*Cargar/ }));
    const tryButton = await screen.findByRole('button', { name: 'Probar' });
    await waitFor(() => expect((tryButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(tryButton);
    await waitFor(() =>
      expect((instructions.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true),
    );
    expect(createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.objectContaining({ instructions: createDefaultDraft().instructions }),
      true,
    );

    await act(async () => {
      resolveRobot(savedCopy);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByDisplayValue(createDefaultDraft().instructions)).toBeTruthy(),
    );
    expect(screen.queryByDisplayValue(loadedDraft.instructions)).toBeNull();
    expect(
      putDraft.mock.calls.every((call) => call[1]?.instructions !== loadedDraft.instructions),
    ).toBe(true);
  });

  it('does not persist an admission marker before the draft snapshot is saved', async () => {
    window.sessionStorage.clear();
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValue(new Promise<DraftSnapshot>(() => undefined));
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft,
    };
    const savedRobotApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    const createAttempt = vi.fn();
    const attemptApi = { ...emptyAttemptApi(), createAttempt };
    const first = render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        savedRobotApi={savedRobotApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    const instructions = await screen.findByLabelText('Qué debe tener en cuenta el robot');
    const tryButton = await screen.findByRole('button', { name: 'Probar' });
    await waitFor(() => expect((tryButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(instructions, { target: { value: 'Edición antes de recargar' } });
    fireEvent.click(tryButton);
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce());
    expect(createAttempt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();

    first.unmount();
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        savedRobotApi={savedRobotApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    await screen.findByText('Todavía no hay intentos guardados.');
    const reloadedTryButton = await screen.findByRole('button', { name: 'Probar' });
    await waitFor(() => expect((reloadedTryButton as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Comprobar estado' })).toBeNull();
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('previews history while the editor load fails, then applies the snapshot after retry', async () => {
    const sourceSummary: AttemptSummary = {
      id: 'attempt-editor-retry',
      createdAt: '2026-09-21T12:00:00.000Z',
      updatedAt: '2026-09-21T12:00:01.000Z',
      status: 'victory',
      cancelRequested: false,
      levelId: LEVEL.id,
      modelKey: 'claude-sonnet-4.6',
      modelLabel: 'Claude Sonnet 4.6',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      turnsUsed: 8,
      maxTurns: LEVEL.maxTurns,
      calls: 8,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      gameTokens: 700,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      score: 100,
      collectedObjectIds: [],
      objectPoints: 0,
      progress: 1,
      finalSupport: LEVEL.exit.support,
      animationEnabled: false,
      presentationComplete: true,
      recordComplete: true,
    };
    const recovered = { ...createDefaultDraft(), instructions: 'Recuperada desde el historial' };
    const getDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error('No se pudo cargar el borrador.'))
      .mockResolvedValueOnce({ version: 0, draft: createDefaultDraft() });
    const draftApi: DraftApi = { getDraft, putDraft: vi.fn() };
    const attemptApi: AttemptApi = {
      ...emptyAttemptApi(),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [sourceSummary] }),
      getConfiguration: vi
        .fn()
        .mockResolvedValue({ attemptId: sourceSummary.id, draft: recovered }),
    };
    render(
      <App
        authClient={client({ initialize: vi.fn().mockResolvedValue(session()) })}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    const history = await screen.findByRole('heading', { name: 'Historial' });
    const openConfiguration = () =>
      fireEvent.click(
        within(history.closest('section') as HTMLElement).getAllByRole('button', {
          name: 'Ver configuración',
        })[0]!,
      );
    openConfiguration();
    expect(await screen.findByText('Recuperada desde el historial')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Usar esta configuración' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(attemptApi.getConfiguration).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Cerrar' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();

    openConfiguration();
    expect(await screen.findByText('Recuperada desde el historial')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar carga' }));
    await screen.findByDisplayValue(createDefaultDraft().instructions);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Usar esta configuración' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));
    expect(await screen.findByDisplayValue('Recuperada desde el historial')).toBeTruthy();
    expect(
      await screen.findByText(
        'Configuración cargada en el editor. Se guarda como una edición normal.',
      ),
    ).toBeTruthy();
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('keeps the logout label while the signed-in account loads its attempts', async () => {
    window.sessionStorage.clear();
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn(),
    };
    const attemptApi = {
      ...emptyAttemptApi(),
      listAttempts: vi.fn(() => new Promise<never>(() => undefined)),
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    await screen.findByText('Recuperando tus intentos…');
    const logoutButton = screen.getByRole('button', { name: 'Cerrar sesión' });
    expect(logoutButton.textContent).toBe('Cerrar sesión');
    await waitFor(() => expect((logoutButton as HTMLButtonElement).disabled).toBe(true));
    expect(authClient.logout).not.toHaveBeenCalled();
  });

  it('does not remain loading when StrictMode runs the effect twice', async () => {
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });

    render(
      <StrictMode>
        <App authClient={authClient} />
      </StrictMode>,
    );

    expect(await screen.findByText('a@example.com')).toBeTruthy();
    expect(authClient.initialize).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows a visitor and starts managed access from the visible button', async () => {
    const beginLogin = vi.fn().mockResolvedValue(undefined);
    const authClient = client({ beginLogin });
    render(<App authClient={authClient} />);

    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Entrar o crear una cuenta' }));
    await waitFor(() => expect(beginLogin).toHaveBeenCalledOnce());
  });

  it('confirms a pending account with an already received code before any resend', async () => {
    const authClient = client();
    const confirmationClient: PendingConfirmationClient = {
      confirm: vi.fn().mockResolvedValue(undefined),
      resend: vi.fn().mockResolvedValue(undefined),
    };
    render(<App authClient={authClient} confirmationClient={confirmationClient} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar una cuenta pendiente' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'pending@example.com' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Código de confirmación' }), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar email' }));

    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(confirmationClient.confirm).toHaveBeenCalledWith('pending@example.com', '123456');
    expect(confirmationClient.resend).not.toHaveBeenCalled();
    expect(authClient.beginLogin).not.toHaveBeenCalled();
    expect(screen.queryByText('Cuenta confirmada')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
    expect(screen.getByText('Email confirmado. Ahora ingresá para continuar.')).toBeTruthy();
  });

  it('clears resend success before a failed confirmation and shows operation-specific busy text', async () => {
    let releaseResend!: () => void;
    const confirmationClient: PendingConfirmationClient = {
      confirm: vi.fn().mockRejectedValue(new Error('código inválido')),
      resend: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseResend = resolve;
          }),
      ),
    };
    render(<App authClient={client()} confirmationClient={confirmationClient} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar una cuenta pendiente' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'pending@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar código' }));
    expect(await screen.findByRole('button', { name: 'Reenviando…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirmar email' })).toBeTruthy();
    releaseResend();
    expect(
      await screen.findByText(
        'Te enviamos un nuevo código. Usá ese código para confirmar tu email.',
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Código de confirmación' }), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar email' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No se pudo completar la confirmación',
    );
    expect(
      screen.queryByText('Te enviamos un nuevo código. Usá ese código para confirmar tu email.'),
    ).toBeNull();
  });

  it.each(['CodeDeliveryFailureException', 'LimitExceededException', 'TooManyRequestsException'])(
    'keeps confirmation pending and recovers after resend %s',
    async (error) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ __type: error }), { status: 400 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const authClient = client();
      const confirmationClient = new CognitoPendingConfirmationClient(config, { fetch: fetchImpl });
      render(<App authClient={authClient} confirmationClient={confirmationClient} />);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Confirmar una cuenta pendiente' }),
      );
      fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
        target: { value: 'pending@example.com' },
      });
      const sentMessage = 'Te enviamos un nuevo código. Usá ese código para confirmar tu email.';
      fireEvent.click(screen.getByRole('button', { name: 'Reenviar código' }));
      expect(await screen.findByText(sentMessage)).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Reenviar código' }));
      expect((await screen.findByRole('alert')).textContent).toContain(
        error === 'CodeDeliveryFailureException'
          ? 'No se pudo completar la confirmación'
          : 'Se alcanzó un límite de reenvío',
      );
      expect(screen.queryByText(sentMessage)).toBeNull();
      expect(screen.getByRole('heading', { name: 'Retomá tu cuenta' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
      expect(authClient.beginLogin).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Reenviar código' }));
      expect(await screen.findByText(sentMessage)).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.change(screen.getByRole('textbox', { name: 'Código de confirmación' }), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Confirmar email' }));
      expect(
        await screen.findByText('Email confirmado. Ahora ingresá para continuar.'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
      expect(authClient.beginLogin).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    },
  );

  it('keeps a remote logout failure without rendering the prior identity', async () => {
    const authClient = client({
      initialize: vi.fn().mockResolvedValue(session()),
      logout: vi
        .fn()
        .mockRejectedValue(
          new AuthFailure(
            'logout',
            'Se cerró la sesión local, pero no se pudo completar el cierre remoto.',
          ),
        ),
    });
    render(<App authClient={authClient} />);

    await screen.findByText('a@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'no se pudo completar el cierre remoto',
    );
    expect(screen.queryByText('a@example.com')).toBeNull();
    expect(screen.getByRole('button', { name: 'Completar cierre remoto' })).toBeTruthy();
  });

  it.each(['resolved', 'remote-failure'] as const)(
    'ignores a late successful renewal after logout %s',
    async (logoutOutcome) => {
      vi.useFakeTimers();
      window.sessionStorage.clear();
      const initial = session('a@example.com', (Date.now() + 5_000) / 1000);
      let resolveRenewal!: (value: AuthSession) => void;
      const initialize = vi
        .fn<() => Promise<AuthSession | null>>()
        .mockResolvedValueOnce(initial)
        .mockImplementationOnce(
          () =>
            new Promise<AuthSession>((resolve) => {
              resolveRenewal = resolve;
            }),
        );
      const logoutMessage = 'Se cerró la sesión local, pero no se pudo completar el cierre remoto.';
      const logout =
        logoutOutcome === 'resolved'
          ? vi.fn().mockResolvedValue(undefined)
          : vi.fn().mockRejectedValue(new AuthFailure('logout', logoutMessage));
      const authClient = client({ initialize, logout });
      const draftApi: DraftApi = {
        getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
        putDraft: vi.fn().mockReturnValue(new Promise<never>(() => undefined)),
      };
      render(
        <App
          authClient={authClient}
          draftApi={draftApi}
          attemptApi={emptyAttemptApi()}
          configLoader={async () => config}
        />,
      );

      await act(flushAuthMicrotasks);
      expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
        target: { value: 'Cambio ficticio pendiente' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
      expect(screen.getByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await flushAuthMicrotasks();
      });
      expect(initialize).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('heading', { name: 'Comprobando tu sesión…' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Descartar cambios locales y salir' }));
      await act(flushAuthMicrotasks);
      expect(logout).toHaveBeenCalledOnce();
      if (logoutOutcome === 'resolved') {
        expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
      } else {
        expect(screen.getByText(logoutMessage)).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Sesión confirmada' })).toBeNull();
      }

      await act(async () => {
        resolveRenewal(session('a@example.com', (Date.now() + 600_000) / 1000));
        await flushAuthMicrotasks();
      });

      if (logoutOutcome === 'resolved') {
        expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
      } else {
        expect(screen.getByText(logoutMessage)).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Sesión confirmada' })).toBeNull();
      }
      expect(logout).toHaveBeenCalledOnce();
    },
  );

  it('ignores a late renewal failure after logout without replacing the remote logout error', async () => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    const initial = session('a@example.com', (Date.now() + 5_000) / 1000);
    let rejectRenewal!: (error: unknown) => void;
    const initialize = vi
      .fn<() => Promise<AuthSession | null>>()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise<AuthSession>((_resolve, reject) => {
            rejectRenewal = reject;
          }),
      );
    const logoutMessage = 'Se cerró la sesión local, pero no se pudo completar el cierre remoto.';
    const authClient = client({
      initialize,
      logout: vi.fn().mockRejectedValue(new AuthFailure('logout', logoutMessage)),
    });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockReturnValue(new Promise<never>(() => undefined)),
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={emptyAttemptApi()}
        configLoader={async () => config}
      />,
    );

    await act(flushAuthMicrotasks);
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Cambio ficticio pendiente' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await flushAuthMicrotasks();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Descartar cambios locales y salir' }));
    await act(flushAuthMicrotasks);
    expect(screen.getByText(logoutMessage)).toBeTruthy();

    await act(async () => {
      rejectRenewal(new AuthFailure('network', 'Error tardío de renovación.'));
      await flushAuthMicrotasks();
    });

    expect(screen.getByText(logoutMessage)).toBeTruthy();
    expect(screen.queryByText('Error tardío de renovación.')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sesión confirmada' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Completar cierre remoto' })).toBeTruthy();
  });

  it.each(['resolved', 'rejected'] as const)(
    'ignores a late session restoration after logout when it is %s',
    async (restoreOutcome) => {
      vi.useFakeTimers();
      window.sessionStorage.clear();
      const initial = session('a@example.com', (Date.now() + 5_000) / 1000);
      let resolveRestore!: (value: AuthSession) => void;
      let rejectRestore!: (error: unknown) => void;
      const initialize = vi
        .fn<() => Promise<AuthSession | null>>()
        .mockResolvedValueOnce(initial)
        .mockRejectedValueOnce(new AuthFailure('network', 'No se pudo renovar la sesión.'))
        .mockImplementationOnce(
          () =>
            new Promise<AuthSession>((resolve, reject) => {
              resolveRestore = resolve;
              rejectRestore = reject;
            }),
        );
      const logout = vi.fn().mockResolvedValue(undefined);
      const authClient = client({ initialize, logout });
      const draftApi: DraftApi = {
        getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
        putDraft: vi.fn().mockReturnValue(new Promise<never>(() => undefined)),
      };
      render(
        <App
          authClient={authClient}
          draftApi={draftApi}
          attemptApi={emptyAttemptApi()}
          configLoader={async () => config}
        />,
      );

      await act(flushAuthMicrotasks);
      expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
        target: { value: 'Cambio ficticio pendiente' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await flushAuthMicrotasks();
      });
      expect(screen.getByRole('button', { name: 'Revalidar sesión' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Revalidar sesión' }));
      await act(flushAuthMicrotasks);
      expect(initialize).toHaveBeenCalledTimes(3);
      fireEvent.click(screen.getByRole('button', { name: 'Descartar cambios locales y salir' }));
      await act(flushAuthMicrotasks);
      expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
      expect(logout).toHaveBeenCalledOnce();

      await act(async () => {
        if (restoreOutcome === 'resolved') {
          resolveRestore(session('a@example.com', (Date.now() + 600_000) / 1000));
        } else {
          rejectRestore(new AuthFailure('network', 'Error tardío de revalidación.'));
        }
        await flushAuthMicrotasks();
      });

      expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Sesión confirmada' })).toBeNull();
      expect(screen.queryByText('Error tardío de revalidación.')).toBeNull();
      expect(logout).toHaveBeenCalledOnce();
    },
  );

  it('keeps a pending renewal valid when Esperar guardado is clicked while paused', async () => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    const initial = session('a@example.com', (Date.now() + 5_000) / 1000, 'old-token');
    const renewed = session('a@example.com', (Date.now() + 600_000) / 1000, 'new-token');
    let resolveRenewal!: (value: AuthSession) => void;
    const initialize = vi
      .fn<() => Promise<AuthSession | null>>()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise<AuthSession>((resolve) => {
            resolveRenewal = resolve;
          }),
      );
    let resolvePut!: (snapshot: DraftSnapshot) => void;
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(
      new Promise<DraftSnapshot>((resolve) => {
        resolvePut = resolve;
      }),
    );
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft,
    };
    const logout = vi.fn().mockResolvedValue(undefined);
    const authClient = client({ initialize, logout });
    const instructions = 'Guardar antes de salir tras renovar';
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={emptyAttemptApi()}
        configLoader={async () => config}
      />,
    );

    await act(flushAuthMicrotasks);
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: instructions },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(screen.getByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(600);
      await flushAuthMicrotasks();
    });
    expect(putDraft).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(4_400);
      await flushAuthMicrotasks();
    });
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Comprobando tu sesión…' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Esperar guardado' }));
    await act(flushAuthMicrotasks);
    expect(screen.getByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();

    await act(async () => {
      resolveRenewal(renewed);
      await flushAuthMicrotasks();
    });
    expect(screen.getByRole('heading', { name: 'Sesión confirmada' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Esperar guardado' }));
    await act(flushAuthMicrotasks);
    await act(async () => {
      resolvePut({ version: 1, draft: { ...createDefaultDraft(), instructions } });
      await flushAuthMicrotasks();
    });
    expect(logout).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sesión confirmada' })).toBeNull();
  });

  it('retries a configuration failure and reaches the visitor state', async () => {
    const authClient = client();
    const configLoader = vi
      .fn<() => Promise<AuthConfig>>()
      .mockRejectedValueOnce(
        new AuthFailure('configuration', 'La configuración no está disponible.'),
      )
      .mockResolvedValue(config);
    const clientFactory = vi.fn().mockReturnValue(authClient);
    render(<App configLoader={configLoader} clientFactory={clientFactory} />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'configuración no está disponible',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(configLoader).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenCalledOnce();
  });

  it('reloads config when a default confirmation client factory rejects', async () => {
    const authClient = client();
    const configLoader = vi
      .fn<() => Promise<AuthConfig>>()
      .mockResolvedValueOnce(invalidConfirmationConfig)
      .mockResolvedValue(config);
    const clientFactory = vi.fn().mockReturnValue(authClient);

    render(
      <StrictMode>
        <App configLoader={configLoader} clientFactory={clientFactory} />
      </StrictMode>,
    );

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(configLoader).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenNthCalledWith(1, invalidConfirmationConfig);
    expect(clientFactory).toHaveBeenNthCalledWith(2, config);
    expect(authClient.initialize).toHaveBeenCalledOnce();
  });

  it('revalidates an existing session after a transient restore error', async () => {
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(new AuthFailure('network', 'No se pudo validar la sesión.'))
      .mockResolvedValueOnce(null);
    const authClient = client({ initialize });
    render(<App authClient={authClient} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revalidar sesión' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revalidar sesión' }));
    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('renews the session when the access token expires while the tab remains open', async () => {
    const first = session('a@example.com', Math.floor(Date.now() / 1000));
    const renewed = session('a@example.com', Math.floor(Date.now() / 1000) + 600);
    const initialize = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(renewed);
    const authClient = client({ initialize });
    render(<App authClient={authClient} />);

    expect(await screen.findByText('a@example.com')).toBeTruthy();
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
    expect(screen.getByText('a@example.com')).toBeTruthy();
  });

  it('keeps a pending draft through same-sub renewal and saves with the renewed token', async () => {
    vi.useFakeTimers();
    const first = session('a@example.com', (Date.now() + 800) / 1000, 'old-token');
    const renewed = session('a@example.com', (Date.now() + 600_000) / 1000, 'new-token');
    let currentSession = first;
    let resolveRenewal!: (value: AuthSession) => void;
    const initialize = vi
      .fn<() => Promise<AuthSession | null>>()
      .mockImplementationOnce(async () => {
        currentSession = first;
        return first;
      })
      .mockImplementationOnce(
        () =>
          new Promise<AuthSession>((resolve) => {
            resolveRenewal = (value) => {
              currentSession = value;
              resolve(value);
            };
          }),
      );
    const authClient = client({ initialize });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          expectedVersion: number;
          draft: ReturnType<typeof createDefaultDraft>;
        };
        return new Response(
          JSON.stringify({ version: body.expectedVersion + 1, draft: body.draft }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response(JSON.stringify({ version: 0, draft: createDefaultDraft() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const draftApi = new DraftApiClient(config, {
      tokenProvider: () => currentSession.user.access_token,
      fetch: fetchImpl,
    });
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={emptyAttemptApi()}
        configLoader={async () => config}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Texto pendiente durante la renovación' },
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0);
    expect(screen.getByDisplayValue('Texto pendiente durante la renovación')).toBeTruthy();

    await act(async () => {
      resolveRenewal(renewed);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    const putCall = fetchImpl.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(putCall?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer new-token' }),
    });
    expect(screen.getByDisplayValue('Texto pendiente durante la renovación')).toBeTruthy();
  });

  it('preserves an account recovery snapshot when renewal temporarily returns no session', async () => {
    const first = session('a@example.com', (Date.now() + 50) / 1000, 'old-token', 'subject-a');
    let resolveRenewal!: (value: AuthSession | null) => void;
    const initialize = vi
      .fn<() => Promise<AuthSession | null>>()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(
        () =>
          new Promise<AuthSession | null>((resolve) => {
            resolveRenewal = resolve;
          }),
      );
    const authClient = client({ initialize });
    render(<App authClient={authClient} attemptApi={emptyAttemptApi()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({
        sub: 'subject-a',
        requestKey: 'pending-key',
        expectedVersion: 2,
        draft: createDefaultDraft(),
      }),
    );

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await act(async () => {
      resolveRenewal(null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain(
      'pending-key',
    );
  });

  it('clears the previous account recovery snapshot when renewal changes identity', async () => {
    const first = session('a@example.com', (Date.now() + 50) / 1000, 'old-token', 'subject-a');
    const renewed = session(
      'b@example.com',
      (Date.now() + 600_000) / 1000,
      'new-token',
      'subject-b',
    );
    let resolveRenewal!: (value: AuthSession) => void;
    const initialize = vi
      .fn<() => Promise<AuthSession | null>>()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(
        () =>
          new Promise<AuthSession>((resolve) => {
            resolveRenewal = resolve;
          }),
      );
    const authClient = client({ initialize });
    render(<App authClient={authClient} attemptApi={emptyAttemptApi()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({
        sub: 'subject-a',
        requestKey: 'old-key',
        expectedVersion: 2,
        draft: createDefaultDraft(),
      }),
    );

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await act(async () => {
      resolveRenewal(renewed);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('keeps local discard and logout available while waiting for a never-resolving save', async () => {
    vi.useFakeTimers();
    const current = session('a@example.com', (Date.now() + 600_000) / 1000);
    const initialize = vi.fn().mockResolvedValue(current);
    const logout = vi.fn().mockResolvedValue(undefined);
    const authClient = client({ initialize, logout });
    let resolvePut!: (value: DraftSnapshot) => void;
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(
      new Promise<DraftSnapshot>((resolve) => {
        resolvePut = resolve;
      }),
    );
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft,
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={emptyAttemptApi()}
        configLoader={async () => config}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Guardado que no responde' },
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(putDraft).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(screen.getByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Esperar guardado' }));
    await act(async () => {
      await Promise.resolve();
    });
    const discard = screen.getByRole('button', { name: 'Descartar cambios locales y salir' });
    expect((discard as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(discard);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(logout).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    resolvePut({ version: 1, draft: createDefaultDraft() });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(logout).toHaveBeenCalledOnce();
  });

  it('cancels a pending discard-and-logout prompt when Probar starts admission', async () => {
    window.sessionStorage.clear();
    const logout = vi.fn().mockResolvedValue(undefined);
    const createAttempt = vi.fn(() => new Promise<never>(() => undefined));
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      putDraft: vi
        .fn()
        .mockImplementation(async (version, draft) => ({ version: version + 1, draft })),
    };
    render(
      <App
        authClient={client({ initialize: vi.fn().mockResolvedValue(session()), logout })}
        draftApi={draftApi}
        attemptApi={{ ...emptyAttemptApi(), createAttempt }}
        configLoader={async () => config}
      />,
    );

    const tryButton = await screen.findByRole('button', { name: 'Probar' });
    await waitFor(() => expect((tryButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Cambios locales para la admisión' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(screen.getByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeTruthy();

    fireEvent.click(tryButton);
    await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());

    expect(screen.queryByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Descartar cambios locales y salir' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('heading', { name: 'Sesión confirmada' })).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();
  });

  it('keeps the session and admits the snapshot when an awaited save resolves after Probar', async () => {
    window.sessionStorage.clear();
    const logout = vi.fn().mockResolvedValue(undefined);
    const createAttempt = vi.fn(() => new Promise<never>(() => undefined));
    let resolvePut!: (snapshot: DraftSnapshot) => void;
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(
      new Promise<DraftSnapshot>((resolve) => {
        resolvePut = resolve;
      }),
    );
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      putDraft,
    };
    render(
      <App
        authClient={client({ initialize: vi.fn().mockResolvedValue(session()), logout })}
        draftApi={draftApi}
        attemptApi={{ ...emptyAttemptApi(), createAttempt }}
        configLoader={async () => config}
      />,
    );

    const tryButton = await screen.findByRole('button', { name: 'Probar' });
    await waitFor(() => expect((tryButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Guardado pendiente antes de probar' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    fireEvent.click(screen.getByRole('button', { name: 'Esperar guardado' }));
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce());

    fireEvent.click(tryButton);
    expect(screen.queryByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sesión confirmada' })).toBeTruthy();
    expect(logout).not.toHaveBeenCalled();
    await act(async () => {
      resolvePut({
        version: 2,
        draft: { ...createDefaultDraft(), instructions: 'Guardado pendiente antes de probar' },
      });
    });
    await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());

    expect(createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      2,
      expect.objectContaining({ instructions: 'Guardado pendiente antes de probar' }),
      true,
    );
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Sesión confirmada' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('locks editor fields and logout in the same click that starts admission', async () => {
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    };
    const createAttempt = vi.fn(() => new Promise<never>(() => undefined));
    const attemptApi = { ...emptyAttemptApi(), createAttempt };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    await screen.findByLabelText('Qué debe tener en cuenta el robot');
    const tryButton = await screen.findByRole('button', { name: 'Probar' });
    await waitFor(() => expect((tryButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(tryButton);

    expect(
      (
        screen
          .getByLabelText('Qué debe tener en cuenta el robot')
          .closest('fieldset') as HTMLFieldSetElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Cerrar sesión' }).textContent).toBe('Cerrar sesión');
  });

  it('locks editor, history, and logout through automatic replay, then releases them at the result', async () => {
    window.sessionStorage.clear();
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    };
    const attemptId = 'attempt-presentation-lock';
    const pending: AttemptSummary = {
      id: attemptId,
      createdAt: '2026-09-21T12:00:00.000Z',
      updatedAt: '2026-09-21T12:00:01.000Z',
      status: 'victory',
      cancelRequested: false,
      levelId: LEVEL.id,
      modelKey: 'claude-sonnet-4.6',
      modelLabel: 'Claude Sonnet 4.6',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      turnsUsed: 17,
      maxTurns: LEVEL.maxTurns,
      calls: 17,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      gameTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      score: null,
      collectedObjectIds: ['recompensa-1', 'llave-1'],
      objectPoints: 25,
      progress: 1,
      finalSupport: LEVEL.exit.support,
      animationEnabled: true,
      presentationComplete: false,
      recordComplete: true,
    };
    setCurrentRecovery(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', attemptId }),
    );
    const attemptApi = {
      ...emptyAttemptApi(),
      getAttempt: vi.fn().mockResolvedValue(pending),
      getReplay: vi.fn().mockResolvedValue(replayRecord(attemptId)),
      completePresentation: vi.fn().mockResolvedValue({ ...pending, presentationComplete: true }),
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Escena lista' }));
    expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Historial' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Victoria' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Terminar escena' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy();
    expect(attemptApi.createAttempt).not.toHaveBeenCalled();
  });

  it('keeps Probar locked after preference loading fails and restores the server value on retry', async () => {
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    };
    const getAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Preference unavailable', 500))
      .mockResolvedValueOnce({ animationEnabled: false, version: 1 });
    const attemptApi = {
      ...emptyAttemptApi(),
      getAnimationPreference,
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Historial' })).toBeTruthy();
    const tryButton = screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
    expect(tryButton.disabled).toBe(true);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar preferencia' }));
    await waitFor(() => expect(getAnimationPreference).toHaveBeenCalledTimes(2));
    expect((screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement).checked).toBe(
      false,
    );
    await waitFor(() => expect(tryButton.disabled).toBe(false));
  });

  it('settles attempt discovery when the authenticated App rerenders for workspace busy state', async () => {
    window.sessionStorage.clear();
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    };
    const attemptApi = emptyAttemptApi();
    const listAttempts = vi.mocked(attemptApi.listAttempts);

    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Historial' })).toBeTruthy();
    await waitFor(() => expect(listAttempts).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  it('pauses the authenticated workspace after an API auth failure and preserves identity for re-entry', async () => {
    window.sessionStorage.clear();
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    };
    const historicalAttempt: AttemptSummary = {
      id: 'attempt-history-auth-error',
      createdAt: '2026-09-21T12:00:00.000Z',
      updatedAt: '2026-09-21T12:01:00.000Z',
      status: 'victory',
      cancelRequested: false,
      levelId: LEVEL.id,
      modelKey: 'claude-sonnet-4.6',
      modelLabel: 'Claude Sonnet 4.6',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      turnsUsed: 17,
      maxTurns: LEVEL.maxTurns,
      calls: 17,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      gameTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      score: null,
      collectedObjectIds: ['recompensa-1', 'llave-1'],
      objectPoints: 25,
      progress: 1,
      finalSupport: LEVEL.exit.support,
      animationEnabled: false,
      presentationComplete: true,
      recordComplete: true,
    };
    const attemptApi: AttemptApi = {
      ...emptyAttemptApi(),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [historicalAttempt] }),
      getAttempt: vi
        .fn()
        .mockRejectedValue(
          new AttemptApiFailure('authentication', 'La sesión ya no está autorizada.', 401),
        ),
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    await screen.findByText('a@example.com');
    fireEvent.click(await screen.findByRole('button', { name: 'Ver resultado' }));
    expect(await screen.findByText('La sesión ya no está autorizada.')).toBeTruthy();
    expect(screen.getByText(/La sesión dejó de tener acceso a esta cuenta/)).toBeTruthy();
    expect(
      (
        screen
          .getByLabelText('Qué debe tener en cuenta el robot')
          .closest('fieldset') as HTMLFieldSetElement
      ).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByText('a@example.com')).toBeTruthy();
    expect(
      screen.getByText('La sesión necesita volver a validarse antes de continuar.'),
    ).toBeTruthy();
    expect(screen.queryByText('Tu cuenta está confirmada y la sesión es válida.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();
  });

  it('pauses the preference controls and offers re-entry after a preference auth failure', async () => {
    window.sessionStorage.clear();
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    };
    const authError = new AttemptApiFailure('authentication', 'Tu sesión dejó de ser válida.', 401);
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockRejectedValueOnce(authError);
    const putAnimationPreference = vi.fn().mockRejectedValue(authError);
    const attemptApi = {
      ...emptyAttemptApi(),
      getAnimationPreference,
      putAnimationPreference,
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    await screen.findByRole('heading', { name: 'Historial' });
    const animation = screen.getByRole('checkbox', { name: 'Animación' }) as HTMLInputElement;
    await waitFor(() => expect(animation.disabled).toBe(false));
    fireEvent.click(animation);

    await waitFor(() => expect(putAnimationPreference).toHaveBeenCalledOnce());
    await waitFor(() => expect(getAnimationPreference).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Volver a ingresar' })).toBeTruthy();
    expect(screen.getByText('a@example.com')).toBeTruthy();
    expect(
      screen.getByText('La sesión necesita volver a validarse antes de continuar.'),
    ).toBeTruthy();
    expect(animation.disabled).toBe(true);
    expect(
      (
        screen
          .getByLabelText('Qué debe tener en cuenta el robot')
          .closest('fieldset') as HTMLFieldSetElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(animation);
    expect(putAnimationPreference).toHaveBeenCalledOnce();
  });

  it('loads an attempt configuration, saves it as a copy, then tests the visible draft', async () => {
    window.sessionStorage.clear();
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const sourceSummary: AttemptSummary = {
      id: 'attempt-source',
      createdAt: '2026-09-21T12:00:00.000Z',
      updatedAt: '2026-09-21T12:00:01.000Z',
      status: 'victory',
      cancelRequested: false,
      levelId: LEVEL.id,
      modelKey: 'claude-sonnet-4.6',
      modelLabel: 'Claude Sonnet 4.6',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      turnsUsed: 17,
      maxTurns: LEVEL.maxTurns,
      calls: 17,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      gameTokens: 700,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      score: 321,
      collectedObjectIds: ['recompensa-1', 'llave-1'],
      objectPoints: 25,
      progress: 1,
      finalSupport: LEVEL.exit.support,
      animationEnabled: false,
      presentationComplete: true,
      recordComplete: true,
    };
    const sourceSerialized = JSON.stringify(sourceSummary);
    const recovered = { ...createDefaultDraft(), instructions: 'Desde la victoria' };
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockImplementation(async (version: number, draft) => ({
        version: version + 1,
        draft,
      })),
    };
    const saved: SavedRobot = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Desde intento',
      version: 1,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      modelKey: recovered.modelKey,
      draft: recovered,
    };
    const savedRobotApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      getRobot: vi.fn().mockResolvedValue(saved),
      saveRobot: vi.fn().mockResolvedValue(saved),
      deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    };
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: { ...sourceSummary, id: 'attempt-new' },
      dispatchConfirmed: true,
    });
    const attemptApi = {
      ...emptyAttemptApi(),
      listAttempts: vi
        .fn()
        .mockResolvedValueOnce({ attempts: [sourceSummary] })
        .mockResolvedValue({ attempts: [] }),
      getConfiguration: vi
        .fn()
        .mockResolvedValue({ attemptId: 'attempt-source', draft: recovered }),
      createAttempt,
    } as AttemptApi;
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        savedRobotApi={savedRobotApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Historial' })).toBeTruthy();
    const history = screen
      .getByRole('heading', { name: 'Historial' })
      .closest('section') as HTMLElement;
    const sourceRow = within(history).getAllByRole('listitem')[0]!;
    fireEvent.click(within(sourceRow).getByRole('button', { name: 'Ver configuración' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Usar esta configuración' }));
    expect(await screen.findByDisplayValue('Desde la victoria')).toBeTruthy();

    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'Guardar como nueva' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar como nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Desde intento' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(savedRobotApi.saveRobot).toHaveBeenCalledOnce());
    expect((savedRobotApi.saveRobot as ReturnType<typeof vi.fn>).mock.calls[0]?.[3]).toEqual(
      recovered,
    );

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    await waitFor(() => expect(createAttempt).toHaveBeenCalledOnce());
    const sentDraft = createAttempt.mock.calls[0]?.[2];
    expect(sentDraft.instructions).toBe('Desde la victoria');
    expect(createAttempt.mock.calls[0]?.[0]).not.toBe('attempt-source');
    expect(savedRobotApi.saveRobot).toHaveBeenCalledOnce();
    expect(JSON.stringify(sourceSummary)).toBe(sourceSerialized);
  });
});
