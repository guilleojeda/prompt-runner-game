// @vitest-environment jsdom

import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type DraftSnapshot,
  type RobotDraft,
  type SavedRobot,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type QuotaSummary } from './attempt-api.js';
import { AttemptActivityHarness as AttemptActivity } from './AttemptActivity.test-support.js';
import type { AttemptActivityHandle } from './useAttemptActivity.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';
import type { DraftApi } from './draft-api.js';
import { SavedRobots } from './SavedRobots.js';
import type { SavedRobotApi } from './saved-robot-api.js';

function session(): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub: 'subject-a', email: 'a@example.com' },
    user: new User({
      access_token: 'access-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
        aud: 'client-public',
        iat: now,
        exp: now + 600,
        sub: 'subject-a',
        email: 'a@example.com',
      },
    }),
  };
}

function attemptApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi.fn(),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'Not found.', 404)),
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

interface RealPreparationHarnessProps {
  readonly runner: AttemptApi;
  readonly editorApi: DraftApi;
  readonly copiesApi: SavedRobotApi;
  readonly activeSession: AuthSession;
  readonly onTryClick?: () => void;
}

function RealPreparationHarness({
  runner,
  editorApi,
  copiesApi,
  activeSession,
  onTryClick,
}: RealPreparationHarnessProps) {
  const editor = useRef<RobotEditorHandle | null>(null);
  const workspace = useRef<AttemptActivityHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [tryAvailable, setTryAvailable] = useState(false);

  return (
    <>
      <RobotEditor
        ref={editor}
        api={editorApi}
        session={activeSession}
        locked={busy}
        tryUnavailable={!tryAvailable}
        onTry={() => {
          onTryClick?.();
          workspace.current?.start();
        }}
      />
      <AttemptActivity
        ref={workspace}
        api={runner}
        editor={editor}
        session={activeSession}
        onBusyChange={setBusy}
        onTryAvailabilityChange={setTryAvailable}
      />
      <SavedRobots
        api={copiesApi}
        editor={editor}
        session={activeSession}
        configurationAvailable
        accessState="ready"
      />
    </>
  );
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

describe('AttemptActivity availability implementation', () => {
  it('labels a pending preference write as confirmation and exposes conflict details as its cause', async () => {
    let rejectSave!: (error: unknown) => void;
    const getAnimationPreference = vi
      .fn()
      .mockResolvedValueOnce({ animationEnabled: true, version: 0 })
      .mockResolvedValueOnce({ animationEnabled: true, version: 1 });
    const putAnimationPreference = vi.fn(
      () =>
        new Promise<{ animationEnabled: boolean; version: number }>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const runner = attemptApi({ getAnimationPreference, putAnimationPreference });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    const onTryAvailabilityChange = vi.fn();
    render(
      <AttemptActivity
        api={runner}
        editor={editor}
        session={session()}
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );

    await screen.findByRole('heading', { name: 'Historial' });
    await waitFor(() => expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Animación' }));
    expect(
      await screen.findByText(
        'Confirmando tu preferencia de animación. Podés seguir preparando el robot.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Estamos recuperando tu preferencia de animación/)).toBeNull();
    expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      rejectSave(new AttemptApiFailure('conflict', 'Version conflict.', 409));
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Guardar mi selección' })).toBeTruthy();
    const availabilityStatus = document.getElementById('attempt-availability-status');
    expect(availabilityStatus?.textContent).toMatch(/No se guardó tu cambio/);
    expect(screen.queryByText(/Estamos recuperando tu preferencia de animación/)).toBeNull();
    expect(runner.createAttempt).not.toHaveBeenCalled();
  });

  it('blocks an admission if quota reaches zero while the confirmed snapshot is being captured', async () => {
    let finishQuota!: (quota: QuotaSummary) => void;
    let finishSnapshot!: (snapshot: DraftSnapshot) => void;
    const createAttempt = vi.fn();
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [] });
    const runner = attemptApi({
      createAttempt,
      listAttempts,
      getQuota: vi.fn(
        () =>
          new Promise<QuotaSummary>((resolve) => {
            finishQuota = resolve;
          }),
      ),
    });
    const captureSnapshot = vi.fn(
      () =>
        new Promise<DraftSnapshot>((resolve) => {
          finishSnapshot = resolve;
        }),
    );
    const editor = {
      current: { captureSnapshot },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    const onTryAvailabilityChange = vi.fn();
    render(
      <AttemptActivity
        ref={ref}
        api={runner}
        editor={editor}
        session={session()}
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );

    await waitFor(() => expect(listAttempts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true));
    act(() => {
      ref.current!.start();
    });
    await waitFor(() => expect(captureSnapshot).toHaveBeenCalledOnce());

    await act(async () => {
      finishQuota({
        day: '2026-09-21',
        used: 100,
        limit: 100,
        remaining: 0,
        resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(false));
    expect(await screen.findByText('No quedan partidas disponibles.')).toBeTruthy();

    await act(async () => {
      finishSnapshot({ version: 2, draft: createDefaultDraft() });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('keeps admission busy until initial active-attempt discovery finishes', async () => {
    let finishDiscovery!: (page: { attempts: readonly [] }) => void;
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishDiscovery = resolve;
          }),
      );
    const createAttempt = vi.fn();
    const getQuota = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'Quota unavailable.'));
    const runner = attemptApi({ listAttempts, createAttempt, getQuota });
    const captureSnapshot = vi.fn().mockResolvedValue({ version: 2, draft: createDefaultDraft() });
    const editor = {
      current: { captureSnapshot },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as { current: AttemptActivityHandle | null };
    const onBusyChange = vi.fn();
    const onTryAvailabilityChange = vi.fn();
    render(
      <AttemptActivity
        ref={ref}
        api={runner}
        editor={editor}
        session={session()}
        onBusyChange={onBusyChange}
        onTryAvailabilityChange={onTryAvailabilityChange}
      />,
    );

    await waitFor(() => expect(listAttempts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    act(() => ref.current!.start());
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(createAttempt).not.toHaveBeenCalled();

    await act(async () => {
      finishDiscovery({ attempts: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    expect(onTryAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('releases the editor click lock when quota becomes zero before availability rerenders', async () => {
    let finishQuota!: (quota: QuotaSummary) => void;
    const createAttempt = vi.fn();
    const onTryClick = vi.fn();
    const runner = attemptApi({
      createAttempt,
      getQuota: vi.fn(
        () =>
          new Promise<QuotaSummary>((resolve) => {
            finishQuota = resolve;
          }),
      ),
    });
    const initialDraft = createDefaultDraft();
    const editorApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 1, draft: initialDraft }),
      putDraft: vi.fn(async (expectedVersion: number, draft: RobotDraft) => ({
        version: expectedVersion + 1,
        draft,
      })),
    };
    const savedDraft = {
      ...createDefaultDraft(),
      instructions: 'Copia disponible durante la cuota cero.',
    };
    const savedCopy: SavedRobot = {
      id: 'saved-copy-click-lock',
      name: 'Explorador guardado',
      version: 1,
      createdAt: '2026-09-21T12:00:00.000Z',
      updatedAt: '2026-09-21T12:00:00.000Z',
      modelKey: savedDraft.modelKey,
      draft: savedDraft,
    };
    const copiesApi: SavedRobotApi = {
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
      getRobot: vi.fn().mockResolvedValue(savedCopy),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    render(
      <RealPreparationHarness
        runner={runner}
        editorApi={editorApi}
        copiesApi={copiesApi}
        activeSession={session()}
        onTryClick={onTryClick}
      />,
    );

    const tryButton = (await screen.findByRole('button', { name: 'Probar' })) as HTMLButtonElement;
    const copyRadio = (await screen.findByRole('radio', {
      name: /Explorador guardado/u,
    })) as HTMLInputElement;
    await waitFor(() => expect(tryButton.disabled).toBe(false));

    await act(async () => {
      finishQuota({
        day: '2026-09-21',
        used: 100,
        limit: 100,
        remaining: 0,
        resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      await Promise.resolve();
      fireEvent.click(tryButton);
    });

    expect(createAttempt).not.toHaveBeenCalled();
    expect(onTryClick).toHaveBeenCalledOnce();
    expect(tryButton.disabled).toBe(true);
    expect(screen.getByText('No quedan partidas disponibles.')).toBeTruthy();
    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    expect(instructions.readOnly).toBe(false);
    expect(instructions.matches(':disabled')).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement).disabled).toBe(
      false,
    );

    expect(copyRadio.disabled).toBe(false);
    fireEvent.click(copyRadio);
    await waitFor(() => expect(copiesApi.getRobot).toHaveBeenCalledOnce());
    const selectedCopy = screen.getByRole('region', { name: 'Copia seleccionada' });
    await waitFor(() => expect(selectedCopy.getAttribute('aria-busy')).toBe('false'));
    const useCopy = within(selectedCopy).getByRole('button', { name: 'Usar este robot' });
    expect((useCopy as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(useCopy);
    const useDialog = await screen.findByRole('dialog', { name: /Usar.*Explorador guardado/u });
    fireEvent.click(within(useDialog).getByRole('button', { name: 'Usar este robot' }));
    expect(await screen.findByDisplayValue(savedDraft.instructions)).toBeTruthy();
    const loadedInstructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    fireEvent.change(loadedInstructions, { target: { value: 'Puedo seguir editando.' } });
    expect(loadedInstructions.value).toBe('Puedo seguir editando.');
    const enabledSkill = screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement;
    const skillWasEnabled = enabledSkill.checked;
    fireEvent.click(enabledSkill);
    expect(enabledSkill.checked).toBe(!skillWasEnabled);
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('keeps preparation unlocked when an animation choice becomes unconfirmed before rerender', async () => {
    let finishPreferenceSave!: (value: { animationEnabled: boolean; version: number }) => void;
    const createAttempt = vi.fn();
    const onTryClick = vi.fn();
    const runner = attemptApi({
      createAttempt,
      putAnimationPreference: vi.fn(
        () =>
          new Promise<{ animationEnabled: boolean; version: number }>((resolve) => {
            finishPreferenceSave = resolve;
          }),
      ),
    });
    const editorApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      putDraft: vi.fn(async (expectedVersion: number, draft: RobotDraft) => ({
        version: expectedVersion + 1,
        draft,
      })),
    };
    const copiesApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    render(
      <RealPreparationHarness
        runner={runner}
        editorApi={editorApi}
        copiesApi={copiesApi}
        activeSession={session()}
        onTryClick={onTryClick}
      />,
    );

    const tryButton = (await screen.findByRole('button', { name: 'Probar' })) as HTMLButtonElement;
    const animationCheckbox = (await screen.findByRole('checkbox', {
      name: 'Animación',
    })) as HTMLInputElement;
    await waitFor(() => expect(tryButton.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(animationCheckbox);
      fireEvent.click(tryButton);
      await Promise.resolve();
    });

    await waitFor(() => expect(runner.putAnimationPreference).toHaveBeenCalledOnce());
    expect(createAttempt).not.toHaveBeenCalled();
    expect(onTryClick).toHaveBeenCalledOnce();
    expect(tryButton.disabled).toBe(true);
    expect(
      await screen.findByText(
        'Confirmando tu preferencia de animación. Podés seguir preparando el robot.',
      ),
    ).toBeTruthy();
    const instructions = screen.getByLabelText(
      'Qué debe tener en cuenta el robot',
    ) as HTMLTextAreaElement;
    expect(instructions.readOnly).toBe(false);
    expect(instructions.matches(':disabled')).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole('button', { name: 'Guardar robot actual' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await act(async () => {
      finishPreferenceSave({ animationEnabled: false, version: 1 });
      await Promise.resolve();
    });
    await waitFor(() => expect(tryButton.disabled).toBe(false));
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('shows unknown animation as mixed until the server confirms its false value', async () => {
    vi.useFakeTimers();
    let rejectInitialPreference!: (error: unknown) => void;
    const getAnimationPreference = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ animationEnabled: boolean; version: number }>((_resolve, reject) => {
            rejectInitialPreference = reject;
          }),
      )
      .mockResolvedValueOnce({ animationEnabled: false, version: 1 });
    const createAttempt = vi.fn();
    const runner = attemptApi({ createAttempt, getAnimationPreference });
    const editorApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      putDraft: vi.fn(async (expectedVersion: number, draft: RobotDraft) => ({
        version: expectedVersion + 1,
        draft,
      })),
    };
    const copiesApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    render(
      <RealPreparationHarness
        runner={runner}
        editorApi={editorApi}
        copiesApi={copiesApi}
        activeSession={session()}
      />,
    );

    await settlePreparationPromises();
    const animationCheckbox = screen.getByRole('checkbox', {
      name: 'Animación',
    }) as HTMLInputElement;
    const tryButton = screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    expect(animationCheckbox.indeterminate).toBe(true);
    expect(animationCheckbox.getAttribute('aria-checked')).toBe('mixed');
    expect(tryButton.disabled).toBe(true);

    await act(async () => {
      rejectInitialPreference(new AttemptApiFailure('server', 'Preferencia no disponible.', 503));
      await Promise.resolve();
    });
    await settlePreparationPromises();
    expect(animationCheckbox.disabled).toBe(false);
    expect(animationCheckbox.indeterminate).toBe(true);
    expect(animationCheckbox.getAttribute('aria-checked')).toBe('mixed');
    expect(tryButton.disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settlePreparationPromises();
    expect(getAnimationPreference).toHaveBeenCalledTimes(2);
    await settlePreparationPromises();
    expect(tryButton.disabled).toBe(false);
    expect(animationCheckbox.indeterminate).toBe(false);
    expect(animationCheckbox.checked).toBe(false);
    expect(animationCheckbox.getAttribute('aria-checked')).toBe('false');
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('turns a mixed preference into the explicit on choice while its save is pending', async () => {
    vi.useFakeTimers();
    let finishPreferenceSave!: (value: { animationEnabled: boolean; version: number }) => void;
    const getAnimationPreference = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Preferencia no disponible.', 503))
      .mockResolvedValue({ animationEnabled: false, version: 8 });
    const createAttempt = vi.fn();
    const runner = attemptApi({
      createAttempt,
      getAnimationPreference,
      putAnimationPreference: vi.fn(
        () =>
          new Promise<{ animationEnabled: boolean; version: number }>((resolve) => {
            finishPreferenceSave = resolve;
          }),
      ),
    });
    const editorApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      putDraft: vi.fn(async (expectedVersion: number, draft: RobotDraft) => ({
        version: expectedVersion + 1,
        draft,
      })),
    };
    const copiesApi: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn(),
    };
    render(
      <RealPreparationHarness
        runner={runner}
        editorApi={editorApi}
        copiesApi={copiesApi}
        activeSession={session()}
      />,
    );

    await settlePreparationPromises();
    const animationCheckbox = screen.getByRole('checkbox', {
      name: 'Animación',
    }) as HTMLInputElement;
    const tryButton = screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
    await settlePreparationPromises();
    expect(animationCheckbox.disabled).toBe(false);
    expect(animationCheckbox.indeterminate).toBe(true);
    expect(animationCheckbox.getAttribute('aria-checked')).toBe('mixed');

    fireEvent.click(animationCheckbox);
    expect(animationCheckbox.checked).toBe(true);
    expect(animationCheckbox.indeterminate).toBe(false);
    expect(runner.putAnimationPreference).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(getAnimationPreference).toHaveBeenCalledOnce();
    expect(runner.putAnimationPreference).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settlePreparationPromises();
    expect(runner.putAnimationPreference).toHaveBeenCalledOnce();
    expect(runner.putAnimationPreference).toHaveBeenCalledWith(true, 8, expect.any(AbortSignal));
    expect(animationCheckbox.checked).toBe(true);
    expect(animationCheckbox.indeterminate).toBe(false);
    expect(animationCheckbox.getAttribute('aria-checked')).toBe('true');
    expect(tryButton.disabled).toBe(true);
    expect(
      screen.getByText(
        'Confirmando tu preferencia de animación. Podés seguir preparando el robot.',
      ),
    ).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();

    await act(async () => {
      finishPreferenceSave({ animationEnabled: true, version: 9 });
      await Promise.resolve();
    });
    await settlePreparationPromises();
    expect(tryButton.disabled).toBe(false);
    expect(animationCheckbox.checked).toBe(true);
    expect(animationCheckbox.indeterminate).toBe(false);
    expect(createAttempt).not.toHaveBeenCalled();
  });
});
