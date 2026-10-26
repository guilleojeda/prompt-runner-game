// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function session(sub = 'subject-a'): AuthSession {
  return {
    identity: { sub, email: `${sub}@example.com` },
    user: new User({
      access_token: 'access-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client-public',
        iat: 1,
        exp: 9999999999,
        sub,
        email: `${sub}@example.com`,
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

function savedRobot(overrides: Partial<SavedRobot> = {}): SavedRobot {
  return {
    id: 'robot-a',
    name: 'Explorador',
    version: 1,
    createdAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:00:00.000Z',
    modelKey: 'claude-sonnet-4.6',
    draft: createDefaultDraft(),
    ...overrides,
  };
}

function robotSummary(robot: SavedRobot): SavedRobotSummary {
  return {
    id: robot.id,
    name: robot.name,
    version: robot.version,
    createdAt: robot.createdAt,
    updatedAt: robot.updatedAt,
    modelKey: robot.modelKey,
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

function editor(
  snapshot: RobotDraft = createDefaultDraft(),
): React.RefObject<RobotEditorHandle | null> {
  return {
    current: {
      captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: snapshot }),
      applyDraft: vi
        .fn()
        .mockImplementation(async (value: RobotDraft | (() => Promise<RobotDraft>)) => {
          if (typeof value === 'function') await value();
          return true;
        }),
      hasUnconfirmedChanges: vi.fn().mockReturnValue(false),
      discardPending: vi.fn(),
      flushPending: vi.fn().mockResolvedValue(true),
      waitForConfirmed: vi.fn().mockResolvedValue(true),
      releaseAttemptLock: vi.fn(),
    },
  };
}

function api(overrides: Partial<SavedRobotApi> = {}): SavedRobotApi {
  const robot = savedRobot();
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [robot], nextCursor: undefined }),
    getRobot: vi.fn().mockResolvedValue(robot),
    saveRobot: vi
      .fn()
      .mockImplementation(async (id: string, version: number, name: string, draft: RobotDraft) =>
        savedRobot({
          id,
          version: version + 1,
          name,
          draft,
          updatedAt: '2026-09-29T13:00:00.000Z',
        }),
      ),
    deleteRobot: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('SavedRobots', () => {
  it('loads a selected copy into the editor and creates a named copy from its snapshot', async () => {
    const editorRef = editor();
    const savedApi = api();
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    expect(await screen.findByRole('button', { name: /Explorador.*Cargar/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Explorador.*Cargar/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() =>
      expect(editorRef.current?.applyDraft).toHaveBeenCalledWith(expect.any(Function)),
    );
    expect(screen.getByText('Seleccionado:')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar como nueva' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Nombre para la nueva copia'));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Defensa' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() =>
      expect(savedApi.saveRobot).toHaveBeenCalledWith(
        expect.any(String),
        0,
        'Defensa',
        createDefaultDraft(),
      ),
    );
    expect(await screen.findByText('Guardaste «Defensa» como robot nuevo.')).toBeTruthy();
  });

  it('keeps the editor unchanged and reports auth when a copy load is rejected', async () => {
    const onAuthRequired = vi.fn();
    const savedApi = api({
      getRobot: vi
        .fn()
        .mockRejectedValue(new SavedRobotApiFailure('authentication', 'Volvé a ingresar.', 401)),
    });
    const editorRef = editor();
    render(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledOnce());
    expect(screen.getByText('Volvé a ingresar.')).toBeTruthy();
    expect(screen.queryByText('Seleccionado:')).toBeNull();
  });

  it('shows an empty state after a list retry and does not offer a mutation retry', async () => {
    const listRobots = vi
      .fn()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'No hay conexión.'))
      .mockResolvedValueOnce({ robots: [] });
    const savedApi = api({ listRobots });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    expect(await screen.findByText('No hay conexión.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar lista' }));
    expect(await screen.findByText('Todavía no guardaste ninguna copia.')).toBeTruthy();
    expect(listRobots).toHaveBeenCalledTimes(2);
  });

  it('keeps creation disabled while paused or locked', async () => {
    const savedApi = api({ listRobots: vi.fn().mockResolvedValue({ robots: [] }) });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} paused locked />);

    const create = await screen.findByRole('button', { name: 'Guardar como nueva' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
  });

  it('exposes one create control and preserves the entered name while the form is open', async () => {
    const savedApi = api({ listRobots: vi.fn().mockResolvedValue({ robots: [] }) });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    const create = await screen.findByRole('button', { name: 'Guardar como nueva' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    expect(screen.getAllByRole('button', { name: 'Guardar como nueva' })).toHaveLength(1);

    const input = screen.getByLabelText('Nombre para la nueva copia');
    fireEvent.change(input, { target: { value: 'Defensa' } });
    expect((input as HTMLInputElement).value).toBe('Defensa');

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar como nueva' }));
    expect(screen.getAllByRole('button', { name: 'Guardar como nueva' })).toHaveLength(1);
    expect((screen.getByLabelText('Nombre para la nueva copia') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('accepts an 80-code-point Unicode name without truncating it in the input', async () => {
    const editorRef = editor();
    const saveRobot = vi
      .fn()
      .mockImplementation(async (id: string, version: number, name: string, draft: RobotDraft) =>
        savedRobot({ id, version: version + 1, name, draft }),
      );
    const savedApi = api({ listRobots: vi.fn().mockResolvedValue({ robots: [] }), saveRobot });
    const unicodeName = '🙂'.repeat(80);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
    const input = screen.getByLabelText('Nombre para la nueva copia');
    fireEvent.change(input, { target: { value: unicodeName } });
    expect((input as HTMLInputElement).value).toBe(unicodeName);
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(saveRobot).toHaveBeenCalledWith(
        expect.any(String),
        0,
        unicodeName,
        createDefaultDraft(),
      ),
    );
  });

  it('deduplicates paginated rows by ID while retaining same-name copies', async () => {
    const summary = (id: string, version: number): SavedRobotSummary => ({
      id,
      name: 'Mismo nombre',
      version,
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      modelKey: 'claude-sonnet-4.6',
    });
    const listRobots = vi
      .fn()
      .mockResolvedValueOnce({
        robots: [summary('robot-a', 1), summary('robot-b', 1)],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({ robots: [summary('robot-a', 2), summary('robot-c', 1)] });
    const getRobot = vi.fn().mockImplementation(async (id: string) => savedRobot({ id }));
    const savedApi = api({ listRobots, getRobot });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    expect(await screen.findAllByRole('button', { name: /Mismo nombre.*Cargar/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Mismo nombre Copia 1.*Cargar$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Mismo nombre Copia 2.*Cargar$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Mismo nombre.*Cargar/ })).toHaveLength(3),
    );
    expect(screen.getByRole('button', { name: /^Mismo nombre Copia 3.*Cargar$/ })).toBeTruthy();
    for (const [index, expectedId] of ['robot-a', 'robot-b', 'robot-c'].entries()) {
      fireEvent.click(screen.getAllByRole('button', { name: /Mismo nombre.*Cargar/ })[index]!);
      await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(index + 1));
      expect(getRobot.mock.calls[index]?.[0]).toBe(expectedId);
    }
    expect(listRobots).toHaveBeenLastCalledWith('next');
  });

  it('updates the selected copy only from the explicit Guardar action', async () => {
    const changed = { ...createDefaultDraft(), instructions: 'Preferí esperar.' };
    const editorRef = editor(changed);
    const saveRobot = vi
      .fn()
      .mockResolvedValue(savedRobot({ version: 2, name: 'Explorador mejorado', draft: changed }));
    const savedApi = api({ saveRobot });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    expect(saveRobot).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Nombre de esta copia'), {
      target: { value: 'Explorador mejorado' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() =>
      expect(saveRobot).toHaveBeenCalledWith('robot-a', 1, 'Explorador mejorado', changed),
    );
    expect(screen.getByText('Guardaste «Explorador mejorado».')).toBeTruthy();
  });

  it('accepts a complete matching 409 current as the pending create result', async () => {
    const draft = { ...createDefaultDraft(), instructions: 'La misma creación.' };
    const saveRobot = vi
      .fn()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      )
      .mockImplementationOnce(
        async (id: string, _version: number, name: string, nextDraft: RobotDraft) => {
          throw new SavedRobotApiFailure(
            'conflict',
            'stale',
            409,
            savedRobot({ id, name, version: 1, draft: nextDraft }),
          );
        },
      );
    const getRobot = vi
      .fn()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'No se puede leer todavía.'))
      .mockRejectedValueOnce(new SavedRobotApiFailure('not_found', 'No existe.', 404));
    const editorRef = editor(draft);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      saveRobot,
      getRobot,
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Copia pendiente' },
    });
    const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/misma copia/)).toBeTruthy());
    const id = saveRobot.mock.calls[0]?.[0];

    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByText('Guardaste «Copia pendiente» como robot nuevo.')).toBeTruthy(),
    );
    expect(saveRobot.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      [id, 0, 'Copia pendiente', draft],
      [id, 0, 'Copia pendiente', draft],
    ]);
    expect(getRobot.mock.calls.map((call) => call[0])).toEqual([id, id]);
    expect(editorRef.current?.captureSnapshot).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Cargar versión remota' })).toBeNull();
  });

  it('reuses the pending create UUID after an ambiguous write and transient readback failure', async () => {
    const editorRef = editor();
    const saveRobot = vi
      .fn()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      )
      .mockImplementationOnce(
        async (id: string, _version: number, name: string, draft: RobotDraft) =>
          savedRobot({ id, name, version: 1, draft }),
      );
    const getRobot = vi
      .fn()
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Todavía no se puede leer.'))
      .mockImplementationOnce(async (id: string) => savedRobot({ id, name: 'Persistente' }));
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      saveRobot,
      getRobot,
    });
    const view = render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Persistente' },
    });
    const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText(/misma copia/)).toBeTruthy();
    expect(saveRobot).toHaveBeenCalledTimes(1);
    const firstId = saveRobot.mock.calls[0]?.[0];

    view.rerender(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        configurationAvailable={false}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Guardar como nueva' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    const pendingName = screen.getByLabelText('Nombre para la nueva copia') as HTMLInputElement;
    expect(pendingName.disabled).toBe(true);
    expect(pendingName.value).toBe('Persistente');
    fireEvent.submit(form);
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot).toHaveBeenCalledTimes(1);
    expect(getRobot.mock.calls[1]?.[0]).toBe(firstId);
    expect(screen.getByText('Guardaste «Persistente» como robot nuevo.')).toBeTruthy();
    expect(editorRef.current?.captureSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])(
    'retains a first pending create after an auth readback failure (%s) and reports its context',
    async (status) => {
      const draft = { ...createDefaultDraft(), instructions: 'Copia con acceso renovado.' };
      const onAuthRequired = vi.fn();
      const saveRobot = vi
        .fn()
        .mockRejectedValueOnce(
          new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
        );
      const getRobot = vi
        .fn()
        .mockRejectedValueOnce(
          new SavedRobotApiFailure(
            'authentication',
            'El acceso anterior fue rechazado.',
            status,
            undefined,
            false,
            { authContext: 17 },
          ),
        );
      const savedApi = api({
        listRobots: vi.fn().mockResolvedValue({ robots: [] }),
        saveRobot,
        getRobot,
      });
      const editorRef = editor(draft);
      render(
        <SavedRobots
          api={savedApi}
          editor={editorRef}
          session={session()}
          onAuthRequired={onAuthRequired}
        />,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
      fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
        target: { value: 'Acceso renovado' },
      });
      const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => expect(onAuthRequired).toHaveBeenCalledWith(17));
      expect(screen.getByText('El acceso anterior fue rechazado.')).toBeTruthy();
      expect(screen.getByText(/misma copia/)).toBeTruthy();
      expect(saveRobot).toHaveBeenCalledOnce();
      const id = saveRobot.mock.calls[0]?.[0];
      getRobot.mockResolvedValueOnce(savedRobot({ id, name: 'Acceso renovado', draft }));

      fireEvent.submit(form);
      await waitFor(() =>
        expect(screen.getByText('Guardaste «Acceso renovado» como robot nuevo.')).toBeTruthy(),
      );
      expect(getRobot).toHaveBeenLastCalledWith(id);
      expect(saveRobot).toHaveBeenCalledOnce();
      expect(onAuthRequired).toHaveBeenCalledOnce();
    },
  );

  it.each([401, 403])(
    'retains a pending create when a later auth readback fails (%s) and retries the same UUID',
    async (status) => {
      const draft = { ...createDefaultDraft(), instructions: 'Esperando renovación.' };
      const onAuthRequired = vi.fn();
      const saveRobot = vi
        .fn()
        .mockRejectedValueOnce(
          new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
        );
      const getRobot = vi
        .fn()
        .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Todavía no se puede leer.'))
        .mockRejectedValueOnce(
          new SavedRobotApiFailure(
            'authentication',
            'La lectura anterior perdió acceso.',
            status,
            undefined,
            false,
            { authContext: 29 },
          ),
        )
        .mockImplementationOnce(async (id: string) =>
          savedRobot({ id, name: 'Esperando renovación', draft }),
        );
      const savedApi = api({
        listRobots: vi.fn().mockResolvedValue({ robots: [] }),
        saveRobot,
        getRobot,
      });
      const editorRef = editor(draft);
      render(
        <SavedRobots
          api={savedApi}
          editor={editorRef}
          session={session()}
          onAuthRequired={onAuthRequired}
        />,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
      fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
        target: { value: 'Esperando renovación' },
      });
      const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
      fireEvent.submit(form);
      await waitFor(() => expect(screen.getByText(/misma copia/)).toBeTruthy());
      const id = saveRobot.mock.calls[0]?.[0];

      fireEvent.submit(form);
      await waitFor(() => expect(onAuthRequired).toHaveBeenCalledWith(29));
      expect(screen.getByText('La lectura anterior perdió acceso.')).toBeTruthy();
      expect(screen.getByText(/misma copia/)).toBeTruthy();
      expect(saveRobot).toHaveBeenCalledOnce();
      expect(getRobot).toHaveBeenNthCalledWith(2, id);

      fireEvent.submit(form);
      await waitFor(() =>
        expect(screen.getByText('Guardaste «Esperando renovación» como robot nuevo.')).toBeTruthy(),
      );
      expect(getRobot).toHaveBeenNthCalledWith(3, id);
      expect(saveRobot).toHaveBeenCalledOnce();
      expect(onAuthRequired).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      code: 'authentication' as const,
      status: 401,
      message: 'El acceso fue rechazado para esta operación.',
      authContext: 41,
    },
    {
      code: 'invalid' as const,
      status: 400,
      message: 'La configuración no es válida.',
      authContext: undefined,
    },
    {
      code: 'limit' as const,
      status: 409,
      message: 'Eliminá una configuración guardada para crear otra.',
      authContext: undefined,
    },
    {
      code: 'rate_limited' as const,
      status: 429,
      message: 'Esperá un momento antes de volver a intentar.',
      authContext: undefined,
    },
  ])(
    'does not retain a pending create after a definite initial $code rejection',
    async ({ code, status, message, authContext }) => {
      const saveRobot = vi
        .fn()
        .mockRejectedValueOnce(
          new SavedRobotApiFailure(
            code,
            message,
            status,
            undefined,
            code === 'invalid',
            authContext === undefined ? undefined : { authContext },
          ),
        )
        .mockImplementationOnce(
          async (id: string, _version: number, name: string, draft: RobotDraft) =>
            savedRobot({ id, name, draft }),
        );
      const savedApi = api({
        listRobots: vi.fn().mockResolvedValue({ robots: [] }),
        saveRobot,
      });
      const onAuthRequired = vi.fn();
      render(
        <SavedRobots
          api={savedApi}
          editor={editor()}
          session={session()}
          onAuthRequired={onAuthRequired}
        />,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
      fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
        target: { value: 'Rechazo definitivo' },
      });
      const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
      fireEvent.submit(form);
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
      const firstId = saveRobot.mock.calls[0]?.[0];
      expect(screen.queryByText(/misma copia/)).toBeNull();
      if (authContext === undefined) {
        expect(onAuthRequired).not.toHaveBeenCalled();
      } else {
        expect(onAuthRequired).toHaveBeenCalledWith(authContext);
      }

      fireEvent.submit(form);
      await waitFor(() =>
        expect(screen.getByText('Guardaste «Rechazo definitivo» como robot nuevo.')).toBeTruthy(),
      );
      expect(saveRobot).toHaveBeenCalledTimes(2);
      expect(saveRobot.mock.calls[1]?.[0]).not.toBe(firstId);
    },
  );

  it.each([
    {
      code: 'rate_limited' as const,
      status: 429,
      message: 'Esperá un momento antes de volver a intentar.',
    },
    {
      code: 'limit' as const,
      status: 409,
      message: 'Eliminá una configuración guardada para crear otra.',
    },
  ])(
    'retains an older uncertain create when its retry is rejected by $code',
    async ({ code, status, message }) => {
      const draft = { ...createDefaultDraft(), instructions: 'Contenido incierto.' };
      const saveRobot = vi
        .fn()
        .mockRejectedValueOnce(
          new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
        )
        .mockRejectedValueOnce(new SavedRobotApiFailure(code, message, status))
        .mockImplementationOnce(
          async (id: string, _version: number, name: string, nextDraft: RobotDraft) =>
            savedRobot({ id, name, draft: nextDraft }),
        );
      const getRobot = vi
        .fn()
        .mockRejectedValue(new SavedRobotApiFailure('not_found', 'No existe.', 404));
      const savedApi = api({
        listRobots: vi.fn().mockResolvedValue({ robots: [] }),
        saveRobot,
        getRobot,
      });
      render(<SavedRobots api={savedApi} editor={editor(draft)} session={session()} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
      fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
        target: { value: 'Copia incierta' },
      });
      const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
      fireEvent.submit(form);
      await waitFor(() => expect(screen.getByText(/misma copia/)).toBeTruthy());
      const pendingId = saveRobot.mock.calls[0]?.[0];

      fireEvent.submit(form);
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
      expect(screen.getByText(/misma copia/)).toBeTruthy();
      expect(
        (screen.getByLabelText('Nombre para la nueva copia') as HTMLInputElement).disabled,
      ).toBe(true);

      fireEvent.submit(form);
      await waitFor(() =>
        expect(screen.getByText('Guardaste «Copia incierta» como robot nuevo.')).toBeTruthy(),
      );
      expect(saveRobot.mock.calls[1]?.slice(0, 4)).toEqual([pendingId, 0, 'Copia incierta', draft]);
      expect(saveRobot.mock.calls[2]?.slice(0, 4)).toEqual([pendingId, 0, 'Copia incierta', draft]);
      expect(getRobot).toHaveBeenCalledTimes(3);
    },
  );

  it('retries the same UUID after a same-ID 404 confirms the ambiguous create was absent', async () => {
    const draft = { ...createDefaultDraft(), instructions: 'Reintento sin copia remota.' };
    const saveRobot = vi
      .fn()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      )
      .mockImplementationOnce(
        async (id: string, _version: number, name: string, nextDraft: RobotDraft) =>
          savedRobot({ id, name, draft: nextDraft }),
      );
    const getRobot = vi
      .fn()
      .mockRejectedValueOnce(new SavedRobotApiFailure('not_found', 'No existe.', 404))
      .mockRejectedValueOnce(new SavedRobotApiFailure('not_found', 'No existe.', 404));
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      saveRobot,
      getRobot,
    });
    render(<SavedRobots api={savedApi} editor={editor(draft)} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Sin copia remota' },
    });
    const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/misma copia/)).toBeTruthy());
    const id = saveRobot.mock.calls[0]?.[0];

    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByText('Guardaste «Sin copia remota» como robot nuevo.')).toBeTruthy(),
    );
    expect(getRobot).toHaveBeenCalledWith(id);
    expect(saveRobot).toHaveBeenNthCalledWith(2, id, 0, 'Sin copia remota', draft);
  });

  it.each([
    {
      label: 'different content',
      remote: (id: string, draft: RobotDraft) =>
        savedRobot({
          id,
          name: 'Otra copia',
          draft: { ...draft, instructions: 'Contenido remoto.' },
        }),
    },
    {
      label: 'different identity',
      remote: (id: string, draft: RobotDraft) =>
        savedRobot({ id: `${id}-other`, name: 'Guardada', draft }),
    },
  ])('keeps the pending create behind the same-ID $label guard', async ({ remote }) => {
    const draft = { ...createDefaultDraft(), instructions: 'Contenido local.' };
    const saveRobot = vi
      .fn()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const getRobot = vi.fn().mockImplementation(async (id: string) => remote(id, draft));
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [] }),
      saveRobot,
      getRobot,
    });
    render(<SavedRobots api={savedApi} editor={editor(draft)} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Guardada' },
    });
    const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/misma copia/)).toBeTruthy());
    expect(saveRobot).toHaveBeenCalledOnce();

    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/Hay una versión más nueva/)).toBeTruthy());
    expect(screen.queryByText(/misma copia/)).toBeNull();
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(getRobot).toHaveBeenCalledTimes(2);
  });

  it('does not save a snapshot captured before an account switch', async () => {
    let resolveSnapshot!: (snapshot: { version: number; draft: RobotDraft }) => void;
    const editorRef = editor();
    (editorRef.current?.captureSnapshot as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const saveRobot = vi.fn();
    const robot = savedRobot();
    const savedApi = api({ saveRobot });
    const view = render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));

    view.rerender(<SavedRobots api={savedApi} editor={editorRef} session={session('subject-b')} />);
    await act(async () => {
      resolveSnapshot({ version: 1, draft: robot.draft });
      await Promise.resolve();
    });
    expect(saveRobot).not.toHaveBeenCalled();
  });

  it('reconciles an ambiguous write by reading the same UUID', async () => {
    const robot = savedRobot();
    const saveRobot = vi
      .fn()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const getRobot = vi.fn().mockResolvedValue(savedRobot({ version: 2, draft: robot.draft }));
    const editorRef = editor();
    const savedApi = api({ saveRobot, getRobot });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    const changed = { ...createDefaultDraft(), instructions: 'Nueva ruta.' };
    (editorRef.current?.captureSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 1,
      draft: changed,
    });
    getRobot.mockResolvedValue(savedRobot({ version: 2, draft: changed }));
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() => expect(screen.getByText('Guardaste «Explorador».')).toBeTruthy());
    expect(getRobot).toHaveBeenLastCalledWith('robot-a');
  });

  it('preserves an auth failure from ambiguous save readback and scopes the error to Guardar', async () => {
    const onAuthRequired = vi.fn();
    const saveRobot = vi
      .fn()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const getRobot = vi
      .fn()
      .mockResolvedValueOnce(savedRobot())
      .mockRejectedValueOnce(new SavedRobotApiFailure('authentication', 'Volvé a ingresar.', 401));
    const editorRef = editor({ ...createDefaultDraft(), instructions: 'Cambios.' });
    const savedApi = api({ saveRobot, getRobot });
    render(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledOnce());
    expect(screen.getByText('Volvé a ingresar.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar lista' })).toBeNull();
  });

  it('preserves an auth failure from ambiguous delete readback', async () => {
    const onAuthRequired = vi.fn();
    const deleteRobot = vi
      .fn()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const getRobot = vi
      .fn()
      .mockResolvedValueOnce(savedRobot())
      .mockRejectedValueOnce(new SavedRobotApiFailure('authentication', 'Volvé a ingresar.', 401));
    const savedApi = api({ deleteRobot, getRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <SavedRobots
        api={savedApi}
        editor={editor()}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(screen.getByText(/Seleccionado/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByText('Volvé a ingresar.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar lista' })).toBeNull();
    confirm.mockRestore();
  });

  it('blocks a stale selected save until the remote version is loaded', async () => {
    const remoteDraft = { ...createDefaultDraft(), instructions: 'Versión remota.' };
    const changedDraft = { ...createDefaultDraft(), instructions: 'Cambios locales.' };
    const remote = savedRobot({ version: 2, draft: remoteDraft });
    const saveRobot = vi
      .fn()
      .mockRejectedValueOnce(new SavedRobotApiFailure('conflict', 'stale', 409, remote))
      .mockResolvedValueOnce(savedRobot({ version: 3, draft: changedDraft }));
    const editorRef = editor(changedDraft);
    const savedApi = api({ saveRobot });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() =>
      expect(screen.getByText(/Hay una versión.*Guardar.*bloqueado/)).toBeTruthy(),
    );
    expect((screen.getByRole('button', { name: /^Guardar$/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Seguir con esta versión' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Guardar como nueva' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar versión remota' }));
    await waitFor(() =>
      expect(editorRef.current?.applyDraft).toHaveBeenLastCalledWith(remoteDraft),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot.mock.calls[1]?.[0]).toBe('robot-a');
    expect(saveRobot.mock.calls[1]?.[1]).toBe(2);
  });

  it('accepts a complete matching 409 current as a selected save result', async () => {
    const changedDraft = { ...createDefaultDraft(), instructions: 'Cambios confirmados.' };
    const current = savedRobot({
      version: 2,
      name: 'Nombre confirmado',
      draft: changedDraft,
    });
    const saveRobot = vi
      .fn()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      )
      .mockRejectedValueOnce(new SavedRobotApiFailure('conflict', 'stale', 409, current));
    const getRobot = vi
      .fn()
      .mockResolvedValueOnce(savedRobot())
      .mockRejectedValueOnce(new SavedRobotApiFailure('network', 'Readback no disponible.'));
    const editorRef = editor(changedDraft);
    const savedApi = api({ saveRobot, getRobot });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Nombre de esta copia'), {
      target: { value: 'Nombre confirmado' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() => expect(screen.getByText('No se confirmó.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() => expect(screen.getByText('Guardaste «Nombre confirmado».')).toBeTruthy());
    expect(saveRobot.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      ['robot-a', 1, 'Nombre confirmado', changedDraft],
      ['robot-a', 1, 'Nombre confirmado', changedDraft],
    ]);
    expect(screen.queryByRole('button', { name: 'Cargar versión remota' })).toBeNull();
    expect(getRobot).toHaveBeenCalledTimes(2);
  });

  it('retires a pending create when its listed copy is deleted before a fresh capture', async () => {
    const initialDraft = { ...createDefaultDraft(), instructions: 'Captura incierta.' };
    const currentDraft = { ...createDefaultDraft(), instructions: 'Captura vigente.' };
    const editorRef = editor(initialDraft);
    const captureSnapshot = editorRef.current?.captureSnapshot as ReturnType<typeof vi.fn>;
    captureSnapshot.mockResolvedValueOnce({ version: 1, draft: initialDraft });
    captureSnapshot.mockResolvedValueOnce({ version: 1, draft: currentDraft });
    let pendingId: string | undefined;
    const listRobots = vi.fn().mockImplementation(async (cursor?: string) => {
      if (!cursor) {
        return {
          robots: [robotSummary(savedRobot({ id: 'existing-copy', name: 'Existente' }))],
          nextCursor: 'next',
        };
      }
      return {
        robots: [
          robotSummary(
            savedRobot({
              id: pendingId ?? 'pending-copy',
              name: 'Copia incierta',
              draft: initialDraft,
            }),
          ),
        ],
      };
    });
    const saveRobot = vi
      .fn()
      .mockImplementationOnce(async (id: string) => {
        pendingId = id;
        throw new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true);
      })
      .mockImplementationOnce(
        async (id: string, _version: number, name: string, draft: RobotDraft) =>
          savedRobot({ id, name, draft }),
      );
    const getRobot = vi
      .fn()
      .mockRejectedValueOnce(new SavedRobotApiFailure('not_found', 'No existe.', 404));
    const deleteRobot = vi.fn().mockResolvedValue({ deleted: true });
    const savedApi = api({ listRobots, saveRobot, getRobot, deleteRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Copia incierta' },
    });
    const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/misma copia/)).toBeTruthy());
    expect(pendingId).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Eliminar Copia incierta' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar Copia incierta' }));
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledWith(pendingId, 1));
    expect(screen.queryByText(/misma copia/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar como nueva' }));
    const freshName = screen.getByLabelText('Nombre para la nueva copia');
    expect((freshName as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(freshName, { target: { value: 'Copia vigente' } });
    fireEvent.submit(freshName.closest('form')!);
    await waitFor(() =>
      expect(screen.getByText('Guardaste «Copia vigente» como robot nuevo.')).toBeTruthy(),
    );

    expect(saveRobot).toHaveBeenCalledTimes(2);
    expect(saveRobot.mock.calls[1]?.[0]).not.toBe(pendingId);
    expect(saveRobot.mock.calls[1]?.slice(2, 4)).toEqual(['Copia vigente', currentDraft]);
    confirm.mockRestore();
  });

  it('deletes a selected copy without changing the editor draft', async () => {
    const editorRef = editor();
    const savedApi = api();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(savedApi.deleteRobot).toHaveBeenCalledWith('robot-a', 1));
    expect(editorRef.current?.applyDraft).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Seleccionado:')).toBeNull();
  });

  it('does not delete when confirmation is cancelled', async () => {
    const editorRef = editor();
    const savedApi = api();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(screen.getByText('Seleccionado:')).toBeTruthy();
    confirm.mockRestore();
  });

  it('treats an ambiguous delete as complete after same-ID 404 readback', async () => {
    const editorRef = editor();
    const deleteRobot = vi
      .fn()
      .mockRejectedValue(
        new SavedRobotApiFailure('network', 'No se confirmó.', undefined, undefined, true),
      );
    const getRobot = vi
      .fn()
      .mockResolvedValueOnce(savedRobot())
      .mockRejectedValueOnce(new SavedRobotApiFailure('not_found', 'No existe.', 404));
    const savedApi = api({ deleteRobot, getRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(screen.queryByText('Seleccionado:')).toBeNull());
    expect(getRobot).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Eliminaste «Explorador»/)).toBeTruthy();
    confirm.mockRestore();
  });

  it('resolves a stale delete without changing the active draft and asks for confirmation again', async () => {
    const activeDraft = { ...createDefaultDraft(), instructions: 'Cambios locales.' };
    const remote = savedRobot({
      version: 2,
      draft: { ...createDefaultDraft(), instructions: 'Versión remota.' },
    });
    const editorRef = editor(activeDraft);
    const deleteRobot = vi
      .fn()
      .mockRejectedValueOnce(new SavedRobotApiFailure('conflict', 'stale', 409, remote))
      .mockResolvedValueOnce({ deleted: true });
    const savedApi = api({ deleteRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' })).toBeTruthy(),
    );
    expect(screen.getAllByText(/confirmá «Eliminar» nuevamente/)).toHaveLength(1);
    expect(screen.queryByText(/«Guardar» está bloqueado/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' }));
    await waitFor(() =>
      expect(screen.getByText(/cambió.*Confirmá «Eliminar» nuevamente/)).toBeTruthy(),
    );
    expect(editorRef.current?.applyDraft).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(deleteRobot).toHaveBeenLastCalledWith('robot-a', 2));
    expect(deleteRobot).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(editorRef.current?.applyDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Eliminaste «Explorador»/)).toBeTruthy();
    confirm.mockRestore();
  });

  it('switches conflict resolution from delete to save after creating a new copy', async () => {
    const changedDraft = { ...createDefaultDraft(), instructions: 'Cambios locales.' };
    const deleteRemote = savedRobot({ id: 'robot-a', version: 2 });
    const newCopy = savedRobot({
      id: 'robot-new',
      name: 'Nueva copia',
      version: 1,
      draft: createDefaultDraft(),
    });
    const saveRemote = savedRobot({ ...newCopy, version: 2 });
    const editorRef = editor();
    const captureSnapshot = editorRef.current?.captureSnapshot as ReturnType<typeof vi.fn>;
    const saveRobot = vi
      .fn()
      .mockResolvedValueOnce(newCopy)
      .mockRejectedValueOnce(new SavedRobotApiFailure('conflict', 'stale', 409, saveRemote));
    const deleteRobot = vi
      .fn()
      .mockRejectedValueOnce(new SavedRobotApiFailure('conflict', 'stale', 409, deleteRemote));
    const savedApi = api({ saveRobot, deleteRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Guardar como nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Nueva copia' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() =>
      expect(screen.getByText('Guardaste «Nueva copia» como robot nuevo.')).toBeTruthy(),
    );

    captureSnapshot.mockResolvedValue({ version: 1, draft: changedDraft });
    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cargar versión remota' })).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Actualizar versión para Eliminar' })).toBeNull();
    expect(editorRef.current?.applyDraft).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('consults a readable historical copy without requiring an available editor', async () => {
    const base = createDefaultDraft();
    const instructions = 'Instrucción histórica completa. '.repeat(45);
    const disabledDescription = 'Descripción histórica deshabilitada. '.repeat(17);
    const historical = savedRobot({
      draft: {
        ...base,
        instructions,
        skills: base.skills.map((skill) =>
          skill.id === 'wait'
            ? { ...skill, enabled: false, description: disabledDescription }
            : skill,
        ),
      },
    });
    const editorRef = editor();
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(historical)] }),
      getRobot: vi.fn().mockResolvedValue(historical),
    });
    render(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        configurationAvailable={false}
      />,
    );

    const load = await screen.findByRole('button', { name: /Explorador.*Cargar/ });
    expect((load as HTMLButtonElement).disabled).toBe(true);
    const trigger = screen.getByRole('button', { name: 'Ver configuración de Explorador' });
    fireEvent.click(trigger);

    await waitFor(() =>
      expect(
        [...document.querySelectorAll('.configuration-preview-copy p')].some(
          (paragraph) => paragraph.textContent === instructions,
        ),
      ).toBe(true),
    );
    const description = [...document.querySelectorAll('.configuration-preview-literal')].find(
      (element) => element.textContent === disabledDescription,
    );
    expect(description).toBeTruthy();
    expect(description?.closest('li')?.textContent).toContain('deshabilitada');
    expect(description?.closest('li')?.textContent).toContain('Esperar');
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Configuración de Explorador' }),
    );
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(screen.queryByText(/Seleccionado:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(document.activeElement).toBe(trigger);
  });

  it('shows an oversized readable copy after Cargar without writing or showing an editor error', async () => {
    const historical = savedRobot({
      draft: { ...createDefaultDraft(), instructions: 'x'.repeat(1_190) },
    });
    const editorRef = editor();
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(historical)] }),
      getRobot: vi.fn().mockResolvedValue(historical),
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));

    await waitFor(() =>
      expect(
        [...document.querySelectorAll('.configuration-preview-copy p')].some(
          (paragraph) => paragraph.textContent === historical.draft.instructions,
        ),
      ).toBe(true),
    );
    expect(screen.getByRole('status').textContent).toContain('supera los límites actuales');
    expect(screen.getByRole('status').textContent).toMatch(/1.?000 caracteres/u);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Seleccionado:/)).toBeNull();
    expect(editorRef.current?.applyDraft).toHaveBeenCalledOnce();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
  });

  it('keeps incompatible rows deletable by listed ID/version and preserves a neighboring selection', async () => {
    const active = savedRobot({ id: 'active-copy', name: 'Activa' });
    const incompatible = savedRobot({
      id: 'incompatible-copy',
      name: 'Histórica incompatible',
      version: 7,
    });
    const getRobot = vi.fn().mockImplementation(async (id: string) => {
      if (id === active.id) return active;
      throw new SavedRobotApiFailure('server', 'La configuración guardada no es compatible.', 500);
    });
    const deleteRobot = vi.fn().mockResolvedValue({ deleted: true });
    const savedApi = api({
      listRobots: vi
        .fn()
        .mockResolvedValue({ robots: [robotSummary(active), robotSummary(incompatible)] }),
      getRobot,
      deleteRobot,
    });
    const editorRef = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Activa.*Cargar/ }));
    await waitFor(() =>
      expect(document.querySelector('.saved-robots-selected')?.textContent).toContain('Activa'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Ver configuración de Histórica incompatible' }),
    );
    expect(await screen.findByText('La configuración guardada no es compatible.')).toBeTruthy();
    expect(getRobot).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Eliminar Histórica incompatible' }));
    expect(deleteRobot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar Histórica incompatible' }));
    await waitFor(() =>
      expect(deleteRobot).toHaveBeenCalledWith(incompatible.id, incompatible.version),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(editorRef.current?.applyDraft).toHaveBeenCalledOnce();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(document.querySelector('.saved-robots-selected')?.textContent).toContain('Activa');
    confirm.mockRestore();
  });

  it('reconfirms a refreshed row version without applying remote content or changing another selection', async () => {
    const active = savedRobot({ id: 'active-copy', name: 'Activa' });
    const target = savedRobot({ id: 'delete-copy', name: 'Para borrar', version: 1 });
    const remoteSummary = {
      ...robotSummary(target),
      version: 2,
      updatedAt: '2026-10-14T12:00:00.000Z',
    };
    const deleteRobot = vi
      .fn()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('conflict', 'stale', 409, undefined, false, {
          currentSummary: remoteSummary,
        }),
      )
      .mockResolvedValueOnce({ deleted: true });
    const savedApi = api({
      listRobots: vi
        .fn()
        .mockResolvedValue({ robots: [robotSummary(active), robotSummary(target)] }),
      getRobot: vi.fn().mockResolvedValue(active),
      deleteRobot,
    });
    const editorRef = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Activa.*Cargar/ }));
    await waitFor(() =>
      expect(document.querySelector('.saved-robots-selected')?.textContent).toContain('Activa'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar Para borrar' }));
    await screen.findByRole('button', { name: 'Actualizar versión para Eliminar' });
    expect(deleteRobot).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Actualizar versión para Eliminar' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar Para borrar' }));
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(2));
    expect(deleteRobot.mock.calls).toEqual([
      [target.id, 1],
      [target.id, 2],
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(editorRef.current?.applyDraft).toHaveBeenCalledOnce();
    expect(document.querySelector('.saved-robots-selected')?.textContent).toContain('Activa');
    confirm.mockRestore();
  });

  it('does not pair a summary-only delete conflict version with the selected draft for Guardar', async () => {
    const selected = savedRobot({ version: 1 });
    const remoteSummary = { ...robotSummary(selected), version: 2 };
    const deleteRobot = vi.fn().mockRejectedValue(
      new SavedRobotApiFailure('conflict', 'stale', 409, undefined, false, {
        currentSummary: remoteSummary,
      }),
    );
    const saveRobot = vi.fn().mockRejectedValue(new SavedRobotApiFailure('conflict', 'stale', 409));
    const editorRef = editor({ ...createDefaultDraft(), instructions: 'Edición local posterior.' });
    const savedApi = api({ deleteRobot, saveRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() =>
      expect(document.querySelector('.saved-robots-selected')?.textContent).toContain('Explorador'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actualizar versión para Eliminar' }),
    );
    expect(editorRef.current?.applyDraft).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /^Guardar$/ }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    expect(saveRobot.mock.calls[0]?.[1]).toBe(1);
    expect(screen.getByText('stale')).toBeTruthy();
    expect(screen.queryByText(/Guardaste/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cargar versión remota' })).toBeNull();
    expect(editorRef.current?.applyDraft).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it('uses the refreshed management version for a selected delete', async () => {
    const target = savedRobot({ version: 1 });
    const remoteSummary = { ...robotSummary(target), version: 2 };
    const deleteRobot = vi
      .fn()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('conflict', 'stale', 409, undefined, false, {
          currentSummary: remoteSummary,
        }),
      )
      .mockResolvedValueOnce({ deleted: true });
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot: vi.fn().mockResolvedValue(target),
      deleteRobot,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(screen.getByText('Seleccionado:')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await screen.findByRole('button', { name: 'Actualizar versión para Eliminar' });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' }));

    await waitFor(() => expect(screen.getByText(/Confirmá «Eliminar» nuevamente/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(screen.getByText(/Eliminaste «Explorador»/)).toBeTruthy());
    expect(deleteRobot.mock.calls).toEqual([
      [target.id, 1],
      [target.id, 2],
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('discards an inspection response after the user closes its pending preview', async () => {
    const pending = deferred<SavedRobot>();
    const savedApi = api({ getRobot: vi.fn().mockReturnValue(pending.promise) });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ver configuración de Explorador' }));
    await screen.findByText('Consultando la copia…');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await act(async () =>
      pending.resolve(
        savedRobot({ draft: { ...createDefaultDraft(), instructions: 'Respuesta tardía.' } }),
      ),
    );

    await waitFor(() => expect(screen.queryByText('Consultando la copia…')).toBeNull());
    expect(screen.queryByText('Respuesta tardía.')).toBeNull();
  });

  it('releases only a closed inspection and keeps a newer load busy after its late finalizer', async () => {
    const inspection = deferred<SavedRobot>();
    const selection = deferred<SavedRobot>();
    const getRobot = vi
      .fn()
      .mockReturnValueOnce(inspection.promise)
      .mockReturnValueOnce(selection.promise);
    const savedApi = api({ getRobot });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    const inspect = await screen.findByRole('button', { name: 'Ver configuración de Explorador' });
    fireEvent.click(inspect);
    await screen.findByText('Consultando la copia…');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Tus robots' }).getAttribute('aria-busy')).toBe(
        'false',
      ),
    );
    expect(document.activeElement).toBe(inspect);

    fireEvent.click(screen.getByRole('button', { name: /Explorador.*Cargar/ }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('region', { name: 'Tus robots' }).getAttribute('aria-busy')).toBe(
      'true',
    );

    await act(async () => {
      inspection.resolve(
        savedRobot({ draft: { ...createDefaultDraft(), instructions: 'Respuesta tardía.' } }),
      );
    });
    expect(screen.queryByText('Respuesta tardía.')).toBeNull();
    expect(screen.getByRole('region', { name: 'Tus robots' }).getAttribute('aria-busy')).toBe(
      'true',
    );

    await act(async () => {
      selection.resolve(savedRobot());
    });
    await waitFor(() => expect(screen.getByText('Seleccionado:')).toBeTruthy());
  });

  it('clears an inspection response when the signed-in identity changes', async () => {
    const pending = deferred<SavedRobot>();
    const savedApi = api({ getRobot: vi.fn().mockReturnValue(pending.promise) });
    const editorRef = editor();
    const renderIdentity = (currentSession: AuthSession) => (
      <SavedRobots
        key={currentSession.identity.sub}
        api={savedApi}
        editor={editorRef}
        session={currentSession}
      />
    );
    const view = render(renderIdentity(session('subject-a')));

    fireEvent.click(await screen.findByRole('button', { name: 'Ver configuración de Explorador' }));
    await screen.findByText('Consultando la copia…');
    view.rerender(renderIdentity(session('subject-b')));
    await act(async () =>
      pending.resolve(
        savedRobot({ draft: { ...createDefaultDraft(), instructions: 'Otra identidad.' } }),
      ),
    );

    expect(screen.queryByText('Otra identidad.')).toBeNull();
  });

  it('keeps row actions disabled while paused or locked and forwards preview auth context', async () => {
    const onAuthRequired = vi.fn();
    const failedApi = api({
      getRobot: vi.fn().mockRejectedValue(
        new SavedRobotApiFailure('authentication', 'Volvé a ingresar.', 401, undefined, false, {
          authContext: 42,
        }),
      ),
    });
    const lockedView = render(
      <SavedRobots api={failedApi} editor={editor()} session={session()} locked />,
    );
    const inspect = await screen.findByRole('button', { name: 'Ver configuración de Explorador' });
    const remove = screen.getByRole('button', { name: 'Eliminar Explorador' });
    expect((inspect as HTMLButtonElement).disabled).toBe(true);
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    lockedView.unmount();

    render(
      <SavedRobots
        api={failedApi}
        editor={editor()}
        session={session()}
        configurationAvailable={false}
        onAuthRequired={onAuthRequired}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ver configuración de Explorador' }));
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledWith(42));
    expect(screen.getByText('Volvé a ingresar.')).toBeTruthy();
  });
});
