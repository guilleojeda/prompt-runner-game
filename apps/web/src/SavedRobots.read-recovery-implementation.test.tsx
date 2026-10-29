// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { SavedRobots, type SavedRobotsHandle } from './SavedRobots.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';
import { installHtmlDialogTestShim } from './configuration-confirmation.test-support.js';

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

function setVisibility(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
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

function session(sub = 'copy-write-user'): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  const email = `${sub}@example.test`;
  return {
    identity: { sub, email },
    user: new User({
      access_token: `copy-write-token-${sub}`,
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
  return { current, ref: { current } as unknown as React.RefObject<RobotEditorHandle | null> };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  });
}

function selectedPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

let restoreDialogShim: (() => void) | undefined;

beforeAll(() => {
  restoreDialogShim = installHtmlDialogTestShim();
});

afterAll(() => restoreDialogShim?.());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalVisibilityState) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, 'visibilityState');
  }
  if (originalHidden) {
    Object.defineProperty(document, 'hidden', originalHidden);
  } else {
    Reflect.deleteProperty(document, 'hidden');
  }
});

describe('SavedRobots read recovery implementation regressions', () => {
  it('keeps the selected copy GET alive when an earlier copy write completes after changing selection', async () => {
    const first = robot('copy-a', 'Robot A', 'Literal original de A.');
    const second = robot('copy-b', 'Robot B', 'Literal vigente de B.');
    const renamed = robot(first.id, 'Robot A renombrado', first.draft.instructions, 2);
    const pendingWrite = deferred<SavedRobot>();
    const pendingSecondRead = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(pendingSecondRead.promise);
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockReturnValue(pendingWrite.promise);
    const api: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(first), summary(second)] }),
      getRobot,
      saveRobot,
      deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    };
    const editorState = editor();
    render(<SavedRobots api={api} editor={editorState.ref} session={session()} />);
    await settle();

    fireEvent.click(screen.getByRole('radio', { name: /Robot A/u }));
    await settle();
    fireEvent.click(within(selectedPanel()).getByText('Más acciones'));
    fireEvent.click(within(selectedPanel()).getByRole('button', { name: 'Renombrar' }));
    const renameDialog = screen.getByRole('dialog', { name: /Renombrar.*Robot A/u });
    fireEvent.change(within(renameDialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: renamed.name },
    });
    fireEvent.click(within(renameDialog).getByRole('button', { name: 'Guardar nombre' }));
    await settle();
    expect(saveRobot).toHaveBeenCalledOnce();

    fireEvent(renameDialog, new Event('cancel', { cancelable: true }));
    fireEvent.click(screen.getByRole('radio', { name: /Robot B/u }));
    await settle();
    expect(getRobot.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);

    await act(async () => {
      pendingWrite.resolve(renamed);
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      pendingSecondRead.resolve(second);
      await Promise.resolve();
    });
    await settle();

    expect(within(selectedPanel()).getByRole('heading', { name: second.name })).toBeTruthy();
    expect(
      within(selectedPanel()).getByText(second.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Robot A renombrado/u })).toBeTruthy();
    expect(getRobot.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
  });

  it('keeps the cause visible after a selected copy is definitively missing', async () => {
    vi.useFakeTimers();
    const copy = robot('copy-missing', 'Robot ausente', 'La copia no existe en el servidor.');
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValue(new SavedRobotApiFailure('not_found', 'La copia ya no existe.', 404));
    const api: SavedRobotApi = {
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
      saveRobot: vi.fn(),
      deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    };
    render(<SavedRobots api={api} editor={editor().ref} session={session()} />);
    await settle();
    fireEvent.click(screen.getByRole('radio', { name: /Robot ausente/u }));
    await settle();

    expect(screen.queryByRole('radio', { name: /Robot ausente/u })).toBeNull();
    expect(screen.getByText(/La copia «Robot ausente» ya no está disponible/u)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(getRobot).toHaveBeenCalledOnce();
  });

  it('does not reopen an aborted initial list read on a focus wake after leaving the library', async () => {
    const pendingList = deferred<{ robots: SavedRobotSummary[] }>();
    const resumedList = deferred<{ robots: SavedRobotSummary[] }>();
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockReturnValueOnce(pendingList.promise)
      .mockReturnValueOnce(resumedList.promise);
    const api: SavedRobotApi = {
      listRobots,
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    };
    const handle = createRef<SavedRobotsHandle>();
    const editorState = editor();
    setVisibility(false);
    const view = render(
      <SavedRobots ref={handle} active api={api} editor={editorState.ref} session={session()} />,
    );
    await settle();
    expect(listRobots).toHaveBeenCalledOnce();
    expect(listRobots.mock.calls[0]?.[0]).toBeUndefined();
    const firstSignal = listRobots.mock.calls[0]?.[1];
    expect(firstSignal).toBeInstanceOf(AbortSignal);

    act(() => {
      handle.current?.leaveSurface();
      view.rerender(
        <SavedRobots
          ref={handle}
          active={false}
          api={api}
          editor={editorState.ref}
          session={session()}
        />,
      );
    });
    await settle();
    expect(firstSignal?.aborted).toBe(true);
    act(() => window.dispatchEvent(new Event('focus')));
    await settle();

    expect(listRobots).toHaveBeenCalledOnce();
    view.rerender(
      <SavedRobots ref={handle} active api={api} editor={editorState.ref} session={session()} />,
    );
    await settle();
    expect(listRobots).toHaveBeenCalledTimes(2);
    expect(listRobots.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, undefined]);
    expect(listRobots.mock.calls[1]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('keeps focus on Cargar más during a 429 retry and hands it to the first added row when pagination ends', async () => {
    vi.useFakeTimers();
    const first = robot('copy-first-page', 'Primera página', 'Literal ya disponible.');
    const next = robot('copy-next-page', 'Página final', 'Literal añadida al final.');
    const retryPage = deferred<{ robots: SavedRobotSummary[] }>();
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockResolvedValueOnce({ robots: [summary(first)], nextCursor: 'cursor-next' })
      .mockRejectedValueOnce(new SavedRobotApiFailure('rate_limited', 'Demasiadas consultas.', 429))
      .mockReturnValueOnce(retryPage.promise);
    const api: SavedRobotApi = {
      listRobots,
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    };
    render(<SavedRobots api={api} editor={editor().ref} session={session()} />);
    await settle();

    const loadMore = screen.getByRole('button', { name: 'Cargar más' }) as HTMLButtonElement;
    loadMore.focus();
    fireEvent.click(loadMore);
    await settle();
    expect(loadMore.disabled).toBe(false);
    expect(loadMore.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(loadMore);
    expect(screen.getByText('Volveremos a consultar tus robots guardados.')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await settle();
    expect(listRobots).toHaveBeenCalledTimes(3);
    expect((screen.getByRole('button', { name: 'Cargando…' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(document.activeElement).toBe(loadMore);

    await act(async () => {
      retryPage.resolve({ robots: [summary(next)] });
      await Promise.resolve();
    });
    await settle();

    const addedRadio = screen.getByRole('radio', { name: /Página final/u }) as HTMLInputElement;
    expect(document.activeElement).toBe(addedRadio);
    expect(addedRadio.checked).toBe(false);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
    expect(listRobots.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      'cursor-next',
      'cursor-next',
    ]);
  });

  it('does not move focus to a new row if the person focused another control during pagination', async () => {
    const first = robot('copy-focus-first', 'Fila existente', 'Primera fila.');
    const next = robot('copy-focus-next', 'Fila agregada', 'Fila de la siguiente página.');
    const pendingPage = deferred<{ robots: SavedRobotSummary[] }>();
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockResolvedValueOnce({ robots: [summary(first)], nextCursor: 'cursor-next' })
      .mockReturnValueOnce(pendingPage.promise);
    const api: SavedRobotApi = {
      listRobots,
      getRobot: vi.fn(),
      saveRobot: vi.fn(),
      deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    };
    render(<SavedRobots api={api} editor={editor().ref} session={session()} />);
    await settle();

    const loadMore = screen.getByRole('button', { name: 'Cargar más' });
    loadMore.focus();
    fireEvent.click(loadMore);
    await settle();
    const otherControl = screen.getByRole('radio', { name: /Fila existente/u }) as HTMLInputElement;
    otherControl.focus();
    await act(async () => {
      pendingPage.resolve({ robots: [summary(next)] });
      await Promise.resolve();
    });
    await settle();

    expect(screen.getByRole('radio', { name: /Fila agregada/u })).toBeTruthy();
    expect(document.activeElement).toBe(otherControl);
    expect(otherControl.checked).toBe(false);
  });

  it.each(['surface', 'identity'] as const)(
    'does not restore pagination focus after a pending page is abandoned by %s change',
    async (change) => {
      const first = robot('copy-abandon-first', 'Fila actual', 'Fila actual.');
      const oldNext = robot('copy-abandon-next', 'Fila de identidad anterior', 'No reinsertar.');
      const newIdentityCopy = robot(
        'copy-new-identity',
        'Fila de identidad nueva',
        'Nueva cuenta.',
      );
      const pendingPage = deferred<{ robots: SavedRobotSummary[] }>();
      const listRobots = vi
        .fn<SavedRobotApi['listRobots']>()
        .mockResolvedValueOnce({ robots: [summary(first)], nextCursor: 'cursor-next' })
        .mockReturnValueOnce(pendingPage.promise)
        .mockResolvedValueOnce({ robots: [summary(newIdentityCopy)] });
      const api: SavedRobotApi = {
        listRobots,
        getRobot: vi.fn(),
        saveRobot: vi.fn(),
        deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
      };
      const handle = createRef<SavedRobotsHandle>();
      const editorState = editor();
      const renderSurface = (active: boolean, sub: string) => (
        <>
          <button type="button">Preparar</button>
          <SavedRobots
            key={sub}
            ref={handle}
            active={active}
            api={api}
            editor={editorState.ref}
            session={session(sub)}
          />
        </>
      );
      const view = render(renderSurface(true, 'identity-a'));
      await settle();
      const loadMore = screen.getByRole('button', { name: 'Cargar más' });
      loadMore.focus();
      fireEvent.click(loadMore);
      await settle();
      const outsideControl = screen.getByRole('button', { name: 'Preparar' });
      outsideControl.focus();

      if (change === 'surface') {
        act(() => {
          handle.current?.leaveSurface();
          view.rerender(renderSurface(false, 'identity-a'));
        });
      } else {
        act(() => view.rerender(renderSurface(true, 'identity-b')));
        await settle();
        expect(screen.getByRole('radio', { name: /Fila de identidad nueva/u })).toBeTruthy();
      }
      await act(async () => {
        pendingPage.resolve({ robots: [summary(oldNext)] });
        await Promise.resolve();
      });
      await settle();

      expect(document.activeElement).toBe(outsideControl);
      expect(screen.queryByRole('radio', { name: /Fila de identidad anterior/u })).toBeNull();
      expect(listRobots.mock.calls.map(([cursor]) => cursor)).toEqual(
        change === 'surface' ? [undefined, 'cursor-next'] : [undefined, 'cursor-next', undefined],
      );
    },
  );
});
