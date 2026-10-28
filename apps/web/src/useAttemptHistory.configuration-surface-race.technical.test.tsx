// @vitest-environment jsdom

import { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import type { AttemptApi } from './attempt-api.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { useAttemptHistory, type AttemptHistoryController } from './useAttemptHistory.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForCommit(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 25));
}

describe('useAttemptHistory surface-change application race', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores a deferred successful application from the previous surface', async () => {
    const application = deferred<boolean>();
    const currentAttempt = { current: null };
    const editor = {
      current: {
        applyDraft: vi.fn(() => application.promise),
        cancelApplication: vi.fn(),
      } as unknown as RobotEditorHandle,
    };
    const api = {
      getConfiguration: vi.fn(async (id: string) => ({
        attemptId: id,
        draft: createDefaultDraft(),
      })),
    } as unknown as AttemptApi;
    const trace: string[] = [];
    const latest = { current: null as AttemptHistoryController | null };
    let returnedToEditor = 0;
    let applicationCompleted = false;

    const currentHistory = (): AttemptHistoryController => {
      if (latest.current === null) throw new Error('The history hook did not render.');
      return latest.current;
    };

    function Harness({ surface }: { readonly surface: 'historial' | 'preparar' }) {
      const history = useAttemptHistory({
        api,
        identity: 'owner',
        currentAttempt,
        historyVisible: true,
        surface,
        editor,
        configurationAvailable: true,
        authPaused: false,
        activityBusy: { current: false },
        onReturnToEditor: () => {
          returnedToEditor += 1;
          trace.push('return');
        },
      });

      useLayoutEffect(() => {
        latest.current = history;
        if (surface === 'preparar' && !applicationCompleted) {
          applicationCompleted = true;
          trace.push('new-surface-layout');
          application.resolve(true);
          queueMicrotask(() => {
            trace.push(
              `after-layout-microtask:return=${returnedToEditor}:status=${latest.current?.configurationState?.status}`,
            );
          });
        }
      });

      return null;
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      root.render(<Harness surface="historial" />);
      await waitForCommit();

      await currentHistory().openConfiguration('attempt-probe');
      await waitForCommit();
      currentHistory().requestConfigurationConfirmation();
      await waitForCommit();
      const confirmationId = currentHistory().configurationConfirmation?.id;
      if (confirmationId === undefined) throw new Error('The confirmation did not open.');
      currentHistory().confirmConfiguration(confirmationId);
      await waitForCommit();

      root.render(<Harness surface="preparar" />);
      await waitForCommit();

      expect(trace).toContain('new-surface-layout');
      expect(returnedToEditor).toBe(0);
    } finally {
      root.unmount();
      container.remove();
      await waitForCommit();
    }
  });
});
