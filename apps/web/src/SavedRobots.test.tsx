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
import type { AuthSession } from '../../../apps/web/src/auth.js';
import type { RobotEditorHandle } from '../../../apps/web/src/RobotEditor.js';
import { SavedRobots } from '../../../apps/web/src/SavedRobots.js';
import { SavedRobotApiFailure, type SavedRobotApi } from '../../../apps/web/src/saved-robot-api.js';
import { installHtmlDialogTestShim } from '../../../apps/web/src/configuration-confirmation.test-support.js';

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

type ApplyCandidate = RobotDraft | ((signal?: AbortSignal) => Promise<RobotDraft>);
type ApplyOptions = { signal?: AbortSignal };
type ApplyDraftMock = (candidate: ApplyCandidate, options?: ApplyOptions) => Promise<boolean>;

interface PendingApplication {
  readonly draft: RobotDraft;
  readonly signal?: AbortSignal;
  readonly resolve: (applied: boolean) => void;
}

function editor(
  snapshot: RobotDraft = createDefaultDraft(),
): React.RefObject<RobotEditorHandle | null> {
  const ref = {
    current: {
      captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: snapshot }),
      applyDraft: vi.fn<ApplyDraftMock>().mockImplementation(async (candidate, options) => {
        if (typeof candidate === 'function') await candidate(options?.signal);
        return true;
      }),
      hasUnconfirmedChanges: vi.fn().mockReturnValue(false),
      discardPending: vi.fn(),
      flushPending: vi.fn().mockResolvedValue(true),
      waitForConfirmed: vi.fn().mockResolvedValue(true),
      releaseAttemptLock: vi.fn(),
    },
  };
  return ref as unknown as React.RefObject<RobotEditorHandle | null>;
}

function applicationEditor(snapshot: RobotDraft = createDefaultDraft()) {
  const pendingApplications: PendingApplication[] = [];
  const applyDraft = vi.fn<ApplyDraftMock>().mockImplementation(async (candidate, options) => {
    const draft = typeof candidate === 'function' ? await candidate(options?.signal) : candidate;
    return await new Promise<boolean>((resolve) => {
      pendingApplications.push({ draft, signal: options?.signal, resolve });
    });
  });
  const editorRef = {
    current: {
      captureSnapshot: vi.fn().mockResolvedValue({ version: 1, draft: snapshot }),
      applyDraft,
      hasUnconfirmedChanges: vi.fn().mockReturnValue(false),
      discardPending: vi.fn(),
      flushPending: vi.fn().mockResolvedValue(true),
      waitForConfirmed: vi.fn().mockResolvedValue(true),
      releaseAttemptLock: vi.fn(),
    },
  } as unknown as React.RefObject<RobotEditorHandle | null>;
  return { editorRef, applyDraft, pendingApplications };
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

let restoreDialogShim: (() => void) | undefined;

beforeAll(() => {
  restoreDialogShim = installHtmlDialogTestShim();
});

afterAll(() => restoreDialogShim?.());

async function chooseCopy(matcher: RegExp): Promise<HTMLElement> {
  const radio = await screen.findByRole('radio', { name: matcher });
  fireEvent.click(radio);
  await waitFor(() =>
    expect(screen.getByRole('region', { name: /Mis robots/u }).getAttribute('aria-busy')).toBe(
      'false',
    ),
  );
  return radio;
}

function selectedCopyPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

async function applySelectedCopy(): Promise<void> {
  const panel = selectedCopyPanel();
  fireEvent.click(within(panel).getByRole('button', { name: 'Usar este robot' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Usar este robot' }));
}

async function useCopy(matcher: RegExp): Promise<HTMLElement> {
  const radio = await chooseCopy(matcher);
  await applySelectedCopy();
  return radio;
}

function openMoreActions(): void {
  const summary = screen.getByText('Más acciones');
  if (!(summary.closest('details') as HTMLDetailsElement | null)?.open) {
    fireEvent.click(summary);
  }
}

function deleteSelectedCopy(): void {
  openMoreActions();
  fireEvent.click(screen.getByRole('button', { name: /Eliminar copia/u }));
}

afterEach(() => cleanup());

describe('SavedRobots', () => {
  it('uses a copy only after confirmation, then creates a named copy from the editor snapshot', async () => {
    const editorRef = editor();
    const savedApi = api();
    const saveRobot = vi.spyOn(savedApi, 'saveRobot');
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await useCopy(/Explorador/u);
    await waitFor(() =>
      expect(editorRef.current?.applyDraft).toHaveBeenCalledWith(
        savedRobot().draft,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.getByRole('region', { name: 'Copia seleccionada' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Nombre para la nueva copia'));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Defensa' },
    });
    fireEvent.submit(screen.getByLabelText('Nombre para la nueva copia').closest('form')!);
    await waitFor(() =>
      expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
        expect.any(String),
        0,
        'Defensa',
        createDefaultDraft(),
      ]),
    );
    expect(await screen.findByText('Guardaste «Defensa» como robot nuevo.')).toBeTruthy();
  });

  it('replaces a pending copy application when another copy is chosen', async () => {
    const first = savedRobot({
      id: 'robot-first',
      name: 'Primero',
      draft: { ...createDefaultDraft(), instructions: 'Primera copia.' },
    });
    const second = savedRobot({
      id: 'robot-second',
      name: 'Segunda',
      draft: { ...createDefaultDraft(), instructions: 'Segunda copia.' },
    });
    const firstLoad = deferred<SavedRobot>();
    const secondLoad = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockImplementation((id) => (id === first.id ? firstLoad.promise : secondLoad.promise));
    const savedApi = api({
      listRobots: vi
        .fn()
        .mockResolvedValue({ robots: [robotSummary(first), robotSummary(second)] }),
      getRobot,
    });
    const { editorRef, applyDraft, pendingApplications } = applicationEditor();
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    const firstButton = await screen.findByRole('radio', { name: /Primero/u });
    const secondButton = await screen.findByRole('radio', { name: /Segunda/u });
    firstButton.focus();
    fireEvent.click(firstButton);
    await waitFor(() => expect(getRobot).toHaveBeenCalledOnce());
    await act(async () => {
      firstLoad.resolve(first);
      await Promise.resolve();
    });
    await applySelectedCopy();

    expect(applyDraft).toHaveBeenCalledWith(
      first.draft,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const firstSignal = applyDraft.mock.calls[0]?.[1]?.signal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect((secondButton as HTMLButtonElement).disabled).toBe(false);

    secondButton.focus();
    fireEvent.click(secondButton);
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      secondLoad.resolve(second);
      await Promise.resolve();
    });
    await applySelectedCopy();
    await waitFor(() =>
      expect(
        pendingApplications.some(
          (application) => application.draft.instructions === 'Segunda copia.',
        ),
      ).toBe(true),
    );
    await act(async () => {
      pendingApplications
        .find((application) => application.draft.instructions === 'Segunda copia.')!
        .resolve(true);
      await Promise.resolve();
    });
    expect(await screen.findByText('Cargaste «Segunda».')).toBeTruthy();
    expect(selectedCopyPanel().textContent).toContain('Segunda');
    const activeAfterSecondApplication = document.activeElement;

    await act(async () => {
      pendingApplications
        .find((application) => application.draft.instructions === 'Primera copia.')!
        .resolve(true);
      await Promise.resolve();
    });
    expect(screen.queryByText('Cargaste «Primero».')).toBeNull();
    expect(selectedCopyPanel().textContent).toContain('Segunda');
    expect(document.activeElement).toBe(activeAfterSecondApplication);
  });

  it.each(['pause', 'unmount'] as const)(
    'cancels a pending saved-copy application on %s and ignores its late result',
    async (abandonment) => {
      const robot = savedRobot({
        id: `robot-${abandonment}`,
        name: 'Copia pausada',
        draft: { ...createDefaultDraft(), instructions: 'No aplicar después de abandonar.' },
      });
      const load = deferred<SavedRobot>();
      const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockReturnValue(load.promise);
      const savedApi = api({
        listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(robot)] }),
        getRobot,
      });
      const { editorRef, applyDraft, pendingApplications } = applicationEditor();
      const view = render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

      await chooseCopy(/Copia pausada/u);
      await waitFor(() => expect(getRobot).toHaveBeenCalledOnce());
      await act(async () => {
        load.resolve(robot);
        await Promise.resolve();
      });
      await applySelectedCopy();
      expect(applyDraft).toHaveBeenCalledWith(
        robot.draft,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const signal = applyDraft.mock.calls[0]?.[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);

      if (abandonment === 'pause') {
        view.rerender(
          <SavedRobots
            api={savedApi}
            editor={editorRef}
            session={session()}
            paused
            accessState="required"
          />,
        );
      } else {
        view.unmount();
      }
      expect(signal?.aborted).toBe(true);

      await waitFor(() => expect(pendingApplications).toHaveLength(1));
      await act(async () => {
        pendingApplications[0]!.resolve(true);
        await Promise.resolve();
      });

      if (abandonment === 'pause') {
        expect(screen.queryByText(`Cargaste «${robot.name}».`)).toBeNull();
        const selected = screen.getByRole('region', { name: 'Copia seleccionada' });
        expect(
          within(selected)
            .getByRole('button', { name: 'Usar este robot' })
            .hasAttribute('disabled'),
        ).toBe(true);
        expect(
          screen.getByRole('button', { name: 'Guardar robot actual' }).hasAttribute('disabled'),
        ).toBe(true);
      }
    },
  );

  it('keeps the editor unchanged and reports auth when a copy load is rejected', async () => {
    const onAuthRequired = vi.fn();
    const savedApi = api({
      getRobot: vi
        .fn()
        .mockRejectedValue(new SavedRobotApiFailure('authentication', 'Volvé a ingresar.', 401)),
    });
    const editorRef = editor();
    editorRef.current!.applyDraft = vi
      .fn<ApplyDraftMock>()
      .mockImplementation(async (candidate, options) => {
        try {
          if (typeof candidate === 'function') await candidate(options?.signal);
          return true;
        } catch (error) {
          if (error instanceof SavedRobotApiFailure && error.code === 'authentication') {
            onAuthRequired(error.authContext);
          }
          throw error;
        }
      });
    render(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );

    await chooseCopy(/Explorador/u);
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledOnce());
    expect(screen.getByText('Volvé a ingresar.')).toBeTruthy();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(screen.queryByText('Cargaste «Explorador».')).toBeNull();
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

    const create = await screen.findByRole('button', { name: 'Guardar robot actual' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
  });

  it('exposes one create control and preserves the entered name while the form is open', async () => {
    const savedApi = api({ listRobots: vi.fn().mockResolvedValue({ robots: [] }) });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    const create = await screen.findByRole('button', { name: 'Guardar robot actual' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    expect(screen.getAllByRole('button', { name: 'Guardar una copia' })).toHaveLength(1);

    const input = screen.getByLabelText('Nombre para la nueva copia');
    fireEvent.change(input, { target: { value: 'Defensa' } });
    expect((input as HTMLInputElement).value).toBe('Defensa');

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    expect(screen.getAllByRole('button', { name: 'Guardar una copia' })).toHaveLength(1);
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

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
    const input = screen.getByLabelText('Nombre para la nueva copia');
    fireEvent.change(input, { target: { value: unicodeName } });
    expect((input as HTMLInputElement).value).toBe(unicodeName);
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
        expect.any(String),
        0,
        unicodeName,
        createDefaultDraft(),
      ]),
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
    const getRobot = vi
      .fn()
      .mockImplementation(async (id: string) => savedRobot({ id, name: 'Mismo nombre' }));
    const savedApi = api({ listRobots, getRobot });
    render(<SavedRobots api={savedApi} editor={editor()} session={session()} />);

    expect(await screen.findAllByRole('radio', { name: /Mismo nombre/u })).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /^Mismo nombre Copia 1$/u })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Mismo nombre Copia 2$/u })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() =>
      expect(screen.getAllByRole('radio', { name: /Mismo nombre/u })).toHaveLength(3),
    );
    expect(screen.getByRole('radio', { name: /^Mismo nombre Copia 3$/u })).toBeTruthy();
    for (const [index, expectedId] of ['robot-a', 'robot-b', 'robot-c'].entries()) {
      fireEvent.click(screen.getAllByRole('radio', { name: /Mismo nombre/u })[index]!);
      await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(index + 1));
      expect(getRobot.mock.calls[index]?.[0]).toBe(expectedId);
    }
    expect(listRobots).toHaveBeenLastCalledWith('next');
  });

  it('renames the selected copy while preserving its stored draft instead of capturing the editor', async () => {
    const changed = { ...createDefaultDraft(), instructions: 'Preferí esperar.' };
    const editorRef = editor(changed);
    const saveRobot = vi
      .fn()
      .mockResolvedValue(savedRobot({ version: 2, name: 'Explorador mejorado', draft: changed }));
    const savedApi = api({ saveRobot });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    await chooseCopy(/Explorador/u);
    expect(saveRobot).not.toHaveBeenCalled();
    openMoreActions();
    fireEvent.click(within(selectedCopyPanel()).getByRole('button', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Explorador/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Explorador mejorado' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() =>
      expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
        'robot-a',
        1,
        'Explorador mejorado',
        savedRobot().draft,
      ]),
    );
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
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

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
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
      (screen.getByRole('button', { name: 'Guardar una copia' }) as HTMLButtonElement).disabled,
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

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
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

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
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

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
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

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar robot actual' }));
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
    await chooseCopy(/Explorador/u);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Copia seleccionada' })).toBeTruthy(),
    );
    deleteSelectedCopy();
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByText('Volvé a ingresar.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar lista' })).toBeNull();
    confirm.mockRestore();
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
      .mockRejectedValueOnce(new SavedRobotApiFailure('not_found', 'No existe.', 404))
      .mockImplementationOnce(async () =>
        savedRobot({
          id: pendingId ?? 'pending-copy',
          name: 'Copia incierta',
          draft: initialDraft,
        }),
      );
    const deleteRobot = vi.fn().mockResolvedValue({ deleted: true });
    const savedApi = api({ listRobots, saveRobot, getRobot, deleteRobot });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await screen.findByRole('button', { name: 'Guardar robot actual' });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Guardar robot actual' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
    fireEvent.change(screen.getByLabelText('Nombre para la nueva copia'), {
      target: { value: 'Copia incierta' },
    });
    const form = screen.getByLabelText('Nombre para la nueva copia').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/misma copia/)).toBeTruthy());
    expect(pendingId).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await chooseCopy(/Copia incierta/u);
    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([pendingId, 1]));
    expect(screen.queryByText(/misma copia/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar robot actual' }));
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
    const deleteRobot = vi.spyOn(savedApi, 'deleteRobot');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    await chooseCopy(/Explorador/u);
    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual(['robot-a', 1]));
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('radio', { name: /Explorador/u })).toBeNull());
    const selected = screen.getByRole('region', { name: 'Copia seleccionada' });
    expect(within(selected).getByRole('heading', { name: 'Elegí una copia' })).toBeTruthy();
    expect(
      within(selected).queryByText(savedRobot().draft.instructions, {
        normalizer: (text) => text,
      }),
    ).toBeNull();
    confirm.mockRestore();
  });

  it('does not delete when confirmation is cancelled', async () => {
    const editorRef = editor();
    const savedApi = api();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);
    await chooseCopy(/Explorador/u);
    deleteSelectedCopy();
    expect(savedApi.deleteRobot).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Copia seleccionada' })).toBeTruthy();
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
    await chooseCopy(/Explorador/u);
    deleteSelectedCopy();
    await waitFor(() => expect(screen.queryByRole('radio', { name: /Explorador/u })).toBeNull());
    const selected = screen.getByRole('region', { name: 'Copia seleccionada' });
    expect(within(selected).getByRole('heading', { name: 'Elegí una copia' })).toBeTruthy();
    expect(
      within(selected).queryByText(savedRobot().draft.instructions, {
        normalizer: (text) => text,
      }),
    ).toBeNull();
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

    await chooseCopy(/Explorador/u);
    deleteSelectedCopy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' })).toBeTruthy(),
    );
    expect(screen.getAllByText(/confirmá «Eliminar» nuevamente/)).toHaveLength(1);
    expect(screen.queryByText(/«Guardar» está bloqueado/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' }));
    await waitFor(() =>
      expect(screen.getByText(/cambió.*Confirmá «Eliminar» nuevamente/)).toBeTruthy(),
    );
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();

    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot).toHaveBeenLastCalledWith('robot-a', 2));
    expect(deleteRobot).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(screen.getByText(/Eliminaste «Explorador»/)).toBeTruthy();
    confirm.mockRestore();
  });

  it('consults the full historical copy without requiring editor availability', async () => {
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

    const trigger = await chooseCopy(/Explorador/u);

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
    expect(document.activeElement).toBe(trigger);
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows an oversized readable copy on selection without applying it or writing', async () => {
    const historical = savedRobot({
      draft: { ...createDefaultDraft(), instructions: 'x'.repeat(1_190) },
    });
    const editorRef = editor();
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(historical)] }),
      getRobot: vi.fn().mockResolvedValue(historical),
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(/Explorador/u);

    await waitFor(() =>
      expect(
        [...document.querySelectorAll('.configuration-preview-copy p')].some(
          (paragraph) => paragraph.textContent === historical.draft.instructions,
        ),
      ).toBe(true),
    );
    expect(selectedCopyPanel().textContent).toContain('supera los límites actuales');
    expect(selectedCopyPanel().textContent).toMatch(/1.?000 caracteres/u);
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
  });

  it('keeps an incompatible row deletable by its listed ID/version after its read fails', async () => {
    const incompatible = savedRobot({
      id: 'incompatible-copy',
      name: 'Histórica incompatible',
      version: 7,
    });
    const getRobot = vi.fn().mockImplementation(async () => {
      throw new SavedRobotApiFailure('server', 'La configuración guardada no es compatible.', 500);
    });
    const deleteRobot = vi.fn().mockResolvedValue({ deleted: true });
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(incompatible)] }),
      getRobot,
      deleteRobot,
    });
    const editorRef = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(/Histórica incompatible/u);
    expect(await screen.findByText('La configuración guardada no es compatible.')).toBeTruthy();
    expect(getRobot).toHaveBeenCalledOnce();

    deleteSelectedCopy();
    expect(deleteRobot).not.toHaveBeenCalled();
    deleteSelectedCopy();
    await waitFor(() =>
      expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([
        incompatible.id,
        incompatible.version,
      ]),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('reconfirms a refreshed selected-copy version without applying its remote content', async () => {
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
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot: vi.fn().mockResolvedValue(target),
      deleteRobot,
    });
    const editorRef = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(/Para borrar/u);
    deleteSelectedCopy();
    await screen.findByRole('button', { name: 'Actualizar versión para Eliminar' });
    expect(deleteRobot).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Actualizar versión para Eliminar' })).toBeNull(),
    );
    deleteSelectedCopy();
    await waitFor(() => expect(deleteRobot).toHaveBeenCalledTimes(2));
    expect(deleteRobot.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [target.id, 1],
      [target.id, 2],
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('does not turn a summary-only delete conflict into an editor write', async () => {
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

    await chooseCopy(/Explorador/u);
    await waitFor(() => expect(selectedCopyPanel()).toBeTruthy());
    deleteSelectedCopy();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actualizar versión para Eliminar' }),
    );
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(saveRobot).not.toHaveBeenCalled();
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

    await chooseCopy(/Explorador/u);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Copia seleccionada' })).toBeTruthy(),
    );
    deleteSelectedCopy();
    await screen.findByRole('button', { name: 'Actualizar versión para Eliminar' });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar versión para Eliminar' }));

    await waitFor(() => expect(screen.getByText(/Confirmá «Eliminar» nuevamente/)).toBeTruthy());
    deleteSelectedCopy();
    await waitFor(() => expect(screen.getByText(/Eliminaste «Explorador»/)).toBeTruthy());
    expect(deleteRobot.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [target.id, 1],
      [target.id, 2],
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('does not show a late copy response from the previous identity', async () => {
    const pending = deferred<SavedRobot>();
    const first = savedRobot({
      draft: { ...createDefaultDraft(), instructions: 'Respuesta vieja.' },
    });
    const second = savedRobot({
      draft: { ...createDefaultDraft(), instructions: 'Otra identidad.' },
    });
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(second);
    const savedApi = api({ getRobot });
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

    await chooseCopy(/Explorador/u);
    view.rerender(renderIdentity(session('subject-b')));
    await chooseCopy(/Explorador/u);
    expect(within(selectedCopyPanel()).getByText(second.draft.instructions)).toBeTruthy();
    await act(async () => pending.resolve(first));

    expect(within(selectedCopyPanel()).getByText(second.draft.instructions)).toBeTruthy();
    expect(within(selectedCopyPanel()).queryByText(first.draft.instructions)).toBeNull();
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
    const lockedCopy = await screen.findByRole('radio', { name: /Explorador/u });
    expect((lockedCopy as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Guardar robot actual' }) as HTMLButtonElement).disabled,
    ).toBe(true);
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
    await chooseCopy(/Explorador/u);
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledWith(42));
    expect(screen.getByText('Volvé a ingresar.')).toBeTruthy();
  });
});
