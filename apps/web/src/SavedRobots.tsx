import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  draftsEqual,
  validateSavedRobotName,
  type DraftSnapshot,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import { MODEL_CATALOG } from '../../../shared/models.js';
import type { AuthSession } from './auth.js';
import { type RobotEditorHandle } from './RobotEditor.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

type NameFormMode = 'new' | null;
type SavedOperation = 'load' | 'save' | 'delete' | null;
type ErrorKind = 'list' | 'load' | 'save' | 'new' | 'delete' | null;
type ConflictKind = 'save' | 'delete' | null;

interface PendingCreate {
  readonly id: string;
  readonly name: string;
  readonly draft: RobotDraft;
}

class StaleSavedOperation extends Error {
  public constructor() {
    super('La sesión cambió mientras se procesaba la operación.');
    this.name = 'StaleSavedOperation';
  }
}

class PendingCreateReadbackFailure extends Error {
  public constructor(cause: unknown) {
    super('No se pudo comprobar la copia pendiente. Reintentá para volver a consultarla.', {
      cause,
    });
    this.name = 'PendingCreateReadbackFailure';
  }
}

export interface SavedRobotsProps {
  api: SavedRobotApi;
  editor: RefObject<RobotEditorHandle | null>;
  session: AuthSession;
  paused?: boolean;
  locked?: boolean;
  onAuthRequired?: () => void;
}

function modelLabel(modelKey: string): string {
  return MODEL_CATALOG.find((model) => model.key === modelKey)?.label ?? modelKey;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
}

function newRobotId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof SavedRobotApiFailure) return error.message;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return fallback;
}

function isAuthError(error: unknown): boolean {
  return error instanceof SavedRobotApiFailure && error.code === 'authentication';
}

function isMissingError(error: unknown): boolean {
  return error instanceof SavedRobotApiFailure && error.code === 'not_found';
}

function summaryFromRobot(robot: SavedRobot): SavedRobotSummary {
  return {
    id: robot.id,
    name: robot.name,
    version: robot.version,
    createdAt: robot.createdAt,
    updatedAt: robot.updatedAt,
    modelKey: robot.modelKey,
  };
}

function mergeSummaries(
  current: readonly SavedRobotSummary[],
  incoming: readonly SavedRobotSummary[],
): SavedRobotSummary[] {
  const byId = new Map(current.map((robot) => [robot.id, robot]));
  incoming.forEach((robot) => byId.set(robot.id, robot));
  return [...byId.values()];
}

function sameSavedContent(robot: SavedRobot, id: string, name: string, draft: RobotDraft): boolean {
  return robot.id === id && robot.name === name && draftsEqual(robot.draft, draft);
}

export function SavedRobots({
  api,
  editor,
  session,
  paused = false,
  locked = false,
  onAuthRequired,
}: SavedRobotsProps) {
  const [robots, setRobots] = useState<SavedRobotSummary[]>([]);
  const [selected, setSelected] = useState<SavedRobot | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [listBusy, setListBusy] = useState(true);
  const [operation, setOperation] = useState<SavedOperation>(null);
  const [nameMode, setNameMode] = useState<NameFormMode>(null);
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind>(null);
  const [conflict, setConflict] = useState<SavedRobot | null>(null);
  const [conflictKind, setConflictKind] = useState<ConflictKind>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const generationRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedNameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const isCurrent = useCallback(
    (generation: number): boolean => generationRef.current === generation,
    [],
  );

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    void api
      .listRobots(undefined, controller.signal)
      .then((page) => {
        if (!isCurrent(generation) || controller.signal.aborted) return;
        setRobots([...page.robots]);
        setNextCursor(page.nextCursor);
        setListBusy(false);
      })
      .catch((loadError: unknown) => {
        if (!isCurrent(generation) || controller.signal.aborted) return;
        setListBusy(false);
        setError(apiErrorMessage(loadError, 'No se pudieron cargar tus robots guardados.'));
        setErrorKind('list');
        if (isAuthError(loadError)) onAuthRequired?.();
      });
    return () => {
      generationRef.current += 1;
      controller.abort();
    };
  }, [api, isCurrent, listAttempt, onAuthRequired, session.identity.sub]);

  useEffect(() => {
    if (!nameMode) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [nameMode]);

  const busy = paused || locked || listBusy || operation !== null;
  const selectedSummary = selected ? summaryFromRobot(selected) : null;
  const copiesByName = new Map<string, number>();
  const copyNumbers = new Map<string, number>();
  for (const robot of robots) {
    const number = (copiesByName.get(robot.name) ?? 0) + 1;
    copiesByName.set(robot.name, number);
    copyNumbers.set(robot.id, number);
  }

  const handleLoadMore = async (): Promise<void> => {
    if (!nextCursor || busy) return;
    setOperation('load');
    setError(null);
    setErrorKind(null);
    const generation = generationRef.current;
    try {
      if (!isCurrent(generation)) return;
      const page = await api.listRobots(nextCursor);
      if (!isCurrent(generation)) return;
      setRobots((current) => mergeSummaries(current, page.robots));
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (!isCurrent(generation)) return;
      setError(apiErrorMessage(loadError, 'No se pudieron cargar más robots.'));
      setErrorKind('list');
      if (isAuthError(loadError)) onAuthRequired?.();
    } finally {
      if (isCurrent(generation)) setOperation(null);
    }
  };

  const handleSelect = async (summary: SavedRobotSummary): Promise<void> => {
    if (busy) return;
    setOperation('load');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    setConflict(null);
    setConflictKind(null);
    const generation = generationRef.current;
    try {
      if (!isCurrent(generation)) return;
      const robot = await api.getRobot(summary.id);
      if (!isCurrent(generation)) return;
      const applied = await editor.current?.applyDraft(robot.draft);
      if (!isCurrent(generation)) return;
      if (!applied) {
        setError(
          'No se pudo cargar el robot porque hay cambios pendientes o un conflicto abierto.',
        );
        setErrorKind('load');
        return;
      }
      setSelected(robot);
      setName(robot.name);
      setMessage(`Cargaste «${robot.name}».`);
    } catch (loadError) {
      if (!isCurrent(generation)) return;
      setError(apiErrorMessage(loadError, 'No se pudo cargar el robot guardado.'));
      setErrorKind('load');
      if (isAuthError(loadError)) onAuthRequired?.();
      if (isMissingError(loadError)) {
        setRobots((current) => current.filter((robot) => robot.id !== summary.id));
        if (selected?.id === summary.id) setSelected(null);
      }
    } finally {
      if (isCurrent(generation)) setOperation(null);
    }
  };

  const reconcileSave = async (
    id: string,
    expectedVersion: number,
    desiredName: string,
    desiredDraft: RobotDraft,
    generation: number,
  ): Promise<SavedRobot> => {
    if (!isCurrent(generation)) throw new StaleSavedOperation();
    try {
      const saved = await api.saveRobot(id, expectedVersion, desiredName, desiredDraft);
      if (!isCurrent(generation)) throw new StaleSavedOperation();
      return saved;
    } catch (saveError) {
      if (!(saveError instanceof SavedRobotApiFailure) || !saveError.ambiguous) throw saveError;
      if (!isCurrent(generation)) throw new StaleSavedOperation();
      try {
        const remote = await api.getRobot(id);
        if (!isCurrent(generation)) throw new StaleSavedOperation();
        if (isCurrent(generation) && sameSavedContent(remote, id, desiredName, desiredDraft)) {
          return remote;
        }
      } catch (readError) {
        if (readError instanceof StaleSavedOperation) throw readError;
        if (isAuthError(readError)) throw readError;
        if (isMissingError(readError)) throw saveError;
      }
      throw saveError;
    }
  };

  const reconcilePendingCreate = async (
    intent: PendingCreate,
    generation: number,
  ): Promise<SavedRobot> => {
    if (!isCurrent(generation)) throw new StaleSavedOperation();
    try {
      const remote = await api.getRobot(intent.id);
      if (!isCurrent(generation)) throw new StaleSavedOperation();
      if (sameSavedContent(remote, intent.id, intent.name, intent.draft)) return remote;
      throw new SavedRobotApiFailure(
        'conflict',
        'La copia pendiente ya existe con otro contenido.',
        409,
        remote,
      );
    } catch (readError) {
      if (readError instanceof StaleSavedOperation) throw readError;
      if (readError instanceof SavedRobotApiFailure && readError.code === 'conflict') {
        throw readError;
      }
      if (isAuthError(readError)) throw readError;
      if (!isMissingError(readError)) {
        throw new PendingCreateReadbackFailure(readError);
      }
      if (!isCurrent(generation)) throw new StaleSavedOperation();
      return reconcileSave(intent.id, 0, intent.name, intent.draft, generation);
    }
  };

  const updateListWith = (robot: SavedRobot): void => {
    const summary = summaryFromRobot(robot);
    setRobots((current) => {
      const found = current.some((candidate) => candidate.id === robot.id);
      return found
        ? current.map((candidate) => (candidate.id === robot.id ? summary : candidate))
        : [summary, ...current];
    });
  };

  const saveSelected = async (desiredName: string, draft: RobotDraft): Promise<void> => {
    const current = selected;
    if (!current) return;
    const generation = generationRef.current;
    if (!isCurrent(generation)) return;
    setOperation('save');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    try {
      const saved = await reconcileSave(
        current.id,
        current.version,
        desiredName,
        draft,
        generation,
      );
      if (!isCurrent(generation)) return;
      setSelected(saved);
      setName(saved.name);
      updateListWith(saved);
      setConflict(null);
      setConflictKind(null);
      setNameMode(null);
      setMessage(`Guardaste «${saved.name}».`);
    } catch (saveError) {
      if (!isCurrent(generation)) return;
      if (saveError instanceof SavedRobotApiFailure && saveError.code === 'conflict') {
        setConflict(saveError.current ?? null);
        setConflictKind('save');
        setError(
          saveError.current
            ? 'El robot guardado cambió en otra pestaña. Cargá la versión remota o usá «Guardar como nueva» para conservar el borrador visible. «Guardar» está bloqueado hasta resolver el conflicto.'
            : saveError.message,
        );
        setErrorKind('save');
      } else {
        setError(apiErrorMessage(saveError, 'No se pudo guardar el robot guardado.'));
        setErrorKind('save');
        if (isMissingError(saveError)) {
          setSelected(null);
          setName('');
          setRobots((currentItems) => currentItems.filter((item) => item.id !== current.id));
        }
      }
      if (isAuthError(saveError)) onAuthRequired?.();
    } finally {
      if (isCurrent(generation)) setOperation(null);
    }
  };

  const handleSaveAsNew = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    let intent = pendingCreateRef.current;
    const retryingPendingCreate = intent !== null;
    let createId = intent?.id;
    let createName = intent?.name;
    if (!intent) {
      try {
        createName = validateSavedRobotName(newName);
      } catch (validationError) {
        setError(apiErrorMessage(validationError, 'Ingresá un nombre válido para el robot.'));
        setErrorKind('new');
        return;
      }
      createId = newRobotId();
    } else {
      setNewName(intent.name);
    }
    const generation = generationRef.current;
    setOperation('save');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    try {
      if (!pendingCreateRef.current) {
        const snapshot: DraftSnapshot | null = (await editor.current?.captureSnapshot()) ?? null;
        if (!snapshot) {
          setError(
            'No se pudo capturar la configuración actual. Terminá o reintentá el guardado pendiente.',
          );
          setErrorKind('new');
          return;
        }
        if (!isCurrent(generation)) return;
        intent = { id: createId!, name: createName!, draft: snapshot.draft };
        pendingCreateRef.current = intent;
        setPendingCreate(intent);
      }
      if (!isCurrent(generation)) return;
      const saved = retryingPendingCreate
        ? await reconcilePendingCreate(intent!, generation)
        : await reconcileSave(intent!.id, 0, intent!.name, intent!.draft, generation);
      if (!isCurrent(generation)) return;
      pendingCreateRef.current = null;
      setPendingCreate(null);
      setSelected(saved);
      setName(saved.name);
      setNewName('');
      setNameMode(null);
      updateListWith(saved);
      setConflict(null);
      setConflictKind(null);
      setMessage(`Guardaste «${saved.name}» como robot nuevo.`);
    } catch (saveError) {
      if (!isCurrent(generation)) return;
      const preservePending =
        saveError instanceof PendingCreateReadbackFailure ||
        (saveError instanceof SavedRobotApiFailure && saveError.ambiguous);
      if (!preservePending) {
        pendingCreateRef.current = null;
        setPendingCreate(null);
      }
      setError(apiErrorMessage(saveError, 'No se pudo guardar el robot nuevo.'));
      setErrorKind('new');
      if (saveError instanceof SavedRobotApiFailure && saveError.code === 'conflict') {
        setConflict(saveError.current ?? null);
        setConflictKind('save');
      }
      if (isAuthError(saveError)) onAuthRequired?.();
    } finally {
      if (isCurrent(generation)) setOperation(null);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!selected) return;
    const generation = generationRef.current;
    setOperation('save');
    setError(null);
    let desiredName: string;
    try {
      desiredName = validateSavedRobotName(name);
    } catch (validationError) {
      setError(apiErrorMessage(validationError, 'Ingresá un nombre válido para el robot.'));
      setErrorKind('save');
      setOperation(null);
      return;
    }
    let snapshot: DraftSnapshot | null;
    try {
      snapshot = (await editor.current?.captureSnapshot()) ?? null;
    } catch (captureError) {
      setError(apiErrorMessage(captureError, 'No se pudo capturar la configuración actual.'));
      setErrorKind('save');
      setOperation(null);
      return;
    }
    if (!snapshot) {
      setError(
        'No se pudo capturar la configuración actual. Reintentá cuando termine el guardado.',
      );
      setErrorKind('save');
      setOperation(null);
      return;
    }
    if (!isCurrent(generation)) return;
    if (selected.name === desiredName && draftsEqual(selected.draft, snapshot.draft)) {
      setMessage('No hay cambios para guardar en este robot.');
      setOperation(null);
      return;
    }
    await saveSelected(desiredName, snapshot.draft);
  };

  const handleDelete = async (): Promise<void> => {
    const current = selected;
    if (!current || busy) return;
    if (!window.confirm(`¿Eliminar «${current.name}»? Esta acción no se puede deshacer.`)) return;
    const generation = generationRef.current;
    setOperation('delete');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    try {
      if (!isCurrent(generation)) return;
      await api.deleteRobot(current.id, current.version);
      if (!isCurrent(generation)) return;
      setSelected(null);
      setName('');
      setRobots((items) => items.filter((item) => item.id !== current.id));
      setMessage(
        `Eliminaste «${current.name}». Tu configuración actual y tus intentos siguen intactos.`,
      );
    } catch (deleteError) {
      if (!isCurrent(generation)) return;
      if (deleteError instanceof SavedRobotApiFailure && deleteError.ambiguous) {
        if (!isCurrent(generation)) return;
        try {
          await api.getRobot(current.id);
          if (!isCurrent(generation)) return;
          setError('No se pudo confirmar la eliminación. Revisá la lista y reintentá.');
          setErrorKind('delete');
        } catch (readError) {
          if (!isCurrent(generation)) return;
          if (isAuthError(readError)) {
            setError(
              apiErrorMessage(readError, 'Tu sesión ya no tiene acceso a los robots guardados.'),
            );
            setErrorKind('delete');
            onAuthRequired?.();
            return;
          }
          if (isMissingError(readError)) {
            setSelected(null);
            setName('');
            setRobots((items) => items.filter((item) => item.id !== current.id));
            setMessage(`Eliminaste «${current.name}».`);
          } else {
            setError(apiErrorMessage(deleteError, 'No se pudo confirmar la eliminación.'));
            setErrorKind('delete');
          }
        }
      } else {
        if (
          deleteError instanceof SavedRobotApiFailure &&
          deleteError.code === 'conflict' &&
          deleteError.current
        ) {
          setConflict(deleteError.current ?? null);
          setConflictKind('delete');
          setError(null);
          setErrorKind(null);
        } else {
          setConflict(null);
          setConflictKind(null);
          setError(apiErrorMessage(deleteError, 'No se pudo eliminar el robot guardado.'));
          setErrorKind('delete');
          if (isMissingError(deleteError)) {
            setSelected(null);
            setName('');
            setRobots((items) => items.filter((item) => item.id !== current.id));
          }
        }
      }
      if (isAuthError(deleteError)) onAuthRequired?.();
    } finally {
      if (isCurrent(generation)) setOperation(null);
    }
  };

  const handleUseConflict = async (): Promise<void> => {
    if (!conflict || busy) return;
    const generation = generationRef.current;
    const conflictResolutionKind = conflictKind;
    setOperation('load');
    setError(null);
    setErrorKind(null);
    try {
      if (!isCurrent(generation)) return;
      if (conflictResolutionKind === 'delete') {
        setSelected(conflict);
        setName(conflict.name);
        updateListWith(conflict);
        setConflict(null);
        setConflictKind(null);
        setMessage(
          `La copia «${conflict.name}» cambió. Confirmá «Eliminar» nuevamente para borrarla. Tu configuración actual sigue intacta.`,
        );
        return;
      }
      const applied = await editor.current?.applyDraft(conflict.draft);
      if (!isCurrent(generation)) return;
      if (!applied) {
        setError('No se pudo cargar la versión remota porque hay cambios pendientes.');
        setErrorKind('load');
        return;
      }
      setSelected(conflict);
      setName(conflict.name);
      updateListWith(conflict);
      setConflict(null);
      setConflictKind(null);
      setMessage(`Cargaste la versión remota de «${conflict.name}».`);
    } catch (loadError) {
      if (isCurrent(generation)) {
        setError(apiErrorMessage(loadError, 'No se pudo cargar la versión remota.'));
        setErrorKind('load');
      }
    } finally {
      if (isCurrent(generation)) setOperation(null);
    }
  };

  const canEdit =
    !paused &&
    !locked &&
    !listBusy &&
    operation === null &&
    selected !== null &&
    nameMode === null &&
    conflict === null;
  return (
    <section className="saved-robots" aria-labelledby="saved-robots-title" aria-busy={busy}>
      <div className="saved-robots-heading">
        <div>
          <p className="card-kicker">Copias guardadas</p>
          <h2 id="saved-robots-title">Tus robots</h2>
          <p className="saved-robots-intro">
            Guardá configuraciones con nombre para volver a cargarlas cuando quieras. Editar la
            configuración actual no cambia una copia hasta que pulses «Guardar».
          </p>
        </div>
        {listBusy && <span className="spinner" aria-label="Cargando robots guardados" />}
      </div>

      {paused && (
        <p className="editor-paused" role="status">
          Verificando tu sesión… Tus robots guardados siguen protegidos.
        </p>
      )}
      {error &&
        (errorKind === 'list' ||
          errorKind === 'load' ||
          ((errorKind === 'save' || errorKind === 'delete' || errorKind === 'new') &&
            selected === null &&
            nameMode !== 'new')) && (
          <div className="saved-robots-error" role="alert" aria-live="assertive">
            <p>{error}</p>
            {errorKind === 'list' && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setListBusy(true);
                  setError(null);
                  setErrorKind(null);
                  setMessage(null);
                  setListAttempt((attempt) => attempt + 1);
                }}
                disabled={busy}
              >
                Reintentar lista
              </button>
            )}
          </div>
        )}
      {message && (
        <p className="saved-robots-message" role="status" aria-live="polite">
          {message}
        </p>
      )}

      {!listBusy && robots.length === 0 && !error && (
        <p className="saved-robots-empty">Todavía no guardaste ninguna copia.</p>
      )}
      {robots.length > 0 && (
        <div className="saved-robots-list-wrap">
          <ul className="saved-robots-list" aria-label="Robots guardados">
            {robots.map((robot) => (
              <li key={robot.id}>
                <button
                  className={`saved-robot-item${selected?.id === robot.id ? ' is-selected' : ''}`}
                  type="button"
                  onClick={() => void handleSelect(robot)}
                  disabled={busy}
                  aria-pressed={selected?.id === robot.id}
                >
                  <span className="saved-robot-item-main">
                    <strong>{robot.name}</strong>
                    {(copiesByName.get(robot.name) ?? 0) > 1 && (
                      <span>Copia {copyNumbers.get(robot.id)}</span>
                    )}
                    <span>
                      {modelLabel(robot.modelKey)}, actualizado {formatDate(robot.updatedAt)}
                    </span>
                  </span>
                  <span className="saved-robot-item-date">
                    Creado {formatDate(robot.createdAt)}
                  </span>
                  <span className="saved-robot-item-load">Cargar</span>
                </button>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <button
              className="text-button"
              type="button"
              onClick={() => void handleLoadMore()}
              disabled={busy}
            >
              {operation === 'load' ? 'Cargando…' : 'Cargar más'}
            </button>
          )}
        </div>
      )}

      {nameMode !== 'new' && (
        <div className="saved-robots-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              setNameMode('new');
              setNewName(pendingCreate?.name ?? '');
              setError(null);
              setErrorKind(null);
              setMessage(null);
            }}
            disabled={paused || locked || listBusy || operation !== null}
          >
            Guardar como nueva
          </button>
        </div>
      )}

      {selected && (
        <form
          className="saved-robots-selected-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <label htmlFor="saved-robot-selected-name">Nombre de esta copia</label>
          <input
            ref={selectedNameInputRef}
            id="saved-robot-selected-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            disabled={!canEdit}
          />
          {error && (errorKind === 'save' || errorKind === 'delete') && (
            <p className="saved-robots-control-error" role="alert" aria-live="assertive">
              {error}
            </p>
          )}
          <div className="saved-robots-actions">
            <button className="secondary-button" type="submit" disabled={!canEdit}>
              Guardar
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                selectedNameInputRef.current?.focus();
                selectedNameInputRef.current?.select();
              }}
              disabled={!canEdit}
            >
              Renombrar
            </button>
            <button
              className="text-button danger-button"
              type="button"
              onClick={() => void handleDelete()}
              disabled={!canEdit}
            >
              Eliminar
            </button>
          </div>
        </form>
      )}

      {nameMode === 'new' && (
        <form className="saved-robots-name-form" onSubmit={(event) => void handleSaveAsNew(event)}>
          <label htmlFor="saved-robot-name">Nombre para la nueva copia</label>
          <input
            ref={inputRef}
            id="saved-robot-name"
            type="text"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            required
            disabled={paused || locked || operation !== null || pendingCreate !== null}
          />
          {error && errorKind === 'new' && (
            <p className="saved-robots-control-error" role="alert" aria-live="assertive">
              {error}
            </p>
          )}
          {pendingCreate && (
            <p className="saved-robots-pending" role="status">
              No se confirmó la respuesta. Reintentá esta acción para consultar la misma copia sin
              crear otra.
            </p>
          )}
          <div className="editor-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={paused || locked || operation !== null}
            >
              Guardar como nueva
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => setNameMode(null)}
              disabled={operation !== null}
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {conflict && (
        <div className="saved-robots-conflict" role="alert">
          <p>
            {conflictKind === 'delete'
              ? `La copia «${conflict.name}» cambió en otra pestaña. Actualizá su versión y confirmá «Eliminar» nuevamente; tu configuración actual sigue intacta.`
              : `Hay una versión más nueva de «${conflict.name}» guardada en otra pestaña. «Guardar» está bloqueado hasta que cargues esa versión o guardes el borrador visible como una copia nueva.`}
          </p>
          <div className="editor-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void handleUseConflict()}
              disabled={busy}
            >
              {conflictKind === 'delete'
                ? 'Actualizar versión para Eliminar'
                : 'Cargar versión remota'}
            </button>
          </div>
        </div>
      )}

      {selected && selectedSummary && (
        <p className="saved-robots-selected" role="status">
          Seleccionado: <strong>{selectedSummary.name}</strong>
        </p>
      )}
    </section>
  );
}
