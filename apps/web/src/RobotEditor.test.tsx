// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type DraftSnapshot, type RobotDraft } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { DraftApiFailure, type DraftApi } from './draft-api.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';

function session(
  email = 'a@example.com',
  _expiresAt = Math.floor(Date.now() / 1000) + 600,
  accessToken = 'access-token',
  sub = 'subject-a',
): AuthSession {
  return {
    identity: { sub, email },
    user: new User({
      access_token: accessToken,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client-public',
        iat: 1,
        exp: 9999999999,
        sub,
        email,
      },
      expires_at: _expiresAt,
    }),
  };
}

function snapshot(version = 0, draft: RobotDraft = createDefaultDraft()): DraftSnapshot {
  return { version, draft };
}

function api(overrides: Partial<DraftApi> = {}): DraftApi {
  return {
    getDraft: vi.fn().mockResolvedValue(snapshot()),
    putDraft: vi.fn().mockResolvedValue(snapshot(1)),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RobotEditor', () => {
  it('loads the server draft and keeps the literal initial instructions visible', async () => {
    render(<RobotEditor api={api()} session={session()} />);

    expect(
      await screen.findByDisplayValue(
        'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
      ),
    ).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Avanzar' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole('checkbox', { name: 'Retroceder' }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect((screen.getByRole('checkbox', { name: 'Esperar' }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      (screen.getByLabelText('Modelo para el próximo intento') as HTMLSelectElement).value,
    ).toBe('claude-sonnet-4.6');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('Guardado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Probar/i })).toBeNull();
  });

  it('lets the player enable and describe Esperar', async () => {
    const putDraft = vi.fn().mockImplementation(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    }));
    const { container } = render(<RobotEditor api={api({ putDraft })} session={session()} />);

    const waitToggle = (await screen.findByRole('checkbox', {
      name: 'Esperar',
    })) as HTMLInputElement;
    expect(waitToggle.checked).toBe(false);
    fireEvent.click(waitToggle);
    fireEvent.change(container.querySelector('#skill-description-wait') as HTMLTextAreaElement, {
      target: { value: 'Avanzá cuando convenga; esperá si el terreno va a cambiar.' },
    });

    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce(), { timeout: 2_000 });
    const sent = putDraft.mock.calls[0]?.[1] as RobotDraft;
    expect(sent.skills.find((skill) => skill.id === 'wait')).toMatchObject({
      enabled: true,
      description: 'Avanzá cuando convenga; esperá si el terreno va a cambiar.',
    });
  });

  it('keeps the current model fixed and disables the selector as an attempt starts', async () => {
    const editorRef = createRef<RobotEditorHandle>();
    const onTry = vi.fn();
    render(<RobotEditor ref={editorRef} api={api()} session={session()} onTry={onTry} />);
    const selector = await screen.findByLabelText('Modelo para el próximo intento');
    expect((selector as HTMLSelectElement).value).toBe('claude-sonnet-4.6');
    expect((screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    expect(onTry).toHaveBeenCalledOnce();
    expect((selector as HTMLSelectElement).disabled).toBe(true);
  });

  it('captures the visible default and persists version zero before returning the attempt snapshot', async () => {
    const putDraft = vi.fn().mockResolvedValue(snapshot(1));
    const editorRef = createRef<RobotEditorHandle>();
    render(<RobotEditor ref={editorRef} api={api({ putDraft })} session={session()} locked />);

    const instructions = await screen.findByDisplayValue(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    expect((instructions.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);

    let captured: DraftSnapshot | null = null;
    await act(async () => {
      captured = (await editorRef.current?.captureSnapshot()) ?? null;
    });

    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.[0]).toBe(0);
    expect(putDraft.mock.calls[0]?.[1].instructions).toBe(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    expect(captured).not.toBeNull();
    const result = captured as unknown as DraftSnapshot;
    expect(result.version).toBe(1);
    expect(result.draft.instructions).toBe(putDraft.mock.calls[0]?.[1].instructions);
  });

  it('debounces edits, allows one write in flight, and sends later text over the confirmed version', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: DraftSnapshot) => void;
    const first = new Promise<DraftSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const putDraft = vi.fn().mockReturnValueOnce(first).mockResolvedValue(snapshot(2));
    const draftApi = api({ putDraft });
    render(<RobotEditor api={draftApi} session={session()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const instructions = screen.getByLabelText('Qué debe tener en cuenta el robot');
    fireEvent.change(instructions, { target: { value: 'A' } });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(putDraft.mock.calls[0]?.[0]).toBe(0);
    expect(putDraft.mock.calls[0]?.[1]).toMatchObject({ instructions: 'A' });

    fireEvent.change(instructions, { target: { value: 'B' } });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(putDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(snapshot(1, { ...createDefaultDraft(), instructions: 'A' }));
      await first;
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(1);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: 'B' });
  });

  it('stops on a conflict and offers both explicit resolution actions', async () => {
    const remoteBase = createDefaultDraft();
    const remote = {
      ...remoteBase,
      instructions: 'Versión de la otra pestaña',
      skills: remoteBase.skills.map((skill) =>
        skill.id === 'retreat' ? { ...skill, enabled: true, description: 'Volvé' } : skill,
      ),
    };
    const draftApi = api({
      putDraft: vi
        .fn()
        .mockRejectedValue(new DraftApiFailure('conflict', 'conflict', 409, snapshot(1, remote))),
    });
    render(<RobotEditor api={draftApi} session={session()} />);
    await screen.findByDisplayValue(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Mi versión' },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(
      await screen.findByRole('heading', { name: 'Hay una versión guardada en otra pestaña' }),
    ).toBeTruthy();
    expect(
      screen
        .getAllByRole('listitem')
        .some(
          (item) => item.textContent?.includes('Retroceder') && item.textContent?.includes('Volvé'),
        ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Usar la versión guardada' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Guardar mis cambios' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Otra edición local antes de resolver' },
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(draftApi.putDraft).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Usar la versión guardada' }));
    expect(screen.getByDisplayValue('Versión de la otra pestaña')).toBeTruthy();
  });

  it('reconciles a successful PUT whose response was lost without overwriting newer edits', async () => {
    const sent = {
      ...createDefaultDraft(),
      instructions: 'Guardado aunque se perdió la respuesta',
    };
    const draftApi = api({
      putDraft: vi
        .fn()
        .mockRejectedValue(new DraftApiFailure('network', 'timeout', undefined, undefined, true)),
      getDraft: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot(1, sent)),
    });
    render(<RobotEditor api={draftApi} session={session()} />);
    await waitFor(() => expect(draftApi.getDraft).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Qué debe tener en cuenta el robot') as HTMLTextAreaElement).value,
      ).toBe('Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo'),
    );
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: sent.instructions },
    });
    await waitFor(() => expect(draftApi.putDraft).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await waitFor(() => expect(draftApi.getDraft).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await waitFor(() => expect(screen.getByText('Guardado')).toBeTruthy(), { timeout: 2_000 });
    expect(draftApi.getDraft).toHaveBeenCalledTimes(2);
    expect(screen.getByDisplayValue(sent.instructions)).toBeTruthy();
  });

  it('shows a retry for an initial load failure without exposing editable defaults', async () => {
    const getDraft = vi
      .fn()
      .mockRejectedValueOnce(new DraftApiFailure('network', 'offline'))
      .mockResolvedValueOnce(snapshot());
    const draftApi = api({ getDraft });
    render(<RobotEditor api={draftApi} session={session()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('offline');
    expect(screen.queryByLabelText('Qué debe tener en cuenta el robot')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar carga' }));
    expect(await screen.findByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();
    expect(getDraft).toHaveBeenCalledTimes(2);
  });

  it('blocks the editor when the persisted draft is incompatible instead of showing defaults', async () => {
    const draftApi = api({
      getDraft: vi
        .fn()
        .mockRejectedValue(new DraftApiFailure('server', 'La versión guardada no es compatible.')),
    });
    render(<RobotEditor api={draftApi} session={session()} />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'La versión guardada no es compatible.',
    );
    expect(screen.queryByLabelText('Qué debe tener en cuenta el robot')).toBeNull();
  });

  it('warns before leaving while edits are unconfirmed and clears the warning after save', async () => {
    const saved = { ...createDefaultDraft(), instructions: 'Texto pendiente' };
    const draftApi = api({ putDraft: vi.fn().mockResolvedValue(snapshot(1, saved)) });
    render(<RobotEditor api={draftApi} session={session()} />);
    await screen.findByDisplayValue(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Texto pendiente' },
    });
    const pendingEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pendingEvent);
    expect(pendingEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByText('Guardado')).toBeTruthy(), { timeout: 2_000 });
    const savedEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savedEvent);
    expect(savedEvent.defaultPrevented).toBe(false);
  });

  it('keeps a reversion pending while the previous PUT is in flight and saves it after A', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const draftA = { ...base, instructions: 'A' };
    let resolveA!: (value: DraftSnapshot) => void;
    const firstPut = new Promise<DraftSnapshot>((resolve) => {
      resolveA = resolve;
    });
    const putDraft = vi.fn().mockReturnValueOnce(firstPut).mockResolvedValueOnce(snapshot(2, base));
    const draftApi = api({ putDraft });
    render(<RobotEditor api={draftApi} session={session()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const instructions = screen.getByLabelText('Qué debe tener en cuenta el robot');
    fireEvent.change(instructions, { target: { value: draftA.instructions } });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.change(instructions, { target: { value: base.instructions } });
    const pendingEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pendingEvent);
    expect(pendingEvent.defaultPrevented).toBe(true);
    await act(async () => {
      resolveA(snapshot(1, draftA));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(1);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: base.instructions });
  });

  it('cancels the queued follow-up when unmounted after A confirms with B pending', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    let resolveA!: (value: DraftSnapshot) => void;
    const firstPut = new Promise<DraftSnapshot>((resolve) => {
      resolveA = resolve;
    });
    const putDraft = vi.fn().mockReturnValueOnce(firstPut).mockResolvedValueOnce(snapshot(2));
    const draftApi = api({ putDraft });
    const view = render(<RobotEditor api={draftApi} session={session()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const instructions = screen.getByLabelText('Qué debe tener en cuenta el robot');
    fireEvent.change(instructions, { target: { value: 'A' } });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.change(instructions, { target: { value: 'B' } });
    await act(async () => {
      resolveA(snapshot(1, { ...base, instructions: 'A' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(putDraft).toHaveBeenCalledOnce();
  });

  it('retries failed reconciliation with GET before considering another PUT', async () => {
    const sent = { ...createDefaultDraft(), instructions: 'A' };
    const getDraft = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new DraftApiFailure('network', 'offline'))
      .mockResolvedValueOnce(snapshot(1, sent));
    const putDraft = vi
      .fn()
      .mockRejectedValue(new DraftApiFailure('server', 'ambiguous', undefined, undefined, true));
    const draftApi = api({ getDraft, putDraft });
    render(<RobotEditor api={draftApi} session={session()} />);
    await screen.findByDisplayValue(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: sent.instructions },
    });
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await waitFor(() => expect(getDraft).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const pendingEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pendingEvent);
    expect(pendingEvent.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }));
    await waitFor(() => expect(getDraft).toHaveBeenCalledTimes(3), { timeout: 2_000 });
    expect(putDraft).toHaveBeenCalledOnce();
    expect(await screen.findByText('Guardado')).toBeTruthy();
    const savedEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savedEvent);
    expect(savedEvent.defaultPrevented).toBe(false);
  });

  it('keeps reconciliation retry visible when editing after its GET fails', async () => {
    const sent = { ...createDefaultDraft(), instructions: 'A' };
    const getDraft = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new DraftApiFailure('network', 'offline'));
    const putDraft = vi
      .fn()
      .mockRejectedValue(new DraftApiFailure('server', 'ambiguous', undefined, undefined, true));
    const draftApi = api({ getDraft, putDraft });
    render(<RobotEditor api={draftApi} session={session()} />);
    await screen.findByDisplayValue(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: sent.instructions },
    });
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await waitFor(() => expect(getDraft).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Edición posterior a la respuesta ambigua' },
    });
    expect(screen.getByRole('button', { name: 'Reintentar guardado' })).toBeTruthy();
    expect(putDraft).toHaveBeenCalledOnce();
  });

  it('turns an ambiguous save into a conflict when reconciliation finds a newer draft', async () => {
    const sent = { ...createDefaultDraft(), instructions: 'Mi versión' };
    const remote = { ...createDefaultDraft(), instructions: 'Otra versión' };
    const getDraft = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(2, remote));
    const putDraft = vi
      .fn()
      .mockRejectedValue(new DraftApiFailure('server', 'ambiguous', undefined, undefined, true));
    const draftApi = api({ getDraft, putDraft });
    render(<RobotEditor api={draftApi} session={session()} />);
    await screen.findByDisplayValue(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: sent.instructions },
    });
    expect(
      await screen.findByRole('heading', { name: 'Hay una versión guardada en otra pestaña' }),
    ).toBeTruthy();
    expect(screen.getByText(remote.instructions)).toBeTruthy();
    expect(putDraft).toHaveBeenCalledOnce();
  });

  it('writes the visible base with its known version after reconciliation reads the base', async () => {
    const base = createDefaultDraft();
    const sent = { ...base, instructions: 'Mi versión' };
    const getDraft = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot(0, base));
    const putDraft = vi
      .fn()
      .mockRejectedValueOnce(new DraftApiFailure('server', 'ambiguous', undefined, undefined, true))
      .mockResolvedValueOnce(snapshot(1, base));
    const draftApi = api({ getDraft, putDraft });
    render(<RobotEditor api={draftApi} session={session()} />);
    await screen.findByDisplayValue(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    const instructions = screen.getByLabelText('Qué debe tener en cuenta el robot');
    fireEvent.change(instructions, { target: { value: sent.instructions } });
    await waitFor(() => expect(putDraft).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await waitFor(() => expect(getDraft).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    fireEvent.change(instructions, { target: { value: base.instructions } });
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }));
    await waitFor(() => expect(putDraft).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(putDraft.mock.calls[1]?.[0]).toBe(0);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: base.instructions });
    expect(await screen.findByText('Guardado')).toBeTruthy();
  });

  it('coalesces a retry while reconciliation is active and keeps its conflict result', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    let resolveReconciliation!: (value: DraftSnapshot) => void;
    const reconciliation = new Promise<DraftSnapshot>((resolve) => {
      resolveReconciliation = resolve;
    });
    const getDraft = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(reconciliation);
    const putDraft = vi
      .fn()
      .mockRejectedValue(new DraftApiFailure('network', 'lost', undefined, undefined, true));
    const editorRef = createRef<RobotEditorHandle>();
    render(<RobotEditor ref={editorRef} api={{ getDraft, putDraft }} session={session()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const instructions = screen.getByLabelText('Qué debe tener en cuenta el robot');
    fireEvent.change(instructions, { target: { value: 'A' } });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getDraft).toHaveBeenCalledTimes(2);
    fireEvent.change(instructions, { target: { value: 'B' } });
    fireEvent.change(instructions, { target: { value: 'A' } });
    expect(screen.queryByRole('button', { name: 'Reintentar guardado' })).toBeNull();
    const flushPromise = editorRef.current?.flushPending();
    expect(getDraft).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveReconciliation({ version: 2, draft: { ...base, instructions: 'REMOTE C' } });
      await flushPromise;
      await Promise.resolve();
    });
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Conflicto de edición')).toBeTruthy();
    expect(screen.getByText('REMOTE C')).toBeTruthy();
  });

  it('drops an active reconciliation when the editor unmounts', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const sent = { ...base, instructions: 'Enviada' };
    let resolveReconciliation!: (value: DraftSnapshot) => void;
    const reconciliation = new Promise<DraftSnapshot>((resolve) => {
      resolveReconciliation = resolve;
    });
    const getDraft = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(reconciliation);
    const putDraft = vi
      .fn()
      .mockRejectedValue(new DraftApiFailure('network', 'lost', undefined, undefined, true));
    const view = render(<RobotEditor api={{ getDraft, putDraft }} session={session()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: sent.instructions },
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getDraft).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
      resolveReconciliation(snapshot(1, sent));
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
    });
    expect(putDraft).toHaveBeenCalledOnce();
  });

  it('ignores a late GET from the previous identity after switching sessions', async () => {
    let resolveA!: (value: DraftSnapshot) => void;
    const draftA = { ...createDefaultDraft(), instructions: 'Cuenta A' };
    const draftB = { ...createDefaultDraft(), instructions: 'Cuenta B' };
    const getDraft = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<DraftSnapshot>((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockResolvedValueOnce(snapshot(4, draftB));
    const draftApi = api({ getDraft });
    const first = session();
    const second = session(
      'b@example.com',
      Math.floor(Date.now() / 1000) + 600,
      'b-token',
      'subject-b',
    );
    const view = render(<RobotEditor api={draftApi} session={first} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    view.rerender(<RobotEditor api={draftApi} session={second} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByDisplayValue('Cuenta B')).toBeTruthy();
    await act(async () => {
      resolveA(snapshot(3, draftA));
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('Cuenta B')).toBeTruthy();
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    view.unmount();
  });

  it('drops queued work when the editor unmounts during an in-flight PUT', async () => {
    let resolvePut!: (value: DraftSnapshot) => void;
    const putDraft = vi.fn().mockReturnValue(
      new Promise<DraftSnapshot>((resolve) => {
        resolvePut = resolve;
      }),
    );
    const draftApi = api({ putDraft });
    const view = render(<RobotEditor api={draftApi} session={session()} />);
    await screen.findByDisplayValue(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Enviada' },
    });
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(putDraft).toHaveBeenCalledOnce();
    view.unmount();
    resolvePut(snapshot(1, { ...createDefaultDraft(), instructions: 'Enviada' }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(putDraft).toHaveBeenCalledOnce();
  });
});
