// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { User } from 'oidc-client-ts';
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
import { SavedRobots } from './SavedRobots.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

function session(): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  const sub = 'create-intent-pause-user';
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

function robot(id: string, name: string, draft: RobotDraft): SavedRobot {
  return {
    id,
    name,
    version: 1,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function editor() {
  const current = {
    captureSnapshot: vi.fn<RobotEditorHandle['captureSnapshot']>().mockResolvedValue({
      version: 4,
      draft: createDefaultDraft(),
    } satisfies DraftSnapshot),
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

function api(overrides: Partial<SavedRobotApi> = {}): SavedRobotApi {
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [] }),
    getRobot: vi.fn(),
    saveRobot: vi.fn<SavedRobotApi['saveRobot']>(),
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SavedRobots create intent implementation regressions', () => {
  it('keeps other management actions exclusive while the canceled create request is still running', async () => {
    const existing = robot('saved-copy', 'Robot existente', createDefaultDraft());
    const write = deferred<SavedRobot>();
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockReturnValue(write.promise);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(existing)] }),
      getRobot: vi.fn().mockResolvedValue(existing),
      saveRobot,
    });
    const editorState = editor();
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    fireEvent.click(await screen.findByRole('radio', { name: /Robot existente/u }));
    await screen.findByRole('heading', { name: existing.name });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Copia en vuelo' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    const createdId = saveRobot.mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    const check = await screen.findByRole('button', { name: 'Comprobar guardado' });
    expect(check.getAttribute('aria-disabled')).toBe('true');
    expect(check.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(check);
    expect(
      (screen.getByRole('button', { name: 'Guardar robot actual' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByText('Más acciones'));
    expect((screen.getByRole('button', { name: 'Renombrar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Reemplazar con mi robot actual…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Eliminar copia…' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      write.resolve(robot(createdId!, 'Copia en vuelo', createDefaultDraft()));
      await write.promise;
    });
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
  });

  it('retires a canceled first write after a definitive rejection and allows a fresh UUID', async () => {
    const write = deferred<SavedRobot>();
    const firstDraft = { ...createDefaultDraft(), instructions: 'Primer intento cancelado.' };
    const secondDraft = { ...createDefaultDraft(), instructions: 'Nueva intención.' };
    const captureSnapshot = vi
      .fn<RobotEditorHandle['captureSnapshot']>()
      .mockResolvedValueOnce({ version: 4, draft: firstDraft })
      .mockResolvedValueOnce({ version: 5, draft: secondDraft });
    const editorState = editor();
    editorState.current.captureSnapshot = captureSnapshot;
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockReturnValueOnce(write.promise)
      .mockImplementationOnce(async (id, version, name, draft) => robot(id, name, draft));
    const getRobot = vi.fn<SavedRobotApi['getRobot']>();
    const savedApi = api({ getRobot, saveRobot });
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Solicitud rechazada' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    const rejectedId = saveRobot.mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByLabelText('Nombre para la nueva copia')).toBeNull());
    const check = await screen.findByRole('button', { name: 'Comprobar guardado' });
    expect(document.activeElement).toBe(check);

    await act(async () => {
      write.reject(
        new SavedRobotApiFailure('rate_limited', 'Esperá antes de volver a intentar.', 429),
      );
      await write.promise.catch(() => undefined);
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Comprobar guardado' })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Guardar robot actual' }),
      ),
    );
    expect(getRobot).not.toHaveBeenCalled();
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Nueva intención' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot.mock.calls[1]?.[0]).not.toBe(rejectedId);
    expect(saveRobot.mock.calls[1]?.slice(1, 4)).toEqual([0, 'Nueva intención', secondDraft]);
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
    expect(getRobot).not.toHaveBeenCalled();
  });

  it('closes canceled debt on its automatic same-ID 404 without another GET', async () => {
    const write = deferred<SavedRobot>();
    const firstDraft = { ...createDefaultDraft(), instructions: 'Snapshot ausente.' };
    const secondDraft = { ...createDefaultDraft(), instructions: 'Nueva copia.' };
    const captureSnapshot = vi
      .fn<RobotEditorHandle['captureSnapshot']>()
      .mockResolvedValueOnce({ version: 4, draft: firstDraft })
      .mockResolvedValueOnce({ version: 5, draft: secondDraft });
    const editorState = editor();
    editorState.current.captureSnapshot = captureSnapshot;
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValue(new SavedRobotApiFailure('not_found', 'La copia no existe.', 404));
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockReturnValueOnce(write.promise)
      .mockImplementationOnce(async (...args) => robot(args[0], args[2], args[3]));
    const savedApi = api({ getRobot, saveRobot });
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Copia ausente' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    const missingId = saveRobot.mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByLabelText('Nombre para la nueva copia')).toBeNull());
    const check = await screen.findByRole('button', { name: 'Comprobar guardado' });
    expect(document.activeElement).toBe(check);

    await act(async () => {
      write.reject(
        new SavedRobotApiFailure('network', 'No se confirmó el envío.', undefined, undefined, true),
      );
      await write.promise.catch(() => undefined);
    });
    await waitFor(() => expect(getRobot.mock.calls.map((call) => call[0])).toEqual([missingId]));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Comprobar guardado' })).toBeNull(),
    );
    const createButton = screen.getByRole('button', { name: 'Guardar robot actual' });
    await waitFor(() => expect(document.activeElement).toBe(createButton));
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Guardaste «Copia ausente»/u)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Nueva copia' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot.mock.calls[1]?.[0]).not.toBe(missingId);
    expect(saveRobot.mock.calls[1]?.slice(1, 4)).toEqual([0, 'Nueva copia', secondDraft]);
    expect(getRobot.mock.calls.map((call) => call[0])).toEqual([missingId]);
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
  });

  it('defers an ambiguous write readback while access is paused, then checks only on request', async () => {
    const write = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValue(new SavedRobotApiFailure('not_found', 'No existe todavía.', 404));
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockReturnValue(write.promise);
    const editorState = editor();
    const sessionState = session();
    const savedApi = api({ getRobot, saveRobot });
    const view = render(
      <SavedRobots api={savedApi} editor={editorState.ref} session={sessionState} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Escritura pausada' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    const id = saveRobot.mock.calls[0]?.[0];

    view.rerender(
      <SavedRobots api={savedApi} editor={editorState.ref} session={sessionState} paused />,
    );
    await waitFor(() => expect(screen.queryByLabelText('Nombre para la nueva copia')).toBeNull());
    await act(async () => {
      write.reject(
        new SavedRobotApiFailure('network', 'No se confirmó el envío.', undefined, undefined, true),
      );
      await write.promise.catch(() => undefined);
    });

    expect(getRobot).not.toHaveBeenCalled();
    const check = (await screen.findByRole('button', {
      name: 'Comprobar guardado',
    })) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(editorState.current.captureSnapshot).toHaveBeenCalledOnce();

    view.rerender(<SavedRobots api={savedApi} editor={editorState.ref} session={sessionState} />);
    check.focus();
    fireEvent.click(check);
    await waitFor(() => expect(getRobot.mock.calls.map((call) => call[0])).toEqual([id]));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Comprobar guardado' })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Guardar robot actual' }),
      ),
    );
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(editorState.current.captureSnapshot).toHaveBeenCalledOnce();
  });

  it('hands focus to the create trigger when an explicit check finds the canceled copy', async () => {
    const write = deferred<SavedRobot>();
    const capturedDraft = { ...createDefaultDraft(), instructions: 'Copia confirmada.' };
    let createdId: string | undefined;
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Intentá comprobar de nuevo.'))
      .mockImplementationOnce(async (id) => robot(id, 'Copia confirmada', capturedDraft));
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockImplementation((id) => {
      createdId = id;
      return write.promise;
    });
    const captureSnapshot = vi.fn<RobotEditorHandle['captureSnapshot']>().mockResolvedValue({
      version: 4,
      draft: capturedDraft,
    });
    const editorState = editor();
    editorState.current.captureSnapshot = captureSnapshot;
    const savedApi = api({ getRobot, saveRobot });
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Copia confirmada' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    const check = await screen.findByRole('button', { name: 'Comprobar guardado' });
    expect(document.activeElement).toBe(check);

    await act(async () => {
      write.reject(
        new SavedRobotApiFailure('network', 'No se confirmó el envío.', undefined, undefined, true),
      );
      await write.promise.catch(() => undefined);
    });
    await waitFor(() => expect(getRobot).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Comprobar guardado' })).toBe(check);
    fireEvent.click(check);
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Comprobar guardado' })).toBeNull(),
    );

    const createButton = screen.getByRole('button', { name: 'Guardar robot actual' });
    await waitFor(() => expect(document.activeElement).toBe(createButton));
    const createdRadio = await screen.findByRole('radio', { name: /Copia confirmada/u });
    expect(createdRadio.getAttribute('value')).toBe(createdId);
    expect((createdRadio as HTMLInputElement).checked).toBe(false);
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(screen.queryByText('Guardaste «Copia confirmada» como robot nuevo.')).toBeNull();
  });

  it('preserves focus moved to another control before a late debt readback retires its button', async () => {
    const existing = robot('saved-copy', 'Robot existente', createDefaultDraft());
    const write = deferred<SavedRobot>();
    const readback = deferred<SavedRobot>();
    let createdId: string | undefined;
    const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockImplementation(async (id) => {
      if (id === existing.id) return existing;
      return readback.promise;
    });
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockImplementation((id) => {
      createdId = id;
      return write.promise;
    });
    const savedApi = api({
      getRobot,
      listRobots: vi.fn().mockResolvedValue({ robots: [summary(existing)] }),
      saveRobot,
    });
    const editorState = editor();
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    const radio = (await screen.findByRole('radio', {
      name: /Robot existente/u,
    })) as HTMLInputElement;
    fireEvent.click(radio);
    await screen.findByRole('heading', { name: existing.name });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Copia con respuesta tardía' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    const check = await screen.findByRole('button', { name: 'Comprobar guardado' });
    expect(document.activeElement).toBe(check);

    await act(async () => {
      write.reject(
        new SavedRobotApiFailure('network', 'No se confirmó el envío.', undefined, undefined, true),
      );
      await write.promise.catch(() => undefined);
    });
    await waitFor(() =>
      expect(getRobot.mock.calls.map((call) => call[0])).toEqual([existing.id, createdId]),
    );
    radio.focus();
    await act(async () => {
      readback.reject(new SavedRobotApiFailure('not_found', 'La copia no existe.', 404));
      await readback.promise.catch(() => undefined);
    });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Comprobar guardado' })).toBeNull(),
    );
    expect(document.activeElement).toBe(radio);
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(editorState.current.captureSnapshot).toHaveBeenCalledOnce();
  });

  it('closes canceled debt on a same-ID content conflict without adopting the remote copy', async () => {
    const write = deferred<SavedRobot>();
    const capturedDraft = { ...createDefaultDraft(), instructions: 'Snapshot enviado.' };
    const remoteDraft = { ...createDefaultDraft(), instructions: 'Contenido remoto distinto.' };
    const captureSnapshot = vi
      .fn<RobotEditorHandle['captureSnapshot']>()
      .mockResolvedValueOnce({ version: 4, draft: capturedDraft })
      .mockResolvedValueOnce({ version: 5, draft: createDefaultDraft() });
    const editorState = editor();
    editorState.current.captureSnapshot = captureSnapshot;
    let requestedId: string | undefined;
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'No se pudo comprobar todavía.'))
      .mockImplementationOnce(async (id) => {
        requestedId = id;
        return robot(id, 'Nombre remoto', remoteDraft);
      });
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockReturnValueOnce(write.promise)
      .mockImplementationOnce(async (id, version, name, draft) => robot(id, name, draft));
    const savedApi = api({ getRobot, saveRobot });
    render(<SavedRobots api={savedApi} editor={editorState.ref} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Copia con colisión' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    const uncertainId = saveRobot.mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByLabelText('Nombre para la nueva copia')).toBeNull());
    write.reject(
      new SavedRobotApiFailure('network', 'No se confirmó el envío.', undefined, undefined, true),
    );
    await waitFor(() => expect(getRobot).toHaveBeenCalledOnce());
    expect(getRobot.mock.calls[0]?.[0]).toBe(uncertainId);
    const check = await screen.findByRole('button', { name: 'Comprobar guardado' });
    expect(document.activeElement).toBe(check);

    fireEvent.click(screen.getByRole('button', { name: 'Comprobar guardado' }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Comprobar guardado' })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Guardar robot actual' }),
      ),
    );
    expect(getRobot.mock.calls.map((call) => call[0])).toEqual([uncertainId, uncertainId]);
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(screen.getByText(/existe con otro contenido/u)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Nombre remoto/u })).toBeNull();
    expect(screen.queryByText(remoteDraft.instructions)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Acción nueva' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(requestedId).toBe(uncertainId);
    expect(saveRobot.mock.calls[1]?.[0]).not.toBe(uncertainId);
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each(['put-409', 'ambiguous-readback'] as const)(
    'ends a same-ID content collision from the initial %s without another check or write',
    async (path) => {
      const capturedDraft = { ...createDefaultDraft(), instructions: 'Contenido solicitado.' };
      const remoteDraft = { ...createDefaultDraft(), instructions: 'Contenido que ya existe.' };
      let requestedId: string | undefined;
      const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockImplementation(async (...args) => {
        const id = args[0];
        const name = args[2];
        requestedId = id;
        if (path === 'put-409') {
          throw new SavedRobotApiFailure(
            'conflict',
            'La copia ya existe.',
            409,
            robot(id, name, remoteDraft),
          );
        }
        throw new SavedRobotApiFailure(
          'network',
          'No se confirmó el envío.',
          undefined,
          undefined,
          true,
        );
      });
      const getRobot = vi
        .fn<SavedRobotApi['getRobot']>()
        .mockImplementation(async (id) => robot(id, 'Colisión', remoteDraft));
      const captureSnapshot = vi.fn<RobotEditorHandle['captureSnapshot']>().mockResolvedValue({
        version: 4,
        draft: capturedDraft,
      });
      const editorState = editor();
      editorState.current.captureSnapshot = captureSnapshot;
      render(
        <SavedRobots
          api={api({ getRobot, saveRobot })}
          editor={editorState.ref}
          session={session()}
        />,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
      fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
        target: { value: 'Colisión' },
      });
      fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
      await screen.findByText(/Hay una versión más nueva/u);

      expect(requestedId).toMatch(/^[0-9a-f-]{36}$/iu);
      expect(saveRobot).toHaveBeenCalledOnce();
      expect(captureSnapshot).toHaveBeenCalledOnce();
      expect(getRobot.mock.calls.map((call) => call[0])).toEqual(
        path === 'put-409' ? [] : [requestedId],
      );
      expect(screen.queryByText(/misma copia/u)).toBeNull();
    },
  );
});
