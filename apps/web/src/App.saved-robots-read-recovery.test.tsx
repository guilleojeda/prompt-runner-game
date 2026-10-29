// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type DraftSnapshot,
  type RobotDraft,
  type SavedRobot,
} from '../../../shared/robot.js';
import { App } from './App.js';
import type { AuthClient, AuthConfig, AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi } from './attempt-api.js';
import type { DraftApi } from './draft-api.js';
import { installHtmlDialogTestShim } from './configuration-confirmation.test-support.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

vi.mock('./replay/ReplayScene.js', () => ({ CoursePreview: () => null, ReplayScene: () => null }));

const MINUTE = 60_000;
const TEST_NOW = new Date('2026-10-29T12:00:00.000Z');

const config: AuthConfig = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'client-public',
  domain: 'https://prompt-runner.auth.us-east-1.amazoncognito.com',
  redirectUri: 'https://robotrunner.guilleojeda.com/jugar',
  logoutUri: 'https://robotrunner.guilleojeda.com/',
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};

const editorDraft: RobotDraft = {
  ...createDefaultDraft(),
  instructions: 'Borrador confirmado del editor, sin cambios por consultar.',
};
const copyDraft: RobotDraft = {
  ...createDefaultDraft(),
  instructions: 'Copia consultada.  \nConservar el literal al recuperar.',
};

function session(sub = 'read-recovery-app'): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  const email = `${sub}@example.test`;
  return {
    identity: { sub, email },
    user: new User({
      access_token: `token-${sub}`,
      refresh_token: `refresh-${sub}`,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: config.issuer,
        aud: config.clientId,
        iat: now,
        exp: now + 36_000,
        sub,
        email,
      },
      expires_at: now + 36_000,
    }),
  };
}

function robot(id: string, name: string, draft: RobotDraft, version = 3): SavedRobot {
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

const copyA = robot('copy-a', 'Copia A', copyDraft);
const copyB = robot('copy-b', 'Copia B', {
  ...copyDraft,
  instructions: 'Copia B de la página siguiente.',
});

function summary(saved: SavedRobot) {
  const { id, name, version, createdAt, updatedAt, modelKey } = saved;
  return { id, name, version, createdAt, updatedAt, modelKey };
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

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
}

function instructions(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>('#robot-instructions');
  if (!field) throw new Error('No está montado el editor de la aplicación.');
  return field;
}

function navigate(surface: 'Preparar' | 'Historial' | 'Mis robots'): void {
  const navigation = screen.getByRole('navigation', { name: 'Navegación principal' });
  const target = within(navigation).getByRole('button', { name: surface });
  if (target.getAttribute('aria-current') !== 'page') fireEvent.click(target);
}

function activeSurface(): string | null {
  const navigation = screen.getByRole('navigation', { name: 'Navegación principal' });
  return within(navigation).getByRole('button', { current: 'page' }).textContent;
}

function selectedPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

interface MountOverrides {
  readonly auth?: Partial<AuthClient>;
  readonly draftApi?: Partial<DraftApi>;
  readonly savedApi?: Partial<SavedRobotApi>;
  readonly runnerApi?: Partial<AttemptApi>;
}

async function mount(overrides: MountOverrides = {}) {
  const auth: AuthClient = {
    initialize: vi.fn().mockResolvedValue(session()),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides.auth,
  };
  const draftApi: DraftApi = {
    getDraft: vi.fn().mockResolvedValue({ version: 4, draft: editorDraft }),
    putDraft: vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation(async (version, draft) => ({ version: version + 1, draft })),
    ...overrides.draftApi,
  };
  const savedApi: SavedRobotApi = {
    listRobots: vi.fn().mockResolvedValue({ robots: [summary(copyA)] }),
    getRobot: vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(copyA),
    saveRobot: vi.fn().mockResolvedValue(copyA),
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides.savedApi,
  };
  const runnerApi: AttemptApi = {
    createAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('invalid', 'No se espera una partida.', 400)),
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
      day: '2026-10-29',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * MINUTE).toISOString(),
    }),
    ...overrides.runnerApi,
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
  return { auth, draftApi, savedApi, runnerApi };
}

let restoreDialogShim: (() => void) | undefined;

beforeAll(() => {
  restoreDialogShim = installHtmlDialogTestShim();
});

afterAll(() => restoreDialogShim?.());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('App library read recovery integration', () => {
  it.each([
    { label: 'before the deadline', awayMs: 20_000, remainingMs: 10_000 },
    { label: 'after the deadline', awayMs: 2 * MINUTE, remainingMs: 0 },
  ])(
    'keeps the failed cursor deadline when leaving Mis robots $label',
    async ({ awayMs, remainingMs }) => {
      const listRobots = vi
        .fn<SavedRobotApi['listRobots']>()
        .mockResolvedValueOnce({ robots: [summary(copyA)], nextCursor: 'page-2' })
        .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'La página no está disponible.'))
        .mockResolvedValueOnce({ robots: [summary(copyB)] });
      const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(copyA);
      const { savedApi } = await mount({ savedApi: { listRobots, getRobot } });

      expect(activeSurface()).toBe('Preparar');
      expect.soft(listRobots).not.toHaveBeenCalled();
      await advance(3 * MINUTE);
      expect.soft(listRobots).not.toHaveBeenCalled();

      navigate('Mis robots');
      await settle();
      expect(listRobots).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole('radio', { name: /Copia A/u }));
      await settle();
      expect(getRobot).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
      await settle();
      expect(listRobots).toHaveBeenCalledTimes(2);
      expect.soft(screen.queryByRole('alert')).toBeNull();
      expect.soft(screen.queryByRole('button', { name: /Reintentar/i })).toBeNull();
      expect(screen.getByRole('radio', { name: /Copia A/u })).toBeTruthy();
      expect(
        within(selectedPanel()).getByText(copyA.draft.instructions, { normalizer: (text) => text }),
      ).toBeTruthy();
      await advance(MINUTE / 2);

      navigate('Historial');
      await settle();
      await advance(awayMs);
      expect.soft(listRobots).toHaveBeenCalledTimes(2);
      expect(getRobot).toHaveBeenCalledOnce();

      navigate('Mis robots');
      await settle();
      expect.soft(listRobots).toHaveBeenCalledTimes(remainingMs > 0 ? 2 : 3);
      expect(getRobot).toHaveBeenCalledOnce();
      if (remainingMs > 0) {
        await advance(remainingMs - 1);
        expect.soft(listRobots).toHaveBeenCalledTimes(2);
        await advance(1);
      }

      expect.soft(listRobots).toHaveBeenCalledTimes(3);
      expect
        .soft(listRobots.mock.calls.map(([cursor]) => cursor))
        .toEqual([undefined, 'page-2', 'page-2']);
      expect.soft(screen.queryByRole('radio', { name: /Copia A/u })).not.toBeNull();
      expect.soft(screen.queryByRole('radio', { name: /Copia B/u })).not.toBeNull();
      expect
        .soft(
          within(selectedPanel()).queryByText(copyA.draft.instructions, {
            normalizer: (text) => text,
          }),
        )
        .not.toBeNull();
      expect(getRobot).toHaveBeenCalledOnce();

      await advance(2 * MINUTE);
      expect.soft(listRobots).toHaveBeenCalledTimes(3);
      expect(getRobot).toHaveBeenCalledOnce();
      expect(savedApi.saveRobot).not.toHaveBeenCalled();
      expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    },
  );

  it('does not poll a healthy list or selected copy when the surface is idle or hidden', async () => {
    const listRobots = vi.fn<SavedRobotApi['listRobots']>().mockResolvedValue({
      robots: [summary(copyA)],
    });
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(copyA);
    const { savedApi, draftApi, runnerApi } = await mount({
      savedApi: { listRobots, getRobot },
    });

    expect(activeSurface()).toBe('Preparar');
    expect.soft(listRobots).not.toHaveBeenCalled();
    await advance(3 * MINUTE);
    expect.soft(listRobots).not.toHaveBeenCalled();

    navigate('Mis robots');
    await settle();
    expect(listRobots).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('radio', { name: /Copia A/u }));
    await settle();
    expect(getRobot).toHaveBeenCalledOnce();
    expect(
      within(selectedPanel()).getByText(copyA.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();

    navigate('Historial');
    await settle();
    await advance(3 * MINUTE);
    navigate('Mis robots');
    await settle();
    await advance(2 * MINUTE);
    expect(listRobots).toHaveBeenCalledOnce();
    expect(getRobot).toHaveBeenCalledOnce();
    expect(instructions().value).toBe(editorDraft.instructions);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });

  it('reopens a failed selected-copy read once on the same identity without applying or writing it', async () => {
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'La ficha no está disponible.'))
      .mockResolvedValueOnce(copyA);
    const listRobots = vi.fn<SavedRobotApi['listRobots']>().mockResolvedValue({
      robots: [summary(copyA)],
    });
    const { savedApi, draftApi, runnerApi } = await mount({ savedApi: { listRobots, getRobot } });
    navigate('Mis robots');
    await settle();
    fireEvent.click(screen.getByRole('radio', { name: /Copia A/u }));
    await settle();
    expect(getRobot).toHaveBeenCalledOnce();
    await advance(MINUTE / 2);

    navigate('Historial');
    await settle();
    await advance(2 * MINUTE);
    expect(getRobot).toHaveBeenCalledOnce();
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();

    navigate('Mis robots');
    await settle();
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
    expect.soft(getRobot.mock.calls.map(([id]) => id)).toEqual([copyA.id, copyA.id]);
    expect
      .soft(
        within(selectedPanel()).queryByText(copyA.draft.instructions, {
          normalizer: (text) => text,
        }),
      )
      .not.toBeNull();
    expect(instructions().value).toBe(editorDraft.instructions);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();

    await advance(2 * MINUTE);
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
    expect(listRobots).toHaveBeenCalledOnce();
  });

  it('does not cancel a pending D2 application when the failed next-page read recovers', async () => {
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockResolvedValueOnce({ robots: [summary(copyA)], nextCursor: 'page-2' })
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Página temporal.'))
      .mockResolvedValueOnce({ robots: [summary(copyB)] });
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(copyA);
    const pendingWrite = deferred<DraftSnapshot>();
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(pendingWrite.promise);
    const { savedApi, runnerApi } = await mount({
      savedApi: { listRobots, getRobot },
      draftApi: { putDraft },
    });
    navigate('Mis robots');
    await settle();
    fireEvent.click(screen.getByRole('radio', { name: /Copia A/u }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await settle();
    expect(listRobots).toHaveBeenCalledTimes(2);

    fireEvent.click(within(selectedPanel()).getByRole('button', { name: 'Usar este robot' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: /Usar.*Copia A/u });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Usar este robot' }));
    await advance(0);
    expect(putDraft).toHaveBeenCalledOnce();
    const pendingSignal = putDraft.mock.calls[0]?.[2];
    expect(pendingSignal).toBeInstanceOf(AbortSignal);
    expect(pendingSignal?.aborted).toBe(false);
    expect(instructions().value).toBe(editorDraft.instructions);
    expect(activeSurface()).toBe('Mis robots');

    await advance(MINUTE);
    expect.soft(listRobots).toHaveBeenCalledTimes(3);
    expect(pendingSignal?.aborted).toBe(false);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructions().value).toBe(editorDraft.instructions);
    expect(activeSurface()).toBe('Mis robots');
    expect.soft(screen.queryByRole('radio', { name: /Copia B/u })).not.toBeNull();

    await act(async () => {
      pendingWrite.resolve({ version: 5, draft: copyDraft });
      await Promise.resolve();
    });
    await settle();
    expect(activeSurface()).toBe('Preparar');
    expect(instructions().value).toBe(copyDraft.instructions);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();

    await advance(2 * MINUTE);
    expect.soft(listRobots).toHaveBeenCalledTimes(3);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(runnerApi.createAttempt).not.toHaveBeenCalled();
  });
});
