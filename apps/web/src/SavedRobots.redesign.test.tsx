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

function session(sub = 'subject-a'): AuthSession {
  return {
    identity: { sub, email: `${sub}@example.test` },
    user: new User({
      access_token: `token-${sub}`,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client-public',
        iat: 1,
        exp: 9_999_999_999,
        sub,
        email: `${sub}@example.test`,
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

function editor(snapshot: RobotDraft = createDefaultDraft()) {
  return {
    current: {
      captureSnapshot: vi.fn().mockResolvedValue({ version: 4, draft: snapshot }),
      applyDraft: vi.fn().mockResolvedValue(true),
      hasUnconfirmedChanges: vi.fn().mockReturnValue(false),
      discardPending: vi.fn(),
      flushPending: vi.fn().mockResolvedValue(true),
      waitForConfirmed: vi.fn().mockResolvedValue(true),
      releaseAttemptLock: vi.fn(),
    },
  } as unknown as React.RefObject<RobotEditorHandle | null>;
}

function captureSnapshotMock(editorRef: React.RefObject<RobotEditorHandle | null>) {
  return editorRef.current!.captureSnapshot as unknown as ReturnType<typeof vi.fn>;
}

function api(overrides: Partial<SavedRobotApi> = {}): SavedRobotApi {
  const robot = savedRobot();
  return {
    listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(robot)], nextCursor: undefined }),
    getRobot: vi.fn().mockResolvedValue(robot),
    saveRobot: vi.fn().mockImplementation(async (id, version, name, draft) =>
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

async function chooseCopy(name: string, waitForRead = true): Promise<HTMLInputElement> {
  const radio = await screen.findByRole('radio', { name: new RegExp(name, 'u') });
  fireEvent.click(radio);
  if (waitForRead) {
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Mis robots/u }).getAttribute('aria-busy')).toBe(
        'false',
      ),
    );
  }
  return radio as HTMLInputElement;
}

function selectedCopyRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Copia seleccionada' });
}

function openMoreActions(): void {
  const summary = screen.getByText('Más acciones');
  if (!(summary.closest('details') as HTMLDetailsElement | null)?.open) {
    fireEvent.click(summary);
  }
}

function replaceButton(): HTMLElement {
  return screen.getByRole('button', { name: /Reemplazar con mi robot actual/u });
}

describe('SavedRobots redesign acceptance', () => {
  it('selects consultatively, preserves literal preview values, and ignores a late A response after B', async () => {
    const base = createDefaultDraft();
    const firstDraft: RobotDraft = {
      ...base,
      instructions: 'Primera línea 🧭\nSegunda línea — literal.',
      skills: base.skills.map((skill) => {
        if (skill.id === 'advance') return { id: skill.id, enabled: skill.enabled };
        if (skill.id === 'retreat') return { ...skill, description: '' };
        return skill;
      }),
    };
    const first = savedRobot({ id: 'copy-a', name: 'Primero', draft: firstDraft });
    const second = savedRobot({
      id: 'copy-b',
      name: 'Segundo',
      draft: { ...firstDraft, instructions: 'Segunda copia; no confundir con A.' },
    });
    const firstRead = deferred<SavedRobot>();
    const secondRead = deferred<SavedRobot>();
    const savedApi = api({
      listRobots: vi
        .fn()
        .mockResolvedValue({ robots: [robotSummary(first), robotSummary(second)] }),
      getRobot: vi
        .fn<SavedRobotApi['getRobot']>()
        .mockImplementation((id) => (id === first.id ? firstRead.promise : secondRead.promise)),
    });
    const editorRef = editor();
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    expect(screen.getByRole('heading', { name: 'Mis robots' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Robots guardados' })).toBeTruthy();
    const firstRadio = await chooseCopy('Primero', false);
    expect(firstRadio.checked).toBe(true);
    await chooseCopy('Segundo', false);
    await waitFor(() => expect(savedApi.getRobot).toHaveBeenCalledTimes(2));
    await act(async () => {
      secondRead.resolve(second);
      await Promise.resolve();
    });
    const panel = selectedCopyRegion();
    expect(await within(panel).findByText(second.draft.instructions)).toBeTruthy();
    expect(
      within(panel).queryByText(firstDraft.instructions, { normalizer: (text) => text }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Guardar robot actual' })).toBeTruthy();
    expect(screen.queryByLabelText('Nombre de esta copia')).toBeNull();
    const previewText = panel.textContent ?? '';
    expect(previewText).toMatch(/sin descripción|sin definir|no tiene descripción/iu);
    expect(previewText).toMatch(/descripción vacía|descripción: vacía/iu);

    await act(async () => {
      firstRead.resolve(first);
      await Promise.resolve();
    });
    expect(within(selectedCopyRegion()).getByText(second.draft.instructions)).toBeTruthy();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
  });

  it('requires an explicit named confirmation to use a consulted copy and returns only after D2 succeeds', async () => {
    const robot = savedRobot({
      draft: { ...createDefaultDraft(), instructions: 'Literal consultado.' },
    });
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(robot)] }),
      getRobot: vi.fn().mockResolvedValue(robot),
    });
    const editorRef = editor();
    const application = deferred<boolean>();
    editorRef.current!.applyDraft = vi.fn().mockReturnValue(application.promise);
    const onReturnToEditor = vi.fn();
    render(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        onReturnToEditor={onReturnToEditor}
      />,
    );

    await chooseCopy(robot.name);
    const panel = selectedCopyRegion();
    expect(within(panel).getByText(robot.draft.instructions)).toBeTruthy();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(onReturnToEditor).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole('button', { name: 'Usar este robot' }));
    const firstDialog = await screen.findByRole('dialog', { name: /Usar.*Explorador/u });
    expect(firstDialog.textContent).toContain(robot.name);
    expect(firstDialog.textContent).toMatch(/reemplaz/u);
    expect(firstDialog.textContent).toMatch(
      /robot actual|instrucciones actuales|habilidades actuales/u,
    );
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(onReturnToEditor).not.toHaveBeenCalled();

    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: 'Usar este robot' }));
    const confirmDialog = await screen.findByRole('dialog', { name: /Usar.*Explorador/u });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Usar este robot' }));
    await waitFor(() => expect(editorRef.current?.applyDraft).toHaveBeenCalledOnce());
    expect(editorRef.current?.applyDraft).toHaveBeenCalledWith(
      robot.draft,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onReturnToEditor).not.toHaveBeenCalled();
    await act(async () => {
      application.resolve(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(onReturnToEditor).toHaveBeenCalledOnce());
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
  });

  it('renames with the exact selected snapshot, including multiline Unicode and absent versus empty fields', async () => {
    const base = createDefaultDraft();
    const oldCopyDraft: RobotDraft = {
      ...base,
      instructions: 'Copia antigua:\ncon Unicode Ω 🤖 y espacios exactos.',
      skills: base.skills.map((skill) => {
        if (skill.id === 'advance') return { id: skill.id, enabled: skill.enabled };
        if (skill.id === 'retreat') return { ...skill, description: '' };
        return skill;
      }),
    };
    const target = savedRobot({ id: 'rename-target', version: 7, draft: oldCopyDraft });
    const editorDraft = { ...base, instructions: 'Borrador distinto del editor.' };
    const editorRef = editor(editorDraft);
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockImplementation(async (id, version, name, draft) =>
        savedRobot({ ...target, id, version: version + 1, name, draft }),
      );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot: vi.fn().mockResolvedValue(target),
      saveRobot,
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Explorador/u });
    const nextName = `${'A'.repeat(79)}🤖`;
    expect([...nextName]).toHaveLength(80);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: nextName },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));

    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());
    expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
      target.id,
      target.version,
      nextName,
      oldCopyDraft,
    ]);
    const writtenDraft = saveRobot.mock.calls[0]?.[3];
    expect(writtenDraft?.instructions).toBe(oldCopyDraft.instructions);
    expect(
      Object.hasOwn(
        writtenDraft!.skills.find((skill) => skill.id === 'advance')!,
        'description',
      ),
    ).toBe(false);
    expect(writtenDraft!.skills.find((skill) => skill.id === 'retreat')?.description).toBe('');
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorDraft.instructions).not.toBe(writtenDraft?.instructions);
  });

  it('captures only after confirmation, restores focus on cancel or Escape, and freezes the snapshot for one PUT', async () => {
    const target = savedRobot({
      id: 'replace-target',
      name: 'Mi explorador',
      version: 5,
      draft: { ...createDefaultDraft(), instructions: 'Copia antes de reemplazar.' },
    });
    const firstSnapshot: RobotDraft = {
      ...createDefaultDraft(),
      instructions: 'Snapshot confirmado.',
    };
    const laterSnapshot: RobotDraft = {
      ...createDefaultDraft(),
      instructions: 'Edición posterior.',
    };
    const editorRef = editor(firstSnapshot);
    const captureSnapshot = captureSnapshotMock(editorRef);
    const pendingWrite = deferred<SavedRobot>();
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockReturnValue(pendingWrite.promise);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot: vi.fn().mockResolvedValue(target),
      saveRobot,
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(target.name);
    expect(within(selectedCopyRegion()).getByText(target.draft.instructions)).toBeTruthy();
    openMoreActions();
    fireEvent.click(replaceButton());
    const cancelDialog = await screen.findByRole('dialog', { name: /Reemplazar.*Mi explorador/u });
    expect(cancelDialog.textContent).toContain(target.name);
    expect(cancelDialog.textContent).toMatch(
      /configuración actual|instrucciones.*habilidades|robot actual/u,
    );
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
    fireEvent.click(within(cancelDialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByText('Más acciones', { selector: 'summary' }));
    expect(captureSnapshot).not.toHaveBeenCalled();

    openMoreActions();
    fireEvent.click(replaceButton());
    const escapeDialog = await screen.findByRole('dialog', { name: /Reemplazar.*Mi explorador/u });
    fireEvent(escapeDialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByText('Más acciones', { selector: 'summary' }));
    expect(captureSnapshot).not.toHaveBeenCalled();

    openMoreActions();
    fireEvent.click(replaceButton());
    const confirmDialog = await screen.findByRole('dialog', {
      name: /Reemplazar.*Mi explorador/u,
    });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Reemplazar copia' }));
    await waitFor(() => expect(captureSnapshot).toHaveBeenCalledOnce());
    await waitFor(() => expect(savedApi.saveRobot).toHaveBeenCalledOnce());
    expect(within(selectedCopyRegion()).getByText(target.draft.instructions)).toBeTruthy();
    expect(within(selectedCopyRegion()).queryByText(firstSnapshot.instructions)).toBeNull();
    expect(screen.queryByText(/Reemplazaste «Mi explorador»/u)).toBeNull();
    captureSnapshot.mockResolvedValue({ version: 6, draft: laterSnapshot });

    expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
      target.id,
      target.version,
      target.name,
      firstSnapshot,
    ]);
    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();

    await act(async () => {
      pendingWrite.resolve(
        savedRobot({ ...target, version: target.version + 1, draft: firstSnapshot }),
      );
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(within(selectedCopyRegion()).getByText(firstSnapshot.instructions)).toBeTruthy(),
    );
    expect(within(selectedCopyRegion()).queryByText(target.draft.instructions)).toBeNull();
  });

  it('reconciles an uncertain replacement before another write, keeping the same ID, version, and payload', async () => {
    const target = savedRobot({ id: 'uncertain-target', version: 3 });
    const frozenDraft = { ...createDefaultDraft(), instructions: 'No volver a capturar.' };
    const nextEditorDraft = { ...createDefaultDraft(), instructions: 'Cambio posterior.' };
    const editorRef = editor(frozenDraft);
    const captureSnapshot = captureSnapshotMock(editorRef);
    const retryRead = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockResolvedValueOnce(target)
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se pudo leer.', undefined, undefined, false),
      )
      .mockReturnValueOnce(retryRead.promise);
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'Respuesta incierta.', undefined, undefined, true),
      )
      .mockResolvedValueOnce(
        savedRobot({ ...target, version: target.version + 1, draft: frozenDraft }),
      );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot,
      saveRobot,
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(replaceButton());
    const firstDialog = await screen.findByRole('dialog', { name: /Reemplazar.*Explorador/u });
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Reemplazar copia' }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: /Reemplazar.*Explorador/u })).toBeTruthy();

    captureSnapshot.mockResolvedValue({ version: 9, draft: nextEditorDraft });
    const retryDialog = screen.getByRole('dialog', { name: /Reemplazar.*Explorador/u });
    fireEvent.click(within(retryDialog).getByRole('button', { name: 'Reemplazar copia' }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(3));
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      retryRead.resolve(target);
      await Promise.resolve();
    });
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      [target.id, target.version, target.name, frozenDraft],
      [target.id, target.version, target.name, frozenDraft],
    ]);
  });

  it.each(['matching-409', 'ambiguous-readback'] as const)(
    'confirms an already committed replacement from %s without another PUT',
    async (outcome) => {
      const target = savedRobot({
        id: `already-committed-${outcome}`,
        version: 6,
        draft: { ...createDefaultDraft(), instructions: 'Copia antes del cambio.' },
      });
      const candidate = { ...createDefaultDraft(), instructions: 'Reemplazo ya confirmado Ω.' };
      const committed = savedRobot({
        ...target,
        version: target.version + 1,
        name: target.name,
        draft: candidate,
      });
      const getRobot = vi.fn<SavedRobotApi['getRobot']>().mockResolvedValueOnce(target);
      const saveRobot = vi.fn<SavedRobotApi['saveRobot']>();
      if (outcome === 'matching-409') {
        saveRobot.mockRejectedValueOnce(
          new SavedRobotApiFailure('conflict', 'Ya quedó guardado.', 409, committed),
        );
      } else {
        getRobot.mockResolvedValueOnce(committed);
        saveRobot.mockRejectedValueOnce(
          new SavedRobotApiFailure('network', 'Respuesta incierta.', undefined, undefined, true),
        );
      }
      const editorRef = editor(candidate);
      const captureSnapshot = captureSnapshotMock(editorRef);
      const savedApi = api({
        listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
        getRobot,
        saveRobot,
      });
      render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

      await chooseCopy(target.name);
      openMoreActions();
      fireEvent.click(replaceButton());
      const dialog = await screen.findByRole('dialog', { name: /Reemplazar.*Explorador/u });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reemplazar copia' }));

      await waitFor(() =>
        expect(within(selectedCopyRegion()).getByText(candidate.instructions)).toBeTruthy(),
      );
      expect(saveRobot).toHaveBeenCalledOnce();
      expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
        target.id,
        target.version,
        target.name,
        candidate,
      ]);
      expect(getRobot).toHaveBeenCalledTimes(outcome === 'matching-409' ? 1 : 2);
      expect(captureSnapshot).toHaveBeenCalledOnce();
      expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    },
  );

  it('keeps an uncertain rename name and saved-copy draft frozen through a failed read and retry', async () => {
    const target = savedRobot({
      id: 'rename-uncertain',
      version: 8,
      draft: { ...createDefaultDraft(), instructions: 'Copia original multilinea:\nΩ 🤖.' },
    });
    const editorRef = editor({ ...createDefaultDraft(), instructions: 'Editor no relacionado.' });
    const captureSnapshot = captureSnapshotMock(editorRef);
    const retryRead = deferred<SavedRobot>();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockResolvedValueOnce(target)
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'No se pudo leer.', undefined, undefined, false),
      )
      .mockReturnValueOnce(retryRead.promise);
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'Respuesta incierta.', undefined, undefined, true),
      )
      .mockResolvedValueOnce(
        savedRobot({ ...target, version: target.version + 1, name: 'Nombre congelado' }),
      );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot,
      saveRobot,
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Explorador/u });
    const nameInput = within(dialog).getByRole('textbox', { name: 'Nombre' });
    fireEvent.change(nameInput, { target: { value: 'Nombre congelado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Nombre posterior' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(getRobot).toHaveBeenCalledTimes(3));
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(captureSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      retryRead.resolve(target);
      await Promise.resolve();
    });
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      [target.id, target.version, 'Nombre congelado', target.draft],
      [target.id, target.version, 'Nombre congelado', target.draft],
    ]);
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
  });

  it('requires comparison and renewed confirmation after a version conflict without applying remote content', async () => {
    const target = savedRobot({ id: 'conflict-target', version: 1 });
    const remote = savedRobot({
      ...target,
      name: 'Explorador remoto',
      version: 2,
      draft: { ...createDefaultDraft(), instructions: 'Versión remota para comparar.' },
    });
    const editorRef = editor({
      ...createDefaultDraft(),
      instructions: 'Conservar mi robot actual.',
    });
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('conflict', 'Cambió en otra pestaña.', 409, remote),
      )
      .mockImplementationOnce(async (id, version, name, draft) =>
        savedRobot({ ...remote, id, version: version + 1, name, draft }),
      );
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot: vi.fn().mockResolvedValue(target),
      saveRobot,
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(replaceButton());
    const firstDialog = await screen.findByRole('dialog', { name: /Reemplazar.*Explorador/u });
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Reemplazar copia' }));
    await screen.findByText('Cambió en otra pestaña.');
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(within(selectedCopyRegion()).getByText(remote.draft.instructions)).toBeTruthy();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();

    const conflictDialog = screen.queryByRole('dialog');
    if (conflictDialog) {
      fireEvent.click(within(conflictDialog).getByRole('button', { name: 'Cancelar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    openMoreActions();
    fireEvent.click(replaceButton());
    const confirmedAgain = await screen.findByRole('dialog', {
      name: /Reemplazar.*Explorador remoto/u,
    });
    expect(saveRobot).toHaveBeenCalledOnce();
    fireEvent.click(within(confirmedAgain).getByRole('button', { name: 'Reemplazar copia' }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledTimes(2));
    expect(saveRobot.mock.calls[1]?.slice(0, 4)).toEqual([
      target.id,
      remote.version,
      remote.name,
      expect.any(Object),
    ]);
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
  });

  it('keeps an over-limit historical copy literal and prevents an invalid name-only PUT', async () => {
    const historical = savedRobot({
      draft: { ...createDefaultDraft(), instructions: 'Literal histórico 🧭 '.repeat(70) },
    });
    const editorRef = editor();
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(historical)] }),
      getRobot: vi.fn().mockResolvedValue(historical),
    });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(historical.name);
    const panel = selectedCopyRegion();
    expect(
      within(panel).getByText(historical.draft.instructions, { normalizer: (text) => text }),
    ).toBeTruthy();
    expect(
      within(panel).getByText(/supera los límites actuales|no se puede usar.*límite/u),
    ).toBeTruthy();
    openMoreActions();
    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Explorador/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Nombre nuevo' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() =>
      expect(
        within(selectedCopyRegion()).getByText(historical.draft.instructions, {
          normalizer: (text) => text,
        }),
      ).toBeTruthy(),
    );
    expect(screen.getAllByText(/1.?000 caracteres/u).length).toBeGreaterThan(0);
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
  });

  it('forwards the current auth context when consulting a copy is rejected', async () => {
    const authError = new SavedRobotApiFailure(
      'authentication',
      'Volvé a ingresar.',
      401,
      undefined,
      false,
      { authContext: 42 },
    );
    const onAuthRequired = vi.fn();
    const editorRef = editor();
    const savedApi = api({
      getRobot: vi.fn().mockRejectedValue(authError),
    });
    render(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );

    await chooseCopy('Explorador');
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledWith(42));
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(savedApi.saveRobot).not.toHaveBeenCalled();
  });

  it('forwards auth context after an uncertain rename read without repeating the PUT', async () => {
    const target = savedRobot({ id: 'auth-rename', version: 4 });
    const authError = new SavedRobotApiFailure(
      'authentication',
      'Volvé a ingresar.',
      401,
      undefined,
      false,
      { authContext: 17 },
    );
    const onAuthRequired = vi.fn();
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockResolvedValueOnce(target)
      .mockRejectedValueOnce(authError);
    const saveRobot = vi
      .fn<SavedRobotApi['saveRobot']>()
      .mockRejectedValueOnce(
        new SavedRobotApiFailure('network', 'Respuesta incierta.', undefined, undefined, true),
      );
    const editorRef = editor({ ...createDefaultDraft(), instructions: 'No capturar.' });
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot,
      saveRobot,
    });
    render(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        onAuthRequired={onAuthRequired}
      />,
    );

    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Explorador/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Renombrado' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));

    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledWith(17));
    expect(saveRobot).toHaveBeenCalledOnce();
    expect(getRobot).toHaveBeenCalledTimes(2);
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
  });

  it('deletes a selected row by its listed ID/version even when its full copy cannot be read', async () => {
    const incompatible = savedRobot({
      id: 'listed-only-copy',
      name: 'Histórica incompatible',
      version: 6,
    });
    const getRobot = vi
      .fn()
      .mockRejectedValue(
        new SavedRobotApiFailure('incompatible', 'No se pudo leer el contenido de esta copia.'),
      );
    const deleteRobot = vi.fn().mockResolvedValue({ deleted: true });
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(incompatible)] }),
      getRobot,
      deleteRobot,
    });
    const editorRef = editor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(incompatible.name);
    await screen.findByText('No se pudo leer el contenido de esta copia.');
    openMoreActions();
    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: /Eliminar copia/u }));

    await waitFor(() =>
      expect(deleteRobot.mock.calls[0]?.slice(0, 2)).toEqual([
        incompatible.id,
        incompatible.version,
      ]),
    );
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(incompatible.name));
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
  });

  it('does not let a sent write response from the old identity replace a newer selection', async () => {
    const first = savedRobot({ id: 'identity-a', name: 'Robot A' });
    const second = savedRobot({
      id: 'identity-b',
      name: 'Robot B',
      draft: { ...createDefaultDraft(), instructions: 'Contenido de B.' },
    });
    const pendingWrite = deferred<SavedRobot>();
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockReturnValue(pendingWrite.promise);
    const savedApi = api({
      listRobots: vi
        .fn()
        .mockResolvedValueOnce({ robots: [robotSummary(first)] })
        .mockResolvedValueOnce({ robots: [robotSummary(second)] }),
      getRobot: vi
        .fn()
        .mockImplementation(async (id: string) => (id === first.id ? first : second)),
      saveRobot,
    });
    const editorRef = editor({ ...createDefaultDraft(), instructions: 'Borrador editor.' });
    const renderIdentity = (currentSession: AuthSession) => (
      <SavedRobots
        key={currentSession.identity.sub}
        api={savedApi}
        editor={editorRef}
        session={currentSession}
      />
    );
    const view = render(renderIdentity(session('subject-a')));

    await chooseCopy(first.name);
    openMoreActions();
    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Robot A/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Robot A renombrado' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());

    view.rerender(renderIdentity(session('subject-b')));
    await chooseCopy(second.name);
    expect(within(selectedCopyRegion()).getByText(second.draft.instructions)).toBeTruthy();
    await act(async () => {
      pendingWrite.resolve(
        savedRobot({ ...first, version: first.version + 1, name: 'Robot A renombrado' }),
      );
      await Promise.resolve();
    });

    expect(within(selectedCopyRegion()).getByText(second.draft.instructions)).toBeTruthy();
    expect(screen.queryByText(/Guardaste «Robot A renombrado»/u)).toBeNull();
    expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
      first.id,
      first.version,
      'Robot A renombrado',
      first.draft,
    ]);
  });

  it('does not send a delayed A snapshot after identity changes to B', async () => {
    const first = savedRobot({
      id: 'capture-identity-a',
      name: 'Robot A',
      draft: { ...createDefaultDraft(), instructions: 'A guardado.' },
    });
    const second = savedRobot({
      id: 'capture-identity-b',
      name: 'Robot B',
      draft: { ...createDefaultDraft(), instructions: 'B guardado y visible.' },
    });
    const pendingCapture = deferred<{ version: number; draft: RobotDraft }>();
    const delayedSnapshot = { ...createDefaultDraft(), instructions: 'Snapshot A tardío.' };
    const editorRef = editor(delayedSnapshot);
    const captureSnapshot = captureSnapshotMock(editorRef);
    captureSnapshot.mockReturnValue(pendingCapture.promise);
    const listRobots = vi
      .fn()
      .mockResolvedValueOnce({ robots: [robotSummary(first)] })
      .mockResolvedValueOnce({ robots: [robotSummary(second)] });
    const getRobot = vi
      .fn<SavedRobotApi['getRobot']>()
      .mockImplementation(async (id: string) => (id === first.id ? first : second));
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>();
    const savedApi = api({ listRobots, getRobot, saveRobot });
    const view = render(
      <SavedRobots api={savedApi} editor={editorRef} session={session('subject-a')} />,
    );

    await chooseCopy(first.name);
    openMoreActions();
    fireEvent.click(replaceButton());
    const dialog = await screen.findByRole('dialog', { name: /Reemplazar.*Robot A/u });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reemplazar copia' }));
    await waitFor(() => expect(captureSnapshot).toHaveBeenCalledOnce());
    expect(saveRobot).not.toHaveBeenCalled();

    view.rerender(<SavedRobots api={savedApi} editor={editorRef} session={session('subject-b')} />);
    await chooseCopy(second.name);
    expect(within(selectedCopyRegion()).getByText(second.draft.instructions)).toBeTruthy();
    await act(async () => {
      pendingCapture.resolve({ version: 9, draft: delayedSnapshot });
      await Promise.resolve();
    });

    expect(saveRobot).not.toHaveBeenCalled();
    expect(listRobots).toHaveBeenCalledTimes(2);
    expect(getRobot).toHaveBeenCalledTimes(2);
    expect(within(selectedCopyRegion()).getByText(second.draft.instructions)).toBeTruthy();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
  });

  it('keeps a same-identity B selection after an in-flight rename of A resolves late', async () => {
    const first = savedRobot({ id: 'same-user-a', name: 'Robot A' });
    const second = savedRobot({
      id: 'same-user-b',
      name: 'Robot B',
      draft: { ...createDefaultDraft(), instructions: 'B conserva esta configuración.' },
    });
    const pendingWrite = deferred<SavedRobot>();
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockReturnValue(pendingWrite.promise);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({
        robots: [robotSummary(first), robotSummary(second)],
      }),
      getRobot: vi
        .fn()
        .mockImplementation(async (id: string) => (id === first.id ? first : second)),
      saveRobot,
    });
    const editorRef = editor({ ...createDefaultDraft(), instructions: 'Editor sin cambios.' });
    render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(first.name);
    openMoreActions();
    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Robot A/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Robot A renombrado' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());

    const pendingDialog = screen.queryByRole('dialog', { name: /Renombrar.*Robot A/u });
    if (pendingDialog) {
      fireEvent(pendingDialog, new Event('cancel', { bubbles: false, cancelable: true }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    const secondRadio = screen.getByRole('radio', { name: /Robot B/u }) as HTMLInputElement;
    expect(secondRadio.disabled).toBe(false);
    fireEvent.click(secondRadio);
    await waitFor(() => expect(savedApi.getRobot).toHaveBeenCalledTimes(2));
    expect(within(selectedCopyRegion()).getByText(second.draft.instructions)).toBeTruthy();

    await act(async () => {
      pendingWrite.resolve(
        savedRobot({ ...first, version: first.version + 1, name: 'Robot A renombrado' }),
      );
      await Promise.resolve();
    });
    expect(within(selectedCopyRegion()).getByText(second.draft.instructions)).toBeTruthy();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
    expect(captureSnapshotMock(editorRef)).not.toHaveBeenCalled();
    expect(saveRobot.mock.calls[0]?.slice(0, 4)).toEqual([
      first.id,
      first.version,
      'Robot A renombrado',
      first.draft,
    ]);
  });

  it('ignores an in-flight rename response after the library is paused', async () => {
    const target = savedRobot({ id: 'paused-rename', version: 2 });
    const pendingWrite = deferred<SavedRobot>();
    const saveRobot = vi.fn<SavedRobotApi['saveRobot']>().mockReturnValue(pendingWrite.promise);
    const savedApi = api({
      listRobots: vi.fn().mockResolvedValue({ robots: [robotSummary(target)] }),
      getRobot: vi.fn().mockResolvedValue(target),
      saveRobot,
    });
    const editorRef = editor({
      ...createDefaultDraft(),
      instructions: 'Editor permanece intacto.',
    });
    const view = render(<SavedRobots api={savedApi} editor={editorRef} session={session()} />);

    await chooseCopy(target.name);
    openMoreActions();
    fireEvent.click(within(selectedCopyRegion()).getByRole('button', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: /Renombrar.*Explorador/u });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre' }), {
      target: { value: 'Nombre suspendido' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(saveRobot).toHaveBeenCalledOnce());

    view.rerender(
      <SavedRobots
        api={savedApi}
        editor={editorRef}
        session={session()}
        paused
        accessState="required"
      />,
    );
    expect(screen.getByText(/El acceso a tu cuenta fue rechazado/)).toBeTruthy();
    await act(async () => {
      pendingWrite.resolve(
        savedRobot({ ...target, version: target.version + 1, name: 'Nombre suspendido' }),
      );
      await Promise.resolve();
    });

    expect(screen.queryByText(/Guardaste «Nombre suspendido»/u)).toBeNull();
    expect(editorRef.current?.captureSnapshot).not.toHaveBeenCalled();
    expect(editorRef.current?.applyDraft).not.toHaveBeenCalled();
  });
});
