import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MutableRefObject,
} from 'react';
import {
  MAX_DRAFT_BYTES,
  ROBOT_CATALOG,
  draftByteLength,
  draftsEqual,
  type DraftSnapshot,
  type RobotDraft,
  type RobotSkillId,
} from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import { DraftApiFailure, type DraftApi } from './draft-api.js';

type EditorStatus = 'loading' | 'clean' | 'dirty' | 'saving' | 'conflict' | 'error';
type RetryMode = 'save' | 'reconcile' | null;

export interface RobotEditorHandle {
  hasUnconfirmedChanges(): boolean;
  discardPending(): void;
  flushPending(): Promise<boolean>;
  captureSnapshot(): Promise<DraftSnapshot | null>;
  releaseAttemptLock(): void;
}

export interface RobotEditorProps {
  api: DraftApi;
  session: AuthSession;
  paused?: boolean;
  locked?: boolean;
  onTry?: () => void;
  onAuthRequired?: () => void;
}

interface InFlightSave {
  generation: number;
  promise: Promise<boolean>;
  operation: object;
}

interface ReconciliationTarget {
  generation: number;
  expectedVersion: number;
  draft: RobotDraft;
}

interface SaveOptions {
  readonly draft?: RobotDraft;
  readonly force?: boolean;
}

function cloneDraft(draft: RobotDraft): RobotDraft {
  return {
    schemaVersion: draft.schemaVersion,
    catalogVersion: draft.catalogVersion,
    instructions: draft.instructions,
    skills: draft.skills.map((skill) =>
      Object.prototype.hasOwnProperty.call(skill, 'description')
        ? { id: skill.id, enabled: skill.enabled, description: skill.description }
        : { id: skill.id, enabled: skill.enabled },
    ),
  };
}

function formatByteCount(bytes: number): string {
  return `${bytes.toLocaleString('es-AR')} / ${MAX_DRAFT_BYTES.toLocaleString('es-AR')} bytes UTF-8`;
}

function statusLabel(status: EditorStatus): string {
  switch (status) {
    case 'loading':
      return 'Cargando configuración…';
    case 'dirty':
      return 'Cambios pendientes';
    case 'saving':
      return 'Guardando…';
    case 'clean':
      return 'Guardado';
    case 'conflict':
      return 'Conflicto de edición';
    case 'error':
      return 'No se pudo confirmar el guardado';
  }
}

function isCurrent(
  generationRef: MutableRefObject<number>,
  generation: number,
  session: AuthSession,
): boolean {
  return generationRef.current === generation && session.identity.sub.length > 0;
}

export const RobotEditor = forwardRef<RobotEditorHandle, RobotEditorProps>(function RobotEditor(
  { api, session, paused = false, locked = false, onTry, onAuthRequired },
  ref,
) {
  const [draft, setDraft] = useState<RobotDraft | null>(null);
  const [status, setStatus] = useState<EditorStatus>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DraftSnapshot | null>(null);
  const [retryMode, setRetryMode] = useState<RetryMode>(null);
  const [attemptClickLocked, setAttemptClickLocked] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const generationRef = useRef(0);
  const draftRef = useRef<RobotDraft | null>(null);
  const confirmedRef = useRef<DraftSnapshot | null>(null);
  const inFlightRef = useRef<InFlightSave | null>(null);
  const reconciliationRef = useRef<ReconciliationTarget | null>(null);
  const pausedRef = useRef(paused);
  const lockedRef = useRef(locked);
  const sessionRef = useRef(session);
  const onAuthRequiredRef = useRef(onAuthRequired);
  const sendSaveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const setLoadedSnapshotRef = useRef<(snapshot: DraftSnapshot) => void>(() => undefined);

  pausedRef.current = paused;
  lockedRef.current = locked;
  sessionRef.current = session;
  onAuthRequiredRef.current = onAuthRequired;

  const updateDraft = (next: RobotDraft): void => {
    if (pausedRef.current || lockedRef.current) {
      return;
    }
    const copy = cloneDraft(next);
    draftRef.current = copy;
    setDraft(copy);
    const isConflict = conflict !== null;
    const hasPendingOperation = inFlightRef.current !== null || reconciliationRef.current !== null;
    if (isConflict) {
      setStatus('conflict');
      setMessage('Otra pestaña guardó una versión distinta. Elegí cómo resolver el conflicto.');
    } else if (hasPendingOperation) {
      setStatus(inFlightRef.current ? 'saving' : 'error');
      setMessage(
        inFlightRef.current
          ? 'Guardando… Este cambio quedará pendiente.'
          : 'No se pudo comprobar el guardado. Podés reintentar.',
      );
      if (!inFlightRef.current && retryMode !== 'save') {
        setRetryMode('reconcile');
      }
    } else if (confirmedRef.current && draftsEqual(copy, confirmedRef.current.draft)) {
      setStatus('clean');
      setMessage(null);
    } else {
      setStatus('dirty');
      setMessage(null);
    }
    if (!isConflict) {
      setConflict(null);
    }
    if (!hasPendingOperation) {
      setRetryMode(null);
    }
  };

  const setLoadedSnapshot = (snapshot: DraftSnapshot): void => {
    const copy = cloneDraft(snapshot.draft);
    confirmedRef.current = { ...snapshot, draft: copy };
    draftRef.current = copy;
    reconciliationRef.current = null;
    setDraft(copy);
    setConflict(null);
    setRetryMode(null);
    setMessage(null);
    setStatus('clean');
  };

  setLoadedSnapshotRef.current = setLoadedSnapshot;

  const reconcile = (target: ReconciliationTarget): Promise<boolean> => {
    const existing = inFlightRef.current;
    if (existing) {
      return existing.promise;
    }
    if (!isCurrent(generationRef, target.generation, sessionRef.current)) {
      return Promise.resolve(false);
    }
    reconciliationRef.current = target;
    setStatus('saving');
    setMessage('Comprobando si el último guardado llegó al servidor…');
    const operation = {};
    const promise = (async (): Promise<boolean> => {
      try {
        const remote = await Promise.resolve().then(() => api.getDraft());
        if (!isCurrent(generationRef, target.generation, sessionRef.current)) {
          return false;
        }
        if (draftsEqual(remote.draft, target.draft)) {
          if (inFlightRef.current?.operation === operation) {
            inFlightRef.current = null;
          }
          confirmedRef.current = remote;
          const current = draftRef.current;
          if (current && draftsEqual(current, remote.draft)) {
            setStatus('clean');
            setMessage(null);
          } else {
            setStatus('dirty');
            setMessage('El último guardado llegó. También hay cambios posteriores pendientes.');
          }
          reconciliationRef.current = null;
          setRetryMode(null);
          return true;
        }
        if (remote.version <= target.expectedVersion) {
          if (inFlightRef.current?.operation === operation) {
            inFlightRef.current = null;
          }
          setStatus('error');
          setMessage('No se confirmó el guardado. Podés reintentar con la misma versión.');
          reconciliationRef.current = target;
          setRetryMode('save');
          return false;
        }
        if (inFlightRef.current?.operation === operation) {
          inFlightRef.current = null;
        }
        setConflict(remote);
        setStatus('conflict');
        setMessage('Otra pestaña guardó una versión distinta. Elegí cómo resolver el conflicto.');
        reconciliationRef.current = null;
        setRetryMode(null);
        return false;
      } catch (error) {
        if (!isCurrent(generationRef, target.generation, sessionRef.current)) {
          return false;
        }
        if (inFlightRef.current?.operation === operation) {
          inFlightRef.current = null;
        }
        if (error instanceof DraftApiFailure && error.code === 'authentication') {
          setStatus('error');
          setMessage(error.message);
          onAuthRequiredRef.current?.();
        } else {
          setStatus('error');
          setMessage('No se pudo comprobar el guardado. Podés reintentar.');
        }
        reconciliationRef.current = target;
        setRetryMode('reconcile');
        return false;
      } finally {
        if (inFlightRef.current?.operation === operation) {
          inFlightRef.current = null;
        }
      }
    })();
    inFlightRef.current = { generation: target.generation, promise, operation };
    return promise;
  };

  const sendSave = (options: SaveOptions = {}): Promise<boolean> => {
    const existing = inFlightRef.current;
    if (existing) {
      return existing.promise;
    }
    const current = options.draft ?? draftRef.current;
    const currentConfirmed = confirmedRef.current;
    const generation = generationRef.current;
    if (
      !current ||
      !currentConfirmed ||
      pausedRef.current ||
      (draftsEqual(current, currentConfirmed.draft) &&
        !(reconciliationRef.current !== null && retryMode === 'save') &&
        !options.force)
    ) {
      return Promise.resolve(true);
    }
    if (draftByteLength(current) > MAX_DRAFT_BYTES) {
      setStatus('error');
      setMessage(
        `La configuración supera el límite de ${MAX_DRAFT_BYTES.toLocaleString('es-AR')} bytes UTF-8.`,
      );
      setRetryMode(null);
      return Promise.resolve(false);
    }

    const sentDraft = cloneDraft(current);
    const expectedVersion = currentConfirmed.version;
    const operation = {};
    setStatus('saving');
    setMessage(null);
    const promise = (async (): Promise<boolean> => {
      try {
        const saved = await api.putDraft(expectedVersion, sentDraft);
        if (!isCurrent(generationRef, generation, sessionRef.current)) {
          return false;
        }
        if (inFlightRef.current?.generation === generation) {
          inFlightRef.current = null;
        }
        reconciliationRef.current = null;
        confirmedRef.current = saved;
        const latest = draftRef.current;
        if (latest && draftsEqual(latest, saved.draft)) {
          setStatus('clean');
          setMessage(null);
        } else {
          setStatus('dirty');
          setMessage('Guardado. Hay cambios posteriores pendientes.');
        }
        setRetryMode(null);
        return true;
      } catch (error) {
        if (!isCurrent(generationRef, generation, sessionRef.current)) {
          return false;
        }
        if (inFlightRef.current?.generation === generation) {
          inFlightRef.current = null;
        }
        if (error instanceof DraftApiFailure && error.code === 'conflict') {
          if (error.current) {
            reconciliationRef.current = null;
            setConflict(error.current);
            setStatus('conflict');
            setMessage(
              'Otra pestaña guardó una versión distinta. Elegí cómo resolver el conflicto.',
            );
            setRetryMode(null);
          } else {
            await reconcile({ generation, expectedVersion, draft: sentDraft });
          }
          return false;
        }
        if (error instanceof DraftApiFailure && error.code === 'authentication') {
          setStatus('error');
          setMessage(error.message);
          setRetryMode('save');
          onAuthRequiredRef.current?.();
          return false;
        }
        if (error instanceof DraftApiFailure && error.ambiguous) {
          reconciliationRef.current = { generation, expectedVersion, draft: sentDraft };
          setRetryMode('reconcile');
          return reconcile(reconciliationRef.current);
        }
        setStatus('error');
        setMessage(
          error instanceof DraftApiFailure ? error.message : 'No se pudo guardar la configuración.',
        );
        setRetryMode('save');
        return false;
      }
    })();
    inFlightRef.current = { generation, promise, operation };
    return promise;
  };

  sendSaveRef.current = sendSave;

  const flushPending = async (): Promise<boolean> => {
    if (pausedRef.current) {
      return false;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const inFlight = inFlightRef.current;
      if (inFlight) {
        if (!(await inFlight.promise)) {
          return false;
        }
      } else {
        const reconciliation = reconciliationRef.current;
        if (reconciliation && retryMode === 'reconcile') {
          if (!(await reconcile(reconciliation))) {
            return false;
          }
          continue;
        }
        const current = draftRef.current;
        const currentConfirmed = confirmedRef.current;
        if (
          !current ||
          !currentConfirmed ||
          (draftsEqual(current, currentConfirmed.draft) &&
            !(reconciliation !== null && retryMode === 'save'))
        ) {
          return true;
        }
        if (!(await sendSave())) {
          return false;
        }
      }
      const current = draftRef.current;
      const currentConfirmed = confirmedRef.current;
      if (current && currentConfirmed && draftsEqual(current, currentConfirmed.draft)) {
        return true;
      }
    }
    return false;
  };

  const captureSnapshot = async (): Promise<DraftSnapshot | null> => {
    const visible = draftRef.current;
    const confirmed = confirmedRef.current;
    if (!visible || !confirmed || pausedRef.current || conflict !== null) {
      return null;
    }
    const frozen = cloneDraft(visible);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const inFlight = inFlightRef.current;
      if (inFlight && !(await inFlight.promise)) {
        return null;
      }
      const reconciliation = reconciliationRef.current;
      if (reconciliation && retryMode === 'reconcile') {
        if (!(await reconcile(reconciliation))) {
          return null;
        }
        continue;
      }
      const current = draftRef.current;
      const currentConfirmed = confirmedRef.current;
      if (!current || !currentConfirmed || !draftsEqual(current, frozen)) {
        return null;
      }
      if (draftsEqual(frozen, currentConfirmed.draft) && currentConfirmed.version > 0) {
        return { ...currentConfirmed, draft: cloneDraft(frozen) };
      }
      const saved = await sendSave({ draft: frozen, force: true });
      if (!saved) {
        return null;
      }
      const afterSave = confirmedRef.current;
      if (afterSave && draftsEqual(afterSave.draft, frozen)) {
        return { ...afterSave, draft: cloneDraft(frozen) };
      }
    }
    return null;
  };

  const retry = (): void => {
    const target = reconciliationRef.current;
    if (target && retryMode === 'reconcile') {
      void reconcile(target);
      return;
    }
    if (!confirmedRef.current && retryMode === 'reconcile') {
      setLoadAttempt((attempt) => attempt + 1);
      return;
    }
    void sendSave();
  };

  useImperativeHandle(ref, () => ({
    hasUnconfirmedChanges: () => {
      const current = draftRef.current;
      const saved = confirmedRef.current;
      return Boolean(
        current &&
        saved &&
        (inFlightRef.current !== null ||
          reconciliationRef.current !== null ||
          !draftsEqual(current, saved.draft)),
      );
    },
    discardPending: () => {
      const replacement = conflict ?? confirmedRef.current;
      if (replacement) {
        setLoadedSnapshot(replacement);
      }
    },
    flushPending,
    captureSnapshot,
    releaseAttemptLock: () => setAttemptClickLocked(false),
  }));

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    inFlightRef.current = null;
    reconciliationRef.current = null;
    draftRef.current = null;
    confirmedRef.current = null;
    setDraft(null);
    setConflict(null);
    setRetryMode(null);
    setMessage(null);
    setStatus('loading');
    void api
      .getDraft(controller.signal)
      .then((snapshot) => {
        if (
          controller.signal.aborted ||
          !isCurrent(generationRef, generation, sessionRef.current)
        ) {
          return;
        }
        setLoadedSnapshotRef.current(snapshot);
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          !isCurrent(generationRef, generation, sessionRef.current)
        ) {
          return;
        }
        setStatus('error');
        setRetryMode('reconcile');
        setMessage(
          error instanceof DraftApiFailure ? error.message : 'No se pudo cargar la configuración.',
        );
        if (error instanceof DraftApiFailure && error.code === 'authentication') {
          onAuthRequiredRef.current?.();
        }
      });
    return () => {
      generationRef.current += 1;
      controller.abort();
    };
  }, [api, loadAttempt, session.identity.sub]);

  useEffect(() => {
    if (paused || status !== 'dirty' || conflict || inFlightRef.current) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void sendSaveRef.current();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [conflict, draft, paused, status]);

  useEffect(() => {
    const saved = confirmedRef.current;
    const hasPending =
      draft !== null &&
      saved !== null &&
      (inFlightRef.current !== null ||
        reconciliationRef.current !== null ||
        !draftsEqual(draft, saved.draft)) &&
      status !== 'loading' &&
      status !== 'clean';
    if (!hasPending) {
      return undefined;
    }
    const warnBeforeUnload = (event: BeforeUnloadEvent): string => {
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [conflict, draft, status]);

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

  const submitRetry = (event: FormEvent): void => {
    event.preventDefault();
    retry();
  };

  const disabled = paused || locked || attemptClickLocked || status === 'loading';
  const byteCount = draft ? draftByteLength(draft) : 0;

  return (
    <section
      className="robot-editor"
      aria-labelledby="robot-editor-title"
      aria-busy={paused || locked || attemptClickLocked || status === 'loading'}
    >
      <div className="editor-heading">
        <div>
          <p className="card-kicker">Configuración persistida</p>
          <h2 id="robot-editor-title">Prepará tu robot</h2>
          <p className="editor-intro">
            Elegí sus habilidades y escribí las instrucciones que recibirá. Los cambios se guardan
            automáticamente. Al probarlo, se fija exactamente lo que estás viendo.
          </p>
        </div>
        <span className={`save-state save-state-${status}`} role="status" aria-live="polite">
          {statusLabel(status)}
        </span>
      </div>

      {paused && (
        <p className="editor-paused" role="status">
          Verificando tu sesión… Conservamos tus cambios en esta pestaña.
        </p>
      )}
      {locked && !paused && (
        <p className="editor-paused" role="status">
          Conservamos esta configuración mientras comprobamos el estado o ejecutamos el intento.
        </p>
      )}
      {message && status !== 'clean' && (
        <p className="editor-message" role={status === 'error' ? 'alert' : 'status'}>
          {message}
        </p>
      )}

      {status === 'loading' && (
        <p className="editor-loading">Recuperando tu configuración guardada…</p>
      )}

      {draft && (
        <form className="editor-form" onSubmit={submitRetry}>
          <fieldset disabled={disabled}>
            <legend>Instrucciones generales</legend>
            <label htmlFor="robot-instructions">Qué debe tener en cuenta el robot</label>
            <textarea
              id="robot-instructions"
              value={draft.instructions}
              onChange={onInstructionsChange}
              rows={5}
            />
          </fieldset>

          <fieldset disabled={disabled}>
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
                          onChange={(event) => onSkillEnabledChange(entry.id, event.target.checked)}
                        />
                        <span>{entry.name}</span>
                      </label>
                      <span className="skill-help">{entry.description}</span>
                    </div>
                    <label htmlFor={`skill-description-${entry.id}`}>
                      Descripción para el agente
                    </label>
                    <textarea
                      id={`skill-description-${entry.id}`}
                      value={skill.description ?? ''}
                      onChange={(event) => onSkillDescriptionChange(entry.id, event.target.value)}
                      rows={3}
                    />
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

          <div className={`byte-count${byteCount > MAX_DRAFT_BYTES ? ' byte-count-over' : ''}`}>
            {formatByteCount(byteCount)}
          </div>

          {(status === 'error' || status === 'conflict') && (
            <div className="editor-actions">
              {retryMode && (
                <button className="secondary-button" type="submit" disabled={disabled}>
                  Reintentar guardado
                </button>
              )}
            </div>
          )}
          {onTry && (
            <div className="editor-actions attempt-action">
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  setAttemptClickLocked(true);
                  onTry();
                }}
                disabled={disabled || status === 'conflict'}
              >
                Probar
              </button>
              <span className="field-help">
                Cada prueba admitida consume un intento de tu cuota diaria, aunque la canceles o
                termine con un error.
              </span>
            </div>
          )}
        </form>
      )}

      {status === 'error' && !draft && (
        <div className="editor-actions">
          <button className="secondary-button" type="button" onClick={retry}>
            Reintentar carga
          </button>
        </div>
      )}

      {conflict && (
        <section className="conflict-card" aria-labelledby="conflict-title">
          <h3 id="conflict-title">Hay una versión guardada en otra pestaña</h3>
          <p>
            Revisá la versión actual y elegí si querés conservarla o volver a guardar tus cambios
            sobre ella.
          </p>
          <div className="conflict-preview">
            <strong>Instrucciones guardadas</strong>
            <p>{conflict.draft.instructions}</p>
            <strong>Habilidades guardadas</strong>
            <ul>
              {conflict.draft.skills.map((skill) => (
                <li key={skill.id}>
                  {ROBOT_CATALOG.find((entry) => entry.id === skill.id)?.name ?? 'Habilidad'}:{' '}
                  {skill.enabled ? 'habilitada' : 'deshabilitada'} —{' '}
                  <span className="conflict-literal">
                    {Object.prototype.hasOwnProperty.call(skill, 'description')
                      ? skill.description
                      : '(sin descripción)'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="editor-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setLoadedSnapshot(conflict)}
              disabled={paused}
            >
              Usar la versión guardada
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                confirmedRef.current = conflict;
                setConflict(null);
                setStatus('dirty');
                setMessage(null);
                setRetryMode('save');
              }}
              disabled={paused}
            >
              Guardar mis cambios
            </button>
          </div>
        </section>
      )}
    </section>
  );
});

RobotEditor.displayName = 'RobotEditor';
