// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { StrictMode } from 'react';
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
    modelKey: 'claude-sonnet-5',
    modelLabel: 'Claude Sonnet 5',
    modelId: 'global.anthropic.claude-sonnet-5',
    turnsUsed: 2,
    maxTurns: 12,
    calls: 2,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
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
  it('freezes the selected model in the admission payload and labels the returned result', async () => {
    const selectedDraft = { ...createDefaultDraft(), modelKey: 'claude-opus-5' as const };
    const completed = {
      ...summary('victory'),
      modelKey: 'claude-opus-5' as const,
      modelLabel: 'Claude Opus 5',
      modelId: 'global.anthropic.claude-opus-5',
      reasoningTokens: 17,
    };
    const createAttempt = vi
      .fn()
      .mockResolvedValue({ attempt: completed, dispatchConfirmed: true });
    const attemptApi = api({ createAttempt });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 4, draft: selectedDraft }),
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

    expect(createAttempt).toHaveBeenCalledWith(
      expect.any(String),
      4,
      expect.objectContaining({ modelKey: 'claude-opus-5' }),
    );
    expect(await screen.findByText('Modelo: Claude Opus 5')).toBeTruthy();
    expect(
      screen.getByText('Razonamiento (incluido en salida)').parentElement?.textContent,
    ).toContain('17');
  });

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
      expect.objectContaining({
        instructions: expect.stringContaining('Siempre preferí'),
        modelKey: 'claude-sonnet-5',
      }),
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

  it('retries a persisted frozen admission after reload and a 404 lookup', async () => {
    const draft = { ...createDefaultDraft(), instructions: 'Snapshot exacto' };
    window.sessionStorage.setItem(
      'prompt-runner:attempt-recovery',
      JSON.stringify({
        sub: 'subject-a',
        requestKey: 'persisted-key',
        expectedVersion: 7,
        draft,
      }),
    );
    const createAttempt = vi.fn().mockResolvedValue({
      attempt: summary('victory'),
      dispatchConfirmed: true,
    });
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const captureSnapshot = vi.fn();
    const editor = {
      current: { captureSnapshot },
    } as unknown as { current: RobotEditorHandle | null };
    render(
      <StrictMode>
        <AttemptWorkspace api={attemptApi} editor={editor} session={session()} />
      </StrictMode>,
    );

    expect(await screen.findByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(getAttemptRequest).toHaveBeenCalledWith('persisted-key', expect.anything());
    expect(createAttempt).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledWith('persisted-key', 7, draft, expect.anything());
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
  });

  it('keeps a key-only recovery marker without inventing a draft to retry', async () => {
    window.sessionStorage.setItem(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', requestKey: 'marker-only-key' }),
    );
    const createAttempt = vi.fn();
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    const checkButton = await screen.findByRole('button', { name: 'Comprobar estado' });
    fireEvent.click(checkButton);
    await waitFor(() => expect(getAttemptRequest).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Comprobar estado' })).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it('does not re-admit when the lookup finds the attempt after reload', async () => {
    const draft = createDefaultDraft();
    window.sessionStorage.setItem(
      'prompt-runner:attempt-recovery',
      JSON.stringify({ sub: 'subject-a', requestKey: 'found-key', expectedVersion: 3, draft }),
    );
    const createAttempt = vi.fn();
    const getAttemptRequest = vi.fn().mockResolvedValue(summary('running'));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    expect(await screen.findByRole('heading', { name: 'Preparando intento' })).toBeTruthy();
    expect(createAttempt).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toContain('attempt-1');
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).not.toContain(
      'expectedVersion',
    );
  });

  it.each([
    [
      'foreign snapshot',
      {
        sub: 'subject-b',
        requestKey: 'foreign-key',
        expectedVersion: 4,
        draft: createDefaultDraft(),
      },
    ],
    [
      'corrupt snapshot',
      {
        sub: 'subject-a',
        requestKey: 'corrupt-key',
        expectedVersion: 'four',
        draft: createDefaultDraft(),
      },
    ],
    [
      'invalid-schema snapshot',
      {
        sub: 'subject-a',
        requestKey: 'schema-key',
        expectedVersion: 4,
        draft: { ...createDefaultDraft(), schemaVersion: 1 },
      },
    ],
    [
      'oversized snapshot',
      {
        sub: 'subject-a',
        requestKey: 'large-key',
        expectedVersion: 4,
        draft: { ...createDefaultDraft(), instructions: 'x'.repeat(70_000) },
      },
    ],
  ])('does not re-admit a %s from session storage', async (_label, stored) => {
    window.sessionStorage.setItem('prompt-runner:attempt-recovery', JSON.stringify(stored));
    const createAttempt = vi.fn();
    const getAttemptRequest = vi.fn();
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(<AttemptWorkspace api={attemptApi} editor={editor} session={session()} />);

    await screen.findByText('Historial');
    expect(createAttempt).not.toHaveBeenCalled();
    expect(getAttemptRequest).not.toHaveBeenCalled();
    if (_label === 'foreign snapshot') {
      expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
    }
  });

  it('retries a lost POST with the same request key, version, and frozen draft', async () => {
    const first = new AttemptApiFailure('network', 'timeout', undefined, true);
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(first)
      .mockResolvedValueOnce({ attempt: summary('victory'), dispatchConfirmed: true });
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
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
    expect(createAttempt).toHaveBeenCalledTimes(2);
    expect(createAttempt.mock.calls[1]?.slice(0, 3)).toEqual(createAttempt.mock.calls[0]);
  });

  it('clears a frozen admission after a definitive retry rejection and unlocks a new start', async () => {
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'timeout', undefined, true))
      .mockRejectedValueOnce(new AttemptApiFailure('quota_exceeded', 'quota', 429))
      .mockResolvedValueOnce({ attempt: summary('running'), dispatchConfirmed: true });
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
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
    expect(await screen.findByRole('button', { name: 'Reintentar consultas' })).toBeTruthy();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createAttempt).toHaveBeenCalledTimes(3);
  });

  it('ignores a deferred retry rejection after the session generation changes', async () => {
    let rejectRetry!: (error: AttemptApiFailure) => void;
    const retryPending = new Promise<never>((_, reject) => {
      rejectRetry = reject;
    });
    const createAttempt = vi
      .fn()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'timeout', undefined, true))
      .mockReturnValueOnce(retryPending);
    const getAttemptRequest = vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'not found', 404));
    const attemptApi = api({ createAttempt, getAttemptRequest });
    const editor = {
      current: {
        captureSnapshot: vi.fn().mockResolvedValue({ version: 9, draft: createDefaultDraft() }),
      },
    } as unknown as { current: RobotEditorHandle | null };
    const ref = { current: null } as unknown as { current: AttemptWorkspaceHandle | null };
    const view = render(
      <AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={session()} />,
    );
    await screen.findByText('Historial');

    await act(async () => {
      (ref.current as AttemptWorkspaceHandle).start();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Comprobar estado' }));
    await waitFor(() => expect(createAttempt).toHaveBeenCalledTimes(2));

    const otherSession = {
      ...session(),
      identity: { sub: 'subject-b', email: 'b@example.com' },
    };
    view.rerender(
      <AttemptWorkspace ref={ref} api={attemptApi} editor={editor} session={otherSession} />,
    );
    await act(async () => {
      rejectRetry(new AttemptApiFailure('quota_exceeded', 'quota', 429));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('quota')).toBeNull();
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
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
