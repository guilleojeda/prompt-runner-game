// @vitest-environment jsdom

import { useEffect, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptApi, AttemptSummary } from './attempt-api.js';
import { HistoryList } from './AttemptActivityViews.js';
import { useAttemptHistory } from './useAttemptHistory.js';
import type { RobotEditorHandle } from './RobotEditor.js';

const terminal: AttemptSummary = {
  id: 'history-inspector-return-action',
  createdAt: '2026-10-27T12:00:00.000Z',
  updatedAt: '2026-10-27T12:00:01.000Z',
  status: 'defeat',
  cancelRequested: false,
  levelId: 'principal',
  modelKey: 'claude-sonnet-4.6',
  modelLabel: 'Claude Sonnet 4.6',
  modelId: 'global.anthropic.claude-sonnet-4-6',
  turnsUsed: 8,
  maxTurns: 24,
  calls: 8,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  gameTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  score: null,
  collectedObjectIds: [],
  objectPoints: 0,
  progress: 0.4,
  finalSupport: 1,
  animationEnabled: false,
  presentationComplete: true,
  recordComplete: true,
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  cleanup();
});

function HistoryInspectorHarness({
  api,
  removeRowOnClose = false,
}: {
  api: AttemptApi;
  removeRowOnClose?: boolean;
}) {
  const [omitRows, setOmitRows] = useState(false);
  const currentAttempt = useRef<AttemptSummary | null>(null);
  const editor = useRef<RobotEditorHandle | null>(null);
  const activityBusy = useRef(false);
  const history = useAttemptHistory({
    api,
    identity: 'history-inspector-test',
    currentAttempt,
    historyVisible: true,
    surface: 'historial',
    editor,
    configurationAvailable: true,
    authPaused: false,
    activityBusy,
  });

  const { loadBootstrapPage } = history;
  useEffect(() => {
    const controller = new AbortController();
    void loadBootstrapPage(controller.signal, () => true);
    return () => controller.abort();
  }, [loadBootstrapPage]);

  const inspecting = history.decisionInspectorTarget !== null;
  const configurationOpen = history.configurationState !== null;
  return (
    <>
      <div hidden={inspecting || configurationOpen}>
        <HistoryList
          attempts={omitRows ? [] : history.history}
          view={history.historyView}
          nextCursor={history.historyCursor}
          error={history.historyError}
          loading={history.loadingHistory}
          recovering={history.historyRecovering}
          recoveryMessage={history.historyRecoveryMessage}
          invalidCursor={history.invalidHistoryCursor}
          busy={false}
          onOpen={() => undefined}
          onReplay={() => undefined}
          onInspect={(id, selection) => history.openDecisionInspectorFromHistory(id, selection)}
          onConfiguration={(attempt) =>
            void history.openConfiguration(attempt.id, true, {
              source: 'history',
              createdAt: attempt.createdAt,
            })
          }
          configurationBusyId={null}
          onMore={() => undefined}
          onUpdate={history.updateHistory}
          onSelectView={history.selectHistoryView}
        />
      </div>
      {inspecting && (
        <section aria-labelledby="inspector-test-title">
          <h2 id="inspector-test-title">Inspeccionar decisiones</h2>
          <button
            type="button"
            onClick={() => {
              if (removeRowOnClose) setOmitRows(true);
              history.clearDecisionInspector();
            }}
          >
            Cerrar inspección
          </button>
        </section>
      )}
      {configurationOpen && (
        <section aria-labelledby="configuration-test-title">
          <h2 id="configuration-test-title">Configuración consultada</h2>
          <button type="button" onClick={history.closeConfiguration}>
            Cerrar configuración
          </button>
        </section>
      )}
    </>
  );
}

function testApi(listAttempts = vi.fn().mockResolvedValue({ attempts: [terminal] })): AttemptApi {
  return {
    listAttempts,
    getConfiguration: vi.fn().mockResolvedValue({
      attemptId: terminal.id,
      draft: {},
    }),
  } as unknown as AttemptApi;
}

async function openInspectorAction(name: string): Promise<HTMLButtonElement> {
  const historyHeading = await screen.findByRole('heading', { name: 'Historial' });
  const section = historyHeading.closest('section');
  expect(section).not.toBeNull();
  const history = section as HTMLElement;
  const row = await within(history).findByRole('listitem');
  const disclosure = within(row).getByText('Más acciones', { selector: 'summary' });
  fireEvent.click(disclosure);
  const action = within(row).getByRole('button', { name }) as HTMLButtonElement;
  action.focus();
  fireEvent.click(action);
  expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
  return action;
}

describe('History navigation implementation', () => {
  it.each([
    ['Inspeccionar decisiones', 'Inspeccionar decisiones'],
    ['Ir a la última acción', 'Ir a la última acción'],
  ])(
    'returns focus to the %s action that opened the inspector',
    async (actionName, expectedFocus) => {
      const api = testApi();
      render(<HistoryInspectorHarness api={api} />);
      await openInspectorAction(actionName);
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));

      const historyHeading = screen.getByRole('heading', { name: 'Historial' });
      const history = historyHeading.closest('section') as HTMLElement;
      const returnedAction = within(history).getByRole('button', { name: expectedFocus });
      await waitFor(() => expect(document.activeElement).toBe(returnedAction));
      expect(api.listAttempts).toHaveBeenCalledOnce();
    },
  );

  it('focuses the visible history heading when the origin row disappears, without rereading', async () => {
    const api = testApi();
    render(<HistoryInspectorHarness api={api} removeRowOnClose />);
    await openInspectorAction('Ir a la última acción');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));

    const historyHeading = screen.getByRole('heading', { name: 'Historial' });
    await waitFor(() => expect(document.activeElement).toBe(historyHeading));
    expect(api.listAttempts).toHaveBeenCalledOnce();
    expect(
      within(historyHeading.closest('section') as HTMLElement).queryByRole('listitem'),
    ).toBeNull();
  });

  it('keeps the returned control inside a shorter viewport when restoring its row anchor', async () => {
    const api = testApi();
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const originalScrollBy = Object.getOwnPropertyDescriptor(window, 'scrollBy');
    const scrollElement = document.scrollingElement ?? document.documentElement;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(scrollElement, 'scrollHeight');
    let scrollY = 734;
    let viewportHeight = 900;
    const scrollBy = vi.fn((_left: number, top: number) => {
      scrollY += top;
    });
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => scrollY,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => viewportHeight,
    });
    Object.defineProperty(window, 'scrollBy', { configurable: true, value: scrollBy });
    Object.defineProperty(scrollElement, 'scrollHeight', {
      configurable: true,
      get: () => 2_600,
    });

    const restoreProperty = (
      target: object,
      name: string,
      descriptor: PropertyDescriptor | undefined,
    ) => {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    };

    try {
      render(<HistoryInspectorHarness api={api} />);
      const historyHeading = await screen.findByRole('heading', { name: 'Historial' });
      const history = historyHeading.closest('section') as HTMLElement;
      const row = await within(history).findByRole('listitem');
      const moreActions = within(row).getByText('Más acciones', { selector: 'summary' });
      fireEvent.click(moreActions);
      const configuration = within(row).getByRole('button', { name: 'Ver configuración' });
      // Controlled DOM coordinates exercise the shrink clamp; browser geometry is verified separately.
      Object.defineProperty(row, 'getBoundingClientRect', {
        configurable: true,
        value: () => controlledRect(1_513 - scrollY, 403),
      });
      Object.defineProperty(configuration, 'getBoundingClientRect', {
        configurable: true,
        value: () => controlledRect(1_859 - scrollY, 44),
      });
      configuration.focus();
      fireEvent.click(configuration);
      expect(await screen.findByRole('heading', { name: 'Configuración consultada' })).toBeTruthy();

      viewportHeight = 480;
      scrollY = 1_181;
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar configuración' }));

      const returned = within(history).getByRole('button', { name: 'Ver configuración' });
      await waitFor(() => expect(document.activeElement).toBe(returned));
      const restoredRect = returned.getBoundingClientRect();
      expect(restoredRect.top).toBeGreaterThanOrEqual(8);
      expect(restoredRect.bottom).toBeLessThanOrEqual(viewportHeight - 8);
      expect(scrollBy).toHaveBeenCalledOnce();
      expect(scrollBy).toHaveBeenCalledWith(0, 250);
      expect(api.listAttempts).toHaveBeenCalledOnce();
      expect(api.getConfiguration).toHaveBeenCalledOnce();
    } finally {
      restoreProperty(window, 'scrollY', originalScrollY);
      restoreProperty(window, 'innerHeight', originalInnerHeight);
      restoreProperty(window, 'scrollBy', originalScrollBy);
      restoreProperty(scrollElement, 'scrollHeight', originalScrollHeight);
    }
  });
});

function controlledRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 390,
    bottom: top + height,
    width: 390,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}
