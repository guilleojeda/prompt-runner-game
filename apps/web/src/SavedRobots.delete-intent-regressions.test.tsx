// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { SavedRobots, type SavedRobotsHandle } from './SavedRobots.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

function session(): AuthSession {
  const sub = 'delete-regression-user';
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub, email: `${sub}@example.test` },
    user: new User({
      access_token: 'delete-regression-token',
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

function robot(id: string, name: string, instructions: string): SavedRobot {
  return {
    id,
    name,
    version: 1,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function editor(): React.RefObject<RobotEditorHandle | null> {
  return {
    current: {
      captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
      applyDraft: vi.fn().mockResolvedValue(true),
      cancelApplication: vi.fn(),
      hasUnconfirmedChanges: vi.fn().mockReturnValue(false),
      discardPending: vi.fn(),
      flushPending: vi.fn().mockResolvedValue(true),
      waitForConfirmed: vi.fn().mockResolvedValue(true),
      releaseAttemptLock: vi.fn(),
    },
  } as unknown as React.RefObject<RobotEditorHandle | null>;
}

function api(overrides: Partial<SavedRobotApi> = {}): SavedRobotApi {
  const first = robot('copy-a', 'Robot A', 'Literal A.');
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [summary(first)] }),
    getRobot: vi.fn().mockResolvedValue(first),
    saveRobot: vi.fn().mockImplementation(async (id, version, name, draft) => ({
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

function openMoreActions(): void {
  const summaryElement = screen.getByText('Más acciones', { selector: 'summary' });
  if (!(summaryElement.closest('details') as HTMLDetailsElement).open) {
    fireEvent.click(summaryElement);
  }
}

function startDelete(): void {
  openMoreActions();
  fireEvent.click(screen.getByRole('button', { name: /Eliminar copia/u }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SavedRobots delete intent regressions', () => {
  it.each(['radio', 'actions summary'])(
    'returns focus to the library when the currently focused deleted %s disappears',
    async (focusedControl) => {
      const first = robot('copy-a', 'Robot A', 'Literal A.');
      const second = robot('copy-b', 'Robot B', 'Literal B.');
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
      const editorRef = editor();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

      const firstRadio = (await screen.findByRole('radio', {
        name: /Robot A/u,
      })) as HTMLInputElement;
      fireEvent.click(firstRadio);
      await waitFor(() => expect(firstRadio.checked).toBe(true));
      startDelete();
      await waitFor(() => expect(deleteRobot).toHaveBeenCalledOnce());

      const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
      fireEvent.click(secondRadio);
      await waitFor(() => expect(secondRadio.checked).toBe(true));
      fireEvent.click(firstRadio);
      await waitFor(() => expect(firstRadio.checked).toBe(true));
      const focusTarget =
        focusedControl === 'radio'
          ? firstRadio
          : screen.getByText('Más acciones', { selector: 'summary' });
      focusTarget.focus();

      await act(async () => {
        pendingDelete.resolve({ deleted: true });
        await pendingDelete.promise;
      });

      await waitFor(() => expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull());
      expect(screen.getByRole('radio', { name: /Robot B/u })).toHaveProperty('checked', false);
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Robots guardados' }),
      );
      expect(
        within(screen.getByRole('region', { name: 'Copia seleccionada' })).getByRole('heading', {
          name: 'Elegí una copia',
        }),
      ).toBeTruthy();
      expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
      expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { change: 'leaving and returning to the library', leave: true },
    { change: 'changing the selected copy', leave: false },
  ])('does not publish focus or feedback from a debt check after $change', async ({ leave }) => {
    const first = robot('copy-a', 'Robot A', 'Literal A.');
    const second = robot('copy-b', 'Robot B', 'Literal B.');
    const deferredCheck = deferred<SavedRobot>();
    let firstReads = 0;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation((id) => {
      if (id === first.id) {
        firstReads += 1;
        if (firstReads === 2) {
          return Promise.reject(
            new SavedRobotApiFailure('network', 'No se pudo comprobar todavía.'),
          );
        }
        if (firstReads === 3) return deferredCheck.promise;
        return Promise.resolve(first);
      }
      return Promise.resolve(second);
    });
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const libraryRef = createRef<SavedRobotsHandle>();
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      deleteRobot,
    });
    const editorRef = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const renderLibrary = (active: boolean) => (
      <SavedRobots
        ref={libraryRef}
        api={savedApi}
        editor={editorRef}
        session={session()}
        active={active}
      />
    );
    const view = render(renderLibrary(true));

    fireEvent.click(await screen.findByRole('radio', { name: /Robot A/u }));
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1),
    );
    startDelete();
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(2),
    );
    const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
    fireEvent.click(secondRadio);
    await waitFor(() => expect(secondRadio.checked).toBe(true));
    await screen.findByRole('button', { name: 'Comprobar eliminación' });

    const check = screen.getByRole('button', { name: 'Comprobar eliminación' });
    check.focus();
    fireEvent.click(check);
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(3),
    );

    let focusTarget: HTMLInputElement;
    if (leave) {
      act(() => libraryRef.current?.leaveSurface());
      view.rerender(renderLibrary(false));
      view.rerender(renderLibrary(true));
      await waitFor(() => expect(secondRadio.checked).toBe(true));
      focusTarget = secondRadio;
    } else {
      const firstRadio = screen.getByRole('radio', { name: /Robot A/u }) as HTMLInputElement;
      fireEvent.click(firstRadio);
      await waitFor(() => expect(firstRadio.checked).toBe(true));
      focusTarget = firstRadio;
    }
    focusTarget.focus();

    await act(async () => {
      deferredCheck.reject(new SavedRobotApiFailure('not_found', 'No existe.', 404));
      await deferredCheck.promise.catch(() => undefined);
    });

    await waitFor(() => expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull());
    if (leave) {
      expect(secondRadio.checked).toBe(true);
      expect(document.activeElement).toBe(secondRadio);
    } else {
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Robots guardados' }),
      );
    }
    expect(screen.queryByText(/ya no está disponible y se quitó de la lista/u)).toBeNull();
    expect(deleteRobot).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('does not restore focus after a lock revokes a sent delete', async () => {
    const pendingDelete = deferred<{ deleted: true }>();
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockReturnValue(pendingDelete.promise);
    const savedApi = api({ deleteRobot });
    const editorRef = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const renderLibrary = (locked: boolean) => (
      <SavedRobots api={savedApi} editor={editorRef} session={session()} locked={locked} />
    );
    const view = render(renderLibrary(false));

    fireEvent.click(await screen.findByRole('radio', { name: /Robot A/u }));
    await waitFor(() => expect(savedApi.getRobot).toHaveBeenCalledOnce());
    openMoreActions();
    const deleteButton = screen.getByRole('button', {
      name: /Eliminar copia/u,
    }) as HTMLButtonElement;
    deleteButton.focus();
    fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledOnce());

    view.rerender(renderLibrary(true));
    await waitFor(() => expect(deleteButton.disabled).toBe(true));
    await act(async () => {
      pendingDelete.resolve({ deleted: true });
      await pendingDelete.promise;
    });

    await waitFor(() => expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull());
    expect(document.activeElement).toBe(document.body);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('keeps focus on another copy when a focused debt check removes its button', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal A.');
    const second = robot('copy-b', 'Robot B', 'Literal B.');
    const automaticRead = deferred<SavedRobot>();
    const explicitRead = deferred<SavedRobot>();
    let firstReads = 0;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation((id) => {
      if (id === first.id) {
        firstReads += 1;
        if (firstReads === 2) return automaticRead.promise;
        if (firstReads === 3) return explicitRead.promise;
        return Promise.resolve(first);
      }
      return Promise.resolve(second);
    });
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <SavedRobots
        api={api({
          listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
          getRobot,
          deleteRobot,
        })}
        editor={editor()}
        session={session()}
      />,
    );

    fireEvent.click(await screen.findByRole('radio', { name: /Robot A/u }));
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1),
    );
    startDelete();
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(2),
    );

    const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
    fireEvent.click(secondRadio);
    await waitFor(() => expect(secondRadio.checked).toBe(true));
    await act(async () => {
      automaticRead.reject(new SavedRobotApiFailure('network', 'No se pudo comprobar todavía.'));
      await automaticRead.promise.catch(() => undefined);
    });

    const check = await screen.findByRole('button', { name: 'Comprobar eliminación' });
    check.focus();
    fireEvent.click(check);
    await waitFor(() =>
      expect(getRobot.mock.calls.filter(([id]) => id === first.id)).toHaveLength(3),
    );
    secondRadio.focus();
    await act(async () => {
      explicitRead.reject(new SavedRobotApiFailure('not_found', 'No existe.', 404));
      await explicitRead.promise.catch(() => undefined);
    });

    await waitFor(() => expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull());
    expect(secondRadio.checked).toBe(true);
    expect(document.activeElement).toBe(secondRadio);
    expect(deleteRobot).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('retains delete uncertainty when the sent request rejects with a raw AbortError', async () => {
    const target = robot('copy-a', 'Robot A', 'Literal A.');
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(target);
    const deleteRobot = vi
      .fn<SavedRobotApi['deleteRobot']>()
      .mockRejectedValueOnce(new DOMException('The request was aborted.', 'AbortError'))
      .mockResolvedValueOnce({ deleted: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <SavedRobots api={api({ getRobot, deleteRobot })} editor={editor()} session={session()} />,
    );

    fireEvent.click(await screen.findByRole('radio', { name: /Robot A/u }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledOnce());
    startDelete();

    await screen.findByRole('alert');
    expect(deleteRobot).toHaveBeenCalledOnce();
    expect(getRobot).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toContain('No se pudo confirmar la eliminación.');
    expect(confirm).toHaveBeenCalledOnce();

    startDelete();
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(2));
    expect(deleteRobot.mock.calls.map(([id, version]) => [id, version])).toEqual([
      [target.id, target.version],
      [target.id, target.version],
    ]);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
