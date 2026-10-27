import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ApiAuthRequired } from './api-auth.js';
import {
  AttemptApiFailure,
  isTransientReadFailure,
  type AttemptApi,
  type QuotaSummary,
} from './attempt-api.js';

const RECOVERY_DELAY_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

interface QuotaSnapshot {
  readonly quota: QuotaSummary | null;
  readonly confirmed: boolean;
  readonly expiresAt: number | null;
  readonly recovering: boolean;
  readonly recoverableFailure: boolean;
  readonly error: string | null;
}

interface QuotaOperation {
  readonly generation: number;
  readonly identity: string;
  readonly controller: AbortController;
}

interface UseQuotaOptions {
  readonly api: AttemptApi;
  readonly identity: string;
  readonly authPaused: boolean;
  readonly onAuthRequired?: ApiAuthRequired;
}

export interface QuotaController {
  readonly quota: QuotaSummary | null;
  readonly current: boolean;
  readonly recovering: boolean;
  readonly recoverableFailure: boolean;
  readonly error: string | null;
  readonly isAvailableNow: () => boolean;
  readonly refreshAfterAdmission: () => Promise<void>;
}

const initialSnapshot: QuotaSnapshot = {
  quota: null,
  confirmed: false,
  expiresAt: null,
  recovering: false,
  recoverableFailure: false,
  error: null,
};

function authenticationFailure(error: unknown): error is AttemptApiFailure {
  return error instanceof AttemptApiFailure && error.code === 'authentication';
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'No se pudo consultar la cuota.';
}

export function useQuota({
  api,
  identity,
  authPaused,
  onAuthRequired,
}: UseQuotaOptions): QuotaController {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>(initialSnapshot);
  const snapshotRef = useRef(snapshot);
  const apiRef = useRef(api);
  const authRequiredRef = useRef(onAuthRequired);
  const identityRef = useRef(identity);
  const authPausedRef = useRef(authPaused);
  const mountedRef = useRef(false);
  const initializedRef = useRef(false);
  const generationRef = useRef(0);
  const activeRef = useRef<QuotaOperation | null>(null);
  const timerRef = useRef<number | null>(null);
  const retryDeadlineRef = useRef<number | null>(null);
  const readRef = useRef<(supersede: boolean) => Promise<void>>(async () => undefined);
  const processDueRef = useRef<() => void>(() => undefined);

  const commit = useCallback(
    (next: QuotaSnapshot | ((current: QuotaSnapshot) => QuotaSnapshot)) => {
      const value = typeof next === 'function' ? next(snapshotRef.current) : next;
      snapshotRef.current = value;
      if (mountedRef.current) setSnapshot(value);
    },
    [],
  );

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback((): void => {
    clearTimer();
    if (!mountedRef.current || authPausedRef.current) return;
    const now = Date.now();
    const current = snapshotRef.current;
    const deadlines: number[] = [];
    if (current.confirmed && current.expiresAt !== null && current.expiresAt > now) {
      deadlines.push(current.expiresAt);
    }
    if (retryDeadlineRef.current !== null && retryDeadlineRef.current > now) {
      deadlines.push(retryDeadlineRef.current);
    }
    if (deadlines.length === 0) return;
    const deadline = Math.min(...deadlines);
    const generation = generationRef.current;
    timerRef.current = window.setTimeout(
      () => {
        timerRef.current = null;
        if (!mountedRef.current || authPausedRef.current || generationRef.current !== generation) {
          return;
        }
        processDueRef.current();
      },
      Math.min(MAX_TIMEOUT_MS, Math.max(0, deadline - now)),
    );
  }, [clearTimer]);

  const processDue = useCallback((): void => {
    if (!mountedRef.current || authPausedRef.current) return;
    const now = Date.now();
    const current = snapshotRef.current;
    const retryPending = retryDeadlineRef.current !== null;
    const expiryDue = current.confirmed && current.expiresAt !== null && current.expiresAt <= now;
    if (expiryDue) {
      commit((value) => ({ ...value, confirmed: false }));
    }
    const retryDue = retryDeadlineRef.current !== null && retryDeadlineRef.current <= now;
    if (retryDue) retryDeadlineRef.current = null;
    if (activeRef.current) {
      scheduleNext();
      return;
    }
    if (retryDue || (expiryDue && !retryPending)) {
      void readRef.current(false);
      return;
    }
    scheduleNext();
  }, [commit, scheduleNext]);

  const read = useCallback(
    async (supersede: boolean): Promise<void> => {
      if (!mountedRef.current || authPausedRef.current) return;
      if (activeRef.current) {
        if (!supersede) return;
        activeRef.current.controller.abort();
        activeRef.current = null;
      }
      retryDeadlineRef.current = null;
      const operation: QuotaOperation = {
        generation: generationRef.current,
        identity: identityRef.current,
        controller: new AbortController(),
      };
      activeRef.current = operation;
      const previous = snapshotRef.current;
      commit({
        ...previous,
        confirmed: false,
        recovering: previous.quota !== null,
        recoverableFailure: false,
        error: null,
      });
      scheduleNext();
      try {
        const result = await apiRef.current.getQuota(operation.controller.signal);
        if (
          !mountedRef.current ||
          generationRef.current !== operation.generation ||
          identityRef.current !== operation.identity ||
          activeRef.current !== operation ||
          operation.controller.signal.aborted ||
          authPausedRef.current
        ) {
          return;
        }
        activeRef.current = null;
        const expiresAt = Date.parse(result.resetsAt);
        const now = Date.now();
        if (Number.isFinite(expiresAt) && expiresAt > now) {
          retryDeadlineRef.current = null;
          commit({
            quota: result,
            confirmed: true,
            expiresAt,
            recovering: false,
            recoverableFailure: false,
            error: null,
          });
        } else {
          retryDeadlineRef.current = now + RECOVERY_DELAY_MS;
          commit({
            quota: result,
            confirmed: false,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
            recovering: true,
            recoverableFailure: false,
            error: null,
          });
        }
        scheduleNext();
      } catch (error) {
        const lifecycleCurrent =
          mountedRef.current &&
          generationRef.current === operation.generation &&
          identityRef.current === operation.identity &&
          !authPausedRef.current;
        const operationCurrent = activeRef.current === operation;
        if (authenticationFailure(error) && lifecycleCurrent) {
          const accepted = authRequiredRef.current?.(error.authContext);
          if (operationCurrent) activeRef.current = null;
          if (operationCurrent && mountedRef.current && !authPausedRef.current) {
            const current = snapshotRef.current;
            if (accepted === false) {
              retryDeadlineRef.current = Date.now() + RECOVERY_DELAY_MS;
              commit({
                ...current,
                confirmed: false,
                recovering: true,
                recoverableFailure: false,
                error: null,
              });
            } else {
              retryDeadlineRef.current = null;
              commit({
                ...current,
                confirmed: false,
                recovering: false,
                recoverableFailure: false,
                error: null,
              });
            }
            scheduleNext();
          }
          return;
        }
        if (!operationCurrent || !lifecycleCurrent) return;
        activeRef.current = null;
        const current = snapshotRef.current;
        const transient = isTransientReadFailure(error);
        retryDeadlineRef.current = transient ? Date.now() + RECOVERY_DELAY_MS : null;
        commit({
          ...current,
          confirmed: false,
          recovering: transient,
          recoverableFailure: transient,
          error: errorMessage(error),
        });
        scheduleNext();
      }
    },
    [commit, scheduleNext],
  );

  useLayoutEffect(() => {
    apiRef.current = api;
    authRequiredRef.current = onAuthRequired;
  }, [api, onAuthRequired]);
  useLayoutEffect(() => {
    readRef.current = read;
    processDueRef.current = processDue;
  }, [processDue, read]);

  const refreshAfterAdmission = useCallback(async (): Promise<void> => {
    if (!mountedRef.current || authPausedRef.current) return;
    retryDeadlineRef.current = null;
    const current = snapshotRef.current;
    commit({ ...current, confirmed: false, error: null });
    await readRef.current(true);
  }, [commit]);

  const isAvailableNow = useCallback((): boolean => {
    const current = snapshotRef.current;
    const isFresh =
      current.confirmed && current.expiresAt !== null && current.expiresAt > Date.now();
    return !isFresh || current.quota?.remaining !== 0;
  }, []);

  useLayoutEffect(() => {
    const previousIdentity = identityRef.current;
    const previousPaused = authPausedRef.current;
    const wasMounted = mountedRef.current;
    const first = !initializedRef.current;
    const reactivated = initializedRef.current && !wasMounted;
    const identityChanged = !first && previousIdentity !== identity;
    const resumed = !first && previousPaused && !authPaused;
    mountedRef.current = true;
    initializedRef.current = true;
    identityRef.current = identity;
    authPausedRef.current = authPaused;

    if (first || reactivated || identityChanged || previousPaused !== authPaused) {
      generationRef.current += 1;
      activeRef.current?.controller.abort();
      activeRef.current = null;
      clearTimer();
      retryDeadlineRef.current = null;
      if (identityChanged) commit(initialSnapshot);
      else if (previousPaused !== authPaused && authPaused) {
        const current = snapshotRef.current;
        const stillFresh =
          current.confirmed && current.expiresAt !== null && current.expiresAt > Date.now();
        commit({ ...current, confirmed: stillFresh, recovering: false });
      }
      if (!authPaused) {
        if (resumed) {
          const current = snapshotRef.current;
          commit({ ...current, confirmed: false, error: null });
        }
        void readRef.current(false);
      }
    }
  }, [authPaused, clearTimer, commit, identity]);

  useLayoutEffect(
    () => () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeRef.current?.controller.abort();
      activeRef.current = null;
      retryDeadlineRef.current = null;
      clearTimer();
    },
    [clearTimer],
  );

  useLayoutEffect(() => {
    const handleWake = (): void => processDueRef.current();
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);
    return () => {
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, []);

  const current = snapshot.confirmed;
  return {
    quota: snapshot.quota,
    current,
    recovering: snapshot.recovering,
    recoverableFailure: snapshot.recoverableFailure,
    error: snapshot.error,
    isAvailableNow,
    refreshAfterAdmission,
  };
}
