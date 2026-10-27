import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiAuthRequired } from './api-auth.js';
import {
  AttemptApiFailure,
  isTransientReadFailure,
  type AttemptApi,
  type AttemptSummary,
} from './attempt-api.js';

const RETRY_DELAY_MS = 60_000;

type RetryStep = 'get' | 'post';
type AcknowledgementPhase = 'posting' | 'checking' | 'waiting' | 'paused' | 'blocked';

export interface PresentationAcknowledgementView {
  readonly identity: string;
  readonly phase: AcknowledgementPhase;
  readonly message: string;
}

interface AcknowledgementEntry {
  readonly key: string;
  readonly identity: string;
  readonly attemptId: string;
  readonly expectedStatus: AttemptSummary['status'];
  phase: AcknowledgementPhase;
  operation: number;
  controller: AbortController | null;
  timer: number | null;
  deadline: number | null;
  nextStep: RetryStep;
  authBlocked: boolean;
}

interface UsePresentationAcknowledgementsOptions {
  readonly api: AttemptApi;
  readonly identity: string;
  readonly authPaused: boolean;
  readonly onAuthRequired?: ApiAuthRequired;
  readonly onConfirmed: (attempt: AttemptSummary) => void;
}

function entryKey(identity: string, attemptId: string): string {
  return JSON.stringify([identity, attemptId]);
}

function isTerminalStatus(status: AttemptSummary['status']): boolean {
  return status !== 'pending' && status !== 'running';
}

function isEligible(attempt: AttemptSummary): boolean {
  return (
    isTerminalStatus(attempt.status) &&
    attempt.animationEnabled &&
    !attempt.presentationComplete &&
    attempt.turnsUsed > 0
  );
}

function isAuthenticationFailure(error: unknown): error is AttemptApiFailure {
  return error instanceof AttemptApiFailure && error.code === 'authentication';
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'No se pudo confirmar el cierre de la presentación.';
}

export function usePresentationAcknowledgements({
  api,
  identity,
  authPaused,
  onAuthRequired,
  onConfirmed,
}: UsePresentationAcknowledgementsOptions) {
  const entriesRef = useRef(new Map<string, AcknowledgementEntry>());
  const viewsRef = useRef<ReadonlyMap<string, PresentationAcknowledgementView>>(new Map());
  const [views, setViews] = useState<ReadonlyMap<string, PresentationAcknowledgementView>>(
    () => new Map(),
  );
  const apiRef = useRef(api);
  const identityRef = useRef(identity);
  const authPausedRef = useRef(authPaused);
  const authRequiredRef = useRef(onAuthRequired);
  const onConfirmedRef = useRef(onConfirmed);
  const mountedRef = useRef(false);
  const previousIdentityRef = useRef(identity);
  const previousPausedRef = useRef(authPaused);
  const runCycleRef = useRef<(entry: AcknowledgementEntry, step: RetryStep) => void>(
    () => undefined,
  );
  const wakeRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    apiRef.current = api;
    identityRef.current = identity;
    authPausedRef.current = authPaused;
    authRequiredRef.current = onAuthRequired;
    onConfirmedRef.current = onConfirmed;
  }, [api, authPaused, identity, onAuthRequired, onConfirmed]);

  const commitViews = useCallback((next: ReadonlyMap<string, PresentationAcknowledgementView>) => {
    viewsRef.current = next;
    if (mountedRef.current) setViews(next);
  }, []);

  const publish = useCallback(
    (entry: AcknowledgementEntry, phase: AcknowledgementPhase, message: string): void => {
      if (entriesRef.current.get(entry.key) !== entry) return;
      entry.phase = phase;
      const next = new Map(viewsRef.current);
      next.set(entry.attemptId, { identity: entry.identity, phase, message });
      commitViews(next);
    },
    [commitViews],
  );

  const clearTimer = useCallback((entry: AcknowledgementEntry): void => {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    entry.deadline = null;
  }, []);

  const removeView = useCallback(
    (entry: AcknowledgementEntry): void => {
      const current = viewsRef.current.get(entry.attemptId);
      if (current?.identity !== entry.identity) return;
      const next = new Map(viewsRef.current);
      next.delete(entry.attemptId);
      commitViews(next);
    },
    [commitViews],
  );

  const isCurrentEntry = useCallback(
    (entry: AcknowledgementEntry): boolean =>
      mountedRef.current &&
      identityRef.current === entry.identity &&
      entriesRef.current.get(entry.key) === entry,
    [],
  );

  const isCurrentOperation = useCallback(
    (entry: AcknowledgementEntry, controller: AbortController, operation: number): boolean =>
      isCurrentEntry(entry) &&
      !authPausedRef.current &&
      entry.operation === operation &&
      entry.controller === controller &&
      !controller.signal.aborted,
    [isCurrentEntry],
  );

  const disposeEntries = useCallback((): void => {
    for (const entry of entriesRef.current.values()) {
      clearTimer(entry);
      entry.operation += 1;
      entry.controller?.abort();
      entry.controller = null;
    }
    entriesRef.current.clear();
    commitViews(new Map());
  }, [clearTimer, commitViews]);

  const finishEntry = useCallback(
    (
      entry: AcknowledgementEntry,
      confirmed: AttemptSummary,
      controller?: AbortController,
      operation?: number,
    ): void => {
      if (!isCurrentEntry(entry)) return;
      if (controller && operation !== undefined) {
        if (!isCurrentOperation(entry, controller, operation)) return;
      } else {
        entry.operation += 1;
        entry.controller?.abort();
      }
      clearTimer(entry);
      entry.controller = null;
      entriesRef.current.delete(entry.key);
      removeView(entry);
      onConfirmedRef.current(confirmed);
    },
    [clearTimer, isCurrentEntry, isCurrentOperation, removeView],
  );

  const stopEntry = useCallback(
    (entry: AcknowledgementEntry, message: string, authBlocked = false): void => {
      if (!isCurrentEntry(entry)) return;
      clearTimer(entry);
      entry.operation += 1;
      entry.controller?.abort();
      entry.controller = null;
      entry.authBlocked = authBlocked;
      publish(entry, 'blocked', message);
    },
    [clearTimer, isCurrentEntry, publish],
  );

  const schedule = useCallback(
    (entry: AcknowledgementEntry, step: RetryStep): void => {
      if (!isCurrentEntry(entry)) return;
      clearTimer(entry);
      entry.operation += 1;
      entry.controller = null;
      entry.nextStep = step;
      entry.deadline = Date.now() + RETRY_DELAY_MS;
      publish(entry, 'waiting', 'Guardado pendiente: volveremos a intentarlo cada minuto.');
      const operation = entry.operation;
      const deadline = entry.deadline;
      const timer = window.setTimeout(
        () => {
          if (
            !isCurrentEntry(entry) ||
            entry.operation !== operation ||
            entry.timer !== timer ||
            authPausedRef.current
          ) {
            return;
          }
          entry.timer = null;
          entry.deadline = null;
          runCycleRef.current(entry, step);
        },
        Math.max(0, deadline - Date.now()),
      );
      entry.timer = timer;
    },
    [clearTimer, isCurrentEntry, publish],
  );

  const handleFailure = useCallback(
    (entry: AcknowledgementEntry, error: unknown, request: RetryStep): void => {
      if (isAuthenticationFailure(error)) {
        const accepted = authRequiredRef.current?.(error.authContext);
        if (accepted === false) {
          schedule(entry, request);
        } else {
          stopEntry(entry, failureMessage(error), true);
        }
        return;
      }

      if (request === 'get') {
        if (isTransientReadFailure(error)) {
          schedule(entry, 'get');
        } else {
          stopEntry(entry, failureMessage(error));
        }
        return;
      }

      if (!(error instanceof AttemptApiFailure) || error.ambiguous) {
        schedule(entry, 'get');
      } else if (isTransientReadFailure(error)) {
        schedule(entry, 'post');
      } else {
        stopEntry(entry, failureMessage(error));
      }
    },
    [schedule, stopEntry],
  );

  const runCycle = useCallback(
    async (entry: AcknowledgementEntry, step: RetryStep): Promise<void> => {
      if (
        !isCurrentEntry(entry) ||
        authPausedRef.current ||
        entry.controller !== null ||
        entry.timer !== null
      ) {
        return;
      }
      const operation = ++entry.operation;
      const controller = new AbortController();
      entry.controller = controller;
      let request = step;
      publish(
        entry,
        request === 'get' ? 'checking' : 'posting',
        request === 'get'
          ? 'Comprobando el cierre de la presentación…'
          : 'Guardando el cierre de la presentación…',
      );

      try {
        if (request === 'get') {
          const current = await apiRef.current.getAttempt(entry.attemptId, controller.signal);
          if (!isCurrentOperation(entry, controller, operation)) return;
          if (current.id !== entry.attemptId) {
            stopEntry(entry, 'El intento consultado no coincide con el cierre pendiente.');
            return;
          }
          if (!isTerminalStatus(current.status) || current.status !== entry.expectedStatus) {
            stopEntry(entry, 'El intento todavía no confirma un resultado final compatible.');
            return;
          }
          if (current.presentationComplete === true) {
            finishEntry(entry, current, controller, operation);
            return;
          }
          if (current.presentationComplete !== false) {
            stopEntry(entry, 'El intento consultado no informa un cierre válido.');
            return;
          }
          request = 'post';
          publish(entry, 'posting', 'Guardando el cierre de la presentación…');
        }

        const completed = await apiRef.current.completePresentation(
          entry.attemptId,
          controller.signal,
        );
        if (!isCurrentOperation(entry, controller, operation)) return;
        if (
          completed.id === entry.attemptId &&
          isTerminalStatus(completed.status) &&
          completed.status === entry.expectedStatus &&
          completed.presentationComplete === true
        ) {
          finishEntry(entry, completed, controller, operation);
          return;
        }
        schedule(entry, 'get');
      } catch (error) {
        if (!isCurrentOperation(entry, controller, operation)) return;
        handleFailure(entry, error, request);
      } finally {
        if (entry.controller === controller) entry.controller = null;
      }
    },
    [finishEntry, handleFailure, isCurrentEntry, isCurrentOperation, publish, schedule, stopEntry],
  );

  useLayoutEffect(() => {
    runCycleRef.current = (entry, step) => {
      void runCycle(entry, step);
    };
  }, [runCycle]);

  const processWake = useCallback((): void => {
    if (authPausedRef.current) return;
    const now = Date.now();
    for (const entry of entriesRef.current.values()) {
      if (
        entry.timer === null ||
        entry.deadline === null ||
        entry.deadline > now ||
        entry.controller !== null
      ) {
        continue;
      }
      clearTimer(entry);
      runCycleRef.current(entry, entry.nextStep);
    }
  }, [clearTimer]);

  useLayoutEffect(() => {
    wakeRef.current = processWake;
  }, [processWake]);

  const pauseEntries = useCallback((): void => {
    for (const entry of entriesRef.current.values()) {
      if (entry.phase === 'blocked') continue;
      clearTimer(entry);
      entry.operation += 1;
      if (entry.controller) {
        entry.controller.abort();
        entry.controller = null;
      }
      entry.deadline = null;
      entry.nextStep = 'get';
      if (!entry.authBlocked) {
        publish(entry, 'paused', 'Guardado pendiente. Lo comprobaremos cuando vuelva la sesión.');
      }
    }
  }, [clearTimer, publish]);

  const resumeEntries = useCallback((): void => {
    for (const entry of entriesRef.current.values()) {
      if (entry.controller !== null || entry.timer !== null) continue;
      if (entry.phase === 'blocked' && !entry.authBlocked) continue;
      if (entry.authBlocked) {
        entry.authBlocked = false;
        publish(entry, 'paused', 'Guardado pendiente. Lo comprobaremos cuando vuelva la sesión.');
      }
      entry.nextStep = 'get';
      runCycleRef.current(entry, 'get');
    }
  }, [publish]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposeEntries();
    };
  }, [disposeEntries]);

  useEffect(() => {
    const identityChanged = previousIdentityRef.current !== identity;
    const pausedBefore = previousPausedRef.current;
    previousIdentityRef.current = identity;
    previousPausedRef.current = authPaused;

    if (identityChanged) {
      disposeEntries();
      return;
    }
    if (!pausedBefore && authPaused) pauseEntries();
    else if (pausedBefore && !authPaused) resumeEntries();
  }, [authPaused, disposeEntries, identity, pauseEntries, resumeEntries]);

  useEffect(() => {
    const handleWake = (): void => wakeRef.current();
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);
    return () => {
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, []);

  const register = useCallback(
    (attempt: AttemptSummary): void => {
      if (!isEligible(attempt)) return;
      const currentIdentity = identityRef.current;
      const key = entryKey(currentIdentity, attempt.id);
      if (entriesRef.current.has(key)) return;
      const entry: AcknowledgementEntry = {
        key,
        identity: currentIdentity,
        attemptId: attempt.id,
        expectedStatus: attempt.status,
        phase: 'posting',
        operation: 0,
        controller: null,
        timer: null,
        deadline: null,
        nextStep: 'post',
        authBlocked: false,
      };
      entriesRef.current.set(key, entry);
      if (authPausedRef.current) {
        entry.nextStep = 'get';
        publish(entry, 'paused', 'Guardado pendiente. Lo comprobaremos cuando vuelva la sesión.');
        return;
      }
      runCycleRef.current(entry, 'post');
    },
    [publish],
  );

  const observe = useCallback(
    (attempt: AttemptSummary): void => {
      const entry = entriesRef.current.get(entryKey(identityRef.current, attempt.id));
      if (!entry || !isTerminalStatus(attempt.status) || !attempt.presentationComplete) return;
      if (attempt.status !== entry.expectedStatus) {
        stopEntry(entry, 'El resultado confirmado no coincide con el cierre pendiente.');
        return;
      }
      finishEntry(entry, attempt);
    },
    [finishEntry, stopEntry],
  );

  return { register, observe, states: views };
}
