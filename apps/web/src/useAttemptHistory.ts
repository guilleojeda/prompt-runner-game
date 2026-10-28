import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ApiAuthRequired } from './api-auth.js';
import {
  AttemptApiFailure,
  type AttemptApi,
  type AttemptConfiguration,
  type AttemptSummary,
  type AttemptsPage,
} from './attempt-api.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import type { ResultSource } from './attempt-display.js';

export interface AttemptDisplayContext {
  readonly source: ResultSource;
  readonly createdAt: string;
}

export type DecisionInitialSelection = 'first' | 'last-action-or-decision' | 'last-decision';
export type HistoryView = 'recent' | 'best';

interface HistoryReturnOrigin {
  readonly attemptId: string;
  readonly action: string;
  readonly view: HistoryView;
  readonly rowTop: number | null;
}

export interface AttemptConfigurationState {
  readonly targetId: string;
  readonly displayContext?: AttemptDisplayContext;
  readonly status: 'loading' | 'ready' | 'applying' | 'error';
  readonly configuration?: AttemptConfiguration;
  readonly message?: string;
  readonly applied?: boolean;
}

export type ActivityTargetHandler = (
  target: AttemptSummary,
  signal: AbortSignal,
) => boolean | Promise<boolean>;

export type AttemptResultQueryState =
  | {
      readonly targetId: string;
      readonly status: 'loading';
      readonly contextAttempt?: AttemptSummary;
    }
  | { readonly targetId: string; readonly status: 'ready'; readonly attempt: AttemptSummary }
  | {
      readonly targetId: string;
      readonly status: 'error';
      readonly message: string;
      readonly contextAttempt?: AttemptSummary;
    };

function isTerminal(status: AttemptSummary['status']): boolean {
  return status !== 'pending' && status !== 'running';
}

function preferFreshSummary(
  incoming: AttemptSummary,
  existing: AttemptSummary | undefined,
  currentAttempt: AttemptSummary | null,
): AttemptSummary {
  let freshest = incoming;
  for (const known of [existing, currentAttempt]) {
    if (!known || known.id !== incoming.id) continue;
    const knownIsTerminal = isTerminal(known.status);
    const freshestIsTerminal = isTerminal(freshest.status);
    if (knownIsTerminal !== freshestIsTerminal) {
      if (knownIsTerminal) freshest = known;
      continue;
    }
    if (known.updatedAt > freshest.updatedAt) freshest = known;
  }
  return freshest;
}

function mergePage(
  current: readonly AttemptSummary[],
  incoming: readonly AttemptSummary[],
  currentAttempt: AttemptSummary | null,
  append: boolean,
): readonly AttemptSummary[] {
  const known = new Map(current.map((item) => [item.id, item]));
  const merged = append ? [...current] : [];
  const positions = new Map(merged.map((item, index) => [item.id, index]));
  for (const item of incoming) {
    const position = positions.get(item.id);
    const previous = position === undefined ? known.get(item.id) : merged[position];
    const next = preferFreshSummary(item, previous, currentAttempt);
    if (position === undefined) {
      positions.set(item.id, merged.length);
      merged.push(next);
    } else {
      merged[position] = next;
    }
  }
  return merged;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'No se pudo consultar el historial de intentos.';
}

function notifyAuthenticationFailure(error: unknown, onAuthRequired?: ApiAuthRequired): void {
  if (error instanceof AttemptApiFailure && error.code === 'authentication') {
    onAuthRequired?.(error.authContext);
  }
}

export interface AttemptHistoryController {
  readonly history: readonly AttemptSummary[];
  readonly historyView: HistoryView;
  readonly historyCursor: string | undefined;
  readonly historyError: string | null;
  readonly loadingHistory: boolean;
  readonly resultQuery: AttemptResultQueryState | null;
  readonly configurationState: AttemptConfigurationState | null;
  readonly decisionInspectorTarget: AttemptSummary | null;
  readonly decisionInspectorSelection: DecisionInitialSelection;
  readonly decisionInspectorOpenVersion: number;
  readonly queryVisible: boolean;
  selectHistoryView(view: HistoryView): void;
  rememberHistoryOrigin(attemptId: string, action: string): void;
  restoreHistoryOrigin(): void;
  forgetHistoryOrigin(): void;
  loadBootstrapPage(signal: AbortSignal, isCurrent: () => boolean): Promise<void>;
  refreshHistory(): Promise<void>;
  loadMore(): Promise<void>;
  retryHistory(): void;
  updateSummaryById(summary: AttemptSummary): void;
  openConfiguration(
    id: string,
    rememberTrigger?: boolean,
    displayContext?: AttemptDisplayContext,
  ): Promise<void>;
  applyConfiguration(): Promise<void>;
  retryConfiguration(): void;
  closeConfiguration(): void;
  clearConfiguration(): void;
  openDecisionInspector(target: AttemptSummary, selection?: DecisionInitialSelection): void;
  openDecisionInspectorFromHistory(id: string, selection?: DecisionInitialSelection): void;
  clearDecisionInspector(restoreFocus?: boolean): void;
  handleDecisionInspectorAuthRequired(authContext?: number): boolean;
  openResult(
    id: string,
    handleActivityTarget: ActivityTargetHandler,
    rememberOrigin?: boolean,
    contextAttempt?: AttemptSummary,
  ): Promise<void>;
  retryResult(): void;
  closeResult(): void;
  handoffResultToActivity(attemptId: string): void;
}

interface UseAttemptHistoryOptions {
  readonly api: AttemptApi;
  readonly identity: string;
  readonly currentAttempt: { readonly current: AttemptSummary | null };
  readonly active: boolean;
  readonly surface: 'preparar' | 'historial' | 'mis-robots';
  readonly editor: RefObject<RobotEditorHandle | null>;
  readonly configurationAvailable: boolean;
  readonly authPaused: boolean;
  readonly activityBusy: { readonly current: boolean };
  readonly onAuthRequired?: ApiAuthRequired;
  readonly onReturnToEditor?: () => void;
}

export function useAttemptHistory({
  api,
  identity,
  currentAttempt,
  active,
  surface,
  editor,
  configurationAvailable,
  authPaused,
  activityBusy,
  onAuthRequired,
  onReturnToEditor,
}: UseAttemptHistoryOptions): AttemptHistoryController {
  const [history, setHistory] = useState<readonly AttemptSummary[]>([]);
  const [historyView, setHistoryView] = useState<HistoryView>('recent');
  const [historyReturnRevision, setHistoryReturnRevision] = useState(0);
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingBootstrap, setLoadingBootstrap] = useState(false);
  const [resultQuery, setResultQuery] = useState<AttemptResultQueryState | null>(null);
  const visibleGenerationRef = useRef(0);
  const bootstrapGenerationRef = useRef(0);
  const visibleControllerRef = useRef<AbortController | null>(null);
  const identityRef = useRef(identity);
  const resultQueryOperationRef = useRef(0);
  const resultQueryControllerRef = useRef<AbortController | null>(null);
  const historyOriginRef = useRef<HistoryReturnOrigin | null>(null);
  const pendingHistoryReturnRef = useRef(false);
  const pendingResultQueryFocusRef = useRef(false);
  const activityTargetHandlerRef = useRef<ActivityTargetHandler | null>(null);
  const authPausedRef = useRef(authPaused);
  const configurationOperationRef = useRef(0);
  const configurationControllerRef = useRef<AbortController | null>(null);
  const configurationApplicationIdRef = useRef(0);
  const configurationApplicationRef = useRef<{
    readonly id: number;
    readonly operation: number;
    readonly generation: number;
    readonly identity: string;
    readonly targetId: string;
    readonly surface: UseAttemptHistoryOptions['surface'];
    readonly controller: AbortController;
  } | null>(null);
  const configurationTriggerRef = useRef<HTMLElement | null>(null);
  const pendingConfigurationFocusRef = useRef<{
    readonly trigger: HTMLElement;
    readonly operation: number;
    readonly identity: string;
    readonly surface: UseAttemptHistoryOptions['surface'];
  } | null>(null);
  const previousSurfaceRef = useRef(surface);
  const [configurationState, setConfigurationState] = useState<AttemptConfigurationState | null>(
    null,
  );
  const [decisionInspectorTarget, setDecisionInspectorTarget] = useState<AttemptSummary | null>(
    null,
  );
  const [decisionInspectorSelection, setDecisionInspectorSelection] =
    useState<DecisionInitialSelection>('first');
  const [decisionInspectorOpenVersion, setDecisionInspectorOpenVersion] = useState(0);
  const decisionInspectorTriggerRef = useRef<HTMLElement | null>(null);
  const pendingDecisionFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    authPausedRef.current = authPaused;
  }, [authPaused]);

  const rememberHistoryOrigin = useCallback(
    (attemptId: string, action: string): void => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-history-row-id]')].find(
        (candidate) => candidate.dataset.historyRowId === attemptId,
      );
      const activeElement = document.activeElement;
      const trigger = activeElement instanceof HTMLElement ? activeElement : null;
      const rowIsVisible = row !== undefined && row.closest('[hidden]') === null;
      const triggerIsInRow = row !== undefined && trigger !== null && row.contains(trigger);
      if (historyOriginRef.current && !triggerIsInRow) return;
      if (!rowIsVisible && !triggerIsInRow) return;
      historyOriginRef.current = {
        attemptId,
        action,
        view: historyView,
        rowTop: rowIsVisible ? row.getBoundingClientRect().top : null,
      };
    },
    [historyView],
  );

  const restoreHistoryOrigin = useCallback((): void => {
    pendingHistoryReturnRef.current = true;
    setHistoryReturnRevision((revision) => revision + 1);
  }, []);

  const forgetHistoryOrigin = useCallback((): void => {
    historyOriginRef.current = null;
    pendingHistoryReturnRef.current = false;
  }, []);

  useLayoutEffect(() => {
    if (!pendingHistoryReturnRef.current || surface !== 'historial') return;
    const historySection = document.querySelector<HTMLElement>('.attempt-history');
    if (!historySection || historySection.closest('[hidden]')) return;

    const origin = historyOriginRef.current;
    if (origin && origin.view !== historyView) {
      setHistoryView(origin.view);
      return;
    }

    pendingHistoryReturnRef.current = false;
    historyOriginRef.current = null;
    const row = origin
      ? [...historySection.querySelectorAll<HTMLElement>('[data-history-row-id]')].find(
          (candidate) => candidate.dataset.historyRowId === origin.attemptId,
        )
      : undefined;
    const actionTarget = row
      ? [...row.querySelectorAll<HTMLElement>('[data-history-action]')].find(
          (element) => element.dataset.historyAction === origin?.action,
        )
      : undefined;
    const target = actionTarget ?? row?.querySelector<HTMLElement>('[data-history-action="open"]');
    if (target) {
      const disclosure = target.closest('details');
      if (disclosure) disclosure.open = true;

      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const visibleMargin = Math.min(8, viewportHeight / 4);
      const targetRect = target.getBoundingClientRect();
      const preferredOffset =
        row && origin?.rowTop !== null && origin?.rowTop !== undefined
          ? row.getBoundingClientRect().top - origin.rowTop
          : 0;
      const minimumOffset = targetRect.bottom - (viewportHeight - visibleMargin);
      const maximumOffset = targetRect.top - visibleMargin;
      const offset =
        minimumOffset <= maximumOffset
          ? Math.min(Math.max(preferredOffset, minimumOffset), maximumOffset)
          : maximumOffset;
      const scrollElement = document.scrollingElement;
      const maximumScrollY = scrollElement
        ? Math.max(0, scrollElement.scrollHeight - viewportHeight)
        : Number.POSITIVE_INFINITY;
      const nextScrollY = Math.min(Math.max(0, window.scrollY + offset), maximumScrollY);
      const scrollOffset = nextScrollY - window.scrollY;
      if (scrollOffset !== 0) window.scrollBy(0, scrollOffset);
      target.focus({ preventScroll: true });
      return;
    }

    const historyHeading = document.getElementById('attempt-history-title');
    if (!historyHeading) return;
    if (typeof historyHeading.scrollIntoView === 'function') {
      historyHeading.scrollIntoView({ block: 'nearest' });
    }
    historyHeading.focus({ preventScroll: true });
  }, [
    history,
    historyReturnRevision,
    historyView,
    resultQuery,
    surface,
    configurationState,
    decisionInspectorTarget,
  ]);

  const cancelConfigurationApplication = useCallback((): void => {
    const application = configurationApplicationRef.current;
    if (!application) return;
    configurationApplicationRef.current = null;
    configurationApplicationIdRef.current += 1;
    application.controller.abort();
    setConfigurationState((state) =>
      state && state.targetId === application.targetId && state.status === 'applying'
        ? { ...state, status: 'ready', applied: false, message: undefined }
        : state,
    );
  }, []);

  const clearConfiguration = useCallback((): void => {
    configurationOperationRef.current += 1;
    configurationControllerRef.current?.abort();
    configurationControllerRef.current = null;
    cancelConfigurationApplication();
    configurationTriggerRef.current = null;
    pendingConfigurationFocusRef.current = null;
    setConfigurationState(null);
  }, [cancelConfigurationApplication]);

  const clearDecisionInspector = useCallback(
    (restoreFocus = true): void => {
      const trigger = decisionInspectorTriggerRef.current;
      const targetId = decisionInspectorTarget?.id;
      decisionInspectorTriggerRef.current = null;
      setDecisionInspectorTarget(null);
      const origin = historyOriginRef.current;
      if (
        restoreFocus &&
        targetId &&
        origin?.attemptId === targetId &&
        (origin.action === 'inspect' || origin.action === 'inspect-last')
      ) {
        pendingDecisionFocusRef.current = null;
        restoreHistoryOrigin();
        return;
      }
      pendingDecisionFocusRef.current = restoreFocus && trigger?.isConnected ? trigger : null;
    },
    [decisionInspectorTarget, restoreHistoryOrigin],
  );

  useLayoutEffect(() => {
    if (decisionInspectorTarget !== null) return;
    const trigger = pendingDecisionFocusRef.current;
    if (!trigger) return;
    if (!trigger.isConnected) {
      pendingDecisionFocusRef.current = null;
      return;
    }
    if (trigger.closest('[hidden]')) return;
    if (trigger instanceof HTMLButtonElement && trigger.disabled) return;
    pendingDecisionFocusRef.current = null;
    trigger.focus();
  }, [configurationState, decisionInspectorTarget, resultQuery, surface]);

  const updateSummaryById = useCallback((summary: AttemptSummary): void => {
    setHistory((items) => {
      let changed = false;
      const updated = items.map((item) => {
        if (item.id !== summary.id) return item;
        changed = true;
        return summary;
      });
      return changed ? updated : items;
    });
  }, []);

  const clearResultQuery = useCallback(
    (restoreFocus = false): void => {
      resultQueryOperationRef.current += 1;
      resultQueryControllerRef.current?.abort();
      resultQueryControllerRef.current = null;
      setResultQuery(null);
      pendingResultQueryFocusRef.current = false;
      if (restoreFocus) restoreHistoryOrigin();
    },
    [restoreHistoryOrigin],
  );

  const openResult = useCallback(
    async (
      id: string,
      handleActivityTarget: ActivityTargetHandler,
      rememberOrigin = true,
      requestedContextAttempt?: AttemptSummary,
    ): Promise<void> => {
      if (activityBusy.current || surface !== 'historial') return;
      activityTargetHandlerRef.current = handleActivityTarget;
      if (rememberOrigin) {
        rememberHistoryOrigin(id, 'open');
      }
      clearConfiguration();
      clearDecisionInspector(false);
      editor.current?.cancelApplication?.();
      const operation = ++resultQueryOperationRef.current;
      resultQueryControllerRef.current?.abort();
      const controller = new AbortController();
      resultQueryControllerRef.current = controller;
      const contextAttempt =
        requestedContextAttempt?.id === id
          ? requestedContextAttempt
          : history.find((item) => item.id === id);
      pendingResultQueryFocusRef.current = true;
      setResultQuery({ targetId: id, status: 'loading', contextAttempt });
      try {
        const target = await api.getAttempt(id, controller.signal);
        if (
          controller.signal.aborted ||
          operation !== resultQueryOperationRef.current ||
          identityRef.current !== identity ||
          surface !== 'historial'
        ) {
          return;
        }
        if (target.id !== id) {
          throw new AttemptApiFailure(
            'server',
            'El intento recibido no coincide con el solicitado.',
          );
        }
        updateSummaryById(target);
        if (await handleActivityTarget(target, controller.signal)) {
          clearResultQuery(false);
          return;
        }
        setResultQuery({ targetId: id, status: 'ready', attempt: target });
      } catch (error) {
        if (
          controller.signal.aborted ||
          operation !== resultQueryOperationRef.current ||
          identityRef.current !== identity ||
          surface !== 'historial'
        ) {
          return;
        }
        notifyAuthenticationFailure(error, onAuthRequired);
        setResultQuery({
          targetId: id,
          status: 'error',
          message: errorMessage(error),
          contextAttempt,
        });
      } finally {
        if (resultQueryControllerRef.current === controller)
          resultQueryControllerRef.current = null;
      }
    },
    [
      activityBusy,
      api,
      clearConfiguration,
      clearDecisionInspector,
      clearResultQuery,
      editor,
      identity,
      history,
      onAuthRequired,
      rememberHistoryOrigin,
      surface,
      updateSummaryById,
    ],
  );

  const retryResult = useCallback((): void => {
    const targetId = resultQuery?.targetId;
    const handler = activityTargetHandlerRef.current;
    const contextAttempt =
      resultQuery?.status === 'ready' ? resultQuery.attempt : resultQuery?.contextAttempt;
    if (targetId && handler) void openResult(targetId, handler, false, contextAttempt);
  }, [openResult, resultQuery]);

  const closeResult = useCallback((): void => {
    clearResultQuery(true);
  }, [clearResultQuery]);

  const handoffResultToActivity = useCallback(
    (attemptId: string): void => {
      if (resultQuery?.targetId !== attemptId) return;
      clearResultQuery(false);
    },
    [clearResultQuery, resultQuery?.targetId],
  );

  useLayoutEffect(() => {
    if (
      !pendingResultQueryFocusRef.current ||
      resultQuery?.status !== 'loading' ||
      surface !== 'historial'
    ) {
      return;
    }
    pendingResultQueryFocusRef.current = false;
    document.getElementById('history-result-loading-title')?.focus({ preventScroll: true });
  }, [resultQuery, surface]);

  const isCurrentConfigurationApplication = useCallback(
    (application: NonNullable<typeof configurationApplicationRef.current>): boolean =>
      configurationApplicationRef.current?.id === application.id &&
      !application.controller.signal.aborted &&
      configurationOperationRef.current === application.operation &&
      identityRef.current === application.identity &&
      surface === application.surface &&
      !authPausedRef.current,
    [surface],
  );

  const openConfiguration = useCallback(
    async (
      id: string,
      rememberTrigger = true,
      requestedDisplayContext?: AttemptDisplayContext,
    ): Promise<void> => {
      if (activityBusy.current || authPaused) return;
      const contextAttempt =
        history.find((item) => item.id === id) ??
        (currentAttempt.current?.id === id ? currentAttempt.current : undefined);
      const displayContext =
        requestedDisplayContext ??
        (contextAttempt
          ? {
              source: surface === 'preparar' ? 'current' : 'history',
              createdAt: contextAttempt.createdAt,
            }
          : undefined);
      cancelConfigurationApplication();
      editor.current?.cancelApplication?.();
      pendingDecisionFocusRef.current = null;
      if (rememberTrigger) {
        configurationTriggerRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (surface === 'historial') rememberHistoryOrigin(id, 'configuration');
      }
      const operation = ++configurationOperationRef.current;
      configurationControllerRef.current?.abort();
      const controller = new AbortController();
      configurationControllerRef.current = controller;
      const operationSurface = surface;
      setConfigurationState({ targetId: id, displayContext, status: 'loading' });
      try {
        const configuration = await api.getConfiguration(id, controller.signal);
        if (
          controller.signal.aborted ||
          configurationOperationRef.current !== operation ||
          identityRef.current !== identity ||
          surface !== operationSurface
        ) {
          return;
        }
        if (configuration.attemptId !== id) {
          throw new AttemptApiFailure(
            'server',
            'La configuración recibida no coincide con el intento consultado.',
          );
        }
        setConfigurationState({ targetId: id, displayContext, status: 'ready', configuration });
      } catch (error) {
        if (
          controller.signal.aborted ||
          configurationOperationRef.current !== operation ||
          identityRef.current !== identity ||
          surface !== operationSurface
        ) {
          return;
        }
        notifyAuthenticationFailure(error, onAuthRequired);
        setConfigurationState({
          targetId: id,
          displayContext,
          status: 'error',
          message: errorMessage(error),
        });
      } finally {
        if (configurationControllerRef.current === controller) {
          configurationControllerRef.current = null;
        }
      }
    },
    [
      activityBusy,
      api,
      authPaused,
      cancelConfigurationApplication,
      editor,
      history,
      identity,
      currentAttempt,
      onAuthRequired,
      rememberHistoryOrigin,
      surface,
    ],
  );

  const applyConfiguration = useCallback(async (): Promise<void> => {
    const current = configurationState;
    const configuration = current?.configuration;
    if (
      !configuration ||
      activityBusy.current ||
      authPaused ||
      !configurationAvailable ||
      current.status === 'applying'
    ) {
      return;
    }
    const operation = configurationOperationRef.current;
    const application = {
      id: configurationApplicationIdRef.current + 1,
      operation,
      generation: operation,
      identity,
      targetId: configuration.attemptId,
      surface,
      controller: new AbortController(),
    };
    configurationApplicationIdRef.current = application.id;
    configurationApplicationRef.current = application;
    setConfigurationState({ ...current, status: 'applying', message: undefined });
    try {
      const applied = await editor.current?.applyDraft(configuration.draft, {
        signal: application.controller.signal,
      });
      if (!isCurrentConfigurationApplication(application)) return;
      if (applied === true && onReturnToEditor) {
        clearConfiguration();
        onReturnToEditor();
        return;
      }
      setConfigurationState((state) =>
        state && state.targetId === configuration.attemptId
          ? { ...state, status: 'ready', applied: applied === true, message: undefined }
          : state,
      );
    } catch (error) {
      if (!isCurrentConfigurationApplication(application)) return;
      setConfigurationState((state) =>
        state && state.targetId === configuration.attemptId
          ? { ...state, status: 'error', applied: false, message: errorMessage(error) }
          : state,
      );
    } finally {
      if (configurationApplicationRef.current?.id === application.id) {
        configurationApplicationRef.current = null;
      }
    }
  }, [
    activityBusy,
    authPaused,
    clearConfiguration,
    configurationAvailable,
    configurationState,
    editor,
    identity,
    isCurrentConfigurationApplication,
    onReturnToEditor,
    surface,
  ]);

  const closeConfiguration = useCallback((): void => {
    const trigger = configurationTriggerRef.current;
    const targetId = configurationState?.targetId;
    const nextOperation = configurationOperationRef.current + 1;
    clearConfiguration();
    const origin = historyOriginRef.current;
    if (targetId && origin?.attemptId === targetId && origin.action === 'configuration') {
      pendingConfigurationFocusRef.current = null;
      restoreHistoryOrigin();
      return;
    }
    if (trigger?.isConnected) {
      pendingConfigurationFocusRef.current = {
        trigger,
        operation: nextOperation,
        identity,
        surface,
      };
    }
  }, [clearConfiguration, configurationState?.targetId, identity, restoreHistoryOrigin, surface]);

  const retryConfiguration = useCallback((): void => {
    const targetId = configurationState?.targetId;
    if (targetId) void openConfiguration(targetId, false, configurationState?.displayContext);
  }, [configurationState, openConfiguration]);

  const openDecisionInspector = useCallback(
    (target: AttemptSummary, selection: DecisionInitialSelection = 'first'): void => {
      if (activityBusy.current || !isTerminal(target.status) || !target.recordComplete) return;
      clearConfiguration();
      cancelConfigurationApplication();
      editor.current?.cancelApplication?.();
      pendingDecisionFocusRef.current = null;
      if (surface === 'historial') {
        rememberHistoryOrigin(target.id, selection === 'first' ? 'inspect' : 'inspect-last');
      }
      decisionInspectorTriggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDecisionInspectorTarget(target);
      setDecisionInspectorSelection(selection);
      setDecisionInspectorOpenVersion((version) => version + 1);
    },
    [
      activityBusy,
      cancelConfigurationApplication,
      clearConfiguration,
      editor,
      rememberHistoryOrigin,
      surface,
    ],
  );

  const openDecisionInspectorFromHistory = useCallback(
    (id: string, selection: DecisionInitialSelection = 'first'): void => {
      if (activityBusy.current) return;
      const target = history.find((item) => item.id === id);
      if (
        !target ||
        !isTerminal(target.status) ||
        !target.recordComplete ||
        !target.presentationComplete
      ) {
        return;
      }
      openDecisionInspector(target, selection);
    },
    [activityBusy, history, openDecisionInspector],
  );

  const handleDecisionInspectorAuthRequired = useCallback(
    (authContext?: number): boolean => {
      const accepted = onAuthRequired?.(authContext);
      if (accepted === false) return false;
      clearDecisionInspector(false);
      return true;
    },
    [clearDecisionInspector, onAuthRequired],
  );

  useLayoutEffect(() => {
    const pending = pendingConfigurationFocusRef.current;
    if (!pending) return;
    pendingConfigurationFocusRef.current = null;
    if (
      !pending.trigger.isConnected ||
      pending.operation !== configurationOperationRef.current ||
      pending.identity !== identityRef.current ||
      pending.surface !== surface ||
      authPausedRef.current
    ) {
      return;
    }
    if (pending.trigger instanceof HTMLButtonElement && pending.trigger.disabled) return;
    pending.trigger.focus();
  }, [authPaused, configurationState, identity, surface]);

  useEffect(() => {
    if (previousSurfaceRef.current === surface) return;
    previousSurfaceRef.current = surface;
    forgetHistoryOrigin();
    if (configurationState !== null) clearConfiguration();
    if (decisionInspectorTarget !== null) clearDecisionInspector(false);
    if (resultQuery !== null) clearResultQuery(false);
    editor.current?.cancelApplication?.();
  }, [
    clearConfiguration,
    clearDecisionInspector,
    clearResultQuery,
    configurationState,
    decisionInspectorTarget,
    editor,
    forgetHistoryOrigin,
    resultQuery,
    surface,
  ]);

  useEffect(() => {
    if (!authPaused) return;
    cancelConfigurationApplication();
    clearDecisionInspector(false);
  }, [authPaused, cancelConfigurationApplication, clearDecisionInspector]);

  useEffect(
    () => () => {
      resultQueryOperationRef.current += 1;
      resultQueryControllerRef.current?.abort();
      visibleGenerationRef.current += 1;
      visibleControllerRef.current?.abort();
      configurationOperationRef.current += 1;
      configurationControllerRef.current?.abort();
      const application = configurationApplicationRef.current;
      configurationApplicationRef.current = null;
      application?.controller.abort();
    },
    [],
  );

  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    visibleGenerationRef.current += 1;
    bootstrapGenerationRef.current += 1;
    visibleControllerRef.current?.abort();
    visibleControllerRef.current = null;
    setHistory([]);
    setHistoryView('recent');
    setHistoryCursor(undefined);
    setHistoryError(null);
    setLoadingHistory(false);
    setLoadingBootstrap(false);
    clearConfiguration();
    clearDecisionInspector(false);
    clearResultQuery(false);
    forgetHistoryOrigin();
    editor.current?.cancelApplication?.();
  }, [
    clearConfiguration,
    clearDecisionInspector,
    clearResultQuery,
    editor,
    forgetHistoryOrigin,
    identity,
  ]);

  useEffect(() => {
    if (active) return;
    visibleGenerationRef.current += 1;
    visibleControllerRef.current?.abort();
    visibleControllerRef.current = null;
    setLoadingHistory(false);
  }, [active]);

  const loadBootstrapPage = useCallback(
    async (signal: AbortSignal, isCurrent: () => boolean): Promise<void> => {
      const generation = ++bootstrapGenerationRef.current;
      setLoadingBootstrap(true);
      try {
        const page: AttemptsPage = await api.listAttempts(undefined, signal);
        if (signal.aborted || !isCurrent() || generation !== bootstrapGenerationRef.current) return;
        setHistory((current) => mergePage(current, page.attempts, currentAttempt.current, false));
        setHistoryCursor(page.nextCursor);
        setHistoryError(null);
      } catch (error) {
        if (signal.aborted || !isCurrent() || generation !== bootstrapGenerationRef.current) return;
        notifyAuthenticationFailure(error, onAuthRequired);
        setHistoryError(errorMessage(error));
      } finally {
        if (generation === bootstrapGenerationRef.current && !signal.aborted && isCurrent()) {
          setLoadingBootstrap(false);
        }
      }
    },
    [api, currentAttempt, onAuthRequired],
  );

  const refreshHistory = useCallback(async (): Promise<void> => {
    const generation = ++visibleGenerationRef.current;
    visibleControllerRef.current?.abort();
    const controller = new AbortController();
    visibleControllerRef.current = controller;
    setLoadingHistory(true);
    try {
      const page = await api.listAttempts(undefined, controller.signal);
      if (
        controller.signal.aborted ||
        generation !== visibleGenerationRef.current ||
        identityRef.current !== identity
      ) {
        return;
      }
      setHistory((current) => mergePage(current, page.attempts, currentAttempt.current, false));
      setHistoryCursor(page.nextCursor);
      setHistoryError(null);
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== visibleGenerationRef.current ||
        identityRef.current !== identity
      ) {
        return;
      }
      notifyAuthenticationFailure(error, onAuthRequired);
      setHistoryError(errorMessage(error));
    } finally {
      if (
        !controller.signal.aborted &&
        generation === visibleGenerationRef.current &&
        identityRef.current === identity
      ) {
        setLoadingHistory(false);
        if (visibleControllerRef.current === controller) visibleControllerRef.current = null;
      }
    }
  }, [api, currentAttempt, identity, onAuthRequired]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!historyCursor || loadingHistory || !active) return;
    const generation = ++visibleGenerationRef.current;
    visibleControllerRef.current?.abort();
    const controller = new AbortController();
    visibleControllerRef.current = controller;
    setLoadingHistory(true);
    try {
      const page = await api.listAttempts(historyCursor, controller.signal);
      if (
        controller.signal.aborted ||
        generation !== visibleGenerationRef.current ||
        identityRef.current !== identity
      ) {
        return;
      }
      setHistory((current) => mergePage(current, page.attempts, currentAttempt.current, true));
      setHistoryCursor(page.nextCursor);
      setHistoryError(null);
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== visibleGenerationRef.current ||
        identityRef.current !== identity
      ) {
        return;
      }
      notifyAuthenticationFailure(error, onAuthRequired);
      setHistoryError(errorMessage(error));
    } finally {
      if (
        !controller.signal.aborted &&
        generation === visibleGenerationRef.current &&
        identityRef.current === identity
      ) {
        setLoadingHistory(false);
        if (visibleControllerRef.current === controller) visibleControllerRef.current = null;
      }
    }
  }, [active, api, currentAttempt, historyCursor, identity, loadingHistory, onAuthRequired]);

  const retryHistory = useCallback((): void => {
    void refreshHistory();
  }, [refreshHistory]);

  return {
    history,
    historyView,
    historyCursor,
    historyError,
    loadingHistory: loadingHistory || loadingBootstrap,
    configurationState,
    decisionInspectorTarget,
    decisionInspectorSelection,
    decisionInspectorOpenVersion,
    resultQuery,
    queryVisible:
      configurationState !== null || decisionInspectorTarget !== null || resultQuery !== null,
    selectHistoryView: setHistoryView,
    rememberHistoryOrigin,
    restoreHistoryOrigin,
    forgetHistoryOrigin,
    loadBootstrapPage,
    refreshHistory,
    loadMore,
    retryHistory,
    updateSummaryById,
    openConfiguration,
    applyConfiguration,
    retryConfiguration,
    closeConfiguration,
    clearConfiguration,
    openDecisionInspector,
    openDecisionInspectorFromHistory,
    clearDecisionInspector,
    handleDecisionInspectorAuthRequired,
    openResult,
    retryResult,
    closeResult,
    handoffResultToActivity,
  };
}
