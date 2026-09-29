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

function editor(
  snapshot: RobotDraft = createDefaultDraft(),
): React.RefObject<RobotEditorHandle | null> {
  return {
    current: {
      captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: snapshot }),
      applyDraft: vi.fn().mockResolvedValue(true),
      hasUnconfirmedChanges: vi.fn().mockReturnValue(false),
      discardPending: vi.fn(),
      flushPending: vi.fn().mockResolvedValue(true),
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

    expect(await screen.findByRole('button', { name: /Explorador/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Explorador.*Cargar/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Explorador/ }));
    await waitFor(() =>
      expect(editorRef.current?.applyDraft).toHaveBeenCalledWith(createDefaultDraft()),
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
    const savedApi = api({ listRobots });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    expect(await screen.findAllByRole('button', { name: /Mismo nombre.*Cargar/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Mismo nombre.*Cargar/ })).toHaveLength(2),
    );
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
    fireEvent.click(await screen.findByRole('button', { name: /Explorador/ }));
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
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar como nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Persistente' },
    });
    const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText(/misma copia/)).toBeTruthy();
    expect(saveRobot).toHaveBeenCalledTimes(1);
    const firstId = saveRobot.mock.calls[0]?.[0];

    fireEvent.submit(form);
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot).toHaveBeenCalledTimes(1);
    expect(getRobot.mock.calls[1]?.[0]).toBe(firstId);
    expect(screen.getByText('Guardaste «Persistente» como robot nuevo.')).toBeTruthy();
    expect(editorRef.current?.captureSnapshot).toHaveBeenCalledTimes(1);
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
    fireEvent.click(await screen.findByRole('button', { name: /Explorador/ }));
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
    fireEvent.click(await screen.findByRole('button', { name: /Explorador/ }));
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
    fireEvent.click(await screen.findByRole('button', { name: /Explorador/ }));
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

  it('deletes a selected copy without changing the editor draft', async () => {
    const editorRef = editor();
    const savedApi = api();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Explorador/ }));
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
});
