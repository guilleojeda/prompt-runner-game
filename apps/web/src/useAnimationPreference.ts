import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiAuthRequired } from './api-auth.js';
import { AttemptApiFailure, isTransientReadFailure, type AttemptApi } from './attempt-api.js';
import type { AnimationPreference } from '../../../shared/attempt.js';

const RECOVERY_DELAY_MS = 60_000;

interface WriteTarget {
  readonly value: boolean;
  readonly expectedVersion: number;
  readonly revision: number;
  readonly baseValue: boolean;
}

interface PreferenceConflict {
  readonly remote: AnimationPreference;
  readonly message: string;
}

type ReadPurpose = 'initial' | 'uncertain' | 'compare' | 'resume';

type RetryPlan =
  | { readonly kind: 'read'; readonly purpose: ReadPurpose; readonly target?: WriteTarget }
  | { readonly kind: 'write' };

interface PreferenceState {
  readonly confirmed: AnimationPreference | null;
  readonly value: boolean;
  readonly revision: number;
  readonly choiceMade: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly recovering: boolean;
  readonly error: string | null;
  readonly conflict: PreferenceConflict | null;
  readonly uncertainTarget: WriteTarget | null;
  readonly comparisonTarget: WriteTarget | null;
  readonly forcedWriteVersion: number | null;
}

interface ActiveOperation {
  readonly generation: number;
  readonly identity: string;
  readonly kind: 'read' | 'write';
  readonly purpose?: ReadPurpose;
  readonly target?: WriteTarget;
  readonly controller: AbortController;
}

function isPreferenceReady(
  state: PreferenceState,
  authPaused: boolean,
  activeOperation: ActiveOperation | null,
  retryPlan: RetryPlan | null,
): boolean {
  return (
    !authPaused &&
    activeOperation === null &&
    retryPlan === null &&
    state.confirmed !== null &&
    !state.loading &&
    !state.saving &&
    !state.recovering &&
    state.error === null &&
    state.conflict === null &&
    state.uncertainTarget === null &&
    state.comparisonTarget === null &&
    state.forcedWriteVersion === null &&
    state.value === state.confirmed.animationEnabled
  );
}

interface UseAnimationPreferenceOptions {
  readonly api: AttemptApi;
  readonly identity: string;
  readonly authPaused: boolean;
  readonly onAuthRequired?: ApiAuthRequired;
}

export interface AnimationPreferenceController {
  readonly value: boolean;
  readonly unknown: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly recovering: boolean;
  readonly error: string | null;
  readonly conflict: PreferenceConflict | null;
  readonly ready: boolean;
  isReadyNow(): boolean;
  confirmedValueNow(): boolean | null;
  choose(value: boolean): void;
  saveSelection(): void;
}

function initialState(): PreferenceState {
  return {
    confirmed: null,
    value: true,
    revision: 0,
    choiceMade: false,
    loading: false,
    saving: false,
    recovering: false,
    error: null,
    conflict: null,
    uncertainTarget: null,
    comparisonTarget: null,
    forcedWriteVersion: null,
  };
}

function hasPendingIntent(state: PreferenceState): boolean {
  if (state.conflict !== null) return false;
  return (
    state.uncertainTarget !== null ||
    state.comparisonTarget !== null ||
    state.forcedWriteVersion !== null ||
    (state.confirmed !== null && state.value !== state.confirmed.animationEnabled) ||
    (state.confirmed === null && state.choiceMade)
  );
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}

function conflictMessage(remote: AnimationPreference): string {
  return `No se guardó tu cambio porque la preferencia del servidor ahora está ${remote.animationEnabled ? 'activada' : 'desactivada'}. Tu selección sigue visible; elegí guardarla para resolver el conflicto.`;
}

function fenceConflictMessage(): string {
  return 'La versión guardada todavía no permite confirmar tu selección. Sigue visible; elegí guardarla para volver a comprobarla.';
}

export function useAnimationPreference({
  api,
  identity,
  authPaused,
  onAuthRequired,
}: UseAnimationPreferenceOptions): AnimationPreferenceController {
  const [state, setState] = useState<PreferenceState>(initialState);
  const stateRef = useRef(state);
  const apiRef = useRef(api);
  const authRequiredRef = useRef(onAuthRequired);
  const identityRef = useRef(identity);
  const authPausedRef = useRef(authPaused);
  const mountedRef = useRef(false);
  const initializedRef = useRef(false);
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveOperation | null>(null);
  const timerRef = useRef<number | null>(null);
  const retryPlanRef = useRef<RetryPlan | null>(null);
  const retryDeadlineRef = useRef<number | null>(null);
  const resumeNeedsReadRef = useRef(false);

  apiRef.current = api;
  authRequiredRef.current = onAuthRequired;

  const commit = useCallback((update: (current: PreferenceState) => PreferenceState): void => {
    const next = update(stateRef.current);
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  function clearRetryTimer(clearPlan = true): void {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    retryDeadlineRef.current = null;
    if (clearPlan) retryPlanRef.current = null;
  }

  function isCurrent(operation: ActiveOperation): boolean {
    return (
      mountedRef.current &&
      activeRef.current === operation &&
      generationRef.current === operation.generation &&
      identityRef.current === operation.identity &&
      !operation.controller.signal.aborted &&
      !authPausedRef.current
    );
  }

  function reportAuthFailure(error: AttemptApiFailure): boolean {
    return authRequiredRef.current?.(error.authContext) === false;
  }

  function invalidReadback(
    preference: AnimationPreference,
    confirmed: AnimationPreference | null,
  ): string | null {
    if (confirmed && preference.version < confirmed.version) {
      return 'La preferencia recibida es anterior a la versión confirmada. Conservamos tu selección hasta poder comprobar una versión válida.';
    }
    if (
      confirmed &&
      preference.version === confirmed.version &&
      preference.animationEnabled !== confirmed.animationEnabled
    ) {
      return 'La preferencia recibida no coincide con el contenido de su versión. Conservamos tu selección hasta poder comprobar una versión válida.';
    }
    return null;
  }

  function scheduleRecovery(plan: RetryPlan): void {
    clearRetryTimer();
    const deadline = Date.now() + RECOVERY_DELAY_MS;
    const generation = generationRef.current;
    retryPlanRef.current = plan;
    retryDeadlineRef.current = deadline;
    commit((current) => ({
      ...current,
      loading: false,
      saving:
        plan.kind === 'write' ||
        (plan.kind === 'read' && plan.purpose === 'compare') ||
        current.uncertainTarget !== null ||
        current.comparisonTarget !== null ||
        (current.confirmed !== null && current.value !== current.confirmed.animationEnabled),
      recovering: true,
      error: null,
    }));

    timerRef.current = window.setTimeout(
      () => runDueRetry(deadline, generation),
      RECOVERY_DELAY_MS,
    );
  }

  function runDueRetry(expectedDeadline: number, expectedGeneration: number): void {
    if (
      generationRef.current !== expectedGeneration ||
      retryDeadlineRef.current !== expectedDeadline
    ) {
      return;
    }
    timerRef.current = null;
    if (authPausedRef.current || activeRef.current !== null) {
      resumeNeedsReadRef.current = true;
      return;
    }
    if (Date.now() < expectedDeadline) {
      timerRef.current = window.setTimeout(
        () => runDueRetry(expectedDeadline, expectedGeneration),
        expectedDeadline - Date.now(),
      );
      return;
    }
    const scheduledPlan = retryPlanRef.current;
    retryPlanRef.current = null;
    retryDeadlineRef.current = null;
    commit((current) => ({ ...current, recovering: false }));
    if (scheduledPlan) runRetryPlan(scheduledPlan);
  }

  function dispatchDueRetry(): void {
    const deadline = retryDeadlineRef.current;
    if (
      deadline === null ||
      Date.now() < deadline ||
      authPausedRef.current ||
      activeRef.current !== null ||
      document.visibilityState === 'hidden'
    ) {
      return;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    runDueRetry(deadline, generationRef.current);
  }

  function runRetryPlan(plan: RetryPlan): void {
    if (authPausedRef.current || activeRef.current !== null) {
      retryPlanRef.current = plan;
      retryDeadlineRef.current = Date.now();
      resumeNeedsReadRef.current = true;
      return;
    }
    if (plan.kind === 'read') {
      startRead(plan.purpose, plan.target);
    } else {
      pump();
    }
  }

  function startRead(purpose: ReadPurpose, target?: WriteTarget): void {
    if (authPausedRef.current || activeRef.current !== null) return;
    clearRetryTimer();
    const operation: ActiveOperation = {
      generation: generationRef.current,
      identity: identityRef.current,
      kind: 'read',
      purpose,
      ...(target ? { target } : {}),
      controller: new AbortController(),
    };
    activeRef.current = operation;
    commit((current) => ({
      ...current,
      loading: current.confirmed === null,
      saving:
        purpose === 'compare' ||
        (purpose !== 'initial' &&
          (current.uncertainTarget !== null ||
            current.comparisonTarget !== null ||
            (current.confirmed !== null && current.value !== current.confirmed.animationEnabled))),
      recovering: false,
      error: null,
    }));

    void (async () => {
      let succeeded = false;
      try {
        const preference = await apiRef.current.getAnimationPreference(operation.controller.signal);
        if (!isCurrent(operation)) return;
        const protocolError = invalidReadback(preference, stateRef.current.confirmed);
        if (protocolError) {
          commit((current) => ({
            ...current,
            loading: false,
            saving: hasPendingIntent(current),
            recovering: false,
            error: protocolError,
          }));
          succeeded = true;
          return;
        }
        applyReadback(preference, purpose, target);
        succeeded = true;
      } catch (error) {
        if (!isCurrent(operation)) return;
        if (error instanceof AttemptApiFailure && error.code === 'authentication') {
          if (reportAuthFailure(error)) {
            scheduleRecovery({ kind: 'read', purpose, ...(target ? { target } : {}) });
          } else {
            commit((current) => ({
              ...current,
              loading: false,
              saving: hasPendingIntent(current),
              recovering: false,
              error: failureMessage(error, 'No se pudo consultar la preferencia de animación.'),
            }));
          }
        } else if (isTransientReadFailure(error)) {
          scheduleRecovery({ kind: 'read', purpose, ...(target ? { target } : {}) });
        } else {
          commit((current) => ({
            ...current,
            loading: false,
            saving: hasPendingIntent(current),
            recovering: false,
            error: failureMessage(error, 'No se pudo consultar la preferencia de animación.'),
          }));
        }
      } finally {
        if (isCurrent(operation)) {
          activeRef.current = null;
          commit((current) => ({
            ...current,
            loading: false,
            saving: current.recovering
              ? current.saving
              : current.error === null && hasPendingIntent(current),
          }));
          if (succeeded && retryPlanRef.current === null) pump();
        }
      }
    })();
  }

  function applyReadback(
    preference: AnimationPreference,
    purpose: ReadPurpose,
    target?: WriteTarget,
  ): void {
    const current = stateRef.current;
    if (purpose === 'uncertain') {
      const unresolved = target ?? current.uncertainTarget;
      if (!unresolved) {
        applyOrdinaryReadback(preference);
        return;
      }
      if (preference.version > unresolved.expectedVersion) {
        if (preference.animationEnabled === current.value) {
          commit((latest) => ({
            ...latest,
            confirmed: preference,
            choiceMade: false,
            uncertainTarget: null,
            comparisonTarget: null,
            forcedWriteVersion: null,
            saving: false,
            recovering: false,
            error: null,
            conflict: null,
          }));
        } else if (preference.animationEnabled === unresolved.value) {
          commit((latest) => ({
            ...latest,
            confirmed: preference,
            uncertainTarget: null,
            comparisonTarget: null,
            forcedWriteVersion: null,
            saving: true,
            recovering: false,
            error: null,
            conflict: null,
          }));
        } else {
          commit((latest) => ({
            ...latest,
            confirmed: preference,
            uncertainTarget: null,
            comparisonTarget: null,
            forcedWriteVersion: null,
            saving: false,
            recovering: false,
            error: null,
            conflict: { remote: preference, message: conflictMessage(preference) },
          }));
        }
        return;
      }
      if (
        preference.version === unresolved.expectedVersion &&
        preference.animationEnabled === unresolved.baseValue
      ) {
        commit((latest) => ({
          ...latest,
          confirmed: preference,
          uncertainTarget: null,
          comparisonTarget: null,
          forcedWriteVersion: preference.version,
          saving: true,
          recovering: false,
          error: null,
          conflict: null,
        }));
        return;
      }
      commit((latest) => ({
        ...latest,
        loading: false,
        saving: true,
        recovering: false,
        error:
          'La lectura no confirma una versión que permita continuar sin riesgo. Conservamos tu selección.',
      }));
      return;
    }

    if (purpose === 'compare') {
      const fenceStillUnresolved =
        current.forcedWriteVersion !== null && preference.version <= current.forcedWriteVersion;
      if (preference.animationEnabled === current.value && !fenceStillUnresolved) {
        commit((latest) => ({
          ...latest,
          confirmed: preference,
          choiceMade: false,
          uncertainTarget: null,
          comparisonTarget: null,
          forcedWriteVersion: null,
          saving: false,
          recovering: false,
          error: null,
          conflict: null,
        }));
      } else {
        commit((latest) => ({
          ...latest,
          confirmed: preference,
          choiceMade: preference.animationEnabled === current.value ? false : latest.choiceMade,
          uncertainTarget: null,
          comparisonTarget: null,
          forcedWriteVersion: fenceStillUnresolved ? current.forcedWriteVersion : null,
          saving: false,
          recovering: false,
          error: null,
          conflict: {
            remote: preference,
            message:
              fenceStillUnresolved && preference.animationEnabled === current.value
                ? fenceConflictMessage()
                : conflictMessage(preference),
          },
        }));
      }
      return;
    }

    if (purpose === 'resume') {
      const previous = current.confirmed;
      if (current.forcedWriteVersion !== null && preference.version <= current.forcedWriteVersion) {
        commit((latest) => ({
          ...latest,
          confirmed: preference,
          choiceMade: preference.animationEnabled === current.value ? false : latest.choiceMade,
          saving: true,
          recovering: false,
          error: null,
          conflict: null,
        }));
        return;
      }
      if (preference.animationEnabled === current.value) {
        commit((latest) => ({
          ...latest,
          confirmed: preference,
          choiceMade: false,
          uncertainTarget: null,
          comparisonTarget: null,
          forcedWriteVersion: null,
          saving: false,
          recovering: false,
          error: null,
          conflict: null,
        }));
      } else if (
        previous !== null &&
        preference.version === previous.version &&
        preference.animationEnabled === previous.animationEnabled
      ) {
        commit((latest) => ({
          ...latest,
          confirmed: preference,
          forcedWriteVersion: null,
          saving: true,
          recovering: false,
          error: null,
          conflict: null,
        }));
      } else {
        commit((latest) => ({
          ...latest,
          confirmed: preference,
          forcedWriteVersion: null,
          saving: false,
          recovering: false,
          error: null,
          conflict: { remote: preference, message: conflictMessage(preference) },
        }));
      }
      return;
    }

    applyOrdinaryReadback(preference);
  }

  function applyOrdinaryReadback(preference: AnimationPreference): void {
    const current = stateRef.current;
    if (current.confirmed === null) {
      const keepChoice = current.choiceMade && current.value !== preference.animationEnabled;
      commit((latest) => ({
        ...latest,
        confirmed: preference,
        value: latest.choiceMade ? latest.value : preference.animationEnabled,
        choiceMade: keepChoice,
        loading: false,
        saving: keepChoice,
        recovering: false,
        error: null,
        conflict: null,
        uncertainTarget: null,
        comparisonTarget: null,
        forcedWriteVersion: null,
      }));
    } else if (!current.choiceMade) {
      commit((latest) => ({
        ...latest,
        confirmed: preference,
        value: preference.animationEnabled,
        choiceMade: false,
        loading: false,
        saving: false,
        recovering: false,
        error: null,
        conflict: null,
        uncertainTarget: null,
        comparisonTarget: null,
        forcedWriteVersion: null,
      }));
    } else if (preference.animationEnabled === current.value) {
      commit((latest) => ({
        ...latest,
        confirmed: preference,
        choiceMade: false,
        saving: false,
        recovering: false,
        error: null,
        conflict: null,
      }));
    } else if (
      preference.version === current.confirmed.version &&
      preference.animationEnabled === current.confirmed.animationEnabled
    ) {
      commit((latest) => ({
        ...latest,
        confirmed: preference,
        saving: true,
        recovering: false,
        error: null,
        conflict: null,
      }));
    } else {
      commit((latest) => ({
        ...latest,
        confirmed: preference,
        saving: false,
        recovering: false,
        error: null,
        conflict: { remote: preference, message: conflictMessage(preference) },
      }));
    }
  }

  function startWrite(target: WriteTarget): void {
    if (authPausedRef.current || activeRef.current !== null) return;
    clearRetryTimer();
    const operation: ActiveOperation = {
      generation: generationRef.current,
      identity: identityRef.current,
      kind: 'write',
      target,
      controller: new AbortController(),
    };
    activeRef.current = operation;
    commit((current) => ({
      ...current,
      loading: false,
      saving: true,
      recovering: false,
      error: null,
      conflict: null,
      comparisonTarget: null,
    }));

    void (async () => {
      let succeeded = false;
      let reconcile: RetryPlan | null = null;
      try {
        const saved = await apiRef.current.putAnimationPreference(
          target.value,
          target.expectedVersion,
          operation.controller.signal,
        );
        if (!isCurrent(operation)) return;
        const current = stateRef.current;
        const protocolError = invalidReadback(saved, current.confirmed);
        if (
          protocolError ||
          saved.version <= target.expectedVersion ||
          saved.animationEnabled !== target.value
        ) {
          commit((latest) => ({
            ...latest,
            uncertainTarget: target,
            comparisonTarget: null,
            saving: true,
            recovering: false,
            error: null,
          }));
          reconcile = { kind: 'read', purpose: 'uncertain', target };
        } else {
          commit((latest) => ({
            ...latest,
            confirmed: saved,
            choiceMade: latest.value === saved.animationEnabled ? false : latest.choiceMade,
            uncertainTarget: null,
            comparisonTarget: null,
            forcedWriteVersion: null,
            saving: latest.value !== saved.animationEnabled,
            recovering: false,
            error: null,
            conflict: null,
          }));
          succeeded = true;
        }
      } catch (error) {
        if (!isCurrent(operation)) return;
        if (error instanceof AttemptApiFailure && error.code === 'conflict') {
          commit((current) => ({
            ...current,
            uncertainTarget: null,
            comparisonTarget: target,
            saving: true,
            recovering: false,
            error: null,
            conflict: null,
          }));
          reconcile = { kind: 'read', purpose: 'compare', target };
        } else if (!(error instanceof AttemptApiFailure) || error.ambiguous) {
          commit((current) => ({
            ...current,
            uncertainTarget: target,
            comparisonTarget: null,
            saving: true,
            recovering: false,
            error: null,
            conflict: null,
          }));
          reconcile = { kind: 'read', purpose: 'uncertain', target };
        } else if (error.code === 'attempt_unavailable' && error.status === 429) {
          const current = stateRef.current;
          if (
            current.confirmed &&
            current.value === current.confirmed.animationEnabled &&
            current.uncertainTarget === null &&
            current.forcedWriteVersion === null
          ) {
            commit((latest) => ({ ...latest, choiceMade: false, saving: false, error: null }));
          } else {
            scheduleRecovery({ kind: 'write' });
          }
        } else if (error.code === 'authentication') {
          if (reportAuthFailure(error)) {
            scheduleRecovery({ kind: 'read', purpose: 'resume' });
          } else {
            commit((current) => ({
              ...current,
              saving: false,
              recovering: false,
              error: failureMessage(error, 'No se pudo guardar la preferencia de animación.'),
            }));
          }
        } else {
          commit((current) => ({
            ...current,
            saving: false,
            recovering: false,
            error: failureMessage(error, 'No se pudo guardar la preferencia de animación.'),
          }));
        }
      } finally {
        if (isCurrent(operation)) {
          activeRef.current = null;
          commit((current) => ({
            ...current,
            loading: false,
            saving:
              retryPlanRef.current !== null
                ? current.saving
                : current.error === null && hasPendingIntent(current),
          }));
          if (reconcile && retryPlanRef.current === null) {
            startRead(reconcile.purpose, reconcile.target);
          } else if (succeeded && retryPlanRef.current === null) {
            pump();
          }
        }
      }
    })();
  }

  function pump(): void {
    if (!mountedRef.current || authPausedRef.current || activeRef.current !== null) return;
    if (retryPlanRef.current !== null) return;
    const current = stateRef.current;
    if (current.error !== null || current.conflict !== null) return;
    if (current.uncertainTarget) {
      startRead('uncertain', current.uncertainTarget);
      return;
    }
    if (current.comparisonTarget) {
      startRead('compare', current.comparisonTarget);
      return;
    }
    if (current.confirmed === null) {
      startRead('initial');
      return;
    }
    if (current.forcedWriteVersion !== null) {
      const version = current.forcedWriteVersion;
      const target: WriteTarget = {
        value: current.value,
        expectedVersion: version,
        revision: current.revision,
        baseValue: current.confirmed.animationEnabled,
      };
      startWrite(target);
      return;
    }
    if (current.value !== current.confirmed.animationEnabled) {
      startWrite({
        value: current.value,
        expectedVersion: current.confirmed.version,
        revision: current.revision,
        baseValue: current.confirmed.animationEnabled,
      });
      return;
    }
    commit((latest) => ({
      ...latest,
      choiceMade: false,
      saving: false,
      recovering: false,
      error: null,
      uncertainTarget: null,
      comparisonTarget: null,
      forcedWriteVersion: null,
    }));
  }

  function runLifecycle(identityNow: string, pausedNow: boolean): void {
    if (!initializedRef.current) {
      initializedRef.current = true;
      identityRef.current = identityNow;
      authPausedRef.current = pausedNow;
      if (!pausedNow) startRead('initial');
      return;
    }

    if (identityRef.current !== identityNow) {
      const oldOperation = activeRef.current;
      activeRef.current = null;
      generationRef.current += 1;
      clearRetryTimer();
      resumeNeedsReadRef.current = false;
      oldOperation?.controller.abort();
      identityRef.current = identityNow;
      authPausedRef.current = pausedNow;
      commit(() => initialState());
      if (!pausedNow) startRead('initial');
      return;
    }

    const wasPaused = authPausedRef.current;
    authPausedRef.current = pausedNow;
    if (!wasPaused && pausedNow) {
      const current = stateRef.current;
      const operation = activeRef.current;
      const hadRetry = retryPlanRef.current !== null;
      const hasWork =
        operation !== null ||
        hadRetry ||
        hasPendingIntent(current) ||
        current.conflict !== null ||
        current.error !== null;
      resumeNeedsReadRef.current = hasWork;
      clearRetryTimer();
      if (operation) {
        activeRef.current = null;
        operation.controller.abort();
      }
      commit((latest) => ({
        ...latest,
        uncertainTarget:
          operation?.kind === 'write'
            ? (operation.target ?? latest.uncertainTarget)
            : latest.uncertainTarget,
        loading: false,
        saving:
          operation?.kind === 'write' ||
          latest.uncertainTarget !== null ||
          latest.comparisonTarget !== null ||
          latest.forcedWriteVersion !== null ||
          (latest.confirmed !== null && latest.value !== latest.confirmed.animationEnabled),
        recovering: false,
      }));
      return;
    }

    if (wasPaused && !pausedNow && resumeNeedsReadRef.current) {
      resumeNeedsReadRef.current = false;
      const current = stateRef.current;
      commit((latest) => ({ ...latest, error: null, recovering: false }));
      if (current.uncertainTarget) startRead('uncertain', current.uncertainTarget);
      else if (current.comparisonTarget || current.conflict) {
        startRead('compare', current.comparisonTarget ?? undefined);
      } else if (current.confirmed === null) startRead('initial');
      else startRead('resume');
      return;
    }

    // StrictMode replays layout effects after its simulated cleanup. The first read was
    // aborted with that cleanup, so a still-unknown preference needs one fresh initial GET.
    const current = stateRef.current;
    if (
      !pausedNow &&
      current.confirmed === null &&
      current.error === null &&
      activeRef.current === null &&
      retryPlanRef.current === null
    ) {
      startRead('initial');
    }
  }

  function choose(value: boolean): void {
    if (authPausedRef.current) return;
    const current = stateRef.current;
    if (current.value === value && (current.confirmed !== null || current.choiceMade)) return;
    const nextRevision = current.revision + 1;
    const hasConflict = current.conflict !== null;
    commit((latest) => ({
      ...latest,
      value,
      revision: nextRevision,
      choiceMade: true,
      error: null,
      saving:
        latest.uncertainTarget !== null ||
        latest.comparisonTarget !== null ||
        (latest.confirmed !== null && value !== latest.confirmed.animationEnabled),
    }));

    if (hasConflict || current.comparisonTarget) return;
    const retry = retryPlanRef.current;
    if (
      retry?.kind === 'write' &&
      current.forcedWriteVersion === null &&
      current.confirmed?.animationEnabled === value
    ) {
      clearRetryTimer();
      commit((latest) => ({
        ...latest,
        choiceMade: false,
        saving: false,
        recovering: false,
      }));
      return;
    }
    if (retry || activeRef.current) return;
    pump();
  }

  function saveSelection(): void {
    if (authPausedRef.current || activeRef.current !== null) return;
    const current = stateRef.current;
    const conflict = current.conflict;
    if (!conflict) return;
    clearRetryTimer();
    commit((latest) => ({ ...latest, conflict: null, comparisonTarget: null, error: null }));
    startWrite({
      value: current.value,
      expectedVersion: conflict.remote.version,
      revision: current.revision,
      baseValue: conflict.remote.animationEnabled,
    });
  }

  const actionsRef = useRef({
    lifecycle: runLifecycle,
    dispatchDue: dispatchDueRetry,
  });
  actionsRef.current = { lifecycle: runLifecycle, dispatchDue: dispatchDueRetry };

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      clearRetryTimer();
      const operation = activeRef.current;
      activeRef.current = null;
      operation?.controller.abort();
    };
  }, []);

  useLayoutEffect(() => {
    actionsRef.current.lifecycle(identity, authPaused);
  }, [identity, authPaused]);

  useEffect(() => {
    const wake = (): void => actionsRef.current.dispatchDue();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  const isReadyNow = useCallback(
    () =>
      isPreferenceReady(
        stateRef.current,
        authPausedRef.current,
        activeRef.current,
        retryPlanRef.current,
      ),
    [],
  );
  const confirmedValueNow = useCallback(
    () => stateRef.current.confirmed?.animationEnabled ?? null,
    [],
  );

  const confirmed = state.confirmed;
  const ready = isPreferenceReady(state, authPaused, activeRef.current, retryPlanRef.current);

  return {
    value: state.value,
    unknown: confirmed === null && !state.choiceMade,
    loading: state.loading,
    saving: state.saving,
    recovering: state.recovering,
    error: state.error,
    conflict: state.conflict,
    ready,
    isReadyNow,
    confirmedValueNow,
    choose,
    saveSelection,
  };
}
