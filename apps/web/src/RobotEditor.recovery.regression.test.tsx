// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { createRef, type RefObject } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDefaultDraft, type DraftSnapshot, type RobotDraft } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { DraftApiFailure, type DraftApi } from './draft-api.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';

type DraftApiMock = {
  getDraft: Mock<DraftApi['getDraft']>;
  putDraft: Mock<DraftApi['putDraft']>;
};

function session(): AuthSession {
  return {
    identity: { sub: 'regression-owner', email: 'regression-owner@example.test' },
    user: new User({
      access_token: 'regression-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client-public',
        iat: 1,
        exp: 9_999_999_999,
        sub: 'regression-owner',
        email: 'regression-owner@example.test',
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

async function renderReady(draftApi: DraftApi, ref?: RefObject<RobotEditorHandle | null>) {
  const view = render(<RobotEditor ref={ref} api={draftApi} session={session()} />);
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

function openConflictComparison(): void {
  const compare = screen.queryByRole('button', { name: /Comparar versiones/i });
  if (compare && compare.getAttribute('aria-expanded') !== 'true') fireEvent.click(compare);
}

function clickUseStored(): void {
  openConflictComparison();
  fireEvent.click(
    screen.getByRole('button', { name: /Usar (?:la versión guardada|lo guardado)/i }),
  );
}

function clickKeepMine(): HTMLButtonElement {
  openConflictComparison();
  const button = screen.getByRole('button', {
    name: /Conservar mis cambios/i,
  }) as HTMLButtonElement;
  fireEvent.click(button);
  return button;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RobotEditor recovery regressions', () => {
  it('keeps a confirmed candidate failure clean, then saves a later edit at the original minute', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const candidate = { ...base, instructions: 'Candidato no aplicado' };
    const later = { ...base, instructions: 'Edición durante la espera' };
    const getDraft = vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(7, base));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('rate_limited', 'Volvé a intentar más tarde.', 429),
      )
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    const draftApi = api({ getDraft, putDraft });
    await renderReady(draftApi, editorRef);

    let applied: boolean | undefined;
    await act(async () => {
      applied = await editorRef.current?.applyDraft(candidate);
    });

    expect(applied).toBe(false);
    expect(instructionValue()).toBe(base.instructions);
    expect(screen.queryByText(candidate.instructions)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Guardado')).toBeTruthy();
    expect(editorRef.current?.hasUnconfirmedChanges()).toBe(false);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.[0]).toBe(7);
    expect(await editorRef.current?.waitForConfirmed(new AbortController().signal)).toBe(true);
    await expect(editorRef.current?.captureSnapshot()).resolves.toMatchObject({
      version: 7,
      draft: base,
    });
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();

    await advance(30_000);
    expect(screen.getByText('Guardado')).toBeTruthy();
    editInstructions(later.instructions);
    expect(instructionValue()).toBe(later.instructions);
    expect(
      screen.getByText('Guardado pendiente: volveremos a intentarlo cada minuto'),
    ).toBeTruthy();
    await advance(29_999);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(getDraft).toHaveBeenCalledOnce();
    await advance(1);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(7);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: later.instructions });
    expect(draftApi.getDraft).toHaveBeenCalledOnce();
    expect(screen.getByText('Guardado')).toBeTruthy();
    expect(screen.queryByText(candidate.instructions)).toBeNull();
  });

  it('joins the active visible PUT to capture its confirmed positive snapshot', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const visible = { ...base, instructions: 'Visible A en curso' };
    let resolveSave!: (value: DraftSnapshot) => void;
    const pendingSave = new Promise<DraftSnapshot>((resolve) => {
      resolveSave = resolve;
    });
    const putDraft = vi.fn<DraftApi['putDraft']>().mockImplementationOnce(() => pendingSave);
    const editorRef = createRef<RobotEditorHandle>();
    const draftApi = api({
      getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(1, base)),
      putDraft,
    });
    await renderReady(draftApi, editorRef);

    editInstructions(visible.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();

    let capturedPromise!: Promise<DraftSnapshot | null>;
    await act(async () => {
      capturedPromise = editorRef.current!.captureSnapshot();
      await settle();
    });
    await act(async () => {
      resolveSave(snapshot(2, visible));
      await pendingSave;
    });

    await expect(capturedPromise).resolves.toMatchObject({ version: 2, draft: visible });
    expect(putDraft).toHaveBeenCalledOnce();
    expect(draftApi.getDraft).toHaveBeenCalledOnce();
  });

  it('flushes a prior visible PUT before saving the frozen newer draft for capture', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const visibleA = { ...base, instructions: 'Visible A en curso' };
    const capturedB = { ...base, instructions: 'B congelada para captura' };
    let resolveA!: (value: DraftSnapshot) => void;
    const pendingA = new Promise<DraftSnapshot>((resolve) => {
      resolveA = resolve;
    });
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(pendingA)
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    const draftApi = api({ putDraft });
    await renderReady(draftApi, editorRef);

    editInstructions(visibleA.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    editInstructions(capturedB.instructions);

    let capturedPromise!: Promise<DraftSnapshot | null>;
    await act(async () => {
      capturedPromise = editorRef.current!.captureSnapshot();
      await settle();
    });
    expect(putDraft).toHaveBeenCalledOnce();

    await act(async () => {
      resolveA(snapshot(1, visibleA));
      await pendingA;
      await settle();
    });

    await expect(capturedPromise).resolves.toMatchObject({ version: 2, draft: capturedB });
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(1);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: capturedB.instructions });
    expect(draftApi.getDraft).toHaveBeenCalledOnce();
  });

  it('rejects an A snapshot when B changes during its joined PUT, then leaves B to normal debounce', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const visibleA = { ...base, instructions: 'Visible A en curso' };
    const visibleB = { ...base, instructions: 'Edición B posterior' };
    let resolveSave!: (value: DraftSnapshot) => void;
    const pendingSave = new Promise<DraftSnapshot>((resolve) => {
      resolveSave = resolve;
    });
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementationOnce(() => pendingSave)
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    const draftApi = api({
      getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(1, base)),
      putDraft,
    });
    await renderReady(draftApi, editorRef);

    editInstructions(visibleA.instructions);
    await advance(600);
    let capturedPromise!: Promise<DraftSnapshot | null>;
    await act(async () => {
      capturedPromise = editorRef.current!.captureSnapshot();
      await settle();
    });

    editInstructions(visibleB.instructions);
    await act(async () => {
      resolveSave(snapshot(2, visibleA));
      await pendingSave;
    });

    await expect(capturedPromise).resolves.toBeNull();
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(599);
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(1);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(2);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: visibleB.instructions });
    expect(instructionValue()).toBe(visibleB.instructions);
  });

  it('saves a later visible edit after candidate rate limiting, never the candidate', async () => {
    vi.useFakeTimers();
    const candidate = { ...createDefaultDraft(), instructions: 'Candidato rechazado' };
    const later = { ...createDefaultDraft(), instructions: 'Edición visible posterior' };
    let rejectCandidate!: (error: DraftApiFailure) => void;
    const pendingCandidate = new Promise<DraftSnapshot>((_resolve, reject) => {
      rejectCandidate = reject;
    });
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementationOnce(() => pendingCandidate)
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    const draftApi = api({ putDraft });
    await renderReady(draftApi, editorRef);

    let applied: boolean | undefined;
    let applyPromise!: Promise<boolean>;
    await act(async () => {
      applyPromise = editorRef.current!.applyDraft(candidate);
      await settle();
    });
    expect(putDraft).toHaveBeenCalledOnce();

    editInstructions(later.instructions);
    expect(instructionValue()).toBe(later.instructions);
    await act(async () => {
      rejectCandidate(new DraftApiFailure('rate_limited', 'Demasiadas solicitudes.', 429));
      applied = await applyPromise;
    });

    expect(applied).toBe(false);
    expect(instructionValue()).toBe(later.instructions);
    expect(screen.queryByText(candidate.instructions)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(59_999);
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(1);

    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(0);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: later.instructions });
    expect(putDraft.mock.calls[1]?.[1]).not.toMatchObject({ instructions: candidate.instructions });
    expect(instructionValue()).toBe(later.instructions);
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('recognizes an ancestor through three uncertain conditional writes', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const draftA = { ...base, instructions: 'Ancestro A' };
    const draftB = { ...base, instructions: 'Ancestro B' };
    const draftC = { ...base, instructions: 'Visible C' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(1, draftB));
    const ambiguous = () =>
      new DraftApiFailure('network', 'Respuesta no confirmada.', undefined, undefined, true);
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(ambiguous())
      .mockRejectedValueOnce(ambiguous())
      .mockRejectedValueOnce(ambiguous())
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const draftApi = api({ getDraft, putDraft });
    await renderReady(draftApi);

    editInstructions(draftA.instructions);
    await advance(600);
    editInstructions(draftB.instructions);
    await advance(600);
    await advance(59_400);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(0);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: draftB.instructions });

    editInstructions(draftC.instructions);
    await advance(600);
    await advance(59_400);
    expect(putDraft).toHaveBeenCalledTimes(3);
    expect(putDraft.mock.calls[2]?.[0]).toBe(0);
    expect(putDraft.mock.calls[2]?.[1]).toMatchObject({ instructions: draftC.instructions });

    await advance(60_000);
    expect(getDraft).toHaveBeenCalledTimes(4);
    expect(putDraft).toHaveBeenCalledTimes(4);
    expect(putDraft.mock.calls[3]?.[0]).toBe(1);
    expect(putDraft.mock.calls[3]?.[1]).toMatchObject({ instructions: draftC.instructions });
    expect(instructionValue()).toBe(draftC.instructions);
    expect(screen.queryByText('Conflicto de edición')).toBeNull();
    expect(screen.getByText('Guardado')).toBeTruthy();
  });

  it('clears a pending stored-version check when paused so the conflict can be resolved after resume', async () => {
    vi.useFakeTimers();
    const local = { ...createDefaultDraft(), instructions: 'Borrador local' };
    const remote = { ...createDefaultDraft(), instructions: 'Versión remota' };
    let resolveStoredCheck!: (value: DraftSnapshot) => void;
    const storedCheck = new Promise<DraftSnapshot>((resolve) => {
      resolveStoredCheck = resolve;
    });
    let storedCheckSignal: AbortSignal | undefined;
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(2, remote))
      .mockImplementationOnce((signal) => {
        storedCheckSignal = signal;
        return storedCheck;
      });
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Respuesta no confirmada.', undefined, undefined, true),
      )
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const draftApi = api({ getDraft, putDraft });
    const view = await renderReady(draftApi);

    editInstructions(local.instructions);
    await advance(600);
    await advance(60_000);
    expect(screen.getByText('Conflicto de edición')).toBeTruthy();

    clickUseStored();
    await settle();
    expect(getDraft).toHaveBeenCalledTimes(3);

    view.rerender(<RobotEditor api={draftApi} session={session()} paused />);
    await settle();
    expect(storedCheckSignal?.aborted).toBe(true);
    view.rerender(<RobotEditor api={draftApi} session={session()} />);
    await settle();
    const keepMine = screen.getByRole('button', {
      name: /Conservar mis cambios/i,
    }) as HTMLButtonElement;
    expect(keepMine.disabled).toBe(false);

    clickKeepMine();
    await advance(600);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(2);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: local.instructions });

    await act(async () => {
      resolveStoredCheck(snapshot(2, remote));
      await storedCheck;
      await settle();
    });
    expect(instructionValue()).toBe(local.instructions);
    expect(screen.getByText('Guardado')).toBeTruthy();
    expect(getDraft).toHaveBeenCalledTimes(3);
  });
});
