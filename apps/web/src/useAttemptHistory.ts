import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ApiAuthRequired } from './api-auth.js';
import {
  AttemptApiFailure,
  isTransientReadFailure,
  type AttemptApi,
  type AttemptConfiguration,
  type AttemptSummary,
  type AttemptsPage,
} from './attempt-api.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import type { ResultSource } from './attempt-display.js';
import { useAttemptReadRecovery, type AttemptReadResource } from './useAttemptReadRecovery.js';

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
  readonly focusVersion: number;
  readonly status: 'loading' | 'recovering' | 'pending' | 'ready' | 'applying' | 'error';
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
  | {
      readonly targetId: string;
      readonly status: 'recovering';
      readonly message: string;
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

function notifyAuthenticationFailure(
  error: unknown,
  onAuthRequired?: ApiAuthRequired,
): boolean | void {
  if (error instanceof AttemptApiFailure && error.code === 'authentication') {
    return onAuthRequired?.(error.authContext);
  }
  return undefined;
}

const HISTORY_RECOVERY_DELAY_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

interface HistoryPageResource {
  readonly identity: string;
  readonly cursor: string | undefined;
  readonly append: boolean;
  readonly chain: number;
}

interface HistoryPageOperation {
  readonly id: number;
  readonly resource: HistoryPageResource;
  readonly controller: AbortController;
  readonly requiresVisibleList: boolean;
  readonly recovery: boolean;
}

interface FailedHistoryPage {
  readonly resource: HistoryPageResource;
  readonly deadline: number;
}

interface HistoryResultResource extends AttemptReadResource {
  readonly identity: string;
  readonly targetId: string;
  readonly surface: 'historial';
  readonly contextAttempt?: AttemptSummary;
  readonly handleActivityTarget: ActivityTargetHandler;
}

interface HistoryConfigurationResource extends AttemptReadResource {
  readonly displayContext?: AttemptDisplayContext;
  readonly focusVersion: number;
}

export interface AttemptHistoryController {
  readonly history: readonly AttemptSummary[];
  readonly historyView: HistoryView;
  readonly historyCursor: string | undefined;
  readonly historyError: string | null;
  readonly loadingHistory: boolean;
  readonly historyRecovering: boolean;
  readonly historyRecoveryMessage: string | null;
  readonly invalidHistoryCursor: boolean;
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
  updateHistory(): void;
  updateSummaryById(summary: AttemptSummary): void;
  openConfiguration(
    id: string,
    rememberTrigger?: boolean,
    displayContext?: AttemptDisplayContext,
  ): Promise<void>;
  applyConfiguration(): Promise<void>;
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
  closeResult(): void;
  handoffResultToActivity(attemptId: string): void;
}

interface UseAttemptHistoryOptions {
  readonly api: AttemptApi;
  readonly identity: string;
  readonly currentAttempt: { readonly current: AttemptSummary | null };
  readonly historyVisible: boolean;
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
  historyVisible,
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
  const [historyRecovering, setHistoryRecovering] = useState(false);
  const [historyRecoveryMessage, setHistoryRecoveryMessage] = useState<string | null>(null);
  const [invalidHistoryCursor, setInvalidHistoryCursor] = useState(false);
  const [resultQuery, setResultQuery] = useState<AttemptResultQueryState | null>(null);
  const identityRef = useRef(identity);
  const historyVisibleRef = useRef(historyVisible);
  const apiRef = useRef(api);
  const authRequiredRef = useRef(onAuthRequired);
  const mountedRef = useRef(true);
  const pageChainRef = useRef(0);
  const pageOperationIdRef = useRef(0);
  const pageOperationRef = useRef<HistoryPageOperation | null>(null);
  const failedPageRef = useRef<FailedHistoryPage | null>(null);
  const authBlockedPageRef = useRef<HistoryPageResource | null>(null);
  const bootstrapIdentityRef = useRef<string | null>(null);
  const pageTimerRef = useRef<number | null>(null);
  const runPageRef = useRef<
    (
      resource: HistoryPageResource,
      options: {
        readonly externalSignal?: AbortSignal;
        readonly isCurrent?: () => boolean;
        readonly requiresVisibleList: boolean;
      },
    ) => Promise<void>
  >(async () => undefined);
  const processDuePageRef = useRef<() => void>(() => undefined);
  const schedulePageRetryRef = useRef<() => void>(() => undefined);
  const historyOriginRef = useRef<HistoryReturnOrigin | null>(null);
  const pendingHistoryReturnRef = useRef(false);
  const pendingResultQueryFocusRef = useRef(false);
  const authPausedRef = useRef(authPaused);
  const configurationOperationRef = useRef(0);
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
  const surfaceRef = useRef(surface);
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
  const historyListVisible =
    historyVisible &&
    configurationState === null &&
    decisionInspectorTarget === null &&
    resultQuery === null;
  const resultQueryVisible =
    surface === 'historial' &&
    resultQuery !== null &&
    configurationState === null &&
    decisionInspectorTarget === null;

  useLayoutEffect(() => {
    authPausedRef.current = authPaused;
    historyVisibleRef.current = historyListVisible;
    apiRef.current = api;
    authRequiredRef.current = onAuthRequired;
    surfaceRef.current = surface;
  }, [api, authPaused, historyListVisible, onAuthRequired, resultQueryVisible, surface]);

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

  const configurationRecovery = useAttemptReadRecovery<
    HistoryConfigurationResource,
    AttemptConfiguration
  >({
    active:
      configurationState !== null && decisionInspectorTarget === null && !activityBusy.current,
    authPaused,
    identity,
    surface,
    onAuthRequired: (authContext) => authRequiredRef.current?.(authContext),
    read: (resource, signal) => apiRef.current.getConfiguration(resource.targetId, signal),
    isPendingFailure: (error) => error instanceof AttemptApiFailure && error.code === 'pending',
    onStart: (resource) =>
      setConfigurationState((state) =>
        state?.targetId === resource.targetId && state.focusVersion === resource.focusVersion
          ? { ...state, status: 'loading', message: undefined }
          : {
              targetId: resource.targetId,
              displayContext: resource.displayContext,
              focusVersion: resource.focusVersion,
              status: 'loading',
            },
      ),
    onValue: (configuration, resource) => {
      if (configuration.attemptId !== resource.targetId) {
        throw new AttemptApiFailure(
          'server',
          'La configuración recibida no coincide con el intento consultado.',
          200,
        );
      }
      setConfigurationState({
        targetId: resource.targetId,
        displayContext: resource.displayContext,
        focusVersion: resource.focusVersion,
        status: 'ready',
        configuration,
      });
      return false;
    },
    onRecovering: (resource, error, reason) =>
      setConfigurationState((state) => {
        if (state?.targetId !== resource.targetId || state.focusVersion !== resource.focusVersion) {
          return state;
        }
        return {
          ...state,
          status: reason === 'pending' ? 'pending' : 'recovering',
          message:
            reason === 'pending' || reason === 'authentication'
              ? errorMessage(error)
              : 'Volveremos a consultar la configuración guardada.',
        };
      }),
    onPaused: (resource) =>
      setConfigurationState((state) =>
        state?.targetId === resource.targetId && state.focusVersion === resource.focusVersion
          ? {
              ...state,
              status: 'recovering',
              message: 'Volveremos a consultar la configuración guardada cuando esté disponible.',
            }
          : state,
      ),
    onError: (resource, error) =>
      setConfigurationState((state) =>
        state?.targetId === resource.targetId && state.focusVersion === resource.focusVersion
          ? { ...state, status: 'error', message: errorMessage(error) }
          : state,
      ),
  });

  const resultRecovery = useAttemptReadRecovery<HistoryResultResource, AttemptSummary>({
    active: resultQueryVisible && !activityBusy.current,
    authPaused,
    identity,
    surface,
    onAuthRequired: (authContext) => authRequiredRef.current?.(authContext),
    read: (resource, signal) => apiRef.current.getAttempt(resource.targetId, signal),
    onStart: (resource) =>
      setResultQuery({
        targetId: resource.targetId,
        status: 'loading',
        contextAttempt: resource.contextAttempt,
      }),
    onValue: (result, resource, signal, isCurrent) => {
      if (result.id !== resource.targetId) {
        throw new AttemptApiFailure(
          'server',
          'El intento recibido no coincide con el solicitado.',
          200,
        );
      }
      updateSummaryById(result);
      const handoff = resource.handleActivityTarget(result, signal);
      if (typeof handoff === 'boolean') {
        if (!handoff && isCurrent()) {
          setResultQuery({ targetId: resource.targetId, status: 'ready', attempt: result });
        }
        return handoff;
      }
      return handoff.then((handedOff) => {
        if (!handedOff && isCurrent()) {
          setResultQuery({ targetId: resource.targetId, status: 'ready', attempt: result });
        }
        return handedOff;
      });
    },
    onComplete: () => {
      setResultQuery(null);
      pendingResultQueryFocusRef.current = false;
    },
    onRecovering: (resource, error, reason) =>
      setResultQuery({
        targetId: resource.targetId,
        status: 'recovering',
        message:
          reason === 'authentication'
            ? errorMessage(error)
            : 'Volveremos a consultar el resultado.',
        contextAttempt: resource.contextAttempt,
      }),
    onPaused: (resource) =>
      setResultQuery({
        targetId: resource.targetId,
        status: 'recovering',
        message: 'Volveremos a consultar el resultado cuando esté disponible.',
        contextAttempt: resource.contextAttempt,
      }),
    onError: (resource, error) =>
      setResultQuery({
        targetId: resource.targetId,
        status: 'error',
        message: errorMessage(error),
        contextAttempt: resource.contextAttempt,
      }),
  });

  const clearResultQuery = useCallback(
    (restoreFocus = false): void => {
      resultRecovery.clear();
      setResultQuery(null);
      pendingResultQueryFocusRef.current = false;
      if (restoreFocus) restoreHistoryOrigin();
    },
    [resultRecovery, restoreHistoryOrigin],
  );

  const clearConfiguration = useCallback((): void => {
    configurationOperationRef.current += 1;
    configurationRecovery.clear();
    cancelConfigurationApplication();
    configurationTriggerRef.current = null;
    pendingConfigurationFocusRef.current = null;
    setConfigurationState(null);
  }, [cancelConfigurationApplication, configurationRecovery]);

  const openResult = useCallback(
    (
      id: string,
      handleActivityTarget: ActivityTargetHandler,
      rememberOrigin = true,
      requestedContextAttempt?: AttemptSummary,
    ): Promise<void> => {
      if (activityBusy.current || surface !== 'historial') return Promise.resolve();
      if (rememberOrigin) rememberHistoryOrigin(id, 'open');
      clearConfiguration();
      clearDecisionInspector(false);
      editor.current?.cancelApplication?.();
      clearResultQuery(false);
      const contextAttempt =
        requestedContextAttempt?.id === id
          ? requestedContextAttempt
          : history.find((item) => item.id === id);
      const resource: HistoryResultResource = {
        identity,
        targetId: id,
        surface: 'historial',
        ...(contextAttempt ? { contextAttempt } : {}),
        handleActivityTarget,
      };
      pendingResultQueryFocusRef.current = true;
      return resultRecovery.open(resource);
    },
    [
      activityBusy,
      clearConfiguration,
      clearDecisionInspector,
      clearResultQuery,
      editor,
      history,
      identity,
      rememberHistoryOrigin,
      resultRecovery,
      surface,
    ],
  );

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
      (resultQuery?.status !== 'loading' && resultQuery?.status !== 'recovering') ||
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
    (
      id: string,
      rememberTrigger = true,
      requestedDisplayContext?: AttemptDisplayContext,
    ): Promise<void> => {
      if (activityBusy.current || authPaused) return Promise.resolve();
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
      const resource: HistoryConfigurationResource = {
        identity,
        targetId: id,
        surface,
        displayContext,
        focusVersion: operation,
      };
      setConfigurationState({
        targetId: id,
        displayContext,
        focusVersion: operation,
        status: 'loading',
      });
      return configurationRecovery.open(resource);
    },
    [
      activityBusy,
      authPaused,
      cancelConfigurationApplication,
      configurationRecovery,
      editor,
      history,
      identity,
      currentAttempt,
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

  const clearPageTimer = useCallback((): void => {
    if (pageTimerRef.current === null) return;
    window.clearTimeout(pageTimerRef.current);
    pageTimerRef.current = null;
  }, []);

  const cancelPageOperation = useCallback((preserveResource: boolean): void => {
    const operation = pageOperationRef.current;
    if (!operation) return;
    pageOperationRef.current = null;
    pageOperationIdRef.current += 1;
    operation.controller.abort();
    setLoadingHistory(false);
    if (preserveResource && !failedPageRef.current && authBlockedPageRef.current === null) {
      failedPageRef.current = { resource: operation.resource, deadline: Date.now() };
      setHistoryRecovering(operation.recovery);
      if (!operation.recovery) setHistoryRecoveryMessage(null);
    }
  }, []);

  const schedulePageRetry = useCallback((): void => {
    clearPageTimer();
    const pending = failedPageRef.current;
    if (
      !mountedRef.current ||
      authPausedRef.current ||
      !historyVisibleRef.current ||
      document.hidden ||
      document.visibilityState === 'hidden' ||
      pageOperationRef.current !== null ||
      pending === null ||
      pending.resource.identity !== identityRef.current ||
      pending.resource.chain !== pageChainRef.current
    ) {
      return;
    }
    const delay = Math.max(0, pending.deadline - Date.now());
    pageTimerRef.current = window.setTimeout(
      () => {
        pageTimerRef.current = null;
        processDuePageRef.current();
      },
      Math.min(MAX_TIMEOUT_MS, delay),
    );
  }, [clearPageTimer]);

  const processDuePage = useCallback((): void => {
    const pending = failedPageRef.current;
    if (
      !mountedRef.current ||
      pending === null ||
      authPausedRef.current ||
      !historyVisibleRef.current ||
      document.hidden ||
      document.visibilityState === 'hidden' ||
      pageOperationRef.current !== null ||
      pending.resource.identity !== identityRef.current ||
      pending.resource.chain !== pageChainRef.current
    ) {
      return;
    }
    if (pending.deadline > Date.now()) {
      schedulePageRetryRef.current();
      return;
    }
    clearPageTimer();
    void runPageRef.current(pending.resource, { requiresVisibleList: true });
  }, [clearPageTimer]);

  const runPage = useCallback(
    async (
      resource: HistoryPageResource,
      options: {
        readonly externalSignal?: AbortSignal;
        readonly isCurrent?: () => boolean;
        readonly requiresVisibleList: boolean;
      },
    ): Promise<void> => {
      const canStart =
        mountedRef.current &&
        !authPausedRef.current &&
        identityRef.current === resource.identity &&
        pageChainRef.current === resource.chain &&
        !options.externalSignal?.aborted &&
        options.isCurrent?.() !== false &&
        (!options.requiresVisibleList ||
          (historyVisibleRef.current && !document.hidden && document.visibilityState !== 'hidden'));
      if (!canStart) return;

      clearPageTimer();
      cancelPageOperation(false);
      const controller = new AbortController();
      const operation: HistoryPageOperation = {
        id: ++pageOperationIdRef.current,
        resource,
        controller,
        requiresVisibleList: options.requiresVisibleList,
        recovery: failedPageRef.current?.resource === resource,
      };
      pageOperationRef.current = operation;
      setLoadingHistory(true);
      setHistoryError(null);
      setInvalidHistoryCursor(false);
      setHistoryRecovering(failedPageRef.current !== null);

      const abortCurrent = (): void => controller.abort();
      if (options.externalSignal) {
        options.externalSignal.addEventListener('abort', abortCurrent, { once: true });
        if (options.externalSignal.aborted) controller.abort();
      }
      const aborted = Symbol('history-page-aborted');
      let resolveAborted!: (value: typeof aborted) => void;
      const abortPromise = new Promise<typeof aborted>((resolve) => {
        resolveAborted = resolve;
      });
      const handleAbort = (): void => resolveAborted(aborted);
      controller.signal.addEventListener('abort', handleAbort, { once: true });
      if (controller.signal.aborted) handleAbort();

      const isCurrentOperation = (): boolean =>
        mountedRef.current &&
        pageOperationRef.current === operation &&
        pageOperationIdRef.current === operation.id &&
        identityRef.current === resource.identity &&
        pageChainRef.current === resource.chain &&
        !controller.signal.aborted &&
        !options.externalSignal?.aborted &&
        options.isCurrent?.() !== false &&
        !authPausedRef.current &&
        (!operation.requiresVisibleList ||
          (historyVisibleRef.current && !document.hidden && document.visibilityState !== 'hidden'));

      try {
        const result = await Promise.race([
          Promise.resolve().then(() =>
            apiRef.current.listAttempts(resource.cursor, controller.signal),
          ),
          abortPromise,
        ]);
        if (result === aborted || !isCurrentOperation()) return;
        const page: AttemptsPage = result;
        setHistory((current) =>
          mergePage(current, page.attempts, currentAttempt.current, resource.append),
        );
        setHistoryCursor(page.nextCursor);
        setHistoryError(null);
        setInvalidHistoryCursor(false);
        failedPageRef.current = null;
        authBlockedPageRef.current = null;
        setHistoryRecovering(false);
        setHistoryRecoveryMessage(null);
      } catch (error) {
        if (!isCurrentOperation()) return;
        const acceptedAuthFailure = notifyAuthenticationFailure(error, authRequiredRef.current);
        const isAuthenticationError =
          error instanceof AttemptApiFailure && error.code === 'authentication';
        if (isAuthenticationError && acceptedAuthFailure !== false) {
          failedPageRef.current = null;
          authBlockedPageRef.current = resource;
          setHistoryRecovering(false);
          setHistoryRecoveryMessage(null);
          setHistoryError(errorMessage(error));
          setInvalidHistoryCursor(false);
          return;
        }
        const transient = isAuthenticationError || isTransientReadFailure(error);
        if (transient) {
          failedPageRef.current = {
            resource,
            deadline: Date.now() + HISTORY_RECOVERY_DELAY_MS,
          };
          authBlockedPageRef.current = null;
          setHistoryRecovering(true);
          setHistoryRecoveryMessage(errorMessage(error));
          setHistoryError(null);
          setInvalidHistoryCursor(false);
          return;
        }

        failedPageRef.current = null;
        authBlockedPageRef.current = null;
        setHistoryRecovering(false);
        setHistoryRecoveryMessage(null);
        setHistoryError(errorMessage(error));
        const invalidCursor =
          resource.cursor !== undefined &&
          error instanceof AttemptApiFailure &&
          error.code === 'invalid';
        setInvalidHistoryCursor(invalidCursor);
        if (invalidCursor) setHistoryCursor(undefined);
      } finally {
        options.externalSignal?.removeEventListener('abort', abortCurrent);
        controller.signal.removeEventListener('abort', handleAbort);
        if (pageOperationRef.current === operation) {
          pageOperationRef.current = null;
          setLoadingHistory(false);
          schedulePageRetryRef.current();
        }
      }
    },
    [cancelPageOperation, clearPageTimer, currentAttempt],
  );

  useLayoutEffect(() => {
    runPageRef.current = runPage;
    processDuePageRef.current = processDuePage;
    schedulePageRetryRef.current = schedulePageRetry;
  }, [processDuePage, runPage, schedulePageRetry]);

  const previousAuthPausedRef = useRef(authPaused);
  useEffect(() => {
    const wasPaused = previousAuthPausedRef.current;
    previousAuthPausedRef.current = authPaused;
    if (authPaused) {
      clearPageTimer();
      cancelPageOperation(true);
      return;
    }
    if (wasPaused && authBlockedPageRef.current) {
      failedPageRef.current = {
        resource: authBlockedPageRef.current,
        deadline: Date.now(),
      };
      authBlockedPageRef.current = null;
      setHistoryError(null);
      setInvalidHistoryCursor(false);
      setHistoryRecovering(true);
    }
    if (!historyListVisible || document.hidden || document.visibilityState === 'hidden') {
      clearPageTimer();
      cancelPageOperation(true);
    } else {
      processDuePageRef.current();
      schedulePageRetryRef.current();
    }
  }, [authPaused, cancelPageOperation, clearPageTimer, historyListVisible]);

  useEffect(() => {
    const handleWake = (): void => {
      if (document.hidden || document.visibilityState === 'hidden') {
        clearPageTimer();
        cancelPageOperation(true);
        return;
      }
      processDuePageRef.current();
    };
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);
    return () => {
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, [cancelPageOperation, clearPageTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pageOperationIdRef.current += 1;
      pageOperationRef.current?.controller.abort();
      pageOperationRef.current = null;
      failedPageRef.current = null;
      authBlockedPageRef.current = null;
      clearPageTimer();
      configurationOperationRef.current += 1;
      const application = configurationApplicationRef.current;
      configurationApplicationRef.current = null;
      application?.controller.abort();
    };
  }, [clearPageTimer]);

  useLayoutEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    pageChainRef.current = 0;
    pageOperationIdRef.current += 1;
    pageOperationRef.current?.controller.abort();
    pageOperationRef.current = null;
    failedPageRef.current = null;
    authBlockedPageRef.current = null;
    clearPageTimer();
    bootstrapIdentityRef.current = null;
    setHistory([]);
    setHistoryView('recent');
    setHistoryCursor(undefined);
    setHistoryError(null);
    setLoadingHistory(false);
    setHistoryRecovering(false);
    setHistoryRecoveryMessage(null);
    setInvalidHistoryCursor(false);
    clearConfiguration();
    clearDecisionInspector(false);
    clearResultQuery(false);
    forgetHistoryOrigin();
    editor.current?.cancelApplication?.();
  }, [
    clearConfiguration,
    clearDecisionInspector,
    clearPageTimer,
    clearResultQuery,
    editor,
    forgetHistoryOrigin,
    identity,
  ]);

  useEffect(() => {
    if (!authPaused) return;
    cancelConfigurationApplication();
    clearDecisionInspector(false);
  }, [authPaused, cancelConfigurationApplication, clearDecisionInspector]);

  const loadBootstrapPage = useCallback(
    async (signal: AbortSignal, isCurrent: () => boolean): Promise<void> => {
      if (bootstrapIdentityRef.current !== identity) {
        bootstrapIdentityRef.current = identity;
        if (pageChainRef.current === 0) pageChainRef.current = 1;
      }
      const resource: HistoryPageResource = {
        identity,
        cursor: undefined,
        append: false,
        chain: pageChainRef.current,
      };
      await runPageRef.current(resource, {
        externalSignal: signal,
        isCurrent,
        requiresVisibleList: false,
      });
    },
    [identity],
  );

  const startFirstPage = useCallback(
    (requiresVisibleList: boolean): Promise<void> => {
      const chain = ++pageChainRef.current;
      clearPageTimer();
      failedPageRef.current = null;
      authBlockedPageRef.current = null;
      cancelPageOperation(false);
      const resource: HistoryPageResource = {
        identity,
        cursor: undefined,
        append: false,
        chain,
      };
      if (authPausedRef.current) {
        failedPageRef.current = { resource, deadline: Date.now() };
        setHistoryRecovering(true);
        setHistoryRecoveryMessage('La consulta se reanudará al restablecer el acceso.');
        setHistoryError(null);
        setInvalidHistoryCursor(false);
        return Promise.resolve();
      }
      setHistoryRecovering(false);
      setHistoryRecoveryMessage(null);
      setHistoryError(null);
      setInvalidHistoryCursor(false);
      return runPageRef.current(resource, { requiresVisibleList });
    },
    [cancelPageOperation, clearPageTimer, identity],
  );

  const refreshHistory = useCallback((): Promise<void> => startFirstPage(false), [startFirstPage]);

  const updateHistory = useCallback((): void => {
    void startFirstPage(true);
  }, [startFirstPage]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (
      !historyCursor ||
      loadingHistory ||
      historyRecovering ||
      !historyVisibleRef.current ||
      authPausedRef.current ||
      pageOperationRef.current !== null
    ) {
      return;
    }
    const resource: HistoryPageResource = {
      identity,
      cursor: historyCursor,
      append: true,
      chain: pageChainRef.current,
    };
    await runPageRef.current(resource, { requiresVisibleList: true });
  }, [historyCursor, historyRecovering, identity, loadingHistory]);

  return {
    history,
    historyView,
    historyCursor,
    historyError,
    loadingHistory,
    historyRecovering,
    historyRecoveryMessage,
    invalidHistoryCursor,
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
    updateHistory,
    updateSummaryById,
    openConfiguration,
    applyConfiguration,
    closeConfiguration,
    clearConfiguration,
    openDecisionInspector,
    openDecisionInspectorFromHistory,
    clearDecisionInspector,
    handleDecisionInspectorAuthRequired,
    openResult,
    closeResult,
    handoffResultToActivity,
  };
}
