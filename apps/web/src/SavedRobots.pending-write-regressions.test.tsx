// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { SavedRobots } from './SavedRobots.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';
import { installHtmlDialogTestShim } from './configuration-confirmation.test-support.js';

let restoreDialogShim: (() => void) | undefined;

beforeAll(() => {
  restoreDialogShim = installHtmlDialogTestShim();
});

afterAll(() => restoreDialogShim?.());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function session(): AuthSession {
  return {
    identity: { sub: 'pending-write-user', email: 'pending-write@example.test' },
    user: new User({
      access_token: 'pending-write-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client-public',
        iat: 1,
        exp: 9_999_999_999,
        sub: 'pending-write-user',
        email: 'pending-write@example.test',
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeEditor(
  captureSnapshot: RobotEditorHandle['captureSnapshot'] = vi
    .fn()
    .mockResolvedValue({ version: 4, draft: createDefaultDraft() }),
) {
  return {
    current: {
      captureSnapshot,
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

function makeApi(overrides: Partial<SavedRobotApi> = {}): SavedRobotApi {
  const initial = robot('copy-a', 'Robot A', 'Contenido A.');
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [summary(initial)], nextCursor: undefined }),
    getRobot: vi.fn().mockResolvedValue(initial),
    saveRobot: vi
      .fn()
      .mockImplementation(async (id, version, name, draft) =>
        robot(id, name, draft.instructions, version + 1),
      ),
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides,
  };
}

function selectedPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

async function chooseCopy(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('radio', { name: new RegExp(name, 'u') }));
  await waitFor(() => expect(selectedPanel().getAttribute('aria-busy')).toBe('false'));
}

function openMoreActions(): void {
  const summaryElement = screen.getByText('Más acciones');
  if (!(summaryElement.closest('details') as HTMLDetailsElement).open) {
    fireEvent.click(summaryElement);
  }
}

function renameButton(): HTMLElement {
  return within(selectedPanel()).getByRole('button', { name: 'Renombrar' });
}

describe('SavedRobots pending-write regressions', () => {
  it('reconciles a canceled rename before allowing a new copy mutation', async () => {
    const first = robot('copy-a', 'Robot A', 'Contenido A.');
    const second = robot('copy-b', 'Robot B', 'Contenido B.');
    let firstReadCount = 0;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation(async (id) => {
      if (id === first.id) {
        firstReadCount += 1;
        if (firstReadCount === 2) {
          throw new SavedRobotApiFailure(
            'network',
            'No se pudo conciliar todavía.',
            undefined,
            undefined,
            false,
          );
        }
        return first;
      }
      return second;
    });
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'Respuesta incierta.', undefined, undefined, true),
      )
      .mockImplementationOnce(async (id, version, name, draft) =>
        robot(id, name, draft.instructions, version + 1),
      );
    const savedApi = makeApi({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      saveRobot,
    });
    const editor = makeEditor();
    render(<SavedRobots api={savedApi} editor={editor} session={session()} />);

    await chooseCopy(first.name);
    openMoreActions();
    fireEvent.click(renameButton());
    const firstDialog = await screen.findByRole('dialog', { name: /Renombrar.*Robot A/u });
    fireEvent.change(within(firstDialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Nombre inicial' },
    });
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot).toHaveBeenCalledOnce();

    fireEvent(firstDialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await chooseCopy(second.name);
    openMoreActions();
    expect(renameButton().hasAttribute('disabled')).toBe(true);
    expect(
      within(selectedPanel())
        .getByRole('button', { name: /Reemplazar con mi robot actual/u })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      within(selectedPanel())
        .getByRole('button', { name: /Eliminar copia/u })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(saveRobot).toHaveBeenCalledOnce();

    await chooseCopy(first.name);
    openMoreActions();
    fireEvent.click(renameButton());
    const reconcileDialog = await screen.findByRole('dialog', { name: /Renombrar.*Robot A/u });
    expect(
      within(reconcileDialog).getByRole('button', { name: 'Comprobar cambio pendiente' }),
    ).toBeTruthy();
    fireEvent.click(
      within(reconcileDialog).getByRole('button', { name: 'Comprobar cambio pendiente' }),
    );
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(5));
    expect(saveRobot).toHaveBeenCalledOnce();

    openMoreActions();
    fireEvent.click(renameButton());
    const freshIntentDialog = await screen.findByRole('dialog', { name: /Renombrar.*Robot A/u });
    fireEvent.change(within(freshIntentDialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Nombre nuevo' },
    });
    fireEvent.click(within(freshIntentDialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      [first.id, first.version, 'Nombre inicial', first.draft],
      [first.id, first.version, 'Nombre nuevo', first.draft],
    ]);
    expect(editor.current?.captureSnapshot).not.toHaveBeenCalled();
  });

  it('keeps a newer confirmed write over an older selected-copy read', async () => {
    const first = robot('copy-a', 'Robot A', 'Contenido original.');
    const second = robot('copy-b', 'Robot B', 'Contenido B.');
    const staleRead = deferred<SavedRobot>();
    const committed = robot(first.id, 'Robot A renombrado', first.draft.instructions, 2);
    let firstReadCount = 0;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation(async (id) => {
      if (id === second.id) return second;
      firstReadCount += 1;
      return firstReadCount === 1 ? first : staleRead.promise;
    });
    const pendingWrite = deferred<SavedRobot>();
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockReturnValueOnce(pendingWrite.promise)
      .mockImplementationOnce(async (id, version, name, draft) =>
        robot(id, name, draft.instructions, version + 1),
      );
    const savedApi = makeApi({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      saveRobot,
    });
    render(<SavedRobots api={savedApi} editor={makeEditor()} session={session()} />);

    await chooseCopy(first.name);
    openMoreActions();
    fireEvent.click(renameButton());
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Robot A/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Robot A renombrado' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());

    await chooseCopy(second.name);
    fireEvent.click(await screen.findByRole('radio', { name: /Robot A guardado/u }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(3));
    await act(async () => {
      pendingWrite.resolve(committed);
      await pendingWrite.promise;
    });
    await waitFor(() =>
      expect(within(selectedPanel()).getByRole('heading', { name: committed.name })).toBeTruthy(),
    );

    await act(async () => {
      staleRead.resolve(first);
      await Promise.resolve();
    });
    expect(within(selectedPanel()).getByRole('heading', { name: committed.name })).toBeTruthy();
    expect(saveRobot).toHaveBeenCalledOnce();

    openMoreActions();
    fireEvent.click(renameButton());
    const nextRename = await screen.findByRole('dialog', {
      name: /Renombrar.*Robot A renombrado/u,
    });
    fireEvent.change(within(nextRename).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Robot A versión nueva' },
    });
    fireEvent.click(within(nextRename).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot.mock.calls[1]?.slice(0, 3)).toEqual([
      first.id,
      committed.version,
      'Robot A versión nueva',
    ]);
  });

  it('does not write a replacement snapshot captured after the library is paused', async () => {
    const target = robot('copy-a', 'Robot A', 'Contenido guardado.');
    const snapshot = deferred<{ version: number; draft: RobotDraft } | null>();
    const editor = makeEditor(vi.fn().mockReturnValue(snapshot.promise));
    const savedApi = makeApi({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(target)] }),
      getRobot: vi.fn().mockResolvedValue(target),
    });
    const view = render(<SavedRobots api={savedApi} editor={editor} session={session()} />);

    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(
      within(selectedPanel()).getByRole('button', { name: /Reemplazar con mi robot actual/u }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Reemplazar.*Robot A/u });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reemplazar copia' }));
    await waitFor(() => expect(editor.current?.captureSnapshot).toHaveBeenCalledOnce());

    view.rerender(
      <SavedRobots
        api={savedApi}
        editor={editor}
        session={session()}
        paused
        accessState="required"
      />,
    );
    await act(async () => {
      snapshot.resolve({
        version: 4,
        draft: { ...createDefaultDraft(), instructions: 'No enviar.' },
      });
      await snapshot.promise;
    });

    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(editor.current?.applyDraft).not.toHaveBeenCalled();
    expect(savedApi.getRobot).toHaveBeenCalledOnce();
  });

  it('defers ambiguous-write reconciliation while paused and preserves it for the same copy', async () => {
    const target = robot('copy-a', 'Robot A', 'Contenido guardado.');
    const pendingWrite = deferred<SavedRobot>();
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(target);
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockReturnValue(pendingWrite.promise);
    const savedApi = makeApi({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(target)] }),
      getRobot,
      saveRobot,
    });
    const editor = makeEditor();
    const view = render(<SavedRobots api={savedApi} editor={editor} session={session()} />);

    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(renameButton());
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Robot A/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Nombre incierto' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());

    view.rerender(
      <SavedRobots
        api={savedApi}
        editor={editor}
        session={session()}
        paused
        accessState="required"
      />,
    );
    await act(async () => {
      pendingWrite.reject(
        new SavedRobotApiFailure('network', 'Respuesta incierta.', undefined, undefined, true),
      );
      await Promise.resolve();
    });

    expect(getRobot).toHaveBeenCalledOnce();
    expect(saveRobot).toHaveBeenCalledOnce();

    view.rerender(<SavedRobots api={savedApi} editor={editor} session={session()} />);
    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(renameButton());
    const reconcileDialog = await screen.findByRole('dialog', {
      name: /Renombrar.*Robot A/u,
    });
    fireEvent.click(
      within(reconcileDialog).getByRole('button', { name: 'Comprobar cambio pendiente' }),
    );
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(3));
    expect(getRobot.mock.calls.map(([id]) => id)).toEqual([target.id, target.id, target.id]);
    expect(saveRobot).toHaveBeenCalledOnce();
  });
});
