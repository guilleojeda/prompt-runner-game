// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import type { ApiAuthRequired } from './api-auth.js';
import type { AuthSession } from './auth.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { SavedRobots } from './SavedRobots.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';
import { installHtmlDialogTestShim } from './configuration-confirmation.test-support.js';

const MINUTE = 60_000;
const TEST_NOW = new Date('2026-10-29T12:00:00.000Z');
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

function session(sub = 'read-recovery-user'): AuthSession {
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

function api(overrides: Partial<SavedRobotApi> = {}): SavedRobotApi {
  const copy = robot('copy-a', 'Robot A', 'Literal guardado A.');
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
    getRobot: vi.fn().mockResolvedValue(copy),
    saveRobot: vi
      .fn()
      .mockImplementation(async (id: string, version: number, name: string, draft: RobotDraft) =>
        robot(id, name, draft.instructions, version + 1),
      ),
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides,
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

function setVisibility(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
}

function selectedPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

function selectCopy(name: string): void {
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(name, 'u') }));
}

function openMoreActions(): void {
  const summary = screen.getByText('Más acciones', { selector: 'summary' });
  if (!(summary.closest('details') as HTMLDetailsElement).open) fireEvent.click(summary);
}

function expectQuietRecovery(): void {
  expect.soft(screen.queryByRole('alert')).toBeNull();
  expect.soft(screen.queryByRole('button', { name: /Reintentar/i })).toBeNull();
  expect.soft(screen.queryByRole('status')).not.toBeNull();
}

let restoreDialogShim: (() => void) | undefined;

beforeAll(() => {
  restoreDialogShim = installHtmlDialogTestShim();
});

afterAll(() => restoreDialogShim?.());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
  setVisibility(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

describe('SavedRobots read recovery acceptance', () => {
  it('retries an active first-page read every minute without a retry limit, then stops after success', async () => {
    const copy = robot('copy-list', 'Robot de la lista', 'La lista queda disponible.');
    const listRobots = vi.fn<SavedRobotApi['listRobots']>();
    for (let retry = 0; retry < 61; retry += 1) {
      const failure =
        retry % 3 === 0
          ? new SavedRobotApiFailure('network', 'Temporal.')
          : retry % 3 === 1
            ? new SavedRobotApiFailure('server', 'Temporal.', 503)
            : new SavedRobotApiFailure('rate_limited', 'Temporal.', 429);
      listRobots.mockRejectedValueOnce(failure);
    }
    listRobots.mockResolvedValueOnce({ robots: [summary(copy)] });
    const savedApi = api({ listRobots });

    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();

    expect(listRobots).toHaveBeenCalledOnce();
    expectQuietRecovery();
    expect.soft(screen.queryByText('Todavía no guardaste ninguna copia.')).toBeNull();
    await advance(62 * MINUTE);

    expect.soft(listRobots).toHaveBeenCalledTimes(62);
    expect.soft(listRobots.mock.calls.map(([cursor]) => cursor)).toEqual(Array(62).fill(undefined));
    expect.soft(screen.queryByRole('alert')).toBeNull();
    expect.soft(screen.queryByRole('button', { name: /Reintentar/i })).toBeNull();
    expect.soft(screen.queryByRole('radio', { name: /Robot de la lista/u })).toBeTruthy();

    await advance(3 * MINUTE);
    expect.soft(listRobots).toHaveBeenCalledTimes(62);
  });

  it('retries the failed cursor without replacing the loaded page or selected copy', async () => {
    const first = robot('copy-first', 'Primera copia', 'Literal de la primera página.  ');
    const next = robot('copy-next', 'Siguiente copia', 'Literal de la página siguiente.');
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockResolvedValueOnce({ robots: [summary(first)], nextCursor: 'cursor-next' })
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'Página temporalmente inaccesible.'),
      )
      .mockResolvedValueOnce({ robots: [summary(next)] });
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(first);
    const savedApi = api({ listRobots, getRobot });

    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();
    selectCopy(first.name);
    await settle();
    expect(
      within(selectedPanel()).getByText(first.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await settle();
    expect.soft(listRobots).toHaveBeenCalledTimes(2);
    expectQuietRecovery();
    expect.soft(screen.queryByRole('radio', { name: /Primera copia/u })).not.toBeNull();
    expect(
      within(selectedPanel()).getByText(first.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();
    await advance(MINUTE - 1);
    expect.soft(listRobots).toHaveBeenCalledTimes(2);
    await advance(1);

    expect.soft(listRobots).toHaveBeenCalledTimes(3);
    expect
      .soft(listRobots.mock.calls.map(([cursor]) => cursor))
      .toEqual([undefined, 'cursor-next', 'cursor-next']);
    expect.soft(screen.queryByRole('radio', { name: /Primera copia/u })).not.toBeNull();
    expect.soft(screen.queryByRole('radio', { name: /Siguiente copia/u })).not.toBeNull();
    expect(
      within(selectedPanel()).getByText(first.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();
    expect.soft(getRobot).toHaveBeenCalledOnce();

    await advance(2 * MINUTE);
    expect.soft(listRobots).toHaveBeenCalledTimes(3);
    expect.soft(getRobot).toHaveBeenCalledOnce();
  });

  it('retries a failed selected-copy GET by ID without applying or writing the copy', async () => {
    const copy = robot(
      'copy-selected',
      'Copia elegida',
      'Contenido recuperado sin modificar el editor.',
    );
    const firstRead = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(copy);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
    });
    const editorState = editor();
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);
    await settle();
    selectCopy(copy.name);
    await settle();

    expect(getRobot).toHaveBeenCalledOnce();
    expect(getRobot.mock.calls[0]?.[0]).toBe(copy.id);
    await advance(15_000);
    await act(async () => {
      firstRead.reject(new SavedRobotApiFailure('server', 'Ficha temporalmente inaccesible.', 503));
      await Promise.resolve();
    });
    await settle();
    expectQuietRecovery();
    expect(within(selectedPanel()).getByRole('heading', { name: copy.name })).toBeTruthy();
    await advance(MINUTE - 1);
    expect(getRobot).toHaveBeenCalledOnce();
    await advance(1);

    expect.soft(getRobot).toHaveBeenCalledTimes(2);
    expect.soft(getRobot.mock.calls.map(([id]) => id)).toEqual([copy.id, copy.id]);
    expect
      .soft(
        within(selectedPanel()).queryByText(copy.draft.instructions, {
          normalizer: (text) => text,
        }),
      )
      .not.toBeNull();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
    expect(editorState.current.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();

    await advance(2 * MINUTE);
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
  });

  it('keeps an ambiguous-write readback outside the consult retry timer', async () => {
    const copy = robot('copy-ambiguous', 'Copia incierta', 'El contenido guardado no cambia.');
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockResolvedValueOnce(copy)
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'Lectura de conciliación fallida.'),
      )
      .mockResolvedValueOnce(copy);
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure(
          'network',
          'Respuesta de guardado incierta.',
          undefined,
          undefined,
          true,
        ),
      );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
      saveRobot,
    });
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();
    selectCopy(copy.name);
    await settle();
    openMoreActions();
    fireEvent.click(within(selectedPanel()).getByRole('button', { name: 'Renombrar' }));
    const dialog = screen.getByRole('dialog', { name: /Renombrar.*Copia incierta/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Nombre aún incierto' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await settle();

    expect(getRobot.mock.calls.map(([id]) => id)).toEqual([copy.id, copy.id]);
    expect(saveRobot).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await settle();
    await advance(3 * MINUTE);
    expect(getRobot).toHaveBeenCalledTimes(2);
    expect(saveRobot).toHaveBeenCalledOnce();

    openMoreActions();
    fireEvent.click(within(selectedPanel()).getByRole('button', { name: 'Renombrar' }));
    const reconcileDialog = screen.getByRole('dialog', {
      name: /Renombrar.*Copia incierta/u,
    });
    fireEvent.click(
      within(reconcileDialog).getByRole('button', { name: 'Comprobar cambio pendiente' }),
    );
    await settle();
    expect(getRobot.mock.calls.map(([id]) => id)).toEqual([copy.id, copy.id, copy.id]);
    expect(saveRobot).toHaveBeenCalledOnce();
  });

  it('does not overlap a slow recovery GET when that request crosses later minute marks', async () => {
    const copy = robot('copy-slow', 'Copia lenta', 'Lectura lenta confirmada.');
    const secondRead = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Consulta temporal.'))
      .mockReturnValueOnce(secondRead.promise);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
    });
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();
    selectCopy(copy.name);
    await settle();
    expect(getRobot).toHaveBeenCalledOnce();

    await advance(MINUTE);
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
    await advance(3 * MINUTE);
    expect.soft(getRobot).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRead.resolve(copy);
      await Promise.resolve();
    });
    await settle();
    expect
      .soft(
        within(selectedPanel()).queryByText(copy.draft.instructions, {
          normalizer: (text) => text,
        }),
      )
      .not.toBeNull();
    await advance(2 * MINUTE);
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'current authentication rejection',
      new SavedRobotApiFailure('authentication', 'Volvé a ingresar.', 401, undefined, false, {
        authContext: 21,
      }),
      false,
      true,
    ],
    [
      'invalid 2xx response',
      new SavedRobotApiFailure('server', 'La respuesta no es compatible.', 200),
      false,
      false,
    ],
    [
      'incompatible 500 response',
      new SavedRobotApiFailure('incompatible', 'La copia no es compatible.', 500),
      false,
      false,
    ],
    [
      'conditional conflict',
      new SavedRobotApiFailure('conflict', 'La lectura tiene un conflicto definitivo.', 409),
      false,
      false,
    ],
    [
      'configured limit',
      new SavedRobotApiFailure('limit', 'La consulta superó un límite definitivo.', 413),
      false,
      false,
    ],
    [
      'missing copy 404',
      new SavedRobotApiFailure('not_found', 'La copia ya no existe.', 404),
      true,
      false,
    ],
  ])('does not retry a definitive %s', async (_name, failure, missing, authentication) => {
    const copy = robot(
      'copy-terminal',
      'Copia terminal',
      'No se vuelve a consultar automáticamente.',
    );
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockRejectedValue(failure);
    const onAuthRequired = vi.fn<ApiAuthRequired>().mockReturnValue(true);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
    });
    render(
      <SavedRobots
        api={savedApi}
        editor={editor().ref}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );
    await settle();
    selectCopy(copy.name);
    await settle();

    expect(getRobot).toHaveBeenCalledOnce();
    await advance(3 * MINUTE);
    expect(getRobot).toHaveBeenCalledOnce();
    if (missing) {
      expect(screen.queryByRole('radio', { name: /Copia terminal/u })).toBeNull();
    } else {
      expect(screen.getByRole('radio', { name: /Copia terminal/u })).toBeTruthy();
    }
    if (authentication) expect(onAuthRequired).toHaveBeenCalledExactlyOnceWith(21);
    else expect(onAuthRequired).not.toHaveBeenCalled();
  });

  it('treats a rejected stale auth context as a recoverable read for the current identity', async () => {
    const copy = robot('copy-auth-stale', 'Copia actual', 'Se recupera con el acceso vigente.');
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure(
          'authentication',
          'Token anterior rechazado.',
          401,
          undefined,
          false,
          {
            authContext: 12,
          },
        ),
      )
      .mockResolvedValueOnce(copy);
    const onAuthRequired = vi.fn<ApiAuthRequired>().mockReturnValue(false);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
    });
    render(
      <SavedRobots
        api={savedApi}
        editor={editor().ref}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );
    await settle();
    selectCopy(copy.name);
    await settle();

    expect(onAuthRequired).toHaveBeenCalledExactlyOnceWith(12);
    expect(screen.queryByText(/Volvé a ingresar/u)).toBeNull();
    expectQuietRecovery();
    await advance(MINUTE - 1);
    expect(getRobot).toHaveBeenCalledOnce();
    await advance(1);

    expect.soft(getRobot).toHaveBeenCalledTimes(2);
    expect
      .soft(
        within(selectedPanel()).queryByText(copy.draft.instructions, {
          normalizer: (text) => text,
        }),
      )
      .not.toBeNull();
  });

  it('preserves a selected-copy deadline through same-identity access pause and resumes once', async () => {
    const copy = robot('copy-access', 'Copia reanudada', 'La sesión conserva esta consulta.');
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Consulta pendiente.'))
      .mockResolvedValueOnce(copy);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
    });
    const activeSession = session();
    const editorState = editor();
    const view = render(
      <SavedRobots api={savedApi} editor={editorState.ref} session={activeSession} />,
    );
    await settle();
    selectCopy(copy.name);
    await settle();
    expect(getRobot).toHaveBeenCalledOnce();
    await advance(MINUTE / 2);

    view.rerender(
      <SavedRobots
        api={savedApi}
        editor={editorState.ref}
        session={activeSession}
        paused
        accessState="required"
      />,
    );
    await settle();
    await advance(2 * MINUTE);
    expect(getRobot).toHaveBeenCalledOnce();
    expect.soft(screen.queryByRole('radio', { name: /Copia reanudada/u })).not.toBeNull();

    view.rerender(
      <SavedRobots
        api={savedApi}
        editor={editorState.ref}
        session={activeSession}
        accessState="ready"
      />,
    );
    await settle();
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
    expect
      .soft(
        within(selectedPanel()).queryByText(copy.draft.instructions, {
          normalizer: (text) => text,
        }),
      )
      .not.toBeNull();
    await advance(2 * MINUTE);
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
  });

  it('keeps the copy retry deadline while hidden and wakes once after it is due', async () => {
    const copy = robot('copy-hidden', 'Copia oculta', 'La consulta se reanuda una vez.');
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Consulta temporal.'))
      .mockResolvedValueOnce(copy);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
    });
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();
    selectCopy(copy.name);
    await settle();
    await advance(MINUTE / 2);

    setVisibility(true);
    fireEvent(document, new Event('visibilitychange'));
    await settle();
    await advance(2 * MINUTE);
    expect(getRobot).toHaveBeenCalledOnce();

    setVisibility(false);
    fireEvent(document, new Event('visibilitychange'));
    await settle();
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
    expect
      .soft(
        within(selectedPanel()).queryByText(copy.draft.instructions, {
          normalizer: (text) => text,
        }),
      )
      .not.toBeNull();
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(document, new Event('visibilitychange'));
    await settle();
    await advance(2 * MINUTE);
    expect.soft(getRobot).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight copy GET while hidden, ignores its late response, and reopens only once', async () => {
    const copy = robot('copy-hidden-pending', 'Copia protegida', 'Respuesta vigente al volver.');
    const stale = robot(copy.id, copy.name, 'Respuesta tardía mientras estaba oculta.', 2);
    const pending = deferred<SavedRobot>();
    let activeRequests = 0;
    let maxConcurrentRequests = 0;
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockImplementationOnce(async () => {
        activeRequests += 1;
        maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
        try {
          return await pending.promise;
        } finally {
          activeRequests -= 1;
        }
      })
      .mockImplementationOnce(async () => {
        activeRequests += 1;
        maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
        try {
          return copy;
        } finally {
          activeRequests -= 1;
        }
      });
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
    });
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();
    selectCopy(copy.name);
    await settle();
    const oldSignal = getRobot.mock.calls[0]?.[1];
    expect(getRobot).toHaveBeenCalledOnce();

    setVisibility(true);
    fireEvent(document, new Event('visibilitychange'));
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(stale);
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByText(stale.draft.instructions, { normalizer: (text) => text })).toBeNull();

    setVisibility(false);
    fireEvent(document, new Event('visibilitychange'));
    await settle();
    expect(getRobot).toHaveBeenCalledTimes(2);
    expect(getRobot.mock.calls.map(([id]) => id)).toEqual([copy.id, copy.id]);
    expect(
      within(selectedPanel()).getByText(copy.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();
    expect(activeRequests).toBe(0);
    expect(maxConcurrentRequests).toBe(1);
  });

  it('cancels a copy retry when selection changes and treats returning to it as a new query', async () => {
    const first = robot('copy-first', 'Primera selección', 'No repetir esta consulta al fondo.');
    const second = robot('copy-second', 'Segunda selección', 'Consulta activa B.');
    const refreshedFirst = robot(first.id, first.name, 'A consultada de nuevo.', 2);
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'A temporal.'))
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(refreshedFirst);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({
        robots: [summary(first), summary(second)],
      }),
      getRobot,
    });
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();
    selectCopy(first.name);
    await settle();
    await advance(MINUTE / 2);
    selectCopy(second.name);
    await settle();
    expect(
      within(selectedPanel()).getByText(second.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();

    await advance(MINUTE);
    expect(getRobot.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
    expect(
      within(selectedPanel()).getByText(second.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();

    selectCopy(first.name);
    await settle();
    expect(getRobot.mock.calls.map(([id]) => id)).toEqual([first.id, second.id, first.id]);
    expect(
      within(selectedPanel()).getByText(refreshedFirst.draft.instructions, {
        normalizer: (text) => text,
      }),
    ).toBeTruthy();
  });

  it('aborts old-identity reads and never applies a late copy to the new identity', async () => {
    const first = robot('copy-a', 'Robot A', 'Privado de la identidad A.');
    const other = robot('copy-b', 'Robot B', 'Privado de la identidad B.');
    const lateRead = deferred<SavedRobot>();
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockResolvedValueOnce({ robots: [summary(first)] })
      .mockResolvedValueOnce({ robots: [summary(other)] });
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockReturnValue(lateRead.promise);
    const savedApi = api({ listRobots, getRobot });
    const editorState = editor();
    const view = render(
      <SavedRobots api={savedApi} editor={editorState.ref} session={session('identity-a')} />,
    );
    await settle();
    selectCopy(first.name);
    await settle();
    const oldSignal = getRobot.mock.calls[0]?.[1];

    view.rerender(
      <SavedRobots api={savedApi} editor={editorState.ref} session={session('identity-b')} />,
    );
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.getByRole('radio', { name: /Robot B/u })).toBeTruthy();
    await act(async () => {
      lateRead.resolve(first);
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByRole('radio', { name: /Robot A/u })).toBeNull();
    expect(screen.queryByText(first.draft.instructions, { normalizer: (text) => text })).toBeNull();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();

    await advance(MINUTE);
    expect(getRobot).toHaveBeenCalledOnce();
    expect(listRobots).toHaveBeenCalledTimes(2);
  });

  it('cancels a scheduled list retry on unmount', async () => {
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockRejectedValue(new SavedRobotApiFailure('network', 'Sin conexión.'));
    const view = render(
      <SavedRobots api={api({ listRobots })} editor={editor().ref} session={session()} />,
    );
    await settle();
    expect(listRobots).toHaveBeenCalledOnce();
    await advance(MINUTE / 2);
    view.unmount();
    await advance(3 * MINUTE);
    expect(listRobots).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight selected-copy GET on unmount and ignores its late result', async () => {
    const copy = robot('copy-unmount', 'Copia desmontada', 'No se publica después del cierre.');
    const pending = deferred<SavedRobot>();
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockReturnValue(pending.promise);
    const editorState = editor();
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(copy)] }),
      getRobot,
    });
    const view = render(
      <SavedRobots api={savedApi} editor={editorState.ref} session={session()} />,
    );
    await settle();
    selectCopy(copy.name);
    await settle();
    const signal = getRobot.mock.calls[0]?.[1];
    expect(getRobot).toHaveBeenCalledOnce();

    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(copy);
      await Promise.resolve();
    });
    await settle();
    expect(getRobot).toHaveBeenCalledOnce();
    expect(editorState.current.applyDraft).not.toHaveBeenCalled();
    expect(editorState.current.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
  });

  it('does not reopen or reset a failed-read deadline when API and auth callback props rerender', async () => {
    const copy = robot('copy-rerender', 'Lectura estable', 'La fecha límite se conserva.');
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Lista temporal.'))
      .mockResolvedValueOnce({ robots: [summary(copy)] });
    const baseApi = api({ listRobots });
    const editorState = editor();
    const activeSession = session();
    const view = render(
      <SavedRobots
        api={baseApi}
        editor={editorState.ref}
        session={activeSession}
        onAuthRequired={() => false}
      />,
    );
    await settle();
    await advance(MINUTE / 2);

    const refreshedApi = { ...baseApi };
    view.rerender(
      <SavedRobots
        api={refreshedApi}
        editor={editorState.ref}
        session={activeSession}
        onAuthRequired={() => false}
      />,
    );
    await settle();
    expect.soft(listRobots).toHaveBeenCalledOnce();
    await advance(MINUTE / 2 - 1);
    expect.soft(listRobots).toHaveBeenCalledOnce();
    await advance(1);

    expect.soft(listRobots).toHaveBeenCalledTimes(2);
    expect.soft(screen.queryByRole('radio', { name: /Lectura estable/u })).not.toBeNull();
  });

  it('rejects a selected-copy response with another ID without enabling Use or polling it', async () => {
    const requested = robot('copy-requested', 'Copia solicitada', 'Contenido de A.');
    const wrong = robot('copy-wrong', 'Otra copia', 'Contenido de B ajeno.');
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValue(wrong);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(requested)] }),
      getRobot,
    });
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();
    selectCopy(requested.name);
    await settle();

    expect(getRobot.mock.calls[0]?.[0]).toBe(requested.id);
    expect
      .soft(screen.queryByText(wrong.draft.instructions, { normalizer: (text) => text }))
      .toBeNull();
    const useButton = within(selectedPanel()).getByRole('button', { name: 'Usar este robot' });
    expect((useButton as HTMLButtonElement).disabled).toBe(true);
    await advance(3 * MINUTE);
    expect(getRobot).toHaveBeenCalledOnce();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
  });

  it('does not automatically retry a malformed successful first-page response', async () => {
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockRejectedValue(new SavedRobotApiFailure('server', 'La respuesta no es compatible.', 200));
    render(<SavedRobots api={api({ listRobots })} editor={editor().ref} session={session()} />);
    await settle();
    expect(listRobots).toHaveBeenCalledOnce();
    await advance(3 * MINUTE);
    expect(listRobots).toHaveBeenCalledOnce();
  });

  it('does not lower a renamed version when a retried page contains its older summary', async () => {
    const original = robot('copy-versioned', 'Robot anterior', 'Contenido de la copia.');
    const renamed = robot(original.id, 'Robot actualizado', original.draft.instructions, 2);
    const remote = robot(original.id, 'Nombre remoto', 'Contenido remoto v3.', 3);
    const afterConflict = robot(original.id, 'Nombre confirmado v4', remote.draft.instructions, 4);
    const other = robot('copy-next', 'Otra página', 'Contenido siguiente.');
    const listRobots = vi
      .fn<SavedRobotApi['listRobots']>()
      .mockResolvedValueOnce({ robots: [summary(original)], nextCursor: 'cursor-stale' })
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Página temporal.'))
      .mockResolvedValueOnce({ robots: [summary(original), summary(other)] });
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockResolvedValueOnce(renamed)
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('conflict', 'La copia cambió en otra pestaña.', 409, remote),
      )
      .mockResolvedValueOnce(afterConflict);
    const savedApi = api({ listRobots, getRobot: vi.fn().mockResolvedValue(original), saveRobot });
    render(<SavedRobots api={savedApi} editor={editor().ref} session={session()} />);
    await settle();
    selectCopy(original.name);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await settle();

    fireEvent.click(within(selectedPanel()).getByRole('button', { name: 'Renombrar' }));
    const dialog = screen.getByRole('dialog', { name: /Renombrar.*Robot anterior/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: renamed.name },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await settle();
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(within(selectedPanel()).getByRole('heading', { name: renamed.name })).toBeTruthy();

    openMoreActions();
    fireEvent.click(within(selectedPanel()).getByRole('button', { name: 'Renombrar' }));
    const conflictDialog = screen.getByRole('dialog', {
      name: /Renombrar.*Robot actualizado/u,
    });
    fireEvent.change(within(conflictDialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Nombre local en conflicto' },
    });
    fireEvent.click(within(conflictDialog).getByRole('button', { name: 'Guardar nombre' }));
    await settle();
    expect(saveRobot).toHaveBeenCalledTimes(2);
    expect(within(selectedPanel()).getByRole('alert').textContent).toContain(
      'La copia cambió en otra pestaña.',
    );
    expect(within(selectedPanel()).getByRole('heading', { name: remote.name })).toBeTruthy();

    await advance(MINUTE);
    expect.soft(listRobots).toHaveBeenCalledTimes(3);
    expect.soft(screen.queryByRole('radio', { name: /Nombre remoto/u })).not.toBeNull();
    expect(screen.queryByRole('radio', { name: /Robot anterior/u })).toBeNull();
    expect(within(selectedPanel()).getByRole('heading', { name: remote.name })).toBeTruthy();
    expect(within(selectedPanel()).getByRole('alert').textContent).toContain(
      'La copia cambió en otra pestaña.',
    );
    expect(
      within(selectedPanel()).getByText(remote.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();
    expect(saveRobot).toHaveBeenCalledTimes(2);
    expect(savedApi.getRobot).toHaveBeenCalledOnce();

    openMoreActions();
    fireEvent.click(within(selectedPanel()).getByRole('button', { name: 'Renombrar' }));
    const afterConflictDialog = screen.getByRole('dialog', {
      name: /Renombrar.*Nombre remoto/u,
    });
    fireEvent.change(within(afterConflictDialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: afterConflict.name },
    });
    fireEvent.click(within(afterConflictDialog).getByRole('button', { name: 'Guardar nombre' }));
    await settle();
    expect(saveRobot).toHaveBeenCalledTimes(3);
    expect(saveRobot.mock.calls[2]?.slice(0, 3)).toEqual([
      original.id,
      remote.version,
      afterConflict.name,
    ]);
  });
});
