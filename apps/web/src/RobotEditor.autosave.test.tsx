// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { createRef, type RefObject } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDefaultDraft, type DraftSnapshot, type RobotDraft } from '../../../shared/robot.js';
import type { ApiAuthRequired } from './api-auth.js';
import type { AuthSession } from './auth.js';
import { createDraftApiClient, DraftApiFailure, type DraftApi } from './draft-api.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';

type DraftApiMock = {
  getDraft: Mock<DraftApi['getDraft']>;
  putDraft: Mock<DraftApi['putDraft']>;
};

function session(sub = 'subject-a'): AuthSession {
  return {
    identity: { sub, email: `${sub}@example.com` },
    user: new User({
      access_token: `token-${sub}`,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client-public',
        iat: 1,
        exp: 9_999_999_999,
        sub,
        email: `${sub}@example.com`,
      },
      expires_at: 9_999_999_999,
    }),
  };
}

function snapshot(version = 0, draft: RobotDraft = createDefaultDraft()): DraftSnapshot {
  return { version, draft };
}

function api(overrides: Partial<DraftApiMock> = {}): DraftApiMock {
  return {
    getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot()),
    putDraft: vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation(async (version, draft) => snapshot(version + 1, draft)),
    ...overrides,
  };
}

function incompatibleDraftFailure(): DraftApiFailure & { readonly code: 'incompatible' } {
  return Object.assign(
    new DraftApiFailure('server', 'La configuración guardada no es compatible.'),
    { code: 'incompatible' as const },
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function renderReady(
  draftApi: DraftApi,
  options: {
    ref?: RefObject<RobotEditorHandle | null>;
    session?: AuthSession;
    paused?: boolean;
    onTry?: () => void;
    onAuthRequired?: ApiAuthRequired;
  } = {},
) {
  const view = render(
    <RobotEditor
      ref={options.ref}
      api={draftApi}
      session={options.session ?? session()}
      paused={options.paused}
      onTry={options.onTry}
      onAuthRequired={options.onAuthRequired}
    />,
  );
  await settle();
  expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();
  return view;
}

function editInstructions(value: string): void {
  fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
    target: { value },
  });
}

function instructionValue(): string {
  return (screen.getByLabelText('Qué debe tener en cuenta el robot') as HTMLTextAreaElement).value;
}

function expectQuietRecoveryIndicator(): void {
  expect(screen.getByText('Guardado pendiente: volveremos a intentarlo cada minuto')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reintentar guardado' })).toBeNull();
}

function openConflictComparisonIfCollapsed(): void {
  const compare = screen.queryByRole('button', { name: /Comparar versiones/i });
  if (compare && compare.getAttribute('aria-expanded') !== 'true') fireEvent.click(compare);
}

function clickUseStored(): void {
  openConflictComparisonIfCollapsed();
  fireEvent.click(
    screen.getByRole('button', { name: /^(?:Usar la versión guardada|Usar lo guardado)$/ }),
  );
}

function clickKeepMine(): void {
  openConflictComparisonIfCollapsed();
  fireEvent.click(
    screen.getByRole('button', { name: /^(?:Guardar mis cambios|Conservar mis cambios)$/ }),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RobotEditor phase 6 autosave acceptance', () => {
  it('loads once, debounces normal edits for 600 ms, and stops after confirming the visible draft', async () => {
    vi.useFakeTimers();
    const saved = { ...createDefaultDraft(), instructions: 'Texto confirmado' };
    const draftApi = api({
      putDraft: vi.fn<DraftApi['putDraft']>().mockResolvedValue(snapshot(1, saved)),
    });
    const onTry = vi.fn();
    await renderReady(draftApi, { onTry });

    expect(draftApi.getDraft).toHaveBeenCalledOnce();
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    await advance(120_000);
    expect(draftApi.getDraft).toHaveBeenCalledOnce();
    expect(draftApi.putDraft).not.toHaveBeenCalled();

    editInstructions(saved.instructions);
    expect(screen.getByText('Cambios pendientes')).toBeTruthy();
    expect(screen.queryByText(/cambios posteriores pendientes/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await advance(599);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    await advance(1);

    expect(draftApi.putDraft).toHaveBeenCalledOnce();
    expect(draftApi.putDraft.mock.calls[0]?.[0]).toBe(0);
    expect(draftApi.putDraft.mock.calls[0]?.[1]).toMatchObject({
      instructions: saved.instructions,
    });
    expect(screen.getByText('Guardado')).toBeTruthy();
    expect(onTry).not.toHaveBeenCalled();

    await advance(120_000);
    expect(draftApi.getDraft).toHaveBeenCalledOnce();
    expect(draftApi.putDraft).toHaveBeenCalledOnce();
  });

  it('recovers a transient initial GET after one minute without exposing defaults or a retry button', async () => {
    vi.useFakeTimers();
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockRejectedValueOnce(new DraftApiFailure('network', 'No se pudo cargar ahora.'))
      .mockResolvedValueOnce(snapshot());
    const draftApi = api({ getDraft });
    const view = render(<RobotEditor api={draftApi} session={session()} onTry={vi.fn()} />);
    await settle();

    expect(getDraft).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Qué debe tener en cuenta el robot')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('No se pudo cargar ahora.');
    expect(screen.queryByRole('button', { name: 'Reintentar carga' })).toBeNull();
    await advance(59_999);
    expect(getDraft).toHaveBeenCalledOnce();
    await advance(1);
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();
    await advance(120_000);
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps an incompatible stored draft as a definitive load error without periodic retry', async () => {
    vi.useFakeTimers();
    const getDraft = vi.fn<DraftApi['getDraft']>().mockRejectedValue(incompatibleDraftFailure());
    const draftApi = api({ getDraft });
    render(<RobotEditor api={draftApi} session={session()} />);
    await settle();

    expect(getDraft).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toContain(
      'La configuración guardada no es compatible.',
    );
    expect(screen.queryByLabelText('Qué debe tener en cuenta el robot')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reintentar carga' })).toBeNull();
    await advance(300_000);
    expect(getDraft).toHaveBeenCalledOnce();
    expect(draftApi.putDraft).not.toHaveBeenCalled();
  });

  it('keeps A in flight, preserves B, and sends B immediately when its debounce elapsed during A', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const draftA = { ...base, instructions: 'A' };
    const draftB = { ...base, instructions: 'B' };
    let resolveA!: (value: DraftSnapshot) => void;
    const pendingA = new Promise<DraftSnapshot>((resolve) => {
      resolveA = resolve;
    });
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementationOnce(async () => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        try {
          return await pendingA;
        } finally {
          activeWrites -= 1;
        }
      })
      .mockImplementationOnce(async (version: number, draft: RobotDraft) => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        try {
          return snapshot(version + 1, draft);
        } finally {
          activeWrites -= 1;
        }
      });
    const draftApi = api({ putDraft });
    await renderReady(draftApi);

    editInstructions(draftA.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.[0]).toBe(0);
    expect(putDraft.mock.calls[0]?.[1]).toMatchObject({ instructions: 'A' });

    editInstructions(draftB.instructions);
    await advance(30_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionValue()).toBe('B');

    await act(async () => {
      resolveA(snapshot(1, draftA));
      await pendingA;
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(1);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: 'B' });
    expect(instructionValue()).toBe('B');
    expect(screen.queryByText(/cambios posteriores pendientes/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(maximumActiveWrites).toBe(1);
  });

  it('keeps an uncertain write on the minute cadence through edits and flush, without exhausting after an hour', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const sentA = { ...base, instructions: 'A enviado' };
    const latest = { ...base, instructions: 'C vigente' };
    let recoveryReads = 0;
    let activeOperations = 0;
    let maximumActiveOperations = 0;
    const track = async <T,>(operation: () => Promise<T>): Promise<T> => {
      activeOperations += 1;
      maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
      try {
        return await operation();
      } finally {
        activeOperations -= 1;
      }
    };
    const getDraft = vi.fn<DraftApi['getDraft']>(() =>
      track(async () => {
        if (recoveryReads === 0) {
          recoveryReads += 1;
          return snapshot();
        }
        recoveryReads += 1;
        if (recoveryReads <= 61) {
          throw new DraftApiFailure('network', 'Lectura temporalmente no disponible');
        }
        return snapshot(1, sentA);
      }),
    );
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementationOnce(() =>
        track(async () => {
          throw new DraftApiFailure(
            'network',
            'Respuesta de escritura incierta',
            undefined,
            undefined,
            true,
          );
        }),
      )
      .mockImplementationOnce((version: number, draft: RobotDraft) =>
        track(async () => snapshot(version + 1, draft)),
      );
    const draftApi = api({ getDraft, putDraft });
    const editorRef = createRef<RobotEditorHandle>();
    const onTry = vi.fn();
    await renderReady(draftApi, { ref: editorRef, onTry });

    editInstructions(sentA.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(getDraft).toHaveBeenCalledOnce();
    expectQuietRecoveryIndicator();

    editInstructions('B vigente');
    await advance(30_000);
    editInstructions(latest.instructions);
    await settle();
    expect(await editorRef.current?.flushPending()).toBe(false);
    await advance(29_999);
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(onTry).not.toHaveBeenCalled();
    await advance(1);
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledOnce();
    expectQuietRecoveryIndicator();
    // More than sixty one-minute recovery cycles must still reach the server.
    for (let cycle = 0; cycle < 60; cycle += 1) {
      await advance(60_000);
    }

    expect(getDraft).toHaveBeenCalledTimes(62);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(1);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: latest.instructions });
    expect(instructionValue()).toBe(latest.instructions);
    expect(screen.getByText('Guardado')).toBeTruthy();
    expect(onTry).not.toHaveBeenCalled();
    expect(maximumActiveOperations).toBe(1);
  });

  it('processes one expired recovery cycle after several hours of suspension without a catch-up burst', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const local = { ...base, instructions: 'Recuperar después de suspender' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new DraftApiFailure('network', 'Lectura temporalmente no disponible'));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValue(
        new DraftApiFailure('network', 'Respuesta incierta', undefined, undefined, true),
      );
    const draftApi = api({ getDraft, putDraft });
    await renderReady(draftApi);

    editInstructions(local.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(getDraft).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1_000);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    await settle();

    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionValue()).toBe(local.instructions);
    expectQuietRecoveryIndicator();
  });

  it('fences base → uncertain A → base with a conditional write using the known version', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const sentA = { ...base, instructions: 'A' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot());
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Respuesta incierta', undefined, undefined, true),
      )
      .mockResolvedValueOnce(snapshot(1, base));
    const draftApi = api({ getDraft, putDraft });
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(draftApi, { ref: editorRef });

    editInstructions(sentA.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    editInstructions(base.instructions);
    await advance(600);
    expect(instructionValue()).toBe(base.instructions);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(getDraft).toHaveBeenCalledOnce();

    expect(await editorRef.current?.flushPending()).toBe(false);
    expect(await editorRef.current?.captureSnapshot()).toBeNull();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(getDraft).toHaveBeenCalledOnce();

    // The preceding edit check consumed 600 ms of the same recovery deadline.
    await advance(59_399);
    expect(getDraft).toHaveBeenCalledOnce();
    await advance(1);
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(0);
    expect(putDraft.mock.calls[1]?.[1]).toEqual(base);
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('incorporates an uncertain A version before automatically saving visible B', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const sentA = { ...base, instructions: 'A enviado' };
    const visibleB = { ...base, instructions: 'B posterior' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(7, sentA));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Respuesta incierta', undefined, undefined, true),
      )
      .mockImplementationOnce(async (version: number, draft: RobotDraft) =>
        snapshot(version + 1, draft),
      );
    const draftApi = api({ getDraft, putDraft });
    await renderReady(draftApi);

    editInstructions(sentA.instructions);
    await advance(600);
    editInstructions(visibleB.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionValue()).toBe(visibleB.instructions);

    await advance(60_000);
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(7);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: visibleB.instructions });
    expect(instructionValue()).toBe(visibleB.instructions);
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('recognizes A when B loses its conditional write and continues B at A’s version', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const sentA = { ...base, instructions: 'A incierto' };
    const visibleB = { ...base, instructions: 'B vigente' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot());
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Respuesta incierta', undefined, undefined, true),
      )
      .mockRejectedValueOnce(
        new DraftApiFailure('conflict', 'A llegó primero', 409, snapshot(1, sentA)),
      )
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const draftApi = api({ getDraft, putDraft });
    await renderReady(draftApi);

    editInstructions(sentA.instructions);
    await advance(600);
    editInstructions(visibleB.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();

    await advance(60_000);
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledTimes(3);
    expect(putDraft.mock.calls[1]?.[0]).toBe(0);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: visibleB.instructions });
    expect(putDraft.mock.calls[2]?.[0]).toBe(1);
    expect(putDraft.mock.calls[2]?.[1]).toMatchObject({ instructions: visibleB.instructions });
    expect(screen.queryByText('Conflicto de edición')).toBeNull();
    expect(instructionValue()).toBe(visibleB.instructions);
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it.each([
    ['same-version', 2],
    ['lower-version', 1],
  ] as const)(
    'keeps an incoherent %s read uncertain and waits for a usable read before PUT',
    async (_kind, incoherentVersion) => {
      vi.useFakeTimers();
      const base = createDefaultDraft();
      const sentA = { ...base, instructions: 'A incierto' };
      const visibleB = { ...base, instructions: 'B vigente' };
      const inconsistent = { ...base, instructions: 'Lectura incoherente' };
      const getDraft = vi
        .fn<DraftApi['getDraft']>()
        .mockResolvedValueOnce(snapshot(2))
        .mockResolvedValueOnce(snapshot(incoherentVersion, inconsistent))
        .mockResolvedValueOnce(snapshot(2));
      const putDraft = vi
        .fn<DraftApi['putDraft']>()
        .mockRejectedValueOnce(
          new DraftApiFailure('network', 'Respuesta incierta', undefined, undefined, true),
        )
        .mockResolvedValueOnce(snapshot(3, visibleB));
      const draftApi = api({ getDraft, putDraft });
      await renderReady(draftApi);

      editInstructions(sentA.instructions);
      await advance(600);
      editInstructions(visibleB.instructions);
      await advance(600);
      expect(putDraft).toHaveBeenCalledOnce();

      // Reach exactly one minute from the failed PUT, including the 600 ms edit check.
      await advance(59_400);
      expect(getDraft).toHaveBeenCalledTimes(2);
      expect(putDraft).toHaveBeenCalledOnce();
      expect(instructionValue()).toBe(visibleB.instructions);
      expectQuietRecoveryIndicator();
      await advance(59_999);
      expect(getDraft).toHaveBeenCalledTimes(2);
      expect(putDraft).toHaveBeenCalledOnce();
      await advance(1);

      expect(getDraft).toHaveBeenCalledTimes(3);
      expect(putDraft).toHaveBeenCalledTimes(2);
      expect(putDraft.mock.calls[1]?.[0]).toBe(2);
      expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: visibleB.instructions });
      expect(screen.getByText('Guardado')).toBeTruthy();
    },
  );

  it('stops at a third-party version until the user resolves the conflict against the shown version', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const local = { ...base, instructions: 'Mis cambios' };
    const remote = { ...base, instructions: 'Cambios de otra pestaña' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(4, remote));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Respuesta incierta', undefined, undefined, true),
      )
      .mockResolvedValueOnce(snapshot(5, local));
    const draftApi = api({ getDraft, putDraft });
    await renderReady(draftApi);

    editInstructions(local.instructions);
    await advance(600);
    await advance(60_000);

    expect(screen.getByText('Conflicto de edición')).toBeTruthy();
    openConflictComparisonIfCollapsed();
    expect(screen.getByText(remote.instructions)).toBeTruthy();
    expect(instructionValue()).toBe(local.instructions);
    expect(putDraft).toHaveBeenCalledOnce();

    await advance(300_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Reintentar guardado' })).toBeNull();
    clickKeepMine();
    await advance(600);

    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(4);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: local.instructions });
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('rechecks the remote version before discarding, and asks again if it changed', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const local = { ...base, instructions: 'Conservar hasta confirmar' };
    const firstRemote = { ...base, instructions: 'Remoto al comparar' };
    const newerRemote = { ...base, instructions: 'Remoto actualizado' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(4, firstRemote))
      .mockResolvedValueOnce(snapshot(5, newerRemote))
      .mockResolvedValueOnce(snapshot(5, newerRemote));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Respuesta incierta', undefined, undefined, true),
      );
    const draftApi = api({ getDraft, putDraft });
    await renderReady(draftApi);

    editInstructions(local.instructions);
    await advance(600);
    await advance(60_000);
    expect(screen.getByText('Conflicto de edición')).toBeTruthy();
    openConflictComparisonIfCollapsed();
    expect(screen.getByText(firstRemote.instructions)).toBeTruthy();

    clickUseStored();
    await settle();
    expect(getDraft).toHaveBeenCalledTimes(3);
    expect(instructionValue()).toBe(local.instructions);
    openConflictComparisonIfCollapsed();
    expect(screen.getByText(newerRemote.instructions)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^(?:Usar la versión guardada|Usar lo guardado)$/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^(?:Guardar mis cambios|Conservar mis cambios)$/ }),
    ).toBeTruthy();
    expect(putDraft).toHaveBeenCalledOnce();

    clickUseStored();
    await settle();
    expect(getDraft).toHaveBeenCalledTimes(4);
    expect(instructionValue()).toBe(newerRemote.instructions);
    expect(putDraft).toHaveBeenCalledOnce();
  });

  it('keeps my changes conditional on the shown version and requires a second choice after another 409', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const local = { ...base, instructions: 'Mis cambios locales' };
    const firstRemote = { ...base, instructions: 'Primera versión remota' };
    const newerRemote = { ...base, instructions: 'Otra versión remota' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(3, firstRemote));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Respuesta incierta', undefined, undefined, true),
      )
      .mockRejectedValueOnce(
        new DraftApiFailure('conflict', 'Cambió otra vez', 409, snapshot(4, newerRemote)),
      )
      .mockResolvedValueOnce(snapshot(5, local));
    const draftApi = api({ getDraft, putDraft });
    await renderReady(draftApi);

    editInstructions(local.instructions);
    await advance(600);
    await advance(60_000);
    openConflictComparisonIfCollapsed();
    expect(screen.getByText(firstRemote.instructions)).toBeTruthy();

    clickKeepMine();
    await advance(600);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(3);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: local.instructions });
    expect(instructionValue()).toBe(local.instructions);
    expect(screen.getByText('Conflicto de edición')).toBeTruthy();
    openConflictComparisonIfCollapsed();
    expect(screen.getByText(newerRemote.instructions)).toBeTruthy();

    await advance(300_000);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(getDraft).toHaveBeenCalledTimes(2);
    clickKeepMine();
    await advance(600);

    expect(putDraft).toHaveBeenCalledTimes(3);
    expect(putDraft.mock.calls[2]?.[0]).toBe(4);
    expect(putDraft.mock.calls[2]?.[1]).toMatchObject({ instructions: local.instructions });
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('pauses a definitive validation failure until a corrected edit resumes automatic saving', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const corrected = { ...base, instructions: 'Texto corregido' };
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(new DraftApiFailure('invalid', 'El servidor rechazó este texto.', 400))
      .mockResolvedValueOnce(snapshot(1, corrected));
    const draftApi = api({ putDraft });
    await renderReady(draftApi);

    editInstructions('Texto rechazado');
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toContain('El servidor rechazó este texto.');
    await advance(300_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Reintentar guardado' })).toBeNull();

    editInstructions(corrected.instructions);
    await advance(599);
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(1);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(0);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: corrected.instructions });
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('pauses on rejected access, then resumes the same identity without losing edits or retrying during the pause', async () => {
    vi.useFakeTimers();
    const local = { ...createDefaultDraft(), instructions: 'Conservar mientras vuelve el acceso' };
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure(
          'authentication',
          'El acceso a la API fue rechazado.',
          403,
          undefined,
          false,
          {
            authContext: 23,
          },
        ),
      )
      .mockResolvedValueOnce(snapshot(1, local));
    const draftApi = api({ putDraft });
    const onAuthRequired = vi.fn();
    const view = await renderReady(draftApi, { onAuthRequired });

    editInstructions(local.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(onAuthRequired).toHaveBeenCalledWith(23);
    view.rerender(
      <RobotEditor api={draftApi} session={session()} paused onAuthRequired={onAuthRequired} />,
    );
    await settle();
    await advance(300_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionValue()).toBe(local.instructions);

    view.rerender(
      <RobotEditor api={draftApi} session={session()} onAuthRequired={onAuthRequired} />,
    );
    await settle();
    await advance(600);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: local.instructions });
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('reevaluates a stale rejected access automatically within one minute for the same draft owner', async () => {
    vi.useFakeTimers();
    const owner = session('subject-a');
    const local = { ...createDefaultDraft(), instructions: 'Texto y dueño conservados' };
    let accessRefreshed = false;
    const tokenProvider = vi.fn(() =>
      accessRefreshed
        ? { accessToken: 'token-current', authContext: 24 }
        : { accessToken: 'token-stale', authContext: 23 },
    );
    const authHeaders: string[] = [];
    const fetchDraft = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        authHeaders.push(new Headers(init?.headers).get('Authorization') ?? '');
        return new Response(JSON.stringify(snapshot()), { status: 200 });
      })
      .mockImplementationOnce(async (_input, init) => {
        authHeaders.push(new Headers(init?.headers).get('Authorization') ?? '');
        return new Response(JSON.stringify({ message: 'stale rejection' }), { status: 403 });
      })
      .mockImplementationOnce(async (_input, init) => {
        authHeaders.push(new Headers(init?.headers).get('Authorization') ?? '');
        return new Response(JSON.stringify(snapshot(1, local)), { status: 200 });
      });
    const draftApi = createDraftApiClient(
      { apiBaseUrl: 'https://api.example.test/' },
      tokenProvider,
      fetchDraft,
    );
    const onAuthRequired = vi.fn((authContext?: number) => {
      expect(authContext).toBe(23);
      accessRefreshed = true;
      return false;
    });
    await renderReady(draftApi, { session: owner, onAuthRequired });

    editInstructions(local.instructions);
    await advance(600);
    expect(fetchDraft.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchDraft.mock.calls.length).toBeLessThanOrEqual(3);
    expect(tokenProvider).toHaveBeenCalledTimes(fetchDraft.mock.calls.length);
    expect(onAuthRequired).toHaveBeenCalledOnce();
    expect(instructionValue()).toBe(local.instructions);
    expect(owner.identity.sub).toBe('subject-a');

    // A stale context may be reevaluated immediately or by the next cycle.
    await advance(60_000);

    expect(fetchDraft).toHaveBeenCalledTimes(3);
    expect(tokenProvider).toHaveBeenCalledTimes(3);
    expect(authHeaders).toEqual([
      'Bearer token-stale',
      'Bearer token-stale',
      'Bearer token-current',
    ]);
    expect(instructionValue()).toBe(local.instructions);
    expect(screen.getByText('Guardado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /reintentar/i })).toBeNull();
    await advance(120_000);
    expect(fetchDraft).toHaveBeenCalledTimes(3);
  });

  it('aborts an in-flight write on pause and reconciles its outcome before further writes on resume', async () => {
    vi.useFakeTimers();
    const draftA = { ...createDefaultDraft(), instructions: 'A durante la pausa' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(1, draftA));
    let resolveA!: (value: DraftSnapshot) => void;
    const pendingA = new Promise<DraftSnapshot>((resolve) => {
      resolveA = resolve;
    });
    let saveSignal: AbortSignal | undefined;
    const putDraft = vi.fn<DraftApi['putDraft']>((_version, _draft, signal) => {
      saveSignal = signal;
      return pendingA;
    });
    const draftApi = api({ getDraft, putDraft });
    const view = await renderReady(draftApi);

    editInstructions(draftA.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    view.rerender(<RobotEditor api={draftApi} session={session()} paused />);
    await settle();
    expect(saveSignal?.aborted).toBe(true);
    await act(async () => {
      resolveA(snapshot(1, draftA));
      await pendingA;
      await Promise.resolve();
    });
    expect(screen.queryByText('Guardado')).toBeNull();
    await advance(300_000);
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();

    view.rerender(<RobotEditor api={draftApi} session={session()} />);
    await settle();
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionValue()).toBe(draftA.instructions);
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('ignores an old identity’s in-flight response and never saves its text under the new identity', async () => {
    vi.useFakeTimers();
    const oldBase = createDefaultDraft();
    const newRemote = { ...oldBase, instructions: 'Borrador de la nueva cuenta' };
    let resolveOldPut!: (value: DraftSnapshot) => void;
    const oldPut = new Promise<DraftSnapshot>((resolve) => {
      resolveOldPut = resolve;
    });
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(9, newRemote));
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValueOnce(oldPut);
    const draftApi = api({ getDraft, putDraft });
    const view = await renderReady(draftApi, { session: session('subject-a') });

    editInstructions('Texto de la cuenta anterior');
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    view.rerender(<RobotEditor api={draftApi} session={session('subject-b')} />);
    await settle();
    expect(instructionValue()).toBe(newRemote.instructions);

    await act(async () => {
      resolveOldPut(snapshot(1, { ...oldBase, instructions: 'Texto de la cuenta anterior' }));
      await oldPut;
      await Promise.resolve();
      await Promise.resolve();
    });
    await advance(300_000);
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionValue()).toBe(newRemote.instructions);
  });

  it('cancels a queued recovery after discard and after unmount', async () => {
    vi.useFakeTimers();
    const local = { ...createDefaultDraft(), instructions: 'Pendiente' };
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValue(new DraftApiFailure('server', 'Fallo temporal'));
    const draftApi = api({ putDraft });
    const editorRef = createRef<RobotEditorHandle>();
    const view = await renderReady(draftApi, { ref: editorRef });

    editInstructions(local.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    editorRef.current?.discardPending();
    await advance(300_000);
    expect(draftApi.getDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();
    view.unmount();

    await renderReady(draftApi);
    editInstructions(local.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledTimes(2);
    cleanup();
    await advance(300_000);
    expect(draftApi.getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledTimes(2);
  });

  it('invalidates a sent write and queued edits when the draft is explicitly discarded', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    let resolveA!: (value: DraftSnapshot) => void;
    const pendingA = new Promise<DraftSnapshot>((resolve) => {
      resolveA = resolve;
    });
    let saveSignal: AbortSignal | undefined;
    const putDraft = vi.fn<DraftApi['putDraft']>((_version, _draft, signal) => {
      saveSignal = signal;
      return pendingA;
    });
    const draftApi = api({ putDraft });
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(draftApi, { ref: editorRef });

    editInstructions('A en vuelo');
    await advance(600);
    editInstructions('B posterior');
    editorRef.current?.discardPending();
    expect(saveSignal?.aborted).toBe(true);
    await act(async () => {
      resolveA(snapshot(1, { ...base, instructions: 'A en vuelo' }));
      await pendingA;
      await Promise.resolve();
      await Promise.resolve();
    });
    await advance(300_000);

    expect(draftApi.getDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();
  });
});
