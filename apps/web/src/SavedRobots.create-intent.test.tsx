// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type DraftSnapshot,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { SavedRobots, type SavedRobotsHandle } from './SavedRobots.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

function session(sub = 'create-intent-user'): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  const email = `${sub}@example.test`;
  return {
    identity: { sub, email },
    user: new User({
      access_token: `token-${sub}`,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client-public',
        iat: now,
        exp: now + 3_600,
        sub,
        email,
      },
      expires_at: now + 3_600,
    }),
  };
}

function robot(id: string, name: string, draft: RobotDraft, version = 1): SavedRobot {
  return {
    id,
    name,
    version,
    createdAt: '2026-10-30T12:00:00.000Z',
    updatedAt: '2026-10-30T12:00:01.000Z',
    modelKey: draft.modelKey,
    draft,
  };
}

function summary(copy: SavedRobot): SavedRobotSummary {
  return {
    id: copy.id,
    name: copy.name,
    version: copy.version,
    createdAt: copy.createdAt,
    updatedAt: copy.updatedAt,
    modelKey: copy.modelKey,
  };
}

function editor(captureSnapshot?: RobotEditorHandle['captureSnapshot']) {
  const current = {
    captureSnapshot:
      captureSnapshot ??
      vi
        .fn()
        .mockResolvedValue({ version: 4, draft: createDefaultDraft() } satisfies DraftSnapshot),
    applyDraft: vi.fn().mockResolvedValue(true),
    cancelApplication: vi.fn(),
    hasUnconfirmedChanges: vi.fn().mockReturnValue(false),
    discardPending: vi.fn(),
    flushPending: vi.fn().mockResolvedValue(true),
    waitForConfirmed: vi.fn().mockResolvedValue(true),
    releaseAttemptLock: vi.fn(),
  };
  return { current, ref: { current } as unknown as React.RefObject<RobotEditorHandle | null> };
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

function api(overrides: Partial<SavedRobotApi> = {}): SavedRobotApi {
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [] }),
    getRobot: vi.fn(),
    saveRobot: vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockImplementation(async (id, version, name, draft) => robot(id, name, draft, version + 1)),
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides,
  };
}

async function chooseCopy(name: string): Promise<HTMLInputElement> {
  const radio = (await screen.findByRole('radio', {
    name: new RegExp(name, 'u'),
  })) as HTMLInputElement;
  fireEvent.click(radio);
  await waitFor(() => expect(radio.checked).toBe(true));
  await waitFor(() => expect(within(selectedPanel()).getByRole('heading', { name })).toBeTruthy());
  return radio;
}

async function fillCreateForm(name: string): Promise<HTMLFormElement> {
  const trigger = screen.getByRole('button', { name: 'Guardar robot actual' });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  const input = await screen.findByLabelText('Nombre para la nueva copia');
  fireEvent.change(input, { target: { value: name } });
  const form = input.closest('form');
  if (!form) throw new Error('No se encontró el formulario de creación.');
  return form;
}

async function openCreateForm(name: string): Promise<HTMLFormElement> {
  const form = await fillCreateForm(name);
  fireEvent.submit(form);
  return form;
}

function selectedPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SavedRobots phase 23 create intent', () => {
  it('cancels a pending capture and keeps a later create alive when the old capture finishes', async () => {
    const canceledSnapshot = deferred<DraftSnapshot | null>();
    const currentSnapshot = deferred<DraftSnapshot | null>();
    const currentDraft = { ...createDefaultDraft(), instructions: 'Snapshot de la nueva acción.' };
    const editorState = editor(
      vi
        .fn<RobotEditorHandle['captureSnapshot']>()
        .mockReturnValueOnce(canceledSnapshot.promise)
        .mockReturnValueOnce(currentSnapshot.promise),
    );
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockImplementation(async (id, version, name, draft) => robot(id, name, draft, version + 1));
    render(<SavedRobots api={api({ saveRobot })} editor={editorState.ref} session={session()} />);

    const canceledForm = await fillCreateForm('Captura cancelada');
    act(() => {
      const submit = () =>
        canceledForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      submit();
      submit();
    });
    expect(editorState.current.captureSnapshot).toHaveBeenCalledOnce();
    const cancel = within(canceledForm).getByRole('button', { name: 'Cancelar' });
    expect.soft((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByLabelText('Nombre para la nueva copia')).toBeNull());

    const currentForm = await fillCreateForm('Nueva acción vigente');
    fireEvent.submit(currentForm);
    await waitFor(() => expect(editorState.current.captureSnapshot).toHaveBeenCalledTimes(2));
    await act(async () => {
      canceledSnapshot.resolve({ version: 4, draft: createDefaultDraft() });
      await canceledSnapshot.promise;
    });
    expect(saveRobot).not.toHaveBeenCalled();
    const currentName = screen.getByLabelText('Nombre para la nueva copia') as HTMLInputElement;
    expect(currentName.value).toBe('Nueva acción vigente');
    expect(currentName.disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Guardar una copia' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      currentSnapshot.resolve({ version: 5, draft: currentDraft });
      await currentSnapshot.promise;
    });
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    expect(saveRobot.mock.calls[0]?.slice(1, 4)).toEqual([0, 'Nueva acción vigente', currentDraft]);
    expect(editorState.current.captureSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Guardaste «Captura cancelada»/u)).toBeNull();
    expect(screen.getByText('Guardaste «Nueva acción vigente» como robot nuevo.')).toBeTruthy();
  });

  it('invalidates a captured create when selection changes before the snapshot resolves', async () => {
    const first = robot('copy-a', 'Robot A', {
      ...createDefaultDraft(),
      instructions: 'Literal A.',
    });
    const second = robot('copy-b', 'Robot B', {
      ...createDefaultDraft(),
      instructions: 'Literal B.',
    });
    const snapshot = deferred<DraftSnapshot | null>();
    const editorState = editor(
      vi.fn<RobotEditorHandle['captureSnapshot']>().mockReturnValue(snapshot.promise),
    );
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>();
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot: vi
        .fn<SavedRobotApi['getRobot']>()
        .mockImplementation(async (id) => (id === first.id ? first : second)),
      saveRobot,
    });
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);
    await chooseCopy(first.name);
    const form = await openCreateForm('Copia nueva de A');
    await waitFor(() => expect(editorState.current.captureSnapshot).toHaveBeenCalledOnce());

    const selectedB = await chooseCopy(second.name);
    selectedB.focus();
    await act(async () => {
      snapshot.resolve({ version: 4, draft: createDefaultDraft() });
      await snapshot.promise;
    });

    expect(saveRobot).not.toHaveBeenCalled();
    expect(selectedB.checked).toBe(true);
    expect(within(selectedPanel()).getByRole('heading', { name: second.name })).toBeTruthy();
    expect(within(selectedPanel()).queryByText(second.draft.instructions)).not.toBeNull();
    expect(screen.queryByText('Guardaste «Copia nueva de A» como robot nuevo.')).toBeNull();
    expect(document.activeElement).toBe(selectedB);
    expect(form.isConnected).toBe(false);
  });

  it.each(['leaveSurface', 'paused', 'locked', 'identity', 'unmount'] as const)(
    'does not send a late snapshot after %s invalidates the create owner',
    async (abandonment) => {
      const snapshot = deferred<DraftSnapshot | null>();
      const editorState = editor(
        vi.fn<RobotEditorHandle['captureSnapshot']>().mockReturnValue(snapshot.promise),
      );
      const saveRobot = vi.fn<SavedRobotApi['saveRobot']>();
      const savedApi = api({ saveRobot });
      const handle = createRef<SavedRobotsHandle>();
      const renderLibrary = (
        sub = 'create-intent-user',
        props: { active?: boolean; paused?: boolean; locked?: boolean } = {},
      ) => (
        <SavedRobots
          ref={handle}
          api={savedApi}
          editor={editorState.ref}
          session={session(sub)}
          {...props}
        />
      );
      const view = render(renderLibrary());
      const form = await openCreateForm(`Captura ${abandonment}`);
      await waitFor(() => expect(editorState.current.captureSnapshot).toHaveBeenCalledOnce());

      if (abandonment === 'leaveSurface') {
        act(() => {
          handle.current?.leaveSurface();
          view.rerender(renderLibrary('create-intent-user', { active: false }));
        });
      } else if (abandonment === 'paused') {
        view.rerender(renderLibrary('create-intent-user', { paused: true }));
      } else if (abandonment === 'locked') {
        view.rerender(renderLibrary('create-intent-user', { locked: true }));
      } else if (abandonment === 'identity') {
        view.rerender(renderLibrary('different-user'));
      } else {
        view.unmount();
      }

      await act(async () => {
        snapshot.resolve({ version: 4, draft: createDefaultDraft() });
        await snapshot.promise;
      });

      expect(editorState.current.captureSnapshot).toHaveBeenCalledOnce();
      expect(saveRobot).not.toHaveBeenCalled();
      if (abandonment !== 'unmount') {
        expect(
          screen.queryByText(`Guardaste «Captura ${abandonment}» como robot nuevo.`),
        ).toBeNull();
        expect(form.isConnected).toBe(false);
      }
    },
  );

  it.each([
    { finalSelection: 'Robot B', sequence: ['Robot A', 'Robot B'] },
    { finalSelection: 'Robot A', sequence: ['Robot A', 'Robot B', 'Robot A'] },
  ])(
    'records a late matching readback by ID without restoring the canceled $sequence intent',
    async ({ finalSelection, sequence }) => {
      const first = robot('copy-a', 'Robot A', {
        ...createDefaultDraft(),
        instructions: 'Literal A.',
      });
      const second = robot('copy-b', 'Robot B', {
        ...createDefaultDraft(),
        instructions: 'Literal B.',
      });
      const capturedDraft = { ...createDefaultDraft(), instructions: 'Snapshot inmutable.' };
      const write = deferred<SavedRobot>();
      const readback = deferred<SavedRobot>();
      let createdId: string | undefined;
      const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation(async (id) => {
        if (id === first.id) return first;
        if (id === second.id) return second;
        if (id === createdId) return readback.promise;
        throw new SavedRobotApiFailure('not_found', 'ID no solicitado.', 404);
      });
      const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockImplementation((id) => {
        createdId = id;
        return write.promise;
      });
      const editorState = editor(
        vi.fn<RobotEditorHandle['captureSnapshot']>().mockResolvedValue({
          version: 4,
          draft: capturedDraft,
        }),
      );
      const savedApi = api({
        listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
        getRobot,
        saveRobot,
      });
      render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);
      await chooseCopy(first.name);
      await openCreateForm('Copia nueva');
      await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
      const originalCreateId = createdId;
      expect(originalCreateId).toMatch(/^[0-9a-f-]{36}$/iu);
      expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
        originalCreateId,
        0,
        'Copia nueva',
        capturedDraft,
      ]);
      for (const name of sequence.slice(1)) {
        const selected = await chooseCopy(name);
        selected.focus();
      }
      if (sequence.length === 2) {
        write.resolve(robot(originalCreateId!, 'Copia nueva', capturedDraft, 1));
        await act(async () => await write.promise);
      } else {
        write.reject(
          new SavedRobotApiFailure('network', 'Respuesta incierta.', undefined, undefined, true),
        );
        await waitFor(() =>
          expect(getRobot.mock.calls.map((call) => call[0])).toContain(originalCreateId),
        );
        await act(async () => {
          readback.resolve(robot(originalCreateId!, 'Copia nueva', capturedDraft, 1));
          await readback.promise;
        });
      }

      await screen.findByRole('radio', { name: /Copia nueva/u });
      const activeRadio = screen.getByRole('radio', {
        name: new RegExp(finalSelection, 'u'),
      }) as HTMLInputElement;
      const createdRadio = screen.getByRole('radio', { name: /Copia nueva/u }) as HTMLInputElement;
      const expectedCopy = finalSelection === first.name ? first : second;
      expect(createdRadio.checked).toBe(false);
      expect(activeRadio.checked).toBe(true);
      expect(document.activeElement).toBe(activeRadio);
      expect(
        within(selectedPanel()).getByRole('heading', { name: expectedCopy.name }),
      ).toBeTruthy();
      expect(within(selectedPanel()).getByText(expectedCopy.draft.instructions)).toBeTruthy();
      expect(screen.queryByText('Guardaste «Copia nueva» como robot nuevo.')).toBeNull();
      expect(saveRobot).toHaveBeenCalledOnce();
      expect(editorState.current.captureSnapshot).toHaveBeenCalledOnce();
      if (sequence.length === 2) {
        expect(getRobot.mock.calls.map((call) => call[0])).not.toContain(originalCreateId);
      } else {
        expect(getRobot.mock.calls.at(-1)?.[0]).toBe(originalCreateId);
      }
    },
  );

  it('checks the requested ID before accepting a successful create response for another document', async () => {
    const capturedDraft = { ...createDefaultDraft(), instructions: 'Contenido solicitado.' };
    const foreignDraft = { ...createDefaultDraft(), instructions: 'Contenido ajeno.' };
    let createdId: string | undefined;
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockImplementation(async (id) => {
      createdId = id;
      return robot('foreign-id', 'Respuesta ajena', foreignDraft, 1);
    });
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation(async (id) => {
      if (id === createdId) return robot(id, 'Copia solicitada', capturedDraft, 1);
      throw new SavedRobotApiFailure('not_found', 'ID no solicitado.', 404);
    });
    const savedApi = api({
      saveRobot,
      getRobot,
    });
    const editorState = editor(
      vi.fn<RobotEditorHandle['captureSnapshot']>().mockResolvedValue({
        version: 4,
        draft: capturedDraft,
      }),
    );
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    await openCreateForm('Copia solicitada');
    const requestedId = saveRobot.mock.calls[0]?.[0];
    expect(requestedId).toMatch(/^[0-9a-f-]{36}$/iu);
    await waitFor(() => expect(getRobot.mock.calls.length).toBeGreaterThan(0));

    const createdRadio = await screen.findByRole('radio', { name: /Copia solicitada/u });
    expect(getRobot.mock.calls.map((call) => call[0])).toEqual([requestedId]);
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(createdRadio.getAttribute('value')).toBe(requestedId);
    expect(screen.queryByRole('radio', { name: /Respuesta ajena/u })).toBeNull();
    expect(
      within(selectedPanel()).queryByText(foreignDraft.instructions, {
        normalizer: (text) => text,
      }),
    ).toBeNull();
    expect(screen.getByText('Guardaste «Copia solicitada» como robot nuevo.')).toBeTruthy();
  });

  it('checks a canceled sent create by its ID without resending, then treats a new action as new intent', async () => {
    const firstCapture = { ...createDefaultDraft(), instructions: 'Snapshot cancelado.' };
    const secondCapture = { ...createDefaultDraft(), instructions: 'Snapshot nuevo.' };
    const firstWrite = deferred<SavedRobot>();
    const captureSnapshot = vi
      .fn<RobotEditorHandle['captureSnapshot']>()
      .mockResolvedValueOnce({ version: 4, draft: firstCapture })
      .mockResolvedValueOnce({ version: 5, draft: secondCapture });
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'No se pudo comprobar todavía.'))
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('not_found', 'La copia todavía no existe.', 404),
      );
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockImplementationOnce(async (id, version, name, draft) =>
        robot(id, name, draft, version + 1),
      );
    const savedApi = api({
      getRobot,
      saveRobot,
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
    });
    const editorState = editor(captureSnapshot);
    const sessionState = session();
    const view = render(
      <SavedRobots api={savedApi} editor={editorState.ref} session={sessionState} />,
    );

    const form = await openCreateForm('Intención cancelada');
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    const canceledId = saveRobot.mock.calls[0]?.[0];
    expect(saveRobot.mock.calls[0]?.slice(1, 4)).toEqual([0, 'Intención cancelada', firstCapture]);
    const cancel = within(form).getByRole('button', { name: 'Cancelar' });
    expect.soft(cancel.hasAttribute('disabled')).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByLabelText('Nombre para la nueva copia')).toBeNull());

    firstWrite.reject(
      new SavedRobotApiFailure('network', 'No se confirmó el envío.', undefined, undefined, true),
    );
    await waitFor(() => expect(getRobot.mock.calls[0]?.[0]).toBe(canceledId));
    expect(await screen.findByRole('button', { name: 'Comprobar guardado' })).toBeTruthy();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(getRobot).toHaveBeenCalledOnce();
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledOnce();
    view.rerender(
      <SavedRobots api={savedApi} editor={editorState.ref} session={sessionState} paused />,
    );
    expect(
      (screen.getByRole('button', { name: 'Comprobar guardado' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    vi.useRealTimers();
    view.rerender(<SavedRobots api={savedApi} editor={editorState.ref} session={sessionState} />);

    fireEvent.click(screen.getByRole('button', { name: 'Comprobar guardado' }));
    await waitFor(() =>
      expect(getRobot.mock.calls.map((call) => call[0])).toEqual([canceledId, canceledId]),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Comprobar guardado' })).toBeNull(),
    );
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Guardaste «Intención cancelada»/u)).toBeNull();

    await openCreateForm('Nueva acción');
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    const newId = saveRobot.mock.calls[1]?.[0];
    expect(newId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(newId).not.toBe(canceledId);
    expect(saveRobot.mock.calls[1]?.slice(1, 4)).toEqual([0, 'Nueva acción', secondCapture]);
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
  });
});
