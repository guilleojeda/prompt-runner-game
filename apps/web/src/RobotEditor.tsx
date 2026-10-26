import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  MAX_DRAFT_BYTES,
  MAX_INSTRUCTIONS_CHARACTERS,
  MAX_SKILL_DESCRIPTION_CHARACTERS,
  ROBOT_CATALOG,
  countCharacters,
  draftByteLength,
  draftLimitMessage,
  draftsEqual,
  type DraftSnapshot,
  type RobotDraft,
  type RobotSkillId,
} from '../../../shared/robot.js';
import { MODEL_CATALOG } from '../../../shared/models.js';
import type { AuthSession } from './auth.js';
import type { ApiAuthRequired } from './api-auth.js';
import { DraftApiFailure, type DraftApi } from './draft-api.js';
import { SavedRobotApiFailure } from './saved-robot-api.js';

type EditorStatus = 'loading' | 'clean' | 'dirty' | 'saving' | 'recovering' | 'conflict' | 'error';
interface ReconciliationTarget {
  readonly expectedVersion: number;
  readonly base: DraftSnapshot;
  readonly draft: RobotDraft;
  readonly source: 'visible' | 'candidate';
  readonly applicationId?: number;
  readonly recognizes?: ReconciliationTarget;
}

type DraftApplicationSource = RobotDraft | ((signal: AbortSignal) => Promise<RobotDraft>);

interface DraftApplication {
  readonly id: number;
  readonly epoch: number;
  readonly owner: string;
  readonly revision: number;
  readonly visible: RobotDraft;
  readonly source: DraftApplicationSource;
  readonly signal?: AbortSignal;
  readonly resolve: (applied: boolean) => void;
  readonly reject: (error: unknown) => void;
  onAbort?: () => void;
  candidate?: RobotDraft;
  settled: boolean;
}

interface ScheduledWork {
  readonly deadline: number;
}

interface ActiveOperation {
  readonly id: number;
  readonly controller: AbortController;
  readonly kind: 'get' | 'put';
  readonly applicationId?: number;
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (confirmed: boolean) => void;
  readonly onAbort: () => void;
}

export interface RobotEditorHandle {
  hasUnconfirmedChanges(): boolean;
  discardPending(): void;
  flushPending(): Promise<boolean>;
  waitForConfirmed(signal: AbortSignal): Promise<boolean>;
  captureSnapshot(): Promise<DraftSnapshot | null>;
  applyDraft(source: DraftApplicationSource, options?: { signal?: AbortSignal }): Promise<boolean>;
  cancelApplication(): void;
  releaseAttemptLock(): void;
  focusEditor?(): void;
}

export interface RobotEditorProps {
  api: DraftApi;
  session: AuthSession;
  paused?: boolean;
  accessState?: 'ready' | 'checking' | 'required';
  locked?: boolean;
  onTry?: () => void;
  onAuthRequired?: ApiAuthRequired;
  onConfigurationAvailabilityChange?: (available: boolean) => void;
  onAttemptControlsHostChange?: (node: HTMLDivElement | null) => void;
}

interface OperationResult<T> {
  readonly value?: T;
  readonly error?: unknown;
  readonly cancelled: boolean;
}

function cloneDraft(draft: RobotDraft): RobotDraft {
  return {
    schemaVersion: draft.schemaVersion,
    catalogVersion: draft.catalogVersion,
    modelKey: draft.modelKey,
    instructions: draft.instructions,
    skills: draft.skills.map((skill) =>
      Object.prototype.hasOwnProperty.call(skill, 'description')
        ? { id: skill.id, enabled: skill.enabled, description: skill.description }
        : { id: skill.id, enabled: skill.enabled },
    ),
  };
}

const DRAFT_SIZE_WARNING_THRESHOLD = Math.ceil(MAX_DRAFT_BYTES * 0.9);

function formatCharacterCount(value: string, maximum: number): string {
  const count = countCharacters(value);
  const formatted = `${count.toLocaleString('es-AR')} / ${maximum.toLocaleString('es-AR')} caracteres`;
  return count > maximum ? `${formatted}, supera el máximo` : formatted;
}

function statusLabel(status: EditorStatus, isLoadError: boolean): string {
  switch (status) {
    case 'loading':
      return 'Cargando configuración…';
    case 'dirty':
      return 'Cambios pendientes';
    case 'saving':
      return 'Guardando…';
    case 'recovering':
      return 'Guardado pendiente: volveremos a intentarlo cada minuto';
    case 'clean':
      return 'Guardado';
    case 'conflict':
      return 'Conflicto de edición';
    case 'error':
      return isLoadError
        ? 'No se pudo cargar la configuración'
        : 'No se pudo confirmar el guardado';
  }
}

export const RobotEditor = forwardRef<RobotEditorHandle, RobotEditorProps>(function RobotEditor(
  {
    api,
    session,
    paused = false,
    accessState = 'ready',
    locked = false,
    onTry,
    onAuthRequired,
    onConfigurationAvailabilityChange,
    onAttemptControlsHostChange,
  },
  ref,
) {
  const [draft, setDraft] = useState<RobotDraft | null>(null);
  const [status, setStatus] = useState<EditorStatus>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DraftSnapshot | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [conflictActionPending, setConflictActionPending] = useState(false);
  const [attemptClickLocked, setAttemptClickLocked] = useState(false);
  const epochRef = useRef(0);
  const ownerRef = useRef('');
  const mountedRef = useRef(false);
  const operationIdRef = useRef(0);
  const applicationIdRef = useRef(0);
  const operationRef = useRef<ActiveOperation | null>(null);
  const applicationRef = useRef<DraftApplication | null>(null);
  const cancelApplicationRef = useRef<() => void>(() => undefined);
  const cyclePromiseRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<number | null>(null);
  const scheduledRef = useRef<ScheduledWork | null>(null);
  const recoveryDeadlineRef = useRef<number | null>(null);
  const scheduleAtRef = useRef<(deadline: number) => void>(() => undefined);
  const recoveryRef = useRef(false);
  const editDeadlineRef = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const failedRevisionRef = useRef<number | null>(null);
  const draftRef = useRef<RobotDraft | null>(null);
  const confirmedRef = useRef<DraftSnapshot | null>(null);
  const conflictRef = useRef<DraftSnapshot | null>(null);
  const targetRef = useRef<ReconciliationTarget | null>(null);
  const conflictRefreshPendingRef = useRef(false);
  const pausedRef = useRef(paused);
  const accessStateRef = useRef(accessState);
  const lockedRef = useRef(locked);
  const attemptClickLockedRef = useRef(false);
  const apiRef = useRef(api);
  const onAuthRequiredRef = useRef(onAuthRequired);
  const authBlockedRef = useRef(false);
  const waitersRef = useRef(new Set<Waiter>());
  const runCycleRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const editorHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const comparisonHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const conflictTriggerRef = useRef<HTMLButtonElement | null>(null);

  pausedRef.current = paused;
  accessStateRef.current = accessState;
  lockedRef.current = locked;
  conflictRef.current = conflict;
  apiRef.current = api;
  onAuthRequiredRef.current = onAuthRequired;

  const canAccess = (): boolean =>
    mountedRef.current &&
    !pausedRef.current &&
    accessStateRef.current === 'ready' &&
    !authBlockedRef.current;

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    scheduledRef.current = null;
    recoveryDeadlineRef.current = null;
  };

  const cancelTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const notifyWaiters = (result?: boolean): void => {
    const current = draftRef.current;
    const confirmed = confirmedRef.current;
    const clean = Boolean(
      current &&
      confirmed &&
      operationRef.current === null &&
      targetRef.current === null &&
      conflictRef.current === null &&
      draftsEqual(current, confirmed.draft),
    );
    if (result === false || clean) {
      for (const waiter of waitersRef.current) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.resolve(result === false ? false : clean);
      }
      waitersRef.current.clear();
    }
  };

  const setConflictState = (next: DraftSnapshot | null): void => {
    conflictRef.current = next;
    setConflict(next);
    if (!next) setComparisonOpen(false);
    notifyWaiters();
  };

  const scheduleAt = (deadline: number): void => {
    if (!mountedRef.current || !canAccess()) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    const epoch = epochRef.current;
    scheduledRef.current = { deadline };
    timerRef.current = window.setTimeout(
      () => {
        timerRef.current = null;
        scheduledRef.current = null;
        if (epoch !== epochRef.current || !canAccess()) return;
        void runCycleRef.current();
      },
      Math.max(0, deadline - Date.now()),
    );
  };
  scheduleAtRef.current = scheduleAt;

  const scheduleRecovery = (): void => {
    recoveryRef.current = true;
    const visible = draftRef.current;
    const confirmed = confirmedRef.current;
    const visibleIsClean = Boolean(
      visible &&
      confirmed &&
      operationRef.current === null &&
      targetRef.current === null &&
      applicationRef.current === null &&
      conflictRef.current === null &&
      draftsEqual(visible, confirmed.draft),
    );
    setStatus(visibleIsClean ? 'clean' : visible ? 'recovering' : 'error');
    if (!draftRef.current && !message) {
      setMessage('No se pudo cargar la configuración. Se volverá a intentar automáticamente.');
    }
    const deadline = Date.now() + 60_000;
    recoveryDeadlineRef.current = deadline;
    scheduleAt(deadline);
    notifyWaiters();
  };

  const preserveRecoveryDeadline = (): void => {
    recoveryRef.current = true;
    const deadline = recoveryDeadlineRef.current ?? scheduledRef.current?.deadline;
    const preservedDeadline = deadline ?? Date.now() + 60_000;
    recoveryDeadlineRef.current = preservedDeadline;
    scheduleAt(Math.max(Date.now(), preservedDeadline));
    updateVisibleState();
    notifyWaiters();
  };

  const scheduleVisibleEdit = (): void => {
    const deadline = editDeadlineRef.current;
    if (deadline === null || recoveryRef.current || !canAccess()) return;
    scheduleAt(deadline);
  };

  const finishApplication = (application: DraftApplication, applied: boolean): void => {
    if (applicationRef.current !== application || application.settled) return;
    application.settled = true;
    if (application.signal && application.onAbort) {
      application.signal.removeEventListener('abort', application.onAbort);
    }
    applicationRef.current = null;
    application.resolve(applied);
  };

  const rejectApplication = (application: DraftApplication, error: unknown): void => {
    if (applicationRef.current !== application || application.settled) return;
    application.settled = true;
    if (application.signal && application.onAbort) {
      application.signal.removeEventListener('abort', application.onAbort);
    }
    applicationRef.current = null;
    application.reject(error);
  };

  const cancelApplication = (expectedId?: number): void => {
    const application = applicationRef.current;
    if (!application || (expectedId !== undefined && application.id !== expectedId)) return;

    const operation = operationRef.current;
    if (operation?.applicationId === application.id) {
      operation.controller.abort();
      operationRef.current = null;
      cyclePromiseRef.current = null;
    }
    finishApplication(application, false);

    if (targetRef.current?.source === 'candidate') {
      preserveRecoveryDeadline();
    } else if (!targetRef.current) {
      if (recoveryRef.current && scheduledRef.current !== null) {
        preserveRecoveryDeadline();
      } else {
        if (recoveryRef.current) {
          recoveryRef.current = false;
          clearTimer();
        }
        const visible = draftRef.current;
        const confirmed = confirmedRef.current;
        if (visible && confirmed && !draftsEqual(visible, confirmed.draft)) {
          if (editDeadlineRef.current === null || editDeadlineRef.current <= Date.now()) {
            editDeadlineRef.current = Date.now() + 600;
          }
          scheduleVisibleEdit();
        } else {
          updateVisibleState();
        }
      }
    }
  };
  cancelApplicationRef.current = cancelApplication;

  const cloneSnapshot = (snapshot: DraftSnapshot): DraftSnapshot => ({
    ...snapshot,
    draft: cloneDraft(snapshot.draft),
  });

  const isTransient = (error: unknown): boolean =>
    error instanceof DraftApiFailure &&
    (error.ambiguous ||
      error.code === 'network' ||
      error.code === 'server' ||
      error.code === 'rate_limited');

  const isApplicationTransient = (error: unknown): boolean =>
    (error instanceof SavedRobotApiFailure &&
      (error.code === 'network' || error.code === 'server' || error.code === 'rate_limited')) ||
    isTransient(error);

  const isApplicationAuthentication = (
    error: unknown,
  ): { readonly authContext?: number; readonly message: string } | null => {
    if (error instanceof DraftApiFailure || error instanceof SavedRobotApiFailure) {
      return error.code === 'authentication'
        ? { authContext: error.authContext, message: error.message }
        : null;
    }
    return null;
  };

  const isAmbiguous = (error: unknown): boolean =>
    error instanceof DraftApiFailure && error.ambiguous;

  const isVisiblePutInFlight = (): boolean => {
    const operation = operationRef.current;
    const target = targetRef.current;
    return Boolean(
      operation?.kind === 'put' &&
      target &&
      target.source === 'visible' &&
      conflictRef.current === null,
    );
  };

  const handleFailure = (error: unknown, isLoad: boolean): boolean => {
    if (error instanceof DraftApiFailure && error.code === 'authentication') {
      setMessage(error.message);
      setStatus('error');
      let accepted = true;
      try {
        accepted = onAuthRequiredRef.current?.(error.authContext) !== false;
      } catch {
        accepted = true;
      }
      if (accepted) {
        authBlockedRef.current = true;
      } else {
        setMessage(null);
        scheduleRecovery();
      }
      return !accepted;
    }
    if (isTransient(error)) {
      if (isLoad && !draftRef.current) {
        setStatus('error');
        setMessage(
          error instanceof DraftApiFailure
            ? error.message
            : 'No se pudo cargar la configuración. Se volverá a intentar automáticamente.',
        );
        recoveryRef.current = true;
        const deadline = Date.now() + 60_000;
        recoveryDeadlineRef.current = deadline;
        scheduleAt(deadline);
      } else {
        setMessage(null);
        scheduleRecovery();
      }
      return false;
    }
    recoveryRef.current = false;
    clearTimer();
    setStatus('error');
    setMessage(
      error instanceof DraftApiFailure
        ? error.message
        : isLoad
          ? 'No se pudo cargar la configuración.'
          : 'No se pudo guardar la configuración.',
    );
    return false;
  };

  const performOperation = async <T,>(
    request: (signal: AbortSignal) => Promise<T>,
    kind: ActiveOperation['kind'] = 'get',
    applicationId?: number,
  ): Promise<OperationResult<T>> => {
    if (operationRef.current !== null) {
      return { cancelled: true };
    }
    const epoch = epochRef.current;
    const controller = new AbortController();
    const operation: ActiveOperation = {
      id: ++operationIdRef.current,
      controller,
      kind,
      ...(applicationId === undefined ? {} : { applicationId }),
    };
    operationRef.current = operation;
    if (mountedRef.current) setStatus(draftRef.current ? 'saving' : 'loading');
    try {
      const value = await request(controller.signal);
      return {
        value,
        cancelled:
          controller.signal.aborted ||
          epoch !== epochRef.current ||
          operationRef.current?.id !== operation.id,
      };
    } catch (error) {
      return {
        error,
        cancelled:
          controller.signal.aborted ||
          epoch !== epochRef.current ||
          operationRef.current?.id !== operation.id,
      };
    } finally {
      if (operationRef.current?.id === operation.id) operationRef.current = null;
      notifyWaiters();
    }
  };

  const setLoadedSnapshot = (snapshot: DraftSnapshot): void => {
    const copy = cloneSnapshot(snapshot);
    confirmedRef.current = copy;
    draftRef.current = cloneDraft(copy.draft);
    targetRef.current = null;
    failedRevisionRef.current = null;
    conflictRefreshPendingRef.current = false;
    recoveryRef.current = false;
    editDeadlineRef.current = null;
    clearTimer();
    setDraft(cloneDraft(copy.draft));
    setConflictState(null);
    setMessage(null);
    setStatus('clean');
    notifyWaiters();
  };

  const markConflict = (snapshot: DraftSnapshot): void => {
    const copy = cloneSnapshot(snapshot);
    if (applicationRef.current) finishApplication(applicationRef.current, false);
    targetRef.current = null;
    failedRevisionRef.current = null;
    conflictRefreshPendingRef.current = false;
    recoveryRef.current = false;
    clearTimer();
    setConflictState(copy);
    setStatus('conflict');
    setMessage('Otra pestaña guardó una versión distinta. Compará ambas versiones para resolver.');
  };

  const updateVisibleState = (): void => {
    const current = draftRef.current;
    const confirmed = confirmedRef.current;
    if (conflictRef.current) {
      setStatus('conflict');
      return;
    }
    if (targetRef.current && operationRef.current === null) {
      setStatus(recoveryRef.current ? 'recovering' : 'dirty');
      return;
    }
    if (!current || !confirmed) {
      setStatus('loading');
      return;
    }
    if (draftsEqual(current, confirmed.draft)) {
      setStatus(applicationRef.current && recoveryRef.current ? 'recovering' : 'clean');
      setMessage(null);
      editDeadlineRef.current = null;
      if (
        !targetRef.current &&
        applicationRef.current === null &&
        (!recoveryRef.current || scheduledRef.current === null)
      ) {
        recoveryRef.current = false;
        clearTimer();
      }
      notifyWaiters();
    } else if (operationRef.current) {
      setStatus('saving');
    } else if (recoveryRef.current) {
      setStatus('recovering');
    } else {
      setStatus('dirty');
    }
  };

  const isCurrentOwner = (epoch: number, sub: string): boolean =>
    mountedRef.current && epochRef.current === epoch && ownerRef.current === sub;

  const isCurrentApplication = (application: DraftApplication): boolean =>
    applicationRef.current === application &&
    !application.settled &&
    !application.signal?.aborted &&
    isCurrentOwner(application.epoch, application.owner) &&
    canAccess() &&
    !lockedRef.current &&
    revisionRef.current === application.revision &&
    draftRef.current !== null &&
    draftsEqual(draftRef.current, application.visible) &&
    conflictRef.current === null;

  const applicationWaitingOnDefinitiveWrite = (
    applicationId: number | undefined,
    source: ReconciliationTarget['source'],
    revision: number,
    sent: RobotDraft,
  ): DraftApplication | null => {
    const application = applicationRef.current;
    if (
      !application ||
      application.settled ||
      !mountedRef.current ||
      application.epoch !== epochRef.current ||
      application.owner !== ownerRef.current ||
      application.revision !== revisionRef.current ||
      !draftRef.current ||
      !draftsEqual(draftRef.current, application.visible) ||
      conflictRef.current !== null
    ) {
      return null;
    }
    if (applicationId !== undefined) {
      return application.id === applicationId ? application : null;
    }
    return source === 'visible' &&
      application.revision === revision &&
      draftsEqual(sent, application.visible)
      ? application
      : null;
  };

  const confirmsKnownWrite = (snapshot: DraftSnapshot, target: ReconciliationTarget): boolean => {
    let knownWrite: ReconciliationTarget | undefined = target;
    while (knownWrite) {
      if (
        snapshot.version > knownWrite.expectedVersion &&
        draftsEqual(snapshot.draft, knownWrite.draft)
      ) {
        return true;
      }
      knownWrite = knownWrite.recognizes;
    }
    return false;
  };

  const writeDraft = async (
    sentDraft: RobotDraft,
    expectedVersion: number,
    base: DraftSnapshot,
    revision: number,
    recognizeTarget?: ReconciliationTarget,
    source: ReconciliationTarget['source'] = 'visible',
    applicationId?: number,
  ): Promise<boolean> => {
    if (!canAccess() || conflictRef.current || operationRef.current) return false;
    const validation = draftLimitMessage(sentDraft);
    if (validation) {
      setStatus('error');
      setMessage(validation);
      return false;
    }
    const sent = cloneDraft(sentDraft);
    const target: ReconciliationTarget = {
      expectedVersion,
      base: cloneSnapshot(base),
      draft: sent,
      source,
      ...(source !== 'candidate' || applicationId === undefined ? {} : { applicationId }),
      ...(recognizeTarget ? { recognizes: recognizeTarget } : {}),
    };
    targetRef.current = target;
    const epoch = epochRef.current;
    const sub = ownerRef.current;
    setStatus('saving');
    setMessage(null);
    const result = await performOperation(
      (signal) => apiRef.current.putDraft(expectedVersion, sent, signal),
      'put',
      source === 'candidate' ? applicationId : undefined,
    );
    if (!isCurrentOwner(epoch, sub)) return false;
    if (result.cancelled) {
      const lateTarget = targetRef.current;
      if (
        result.value &&
        source === 'candidate' &&
        lateTarget === target &&
        result.value.version > expectedVersion &&
        draftsEqual(result.value.draft, sent)
      ) {
        confirmedRef.current = cloneSnapshot(result.value);
        targetRef.current = null;
        failedRevisionRef.current = null;
        recoveryRef.current = false;
        clearTimer();
        setMessage(null);
        const visible = draftRef.current;
        if (visible && !draftsEqual(visible, result.value.draft)) {
          if (editDeadlineRef.current === null || editDeadlineRef.current <= Date.now()) {
            editDeadlineRef.current = Date.now() + 600;
          }
          updateVisibleState();
          scheduleAt(editDeadlineRef.current);
        } else {
          updateVisibleState();
        }
        notifyWaiters();
      }
      return false;
    }
    if (result.value) {
      if (result.value.version <= expectedVersion || !draftsEqual(result.value.draft, sent)) {
        targetRef.current = target;
        setMessage(null);
        scheduleRecovery();
        return false;
      }
      confirmedRef.current = cloneSnapshot(result.value);
      targetRef.current = null;
      failedRevisionRef.current = null;
      recoveryRef.current = false;
      updateVisibleState();
      notifyWaiters();
      return true;
    }
    const error = result.error;
    if (error instanceof DraftApiFailure && error.code === 'conflict' && error.current) {
      const current = cloneSnapshot(error.current);
      if (recognizeTarget && confirmsKnownWrite(current, recognizeTarget)) {
        confirmedRef.current = current;
        targetRef.current = null;
        recoveryRef.current = false;
        const application = applicationRef.current;
        if (
          recognizeTarget.applicationId !== undefined &&
          application?.id === recognizeTarget.applicationId &&
          isCurrentApplication(application) &&
          draftsEqual(current.draft, application.candidate ?? recognizeTarget.draft)
        ) {
          return true;
        }
        const visible = draftRef.current;
        if (!visible || draftsEqual(visible, current.draft)) {
          updateVisibleState();
          return true;
        }
        return writeDraft(
          visible,
          current.version,
          current,
          revisionRef.current,
          undefined,
          'visible',
          applicationRef.current?.id,
        );
      }
      if (current.version > expectedVersion && draftsEqual(current.draft, sent)) {
        confirmedRef.current = current;
        targetRef.current = null;
        recoveryRef.current = false;
        updateVisibleState();
        return true;
      }
      if (current.version <= expectedVersion) {
        if (recognizeTarget) {
          targetRef.current = recognizeTarget;
          failedRevisionRef.current = revision;
          const newerEdit = revisionRef.current !== revision;
          if (!newerEdit) editDeadlineRef.current = null;
          setMessage(null);
          scheduleRecovery();
          if (newerEdit && editDeadlineRef.current !== null) {
            scheduleAt(editDeadlineRef.current);
          }
        } else {
          targetRef.current = target;
          setMessage(null);
          scheduleRecovery();
        }
        return false;
      }
      markConflict(current);
      return false;
    }
    if (error instanceof DraftApiFailure && error.code === 'conflict') {
      targetRef.current = target;
      setMessage(null);
      scheduleRecovery();
      return false;
    }
    if (isTransient(error)) {
      targetRef.current = isAmbiguous(error) ? target : (recognizeTarget ?? null);
      handleFailure(error, false);
      return false;
    }
    targetRef.current = recognizeTarget ?? null;
    conflictRefreshPendingRef.current = false;
    recoveryRef.current = false;
    clearTimer();
    const latest = draftRef.current;
    const applicationToFinish = applicationWaitingOnDefinitiveWrite(
      applicationId,
      source,
      revision,
      sent,
    );
    const ignoredStaleAuthentication = handleFailure(error, false);
    if (applicationToFinish && !ignoredStaleAuthentication) {
      finishApplication(applicationToFinish, false);
    }
    if (ignoredStaleAuthentication) return false;
    if (recognizeTarget) {
      // The descendant CAS was rejected, but the ancestor PUT can still have
      // committed. Keep checking that ancestor without retrying this exact
      // rejected revision; a later edit can resume writes.
      failedRevisionRef.current = revision;
      const newerEdit = revisionRef.current !== revision && latest !== null;
      if (!newerEdit) editDeadlineRef.current = null;
      if (!authBlockedRef.current) {
        recoveryRef.current = true;
        setStatus('recovering');
        scheduleAt(
          newerEdit && editDeadlineRef.current !== null
            ? editDeadlineRef.current
            : Date.now() + 60_000,
        );
        recoveryDeadlineRef.current = scheduledRef.current?.deadline ?? null;
      }
      return false;
    }
    if (
      latest &&
      revisionRef.current !== revision &&
      draftLimitMessage(latest) === null &&
      editDeadlineRef.current !== null
    ) {
      scheduleAt(editDeadlineRef.current);
    }
    return false;
  };

  const reconcileTarget = async (application?: DraftApplication): Promise<boolean> => {
    const target = targetRef.current;
    if (!target || !canAccess() || operationRef.current) return false;
    const epoch = epochRef.current;
    const sub = ownerRef.current;
    const result = await performOperation(
      (signal) => apiRef.current.getDraft(signal),
      'get',
      application && target.applicationId === application.id ? application.id : undefined,
    );
    if (!isCurrentOwner(epoch, sub) || result.cancelled) return false;
    if (!result.value) {
      handleFailure(result.error, false);
      if (
        application &&
        isCurrentApplication(application) &&
        (authBlockedRef.current || (!recoveryRef.current && conflictRef.current === null))
      ) {
        finishApplication(application, false);
      }
      return false;
    }
    const remote = cloneSnapshot(result.value);
    if (
      remote.version < target.expectedVersion ||
      (remote.version === target.expectedVersion && !draftsEqual(remote.draft, target.base.draft))
    ) {
      targetRef.current = target;
      setStatus('recovering');
      setMessage('La versión leída no coincide con la versión esperada. Conservamos tus cambios.');
      recoveryRef.current = true;
      const deadline = Date.now() + 60_000;
      recoveryDeadlineRef.current = deadline;
      scheduleAt(deadline);
      return false;
    }
    if (remote.version === target.expectedVersion) {
      if (failedRevisionRef.current === revisionRef.current) {
        if (application && target.applicationId === application.id) {
          targetRef.current = null;
          failedRevisionRef.current = null;
          recoveryRef.current = false;
          finishApplication(application, false);
          updateVisibleState();
          return false;
        }
        targetRef.current = target;
        scheduleRecovery();
        return false;
      }
      if (application && target.applicationId === application.id && application.candidate) {
        const saved = await writeDraft(
          application.candidate,
          target.expectedVersion,
          target.base,
          application.revision,
          target,
          'candidate',
          application.id,
        );
        if (saved && isCurrentApplication(application)) {
          return importApplication(application, confirmedRef.current);
        }
        if (isCurrentApplication(application) && !recoveryRef.current) {
          finishApplication(application, false);
        }
        return saved;
      }
      const latest = draftRef.current;
      if (!latest) return false;
      const deadline = editDeadlineRef.current;
      if (deadline !== null && deadline > Date.now()) {
        scheduleAtRef.current(deadline);
        return false;
      }
      const saved = await writeDraft(
        latest,
        target.expectedVersion,
        target.base,
        revisionRef.current,
        target,
        'visible',
        application?.id,
      );
      if (saved) {
        recoveryRef.current = false;
        updateVisibleState();
      }
      return saved;
    }
    const visible = draftRef.current;
    if (visible && remote.version > target.expectedVersion && draftsEqual(remote.draft, visible)) {
      confirmedRef.current = remote;
      targetRef.current = null;
      recoveryRef.current = false;
      if (
        application &&
        target.applicationId === application.id &&
        application.candidate &&
        draftsEqual(remote.draft, application.candidate)
      ) {
        return importApplication(application, remote);
      }
      setMessage(null);
      updateVisibleState();
      return true;
    }
    if (confirmsKnownWrite(remote, target)) {
      confirmedRef.current = remote;
      targetRef.current = null;
      recoveryRef.current = false;
      if (
        application &&
        target.applicationId === application.id &&
        application.candidate &&
        draftsEqual(remote.draft, application.candidate)
      ) {
        return importApplication(application, remote);
      }
      if (visible && !draftsEqual(visible, remote.draft)) {
        const rejectedVisibleRevision = failedRevisionRef.current === revisionRef.current;
        const abandonedCandidate =
          target.source === 'candidate' && target.applicationId !== application?.id;
        if (rejectedVisibleRevision && !abandonedCandidate) {
          if (application) finishApplication(application, false);
          setStatus('error');
          return false;
        }
        setMessage(null);
        updateVisibleState();
        const deadline = editDeadlineRef.current;
        if (deadline !== null && deadline > Date.now()) {
          scheduleAt(deadline);
          return false;
        }
        return writeDraft(
          visible,
          remote.version,
          remote,
          revisionRef.current,
          undefined,
          'visible',
          application?.id,
        );
      }
      setMessage(null);
      updateVisibleState();
      return true;
    }
    markConflict(remote);
    return false;
  };

  const importApplication = (
    application: DraftApplication,
    confirmed: DraftSnapshot | null,
  ): boolean => {
    const candidate = application.candidate;
    if (
      !isCurrentApplication(application) ||
      !candidate ||
      !confirmed ||
      confirmed.version <= 0 ||
      !draftsEqual(confirmed.draft, candidate)
    ) {
      return false;
    }
    confirmedRef.current = cloneSnapshot(confirmed);
    targetRef.current = null;
    failedRevisionRef.current = null;
    recoveryRef.current = false;
    editDeadlineRef.current = null;
    draftRef.current = cloneDraft(candidate);
    revisionRef.current += 1;
    setDraft(cloneDraft(candidate));
    setConflictState(null);
    clearTimer();
    setMessage(null);
    setStatus('clean');
    finishApplication(application, true);
    notifyWaiters();
    return true;
  };

  const handleApplicationSourceFailure = (application: DraftApplication, error: unknown): void => {
    if (!isCurrentApplication(application)) return;
    const authentication = isApplicationAuthentication(error);
    if (authentication) {
      setMessage(authentication.message);
      setStatus('error');
      let accepted = true;
      try {
        accepted = onAuthRequiredRef.current?.(authentication.authContext) !== false;
      } catch {
        accepted = true;
      }
      if (accepted) {
        authBlockedRef.current = true;
        finishApplication(application, false);
      } else {
        setMessage(null);
        scheduleRecovery();
      }
      return;
    }
    if (isApplicationTransient(error)) {
      setMessage(null);
      scheduleRecovery();
      return;
    }

    setMessage(error instanceof Error ? error.message : 'No se pudo cargar la configuración.');
    setStatus('error');
    rejectApplication(application, error);
    const visible = draftRef.current;
    const confirmed = confirmedRef.current;
    if (visible && confirmed && !draftsEqual(visible, confirmed.draft) && !targetRef.current) {
      if (editDeadlineRef.current === null || editDeadlineRef.current <= Date.now()) {
        editDeadlineRef.current = Date.now() + 600;
      }
      scheduleVisibleEdit();
    }
  };

  const runApplicationCycle = async (application: DraftApplication): Promise<boolean> => {
    if (!isCurrentApplication(application)) {
      cancelApplication(application.id);
      return false;
    }
    if (recoveryRef.current && scheduledRef.current !== null) return false;
    if (recoveryRef.current) recoveryRef.current = false;

    const target = targetRef.current;
    if (target) {
      const saved = await reconcileTarget(application);
      if (!isCurrentApplication(application)) return false;
      if (!saved) {
        if (conflictRef.current || authBlockedRef.current) {
          finishApplication(application, false);
        } else if (!recoveryRef.current && targetRef.current === null) {
          finishApplication(application, false);
        }
        return false;
      }
      if (targetRef.current) return false;
    }

    if (!application.candidate) {
      if (typeof application.source === 'function') {
        const loader = application.source;
        const loaded = await performOperation(
          (signal) => loader(signal).then(cloneDraft),
          'get',
          application.id,
        );
        if (!isCurrentApplication(application) || loaded.cancelled) return false;
        if (!loaded.value) {
          handleApplicationSourceFailure(application, loaded.error);
          return false;
        }
        application.candidate = loaded.value;
      } else {
        application.candidate = cloneDraft(application.source);
      }
    }

    const candidate = application.candidate;
    const candidateLimit = candidate
      ? draftLimitMessage(candidate)
      : 'La configuración no es válida.';
    if (candidateLimit) {
      setStatus('error');
      setMessage(candidateLimit);
      finishApplication(application, false);
      return false;
    }

    const visible = draftRef.current;
    const confirmed = confirmedRef.current;
    if (!visible || !confirmed) {
      finishApplication(application, false);
      return false;
    }
    if (!draftsEqual(visible, confirmed.draft)) {
      editDeadlineRef.current = null;
      const savedVisible = await writeDraft(
        visible,
        confirmed.version,
        confirmed,
        application.revision,
        undefined,
        'visible',
        application.id,
      );
      if (!isCurrentApplication(application)) return false;
      if (!savedVisible) {
        if (conflictRef.current || authBlockedRef.current) {
          finishApplication(application, false);
        } else if (!recoveryRef.current && targetRef.current === null) {
          finishApplication(application, false);
        }
        return false;
      }
    }

    if (!isCurrentApplication(application)) return false;
    const candidateBase = confirmedRef.current;
    if (!candidateBase || !candidate) {
      finishApplication(application, false);
      return false;
    }
    const savedCandidate = await writeDraft(
      candidate,
      candidateBase.version,
      candidateBase,
      application.revision,
      undefined,
      'candidate',
      application.id,
    );
    if (savedCandidate && isCurrentApplication(application)) {
      return importApplication(application, confirmedRef.current);
    }
    if (isCurrentApplication(application)) {
      if (conflictRef.current || authBlockedRef.current) {
        finishApplication(application, false);
      } else if (!recoveryRef.current && targetRef.current === null) {
        finishApplication(application, false);
      }
    }
    return savedCandidate;
  };

  const refreshConflict = async (): Promise<boolean> => {
    const displayed = conflictRef.current;
    if (!displayed || !conflictRefreshPendingRef.current || !canAccess()) return false;
    const epoch = epochRef.current;
    const sub = ownerRef.current;
    setConflictActionPending(true);
    try {
      const result = await performOperation((signal) => apiRef.current.getDraft(signal));
      if (!isCurrentOwner(epoch, sub) || result.cancelled) return false;
      if (!result.value) {
        handleFailure(result.error, false);
        return false;
      }
      conflictRefreshPendingRef.current = false;
      recoveryRef.current = false;
      const latest = cloneSnapshot(result.value);
      if (latest.version !== displayed.version || !draftsEqual(latest.draft, displayed.draft)) {
        markConflict(latest);
        setComparisonOpen(true);
        setMessage('La versión guardada cambió. Revisá la comparación y elegí de nuevo.');
      } else {
        setStatus('conflict');
        setMessage('La versión sigue igual. Elegí cómo resolver el conflicto.');
      }
      return false;
    } finally {
      if (isCurrentOwner(epoch, sub)) setConflictActionPending(false);
    }
  };

  const runCycle = (): Promise<boolean> => {
    if (cyclePromiseRef.current) return cyclePromiseRef.current;
    if (
      !canAccess() ||
      (conflictRef.current && !conflictRefreshPendingRef.current) ||
      operationRef.current
    ) {
      return Promise.resolve(false);
    }
    const epoch = epochRef.current;
    const sub = ownerRef.current;
    const promise = (async (): Promise<boolean> => {
      const application = applicationRef.current;
      if (application) return runApplicationCycle(application);
      if (conflictRefreshPendingRef.current && conflictRef.current) return refreshConflict();
      if (!confirmedRef.current) {
        const result = await performOperation((signal) => apiRef.current.getDraft(signal));
        if (!isCurrentOwner(epoch, sub) || result.cancelled) return false;
        if (result.value) {
          setLoadedSnapshot(result.value);
          return true;
        }
        handleFailure(result.error, true);
        return false;
      }
      if (targetRef.current) return reconcileTarget();
      const visible = draftRef.current;
      const confirmed = confirmedRef.current;
      if (!visible || !confirmed) return false;
      if (draftsEqual(visible, confirmed.draft)) {
        updateVisibleState();
        return true;
      }
      return writeDraft(visible, confirmed.version, confirmed, revisionRef.current);
    })();
    cyclePromiseRef.current = promise;
    void promise.then((succeeded) => {
      if (cyclePromiseRef.current === promise) cyclePromiseRef.current = null;
      if (!mountedRef.current || !canAccess() || conflictRef.current) return;
      const application = applicationRef.current;
      if (application) {
        if (
          isCurrentApplication(application) &&
          operationRef.current === null &&
          scheduledRef.current === null &&
          !recoveryRef.current &&
          targetRef.current === null
        ) {
          void runCycleRef.current();
        }
        return;
      }
      if (!succeeded) return;
      if (targetRef.current) return;
      const visible = draftRef.current;
      const confirmed = confirmedRef.current;
      if (!visible || !confirmed || draftsEqual(visible, confirmed.draft)) return;
      if (recoveryRef.current) return;
      const deadline = editDeadlineRef.current;
      if (deadline !== null) {
        if (deadline <= Date.now()) void runCycleRef.current();
        else scheduleAt(deadline);
      }
    });
    return promise;
  };
  runCycleRef.current = runCycle;

  const updateDraft = (next: RobotDraft): void => {
    if (!canAccess() || lockedRef.current) return;
    cancelApplication();
    const copy = cloneDraft(next);
    draftRef.current = copy;
    revisionRef.current += 1;
    failedRevisionRef.current = null;
    editDeadlineRef.current = Date.now() + 600;
    setDraft(copy);
    if (conflictRef.current) {
      setStatus('conflict');
      setMessage(
        'Otra pestaña guardó una versión distinta. Compará ambas versiones para resolver.',
      );
      return;
    }
    const confirmed = confirmedRef.current;
    if (
      confirmed &&
      !targetRef.current &&
      !operationRef.current &&
      draftsEqual(copy, confirmed.draft)
    ) {
      editDeadlineRef.current = null;
      if (!recoveryRef.current || scheduledRef.current === null) {
        recoveryRef.current = false;
        clearTimer();
      }
      setStatus('clean');
      setMessage(null);
      notifyWaiters();
      return;
    }
    if (recoveryRef.current || targetRef.current) {
      setStatus(operationRef.current ? 'saving' : 'recovering');
      return;
    }
    if (confirmed && draftsEqual(copy, confirmed.draft)) {
      setStatus(operationRef.current ? 'saving' : 'clean');
      setMessage(null);
      if (!operationRef.current) {
        editDeadlineRef.current = null;
        clearTimer();
      } else {
        scheduleVisibleEdit();
      }
    } else {
      setStatus(operationRef.current ? 'saving' : 'dirty');
      setMessage(null);
      scheduleVisibleEdit();
    }
  };

  const isClean = (): boolean => {
    const visible = draftRef.current;
    const confirmed = confirmedRef.current;
    return Boolean(
      visible &&
      confirmed &&
      operationRef.current === null &&
      targetRef.current === null &&
      conflictRef.current === null &&
      draftsEqual(visible, confirmed.draft),
    );
  };

  const flushPending = async (): Promise<boolean> => {
    if (!canAccess() || conflictRef.current) return false;
    const cycle = cyclePromiseRef.current;
    if (cycle && isVisiblePutInFlight()) {
      await cycle;
      return isClean();
    }
    if (isClean()) return true;
    if (recoveryRef.current || targetRef.current) return false;
    if (cycle) {
      await cycle;
      return isClean();
    }
    if (operationRef.current !== null) return false;
    const current = draftRef.current;
    const confirmed = confirmedRef.current;
    if (current && confirmed && draftsEqual(current, confirmed.draft)) return true;
    clearTimer();
    const result = await runCycle();
    return result && isClean();
  };

  const captureSnapshot = async (): Promise<DraftSnapshot | null> => {
    const frozen = draftRef.current;
    const revision = revisionRef.current;
    const epoch = epochRef.current;
    const owner = ownerRef.current;
    const saved = confirmedRef.current;
    const joinVisiblePut = isVisiblePutInFlight();
    if (
      !frozen ||
      !saved ||
      !canAccess() ||
      conflictRef.current ||
      (targetRef.current && !joinVisiblePut) ||
      draftLimitMessage(frozen)
    ) {
      return null;
    }
    if (
      draftsEqual(frozen, saved.draft) &&
      saved.version > 0 &&
      operationRef.current === null &&
      targetRef.current === null
    ) {
      return cloneSnapshot(saved);
    }
    if (recoveryRef.current && !joinVisiblePut) return null;
    let confirmed: boolean;
    if (joinVisiblePut) {
      const firstCycle = cyclePromiseRef.current;
      if (!firstCycle) return null;
      const firstSucceeded = await firstCycle;
      if (
        !firstSucceeded ||
        !isCurrentOwner(epoch, owner) ||
        revisionRef.current !== revision ||
        !canAccess() ||
        conflictRef.current
      ) {
        return null;
      }

      // A visible save may finish after a newer revision was edited. Capture
      // only the revision frozen above: join a normal autosave if it already
      // started for that exact draft, otherwise send that frozen draft now.
      if (targetRef.current) {
        const nextCycle = cyclePromiseRef.current;
        if (
          !nextCycle ||
          !isVisiblePutInFlight() ||
          !draftsEqual(targetRef.current.draft, frozen)
        ) {
          return null;
        }
        confirmed = await nextCycle;
      } else {
        const latest = confirmedRef.current;
        if (!latest || recoveryRef.current) return null;
        if (draftsEqual(latest.draft, frozen)) {
          confirmed = true;
        } else {
          clearTimer();
          editDeadlineRef.current = null;
          confirmed = await writeDraft(frozen, latest.version, latest, revision);
        }
      }
    } else if (saved.version === 0 && draftsEqual(frozen, saved.draft)) {
      confirmed = await writeDraft(frozen, saved.version, saved, revision);
    } else {
      confirmed = await flushPending();
    }
    const after = confirmedRef.current;
    if (
      !confirmed ||
      revisionRef.current !== revision ||
      !after ||
      after.version <= 0 ||
      !draftsEqual(after.draft, frozen)
    ) {
      return null;
    }
    return cloneSnapshot(after);
  };

  const applyDraft = (
    source: DraftApplicationSource,
    options?: { signal?: AbortSignal },
  ): Promise<boolean> => {
    cancelApplication();
    const signal = options?.signal;
    if (
      signal?.aborted ||
      !canAccess() ||
      lockedRef.current ||
      attemptClickLockedRef.current ||
      !confirmedRef.current ||
      conflictRef.current ||
      !draftRef.current
    ) {
      return Promise.resolve(false);
    }

    let visible: RobotDraft;
    let candidate: RobotDraft | undefined;
    try {
      visible = cloneDraft(draftRef.current);
      if (typeof source !== 'function') candidate = cloneDraft(source);
    } catch {
      return Promise.resolve(false);
    }

    let resolve!: (applied: boolean) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const application: DraftApplication = {
      id: ++applicationIdRef.current,
      epoch: epochRef.current,
      owner: ownerRef.current,
      revision: revisionRef.current,
      visible,
      source,
      ...(signal ? { signal } : {}),
      resolve,
      reject,
      ...(candidate ? { candidate } : {}),
      settled: false,
    };
    applicationRef.current = application;
    if (signal) {
      application.onAbort = () => cancelApplication(application.id);
      signal.addEventListener('abort', application.onAbort, { once: true });
      if (signal.aborted) {
        cancelApplication(application.id);
        return promise;
      }
    }
    void runCycleRef.current();
    return promise;
  };

  const waitForConfirmed = (signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    if (isClean()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        signal,
        resolve,
        onAbort: () => {
          waitersRef.current.delete(waiter);
          signal.removeEventListener('abort', waiter.onAbort);
          resolve(false);
        },
      };
      waitersRef.current.add(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  };

  const discardPending = (): void => {
    const replacement = conflictRef.current ?? confirmedRef.current;
    cancelApplication();
    epochRef.current += 1;
    clearTimer();
    operationRef.current?.controller.abort();
    operationRef.current = null;
    cyclePromiseRef.current = null;
    setConflictActionPending(false);
    targetRef.current = null;
    failedRevisionRef.current = null;
    recoveryRef.current = false;
    editDeadlineRef.current = null;
    revisionRef.current += 1;
    notifyWaiters(false);
    if (replacement) setLoadedSnapshot(replacement);
  };

  useEffect(() => {
    onConfigurationAvailabilityChange?.(draft !== null);
  }, [draft, onConfigurationAvailabilityChange]);

  useEffect(
    () => () => onConfigurationAvailabilityChange?.(false),
    [onConfigurationAvailabilityChange],
  );

  useImperativeHandle(ref, () => ({
    hasUnconfirmedChanges: () => {
      const current = draftRef.current;
      const saved = confirmedRef.current;
      return Boolean(
        current &&
        saved &&
        (operationRef.current !== null ||
          targetRef.current !== null ||
          !draftsEqual(current, saved.draft)),
      );
    },
    discardPending,
    flushPending,
    waitForConfirmed,
    captureSnapshot,
    applyDraft,
    cancelApplication,
    releaseAttemptLock: () => {
      attemptClickLockedRef.current = false;
      setAttemptClickLocked(false);
    },
    focusEditor: () => {
      const heading = editorHeadingRef.current;
      if (!heading) return;
      heading.scrollIntoView?.({
        block: 'start',
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
      heading.focus();
    },
  }));

  useEffect(() => {
    mountedRef.current = true;
    cancelApplication();
    const sub = session.identity.sub;
    epochRef.current += 1;
    ownerRef.current = sub;
    authBlockedRef.current = false;
    conflictRefreshPendingRef.current = false;
    setConflictActionPending(false);
    clearTimer();
    operationRef.current?.controller.abort();
    operationRef.current = null;
    cyclePromiseRef.current = null;
    targetRef.current = null;
    failedRevisionRef.current = null;
    recoveryRef.current = false;
    editDeadlineRef.current = null;
    revisionRef.current = 0;
    draftRef.current = null;
    confirmedRef.current = null;
    setDraft(null);
    setConflictState(null);
    setMessage(null);
    setStatus('loading');
    if (canAccess()) void runCycleRef.current();
    return () => {
      const application = applicationRef.current;
      if (application) {
        const operation = operationRef.current;
        if (operation?.applicationId === application.id) {
          operation.controller.abort();
          operationRef.current = null;
        }
        finishApplication(application, false);
      }
      mountedRef.current = false;
      epochRef.current += 1;
      clearTimer();
      operationRef.current?.controller.abort();
      operationRef.current = null;
      targetRef.current = null;
      cyclePromiseRef.current = null;
      notifyWaiters(false);
    };
    // The editor owner changes only with API client or authenticated identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session.identity.sub]);

  useLayoutEffect(() => {
    const blocked = paused || accessState !== 'ready';
    if (blocked) {
      cancelApplicationRef.current();
      cancelTimer();
      epochRef.current += 1;
      const active = operationRef.current;
      active?.controller.abort();
      operationRef.current = null;
      cyclePromiseRef.current = null;
      setConflictActionPending(false);
      return;
    }
    if (authBlockedRef.current) authBlockedRef.current = false;
    if (mountedRef.current && (targetRef.current || !confirmedRef.current || !isClean())) {
      if (targetRef.current || !confirmedRef.current) {
        clearTimer();
        recoveryRef.current = false;
        void runCycleRef.current();
      } else if (recoveryRef.current) {
        const deadline = scheduledRef.current?.deadline ?? Date.now() + 60_000;
        scheduleAtRef.current(deadline);
      } else {
        const deadline = editDeadlineRef.current;
        if (deadline !== null) scheduleAtRef.current(deadline);
        else void runCycleRef.current();
      }
    }
  }, [paused, accessState]);

  useEffect(() => {
    if (locked) cancelApplicationRef.current();
  }, [locked]);

  useEffect(() => {
    if (!comparisonOpen || !conflict) return;
    comparisonHeadingRef.current?.focus();
  }, [comparisonOpen, conflict]);

  useEffect(() => {
    if (!comparisonOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setComparisonOpen(false);
        requestAnimationFrame(() => conflictTriggerRef.current?.focus());
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [comparisonOpen]);

  const resolveUseStored = async (): Promise<void> => {
    if (
      !canAccess() ||
      lockedRef.current ||
      attemptClickLockedRef.current ||
      conflictActionPending
    ) {
      return;
    }
    const displayed = conflictRef.current;
    if (!displayed || operationRef.current) return;
    const localRevision = revisionRef.current;
    clearTimer();
    recoveryRef.current = false;
    conflictRefreshPendingRef.current = false;
    setConflictActionPending(true);
    setMessage(null);
    const epoch = epochRef.current;
    const sub = ownerRef.current;
    try {
      const result = await performOperation((signal) => apiRef.current.getDraft(signal));
      if (!isCurrentOwner(epoch, sub) || result.cancelled || !result.value) {
        if (!result.cancelled) {
          if (isTransient(result.error)) conflictRefreshPendingRef.current = true;
          handleFailure(result.error, false);
        }
        return;
      }
      const latest = cloneSnapshot(result.value);
      if (latest.version !== displayed.version || !draftsEqual(latest.draft, displayed.draft)) {
        markConflict(latest);
        setComparisonOpen(true);
        setMessage('La versión guardada cambió. Revisá la comparación y elegí de nuevo.');
        return;
      }
      if (revisionRef.current !== localRevision) {
        setStatus('conflict');
        setMessage('Tus cambios cambiaron mientras comprobábamos. Elegí de nuevo.');
        return;
      }
      setLoadedSnapshot(latest);
    } finally {
      if (isCurrentOwner(epoch, sub)) setConflictActionPending(false);
    }
  };

  const resolveKeepMine = (): void => {
    if (
      !canAccess() ||
      lockedRef.current ||
      attemptClickLockedRef.current ||
      conflictActionPending
    ) {
      return;
    }
    if (operationRef.current) return;
    const displayed = conflictRef.current;
    const visible = draftRef.current;
    if (!displayed || !visible) return;
    conflictRefreshPendingRef.current = false;
    recoveryRef.current = false;
    clearTimer();
    confirmedRef.current = cloneSnapshot(displayed);
    setConflictState(null);
    setMessage(null);
    editDeadlineRef.current = Date.now() + 600;
    setStatus('dirty');
    scheduleAt(editDeadlineRef.current);
  };

  const onInstructionsChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    if (!draft) return;
    updateDraft({ ...draft, instructions: event.target.value });
  };

  const onSkillDescriptionChange = (id: RobotSkillId, value: string): void => {
    if (!draft) return;
    updateDraft({
      ...draft,
      skills: draft.skills.map((skill) =>
        skill.id === id ? { id: skill.id, enabled: skill.enabled, description: value } : skill,
      ),
    });
  };

  const onSkillEnabledChange = (id: RobotSkillId, enabled: boolean): void => {
    if (!draft) return;
    updateDraft({
      ...draft,
      skills: draft.skills.map((skill) => (skill.id === id ? { ...skill, enabled } : skill)),
    });
  };

  const disabled =
    paused || accessState !== 'ready' || locked || attemptClickLocked || status === 'loading';
  const fieldsetDisabled = locked || attemptClickLocked || status === 'loading';
  const byteCount = draft ? draftByteLength(draft) : 0;
  const limitMessage = draft ? draftLimitMessage(draft) : null;
  const shouldWarnAboutDraftSize = byteCount >= DRAFT_SIZE_WARNING_THRESHOLD;
  const isLoadError = status === 'error' && draft === null && confirmedRef.current === null;
  const localComparisonDraft = draft;

  useEffect(() => {
    const saved = confirmedRef.current;
    const hasPending = Boolean(
      draft &&
      saved &&
      (operationRef.current !== null ||
        targetRef.current !== null ||
        !draftsEqual(draft, saved.draft)),
    );
    if (!hasPending) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent): string => {
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [conflict, draft, status]);
  return (
    <section
      className="robot-editor"
      aria-labelledby="robot-editor-title"
      aria-busy={
        paused || accessState !== 'ready' || locked || attemptClickLocked || status === 'loading'
      }
    >
      <div className="editor-heading">
        <div>
          <p className="card-kicker">Configuración persistida</p>
          <div className="editor-title-line">
            <h2 id="robot-editor-title" ref={editorHeadingRef} tabIndex={-1}>
              Prepará tu robot
            </h2>
            {draft && (
              <span className="editor-model-meta">
                Modelo del agente:{' '}
                <strong aria-label="Modelo fijo para el próximo intento">
                  {MODEL_CATALOG.find((model) => model.key === draft.modelKey)?.label ??
                    'Modelo no disponible'}
                </strong>
              </span>
            )}
          </div>
          <p className="editor-intro">
            Elegí sus habilidades y escribí las instrucciones que recibirá. Los cambios se guardan
            automáticamente. Al probarlo, se fija exactamente lo que estás viendo.
          </p>
          <details className="editor-help">
            <summary>Ayuda para empezar</summary>
            <div className="editor-help-copy">
              <p>
                La configuración inicial es limitada a propósito: sólo Avanzar viene habilitada y
                las descripciones están vacías para que decidas qué comunicarle al agente.
              </p>
              <dl>
                <div>
                  <dt>Instrucciones generales</dt>
                  <dd>Definen el objetivo y las prioridades que querés comunicar.</dd>
                </div>
                <div>
                  <dt>Descripción de una habilidad</dt>
                  <dd>
                    Explica esa capacidad al agente. Se envía literalmente y puede quedar vacía o
                    ser incompleta.
                  </dd>
                </div>
                <div>
                  <dt>Qué recibe el agente</dt>
                  <dd>
                    En cada decisión recibe tus instrucciones, las habilidades habilitadas y una
                    observación local nueva. No recibe el mapa completo ni el historial de turnos.
                  </dd>
                </div>
              </dl>
              <p className="editor-help-example">
                Ejemplo de descripción para Avanzar: «Camina una casilla hacia la derecha».
              </p>
            </div>
          </details>
        </div>
        <span className={`save-state save-state-${status}`} role="status" aria-live="polite">
          {statusLabel(status, isLoadError)}
        </span>
      </div>

      {(accessState === 'checking' || (paused && accessState === 'ready')) && (
        <p className="editor-access-status editor-access-status-checking" role="status">
          Verificando tu sesión… Conservamos tus cambios en esta pestaña.
        </p>
      )}
      {accessState === 'required' && (
        <p className="editor-access-status editor-access-status-required" role="status">
          Tu sesión necesita atención. Conservamos tus cambios en esta pestaña.
        </p>
      )}
      {locked && !paused && accessState === 'ready' && (
        <p className="editor-paused" role="status">
          Conservamos esta configuración mientras preparamos o reproducimos el intento, o cargamos
          la preferencia de animación.
        </p>
      )}
      {limitMessage && (
        <p className="configuration-limit-warning" role="alert">
          {limitMessage} Corregí el texto para guardar o probar sin perderlo.
        </p>
      )}
      {message && status !== 'clean' && message !== limitMessage && (
        <p className="editor-message" role={status === 'error' ? 'alert' : 'status'}>
          {message}
        </p>
      )}

      {status === 'loading' && (
        <p className="editor-loading">Recuperando tu configuración guardada…</p>
      )}

      {draft && (
        <form className="editor-form" onSubmit={(event) => event.preventDefault()}>
          <fieldset disabled={fieldsetDisabled}>
            <legend>Instrucciones generales</legend>
            <label htmlFor="robot-instructions">Qué debe tener en cuenta el robot</label>
            <textarea
              id="robot-instructions"
              value={draft.instructions}
              onChange={onInstructionsChange}
              readOnly={disabled}
              aria-describedby="robot-instructions-count"
              aria-invalid={countCharacters(draft.instructions) > MAX_INSTRUCTIONS_CHARACTERS}
              rows={5}
            />
            <p className="character-count" id="robot-instructions-count" aria-live="polite">
              {formatCharacterCount(draft.instructions, MAX_INSTRUCTIONS_CHARACTERS)}
            </p>
          </fieldset>

          <fieldset disabled={fieldsetDisabled}>
            <legend>Habilidades disponibles</legend>
            <p className="field-help">
              Las descripciones se envían literalmente al agente. La ayuda de cada tarjeta no se
              agrega al texto.
            </p>
            <div className="skill-list">
              {ROBOT_CATALOG.map((entry) => {
                const skill = draft.skills.find((candidate) => candidate.id === entry.id);
                if (!skill) return null;
                return (
                  <article className="skill-card" key={entry.id}>
                    <div className="skill-card-heading">
                      <label className="skill-toggle">
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          disabled={disabled}
                          onChange={(event) => onSkillEnabledChange(entry.id, event.target.checked)}
                        />
                        <span>{entry.name}</span>
                      </label>
                      <span className="skill-help">{entry.description}</span>
                    </div>
                    <label htmlFor={`skill-description-${entry.id}`}>
                      Descripción de {entry.name} para el agente
                    </label>
                    <textarea
                      id={`skill-description-${entry.id}`}
                      value={skill.description ?? ''}
                      onChange={(event) => onSkillDescriptionChange(entry.id, event.target.value)}
                      readOnly={disabled}
                      aria-describedby={`skill-description-count-${entry.id}`}
                      aria-invalid={
                        countCharacters(skill.description ?? '') > MAX_SKILL_DESCRIPTION_CHARACTERS
                      }
                      rows={3}
                    />
                    <p
                      className="character-count"
                      id={`skill-description-count-${entry.id}`}
                      aria-live="polite"
                    >
                      {formatCharacterCount(
                        skill.description ?? '',
                        MAX_SKILL_DESCRIPTION_CHARACTERS,
                      )}
                    </p>
                  </article>
                );
              })}
            </div>
          </fieldset>

          {draft.skills.every((skill) => !skill.enabled) && (
            <p className="editor-hint" role="status">
              Podés guardar esta configuración sin habilidades activas. Para ejecutar un recorrido
              más adelante vas a necesitar al menos una.
            </p>
          )}

          {shouldWarnAboutDraftSize && !limitMessage && (
            <p className="configuration-size-warning">
              La configuración está cerca del límite de tamaño. Si lo supera, no se va a poder
              guardar.
            </p>
          )}
        </form>
      )}

      <div
        id="attempt-controls-slot"
        className="editor-attempt-controls"
        role="group"
        aria-label="Controles de prueba y animación"
        ref={onAttemptControlsHostChange}
      >
        {onTry && (
          <div className="editor-actions attempt-action">
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                attemptClickLockedRef.current = true;
                setAttemptClickLocked(true);
                onTry();
              }}
              disabled={
                disabled || draft === null || status === 'conflict' || limitMessage !== null
              }
            >
              Probar
            </button>
            <span className="field-help">
              Cada prueba admitida consume un intento de tu cuota diaria, aunque la canceles o
              termine con un error.
            </span>
          </div>
        )}
      </div>

      {conflict && (
        <div className="editor-conflict" role="group" aria-label="Resolución del conflicto">
          <button
            className="secondary-button editor-conflict-trigger"
            type="button"
            ref={conflictTriggerRef}
            aria-expanded={comparisonOpen}
            aria-controls="editor-conflict-comparison"
            onClick={() => setComparisonOpen((open) => !open)}
          >
            Comparar versiones
          </button>
          {comparisonOpen && (
            <div
              className="editor-conflict-comparison"
              id="editor-conflict-comparison"
              role="region"
              aria-labelledby="editor-conflict-comparison-title"
            >
              <h4 id="editor-conflict-comparison-title" ref={comparisonHeadingRef} tabIndex={-1}>
                Comparación completa de versiones
              </h4>
              <p>
                Tu borrador sigue visible. La versión guardada puede cambiar mientras comparás;
                volveremos a comprobarla antes de descartarlo.
              </p>
              <div className="editor-conflict-fields">
                <div className="editor-conflict-field">
                  <h4>Instrucciones generales</h4>
                  <div className="editor-conflict-side">
                    <strong>Tu borrador (base v{confirmedRef.current?.version ?? 0})</strong>
                    <pre>{localComparisonDraft?.instructions ?? ''}</pre>
                  </div>
                  <div className="editor-conflict-side">
                    <strong>Guardada (v{conflict.version})</strong>
                    <pre>{conflict.draft.instructions}</pre>
                  </div>
                </div>
              </div>
              <ul className="editor-conflict-fields editor-conflict-skills">
                {ROBOT_CATALOG.map((entry) => {
                  const localSkill = localComparisonDraft?.skills.find(
                    (skill) => skill.id === entry.id,
                  );
                  const savedSkill = conflict.draft.skills.find((skill) => skill.id === entry.id);
                  if (!localSkill || !savedSkill) return null;
                  const formatSkill = (skill: RobotDraft['skills'][number]): string =>
                    `${skill.enabled ? 'Habilitada' : 'Deshabilitada'}\n${Object.prototype.hasOwnProperty.call(skill, 'description') ? skill.description : '(sin descripción)'}`;
                  return (
                    <li className="editor-conflict-field" key={entry.id}>
                      <h4>{entry.name}</h4>
                      <div className="editor-conflict-side">
                        <strong>Tu borrador (base v{confirmedRef.current?.version ?? 0})</strong>
                        <pre>{formatSkill(localSkill)}</pre>
                      </div>
                      <div className="editor-conflict-side">
                        <strong>Guardada (v{conflict.version})</strong>
                        <pre>{formatSkill(savedSkill)}</pre>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="editor-conflict-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void resolveUseStored()}
                  disabled={disabled || conflictActionPending}
                >
                  Usar lo guardado
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={resolveKeepMine}
                  disabled={disabled || conflictActionPending}
                >
                  Conservar mis cambios
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setComparisonOpen(false);
                    requestAnimationFrame(() => conflictTriggerRef.current?.focus());
                  }}
                >
                  Cerrar comparación
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
});

RobotEditor.displayName = 'RobotEditor';
