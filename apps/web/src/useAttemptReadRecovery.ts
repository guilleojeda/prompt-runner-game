import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { AttemptApiFailure, isTransientReadFailure } from './attempt-api.js';
import type { ApiAuthRequired } from './api-auth.js';

const RECOVERY_DELAY_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface AttemptReadResource {
  readonly identity: string;
  readonly targetId: string;
  readonly surface: string;
}

export interface AttemptReadRecoveryOptions<Resource extends AttemptReadResource, Value> {
  readonly active: boolean;
  readonly authPaused: boolean;
  readonly identity: string;
  readonly surface: string;
  readonly onAuthRequired?: ApiAuthRequired;
  readonly read: (resource: Resource, signal: AbortSignal) => Promise<Value>;
  readonly isPendingFailure?: (error: unknown, resource: Resource) => boolean;
  readonly onStart: (resource: Resource) => void;
  readonly onValue: (
    value: Value,
    resource: Resource,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ) => boolean | void | Promise<boolean | void>;
  readonly onComplete?: (resource: Resource) => void;
  readonly onRecovering: (
    resource: Resource,
    error: unknown,
    reason: 'transient' | 'pending' | 'authentication',
  ) => void;
  readonly onPaused: (resource: Resource) => void;
  readonly onError: (resource: Resource, error: unknown) => void;
}

interface FailedRead<Resource> {
  readonly resource: Resource;
  readonly deadline: number;
}

export interface AttemptReadRecovery<Resource extends AttemptReadResource> {
  open(resource: Resource): Promise<void>;
  clear(): void;
}

/**
 * Owns the shared lifecycle for selected attempt GETs. Each caller retains its
 * state, validation and continuation; this hook owns only identity, abort,
 * access/visibility pauses and the retry deadline.
 */
export function useAttemptReadRecovery<Resource extends AttemptReadResource, Value>(
  options: AttemptReadRecoveryOptions<Resource, Value>,
): AttemptReadRecovery<Resource> {
  const optionsRef = useRef(options);
  const mountedRef = useRef(false);
  const resourceRef = useRef<Resource | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);
  const failedRef = useRef<FailedRead<Resource> | null>(null);
  const timerRef = useRef<number | null>(null);
  const authBlockedRef = useRef(false);
  const needsFreshReadRef = useRef(false);
  const openingResourceRef = useRef<Resource | null>(null);
  const previousAuthPausedRef = useRef(options.authPaused);
  const runRef = useRef<(resource: Resource) => Promise<void>>(async () => undefined);
  const processDueRef = useRef<() => void>(() => undefined);
  const scheduleRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    optionsRef.current = options;
    if (options.active) openingResourceRef.current = null;
  });

  const clearTimer = useCallback((): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const isVisible = useCallback((resource: Resource): boolean => {
    const current = optionsRef.current;
    const openedThisRender = openingResourceRef.current === resource;
    return (
      mountedRef.current &&
      resourceRef.current === resource &&
      current.identity === resource.identity &&
      current.surface === resource.surface &&
      (current.active || openedThisRender) &&
      !current.authPaused &&
      !document.hidden &&
      document.visibilityState !== 'hidden'
    );
  }, []);

  const clear = useCallback((): void => {
    operationRef.current += 1;
    clearTimer();
    controllerRef.current?.abort();
    controllerRef.current = null;
    resourceRef.current = null;
    failedRef.current = null;
    authBlockedRef.current = false;
    needsFreshReadRef.current = false;
    openingResourceRef.current = null;
  }, [clearTimer]);

  const pause = useCallback((): void => {
    clearTimer();
    const resource = resourceRef.current;
    const controller = controllerRef.current;
    if (!resource || !controller) return;
    if (failedRef.current?.resource !== resource) needsFreshReadRef.current = true;
    controllerRef.current = null;
    operationRef.current += 1;
    controller.abort();
    optionsRef.current.onPaused(resource);
  }, [clearTimer]);

  const schedule = useCallback((): void => {
    clearTimer();
    const resource = resourceRef.current;
    const failed = failedRef.current;
    if (
      !resource ||
      !failed ||
      failed.resource !== resource ||
      authBlockedRef.current ||
      needsFreshReadRef.current ||
      !isVisible(resource)
    ) {
      return;
    }
    timerRef.current = window.setTimeout(
      () => {
        timerRef.current = null;
        processDueRef.current();
      },
      Math.min(MAX_TIMEOUT_MS, Math.max(0, failed.deadline - Date.now())),
    );
  }, [clearTimer, isVisible]);

  const run = useCallback(
    async (resource: Resource): Promise<void> => {
      if (!isVisible(resource) || controllerRef.current !== null) {
        return;
      }

      clearTimer();
      failedRef.current = null;
      authBlockedRef.current = false;
      needsFreshReadRef.current = false;
      const operation = ++operationRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      optionsRef.current.onStart(resource);

      const isCurrentOperation = (): boolean =>
        mountedRef.current &&
        resourceRef.current === resource &&
        controllerRef.current === controller &&
        operationRef.current === operation &&
        optionsRef.current.identity === resource.identity &&
        optionsRef.current.surface === resource.surface &&
        !controller.signal.aborted;
      const isCurrentRead = (): boolean => isCurrentOperation() && isVisible(resource);

      const aborted = Symbol('attempt-read-aborted');
      let resolveAborted!: (value: typeof aborted) => void;
      const abortPromise = new Promise<typeof aborted>((resolve) => {
        resolveAborted = resolve;
      });
      const handleAbort = (): void => resolveAborted(aborted);
      controller.signal.addEventListener('abort', handleAbort, { once: true });
      if (controller.signal.aborted) handleAbort();

      try {
        const value = await Promise.race([
          optionsRef.current.read(resource, controller.signal),
          abortPromise,
        ]);
        if (value === aborted || !isCurrentOperation()) return;
        if (!isCurrentRead()) {
          needsFreshReadRef.current = true;
          optionsRef.current.onPaused(resource);
          return;
        }

        const continuation = optionsRef.current.onValue(
          value as Value,
          resource,
          controller.signal,
          isCurrentRead,
        );
        let completed = false;
        if (typeof continuation === 'boolean') {
          completed = continuation;
        } else if (continuation) {
          completed = (await continuation) === true;
        }
        if (!isCurrentOperation()) return;
        if (!isCurrentRead()) {
          needsFreshReadRef.current = true;
          optionsRef.current.onPaused(resource);
          return;
        }

        failedRef.current = null;
        authBlockedRef.current = false;
        needsFreshReadRef.current = false;
        if (completed) {
          optionsRef.current.onComplete?.(resource);
          clear();
        }
      } catch (error) {
        if (!isCurrentOperation()) return;
        if (!isCurrentRead()) {
          needsFreshReadRef.current = true;
          optionsRef.current.onPaused(resource);
          return;
        }

        const currentOptions = optionsRef.current;
        const authenticationFailure =
          error instanceof AttemptApiFailure && error.code === 'authentication';
        if (authenticationFailure) {
          const accepted = currentOptions.onAuthRequired?.(error.authContext);
          if (!isCurrentOperation()) return;
          if (accepted !== false) {
            authBlockedRef.current = true;
            needsFreshReadRef.current = true;
            currentOptions.onRecovering(resource, error, 'authentication');
            return;
          }
        }

        if (
          authenticationFailure ||
          currentOptions.isPendingFailure?.(error, resource) === true ||
          isTransientReadFailure(error)
        ) {
          const reason = authenticationFailure
            ? 'transient'
            : currentOptions.isPendingFailure?.(error, resource)
              ? 'pending'
              : 'transient';
          failedRef.current = { resource, deadline: Date.now() + RECOVERY_DELAY_MS };
          authBlockedRef.current = false;
          needsFreshReadRef.current = false;
          currentOptions.onRecovering(resource, error, reason);
          return;
        }

        failedRef.current = null;
        authBlockedRef.current = false;
        needsFreshReadRef.current = false;
        currentOptions.onError(resource, error);
      } finally {
        controller.signal.removeEventListener('abort', handleAbort);
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          scheduleRef.current();
        }
      }
    },
    [clear, clearTimer, isVisible],
  );

  const processDue = useCallback((): void => {
    const resource = resourceRef.current;
    if (
      !resource ||
      !isVisible(resource) ||
      controllerRef.current !== null ||
      authBlockedRef.current
    ) {
      return;
    }
    if (needsFreshReadRef.current) {
      clearTimer();
      void runRef.current(resource);
      return;
    }
    const failed = failedRef.current;
    if (!failed || failed.resource !== resource) return;
    if (failed.deadline > Date.now()) {
      scheduleRef.current();
      return;
    }
    clearTimer();
    void runRef.current(resource);
  }, [clearTimer, isVisible]);

  useLayoutEffect(() => {
    runRef.current = run;
    processDueRef.current = processDue;
    scheduleRef.current = schedule;
  }, [processDue, run, schedule]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clear();
    };
  }, [clear]);

  useEffect(() => {
    const wasAuthPaused = previousAuthPausedRef.current;
    previousAuthPausedRef.current = options.authPaused;
    if (options.authPaused || !options.active) {
      pause();
      return;
    }
    if (wasAuthPaused && authBlockedRef.current) {
      authBlockedRef.current = false;
      needsFreshReadRef.current = true;
    }
    processDueRef.current();
    scheduleRef.current();
  }, [options.active, options.authPaused, options.identity, options.surface, pause]);

  useEffect(() => {
    const handleWake = (): void => {
      if (document.hidden || document.visibilityState === 'hidden') {
        pause();
        return;
      }
      processDueRef.current();
    };
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);
    return () => {
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, [pause]);

  const open = useCallback(
    (resource: Resource): Promise<void> => {
      clear();
      resourceRef.current = resource;
      openingResourceRef.current = resource;
      if (!isVisible(resource)) {
        needsFreshReadRef.current = true;
        optionsRef.current.onPaused(resource);
        return Promise.resolve();
      }
      return runRef.current(resource);
    },
    [clear, isVisible],
  );

  return useMemo(() => ({ open, clear }), [clear, open]);
}
