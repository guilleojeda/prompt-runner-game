// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { createRef, type RefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type DraftSnapshot, type RobotDraft } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { DraftApiFailure, type DraftApi } from './draft-api.js';
import { RobotEditor, type RobotEditorHandle, type RobotEditorProps } from './RobotEditor.js';
import { SavedRobotApiFailure } from './saved-robot-api.js';

type DraftSource = RobotDraft | ((signal: AbortSignal) => Promise<RobotDraft>);
type ApplicationState =
  | { readonly state: 'pending' }
  | { readonly state: 'fulfilled'; readonly result: boolean }
  | { readonly state: 'rejected'; readonly error: unknown };

function session(sub = 'application-owner'): AuthSession {
  return {
    identity: { sub, email: `${sub}@example.test` },
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
        email: `${sub}@example.test`,
      },
      expires_at: 9_999_999_999,
    }),
  };
}

function snapshot(version = 0, draft: RobotDraft = createDefaultDraft()): DraftSnapshot {
  return { version, draft };
}

function api(overrides: Partial<DraftApi> = {}): DraftApi {
  return {
    getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot()),
    putDraft: vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation(async (version, draft) => snapshot(version + 1, draft)),
    ...overrides,
  };
}

function applyWithSignal(
  editor: RobotEditorHandle | null,
  source: DraftSource,
  signal: AbortSignal,
): Promise<boolean> {
  if (!editor) throw new Error('The editor handle was not ready.');
  return editor.applyDraft(source, { signal });
}

function observe(promise: Promise<boolean>): { current(): ApplicationState } {
  let state: ApplicationState = { state: 'pending' };
  void promise.then(
    (result) => {
      state = { state: 'fulfilled', result };
    },
    (error: unknown) => {
      state = { state: 'rejected', error };
    },
  );
  return { current: () => state };
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
  editorRef: RefObject<RobotEditorHandle | null>,
  props: Omit<RobotEditorProps, 'api' | 'session' | 'ref'> = {},
) {
  const view = render(
    <RobotEditor ref={editorRef} api={draftApi} session={session()} {...props} />,
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

function instructionsValue(): string {
  return (screen.getByLabelText('Qué debe tener en cuenta el robot') as HTMLTextAreaElement).value;
}

function incompatibleFailure(): DraftApiFailure {
  return new DraftApiFailure('incompatible', 'La configuración guardada no es compatible.');
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RobotEditor D2 application acceptance', () => {
  it('keeps a transient candidate load pending and retries it at 60 seconds', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const candidate = { ...base, instructions: 'Candidato consultado' };
    const sourceSignals: (AbortSignal | undefined)[] = [];
    const source = vi
      .fn<(signal?: AbortSignal) => Promise<RobotDraft>>()
      .mockImplementationOnce((signal) => {
        sourceSignals.push(signal);
        return Promise.reject(new DraftApiFailure('network', 'La copia no respondió.'));
      })
      .mockImplementationOnce((signal) => {
        sourceSignals.push(signal);
        return Promise.resolve(candidate);
      });
    const getDraft = vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(4, base));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(api({ getDraft, putDraft }), editorRef);
    const controller = new AbortController();
    const applying = applyWithSignal(editorRef.current, source, controller.signal);
    const application = observe(applying);
    await settle();

    expect(source).toHaveBeenCalledOnce();
    expect(sourceSignals[0]).toBeInstanceOf(AbortSignal);
    expect(application.current().state).toBe('pending');
    expect(putDraft).not.toHaveBeenCalled();
    expect(instructionsValue()).toBe(base.instructions);
    await advance(59_999);
    expect(source).toHaveBeenCalledOnce();
    expect(putDraft).not.toHaveBeenCalled();
    await advance(1);

    await expect(applying).resolves.toBe(true);
    expect(source).toHaveBeenCalledTimes(2);
    expect(sourceSignals[1]).toBeInstanceOf(AbortSignal);
    expect(sourceSignals[1]).not.toBe(sourceSignals[0]);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.[0]).toBe(4);
    expect(putDraft.mock.calls[0]?.[1]).toMatchObject({ instructions: candidate.instructions });
    expect(instructionsValue()).toBe(candidate.instructions);
    expect(getDraft).toHaveBeenCalledOnce();
  });

  it('shows the clean saved status after canceling a transient candidate load and does no retry', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const source = vi
      .fn<(signal: AbortSignal) => Promise<RobotDraft>>()
      .mockRejectedValueOnce(new DraftApiFailure('network', 'La copia no respondió.'));
    const getDraft = vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(4, base));
    const putDraft = vi.fn<DraftApi['putDraft']>();
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(api({ getDraft, putDraft }), editorRef);
    const applying = applyWithSignal(editorRef.current, source, new AbortController().signal);
    const application = observe(applying);
    await settle();
    expect(application.current().state).toBe('pending');
    expect(
      screen.getByText('Guardado pendiente: volveremos a intentarlo cada minuto', { exact: true }),
    ).toBeTruthy();

    act(() => editorRef.current?.cancelApplication());
    await expect(applying).resolves.toBe(false);
    expect(screen.getByText('Guardado', { exact: true })).toBeTruthy();
    await advance(60_000);

    expect(source).toHaveBeenCalledOnce();
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).not.toHaveBeenCalled();
    expect(screen.getByText('Guardado', { exact: true })).toBeTruthy();
  });

  it('keeps the original deadline when editing after canceling a transient candidate load', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const visible = { ...base, instructions: 'Edición visible después de cancelar.' };
    const source = vi
      .fn<(signal: AbortSignal) => Promise<RobotDraft>>()
      .mockRejectedValueOnce(new DraftApiFailure('network', 'La copia no respondió.'));
    const getDraft = vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(4, base));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(api({ getDraft, putDraft }), editorRef);
    const applying = applyWithSignal(editorRef.current, source, new AbortController().signal);
    await settle();
    act(() => editorRef.current?.cancelApplication());
    await expect(applying).resolves.toBe(false);

    await advance(20_000);
    editInstructions(visible.instructions);
    await advance(39_999);
    expect(putDraft).not.toHaveBeenCalled();
    expect(source).toHaveBeenCalledOnce();
    await advance(1);

    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.slice(0, 2)).toEqual([4, visible]);
    expect(instructionsValue()).toBe(visible.instructions);
  });

  it('saves a dirty visible revision before the candidate and keeps it visible until candidate confirmation', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const visible = { ...base, instructions: 'Edición visible previa' };
    const candidate = { ...base, instructions: 'Candidato de biblioteca' };
    let resolveVisible!: (value: DraftSnapshot) => void;
    let resolveCandidate!: (value: DraftSnapshot) => void;
    const pendingVisible = new Promise<DraftSnapshot>((resolve) => {
      resolveVisible = resolve;
    });
    const pendingCandidate = new Promise<DraftSnapshot>((resolve) => {
      resolveCandidate = resolve;
    });
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockReturnValueOnce(pendingVisible)
      .mockReturnValueOnce(pendingCandidate);
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(
      api({
        getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(5, base)),
        putDraft,
      }),
      editorRef,
    );
    editInstructions(visible.instructions);

    const controller = new AbortController();
    const applying = applyWithSignal(editorRef.current, async () => candidate, controller.signal);
    const application = observe(applying);
    await settle();

    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.[0]).toBe(5);
    expect(putDraft.mock.calls[0]?.[1]).toMatchObject({ instructions: visible.instructions });
    expect(instructionsValue()).toBe(visible.instructions);

    await act(async () => {
      resolveVisible(snapshot(6, visible));
      await pendingVisible;
      await settle();
    });

    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(6);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: candidate.instructions });
    expect(application.current().state).toBe('pending');
    expect(instructionsValue()).toBe(visible.instructions);

    await act(async () => {
      resolveCandidate(snapshot(7, candidate));
      await pendingCandidate;
    });
    await expect(applying).resolves.toBe(true);
    expect(instructionsValue()).toBe(candidate.instructions);
  });

  it('ends the application when an uncertain visible retry is definitively rejected', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const visible = { ...base, instructions: 'A visible con respuesta incierta' };
    const candidate = { ...base, instructions: 'B candidato que no debe aplicarse' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot(4, base))
      .mockResolvedValueOnce(snapshot(4, base))
      .mockResolvedValueOnce(snapshot(5, visible));
    let rejectFirstPut!: (error: DraftApiFailure) => void;
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementationOnce(
        () =>
          new Promise<DraftSnapshot>((_resolve, reject) => {
            rejectFirstPut = reject;
          }),
      )
      .mockRejectedValueOnce(incompatibleFailure());
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(api({ getDraft, putDraft }), editorRef);
    editInstructions(visible.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();

    const applying = applyWithSignal(editorRef.current, candidate, new AbortController().signal);
    const application = observe(applying);
    await settle();
    expect(application.current().state).toBe('pending');

    await act(async () => {
      rejectFirstPut(
        new DraftApiFailure('network', 'Se perdió la respuesta.', undefined, undefined, true),
      );
      await settle();
    });
    await advance(59_999);
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(1);

    await expect(applying).resolves.toBe(false);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: visible.instructions });
    expect(instructionsValue()).toBe(visible.instructions);
    expect(application.current()).toEqual({ state: 'fulfilled', result: false });

    await advance(60_000);
    expect(getDraft).toHaveBeenCalledTimes(3);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(instructionsValue()).toBe(visible.instructions);
    expect(application.current()).toEqual({ state: 'fulfilled', result: false });
  });

  it('ends an application waiting on an already active visible PUT after a definitive rejection', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const visible = { ...base, instructions: 'Visible que ya se está guardando' };
    const candidate = { ...base, instructions: 'Candidato que depende de ese guardado' };
    let rejectVisible!: (error: DraftApiFailure) => void;
    const putDraft = vi.fn<DraftApi['putDraft']>().mockImplementationOnce(
      () =>
        new Promise<DraftSnapshot>((_resolve, reject) => {
          rejectVisible = reject;
        }),
    );
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(
      api({
        getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(4, base)),
        putDraft,
      }),
      editorRef,
    );
    editInstructions(visible.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();

    const applying = applyWithSignal(editorRef.current, candidate, new AbortController().signal);
    const application = observe(applying);
    await settle();
    expect(application.current().state).toBe('pending');

    await act(async () => {
      rejectVisible(incompatibleFailure());
      await settle();
    });
    await expect(applying).resolves.toBe(false);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionsValue()).toBe(visible.instructions);
    expect(application.current()).toEqual({ state: 'fulfilled', result: false });
  });

  it('keeps a newer application alive when an older visible PUT is definitively rejected', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const olderVisible = { ...base, instructions: 'A visible de una revisión anterior' };
    const currentVisible = { ...base, instructions: 'B visible corregida' };
    const candidate = { ...base, instructions: 'C candidato vigente' };
    let rejectOlderPut!: (error: DraftApiFailure) => void;
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementationOnce(
        () =>
          new Promise<DraftSnapshot>((_resolve, reject) => {
            rejectOlderPut = reject;
          }),
      )
      .mockImplementation(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(
      api({
        getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(4, base)),
        putDraft,
      }),
      editorRef,
    );
    editInstructions(olderVisible.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();

    editInstructions(currentVisible.instructions);
    const applying = applyWithSignal(editorRef.current, candidate, new AbortController().signal);
    const application = observe(applying);
    await settle();
    await act(async () => {
      rejectOlderPut(incompatibleFailure());
      await settle();
    });
    expect(application.current().state).toBe('pending');

    await advance(600);
    await expect(applying).resolves.toBe(true);
    expect(putDraft).toHaveBeenCalledTimes(3);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({
      instructions: currentVisible.instructions,
    });
    expect(putDraft.mock.calls[2]?.[1]).toMatchObject({ instructions: candidate.instructions });
    expect(instructionsValue()).toBe(candidate.instructions);
    expect(application.current()).toEqual({ state: 'fulfilled', result: true });
  });

  it('serializes the candidate GET with the visible and candidate PUT operations', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const visible = { ...base, instructions: 'Visible pendiente.' };
    const candidate = { ...base, instructions: 'Candidato que requiere GET.' };
    const requests: Array<{ kind: string; complete(): void }> = [];
    let active = 0;
    let maximumActive = 0;
    function request<T>(kind: string, response: T): Promise<T> {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise<T>((resolve) => {
        requests.push({
          kind,
          complete: () => {
            active -= 1;
            resolve(response);
          },
        });
      });
    }
    const source = vi.fn(() => request('source', candidate));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation((version, draft) =>
        request(
          draft.instructions === visible.instructions ? 'visible' : 'candidate',
          snapshot(version + 1, draft),
        ),
      );
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(
      api({
        getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(4, base)),
        putDraft,
      }),
      editorRef,
    );
    editInstructions(visible.instructions);
    const applying = applyWithSignal(editorRef.current, source, new AbortController().signal);
    await settle();

    for (let index = 0; index < 3; index += 1) {
      expect(requests).toHaveLength(index + 1);
      expect(maximumActive).toBe(1);
      if (index < 2) expect(instructionsValue()).toBe(visible.instructions);
      await act(async () => {
        requests[index]!.complete();
      });
      await settle();
    }

    await expect(applying).resolves.toBe(true);
    expect(maximumActive).toBe(1);
    expect(requests.map((item) => item.kind).sort()).toEqual(['candidate', 'source', 'visible']);
    expect(source).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls.map(([version, draft]) => [version, draft.instructions])).toEqual([
      [4, visible.instructions],
      [5, candidate.instructions],
    ]);
    expect(instructionsValue()).toBe(candidate.instructions);
  });

  it.each(['base', 'candidate'] as const)(
    'reconciles an ambiguous candidate PUT against the %s at 60 seconds',
    async (readKind) => {
      vi.useFakeTimers();
      const base = createDefaultDraft();
      const candidate = { ...base, instructions: `Candidato ${readKind}` };
      const getDraft = vi
        .fn<DraftApi['getDraft']>()
        .mockResolvedValueOnce(snapshot(8, base))
        .mockResolvedValueOnce(readKind === 'base' ? snapshot(8, base) : snapshot(9, candidate));
      const putDraft = vi
        .fn<DraftApi['putDraft']>()
        .mockRejectedValueOnce(
          new DraftApiFailure('server', 'Respuesta incierta.', undefined, undefined, true),
        )
        .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
      const editorRef = createRef<RobotEditorHandle>();
      await renderReady(api({ getDraft, putDraft }), editorRef);
      const controller = new AbortController();
      const applying = applyWithSignal(editorRef.current, candidate, controller.signal);
      const application = observe(applying);
      await settle();

      expect(putDraft).toHaveBeenCalledOnce();
      expect(putDraft.mock.calls[0]?.[0]).toBe(8);
      expect(instructionsValue()).toBe(base.instructions);
      expect(application.current().state).toBe('pending');
      await advance(59_999);
      expect(getDraft).toHaveBeenCalledOnce();
      expect(putDraft).toHaveBeenCalledOnce();
      await advance(1);

      await expect(applying).resolves.toBe(true);
      expect(getDraft).toHaveBeenCalledTimes(2);
      if (readKind === 'base') {
        expect(putDraft).toHaveBeenCalledTimes(2);
        expect(putDraft.mock.calls[1]?.[0]).toBe(8);
        expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: candidate.instructions });
      } else {
        expect(putDraft).toHaveBeenCalledOnce();
      }
      expect(instructionsValue()).toBe(candidate.instructions);
    },
  );

  it('cancels an A→B→A edit while the candidate source is still loading', async () => {
    const base = createDefaultDraft();
    const candidate = { ...base, instructions: 'No debe importarse' };
    let resolveSource!: (value: RobotDraft) => void;
    let loaderSignal: AbortSignal | undefined;
    const source = vi.fn((signal?: AbortSignal) => {
      loaderSignal = signal;
      return new Promise<RobotDraft>((resolve) => {
        resolveSource = resolve;
      });
    });
    const putDraft = vi.fn<DraftApi['putDraft']>();
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(api({ putDraft }), editorRef);
    const controller = new AbortController();
    const applying = applyWithSignal(editorRef.current, source, controller.signal);
    const application = observe(applying);
    await settle();
    expect(source).toHaveBeenCalledOnce();
    expect(loaderSignal).toBeInstanceOf(AbortSignal);

    editInstructions('Edición transitoria B');
    editInstructions(base.instructions);
    await settle();
    const cancelledBeforeSourceResolved = application.current();
    const loaderSignalAbortedAfterEdit = loaderSignal?.aborted;
    resolveSource(candidate);
    await settle();

    expect(cancelledBeforeSourceResolved).toEqual({ state: 'fulfilled', result: false });
    expect(loaderSignalAbortedAfterEdit).toBe(true);
    await expect(applying).resolves.toBe(false);
    expect(instructionsValue()).toBe(base.instructions);
    expect(putDraft).not.toHaveBeenCalled();
  });

  it.each(['signal', 'pause', 'discard', 'identity change', 'unmount'] as const)(
    'releases a pending source loader on %s without a late write',
    async (cancellation) => {
      const base = createDefaultDraft();
      const candidate = { ...base, instructions: 'Candidato tardío' };
      let resolveSource!: (value: RobotDraft) => void;
      let loaderSignal: AbortSignal | undefined;
      const source = vi.fn((signal?: AbortSignal) => {
        loaderSignal = signal;
        return new Promise<RobotDraft>((resolve) => {
          resolveSource = resolve;
        });
      });
      const getDraft = vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(2, base));
      const putDraft = vi.fn<DraftApi['putDraft']>();
      const draftApi = api({ getDraft, putDraft });
      const editorRef = createRef<RobotEditorHandle>();
      const view = await renderReady(draftApi, editorRef);
      const controller = new AbortController();
      const applying = applyWithSignal(editorRef.current, source, controller.signal);
      const application = observe(applying);
      await settle();
      expect(source).toHaveBeenCalledOnce();
      expect(loaderSignal).toBeInstanceOf(AbortSignal);

      if (cancellation === 'signal') controller.abort();
      if (cancellation === 'discard') editorRef.current!.discardPending();
      if (cancellation === 'pause') {
        view.rerender(<RobotEditor ref={editorRef} api={draftApi} session={session()} paused />);
      }
      if (cancellation === 'identity change') {
        view.rerender(
          <RobotEditor ref={editorRef} api={draftApi} session={session('new-owner')} />,
        );
      }
      if (cancellation === 'unmount') view.unmount();
      await settle();
      const cancelledBeforeSourceResolved = application.current();
      const loaderSignalAbortedAtCancel = loaderSignal?.aborted;
      resolveSource(candidate);
      await settle();

      expect(cancelledBeforeSourceResolved).toEqual({ state: 'fulfilled', result: false });
      expect(loaderSignalAbortedAtCancel).toBe(true);
      await expect(applying).resolves.toBe(false);
      expect(putDraft).not.toHaveBeenCalled();
      if (cancellation !== 'unmount') expect(instructionsValue()).toBe(base.instructions);
    },
  );

  it('does not start the candidate loader when its caller signal was already aborted', async () => {
    const source = vi.fn(async () => createDefaultDraft());
    const putDraft = vi.fn<DraftApi['putDraft']>();
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(api({ putDraft }), editorRef);
    const controller = new AbortController();
    controller.abort();

    await expect(applyWithSignal(editorRef.current, source, controller.signal)).resolves.toBe(
      false,
    );
    expect(source).not.toHaveBeenCalled();
    expect(putDraft).not.toHaveBeenCalled();
  });

  it('propagates a definitive candidate-source error and does not revive it after an edit', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const corrected = { ...base, instructions: 'Edición visible posterior' };
    const failure = new SavedRobotApiFailure('not_found', 'La copia ya no existe.', 404);
    let sourceSignal: AbortSignal | undefined;
    const source = vi.fn(async (signal?: AbortSignal): Promise<RobotDraft> => {
      sourceSignal = signal;
      throw failure;
    });
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(
      api({
        getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(6, base)),
        putDraft,
      }),
      editorRef,
    );

    await expect(
      applyWithSignal(editorRef.current, source, new AbortController().signal),
    ).rejects.toBe(failure);
    expect(source).toHaveBeenCalledOnce();
    expect(sourceSignal).toBeInstanceOf(AbortSignal);
    expect(putDraft).not.toHaveBeenCalled();
    await advance(60_000);
    expect(source).toHaveBeenCalledOnce();

    editInstructions(corrected.instructions);
    await advance(600);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(putDraft.mock.calls[0]?.[0]).toBe(6);
    expect(putDraft.mock.calls[0]?.[1]).toMatchObject({ instructions: corrected.instructions });
  });

  it('ignores an obsolete source authentication rejection without blocking the current access', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const candidate = { ...base, instructions: 'Copia con la credencial vigente.' };
    const staleAccess = new SavedRobotApiFailure(
      'authentication',
      'Acceso anterior rechazado.',
      401,
      undefined,
      false,
      { authContext: 17 },
    );
    const source = vi
      .fn<(signal?: AbortSignal) => Promise<RobotDraft>>()
      .mockRejectedValueOnce(staleAccess)
      .mockResolvedValueOnce(candidate);
    const onAuthRequired = vi.fn().mockReturnValue(false);
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementation(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(
      api({
        getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(6, base)),
        putDraft,
      }),
      editorRef,
      { onAuthRequired },
    );

    const applying = applyWithSignal(editorRef.current, source, new AbortController().signal);
    const application = observe(applying);
    await settle();
    expect(onAuthRequired).toHaveBeenCalledExactlyOnceWith(17);
    expect(application.current().state).toBe('pending');
    expect(
      (screen.getByLabelText('Qué debe tener en cuenta el robot') as HTMLTextAreaElement).readOnly,
    ).toBe(false);
    await advance(59_999);
    expect(source).toHaveBeenCalledOnce();
    expect(putDraft).not.toHaveBeenCalled();
    await advance(1);

    await expect(applying).resolves.toBe(true);
    expect(source).toHaveBeenCalledTimes(2);
    expect(onAuthRequired).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionsValue()).toBe(candidate.instructions);
  });

  it.each(['candidate PUT', 'visible preparation'] as const)(
    'keeps an application pending after App rejects stale authentication for %s',
    async (writeStage) => {
      vi.useFakeTimers();
      const base = createDefaultDraft();
      const visible = { ...base, instructions: 'Visible que debe guardarse primero' };
      const candidate = { ...base, instructions: 'Candidato con credencial vigente' };
      const staleAuthentication = new DraftApiFailure(
        'authentication',
        'La credencial anterior fue rechazada.',
        401,
        undefined,
        false,
        { authContext: 17 },
      );
      const onAuthRequired = vi.fn().mockReturnValue(false);
      const putDraft = vi
        .fn<DraftApi['putDraft']>()
        .mockRejectedValueOnce(staleAuthentication)
        .mockImplementation(async (version, draft) => snapshot(version + 1, draft));
      const editorRef = createRef<RobotEditorHandle>();
      await renderReady(
        api({
          getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(4, base)),
          putDraft,
        }),
        editorRef,
        { onAuthRequired },
      );
      if (writeStage === 'visible preparation') editInstructions(visible.instructions);
      const applying = applyWithSignal(editorRef.current, candidate, new AbortController().signal);
      const application = observe(applying);

      await settle();
      expect(onAuthRequired).toHaveBeenCalledExactlyOnceWith(17);
      expect(application.current().state).toBe('pending');
      expect(putDraft).toHaveBeenCalledOnce();
      await advance(59_999);
      expect(onAuthRequired).toHaveBeenCalledOnce();
      expect(putDraft).toHaveBeenCalledOnce();
      expect(instructionsValue()).toBe(
        writeStage === 'visible preparation' ? visible.instructions : base.instructions,
      );
      await advance(1);

      await expect(applying).resolves.toBe(true);
      expect(onAuthRequired).toHaveBeenCalledOnce();
      expect(putDraft).toHaveBeenCalledTimes(writeStage === 'visible preparation' ? 3 : 2);
      expect(putDraft.mock.calls.at(-1)?.[1]).toMatchObject({
        instructions: candidate.instructions,
      });
      expect(instructionsValue()).toBe(candidate.instructions);
      expect(application.current()).toEqual({ state: 'fulfilled', result: true });
    },
  );

  it('ends on a transient candidate PUT after caller cancellation and does not retry later', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const candidate = { ...base, instructions: 'Candidato descartado por el caller' };
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(new DraftApiFailure('rate_limited', 'Esperá un momento.', 429));
    const editorRef = createRef<RobotEditorHandle>();
    const getDraft = vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(3, base));
    await renderReady(api({ getDraft, putDraft }), editorRef);
    const controller = new AbortController();
    const applying = applyWithSignal(editorRef.current, candidate, controller.signal);
    const application = observe(applying);
    await settle();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(instructionsValue()).toBe(base.instructions);
    expect(application.current().state).toBe('pending');

    let captureResolved = false;
    let captured: DraftSnapshot | null | undefined;
    const capturePromise = editorRef.current!.captureSnapshot();
    void capturePromise.then((result) => {
      captureResolved = true;
      captured = result;
    });
    let flushResolved = false;
    let flushed: boolean | undefined;
    const flushPromise = editorRef.current!.flushPending();
    void flushPromise.then((result) => {
      flushResolved = true;
      flushed = result;
    });
    await settle();
    expect(captureResolved).toBe(true);
    expect(captured === null || captured?.draft.instructions === base.instructions).toBe(true);
    expect(flushResolved).toBe(true);
    expect(typeof flushed).toBe('boolean');
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();

    controller.abort();
    await expect(applying).resolves.toBe(false);
    await advance(60_000);
    expect(putDraft).toHaveBeenCalledOnce();
    expect(getDraft).toHaveBeenCalledOnce();
    expect(instructionsValue()).toBe(base.instructions);
  });

  it.each([
    ['incompatible', () => incompatibleFailure()],
    ['invalid', () => new DraftApiFailure('invalid', 'La configuración no es válida.', 400)],
  ] as const)(
    '%s is terminal for an application and never revives after a later edit',
    async (_name, makeFailure) => {
      vi.useFakeTimers();
      const base = createDefaultDraft();
      const candidate = { ...base, instructions: 'Candidato inválido para esta sesión' };
      const corrected = { ...base, instructions: 'Edición visible corregida' };
      const putDraft = vi
        .fn<DraftApi['putDraft']>()
        .mockRejectedValueOnce(makeFailure())
        .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
      const editorRef = createRef<RobotEditorHandle>();
      const draftApi = api({
        getDraft: vi.fn<DraftApi['getDraft']>().mockResolvedValue(snapshot(6, base)),
        putDraft,
      });
      await renderReady(draftApi, editorRef);
      const controller = new AbortController();
      const applying = applyWithSignal(editorRef.current, candidate, controller.signal);

      await expect(applying).resolves.toBe(false);
      expect(instructionsValue()).toBe(base.instructions);
      await advance(60_000);
      expect(putDraft).toHaveBeenCalledOnce();

      editInstructions(corrected.instructions);
      await advance(600);
      expect(putDraft).toHaveBeenCalledTimes(2);
      expect(putDraft.mock.calls[1]?.[0]).toBe(6);
      expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: corrected.instructions });
      expect(putDraft.mock.calls[1]?.[1]).not.toMatchObject({
        instructions: candidate.instructions,
      });
      expect(instructionsValue()).toBe(corrected.instructions);
    },
  );

  it('ends the application after an uncertain candidate retry is definitively rejected', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const candidate = { ...base, instructions: 'Candidato cuya primera respuesta se perdió' };
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot(4, base))
      .mockResolvedValueOnce(snapshot(4, base))
      .mockResolvedValueOnce(snapshot(5, candidate));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockRejectedValueOnce(
        new DraftApiFailure('network', 'Se perdió la respuesta.', undefined, undefined, true),
      )
      .mockRejectedValueOnce(incompatibleFailure())
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(api({ getDraft, putDraft }), editorRef);
    const applicationPromise = applyWithSignal(
      editorRef.current,
      candidate,
      new AbortController().signal,
    );
    const application = observe(applicationPromise);

    await settle();
    expect(putDraft).toHaveBeenCalledOnce();
    expect(application.current().state).toBe('pending');
    await advance(60_000);
    await expect(applicationPromise).resolves.toBe(false);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: candidate.instructions });
    expect(instructionsValue()).toBe(base.instructions);

    await advance(60_000);
    expect(getDraft).toHaveBeenCalledTimes(3);
    expect(putDraft).toHaveBeenCalledTimes(3);
    expect(putDraft.mock.calls[2]?.slice(0, 2)).toEqual([5, base]);
    expect(instructionsValue()).toBe(base.instructions);
    expect(application.current()).toEqual({ state: 'fulfilled', result: false });
  });

  it('keeps a later visible B when cancelled candidate A is confirmed after an uncertain response', async () => {
    vi.useFakeTimers();
    const base = createDefaultDraft();
    const candidate = { ...base, instructions: 'A candidato enviado' };
    const visibleB = { ...base, instructions: 'B visible conservado' };
    let rejectCandidate!: (error: DraftApiFailure) => void;
    const getDraft = vi
      .fn<DraftApi['getDraft']>()
      .mockResolvedValueOnce(snapshot(4, base))
      .mockResolvedValueOnce(snapshot(5, candidate));
    const putDraft = vi
      .fn<DraftApi['putDraft']>()
      .mockImplementationOnce(
        () =>
          new Promise<DraftSnapshot>((_resolve, reject) => {
            rejectCandidate = reject;
          }),
      )
      .mockImplementationOnce(async (version, draft) => snapshot(version + 1, draft));
    const editorRef = createRef<RobotEditorHandle>();
    await renderReady(api({ getDraft, putDraft }), editorRef);
    const controller = new AbortController();
    const applying = applyWithSignal(editorRef.current, candidate, controller.signal);
    const application = observe(applying);
    await settle();
    expect(putDraft).toHaveBeenCalledOnce();
    const candidatePutSignal = putDraft.mock.calls[0]?.[2];
    expect(candidatePutSignal).toBeInstanceOf(AbortSignal);

    editInstructions(visibleB.instructions);
    await settle();
    const cancelledBeforeResponse = application.current();
    const candidatePutSignalAborted = candidatePutSignal?.aborted;
    await act(async () => {
      rejectCandidate(
        new DraftApiFailure('network', 'Respuesta incierta.', undefined, undefined, true),
      );
      await settle();
    });
    expect(instructionsValue()).toBe(visibleB.instructions);
    await advance(59_999);
    expect(getDraft).toHaveBeenCalledOnce();
    expect(putDraft).toHaveBeenCalledOnce();
    await advance(1);

    expect(cancelledBeforeResponse).toEqual({ state: 'fulfilled', result: false });
    expect(candidatePutSignalAborted).toBe(true);
    await expect(applying).resolves.toBe(false);
    expect(getDraft).toHaveBeenCalledTimes(2);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(putDraft.mock.calls[1]?.[0]).toBe(5);
    expect(putDraft.mock.calls[1]?.[1]).toMatchObject({ instructions: visibleB.instructions });
    expect(putDraft.mock.calls[1]?.[1]).not.toMatchObject({ instructions: candidate.instructions });
    expect(instructionsValue()).toBe(visibleB.instructions);
  });
});
