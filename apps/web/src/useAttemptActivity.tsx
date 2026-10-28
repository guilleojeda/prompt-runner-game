import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { AuthSession } from './auth.js';
import type { ApiAuthRequired } from './api-auth.js';
import {
  AttemptApiFailure,
  type AttemptAdmission,
  type AttemptApi,
  type AttemptStatus,
  type AttemptSummary,
} from './attempt-api.js';
import {
  clearAttemptRecovery,
  readAttemptRecovery,
  writeAttemptRecovery,
  type AttemptRecoveryReference,
} from './attempt-recovery.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import type { RobotDraft } from '../../../shared/robot.js';
import type { ReplayRecordView } from '../../../shared/attempt.js';
import { DecisionInspector } from './DecisionInspector.js';
import { ReplayScene } from './replay/ReplayScene.js';
import {
  ConfigurationPreview,
  HistoryList,
  HistoryResultQuery,
  ResultCard,
} from './AttemptActivityViews.js';
import { formatDateTime, isTerminal, statusLabel } from './attempt-display.js';
import { useAnimationPreference } from './useAnimationPreference.js';
import { usePresentationAcknowledgements } from './usePresentationAcknowledgements.js';
import { useQuota } from './useQuota.js';
import { useAttemptHistory, type DecisionInitialSelection } from './useAttemptHistory.js';

type WorkspaceMode =
  | 'loading'
  | 'idle'
  | 'admitting'
  | 'opening'
  | 'pending'
  | 'running'
  | 'canceling'
  | 'unknown'
  | 'selecting'
  | 'preparing-replay'
  | 'replaying'
  | 'replay-error'
  | 'result';

type WorkspaceErrorGuidance = 'check-status' | 'enable-skill' | 'replay';

interface WorkspaceError {
  readonly message: string;
  readonly guidance?: WorkspaceErrorGuidance;
}

const workspaceError = (message: string, guidance?: WorkspaceErrorGuidance): WorkspaceError => ({
  message,
  guidance,
});

function admissionErrorGuidance(error: unknown): WorkspaceErrorGuidance | undefined {
  if (!(error instanceof AttemptApiFailure)) return undefined;
  if (error.message.trim().replace(/[.!?]+$/, '') === 'Seleccioná al menos una habilidad') {
    return 'enable-skill';
  }
  return undefined;
}

interface FrozenAdmission {
  readonly requestKey: string;
  readonly expectedVersion: number;
  readonly draft: RobotDraft;
  readonly animationEnabled: boolean;
}

function frozenAdmissionFromRecovery(
  reference: ReturnType<typeof readAttemptRecovery>,
): FrozenAdmission | null {
  if (
    !reference?.requestKey ||
    reference.expectedVersion === undefined ||
    !reference.draft ||
    reference.animationEnabled === undefined
  ) {
    return null;
  }
  return {
    requestKey: reference.requestKey,
    expectedVersion: reference.expectedVersion,
    draft: reference.draft,
    animationEnabled: reference.animationEnabled,
  };
}

function selectRecoveryReference(
  sub: string,
  stored: ReturnType<typeof readAttemptRecovery>,
  currentFrozen: FrozenAdmission | null,
  currentAttempt: AttemptSummary | null,
): {
  readonly reference: AttemptRecoveryReference;
  readonly frozen: FrozenAdmission | null;
} | null {
  if (currentFrozen) {
    return { reference: { sub, requestKey: currentFrozen.requestKey }, frozen: currentFrozen };
  }
  if (currentAttempt && isActive(currentAttempt.status)) {
    return { reference: { sub, attemptId: currentAttempt.id }, frozen: null };
  }
  const storedFrozen = frozenAdmissionFromRecovery(stored);
  if (storedFrozen) {
    return { reference: { sub, requestKey: storedFrozen.requestKey }, frozen: storedFrozen };
  }
  return stored ? { reference: stored, frozen: null } : null;
}

export interface AttemptActivityOptions {
  readonly api: AttemptApi;
  readonly editor: RefObject<RobotEditorHandle | null>;
  readonly session: AuthSession;
  readonly configurationAvailable?: boolean;
  readonly authPaused?: boolean;
  readonly accessState?: 'ready' | 'checking' | 'required';
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onTryAvailabilityChange?: (available: boolean) => void;
  readonly onAuthRequired?: ApiAuthRequired;
  readonly onReturnToEditor?: () => void;
  readonly surface?: 'preparar' | 'historial' | 'mis-robots';
}

export interface AttemptActivityController {
  readonly busy: boolean;
  readonly foreground: boolean;
  readonly resultVisible: boolean;
  readonly queryVisible: boolean;
  readonly historyResultOpen: boolean;
  readonly configurationOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly historyQueryOpen: boolean;
  readonly tryAvailable: boolean;
  readonly controls: ReactNode;
  readonly view: ReactNode;
  readonly historyView: ReactNode;
  readonly historyResultView: ReactNode;
  readonly configurationView: ReactNode;
  readonly inspectorView: ReactNode;
  readonly start: () => void;
  readonly returnToEditor: () => void;
  readonly leaveResultPresentation: () => void;
}

export interface AttemptActivityHandle {
  start(): void;
}

const ACTIVE_STATUSES: readonly AttemptStatus[] = ['pending', 'running'];

function isActive(status: AttemptStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function cancelEditorApplication(editor: RefObject<RobotEditorHandle | null>): void {
  editor.current?.cancelApplication?.();
}

function releaseEditorAttemptLock(editor: RefObject<RobotEditorHandle | null>): void {
  editor.current?.releaseAttemptLock?.();
}

function captureEditorSnapshot(editor: RefObject<RobotEditorHandle | null>) {
  return editor.current?.captureSnapshot();
}

function statusDescription(status: AttemptStatus): string {
  switch (status) {
    case 'pending':
      return 'El servidor recibió el intento y va a iniciar el cálculo.';
    case 'running':
      return 'El agente está tomando decisiones. Podés cancelar el cálculo.';
    case 'victory':
      return 'El robot llegó a la salida del recorrido.';
    case 'defeat':
      return 'El robot encontró un obstáculo incompatible.';
    case 'incomplete':
      return 'Se alcanzó el límite de turnos sin llegar a la salida.';
    case 'cancelled':
      return 'La ejecución se interrumpió por pedido de la persona.';
    case 'error':
      return 'El proveedor o la respuesta no pudo completar el contrato.';
  }
}

type PlaybackKind = 'automatic' | 'manual';

function needsAutomaticPresentation(attempt: AttemptSummary): boolean {
  return (
    isTerminal(attempt.status) &&
    attempt.animationEnabled &&
    !attempt.presentationComplete &&
    attempt.turnsUsed > 0
  );
}

function makeRequestKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function attemptErrorMessage(error: unknown): string {
  if (error instanceof AttemptApiFailure) return error.message;
  return 'No se pudo consultar el intento. Podés reintentar.';
}

function isAuthenticationFailure(error: unknown): error is AttemptApiFailure {
  return error instanceof AttemptApiFailure && error.code === 'authentication';
}

export function useAttemptActivity({
  api,
  editor,
  session,
  configurationAvailable = true,
  authPaused = false,
  accessState = 'checking',
  onBusyChange,
  onTryAvailabilityChange,
  onAuthRequired,
  onReturnToEditor,
  surface = 'historial',
}: AttemptActivityOptions): AttemptActivityController {
  const [mode, setMode] = useState<WorkspaceMode>('loading');
  const [attempt, setAttempt] = useState<AttemptSummary | null>(null);
  const [error, setError] = useState<WorkspaceError | null>(null);
  const [historyResultOpen, setHistoryResultOpen] = useState(false);
  const [activeCandidates, setActiveCandidates] = useState<readonly AttemptSummary[]>([]);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [replayRecord, setReplayRecord] = useState<ReplayRecordView | null>(null);
  const [playbackKind, setPlaybackKind] = useState<PlaybackKind | null>(null);
  const generationRef = useRef(0);
  const frozenRef = useRef<FrozenAdmission | null>(null);
  const attemptRef = useRef<AttemptSummary | null>(null);
  const activityBusyRef = useRef(false);
  const modeRef = useRef(mode);
  const startLockRef = useRef(false);
  const operationEpochRef = useRef(0);
  const cancelOperationRef = useRef(0);
  const cancelBusyRef = useRef(false);
  const replayEpochRef = useRef(0);
  const recoveryControllerRef = useRef<AbortController | null>(null);
  const sessionSub = session.identity.sub;
  const clearActivityPresentation = useCallback((): void => {
    setHistoryResultOpen(false);
    setMode((current) => (current === 'result' ? 'idle' : current));
    setError(null);
  }, []);
  const onHistoryConfigurationApplied = useCallback((): void => {
    clearActivityPresentation();
    onReturnToEditor?.();
  }, [clearActivityPresentation, onReturnToEditor]);
  const activityHistoryVisible =
    surface === 'historial' &&
    (mode === 'loading' || mode === 'idle' || mode === 'result') &&
    !historyResultOpen;
  const historyOwner = useAttemptHistory({
    api,
    identity: sessionSub,
    currentAttempt: attemptRef,
    historyVisible: activityHistoryVisible,
    surface,
    editor,
    configurationAvailable,
    authPaused,
    activityBusy: activityBusyRef,
    onAuthRequired,
    onReturnToEditor: onReturnToEditor ? onHistoryConfigurationApplied : undefined,
  });
  const {
    history,
    historyView,
    historyCursor,
    historyError,
    loadingHistory,
    historyRecovering,
    historyRecoveryMessage,
    invalidHistoryCursor,
    resultQuery,
    loadBootstrapPage,
    refreshHistory,
    loadMore,
    updateHistory,
    selectHistoryView,
    rememberHistoryOrigin,
    restoreHistoryOrigin,
    forgetHistoryOrigin,
    updateSummaryById,
    configurationState,
    decisionInspectorTarget,
    decisionInspectorSelection,
    decisionInspectorOpenVersion,
    queryVisible,
    openConfiguration,
    applyConfiguration,
    closeConfiguration,
    clearConfiguration,
    openDecisionInspector: openHistoryDecisionInspector,
    openDecisionInspectorFromHistory,
    clearDecisionInspector,
    handleDecisionInspectorAuthRequired,
    openResult: openHistoryResult,
    closeResult,
    handoffResultToActivity,
  } = historyOwner;

  const leaveResultPresentation = useCallback((): void => {
    clearConfiguration();
    clearDecisionInspector(false);
    if (resultQuery) handoffResultToActivity(resultQuery.targetId);
    clearActivityPresentation();
  }, [
    clearActivityPresentation,
    clearConfiguration,
    clearDecisionInspector,
    handoffResultToActivity,
    resultQuery,
  ]);

  const returnToEditor = useCallback((): void => {
    leaveResultPresentation();
    forgetHistoryOrigin();
    onReturnToEditor?.();
  }, [forgetHistoryOrigin, leaveResultPresentation, onReturnToEditor]);

  const returnToHistory = useCallback((): void => {
    setHistoryResultOpen(false);
    setMode('idle');
    setError(null);
    restoreHistoryOrigin();
  }, [restoreHistoryOrigin]);

  const onPresentationConfirmed = useCallback(
    (completed: AttemptSummary): void => {
      const recovery = readAttemptRecovery(sessionSub);
      if (recovery?.attemptId === completed.id) clearAttemptRecovery(sessionSub);
      if (attemptRef.current?.id === completed.id) {
        attemptRef.current = completed;
        setAttempt(completed);
      }
      updateSummaryById(completed);
    },
    [sessionSub, updateSummaryById],
  );
  const {
    register: registerPresentationAcknowledgement,
    observe: observePresentationAcknowledgement,
    states: presentationAcknowledgementStates,
  } = usePresentationAcknowledgements({
    api,
    identity: sessionSub,
    authPaused,
    onAuthRequired,
    onConfirmed: onPresentationConfirmed,
  });
  const animationPreference = useAnimationPreference({
    api,
    identity: sessionSub,
    authPaused,
    onAuthRequired,
  });
  const quotaController = useQuota({
    api,
    identity: sessionSub,
    authPaused,
    onAuthRequired,
  });
  const quota = quotaController.quota;
  const isQuotaAvailableNow = quotaController.isAvailableNow;
  const refreshQuotaAfterAdmission = quotaController.refreshAfterAdmission;
  const isPreferenceReadyNow = animationPreference.isReadyNow;
  const confirmedAnimationValueNow = animationPreference.confirmedValueNow;
  const authPausedRef = useRef(authPaused);
  const currentSessionSubRef = useRef(sessionSub);
  const initializedSubRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    authPausedRef.current = authPaused;
    currentSessionSubRef.current = sessionSub;
  }, [authPaused, sessionSub]);
  const startServerAttemptRef = useRef<
    (
      admission: AttemptAdmission,
      operationGeneration: number,
      operationEpoch: number,
    ) => Promise<void>
  >(async () => undefined);
  const sessionSubRef = useRef(sessionSub);
  const resetCancelBusy = useCallback((): void => {
    cancelOperationRef.current += 1;
    cancelBusyRef.current = false;
    setCancelBusy(false);
  }, []);
  useEffect(
    () => () => {
      generationRef.current += 1;
      cancelOperationRef.current += 1;
      cancelBusyRef.current = false;
      recoveryControllerRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const previousSub = sessionSubRef.current;
    if (previousSub !== sessionSub) {
      frozenRef.current = null;
      attemptRef.current = null;
      recoveryControllerRef.current?.abort();
      recoveryControllerRef.current = null;
      resetCancelBusy();
      clearAttemptRecovery(previousSub);
      replayEpochRef.current += 1;
      setReplayRecord(null);
      setPlaybackKind(null);
      sessionSubRef.current = sessionSub;
    }
  }, [resetCancelBusy, sessionSub]);

  useEffect(() => {
    attemptRef.current = attempt;
    modeRef.current = mode;
  }, [attempt, mode]);

  const busy =
    mode === 'loading' ||
    mode === 'admitting' ||
    mode === 'opening' ||
    mode === 'pending' ||
    mode === 'running' ||
    mode === 'canceling' ||
    mode === 'unknown' ||
    mode === 'selecting' ||
    mode === 'preparing-replay' ||
    mode === 'replaying';
  useLayoutEffect(() => {
    activityBusyRef.current = busy;
  }, [busy]);

  const preferenceReady = animationPreference.ready;
  const preferenceLoading = animationPreference.loading;
  const preferenceSaving = animationPreference.saving;
  const preferenceRecovering = animationPreference.recovering;
  const preferenceError = animationPreference.error;
  const preferenceConflict = animationPreference.conflict;
  const animationPreferenceUnknown = animationPreference.unknown;
  const animationEnabled = animationPreference.value;
  const preferenceRemoteValue = preferenceConflict?.remote.animationEnabled ?? null;
  const quotaCurrent = quotaController.current;
  const tryAvailable = preferenceReady && (!quotaCurrent || quota?.remaining !== 0);
  const tryAvailabilityMessage = preferenceSaving
    ? 'Confirmando tu preferencia de animación. Podés seguir preparando el robot.'
    : !preferenceReady && (preferenceError === null || preferenceRecovering)
      ? 'Estamos recuperando tu preferencia de animación. Podés seguir preparando el robot.'
      : preferenceConflict !== null
        ? ''
        : quotaCurrent && quota?.remaining === 0
          ? 'No quedan partidas disponibles.'
          : !quotaCurrent
            ? 'Disponibilidad sin confirmar. La comprobamos al iniciar.'
            : quotaController.recovering
              ? 'La cuota está en comprobación.'
              : '';

  const isTryAvailableNow = useCallback(
    (): boolean => isPreferenceReadyNow() && isQuotaAvailableNow(),
    [isPreferenceReadyNow, isQuotaAvailableNow],
  );

  useEffect(() => {
    onBusyChange?.(busy);
    if (!busy) {
      startLockRef.current = false;
    }
  }, [busy, onBusyChange]);

  useEffect(() => {
    onTryAvailabilityChange?.(tryAvailable);
  }, [onTryAvailabilityChange, tryAvailable]);

  const beginReplay = useCallback(
    async (target: AttemptSummary, kind: PlaybackKind): Promise<void> => {
      clearConfiguration();
      cancelEditorApplication(editor);
      if (kind === 'manual' && target.turnsUsed === 0) {
        setReplayRecord(null);
        setPlaybackKind(null);
        setMode('result');
        return;
      }
      const generation = generationRef.current;
      const epoch = ++replayEpochRef.current;
      setPlaybackKind(kind);
      setReplayRecord(null);
      clearDecisionInspector(false);
      setError(null);
      if (kind === 'automatic' && !target.recordComplete) {
        setMode('replay-error');
        setError(
          workspaceError(
            'El registro está incompleto y no se puede reproducir sin omitir acciones.',
            'replay',
          ),
        );
        return;
      }
      setMode('preparing-replay');
      try {
        const record = await api.getReplay(target.id);
        if (
          generationRef.current !== generation ||
          replayEpochRef.current !== epoch ||
          record.id !== target.id ||
          !record.closure.recordComplete ||
          record.closure.status !== target.status ||
          record.closure.actionCount !== record.actions.length ||
          record.actions.length !== target.turnsUsed
        ) {
          throw new AttemptApiFailure(
            'server',
            'El registro recibido no coincide con el intento guardado.',
          );
        }
        setReplayRecord(record);
      } catch (replayFailure) {
        if (generationRef.current !== generation || replayEpochRef.current !== epoch) return;
        if (isAuthenticationFailure(replayFailure)) {
          onAuthRequired?.(replayFailure.authContext);
        }
        setError(
          workspaceError(
            replayFailure instanceof AttemptApiFailure
              ? replayFailure.message
              : 'No se pudo cargar una reproducción completa. El resultado original sigue guardado.',
            'replay',
          ),
        );
        setMode('replay-error');
      }
    },
    [api, clearConfiguration, clearDecisionInspector, editor, onAuthRequired],
  );

  const applyAttempt = useCallback(
    (next: AttemptSummary, options: { clearRequest?: boolean } = {}): void => {
      const sameAttempt = attemptRef.current?.id === next.id;
      if (attemptRef.current && !sameAttempt) {
        resetCancelBusy();
        clearDecisionInspector(false);
        clearConfiguration();
      }
      observePresentationAcknowledgement(next);
      attemptRef.current = next;
      setAttempt(next);
      updateSummaryById(next);
      if (needsAutomaticPresentation(next)) {
        frozenRef.current = null;
        writeAttemptRecovery({ sub: sessionSub, attemptId: next.id });
      } else if ((options.clearRequest ?? true) || isTerminal(next.status)) {
        frozenRef.current = null;
        clearAttemptRecovery(sessionSub);
      } else {
        const frozen = frozenRef.current;
        writeAttemptRecovery({
          sub: sessionSub,
          attemptId: next.id,
          ...(frozen ?? {}),
        });
      }
      setError(null);
      if (needsAutomaticPresentation(next)) {
        void beginReplay(next, 'automatic');
      } else {
        setReplayRecord(null);
        setPlaybackKind(null);
        setMode(
          isTerminal(next.status)
            ? 'result'
            : next.cancelRequested
              ? 'canceling'
              : next.status === 'pending' || next.status === 'running'
                ? next.status
                : 'unknown',
        );
      }
    },
    [
      beginReplay,
      clearConfiguration,
      clearDecisionInspector,
      observePresentationAcknowledgement,
      resetCancelBusy,
      sessionSub,
      updateSummaryById,
    ],
  );

  const retryPendingStart = useCallback(
    async (
      pending: AttemptSummary,
      options: {
        readonly signal?: AbortSignal;
        readonly operationGeneration: number;
        readonly operationEpoch: number;
      },
    ): Promise<AttemptAdmission | null> => {
      if (
        options.signal?.aborted ||
        generationRef.current !== options.operationGeneration ||
        operationEpochRef.current !== options.operationEpoch
      ) {
        return null;
      }
      if (authPausedRef.current) {
        frozenRef.current = null;
        applyAttempt(pending, { clearRequest: false });
        setError(
          workspaceError(
            'El inicio quedó pendiente mientras se recupera la sesión. Pulsá Comprobar estado cuando vuelva a estar disponible.',
            'check-status',
          ),
        );
        setMode('unknown');
        return null;
      }
      if (pending.status !== 'pending' || pending.cancelRequested) {
        frozenRef.current = null;
        applyAttempt(pending, { clearRequest: false });
        return null;
      }
      frozenRef.current = null;
      applyAttempt(pending, { clearRequest: false });
      setMode('admitting');
      try {
        const started = await api.startAttempt(pending.id, options.signal);
        if (
          options.signal?.aborted ||
          generationRef.current !== options.operationGeneration ||
          operationEpochRef.current !== options.operationEpoch
        ) {
          return null;
        }
        const stillNeedsStart =
          !started.dispatchConfirmed &&
          started.attempt.status === 'pending' &&
          !started.attempt.cancelRequested;
        applyAttempt(started.attempt, { clearRequest: false });
        if (stillNeedsStart) {
          setError(
            workspaceError(
              'No pudimos confirmar el inicio del intento. Pulsá Comprobar estado para volver a intentar el mismo inicio.',
              'check-status',
            ),
          );
          setMode('unknown');
        }
        return started;
      } catch (startError) {
        if (
          options.signal?.aborted ||
          generationRef.current !== options.operationGeneration ||
          operationEpochRef.current !== options.operationEpoch
        ) {
          return null;
        }
        setError(workspaceError(attemptErrorMessage(startError), 'check-status'));
        setMode('unknown');
        if (isAuthenticationFailure(startError)) {
          onAuthRequired?.(startError.authContext);
        }
        return null;
      }
    },
    [api, applyAttempt, onAuthRequired],
  );

  const handoffHistoryActivityTarget = useCallback(
    (target: AttemptSummary, signal: AbortSignal): boolean => {
      if (signal.aborted) return false;
      if (!isActive(target.status) && !needsAutomaticPresentation(target)) return false;
      setHistoryResultOpen(true);
      clearConfiguration();
      clearDecisionInspector(false);
      cancelEditorApplication(editor);
      const operationGeneration = generationRef.current;
      const operationEpoch = ++operationEpochRef.current;
      if (target.status === 'pending' && !target.cancelRequested) {
        recoveryControllerRef.current?.abort();
        const controller = new AbortController();
        recoveryControllerRef.current = controller;
        void retryPendingStart(target, {
          signal: controller.signal,
          operationGeneration,
          operationEpoch,
        });
      } else {
        applyAttempt(target, { clearRequest: false });
      }
      return true;
    },
    [applyAttempt, clearConfiguration, clearDecisionInspector, editor, retryPendingStart],
  );

  const listAllAttempts = useCallback(
    async (signal?: AbortSignal): Promise<readonly AttemptSummary[]> => {
      const all: AttemptSummary[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api.listAttempts(cursor, signal);
        all.push(...page.attempts);
        if (!page.nextCursor || seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      return all;
    },
    [api],
  );

  const discoverActiveAttempts = useCallback(
    async (signal?: AbortSignal, operationEpoch?: number): Promise<boolean> => {
      const operationGeneration = generationRef.current;
      const all = await listAllAttempts(signal);
      if (
        signal?.aborted ||
        generationRef.current !== operationGeneration ||
        (operationEpoch !== undefined && operationEpochRef.current !== operationEpoch)
      ) {
        return false;
      }
      const active = all.filter((item) => isActive(item.status));
      if (attemptRef.current) resetCancelBusy();
      attemptRef.current = null;
      setAttempt(null);
      setActiveCandidates([]);
      if (active.length === 1) {
        const candidate = active[0];
        if (candidate.status === 'pending' && !candidate.cancelRequested) {
          await retryPendingStart(candidate, {
            signal,
            operationGeneration,
            operationEpoch: operationEpoch ?? operationEpochRef.current,
          });
        } else {
          applyAttempt(candidate, { clearRequest: false });
        }
      } else if (active.length > 1) {
        setActiveCandidates(active);
        setMode('selecting');
      } else {
        setMode('idle');
      }
      return true;
    },
    [applyAttempt, listAllAttempts, resetCancelBusy, retryPendingStart],
  );

  const retryFrozenAdmission = useCallback(
    async (
      frozen: FrozenAdmission,
      options: {
        readonly signal?: AbortSignal;
        readonly operationGeneration: number;
        readonly operationEpoch: number;
      },
    ): Promise<boolean> => {
      if (
        options.signal?.aborted ||
        generationRef.current !== options.operationGeneration ||
        operationEpochRef.current !== options.operationEpoch
      ) {
        return false;
      }
      if (authPausedRef.current) {
        frozenRef.current = frozen;
        writeAttemptRecovery({
          sub: sessionSub,
          requestKey: frozen.requestKey,
          expectedVersion: frozen.expectedVersion,
          draft: frozen.draft,
          animationEnabled: frozen.animationEnabled,
        });
        setError(
          workspaceError(
            'La recuperación quedó pendiente mientras se recupera la sesión. Pulsá Comprobar estado cuando vuelva a estar disponible.',
            'check-status',
          ),
        );
        setMode('unknown');
        return true;
      }
      setMode('admitting');
      try {
        const admission = await api.createAttempt(
          frozen.requestKey,
          frozen.expectedVersion,
          frozen.draft,
          frozen.animationEnabled,
          options.signal,
        );
        if (
          options.signal?.aborted ||
          generationRef.current !== options.operationGeneration ||
          operationEpochRef.current !== options.operationEpoch
        ) {
          return false;
        }
        frozenRef.current = null;
        await startServerAttemptRef.current(
          admission,
          options.operationGeneration,
          options.operationEpoch,
        );
        return true;
      } catch (retryError) {
        if (
          options.signal?.aborted ||
          generationRef.current !== options.operationGeneration ||
          operationEpochRef.current !== options.operationEpoch
        ) {
          return false;
        }
        // A retry result only describes this retry. The original request can
        // still commit after a gateway or quota rejection, so keep its exact
        // key and snapshot available for the next same-key check.
        frozenRef.current = frozen;
        writeAttemptRecovery({
          sub: sessionSub,
          requestKey: frozen.requestKey,
          expectedVersion: frozen.expectedVersion,
          draft: frozen.draft,
          animationEnabled: frozen.animationEnabled,
        });
        setError(
          workspaceError(
            retryError instanceof AttemptApiFailure && retryError.ambiguous
              ? 'No pudimos confirmar si comenzó el intento. Pulsá Comprobar estado para consultar el mismo intento.'
              : attemptErrorMessage(retryError),
            'check-status',
          ),
        );
        setMode('unknown');
        if (isAuthenticationFailure(retryError)) {
          onAuthRequired?.(retryError.authContext);
        }
        return true;
      }
    },
    [api, onAuthRequired, sessionSub],
  );

  const rediscoverAfterMissingRecovery = useCallback(
    async (signal?: AbortSignal, operationEpoch?: number): Promise<boolean> => {
      const operationGeneration = generationRef.current;
      clearAttemptRecovery(sessionSub);
      frozenRef.current = null;
      try {
        return await discoverActiveAttempts(signal, operationEpoch);
      } catch (discoveryError) {
        if (
          signal?.aborted ||
          generationRef.current !== operationGeneration ||
          (operationEpoch !== undefined && operationEpochRef.current !== operationEpoch)
        ) {
          return false;
        }
        if (isAuthenticationFailure(discoveryError)) {
          onAuthRequired?.(discoveryError.authContext);
        }
        setError(workspaceError(attemptErrorMessage(discoveryError), 'check-status'));
        setMode('unknown');
        return true;
      }
    },
    [discoverActiveAttempts, onAuthRequired, sessionSub],
  );

  const recoverKnownAttempt = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      const storedReference = readAttemptRecovery(sessionSub);
      const selected = selectRecoveryReference(
        sessionSub,
        storedReference,
        frozenRef.current,
        attemptRef.current,
      );
      if (!selected) return false;
      const { reference, frozen } = selected;
      if (frozen && !frozenRef.current) frozenRef.current = frozen;
      try {
        const next = reference.attemptId
          ? await api.getAttempt(reference.attemptId, signal)
          : reference.requestKey
            ? await api.getAttemptRequest(reference.requestKey, signal)
            : null;
        if (!next || signal?.aborted) return false;
        if (next.status === 'pending' && !next.cancelRequested) {
          await retryPendingStart(next, {
            signal,
            operationGeneration: generationRef.current,
            operationEpoch: operationEpochRef.current,
          });
          return !signal?.aborted;
        }
        frozenRef.current = null;
        applyAttempt(next, { clearRequest: isTerminal(next.status) });
        return true;
      } catch (recoveryError) {
        if (signal?.aborted) return false;
        if (isAuthenticationFailure(recoveryError)) {
          onAuthRequired?.(recoveryError.authContext);
        }
        if (recoveryError instanceof AttemptApiFailure && recoveryError.code === 'not_found') {
          if (reference.requestKey && !reference.attemptId && frozen) {
            return retryFrozenAdmission(frozen, {
              signal,
              operationGeneration: generationRef.current,
              operationEpoch: operationEpochRef.current,
            });
          }
          if (reference.requestKey && !reference.attemptId) {
            setError(
              workspaceError(
                'No pudimos recuperar la configuración usada para iniciar el intento. Podés comprobar si llegó a comenzar.',
                'check-status',
              ),
            );
            setMode('unknown');
            return true;
          }
          if (reference.attemptId) return rediscoverAfterMissingRecovery(signal);
          return false;
        }
        setError(workspaceError(attemptErrorMessage(recoveryError), 'check-status'));
        setMode('unknown');
        return true;
      }
    },
    [
      api,
      applyAttempt,
      onAuthRequired,
      rediscoverAfterMissingRecovery,
      retryPendingStart,
      retryFrozenAdmission,
      sessionSub,
    ],
  );

  const bootstrapActionsRef = useRef({
    loadBootstrapPage,
    recoverKnownAttempt,
    discoverActiveAttempts,
    onAuthRequired,
  });
  useLayoutEffect(() => {
    bootstrapActionsRef.current = {
      loadBootstrapPage,
      recoverKnownAttempt,
      discoverActiveAttempts,
      onAuthRequired,
    };
  }, [discoverActiveAttempts, loadBootstrapPage, onAuthRequired, recoverKnownAttempt]);
  useEffect(() => {
    if (initializedSubRef.current === sessionSub) return undefined;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    let bootstrapComplete = false;
    void (async () => {
      try {
        await Promise.resolve();
        setMode('loading');
        setAttempt(null);
        setActiveCandidates([]);
        setError(null);
        await bootstrapActionsRef.current.loadBootstrapPage(
          controller.signal,
          () => generationRef.current === generation,
        );
        if (await bootstrapActionsRef.current.recoverKnownAttempt(controller.signal)) return;
        await bootstrapActionsRef.current.discoverActiveAttempts(controller.signal);
      } catch (initialError) {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        if (isAuthenticationFailure(initialError)) {
          bootstrapActionsRef.current.onAuthRequired?.(initialError.authContext);
        }
        setError(workspaceError(attemptErrorMessage(initialError)));
        setMode('unknown');
      } finally {
        if (!controller.signal.aborted && generationRef.current === generation) {
          initializedSubRef.current = sessionSub;
          bootstrapComplete = true;
        }
      }
    })();
    return () => {
      controller.abort();
      if (!bootstrapComplete && generationRef.current === generation) {
        generationRef.current += 1;
      }
    };
  }, [sessionSub]);

  const startServerAttempt = useCallback(
    async (
      admission: AttemptAdmission,
      operationGeneration: number,
      operationEpoch: number,
    ): Promise<void> => {
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      let next = admission.attempt;
      if (!admission.dispatchConfirmed && next.status === 'pending' && !next.cancelRequested) {
        const started = await retryPendingStart(next, {
          operationGeneration,
          operationEpoch,
        });
        if (!started) return;
        next = started.attempt;
      } else {
        frozenRef.current = null;
        applyAttempt(next, { clearRequest: false });
      }
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      if (isTerminal(next.status) && next.presentationComplete) {
        clearAttemptRecovery(sessionSub);
      }
      await refreshQuotaAfterAdmission();
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch ||
        currentSessionSubRef.current !== sessionSub ||
        authPausedRef.current
      ) {
        return;
      }
      await refreshHistory();
    },
    [applyAttempt, refreshQuotaAfterAdmission, refreshHistory, retryPendingStart, sessionSub],
  );
  useEffect(() => {
    startServerAttemptRef.current = startServerAttempt;
  }, [startServerAttempt]);

  const start = useCallback(async (): Promise<void> => {
    if (!isTryAvailableNow()) {
      if (!busy && !startLockRef.current && modeRef.current !== 'admitting') {
        releaseEditorAttemptLock(editor);
      }
      return;
    }
    clearConfiguration();
    cancelEditorApplication(editor);
    if (
      startLockRef.current ||
      busy ||
      authPaused ||
      (modeRef.current === 'result' && attemptRef.current?.status === 'running')
    ) {
      return;
    }
    startLockRef.current = true;
    clearDecisionInspector(false);
    const frozenAnimationEnabled = confirmedAnimationValueNow();
    if (frozenAnimationEnabled === null) {
      startLockRef.current = false;
      releaseEditorAttemptLock(editor);
      return;
    }
    operationEpochRef.current += 1;
    const operationGeneration = generationRef.current;
    const operationEpoch = operationEpochRef.current;
    const requestKey = makeRequestKey();
    setHistoryResultOpen(false);
    const foregroundRecovery = readAttemptRecovery(sessionSub);
    setMode('admitting');
    setError(null);
    let snapshot;
    try {
      snapshot = await captureEditorSnapshot(editor);
    } catch (captureError) {
      snapshot = null;
      setError(workspaceError(attemptErrorMessage(captureError)));
    }
    if (!snapshot) {
      setMode('idle');
      startLockRef.current = false;
      setError(
        (current) =>
          current ??
          workspaceError(
            'No se pudo confirmar la configuración visible. Revisá el guardado y reintentá.',
          ),
      );
      return;
    }
    if (
      generationRef.current !== operationGeneration ||
      operationEpochRef.current !== operationEpoch
    ) {
      return;
    }
    if (!isTryAvailableNow()) {
      setMode('idle');
      startLockRef.current = false;
      releaseEditorAttemptLock(editor);
      return;
    }
    frozenRef.current = {
      requestKey,
      expectedVersion: snapshot.version,
      draft: snapshot.draft,
      animationEnabled: frozenAnimationEnabled,
    };
    writeAttemptRecovery({
      sub: sessionSub,
      requestKey,
      expectedVersion: snapshot.version,
      draft: snapshot.draft,
      animationEnabled: frozenAnimationEnabled,
    });
    try {
      const admission = await api.createAttempt(
        requestKey,
        snapshot.version,
        snapshot.draft,
        frozenAnimationEnabled,
      );
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      await startServerAttempt(admission, operationGeneration, operationEpoch);
    } catch (admissionError) {
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      if (admissionError instanceof AttemptApiFailure && admissionError.ambiguous) {
        setError(
          workspaceError(
            'No pudimos confirmar si comenzó el intento. Pulsá Comprobar estado para consultar el mismo intento.',
            'check-status',
          ),
        );
        setMode('unknown');
        return;
      }
      if (admissionError instanceof AttemptApiFailure && admissionError.code === 'authentication') {
        setError(workspaceError(admissionError.message, 'check-status'));
        setMode('unknown');
        onAuthRequired?.(admissionError.authContext);
        return;
      }
      const currentRecovery = readAttemptRecovery(sessionSub);
      if (currentRecovery?.requestKey === requestKey) {
        if (foregroundRecovery) writeAttemptRecovery(foregroundRecovery);
        else clearAttemptRecovery(sessionSub);
      } else if (!currentRecovery && !foregroundRecovery) {
        clearAttemptRecovery(sessionSub);
      }
      frozenRef.current = null;
      setMode('idle');
      startLockRef.current = false;
      setError(
        workspaceError(attemptErrorMessage(admissionError), admissionErrorGuidance(admissionError)),
      );
      if (admissionError instanceof AttemptApiFailure && admissionError.code === 'quota_exceeded') {
        void refreshQuotaAfterAdmission();
      }
      if (isAuthenticationFailure(admissionError)) {
        onAuthRequired?.(admissionError.authContext);
      }
    }
  }, [
    api,
    authPaused,
    busy,
    clearDecisionInspector,
    editor,
    clearConfiguration,
    isTryAvailableNow,
    confirmedAnimationValueNow,
    onAuthRequired,
    refreshQuotaAfterAdmission,
    sessionSub,
    startServerAttempt,
  ]);

  const resolveUnknown = useCallback(async (): Promise<void> => {
    recoveryControllerRef.current?.abort();
    const controller = new AbortController();
    recoveryControllerRef.current = controller;
    const operationGeneration = generationRef.current;
    operationEpochRef.current += 1;
    const operationEpoch = operationEpochRef.current;
    setError(null);
    const storedReference = readAttemptRecovery(sessionSub);
    const selected = selectRecoveryReference(
      sessionSub,
      storedReference,
      frozenRef.current,
      attemptRef.current,
    );
    if (!selected) {
      await rediscoverAfterMissingRecovery(controller.signal, operationEpoch);
      return;
    }
    const { reference, frozen } = selected;
    if (frozen && !frozenRef.current) frozenRef.current = frozen;
    try {
      const found = reference.attemptId
        ? await api.getAttempt(reference.attemptId, controller.signal)
        : reference.requestKey
          ? await api.getAttemptRequest(reference.requestKey, controller.signal)
          : null;
      if (found) {
        if (
          generationRef.current !== operationGeneration ||
          operationEpochRef.current !== operationEpoch
        ) {
          return;
        }
        if (found.status === 'pending' && !found.cancelRequested) {
          await retryPendingStart(found, {
            signal: controller.signal,
            operationGeneration,
            operationEpoch,
          });
          return;
        }
        frozenRef.current = null;
        applyAttempt(found, { clearRequest: isTerminal(found.status) });
        return;
      }
    } catch (lookupError) {
      if (controller.signal.aborted) return;
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      if (!(lookupError instanceof AttemptApiFailure && lookupError.code === 'not_found')) {
        setError(workspaceError(attemptErrorMessage(lookupError), 'check-status'));
        if (isAuthenticationFailure(lookupError)) {
          onAuthRequired?.(lookupError.authContext);
        }
        return;
      }
    }
    if (reference.attemptId || !frozen || !reference.requestKey) {
      if (reference.attemptId) {
        await rediscoverAfterMissingRecovery(controller.signal, operationEpoch);
        return;
      }
      setError(
        workspaceError(
          'Todavía no se puede confirmar este intento. Volvé a consultar más tarde.',
          'check-status',
        ),
      );
      return;
    }
    await retryFrozenAdmission(frozen, {
      signal: controller.signal,
      operationGeneration,
      operationEpoch,
    });
  }, [
    api,
    applyAttempt,
    onAuthRequired,
    rediscoverAfterMissingRecovery,
    retryFrozenAdmission,
    retryPendingStart,
    sessionSub,
  ]);

  const cancel = useCallback(async (): Promise<void> => {
    const current = attemptRef.current;
    if (
      !current ||
      (!isActive(current.status) && !current.cancelRequested) ||
      cancelBusyRef.current
    ) {
      return;
    }
    const operationGeneration = generationRef.current;
    const operationEpoch = ++operationEpochRef.current;
    const cancelOperation = ++cancelOperationRef.current;
    cancelBusyRef.current = true;
    setCancelBusy(true);
    setMode('canceling');
    try {
      const response = await api.cancelAttempt(current.id);
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      applyAttempt(response, { clearRequest: false });
    } catch (cancelError) {
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      if (isAuthenticationFailure(cancelError)) {
        onAuthRequired?.(cancelError.authContext);
      }
      setMode('unknown');
      setError(workspaceError(attemptErrorMessage(cancelError), 'check-status'));
    } finally {
      if (cancelOperationRef.current === cancelOperation) {
        cancelBusyRef.current = false;
        setCancelBusy(false);
      }
    }
  }, [api, applyAttempt, onAuthRequired]);

  const openReplayFromHistory = useCallback(
    async (id: string): Promise<void> => {
      if (busy) return;
      rememberHistoryOrigin(id, 'replay');
      setHistoryResultOpen(true);
      const next = history.find((item) => item.id === id);
      if (!next) {
        setHistoryResultOpen(false);
        setError(
          workspaceError(
            'No se encontró ese intento en el historial. Volvé a cargar las consultas.',
          ),
        );
        return;
      }
      if (!isTerminal(next.status) || !next.recordComplete) {
        setHistoryResultOpen(false);
        setError(
          workspaceError('Este intento todavía no tiene un registro cerrado para reproducir.'),
        );
        return;
      }
      handoffResultToActivity(id);
      operationEpochRef.current += 1;
      clearDecisionInspector(false);
      clearConfiguration();
      cancelEditorApplication(editor);
      if (attemptRef.current && attemptRef.current.id !== next.id) {
        resetCancelBusy();
        setPlaybackKind(null);
      }
      attemptRef.current = next;
      setAttempt(next);
      updateSummaryById(next);
      setError(null);
      if (needsAutomaticPresentation(next) || next.turnsUsed === 0) {
        applyAttempt(next, { clearRequest: false });
      } else {
        await beginReplay(next, 'manual');
      }
    },
    [
      applyAttempt,
      beginReplay,
      busy,
      clearConfiguration,
      clearDecisionInspector,
      editor,
      history,
      handoffResultToActivity,
      rememberHistoryOrigin,
      resetCancelBusy,
      updateSummaryById,
    ],
  );

  const replayCurrentAttempt = useCallback((): void => {
    const current = attemptRef.current;
    if (
      !current ||
      busy ||
      !isTerminal(current.status) ||
      !current.recordComplete ||
      current.turnsUsed === 0
    ) {
      return;
    }
    void beginReplay(current, 'manual');
  }, [beginReplay, busy]);

  const openDecisionInspectorForCurrent = useCallback(
    (selection: DecisionInitialSelection): void => {
      const current = attemptRef.current;
      if (current) openHistoryDecisionInspector(current, selection);
    },
    [openHistoryDecisionInspector],
  );

  const retryReplay = useCallback((): void => {
    const current = attemptRef.current;
    if (!current || busy) return;
    if (playbackKind === 'automatic' && !current.recordComplete) {
      const generation = generationRef.current;
      const operationEpoch = ++operationEpochRef.current;
      const id = current.id;
      setMode('opening');
      setError(null);
      void api
        .getAttempt(id)
        .then((refreshed) => {
          if (
            generationRef.current !== generation ||
            operationEpochRef.current !== operationEpoch ||
            attemptRef.current?.id !== id
          ) {
            return;
          }
          if (refreshed.id !== id) {
            setError(
              workspaceError(
                'El intento consultado no coincide con el resultado abierto.',
                'replay',
              ),
            );
            setMode('replay-error');
            return;
          }
          attemptRef.current = refreshed;
          setAttempt(refreshed);
          updateSummaryById(refreshed);
          if (!isTerminal(refreshed.status)) {
            applyAttempt(refreshed, { clearRequest: false });
            return;
          }
          if (!refreshed.recordComplete) {
            setError(
              workspaceError(
                'El registro sigue incompleto. Podés volver a intentarlo o ver el resultado guardado.',
                'replay',
              ),
            );
            setMode('replay-error');
            return;
          }
          if (needsAutomaticPresentation(refreshed)) {
            void beginReplay(refreshed, 'automatic');
          } else {
            applyAttempt(refreshed, { clearRequest: false });
          }
        })
        .catch((refreshError: unknown) => {
          if (
            generationRef.current !== generation ||
            operationEpochRef.current !== operationEpoch ||
            attemptRef.current?.id !== id
          ) {
            return;
          }
          if (isAuthenticationFailure(refreshError)) {
            onAuthRequired?.(refreshError.authContext);
          }
          setError(workspaceError(attemptErrorMessage(refreshError), 'replay'));
          setMode('replay-error');
        });
      return;
    }
    void beginReplay(current, playbackKind ?? 'manual');
  }, [api, applyAttempt, beginReplay, busy, onAuthRequired, playbackKind, updateSummaryById]);

  const showResultAfterReplayError = useCallback((): void => {
    const current = attemptRef.current;
    if (!current || !isTerminal(current.status)) return;
    const shouldAcknowledge = playbackKind !== 'manual' && needsAutomaticPresentation(current);
    setReplayRecord(null);
    setPlaybackKind(null);
    setError(null);
    setMode('result');
    if (shouldAcknowledge) registerPresentationAcknowledgement(current);
  }, [playbackKind, registerPresentationAcknowledgement]);

  const replayAttemptId = replayRecord?.id;

  const onReplayReady = useCallback((): void => {
    if (!replayAttemptId || attemptRef.current?.id !== replayAttemptId) return;
    setMode((current) => (current === 'preparing-replay' ? 'replaying' : current));
  }, [replayAttemptId]);

  const onReplayComplete = useCallback((): void => {
    const current = attemptRef.current;
    if (!current || current.id !== replayAttemptId || !playbackKind) return;
    if (playbackKind === 'manual') {
      setReplayRecord(null);
      setPlaybackKind(null);
      setMode('result');
      return;
    }
    setReplayRecord(null);
    setPlaybackKind(null);
    setError(null);
    setMode('result');
    if (needsAutomaticPresentation(current)) registerPresentationAcknowledgement(current);
  }, [playbackKind, registerPresentationAcknowledgement, replayAttemptId]);

  const onReplayError = useCallback((): void => {
    if (!replayAttemptId || attemptRef.current?.id !== replayAttemptId) return;
    setReplayRecord(null);
    setError(workspaceError('No se pudo preparar la reproducción.', 'replay'));
    setMode('replay-error');
  }, [replayAttemptId]);

  useEffect(() => {
    if (
      !attempt ||
      (mode !== 'pending' && mode !== 'running' && mode !== 'canceling') ||
      authPaused
    ) {
      return undefined;
    }
    const controller = new AbortController();
    const operationEpoch = operationEpochRef.current;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await api.getAttempt(attempt.id, controller.signal);
        if (controller.signal.aborted || operationEpochRef.current !== operationEpoch) {
          return;
        }
        applyAttempt(next, { clearRequest: false });
        if (isActive(next.status) || next.cancelRequested) {
          timer = window.setTimeout(() => void poll(), 2_000);
        }
      } catch (pollError) {
        if (controller.signal.aborted || operationEpochRef.current !== operationEpoch) return;
        setMode('unknown');
        setError(workspaceError(attemptErrorMessage(pollError), 'check-status'));
        if (isAuthenticationFailure(pollError)) {
          onAuthRequired?.(pollError.authContext);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, applyAttempt, attempt, authPaused, mode, onAuthRequired]);

  const chooseActive = (next: AttemptSummary): void => {
    setActiveCandidates([]);
    const operationGeneration = generationRef.current;
    const operationEpoch = ++operationEpochRef.current;
    if (next.status === 'pending' && !next.cancelRequested) {
      recoveryControllerRef.current?.abort();
      const controller = new AbortController();
      recoveryControllerRef.current = controller;
      void retryPendingStart(next, {
        signal: controller.signal,
        operationGeneration,
        operationEpoch,
      });
    } else {
      applyAttempt(next, { clearRequest: false });
    }
  };

  const attemptControls = (
    <div className="attempt-controls" aria-label="Controles del intento">
      {quota && (
        <div
          className="quota-badge"
          aria-label={
            quotaCurrent
              ? `Cuota: ${quota.remaining} de ${quota.limit} intentos disponibles`
              : `Cuota anterior: ${quota.remaining} de ${quota.limit} intentos disponibles`
          }
        >
          <strong>{quota.remaining}</strong>
          <span>de {quota.limit} intentos disponibles</span>
          <small>Se renueva el {formatDateTime(quota.resetsAt)}</small>
          {!quotaCurrent && <small>Saldo anterior; cuota vigente sin confirmar.</small>}
        </div>
      )}

      <div className="animation-preference">
        <label htmlFor="animation-enabled">
          <input
            id="animation-enabled"
            type="checkbox"
            ref={(input) => {
              if (input) input.indeterminate = animationPreferenceUnknown;
            }}
            checked={animationPreferenceUnknown ? false : animationEnabled}
            aria-checked={animationPreferenceUnknown ? 'mixed' : animationEnabled}
            disabled={authPaused || busy || preferenceLoading}
            onChange={(event) => animationPreference.choose(event.currentTarget.checked)}
          />
          <span>Animación</span>
        </label>
        {(preferenceLoading || preferenceSaving) && (
          <span className="animation-preference-detail">
            {preferenceLoading ? 'Cargando preferencia guardada…' : 'Guardando preferencia…'}
          </span>
        )}
      </div>

      {preferenceConflict === null && (
        <>
          <span
            id="attempt-availability-status"
            className="attempt-availability-status"
            role={tryAvailabilityMessage ? 'status' : undefined}
            aria-live="polite"
          >
            {tryAvailabilityMessage}
          </span>
        </>
      )}

      {!quotaCurrent && quotaController.recovering && (
        <span className="attempt-availability-status" role="status" aria-live="polite">
          La cuota se vuelve a comprobar automáticamente.
        </span>
      )}

      {preferenceConflict && (
        <div className="attempt-preference-conflict" role="status">
          <p id="attempt-availability-status">
            {preferenceConflict.message}
            {` Valor guardado en el servidor: ${preferenceRemoteValue ? 'activado' : 'desactivado'}.`}
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={animationPreference.saveSelection}
            disabled={authPaused || busy || preferenceSaving}
          >
            Guardar mi selección
          </button>
        </div>
      )}
      {preferenceError && (
        <div className="attempt-error" role="alert">
          <p>{preferenceError}</p>
        </div>
      )}
      {quotaController.error && quotaController.recoverableFailure && (
        <small className="quota-recovery-detail">{quotaController.error}</small>
      )}
      {quotaController.error && !quotaController.recoverableFailure && (
        <div className="attempt-error" role="alert">
          <p>No se pudo confirmar la cuota: {quotaController.error}</p>
        </div>
      )}
    </div>
  );

  const currentErrorGuidance: WorkspaceErrorGuidance | undefined =
    error?.guidance ??
    (mode === 'unknown' ? 'check-status' : mode === 'replay-error' ? 'replay' : undefined);
  const visiblePresentationAcknowledgement =
    attempt && presentationAcknowledgementStates.get(attempt.id)?.identity === sessionSub
      ? presentationAcknowledgementStates.get(attempt.id)
      : undefined;

  const view = (
    <section className="attempt-workspace" aria-labelledby="attempt-workspace-title">
      <div className="attempt-heading">
        <div>
          <p className="card-kicker">Terreno con recompensa y puerta</p>
          <h2 id="attempt-workspace-title" tabIndex={-1}>
            Probar al agente
          </h2>
          <p>Probá tu robot para ver cómo recorre el terreno.</p>
        </div>
      </div>

      <div>
        {error && (
          <div className="attempt-error" role="alert">
            <p>{error.message}</p>
            {(mode === 'unknown' ||
              mode === 'replay-error' ||
              mode === 'idle' ||
              mode === 'result') &&
              currentErrorGuidance && (
                <p className="attempt-error-guidance">
                  <strong>Acción disponible:</strong>{' '}
                  {currentErrorGuidance === 'check-status'
                    ? 'Comprobar estado vuelve a consultar el servidor.'
                    : currentErrorGuidance === 'replay'
                      ? 'Reintentar reproducción vuelve a consultar el registro; Ver resultado muestra el cierre guardado.'
                      : currentErrorGuidance === 'enable-skill'
                        ? 'Habilitá al menos una habilidad y volvé a pulsar Probar.'
                        : ''}
                </p>
              )}
            {mode === 'unknown' && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void resolveUnknown()}
              >
                Comprobar estado
              </button>
            )}
            {mode === 'replay-error' && (
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={retryReplay}
                  disabled={busy}
                >
                  Reintentar reproducción
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void showResultAfterReplayError()}
                >
                  Ver resultado
                </button>
              </>
            )}
          </div>
        )}

        {mode === 'loading' && (
          <p className="attempt-message" role="status">
            Recuperando tus intentos…
          </p>
        )}

        {mode === 'selecting' && (
          <section className="active-attempts" aria-labelledby="active-attempts-title">
            <h3 id="active-attempts-title">Tenés varios intentos en curso</h3>
            <p>Elegí cuál querés retomar en esta pestaña. Los demás siguen en el servidor.</p>
            <div className="active-attempt-list">
              {activeCandidates.map((candidate) => (
                <button
                  className="secondary-button"
                  type="button"
                  key={candidate.id}
                  onClick={() => chooseActive(candidate)}
                >
                  {candidate.id}, {statusLabel(candidate.status)}
                </button>
              ))}
            </div>
          </section>
        )}

        {mode === 'admitting' && (
          <p className="attempt-message" role="status">
            Guardando la configuración e iniciando el intento…
          </p>
        )}
        {mode === 'opening' && (
          <p className="attempt-message" role="status">
            Consultando el resultado guardado…
          </p>
        )}
        {(mode === 'pending' ||
          mode === 'running' ||
          mode === 'canceling' ||
          (mode === 'unknown' && attempt && isActive(attempt.status))) &&
          attempt && (
            <section className="attempt-running" aria-live="polite">
              <div className="attempt-running-copy">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <h3>{statusLabel(attempt.status)}</h3>
                  <p>
                    {attempt.cancelRequested
                      ? 'Confirmando la cancelación…'
                      : statusDescription(attempt.status)}
                  </p>
                </div>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void cancel()}
                disabled={cancelBusy || mode === 'canceling' || authPaused}
              >
                {mode === 'canceling' || attempt.cancelRequested
                  ? 'Cancelando…'
                  : authPaused
                    ? accessState === 'required'
                      ? 'Acceso rechazado'
                      : 'Esperando sesión…'
                    : 'Cancelar'}
              </button>
            </section>
          )}

        {mode === 'unknown' && (
          <p className="attempt-message" role="status">
            El estado del servidor todavía no está confirmado. La recuperación usa la misma admisión
            y no crea otro intento.
          </p>
        )}

        {mode === 'preparing-replay' && (
          <p className="attempt-message" role="status">
            Preparando una reproducción completa desde el registro guardado…
          </p>
        )}

        {replayRecord && (mode === 'preparing-replay' || mode === 'replaying') && (
          <section className="attempt-replay" aria-label="Reproducción del intento">
            <div className="attempt-replay-heading">
              <h3>{playbackKind === 'automatic' ? 'Reproducción del intento' : 'Ver de nuevo'}</h3>
              <p>
                {mode === 'preparing-replay'
                  ? 'Comprobando los gráficos…'
                  : 'La secuencia avanza sola a velocidad fija y no vuelve a llamar al modelo.'}
              </p>
            </div>
            <ReplayScene
              record={replayRecord}
              onReady={onReplayReady}
              onComplete={() => void onReplayComplete()}
              onError={onReplayError}
            />
          </section>
        )}

        {mode === 'result' && attempt && (
          <ResultCard
            attempt={attempt}
            source={historyResultOpen ? 'history' : 'current'}
            createdAt={attempt.createdAt}
            sharingVisible={configurationState === null && decisionInspectorTarget === null}
            onReplay={replayCurrentAttempt}
            onInspect={openDecisionInspectorForCurrent}
            onConfiguration={() =>
              void openConfiguration(attempt.id, true, {
                source: historyResultOpen ? 'history' : 'current',
                createdAt: attempt.createdAt,
              })
            }
            onReturnToEditor={returnToEditor}
            onReturnToHistory={historyResultOpen ? returnToHistory : undefined}
            configurationBusy={
              configurationState?.targetId === attempt.id && configurationState.status === 'loading'
            }
            busy={busy}
          />
        )}
        {visiblePresentationAcknowledgement && (
          <div
            className={
              visiblePresentationAcknowledgement.phase === 'blocked'
                ? 'attempt-error'
                : 'attempt-message'
            }
            role={visiblePresentationAcknowledgement.phase === 'blocked' ? 'alert' : 'status'}
          >
            <p>{visiblePresentationAcknowledgement.message}</p>
          </div>
        )}
      </div>
    </section>
  );

  const configurationView = configurationState ? (
    <ConfigurationPreview
      state={configurationState}
      busy={busy}
      configurationAvailable={configurationAvailable && !authPaused}
      onApply={() => void applyConfiguration()}
      onRetry={() =>
        void openConfiguration(
          configurationState.targetId,
          false,
          configurationState.displayContext,
        )
      }
      onClose={closeConfiguration}
    />
  ) : null;

  const inspectorView =
    decisionInspectorTarget && !authPaused ? (
      <DecisionInspector
        key={`${sessionSub}:${decisionInspectorTarget.id}:${decisionInspectorOpenVersion}`}
        api={api}
        attemptId={decisionInspectorTarget.id}
        targetLabel={`${statusLabel(decisionInspectorTarget.status)}, ${formatDateTime(decisionInspectorTarget.createdAt)}`}
        initialSelection={decisionInspectorSelection}
        onAuthRequired={handleDecisionInspectorAuthRequired}
        onClose={clearDecisionInspector}
      />
    ) : null;

  const historyResultView = resultQuery ? (
    <HistoryResultQuery
      state={resultQuery}
      sharingVisible={configurationState === null && decisionInspectorTarget === null}
      onClose={closeResult}
      onReplay={(id) => void openReplayFromHistory(id)}
      onInspect={openHistoryDecisionInspector}
      onConfiguration={(target) =>
        void openConfiguration(target.id, true, {
          source: 'history',
          createdAt: target.createdAt,
        })
      }
      onReturnToEditor={returnToEditor}
      configurationBusy={
        configurationState?.targetId === resultQuery.targetId &&
        configurationState.status === 'loading'
      }
      busy={busy}
    />
  ) : null;

  const renderedHistoryView =
    mode === 'loading' || mode === 'idle' || mode === 'result' ? (
      <HistoryList
        attempts={history}
        view={historyView}
        nextCursor={historyCursor}
        error={historyError}
        loading={loadingHistory}
        recovering={historyRecovering}
        recoveryMessage={historyRecoveryMessage}
        invalidCursor={invalidHistoryCursor}
        busy={busy || loadingHistory}
        onOpen={(id) => void openHistoryResult(id, handoffHistoryActivityTarget)}
        onReplay={(id) => void openReplayFromHistory(id)}
        onInspect={(id, selection) => void openDecisionInspectorFromHistory(id, selection)}
        onConfiguration={(target) =>
          void openConfiguration(target.id, true, {
            source: 'history',
            createdAt: target.createdAt,
          })
        }
        configurationBusyId={
          configurationState && configurationState.status === 'loading'
            ? configurationState.targetId
            : null
        }
        onMore={() => void loadMore()}
        onUpdate={updateHistory}
        onSelectView={selectHistoryView}
        onPrepare={returnToEditor}
      />
    ) : null;

  return {
    busy,
    foreground: mode !== 'loading' && mode !== 'idle' && mode !== 'result',
    resultVisible:
      mode === 'result' &&
      (surface === 'preparar' || (surface === 'historial' && historyResultOpen)),
    queryVisible,
    historyResultOpen,
    configurationOpen: configurationState !== null,
    inspectorOpen: decisionInspectorTarget !== null,
    historyQueryOpen: resultQuery !== null,
    tryAvailable,
    controls: attemptControls,
    view,
    historyView: renderedHistoryView,
    historyResultView,
    configurationView,
    inspectorView,
    start: () => void start(),
    returnToEditor,
    leaveResultPresentation,
  };
}
