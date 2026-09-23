import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { AuthSession } from './auth.js';
import {
  AttemptApiFailure,
  type AttemptAdmission,
  type AttemptApi,
  type AttemptStatus,
  type AttemptSummary,
  type AttemptsPage,
  type QuotaSummary,
} from './attempt-api.js';
import {
  clearAttemptRecovery,
  readAttemptRecovery,
  writeAttemptRecovery,
} from './attempt-recovery.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import type { RobotDraft } from '../../../shared/robot.js';

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
  | 'result';

interface FrozenAdmission {
  readonly requestKey: string;
  readonly expectedVersion: number;
  readonly draft: RobotDraft;
}

function frozenAdmissionFromRecovery(
  reference: ReturnType<typeof readAttemptRecovery>,
): FrozenAdmission | null {
  if (!reference?.requestKey || reference.expectedVersion === undefined || !reference.draft) {
    return null;
  }
  return {
    requestKey: reference.requestKey,
    expectedVersion: reference.expectedVersion,
    draft: reference.draft,
  };
}

interface AttemptWorkspaceProps {
  readonly api: AttemptApi;
  readonly editor: RefObject<RobotEditorHandle | null>;
  readonly session: AuthSession;
  readonly authPaused?: boolean;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onAuthRequired?: () => void;
}

export interface AttemptWorkspaceHandle {
  start(): void;
}

const ACTIVE_STATUSES: readonly AttemptStatus[] = ['pending', 'running'];

function isActive(status: AttemptStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function isTerminal(status: AttemptStatus): boolean {
  return !isActive(status);
}

function preferFreshHistorySummary(
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

function mergeHistoryPage(
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
    const next = preferFreshHistorySummary(item, previous, currentAttempt);
    if (position === undefined) {
      positions.set(item.id, merged.length);
      merged.push(next);
    } else {
      merged[position] = next;
    }
  }
  return merged;
}

function reasonLabel(reason: string): string {
  if (reason.startsWith('cancelled_'))
    return 'El intento se cerró por tu solicitud de cancelación.';
  const labels: Record<string, string> = {
    exit_reached: 'El robot llegó a la salida.',
    turn_limit_reached: 'Se agotaron los turnos disponibles.',
    walk_into_pit: 'El robot intentó caminar sobre un pozo y cayó.',
    crouch_into_pit: 'El robot intentó cruzar un pozo agachado y cayó.',
    walk_into_branch: 'El robot intentó caminar bajo una rama y chocó.',
    jump_into_branch: 'El robot saltó contra una rama y chocó.',
    start_deadline_expired: 'El cálculo no pudo comenzar dentro del tiempo disponible.',
    runtime_deadline_expired: 'La ejecución no terminó dentro del tiempo disponible.',
    runtime_deadline_exceeded: 'No quedaba tiempo suficiente para otra decisión.',
    throttled: 'El proveedor del agente rechazó las llamadas por falta de capacidad disponible.',
    timeout: 'No llegó una respuesta completa del agente dentro del tiempo disponible.',
    invalid_response: 'El agente respondió sin elegir exactamente una habilidad válida.',
    truncated: 'La respuesta del agente quedó incompleta.',
    audit_failed: 'No se pudo conservar el registro completo de la llamada.',
    request_not_persisted: 'No se pudo guardar la solicitud antes de llamar al agente.',
    provider_error: 'El proveedor del agente no pudo completar la llamada.',
  };
  return labels[reason] ?? 'Un error técnico impidió completar el intento.';
}

function statusLabel(status: AttemptStatus): string {
  switch (status) {
    case 'pending':
      return 'Admitido, esperando inicio';
    case 'running':
      return 'Preparando intento';
    case 'victory':
      return 'Victoria';
    case 'defeat':
      return 'Derrota';
    case 'incomplete':
      return 'Recorrido incompleto';
    case 'cancelled':
      return 'Cancelado';
    case 'error':
      return 'Error de ejecución';
  }
}

function statusDescription(status: AttemptStatus): string {
  switch (status) {
    case 'pending':
      return 'El servidor recibió el intento y va a iniciar el cálculo.';
    case 'running':
      return 'El agente está tomando decisiones. Podés cancelar el cálculo.';
    case 'victory':
      return 'El robot llegó a la salida del recorrido estático.';
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

function formatMetric(value: number | null): string {
  return value === null ? 'desconocido' : value.toLocaleString('es-AR');
}

function formatProgress(value: number): string {
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
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

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof AttemptApiFailure && error.code === 'authentication';
}

function isTransientAdmissionFailure(error: unknown): boolean {
  return error instanceof AttemptApiFailure && (error.ambiguous || error.code === 'authentication');
}

function ResultCard({ attempt }: { attempt: AttemptSummary }) {
  return (
    <section className="attempt-result" aria-labelledby="attempt-result-title">
      <div className="attempt-result-heading">
        <div>
          <p className="card-kicker">Resultado del recorrido</p>
          <h3 id="attempt-result-title">{statusLabel(attempt.status)}</h3>
        </div>
        <span className="attempt-status" data-status={attempt.status}>
          {attempt.recordComplete ? 'Registro completo' : 'Registro incompleto'}
        </span>
      </div>
      <p>{statusDescription(attempt.status)}</p>
      <p className="attempt-level">Nivel: {attempt.levelId}</p>
      <p className="attempt-model">Modelo: {attempt.modelLabel}</p>
      {attempt.reason && (
        <p className="attempt-reason">Causa registrada: {reasonLabel(attempt.reason)}</p>
      )}
      <dl className="attempt-metrics">
        <div>
          <dt>Avance máximo</dt>
          <dd>{formatProgress(attempt.progress)}</dd>
        </div>
        <div>
          <dt>Turnos</dt>
          <dd>
            {attempt.turnsUsed} / {attempt.maxTurns}
          </dd>
        </div>
        <div>
          <dt>Llamadas</dt>
          <dd>{attempt.calls}</dd>
        </div>
        <div>
          <dt>Entrada</dt>
          <dd>{formatMetric(attempt.inputTokens)}</dd>
        </div>
        <div>
          <dt>Salida</dt>
          <dd>{formatMetric(attempt.outputTokens)}</dd>
        </div>
        <div>
          <dt>Razonamiento (incluido en salida)</dt>
          <dd>{formatMetric(attempt.reasoningTokens)}</dd>
        </div>
        <div>
          <dt>Caché leída</dt>
          <dd>{formatMetric(attempt.cacheReadTokens)}</dd>
        </div>
        <div>
          <dt>Caché escrita</dt>
          <dd>{formatMetric(attempt.cacheWriteTokens)}</dd>
        </div>
        <div>
          <dt>Objetos</dt>
          <dd>0</dd>
        </div>
        {attempt.status === 'victory' && (
          <div>
            <dt>Puntaje</dt>
            <dd>
              {attempt.score === null ? 'desconocido' : attempt.score.toLocaleString('es-AR')}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function HistoryList({
  attempts,
  nextCursor,
  busy,
  onOpen,
  onMore,
}: {
  attempts: readonly AttemptSummary[];
  nextCursor?: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onMore: () => void;
}) {
  return (
    <section className="attempt-history" aria-labelledby="attempt-history-title">
      <div className="attempt-section-heading">
        <div>
          <p className="card-kicker">Tus recorridos</p>
          <h3 id="attempt-history-title">Historial</h3>
        </div>
        <span className="history-count">{attempts.length} cargados</span>
      </div>
      {attempts.length === 0 ? (
        <p className="history-empty">Todavía no hay intentos guardados.</p>
      ) : (
        <ul className="history-list">
          {attempts.map((item) => (
            <li key={item.id}>
              <div>
                <strong>{statusLabel(item.status)}</strong>
                <span>
                  {item.turnsUsed} / {item.maxTurns} turnos · {item.modelLabel} · {item.createdAt}
                </span>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => onOpen(item.id)}
                disabled={busy}
              >
                Ver resultado
              </button>
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <button className="secondary-button" type="button" onClick={onMore} disabled={busy}>
          Cargar 20 más
        </button>
      )}
    </section>
  );
}

export const AttemptWorkspace = forwardRef<AttemptWorkspaceHandle, AttemptWorkspaceProps>(
  function AttemptWorkspace(
    {
      api,
      editor,
      session,
      authPaused = false,
      onBusyChange,
      onAuthRequired,
    }: AttemptWorkspaceProps,
    ref,
  ) {
    const [mode, setMode] = useState<WorkspaceMode>('loading');
    const [attempt, setAttempt] = useState<AttemptSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [quota, setQuota] = useState<QuotaSummary | null>(null);
    const [history, setHistory] = useState<readonly AttemptSummary[]>([]);
    const [historyCursor, setHistoryCursor] = useState<string | undefined>();
    const [activeCandidates, setActiveCandidates] = useState<readonly AttemptSummary[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [cancelBusy, setCancelBusy] = useState(false);
    const generationRef = useRef(0);
    const frozenRef = useRef<FrozenAdmission | null>(null);
    const attemptRef = useRef<AttemptSummary | null>(null);
    const modeRef = useRef(mode);
    const startLockRef = useRef(false);
    const operationEpochRef = useRef(0);
    const startServerAttemptRef = useRef<
      (
        admission: AttemptAdmission,
        operationGeneration: number,
        operationEpoch: number,
      ) => Promise<void>
    >(async () => undefined);
    const sessionSub = session.identity.sub;
    const sessionSubRef = useRef(sessionSub);

    useEffect(() => {
      const previousSub = sessionSubRef.current;
      if (previousSub !== sessionSub) {
        frozenRef.current = null;
        clearAttemptRecovery(previousSub);
        sessionSubRef.current = sessionSub;
      }
    }, [sessionSub]);

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
      mode === 'selecting';

    useEffect(() => {
      onBusyChange?.(busy);
      if (!busy) {
        startLockRef.current = false;
      }
    }, [busy, onBusyChange]);

    const applyAttempt = useCallback(
      (next: AttemptSummary, options: { clearRequest?: boolean } = {}): void => {
        attemptRef.current = next;
        setAttempt(next);
        setHistory((current) => {
          let changed = false;
          const updated = current.map((item) => {
            if (item.id !== next.id) return item;
            changed = true;
            return next;
          });
          return changed ? updated : current;
        });
        if ((options.clearRequest ?? true) || isTerminal(next.status)) {
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
        setMode(
          isTerminal(next.status)
            ? 'result'
            : next.cancelRequested
              ? 'canceling'
              : next.status === 'pending' || next.status === 'running'
                ? next.status
                : 'unknown',
        );
      },
      [sessionSub],
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

    const refreshHistory = useCallback(
      async (signal?: AbortSignal): Promise<void> => {
        const operationGeneration = generationRef.current;
        setLoadingHistory(true);
        try {
          const page: AttemptsPage = await api.listAttempts(undefined, signal);
          if (signal?.aborted || generationRef.current !== operationGeneration) return;
          setHistory((current) =>
            mergeHistoryPage(current, page.attempts, attemptRef.current, false),
          );
          setHistoryCursor(page.nextCursor);
        } catch (historyError) {
          if (!signal?.aborted && generationRef.current === operationGeneration) {
            if (isAuthenticationFailure(historyError)) onAuthRequired?.();
            setError(attemptErrorMessage(historyError));
          }
        } finally {
          if (!signal?.aborted && generationRef.current === operationGeneration) {
            setLoadingHistory(false);
          }
        }
      },
      [api, onAuthRequired],
    );

    const refreshQuota = useCallback(
      async (signal?: AbortSignal): Promise<void> => {
        const operationGeneration = generationRef.current;
        try {
          const nextQuota = await api.getQuota(signal);
          if (!signal?.aborted && generationRef.current === operationGeneration) {
            setQuota(nextQuota);
          }
        } catch (quotaError) {
          if (!signal?.aborted && generationRef.current === operationGeneration) {
            if (isAuthenticationFailure(quotaError)) onAuthRequired?.();
            setError(attemptErrorMessage(quotaError));
          }
        }
      },
      [api, onAuthRequired],
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
        setMode('admitting');
        try {
          const admission = await api.createAttempt(
            frozen.requestKey,
            frozen.expectedVersion,
            frozen.draft,
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
          if (isTransientAdmissionFailure(retryError)) {
            setError(
              retryError instanceof AttemptApiFailure && retryError.ambiguous
                ? 'No se confirmó la admisión. Podés comprobarla con la misma clave.'
                : attemptErrorMessage(retryError),
            );
            setMode('unknown');
            if (isAuthenticationFailure(retryError)) onAuthRequired?.();
            return true;
          }
          clearAttemptRecovery(sessionSub);
          frozenRef.current = null;
          startLockRef.current = false;
          setMode('idle');
          setError(attemptErrorMessage(retryError));
          return true;
        }
      },
      [api, onAuthRequired, sessionSub],
    );

    const recoverKnownAttempt = useCallback(
      async (signal?: AbortSignal): Promise<boolean> => {
        const reference = readAttemptRecovery(sessionSub);
        if (!reference) return false;
        const storedFrozen = frozenAdmissionFromRecovery(reference);
        if (storedFrozen) frozenRef.current = storedFrozen;
        try {
          const next = reference.attemptId
            ? await api.getAttempt(reference.attemptId, signal)
            : reference.requestKey
              ? await api.getAttemptRequest(reference.requestKey, signal)
              : null;
          if (!next || signal?.aborted) return false;
          frozenRef.current = null;
          applyAttempt(next, { clearRequest: isTerminal(next.status) });
          return true;
        } catch (recoveryError) {
          if (signal?.aborted) return false;
          if (isAuthenticationFailure(recoveryError)) onAuthRequired?.();
          if (recoveryError instanceof AttemptApiFailure && recoveryError.code === 'not_found') {
            const frozen = frozenRef.current;
            if (reference.requestKey && !reference.attemptId && frozen) {
              return retryFrozenAdmission(frozen, {
                signal,
                operationGeneration: generationRef.current,
                operationEpoch: operationEpochRef.current,
              });
            }
            if (reference.requestKey && !reference.attemptId) {
              setError(
                'No se confirmó la admisión. Conservamos la clave, pero falta el snapshot exacto para reintentar.',
              );
              setMode('unknown');
              return true;
            }
            return false;
          }
          setError(attemptErrorMessage(recoveryError));
          setMode('unknown');
          return true;
        }
      },
      [api, applyAttempt, onAuthRequired, retryFrozenAdmission, sessionSub],
    );

    useEffect(() => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const controller = new AbortController();
      void (async () => {
        try {
          await Promise.resolve();
          setMode('loading');
          setAttempt(null);
          setActiveCandidates([]);
          setError(null);
          await Promise.all([refreshQuota(controller.signal), refreshHistory(controller.signal)]);
          if (await recoverKnownAttempt(controller.signal)) return;
          const all = await listAllAttempts(controller.signal);
          if (controller.signal.aborted || generationRef.current !== generation) return;
          const active = all.filter((item) => isActive(item.status));
          if (active.length === 1) {
            applyAttempt(active[0]);
          } else if (active.length > 1) {
            setActiveCandidates(active);
            setMode('selecting');
          } else {
            setMode('idle');
          }
        } catch (initialError) {
          if (controller.signal.aborted || generationRef.current !== generation) return;
          if (isAuthenticationFailure(initialError)) onAuthRequired?.();
          setError(attemptErrorMessage(initialError));
          setMode('unknown');
        }
      })();
      return () => {
        controller.abort();
        generationRef.current += 1;
      };
    }, [
      applyAttempt,
      listAllAttempts,
      onAuthRequired,
      recoverKnownAttempt,
      refreshHistory,
      refreshQuota,
      sessionSub,
    ]);

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
        frozenRef.current = null;
        applyAttempt(next, { clearRequest: false });
        if (!admission.dispatchConfirmed && next.status === 'pending') {
          try {
            const started = await api.startAttempt(next.id);
            if (
              generationRef.current !== operationGeneration ||
              operationEpochRef.current !== operationEpoch
            ) {
              return;
            }
            next = started.attempt;
            applyAttempt(next, { clearRequest: false });
          } catch (startError) {
            if (
              generationRef.current !== operationGeneration ||
              operationEpochRef.current !== operationEpoch
            ) {
              return;
            }
            if (isAuthenticationFailure(startError)) onAuthRequired?.();
            setError(attemptErrorMessage(startError));
            setMode('unknown');
            return;
          }
        }
        if (
          generationRef.current !== operationGeneration ||
          operationEpochRef.current !== operationEpoch
        ) {
          return;
        }
        if (isTerminal(next.status)) {
          clearAttemptRecovery(sessionSub);
        }
        await refreshQuota();
        await refreshHistory();
      },
      [api, applyAttempt, onAuthRequired, refreshHistory, refreshQuota, sessionSub],
    );
    useEffect(() => {
      startServerAttemptRef.current = startServerAttempt;
    }, [startServerAttempt]);

    const start = useCallback(async (): Promise<void> => {
      if (
        startLockRef.current ||
        busy ||
        authPaused ||
        (modeRef.current === 'result' && attemptRef.current?.status === 'running')
      ) {
        return;
      }
      startLockRef.current = true;
      operationEpochRef.current += 1;
      const operationGeneration = generationRef.current;
      const operationEpoch = operationEpochRef.current;
      const requestKey = makeRequestKey();
      writeAttemptRecovery({ sub: sessionSub, requestKey });
      setMode('admitting');
      setError(null);
      let snapshot;
      try {
        snapshot = await editor.current?.captureSnapshot();
      } catch (captureError) {
        snapshot = null;
        setError(attemptErrorMessage(captureError));
      }
      if (!snapshot) {
        clearAttemptRecovery(sessionSub);
        setMode('idle');
        startLockRef.current = false;
        setError(
          (current) =>
            current ??
            'No se pudo confirmar la configuración visible. Revisá el guardado y reintentá.',
        );
        return;
      }
      if (
        generationRef.current !== operationGeneration ||
        operationEpochRef.current !== operationEpoch
      ) {
        return;
      }
      frozenRef.current = {
        requestKey,
        expectedVersion: snapshot.version,
        draft: snapshot.draft,
      };
      writeAttemptRecovery({
        sub: sessionSub,
        requestKey,
        expectedVersion: snapshot.version,
        draft: snapshot.draft,
      });
      try {
        const admission = await api.createAttempt(requestKey, snapshot.version, snapshot.draft);
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
          setError('No se confirmó la admisión. Podés comprobarla con la misma clave.');
          setMode('unknown');
          return;
        }
        if (
          admissionError instanceof AttemptApiFailure &&
          admissionError.code === 'authentication'
        ) {
          setError(admissionError.message);
          setMode('unknown');
          onAuthRequired?.();
          return;
        }
        clearAttemptRecovery(sessionSub);
        frozenRef.current = null;
        setMode('idle');
        startLockRef.current = false;
        setError(attemptErrorMessage(admissionError));
        if (isAuthenticationFailure(admissionError)) onAuthRequired?.();
      }
    }, [api, authPaused, busy, editor, onAuthRequired, sessionSub, startServerAttempt]);

    useImperativeHandle(
      ref,
      () => ({
        start: () => {
          void start();
        },
      }),
      [start],
    );

    const resolveUnknown = useCallback(async (): Promise<void> => {
      const operationGeneration = generationRef.current;
      operationEpochRef.current += 1;
      const operationEpoch = operationEpochRef.current;
      setError(null);
      const storedReference = readAttemptRecovery(sessionSub);
      const storedFrozen = frozenAdmissionFromRecovery(storedReference);
      if (storedFrozen) frozenRef.current = storedFrozen;
      const frozen = frozenRef.current;
      const reference = {
        sub: sessionSub,
        ...(storedReference?.attemptId || !storedReference
          ? { attemptId: storedReference?.attemptId ?? attemptRef.current?.id }
          : {}),
        ...(storedReference?.requestKey || !storedReference
          ? { requestKey: storedReference?.requestKey ?? frozen?.requestKey }
          : {}),
      };
      if (!reference.attemptId && !reference.requestKey) {
        setError('No hay una referencia de recuperación para este intento.');
        return;
      }
      try {
        const found = reference.attemptId
          ? await api.getAttempt(reference.attemptId)
          : reference.requestKey
            ? await api.getAttemptRequest(reference.requestKey)
            : null;
        if (found) {
          if (
            generationRef.current !== operationGeneration ||
            operationEpochRef.current !== operationEpoch
          ) {
            return;
          }
          frozenRef.current = null;
          applyAttempt(found, { clearRequest: isTerminal(found.status) });
          return;
        }
      } catch (lookupError) {
        if (
          generationRef.current !== operationGeneration ||
          operationEpochRef.current !== operationEpoch
        ) {
          return;
        }
        if (!(lookupError instanceof AttemptApiFailure && lookupError.code === 'not_found')) {
          setError(attemptErrorMessage(lookupError));
          if (isAuthenticationFailure(lookupError)) onAuthRequired?.();
          return;
        }
      }
      if (!frozen || !reference.requestKey || reference.attemptId) {
        setError('Todavía no se puede confirmar este intento. Volvé a consultar más tarde.');
        return;
      }
      await retryFrozenAdmission(frozen, {
        operationGeneration,
        operationEpoch,
      });
    }, [api, applyAttempt, onAuthRequired, retryFrozenAdmission, sessionSub]);

    const cancel = useCallback(async (): Promise<void> => {
      const operationGeneration = generationRef.current;
      operationEpochRef.current += 1;
      const operationEpoch = operationEpochRef.current;
      const current = attemptRef.current;
      if (!current || (!isActive(current.status) && !current.cancelRequested) || cancelBusy) return;
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
        if (isAuthenticationFailure(cancelError)) onAuthRequired?.();
        setMode('unknown');
        setError(attemptErrorMessage(cancelError));
      } finally {
        if (
          generationRef.current === operationGeneration &&
          operationEpochRef.current === operationEpoch
        ) {
          setCancelBusy(false);
        }
      }
    }, [api, applyAttempt, cancelBusy, onAuthRequired]);

    const openAttempt = useCallback(
      async (id: string): Promise<void> => {
        if (busy) return;
        const operationGeneration = generationRef.current;
        operationEpochRef.current += 1;
        const operationEpoch = operationEpochRef.current;
        const previousMode: WorkspaceMode = modeRef.current === 'result' ? 'result' : 'idle';
        setMode('opening');
        setError(null);
        try {
          const next = await api.getAttempt(id);
          if (
            generationRef.current !== operationGeneration ||
            operationEpochRef.current !== operationEpoch
          ) {
            return;
          }
          applyAttempt(next, { clearRequest: false });
        } catch (openError) {
          if (
            generationRef.current !== operationGeneration ||
            operationEpochRef.current !== operationEpoch
          ) {
            return;
          }
          setMode(previousMode);
          if (isAuthenticationFailure(openError)) onAuthRequired?.();
          setError(attemptErrorMessage(openError));
        }
      },
      [api, applyAttempt, busy, onAuthRequired],
    );

    const loadMore = useCallback(async (): Promise<void> => {
      if (!historyCursor || loadingHistory || busy) return;
      const operationGeneration = generationRef.current;
      setLoadingHistory(true);
      try {
        const page = await api.listAttempts(historyCursor);
        if (generationRef.current !== operationGeneration) return;
        setHistory((current) => mergeHistoryPage(current, page.attempts, attemptRef.current, true));
        setHistoryCursor(page.nextCursor);
      } catch (historyError) {
        if (generationRef.current !== operationGeneration) return;
        if (isAuthenticationFailure(historyError)) onAuthRequired?.();
        setError(attemptErrorMessage(historyError));
      } finally {
        if (generationRef.current === operationGeneration) setLoadingHistory(false);
      }
    }, [api, busy, historyCursor, loadingHistory, onAuthRequired]);

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
          setError(attemptErrorMessage(pollError));
          if (isAuthenticationFailure(pollError)) onAuthRequired?.();
        }
      };
      timer = window.setTimeout(() => void poll(), 2_000);
      return () => {
        controller.abort();
        if (timer !== undefined) window.clearTimeout(timer);
      };
    }, [api, applyAttempt, attempt, authPaused, mode, onAuthRequired]);

    const chooseActive = (next: AttemptSummary): void => {
      applyAttempt(next, { clearRequest: false });
      setActiveCandidates([]);
    };

    return (
      <section className="attempt-workspace" aria-labelledby="attempt-workspace-title">
        <div className="attempt-heading">
          <div>
            <p className="card-kicker">Recorrido estático</p>
            <h2 id="attempt-workspace-title">Probar al agente</h2>
            <p>El robot recorre suelo, pozo, suelo, rama y suelo en hasta 12 acciones.</p>
          </div>
          {quota && (
            <div
              className="quota-badge"
              aria-label={`Cuota: ${quota.remaining} intentos disponibles`}
            >
              <strong>{quota.remaining}</strong>
              <span>intentos disponibles hoy</span>
            </div>
          )}
        </div>

        {error && (
          <div className="attempt-error" role="alert">
            <p>{error}</p>
            {mode === 'unknown' && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void resolveUnknown()}
              >
                Comprobar estado
              </button>
            )}
            {(mode === 'idle' || mode === 'result') && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  void refreshQuota();
                  void refreshHistory();
                }}
              >
                Reintentar consultas
              </button>
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
                  {candidate.id} · {statusLabel(candidate.status)}
                </button>
              ))}
            </div>
          </section>
        )}

        {mode === 'admitting' && (
          <p className="attempt-message" role="status">
            Guardando la configuración visible y admitiendo el intento…
          </p>
        )}
        {mode === 'opening' && (
          <p className="attempt-message" role="status">
            Consultando el resultado guardado…
          </p>
        )}
        {(mode === 'pending' || mode === 'running' || mode === 'canceling') && attempt && (
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
                  ? 'Esperando sesión…'
                  : 'Cancelar'}
            </button>
          </section>
        )}

        {mode === 'unknown' && (
          <p className="attempt-message" role="status">
            El estado del servidor todavía no está confirmado. La recuperación no inicia otro
            intento.
          </p>
        )}

        {mode === 'result' && attempt && <ResultCard attempt={attempt} />}

        {(mode === 'idle' || mode === 'result') && (
          <HistoryList
            attempts={history}
            nextCursor={historyCursor}
            busy={busy || loadingHistory}
            onOpen={(id) => void openAttempt(id)}
            onMore={() => void loadMore()}
          />
        )}
      </section>
    );
  },
);

AttemptWorkspace.displayName = 'AttemptWorkspace';
