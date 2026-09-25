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
import type { AnimationPreference, ReplayRecordView } from '../../../shared/attempt.js';
import { ReplayScene } from './replay/ReplayScene.js';

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

interface AttemptWorkspaceProps {
  readonly api: AttemptApi;
  readonly editor: RefObject<RobotEditorHandle | null>;
  readonly session: AuthSession;
  readonly authPaused?: boolean;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onPreferenceReadyChange?: (ready: boolean) => void;
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
    walk_into_barrier: 'El robot intentó atravesar una barrera y chocó.',
    crouch_into_low_barrier: 'El robot intentó pasar agachado por una barrera baja y chocó.',
    jump_into_high_barrier: 'El robot saltó contra una barrera alta y chocó.',
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

function ResultCard({ attempt, onReplay }: { attempt: AttemptSummary; onReplay: () => void }) {
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
      {attempt.recordComplete && attempt.turnsUsed > 0 && (
        <button className="secondary-button replay-again" type="button" onClick={onReplay}>
          Ver de nuevo
        </button>
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
          <dt>Tokens usados para puntaje</dt>
          <dd>{formatMetric(attempt.gameTokens)}</dd>
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
          <dd>{attempt.collectedObjectIds.length}</dd>
        </div>
        <div>
          <dt>Valor de objetos recogidos</dt>
          <dd>{attempt.objectPoints.toLocaleString('es-AR')} puntos</dd>
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
  onReplay,
  onMore,
}: {
  attempts: readonly AttemptSummary[];
  nextCursor?: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onReplay: (id: string) => void;
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
                <span>
                  Objetos: {item.collectedObjectIds.length} · valor recogido:{' '}
                  {item.objectPoints.toLocaleString('es-AR')} puntos
                </span>
              </div>
              <div className="history-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onOpen(item.id)}
                  disabled={busy}
                >
                  Ver resultado
                </button>
                {item.recordComplete && isTerminal(item.status) && item.turnsUsed > 0 && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onReplay(item.id)}
                    disabled={busy}
                  >
                    Ver de nuevo
                  </button>
                )}
              </div>
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
      onPreferenceReadyChange,
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
    const [animationEnabled, setAnimationEnabled] = useState(true);
    const [preferenceLoading, setPreferenceLoading] = useState(true);
    const [preferenceReady, setPreferenceReady] = useState(false);
    const [preferenceSaving, setPreferenceSaving] = useState(false);
    const [preferenceError, setPreferenceError] = useState<string | null>(null);
    const [preferenceConflict, setPreferenceConflict] = useState<string | null>(null);
    const [preferenceRemoteValue, setPreferenceRemoteValue] = useState<boolean | null>(null);
    const [replayRecord, setReplayRecord] = useState<ReplayRecordView | null>(null);
    const [playbackKind, setPlaybackKind] = useState<PlaybackKind | null>(null);
    const [playbackReachedEnd, setPlaybackReachedEnd] = useState(false);
    const [completionBusy, setCompletionBusy] = useState(false);
    const generationRef = useRef(0);
    const frozenRef = useRef<FrozenAdmission | null>(null);
    const attemptRef = useRef<AttemptSummary | null>(null);
    const modeRef = useRef(mode);
    const startLockRef = useRef(false);
    const operationEpochRef = useRef(0);
    const replayEpochRef = useRef(0);
    const completionBusyRef = useRef(false);
    const completionAttemptRef = useRef<string | null>(null);
    const completionOperationRef = useRef(0);
    const animationEnabledRef = useRef(true);
    const preferenceVersionRef = useRef(0);
    const preferenceGenerationRef = useRef(0);
    const preferenceControllerRef = useRef<AbortController>(new AbortController());
    const preferenceChoiceRevisionRef = useRef(0);
    const preferenceWriteCountRef = useRef(0);
    const preferenceConflictRef = useRef(false);
    const preferenceQueueRef = useRef<Promise<void>>(Promise.resolve());
    const preferenceReadyRef = useRef(false);
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
        preferenceControllerRef.current.abort();
        preferenceControllerRef.current = new AbortController();
        preferenceGenerationRef.current += 1;
        preferenceChoiceRevisionRef.current += 1;
        preferenceQueueRef.current = Promise.resolve();
        frozenRef.current = null;
        clearAttemptRecovery(previousSub);
        replayEpochRef.current += 1;
        completionOperationRef.current += 1;
        completionBusyRef.current = false;
        completionAttemptRef.current = null;
        animationEnabledRef.current = true;
        setAnimationEnabled(true);
        preferenceVersionRef.current = 0;
        setPreferenceLoading(true);
        preferenceReadyRef.current = false;
        setPreferenceReady(false);
        preferenceWriteCountRef.current = 0;
        preferenceConflictRef.current = false;
        setPreferenceSaving(false);
        setPreferenceError(null);
        setPreferenceConflict(null);
        setPreferenceRemoteValue(null);
        setReplayRecord(null);
        setPlaybackKind(null);
        setPlaybackReachedEnd(false);
        setCompletionBusy(false);
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
      mode === 'selecting' ||
      mode === 'preparing-replay' ||
      mode === 'replaying';

    useEffect(() => {
      onBusyChange?.(busy);
      if (!busy) {
        startLockRef.current = false;
      }
    }, [busy, onBusyChange]);

    useEffect(() => {
      onPreferenceReadyChange?.(preferenceReady);
    }, [onPreferenceReadyChange, preferenceReady]);

    const refreshAnimationPreference = useCallback(
      async (signal?: AbortSignal, initial = false): Promise<void> => {
        const requestSignal = signal ?? preferenceControllerRef.current.signal;
        const preferenceGeneration = preferenceGenerationRef.current;
        const choiceRevisionAtRequest = preferenceChoiceRevisionRef.current;
        if (initial) {
          setPreferenceLoading(true);
        } else if (preferenceWriteCountRef.current > 0) {
          return;
        }
        try {
          const preference: AnimationPreference = await api.getAnimationPreference(requestSignal);
          if (requestSignal.aborted || preferenceGenerationRef.current !== preferenceGeneration) {
            return;
          }
          if (
            choiceRevisionAtRequest !== preferenceChoiceRevisionRef.current ||
            preference.version < preferenceVersionRef.current
          ) {
            return;
          }
          preferenceReadyRef.current = true;
          setPreferenceReady(true);
          const hasNewerVersion = preference.version > preferenceVersionRef.current;
          preferenceVersionRef.current = Math.max(preference.version, preferenceVersionRef.current);
          if (hasNewerVersion && preferenceWriteCountRef.current > 0) {
            preferenceConflictRef.current = true;
            setPreferenceRemoteValue(preference.animationEnabled);
            setPreferenceConflict(
              `Otra pestaña guardó la animación ${preference.animationEnabled ? 'activada' : 'desactivada'}. Tu selección sigue visible; guardala para usarla como preferencia.`,
            );
          } else if (preferenceWriteCountRef.current === 0) {
            animationEnabledRef.current = preference.animationEnabled;
            setAnimationEnabled(preference.animationEnabled);
            preferenceConflictRef.current = false;
            setPreferenceConflict(null);
            setPreferenceRemoteValue(null);
            setPreferenceError(null);
          }
        } catch (preferenceFailure) {
          if (requestSignal.aborted || preferenceGenerationRef.current !== preferenceGeneration) {
            return;
          }
          if (initial) {
            preferenceReadyRef.current = false;
            setPreferenceReady(false);
          }
          if (isAuthenticationFailure(preferenceFailure)) onAuthRequired?.();
          setPreferenceError(attemptErrorMessage(preferenceFailure));
        } finally {
          if (
            initial &&
            !requestSignal.aborted &&
            preferenceGenerationRef.current === preferenceGeneration
          ) {
            setPreferenceLoading(false);
          }
        }
      },
      [api, onAuthRequired],
    );

    const queueAnimationPreferenceSave = useCallback(
      (value: boolean): void => {
        const revision = ++preferenceChoiceRevisionRef.current;
        const preferenceGeneration = preferenceGenerationRef.current;
        const requestSignal = preferenceControllerRef.current.signal;
        preferenceWriteCountRef.current += 1;
        setPreferenceSaving(true);
        setPreferenceError(null);
        const queued = preferenceQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            try {
              if (
                requestSignal.aborted ||
                preferenceGenerationRef.current !== preferenceGeneration ||
                revision < preferenceChoiceRevisionRef.current ||
                preferenceConflictRef.current
              ) {
                return;
              }
              const saved = await api.putAnimationPreference(
                value,
                preferenceVersionRef.current,
                requestSignal,
              );
              if (
                requestSignal.aborted ||
                preferenceGenerationRef.current !== preferenceGeneration
              ) {
                return;
              }
              preferenceVersionRef.current = saved.version;
              preferenceReadyRef.current = true;
              setPreferenceReady(true);
              if (revision === preferenceChoiceRevisionRef.current) {
                animationEnabledRef.current = saved.animationEnabled;
                setAnimationEnabled(saved.animationEnabled);
                setPreferenceConflict(null);
                setPreferenceRemoteValue(null);
                preferenceConflictRef.current = false;
              }
            } catch (saveFailure) {
              if (
                requestSignal.aborted ||
                preferenceGenerationRef.current !== preferenceGeneration
              ) {
                return;
              }
              try {
                const current = await api.getAnimationPreference(requestSignal);
                if (
                  requestSignal.aborted ||
                  preferenceGenerationRef.current !== preferenceGeneration
                ) {
                  return;
                }
                preferenceVersionRef.current = current.version;
                preferenceReadyRef.current = true;
                setPreferenceReady(true);
                if (current.animationEnabled === value) {
                  if (revision === preferenceChoiceRevisionRef.current) {
                    animationEnabledRef.current = current.animationEnabled;
                    setAnimationEnabled(current.animationEnabled);
                    preferenceConflictRef.current = false;
                    setPreferenceRemoteValue(null);
                    setPreferenceConflict(null);
                  }
                } else if (revision === preferenceChoiceRevisionRef.current) {
                  preferenceConflictRef.current = true;
                  setPreferenceRemoteValue(current.animationEnabled);
                  setPreferenceConflict(
                    `No se guardó tu cambio porque la preferencia del servidor ahora está ${current.animationEnabled ? 'activada' : 'desactivada'}. Tu selección sigue visible; elegí guardarla para resolver el conflicto.`,
                  );
                }
              } catch {
                setPreferenceError(attemptErrorMessage(saveFailure));
              }
            } finally {
              preferenceWriteCountRef.current = Math.max(0, preferenceWriteCountRef.current - 1);
              setPreferenceSaving(preferenceWriteCountRef.current > 0);
            }
          });
        preferenceQueueRef.current = queued;
      },
      [api],
    );

    const chooseAnimationPreference = useCallback(
      (value: boolean): void => {
        animationEnabledRef.current = value;
        setAnimationEnabled(value);
        setPreferenceError(null);
        setPreferenceConflict(null);
        setPreferenceRemoteValue(null);
        preferenceConflictRef.current = false;
        queueAnimationPreferenceSave(value);
      },
      [queueAnimationPreferenceSave],
    );

    const beginReplay = useCallback(
      async (target: AttemptSummary, kind: PlaybackKind): Promise<void> => {
        if (kind === 'manual' && target.turnsUsed === 0) {
          setReplayRecord(null);
          setPlaybackKind(null);
          setPlaybackReachedEnd(false);
          setMode('result');
          return;
        }
        const generation = generationRef.current;
        const epoch = ++replayEpochRef.current;
        setPlaybackKind(kind);
        setReplayRecord(null);
        setPlaybackReachedEnd(false);
        setError(null);
        completionOperationRef.current += 1;
        completionBusyRef.current = false;
        completionAttemptRef.current = null;
        setCompletionBusy(false);
        if (kind === 'automatic' && !target.recordComplete) {
          setMode('replay-error');
          setError('El registro está incompleto y no se puede reproducir sin omitir acciones.');
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
          if (isAuthenticationFailure(replayFailure)) onAuthRequired?.();
          setError(
            replayFailure instanceof AttemptApiFailure
              ? replayFailure.message
              : 'No se pudo cargar una reproducción completa. El resultado original sigue guardado.',
          );
          setMode('replay-error');
        }
      },
      [api, onAuthRequired],
    );

    const refreshPreferenceOnFocus = useCallback((): void => {
      if (document.visibilityState === 'hidden') return;
      void refreshAnimationPreference();
    }, [refreshAnimationPreference]);

    useEffect(() => {
      window.addEventListener('focus', refreshPreferenceOnFocus);
      document.addEventListener('visibilitychange', refreshPreferenceOnFocus);
      return () => {
        window.removeEventListener('focus', refreshPreferenceOnFocus);
        document.removeEventListener('visibilitychange', refreshPreferenceOnFocus);
      };
    }, [refreshPreferenceOnFocus]);

    const applyAttempt = useCallback(
      (next: AttemptSummary, options: { clearRequest?: boolean } = {}): void => {
        if (attemptRef.current && attemptRef.current.id !== next.id) {
          completionOperationRef.current += 1;
          completionBusyRef.current = false;
          completionAttemptRef.current = null;
          setCompletionBusy(false);
          setPlaybackReachedEnd(false);
        }
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
      [beginReplay, sessionSub],
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
          await Promise.all([
            refreshQuota(controller.signal),
            refreshHistory(controller.signal),
            refreshAnimationPreference(controller.signal, true),
          ]);
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
      refreshAnimationPreference,
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
        if (isTerminal(next.status) && next.presentationComplete) {
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
      if (!preferenceReadyRef.current) {
        setPreferenceError('Cargá la preferencia de animación antes de probar el robot.');
        return;
      }
      if (
        startLockRef.current ||
        busy ||
        authPaused ||
        (modeRef.current === 'result' && attemptRef.current?.status === 'running')
      ) {
        return;
      }
      startLockRef.current = true;
      completionOperationRef.current += 1;
      completionBusyRef.current = false;
      completionAttemptRef.current = null;
      setCompletionBusy(false);
      const frozenAnimationEnabled = animationEnabledRef.current;
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

    const openReplayFromHistory = useCallback(
      async (id: string): Promise<void> => {
        if (busy) return;
        const operationGeneration = generationRef.current;
        operationEpochRef.current += 1;
        const operationEpoch = operationEpochRef.current;
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
          if (!isTerminal(next.status) || !next.recordComplete) {
            attemptRef.current = next;
            setAttempt(next);
            setError('Este intento todavía no tiene un registro cerrado para reproducir.');
            setMode(
              isTerminal(next.status)
                ? 'result'
                : next.status === 'pending'
                  ? 'pending'
                  : 'running',
            );
            return;
          }
          attemptRef.current = next;
          setAttempt(next);
          setHistory((current) => current.map((item) => (item.id === next.id ? next : item)));
          if (needsAutomaticPresentation(next)) {
            applyAttempt(next, { clearRequest: false });
          } else if (next.turnsUsed === 0) {
            applyAttempt(next, { clearRequest: false });
          } else {
            await beginReplay(next, 'manual');
          }
        } catch (replayOpenError) {
          if (
            generationRef.current !== operationGeneration ||
            operationEpochRef.current !== operationEpoch
          ) {
            return;
          }
          if (isAuthenticationFailure(replayOpenError)) onAuthRequired?.();
          setError(attemptErrorMessage(replayOpenError));
          setMode('result');
        }
      },
      [api, applyAttempt, beginReplay, busy, onAuthRequired],
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

    const completePresentationInBackground = useCallback(
      (current: AttemptSummary): void => {
        if (completionBusyRef.current && completionAttemptRef.current === current.id) {
          return;
        }
        const generation = generationRef.current;
        const completionOperation = ++completionOperationRef.current;
        completionBusyRef.current = true;
        completionAttemptRef.current = current.id;
        setCompletionBusy(true);
        setError(null);
        void api
          .completePresentation(current.id)
          .then((completed) => {
            if (
              generationRef.current !== generation ||
              completionOperationRef.current !== completionOperation ||
              attemptRef.current?.id !== current.id
            ) {
              return;
            }
            const recovery = readAttemptRecovery(sessionSub);
            if (recovery?.attemptId === current.id) clearAttemptRecovery(sessionSub);
            attemptRef.current = completed;
            setAttempt(completed);
            setHistory((items) =>
              items.map((item) => (item.id === completed.id ? completed : item)),
            );
            setPlaybackReachedEnd(false);
            setPlaybackKind((kind) => (kind === 'automatic' ? null : kind));
            setError(null);
          })
          .catch((completionError: unknown) => {
            if (
              generationRef.current !== generation ||
              completionOperationRef.current !== completionOperation ||
              attemptRef.current?.id !== current.id
            ) {
              return;
            }
            if (isAuthenticationFailure(completionError)) onAuthRequired?.();
            setError(
              `No se pudo guardar el cierre de la presentación: ${attemptErrorMessage(completionError)}`,
            );
          })
          .finally(() => {
            if (completionOperationRef.current !== completionOperation) return;
            completionBusyRef.current = false;
            completionAttemptRef.current = null;
            setCompletionBusy(false);
          });
      },
      [api, onAuthRequired, sessionSub],
    );

    const retryReplay = useCallback((): void => {
      const current = attemptRef.current;
      if (!current || busy) return;
      if (playbackReachedEnd && playbackKind === 'automatic') {
        completePresentationInBackground(current);
        return;
      }
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
              setError('El intento consultado no coincide con el resultado abierto.');
              setMode('replay-error');
              return;
            }
            attemptRef.current = refreshed;
            setAttempt(refreshed);
            setHistory((items) => items.map((item) => (item.id === id ? refreshed : item)));
            if (!isTerminal(refreshed.status)) {
              applyAttempt(refreshed, { clearRequest: false });
              return;
            }
            if (!refreshed.recordComplete) {
              setError(
                'El registro sigue incompleto. Podés volver a intentarlo o ver el resultado guardado.',
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
            if (isAuthenticationFailure(refreshError)) onAuthRequired?.();
            setError(attemptErrorMessage(refreshError));
            setMode('replay-error');
          });
        return;
      }
      void beginReplay(current, playbackKind ?? 'manual');
    }, [
      api,
      applyAttempt,
      beginReplay,
      busy,
      completePresentationInBackground,
      onAuthRequired,
      playbackKind,
      playbackReachedEnd,
    ]);

    const showResultAfterReplayError = useCallback((): void => {
      const current = attemptRef.current;
      if (!current || !isTerminal(current.status)) return;
      const shouldComplete =
        current.animationEnabled && !current.presentationComplete && current.turnsUsed > 0;
      setReplayRecord(null);
      setPlaybackKind(shouldComplete ? 'automatic' : null);
      setPlaybackReachedEnd(shouldComplete);
      setError(null);
      setMode('result');
      if (shouldComplete) {
        completePresentationInBackground(current);
      }
    }, [completePresentationInBackground]);

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
        setPlaybackReachedEnd(false);
        setMode('result');
        return;
      }
      setPlaybackReachedEnd(true);
      setReplayRecord(null);
      setError(null);
      setMode('result');
      completePresentationInBackground(current);
    }, [completePresentationInBackground, playbackKind, replayAttemptId]);

    const onReplayError = useCallback(
      (replayFailure: Error): void => {
        if (!replayAttemptId || attemptRef.current?.id !== replayAttemptId) return;
        setReplayRecord(null);
        setError(
          replayFailure.message || 'No se pudieron preparar todos los recursos de animación.',
        );
        setMode('replay-error');
      },
      [replayAttemptId],
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
            <p className="card-kicker">Terreno con recompensa</p>
            <h2 id="attempt-workspace-title">Probar al agente</h2>
            <p>
              El terreno cambia entre suelo, pozo, rama, barrera y plataforma. En el apoyo 2 hay una
              recompensa: pasar no la recoge; usá Agarrar objeto. Llegá a la salida en hasta 16
              acciones.
            </p>
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

        <div className="animation-preference">
          <label htmlFor="animation-enabled">
            <input
              id="animation-enabled"
              type="checkbox"
              checked={animationEnabled}
              disabled={busy || preferenceLoading}
              onChange={(event) => chooseAnimationPreference(event.currentTarget.checked)}
            />
            <span>Animación</span>
          </label>
          <span className="animation-preference-detail">
            {preferenceLoading
              ? 'Cargando preferencia guardada…'
              : preferenceSaving
                ? 'Guardando preferencia…'
                : animationEnabled
                  ? 'El resultado aparece después de la reproducción.'
                  : 'El resultado aparece directamente.'}
          </span>
        </div>

        {preferenceConflict && (
          <div className="attempt-preference-conflict" role="status">
            <p>
              {preferenceConflict}
              {preferenceRemoteValue === null
                ? ''
                : ` Valor guardado en el servidor: ${preferenceRemoteValue ? 'activado' : 'desactivado'}.`}
            </p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => chooseAnimationPreference(animationEnabledRef.current)}
              disabled={busy || preferenceSaving}
            >
              Guardar mi selección
            </button>
          </div>
        )}
        {preferenceError && (
          <div className="attempt-error" role="alert">
            <p>{preferenceError}</p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void refreshAnimationPreference(undefined, true)}
            >
              Reintentar preferencia
            </button>
          </div>
        )}

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
            {mode === 'replay-error' && (
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={retryReplay}
                  disabled={completionBusy}
                >
                  {playbackReachedEnd ? 'Reintentar cierre' : 'Reintentar reproducción'}
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
                  : 'La secuencia avanza sola a velocidad fija.'}
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
          <ResultCard attempt={attempt} onReplay={replayCurrentAttempt} />
        )}

        {mode === 'result' && playbackReachedEnd && playbackKind === 'automatic' && (
          <>
            {completionBusy && (
              <p className="attempt-message" role="status">
                Guardando el cierre de la presentación…
              </p>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={retryReplay}
              disabled={completionBusy}
            >
              Reintentar cierre de presentación
            </button>
          </>
        )}

        {(mode === 'idle' || mode === 'result') && (
          <HistoryList
            attempts={history}
            nextCursor={historyCursor}
            busy={busy || loadingHistory}
            onOpen={(id) => void openAttempt(id)}
            onReplay={(id) => void openReplayFromHistory(id)}
            onMore={() => void loadMore()}
          />
        )}
      </section>
    );
  },
);

AttemptWorkspace.displayName = 'AttemptWorkspace';
