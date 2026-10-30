// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { SavedRobots } from './SavedRobots.js';
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
