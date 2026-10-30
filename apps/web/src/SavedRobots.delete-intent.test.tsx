// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { ApiAuthRequired } from './api-auth.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { SavedRobots, type SavedRobotsHandle } from './SavedRobots.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';
import { installHtmlDialogTestShim } from './configuration-confirmation.test-support.js';

function session(sub = 'delete-intent-user'): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub, email: `${sub}@example.test` },
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
        email: `${sub}@example.test`,
      },
      expires_at: now + 3_600,
    }),
  };
}

function robot(id: string, name: string, instructions: string, version = 1): SavedRobot {
  return {
    id,
    name,
    version,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    modelKey: 'claude-sonnet-4.6',
    draft: { ...createDefaultDraft(), instructions },
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

function editor() {
  const current = {
    captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    applyDraft: vi.fn().mockResolvedValue(true),
    cancelApplication: vi.fn(),
    hasUnconfirmedChanges: vi.fn().mockReturnValue(false),
    discardPending: vi.fn(),
    flushPending: vi.fn().mockResolvedValue(true),
    waitForConfirmed: vi.fn().mockResolvedValue(true),
    releaseAttemptLock: vi.fn(),
  };
  return {
    current,
    ref: { current } as unknown as React.RefObject<RobotEditorHandle | null>,
  };
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
  const first = robot('copy-a', 'Robot A', 'Literal de A.');
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [summary(first)] }),
    getRobot: vi.fn().mockResolvedValue(first),
    saveRobot: vi
      .fn()
      .mockImplementation(async (id: string, version: number, name: string, draft: RobotDraft) => ({
        ...first,
        id,
        name,
        version: version + 1,
        draft,
      })),
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides,
  };
}

function selectedPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

function expectFocusInLibrary(): void {
  const stableTargets = [
    screen.getByRole('heading', { name: 'Mis robots' }),
    screen.getByRole('heading', { name: 'Robots guardados' }),
    ...screen.queryAllByRole('radio', { name: /Robot [AB]/u }),
  ];
  expect(stableTargets).toContain(document.activeElement);
}

async function selectCopy(name: string): Promise<HTMLInputElement> {
  const radio = (await screen.findByRole('radio', {
    name: new RegExp(name, 'u'),
  })) as HTMLInputElement;
  fireEvent.click(radio);
  await waitFor(() => expect(radio.checked).toBe(true));
  await waitFor(() => expect(within(selectedPanel()).getByRole('heading', { name })).toBeTruthy());
  return radio;
}

function openMoreActionsForSelected(): void {
  const summaryElement = screen.getByText('Más acciones', { selector: 'summary' });
  if (!(summaryElement.closest('details') as HTMLDetailsElement).open) {
    fireEvent.click(summaryElement);
  }
}

function deleteSelectedCopy(): void {
  openMoreActionsForSelected();
  fireEvent.click(screen.getByRole('button', { name: /Eliminar copia/u }));
}

let restoreDialogShim: (() => void) | undefined;

beforeAll(() => {
  restoreDialogShim = installHtmlDialogTestShim();
});

afterAll(() => restoreDialogShim?.());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SavedRobots delete intent acceptance', () => {
  it('keeps a newly selected copy and its focus when an earlier delete succeeds', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal de A.');
    const second = robot('copy-b', 'Robot B', 'Literal de B.');
    const pendingDelete = deferred<{ deleted: true }>();
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockReturnValue(pendingDelete.promise);
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockImplementation(async (id) => (id === first.id ? first : second));
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      deleteRobot,
    });
    const editorState = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    await selectCopy(first.name);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([first.id, first.version]),
    );

    const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
    fireEvent.click(secondRadio);
    await waitFor(() => expect(secondRadio.checked).toBe(true));
    expect(document.activeElement).toBe(secondRadio);

    await act(async () => {
      pendingDelete.resolve({ deleted: true });
      await pendingDelete.promise;
    });

    await waitFor(() =>
      expect(within(selectedPanel()).getByText(second.draft.instructions)).toBeTruthy(),
    );
    expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull();
    expect(secondRadio.checked).toBe(true);
    expect(document.activeElement).toBe(secondRadio);
    expect(within(selectedPanel()).queryByText(first.draft.instructions)).toBeNull();
    expect(editorState.current.captureSnapshot).not.toHaveBeenCalled();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('returns focus to the library when a successful delete removes its focused action', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal de A.');
    const second = robot('copy-b', 'Robot B', 'Literal de B.');
    const deleteRobot = vi.fn<SavedRobotApi['deleteRobot']>().mockResolvedValue({ deleted: true });
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot: vi
        .fn<SavedRobotApi['getRobot']>()
        .mockImplementation(async (id) => (id === first.id ? first : second)),
      deleteRobot,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(first.name);
    openMoreActionsForSelected();
    const deleteButton = screen.getByRole('button', { name: /Eliminar copia/u });
    deleteButton.focus();
    fireEvent.click(deleteButton);

    await waitFor(() => expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull());
    await waitFor(() => expectFocusInLibrary());
    expect((screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(within(selectedPanel()).getByRole('heading', { name: 'Elegí una copia' })).toBeTruthy();
    confirm.mockRestore();
  });

  it('does not restore a selected-copy read that finishes after a 404 delete check', async () => {
    const target = robot('copy-a', 'Robot A', 'Versión consultada antes de borrar.', 1);
    const laterRead = robot('copy-a', 'Robot A', 'Respuesta tardía con versión anterior.', 2);
    const pendingSelectionRead = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockReturnValueOnce(pendingSelectionRead.promise)
      .mockRejectedValueOnce(new SavedRobotApiFailure('not_found', 'No existe.', 404));
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const savedApi = api({ getRobot, deleteRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(target.name);
    expect(getRobot).toHaveBeenCalledOnce();
    deleteSelectedCopy();
    await waitFor(() => expect(getRobot.mock.calls.length).toBe(2));
    expect(getRobot.mock.calls[0]?.[0]).toBe(target.id);
    expect(getRobot.mock.calls[1]?.[0]).toBe(target.id);

    await waitFor(() => expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull());
    await act(async () => {
      pendingSelectionRead.resolve(laterRead);
      await pendingSelectionRead.promise;
    });

    expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull();
    expect(within(selectedPanel()).getByRole('heading', { name: 'Elegí una copia' })).toBeTruthy();
    expect(within(selectedPanel()).queryByText(laterRead.draft.instructions)).toBeNull();

    expect(deleteRobot).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it('does not publish an earlier delete readback error over a newly selected copy', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal de A.');
    const second = robot('copy-b', 'Robot B', 'Literal de B.');
    const pendingReadback = deferred<SavedRobot>();
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation((id) => {
      if (
        id === first.id &&
        getRobot.mock.calls.filter(([calledId]) => calledId === first.id).length > 1
      ) {
        return pendingReadback.promise;
      }
      return Promise.resolve(id === first.id ? first : second);
    });
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      deleteRobot,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(first.name);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(2),
    );
    expect(getRobot.mock.calls[1]?.[0]).toBe(first.id);

    const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
    fireEvent.click(secondRadio);
    await waitFor(() => expect(secondRadio.checked).toBe(true));
    await act(async () => {
      pendingReadback.resolve(first);
      await pendingReadback.promise;
    });

    await waitFor(() =>
      expect(within(selectedPanel()).getByText(second.draft.instructions)).toBeTruthy(),
    );
    expect(secondRadio.checked).toBe(true);
    expect(document.activeElement).toBe(secondRadio);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Robot A.*No se pudo confirmar la eliminación/u)).toBeNull();
    confirm.mockRestore();
  });

  it('ignores a sent delete failure after the account changes', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal de la cuenta anterior.');
    const second = robot('copy-b', 'Robot B', 'Literal de la cuenta actual.');
    const pendingDelete = deferred<{ deleted: true }>();
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockReturnValue(pendingDelete.promise);
    const savedApi = api({
      listRobots: vi
        .fn<SavedRobotApi['listRobots']>()
        .mockResolvedValueOnce({ robots: [summary(first)] })
        .mockResolvedValueOnce({ robots: [summary(second)] }),
      getRobot: vi
        .fn<SavedRobotApi['getRobot']>()
        .mockImplementation(async (id) => (id === first.id ? first : second)),
      deleteRobot,
    });
    const onAuthRequired = vi.fn<ApiAuthRequired>().mockReturnValue(false);
    const editorState = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const renderIdentity = (currentSession: AuthSession) => (
      <SavedRobots
        key={currentSession.identity.sub}
        api={savedApi}
        editor={editorState.ref}
        session={currentSession}
        onAuthRequired={onAuthRequired}
      />
    );
    const view = render(renderIdentity(session('account-a')));

    await selectCopy(first.name);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([first.id, first.version]),
    );
    view.rerender(renderIdentity(session('account-b')));
    await selectCopy(second.name);

    await act(async () => {
      pendingDelete.reject(
        new SavedRobotApiFailure(
          'authentication',
          'La sesión anterior venció.',
          401,
          undefined,
          false,
          {
            authContext: 71,
          },
        ),
      );
      await pendingDelete.promise.catch(() => undefined);
    });

    expect(onAuthRequired).not.toHaveBeenCalled();
    expect(within(selectedPanel()).getByText(second.draft.instructions)).toBeTruthy();
    expect(screen.queryByText('La sesión anterior venció.')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(editorState.current.captureSnapshot).not.toHaveBeenCalled();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('does not let a previous account deletion release a newer deletion operation', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal de la cuenta anterior.');
    const second = robot('copy-b', 'Robot B', 'Literal de la cuenta actual.');
    const previousDelete = deferred<{ deleted: true }>();
    const currentDelete = deferred<{ deleted: true }>();
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockReturnValueOnce(previousDelete.promise)
      .mockReturnValueOnce(currentDelete.promise);
    const savedApi = api({
      listRobots: vi
        .fn<SavedRobotApi['listRobots']>()
        .mockResolvedValueOnce({ robots: [summary(first)] })
        .mockResolvedValueOnce({ robots: [summary(second)] }),
      getRobot: vi
        .fn<SavedRobotApi['getRobot']>()
        .mockImplementation(async (id) => (id === first.id ? first : second)),
      deleteRobot,
    });
    const editorState = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const renderIdentity = (currentSession: AuthSession) => (
      <SavedRobots api={savedApi} editor={editorState.ref} session={currentSession} />
    );
    const view = render(renderIdentity(session('account-a')));

    await selectCopy(first.name);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([first.id, first.version]),
    );

    view.rerender(renderIdentity(session('account-b')));
    await selectCopy(second.name);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(deleteRobot.mock.calls[1]?.slice(0, 2)).toEqual([second.id, second.version]),
    );

    await act(async () => {
      previousDelete.resolve({ deleted: true });
      await previousDelete.promise;
    });
    openMoreActionsForSelected();
    expect(
      (screen.getByRole('button', { name: /Eliminar copia/u }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('radio', { name: /Robot B/u })).toBeTruthy();
    expect(within(selectedPanel()).getByText(second.draft.instructions)).toBeTruthy();

    await act(async () => {
      currentDelete.resolve({ deleted: true });
      await currentDelete.promise;
    });
    await waitFor(() => expect(screen.queryByRole('radio', { name: /Robot B/u })).toBeNull());
    expect(deleteRobot).toHaveBeenCalledTimes(2);
    expect(editorState.current.captureSnapshot).not.toHaveBeenCalled();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it.each([
    { name: 'pauses access', paused: true, active: true, locked: false },
    { name: 'leaves the library', paused: false, active: false, locked: false, leave: true },
    { name: 'locks management', paused: false, active: true, locked: true },
  ])(
    'does not continue a sent delete after the library $name',
    async ({ paused, active, locked, leave }) => {
      const first = robot('copy-a', 'Robot A', 'Literal de A.');
      const pendingDelete = deferred<{ deleted: true }>();
      const deleteRobot = vi
        .fn<SavedRobotApi['deleteRobot']>()
        .mockReturnValue(pendingDelete.promise);
      const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(first);
      const savedApi = api({ getRobot, deleteRobot });
      const editorState = editor();
      const libraryRef = createRef<SavedRobotsHandle>();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const renderLibrary = (isPaused: boolean, isActive: boolean, isLocked: boolean) => (
        <SavedRobots
          ref={libraryRef}
          api={savedApi}
          editor={editorState.ref}
          session={session()}
          paused={isPaused}
          active={isActive}
          locked={isLocked}
        />
      );
      const view = render(renderLibrary(false, true, false));

      await selectCopy(first.name);
      expect(getRobot).toHaveBeenCalledOnce();
      deleteSelectedCopy();
      await waitFor(() => expect(deleteRobot).toHaveBeenCalledOnce());
      if (leave) {
        act(() => libraryRef.current?.leaveSurface());
      }
      view.rerender(renderLibrary(paused, active, locked));

      await act(async () => {
        pendingDelete.reject(
          new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
        );
        await pendingDelete.promise.catch(() => undefined);
      });

      await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(locked ? 2 : 1));
      expect(deleteRobot).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledOnce();
      expect(screen.queryByRole('alert')).toBeNull();
      confirm.mockRestore();
    },
  );

  it('reads the same ID and version before allowing any further delete', async () => {
    const target = robot('copy-a', 'Robot A', 'Literal de A.');
    const firstContinuationReadback = deferred<SavedRobot>();
    const secondContinuationReadback = deferred<SavedRobot>();
    let readCount = 0;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation(async () => {
      readCount += 1;
      if (readCount === 3) return firstContinuationReadback.promise;
      if (readCount === 5) return secondContinuationReadback.promise;
      return target;
    });
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      )
      .mockRejectedValueOnce(
        new SavedRobotApiFailure(
          'network',
          'La continuación tampoco se confirmó.',
          undefined,
          undefined,
          true,
        ),
      )
      .mockResolvedValueOnce({ deleted: true });
    const savedApi = api({
      getRobot,
      deleteRobot,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(target.name);
    deleteSelectedCopy();

    await waitFor(() => expect(getRobot.mock.calls.length).toBe(2));
    expect(deleteRobot).toHaveBeenCalledOnce();
    expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([target.id, target.version]);
    expect(getRobot.mock.calls[1]?.[0]).toBe(target.id);
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('radio', { name: /Robot A/u })).toBeTruthy();

    deleteSelectedCopy();
    await waitFor(() => expect(getRobot.mock.calls.length).toBe(3));
    expect(getRobot.mock.calls[2]?.[0]).toBe(target.id);
    expect(deleteRobot).toHaveBeenCalledOnce();
    await act(async () => {
      firstContinuationReadback.resolve(target);
      await firstContinuationReadback.promise;
    });
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getRobot.mock.calls.length).toBe(4));
    expect(getRobot.mock.calls[3]?.[0]).toBe(target.id);
    expect(deleteRobot.mock.calls.map(([id, version]) => [id, version])).toEqual([
      [target.id, target.version],
      [target.id, target.version],
    ]);
    expect(confirm).toHaveBeenCalledOnce();

    deleteSelectedCopy();
    await waitFor(() => expect(getRobot.mock.calls.length).toBe(5));
    expect(getRobot.mock.calls[4]?.[0]).toBe(target.id);
    expect(deleteRobot).toHaveBeenCalledTimes(2);
    await act(async () => {
      secondContinuationReadback.resolve(target);
      await secondContinuationReadback.promise;
    });
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(3));
    expect(deleteRobot.mock.calls.map(([id, version]) => [id, version])).toEqual([
      [target.id, target.version],
      [target.id, target.version],
      [target.id, target.version],
    ]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull();
    confirm.mockRestore();
  });

  it('requires a fresh confirmation when an ambiguous delete readback finds a newer version', async () => {
    const target = robot('copy-a', 'Robot A', 'Literal de A.', 1);
    const current = robot('copy-a', 'Robot A', 'Literal actualizado en el servidor.', 2);
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      )
      .mockResolvedValueOnce({ deleted: true });
    const savedApi = api({
      getRobot: vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(current),
      deleteRobot,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(target.name);
    deleteSelectedCopy();
    await screen.findByRole('button', { name: 'Actualizar versión para Eliminar' });

    expect(deleteRobot).toHaveBeenCalledOnce();
    expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([target.id, target.version]);
    expect(confirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Actualizar versión para Eliminar' })).toBeNull(),
    );
    expect(screen.getByText(/Confirmá «Eliminar» nuevamente/u)).toBeTruthy();

    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(2));
    expect(deleteRobot.mock.calls.map(([id, version]) => [id, version])).toEqual([
      [target.id, target.version],
      [target.id, current.version],
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('does not revive an A-to-B-to-A delete and checks its debt without deleting', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal de A.');
    const second = robot('copy-b', 'Robot B', 'Literal de B.');
    const pendingReadback = deferred<SavedRobot>();
    let firstReadCount = 0;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation((id) => {
      if (id === first.id) {
        firstReadCount += 1;
        if (firstReadCount === 2) return pendingReadback.promise;
        return Promise.resolve(first);
      }
      return Promise.resolve(second);
    });
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      )
      .mockResolvedValueOnce({ deleted: true });
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      deleteRobot,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(first.name);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(2),
    );
    expect(deleteRobot).toHaveBeenCalledOnce();

    const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
    fireEvent.click(secondRadio);
    await waitFor(() => expect(secondRadio.checked).toBe(true));
    const firstRadio = screen.getByRole('radio', { name: /Robot A/u }) as HTMLInputElement;
    fireEvent.click(firstRadio);
    await waitFor(() => expect(firstRadio.checked).toBe(true));
    await act(async () => {
      pendingReadback.reject(new SavedRobotApiFailure('network', 'La consulta falló.'));
      await pendingReadback.promise.catch(() => undefined);
    });
    await selectCopy(second.name);
    expect(within(selectedPanel()).getByText(second.draft.instructions)).toBeTruthy();
    expect
      .soft(
        (screen.getByRole('button', { name: 'Guardar robot actual' }) as HTMLButtonElement)
          .disabled,
      )
      .toBe(true);
    openMoreActionsForSelected();
    expect
      .soft((screen.getByRole('button', { name: 'Renombrar' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect
      .soft(
        (
          screen.getByRole('button', {
            name: /Reemplazar con mi robot actual/u,
          }) as HTMLButtonElement
        ).disabled,
      )
      .toBe(true);
    expect
      .soft((screen.getByRole('button', { name: /Eliminar copia/u }) as HTMLButtonElement).disabled)
      .toBe(true);
    const check = screen.queryByRole('button', { name: /Comprobar eliminación/u });
    expect.soft(check).not.toBeNull();
    if (!check) {
      confirm.mockRestore();
      return;
    }
    expect((check as HTMLButtonElement).disabled).toBe(false);
    check.focus();
    const targetReadsBeforeCheck = getRobot.mock.calls.filter(([id]) => id === first.id).length;
    fireEvent.click(check);
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(
        targetReadsBeforeCheck + 1,
      ),
    );
    expect(deleteRobot).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Comprobar eliminación/u })).toBeNull(),
    );
    await waitFor(() => expectFocusInLibrary());
    expect(deleteRobot).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(secondRadio.checked).toBe(true);
    expect(within(selectedPanel()).getByText(second.draft.instructions)).toBeTruthy();
    await selectCopy(first.name);
    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(2));
    expect(deleteRobot.mock.calls.map(([id, version]) => [id, version])).toEqual([
      [first.id, first.version],
      [first.id, first.version],
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('accepts a canceled debt readback 404 as absence without another delete', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal de A.');
    const second = robot('copy-b', 'Robot B', 'Literal de B.');
    const pendingReadback = deferred<SavedRobot>();
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation((id) => {
      if (
        id === first.id &&
        getRobot.mock.calls.filter(([calledId]) => calledId === first.id).length > 1
      ) {
        return pendingReadback.promise;
      }
      return Promise.resolve(id === first.id ? first : second);
    });
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      deleteRobot,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(first.name);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(2),
    );
    const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
    fireEvent.click(secondRadio);
    await waitFor(() => expect(secondRadio.checked).toBe(true));
    await act(async () => {
      pendingReadback.reject(new SavedRobotApiFailure('not_found', 'No existe.', 404));
      await pendingReadback.promise.catch(() => undefined);
    });

    await waitFor(() => expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull());
    await waitFor(() =>
      expect(within(selectedPanel()).getByText(second.draft.instructions)).toBeTruthy(),
    );
    expect(secondRadio.checked).toBe(true);
    expect(deleteRobot).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it('keeps canceled debt after a foreign-ID check and does not poll', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal de A.');
    const second = robot('copy-b', 'Robot B', 'Literal de B.');
    const foreign = robot('copy-foreign', 'Robot de otra ficha', 'Contenido ajeno.');
    const readbackFailure = deferred<SavedRobot>();
    let firstReadCount = 0;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation((id) => {
      if (id === first.id) {
        firstReadCount += 1;
        if (firstReadCount === 2) return readbackFailure.promise;
        if (firstReadCount === 3) return Promise.resolve(foreign);
        return Promise.resolve(first);
      }
      return Promise.resolve(second);
    });
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      deleteRobot,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(first.name);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(2),
    );
    const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
    fireEvent.click(secondRadio);
    await waitFor(() => expect(secondRadio.checked).toBe(true));
    await act(async () => {
      readbackFailure.reject(new SavedRobotApiFailure('network', 'La consulta falló.'));
      await readbackFailure.promise.catch(() => undefined);
    });
    await waitFor(() =>
      expect(within(selectedPanel()).getByText(second.draft.instructions)).toBeTruthy(),
    );

    const check = await screen.findByRole('button', { name: /Comprobar eliminación/u });
    const targetReadsBeforeCheck = getRobot.mock.calls.filter(([id]) => id === first.id).length;
    fireEvent.click(check);
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(
        targetReadsBeforeCheck + 1,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Comprobar eliminación/u })).toBeTruthy(),
    );

    expect(deleteRobot).toHaveBeenCalledOnce();
    expect(screen.getByRole('radio', { name: /Robot A/u })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Robot de otra ficha/u })).toBeNull();
    expect(secondRadio.checked).toBe(true);
    confirm.mockRestore();
  });

  it('does not adopt a foreign summary from a conditional-delete conflict', async () => {
    const target = robot('copy-a', 'Robot A', 'Literal de A.');
    const foreign = robot('copy-foreign', 'Robot de otra ficha', 'Contenido ajeno.', 7);
    const deleteRobot = vi.fn<SavedRobotApi['deleteRobot']>().mockRejectedValue(
      new SavedRobotApiFailure('conflict', 'Conflicto.', 409, undefined, false, {
        currentSummary: summary(foreign),
      }),
    );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(target)] }),
      getRobot: vi.fn().mockResolvedValue(target),
      deleteRobot,
    });
    const editorState = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    await selectCopy(target.name);
    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Mis robots' }).getAttribute('aria-busy')).toBe(
        'false',
      ),
    );

    expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([target.id, target.version]);
    expect(screen.getByRole('radio', { name: /Robot A/u })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Robot de otra ficha/u })).toBeNull();
    expect(editorState.current.captureSnapshot).not.toHaveBeenCalled();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('requires a new confirmation for an incompatible historical copy version', async () => {
    const target = robot('legacy-copy', 'Histórica incompatible', 'Contenido no consultable.', 6);
    const newerSummary = { ...summary(target), version: 7 };
    const incompatible = new SavedRobotApiFailure(
      'incompatible',
      'La configuración guardada no es compatible.',
    );
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      )
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('conflict', 'La versión cambió.', 409, undefined, false, {
          currentSummary: newerSummary,
        }),
      )
      .mockResolvedValueOnce({ deleted: true });
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockRejectedValue(incompatible);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(target)] }),
      getRobot,
      deleteRobot,
    });
    const editorState = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    const radio = (await screen.findByRole('radio', {
      name: /Histórica incompatible/u,
    })) as HTMLInputElement;
    fireEvent.click(radio);
    await waitFor(() => expect(screen.getByText(incompatible.message)).toBeTruthy());
    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledOnce());
    await waitFor(() => expect(getRobot.mock.calls.length).toBe(2));
    expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([target.id, target.version]);
    expect(confirm).toHaveBeenCalledOnce();

    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(2));
    expect(deleteRobot.mock.calls[1]?.slice(0, 2)).toEqual([target.id, target.version]);
    expect(confirm).toHaveBeenCalledTimes(2);
    await screen.findByRole('button', { name: 'Actualizar versión para Eliminar' });

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Actualizar versión para Eliminar' })).toBeNull(),
    );
    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(3));
    expect(deleteRobot.mock.calls.map(([id, version]) => [id, version])).toEqual([
      [target.id, target.version],
      [target.id, target.version],
      [target.id, newerSummary.version],
    ]);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(editorState.current.captureSnapshot).not.toHaveBeenCalled();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('does not schedule a timer for a failed delete readback', async () => {
    const target = robot('copy-a', 'Robot A', 'Literal de A.');
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockResolvedValueOnce(target)
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'La consulta falló.'));
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const savedApi = api({ getRobot, deleteRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);

    await selectCopy(target.name);
    deleteSelectedCopy();
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(getRobot).toHaveBeenCalledTimes(2);
    expect(deleteRobot).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });
});
