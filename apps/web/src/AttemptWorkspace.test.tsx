// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { AttemptApiFailure, type AttemptApi, type AttemptSummary } from './attempt-api.js';
import { AttemptWorkspace, type AttemptWorkspaceHandle } from './AttemptWorkspace.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';
import type { DraftApi } from './draft-api.js';

function session(): AuthSession {
  return {
    identity: { sub: 'subject-a', email: 'a@example.com' },
    user: new User({
      access_token: 'token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
        sub: 'subject-a',
        email: 'a@example.com',
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

function summary(status: AttemptSummary['status'] = 'running'): AttemptSummary {
  return {
    id: 'attempt-1',
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:01.000Z',
    status,
    cancelRequested: false,
    levelId: 'principal-estatico-v1',
    turnsUsed: 2,
    maxTurns: 12,
    calls: 2,
    inputTokens: null,
    outputTokens: null,
    gameTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    score: null,
    progress: 0.4,
    finalSupport: 2,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
  };
}

function api(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi
      .fn()
      .mockResolvedValue({ attempt: summary('running'), dispatchConfirmed: true }),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404)),
    getAttempt: vi.fn().mockResolvedValue(summary('running')),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi
      .fn()
      .mockResolvedValue({ attempt: summary('running'), dispatchConfirmed: true }),
    cancelAttempt: vi.fn().mockResolvedValue(summary('cancelled')),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-09-21',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: '2026-09-22T03:00:00.000Z',
    }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AttemptWorkspace', () => {
  it('keeps the captured key and draft through admission, then exposes cancel and terminal metrics', async () => {
    const attemptApi = api();
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(attemptApi.createAttempt).toHaveBeenCalledOnce();
    expect(attemptApi.createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.objectContaining({ instructions: expect.stringContaining('Siempre preferí') }),
    );
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByRole('heading', { name: 'Cancelado' })).toBeTruthy();
    expect(screen.getAllByText('desconocido').length).toBeGreaterThan(0);
  });

  it('flushes A then B before admitting the captured B snapshot with its confirmed version', async () => {
    let resolveA!: (value: DraftSnapshot) => void;
    const draftA = { ...createDefaultDraft(), instructions: 'A' };
    const draftB = { ...createDefaultDraft(), instructions: 'B' };
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(
        new Promise<DraftSnapshot>((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockResolvedValueOnce({ version: 2, draft: draftB });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft,
    };
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: summary('running'),
      dispatchConfirmed: true,
    });
    const attemptApi = api({ createAttempt });
    const editorRef = { current: null } as unknown as { current: RobotEditorHandle | null };
    const workspaceRef = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(
      <>
        <RobotEditor ref={editorRef} api={draftApi} session={session()} />
        <AttemptWorkspace
          ref={workspaceRef}
          api={attemptApi}
          editor={editorRef}
          session={session()}
        />
      </>,
    );

    const instructions = await screen.findByLabelText('Qué debe tener en cuenta el robot');
    await screen.findByText('Historial');
    fireEvent.change(instructions, { target: { value: 'A' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    fireEvent.change(instructions, { target: { value: 'B' } });
    await act(async () => {
      (workspaceRef.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
    });
    expect(putDraft).toHaveBeenCalledOnce();

    await act(async () => {
      resolveA({ version: 1, draft: draftA });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await screen.findByRole('button', { name: 'Cancelar' });
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(1);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: 'B' });
    expect(createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      2,
      expect.objectContaining({ instructions: 'B' }),
    );
  });

  it('resolves an ambiguous admission by request key without creating a second key', async () => {
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'timeout', undefined, true));
    const getAttemptRequest = vi.fn().mockResolvedValue(summary('victory'));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledOnce();
  });

  it('recovers an ambiguous admission from memory when session storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const createAttempt = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('network', 'timeout', undefined, true));
    const getAttemptRequest = vi.fn().mockResolvedValue(summary('victory'));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledOnce();
  });

  it('keeps a persisted request key uncertain after a reload and a 404 lookup', async () => {
    window.sessionStorage.setItem(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', requestKey: 'persisted-key' }),
    );
    const createAttempt = vi.fn();
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    const checkButton = await screen.findByRole('button', { name: 'Comprobar estado' });
    expect(createAttempt).not.toHaveBeenCalled();
    expect(getAttemptRequest).toHaveBeenCalledWith('persisted-key', expect.anything());

    fireEvent.click(checkButton);
    await waitFor(() => expect(getAttemptRequest).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('discovers multiple active attempts through paginated history and asks which one to resume', async () => {
    const first = { ...summary('running'), id: 'attempt-a' };
    const second = { ...summary('pending'), id: 'attempt-b' };
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [first], nextCursor: 'next' })
      .mockResolvedValueOnce({ attempts: [first], nextCursor: 'next' })
      .mockResolvedValueOnce({ attempts: [second] });
    const attemptApi = api({ listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    expect(
      await screen.findByRole('heading', { name: 'Tenés varios intentos en curso' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /attempt-a/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /attempt-b/ })).toBeTruthy();
  });

  it('keeps a slow history result from racing with a new admission', async () => {
    let resolveHistory!: (value: AttemptSummary) => void;
    const getAttempt = vi.fn(
      () =>
        new Promise<AttemptSummary>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: summary('running'),
      dispatchConfirmed: true,
    });
    const attemptApi = api({
      getAttempt,
      createAttempt,
      listAttempts: vi.fn().mockResolvedValue({ attempts: [summary('victory')] }),
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByRole('button', { name: 'Ver resultado' });

    fireEvent.click(screen.getByRole('button', { name: 'Ver resultado' }));
    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
    });
    expect(createAttempt).not.toHaveBeenCalled();

    resolveHistory(summary('victory'));
    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
  });

  it('syncs the history row when polling changes a pending attempt to terminal', async () => {
    const pending = { ...summary('pending'), id: 'attempt-terminal-sync' };
    const terminal = {
      ...pending,
      status: 'error' as const,
      updatedAt: '2026-09-21T12:05:00.000Z',
      reason: 'provider_error',
    };
    const getAttempt = vi.fn().mockResolvedValue(terminal);
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [pending] })
      .mockResolvedValueOnce({ attempts: [pending] });
    const attemptApi = api({ getAttempt, listAttempts });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });
    expect(await screen.findByRole('heading', { name: 'Error de ejecución' })).toBeTruthy();
    const historySection = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(historySection).not.toBeNull();
    expect(within(historySection as HTMLElement).getByText('Error de ejecución')).toBeTruthy();
    expect(
      within(historySection as HTMLElement).queryByText('Admitido, esperando inicio'),
    ).toBeNull();

    fireEvent.click(
      within(historySection as HTMLElement).getByRole('button', { name: 'Ver resultado' }),
    );
    expect(
      await screen.findByText(
        'Causa registrada: El proveedor del agente no pudo completar la llamada.',
      ),
    ).toBeTruthy();
    expect(
      within(historySection as HTMLElement).queryByText('Admitido, esperando inicio'),
    ).toBeNull();
  });

  it('does not let a deferred old history page overwrite a polled terminal summary', async () => {
    const pending = { ...summary('pending'), id: 'attempt-deferred-history' };
    const terminal = {
      ...pending,
      status: 'error' as const,
      updatedAt: '2026-09-21T12:05:00.000Z',
      reason: 'provider_error',
    };
    let resolveHistory!: (page: { attempts: readonly AttemptSummary[] }) => void;
    const oldHistoryPage = new Promise<{ attempts: readonly AttemptSummary[] }>((resolve) => {
      resolveHistory = resolve;
    });
    const listAttempts = vi
      .fn()
      .mockResolvedValueOnce({ attempts: [] })
      .mockResolvedValueOnce({ attempts: [] })
      .mockReturnValueOnce(oldHistoryPage);
    const attemptApi = api({
      createAttempt: vi.fn().mockResolvedValue({ attempt: pending, dispatchConfirmed: true }),
      getAttempt: vi.fn().mockResolvedValue(terminal),
      listAttempts,
    });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    render(<AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />);
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(await screen.findByRole('heading', { name: 'Error de ejecución' })).toBeTruthy();

    resolveHistory({ attempts: [pending] });
    const historySection = screen.getByRole('heading', { name: 'Historial' }).closest('section');
    expect(historySection).not.toBeNull();
    await waitFor(() => {
      expect(within(historySection as HTMLElement).getByText('Error de ejecución')).toBeTruthy();
    });
    expect(
      within(historySection as HTMLElement).queryByText('Admitido, esperando inicio'),
    ).toBeNull();
  });
});
