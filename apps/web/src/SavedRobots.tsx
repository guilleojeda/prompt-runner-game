import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  draftsEqual,
  draftLimitMessage,
  validateSavedRobotName,
  type DraftSnapshot,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import { MODEL_CATALOG } from '../../../shared/models.js';
import { ROBOT_CATALOG } from '../../../shared/robot.js';
import type { AuthSession } from './auth.js';
import type { ApiAuthRequired } from './api-auth.js';
import { type RobotEditorHandle } from './RobotEditor.js';
import { SavedRobotApiFailure, type SavedRobotApi } from './saved-robot-api.js';

type NameFormMode = 'new' | null;
type SavedOperation = 'load' | 'save' | 'delete' | null;
type ErrorKind = 'list' | 'load' | 'save' | 'new' | 'delete' | null;

interface DeleteConflict {
  readonly summary: SavedRobotSummary;
}

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
    super(
      cause instanceof Error && cause.message.trim() !== ''
        ? cause.message
        : 'No se pudo comprobar la copia pendiente. Reintentá para volver a consultarla.',
      { cause },
    );
    this.name = 'PendingCreateReadbackFailure';
  }
}

class OversizedSavedDraft extends Error {
  public constructor(
    public readonly robot: SavedRobot,
    public readonly limitMessage: string,
  ) {
    super(limitMessage);
    this.name = 'OversizedSavedDraft';
  }
}

export interface SavedRobotsProps {
  api: SavedRobotApi;
  editor: RefObject<RobotEditorHandle | null>;
  session: AuthSession;
  configurationAvailable?: boolean;
  paused?: boolean;
  locked?: boolean;
  onAuthRequired?: ApiAuthRequired;
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

function isAuthError(error: unknown): error is SavedRobotApiFailure {
  return error instanceof SavedRobotApiFailure && error.code === 'authentication';
}

function isDefinitiveWriteRejection(error: SavedRobotApiFailure): boolean {
  return (
    error.code === 'authentication' ||
    error.code === 'invalid' ||
    error.code === 'limit' ||
    error.code === 'rate_limited'
  );
}

function reportedAuthError(error: unknown): SavedRobotApiFailure | null {
  const reportedError = error instanceof PendingCreateReadbackFailure ? error.cause : error;
  return isAuthError(reportedError) ? reportedError : null;
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

function mergeSummary(
  current: readonly SavedRobotSummary[],
  incoming: SavedRobotSummary,
): SavedRobotSummary[] {
  return current.some((robot) => robot.id === incoming.id)
    ? current.map((robot) => (robot.id === incoming.id ? incoming : robot))
    : [incoming, ...current];
}

function sameSavedContent(robot: SavedRobot, id: string, name: string, draft: RobotDraft): boolean {
  return robot.id === id && robot.name === name && draftsEqual(robot.draft, draft);
}

export function SavedRobots({
  api,
  editor,
  session,
  configurationAvailable = true,
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
  const [deleteConflict, setDeleteConflict] = useState<DeleteConflict | null>(null);
  const [inspection, setInspection] = useState<SavedRobot | null>(null);
  const [inspectionLoadingId, setInspectionLoadingId] = useState<string | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [inspectionNotice, setInspectionNotice] = useState<string | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const generationRef = useRef(0);
  const inspectionRequestRef = useRef(0);
  const operationTokenRef = useRef(0);
  const operationOwnerRef = useRef<number | null>(null);
  const inspectionOperationRef = useRef<number | null>(null);
  const inspectionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const inspectionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inspectionOpeningRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedNameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const isCurrent = useCallback(
    (generation: number): boolean => generationRef.current === generation,
    [],
  );

  const beginOperation = (kind: Exclude<SavedOperation, null>): number => {
    const token = operationTokenRef.current + 1;
    operationTokenRef.current = token;
    operationOwnerRef.current = token;
    setOperation(kind);
    return token;
  };

  const finishOperation = (token: number): void => {
    if (operationOwnerRef.current !== token) return;
    operationOwnerRef.current = null;
    setOperation(null);
  };

  useEffect(() => {
    if (
      inspectionOpeningRef.current &&
      (inspectionLoadingId !== null || inspectionError !== null || inspection !== null)
    ) {
      inspectionHeadingRef.current?.focus();
      inspectionOpeningRef.current = false;
    }
  }, [inspection, inspectionError, inspectionLoadingId]);

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
        if (isAuthError(loadError)) onAuthRequired?.(loadError.authContext);
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
  const selectedManagementSummary = selected
    ? (robots.find((robot) => robot.id === selected.id) ?? selectedSummary)
    : null;
  const copiesByName = new Map<string, number>();
  const copyNumbers = new Map<string, number>();
  for (const robot of robots) {
    const number = (copiesByName.get(robot.name) ?? 0) + 1;
    copiesByName.set(robot.name, number);
    copyNumbers.set(robot.id, number);
  }

  const handleLoadMore = async (): Promise<void> => {
    if (!nextCursor || busy) return;
    const operationToken = beginOperation('load');
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
      if (isAuthError(loadError)) onAuthRequired?.(loadError.authContext);
    } finally {
      if (isCurrent(generation)) finishOperation(operationToken);
    }
  };

  const clearInspection = (returnFocus: boolean): void => {
    inspectionRequestRef.current += 1;
    const inspectionOperation = inspectionOperationRef.current;
    inspectionOperationRef.current = null;
    if (inspectionOperation !== null) finishOperation(inspectionOperation);
    const trigger = inspectionTriggerRef.current;
    inspectionTriggerRef.current = null;
    inspectionOpeningRef.current = false;
    setInspection(null);
    setInspectionLoadingId(null);
    setInspectionError(null);
    setInspectionNotice(null);
    if (returnFocus && trigger) {
      if (trigger.isConnected) trigger.focus();
      queueMicrotask(() => {
        if (trigger.isConnected) trigger.focus();
      });
    }
  };

  const handleInspect = async (
    summary: SavedRobotSummary,
    trigger: HTMLButtonElement,
  ): Promise<void> => {
    if (busy) return;
    const requestId = inspectionRequestRef.current + 1;
    inspectionRequestRef.current = requestId;
    inspectionTriggerRef.current = trigger;
    inspectionOpeningRef.current = true;
    const operationToken = beginOperation('load');
    inspectionOperationRef.current = operationToken;
    setInspection(null);
    setInspectionLoadingId(summary.id);
    setInspectionError(null);
    setInspectionNotice(null);
    setError(null);
    setErrorKind(null);
    const generation = generationRef.current;
    try {
      const robot = await api.getRobot(summary.id);
      if (!isCurrent(generation) || inspectionRequestRef.current !== requestId) return;
      setInspection(robot);
    } catch (loadError) {
      if (!isCurrent(generation) || inspectionRequestRef.current !== requestId) return;
      setInspectionError(apiErrorMessage(loadError, 'No se pudo consultar esta copia.'));
      if (isAuthError(loadError)) onAuthRequired?.(loadError.authContext);
    } finally {
      if (isCurrent(generation)) {
        if (inspectionRequestRef.current === requestId) setInspectionLoadingId(null);
        if (inspectionOperationRef.current === operationToken) {
          inspectionOperationRef.current = null;
        }
        finishOperation(operationToken);
      }
    }
  };

  const handleSelect = async (
    summary: SavedRobotSummary,
    trigger: HTMLButtonElement,
  ): Promise<void> => {
    if (busy || !configurationAvailable) return;
    clearInspection(false);
    const operationToken = beginOperation('load');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    setConflict(null);
    const generation = generationRef.current;
    try {
      if (!isCurrent(generation)) return;
      const loadedRobotRef = { current: null as SavedRobot | null };
      const applied = await editor.current?.applyDraft(async () => {
        const robot = await api.getRobot(summary.id);
        if (!isCurrent(generation)) throw new StaleSavedOperation();
        loadedRobotRef.current = robot;
        const limitMessage = draftLimitMessage(robot.draft);
        if (limitMessage) throw new OversizedSavedDraft(robot, limitMessage);
        return loadedRobotRef.current.draft;
      });
      if (!isCurrent(generation)) return;
      if (!applied) {
        setError('No se pudo cargar la copia. Revisá el estado del editor y volvé a intentarlo.');
        setErrorKind('load');
        return;
      }
      const robot = loadedRobotRef.current;
      if (!robot) {
        setError('No se pudo cargar el robot guardado.');
        setErrorKind('load');
        return;
      }
      setSelected(robot);
      setName(robot.name);
      setMessage(`Cargaste «${robot.name}».`);
    } catch (loadError) {
      if (!isCurrent(generation)) return;
      if (loadError instanceof OversizedSavedDraft) {
        inspectionTriggerRef.current = trigger;
        inspectionOpeningRef.current = true;
        setInspection(loadError.robot);
        setInspectionNotice(
          `Esta copia supera los límites actuales para cargarla al editor: ${loadError.limitMessage} Podés consultar su contenido completo aquí; no se aplicó al editor.`,
        );
        setError(null);
        setErrorKind(null);
        return;
      }
      setError(apiErrorMessage(loadError, 'No se pudo cargar el robot guardado.'));
      setErrorKind('load');
      if (isAuthError(loadError)) onAuthRequired?.(loadError.authContext);
      if (isMissingError(loadError)) {
        setRobots((current) => current.filter((robot) => robot.id !== summary.id));
        if (selected?.id === summary.id) {
          setSelected(null);
          setName('');
        }
      }
    } finally {
      if (isCurrent(generation)) finishOperation(operationToken);
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
      if (
        saveError instanceof SavedRobotApiFailure &&
        saveError.code === 'conflict' &&
        saveError.current &&
        sameSavedContent(saveError.current, id, desiredName, desiredDraft)
      ) {
        if (!isCurrent(generation)) throw new StaleSavedOperation();
        return saveError.current;
      }
      if (
        !(saveError instanceof SavedRobotApiFailure) ||
        !saveError.ambiguous ||
        isDefinitiveWriteRejection(saveError)
      ) {
        throw saveError;
      }
      if (!isCurrent(generation)) throw new StaleSavedOperation();
      try {
        const remote = await api.getRobot(id);
        if (!isCurrent(generation)) throw new StaleSavedOperation();
        if (isCurrent(generation) && sameSavedContent(remote, id, desiredName, desiredDraft)) {
          return remote;
        }
      } catch (readError) {
        if (readError instanceof StaleSavedOperation) throw readError;
        if (isAuthError(readError)) {
          if (expectedVersion === 0) {
            throw new PendingCreateReadbackFailure(readError);
          }
          throw readError;
        }
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
      if (!isMissingError(readError)) {
        throw new PendingCreateReadbackFailure(readError);
      }
      if (!isCurrent(generation)) throw new StaleSavedOperation();
      return reconcileSave(intent.id, 0, intent.name, intent.draft, generation);
    }
  };

  const updateListWith = (robot: SavedRobot): void => {
    updateListWithSummary(summaryFromRobot(robot));
  };

  const updateListWithSummary = (summary: SavedRobotSummary): void => {
    setRobots((current) => mergeSummary(current, summary));
  };

  const removeListedRobot = (id: string): void => {
    setRobots((items) => items.filter((item) => item.id !== id));
    if (pendingCreateRef.current?.id === id) {
      pendingCreateRef.current = null;
      setPendingCreate(null);
      setNewName('');
    }
    if (selected?.id === id) {
      setSelected(null);
      setName('');
    }
    if (inspection?.id === id || inspectionLoadingId === id) clearInspection(false);
    setDeleteConflict((current) => (current?.summary.id === id ? null : current));
    setConflict((current) => (current?.id === id ? null : current));
  };

  const saveSelected = async (
    desiredName: string,
    draft: RobotDraft,
    operationToken: number,
  ): Promise<void> => {
    const current = selected;
    if (!current) return;
    const generation = generationRef.current;
    if (!isCurrent(generation)) return;
    setError(null);
    setErrorKind(null);
    setMessage(null);
    setDeleteConflict(null);
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
      setNameMode(null);
      setMessage(`Guardaste «${saved.name}».`);
    } catch (saveError) {
      if (!isCurrent(generation)) return;
      if (saveError instanceof SavedRobotApiFailure && saveError.code === 'conflict') {
        setConflict(saveError.current ?? null);
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
      if (isAuthError(saveError)) onAuthRequired?.(saveError.authContext);
    } finally {
      if (isCurrent(generation)) finishOperation(operationToken);
    }
  };

  const handleSaveAsNew = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    let intent = pendingCreateRef.current;
    const retryingPendingCreate = intent !== null;
    if (!configurationAvailable && !retryingPendingCreate) return;
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
    const operationToken = beginOperation('save');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    setDeleteConflict(null);
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
      setMessage(`Guardaste «${saved.name}» como robot nuevo.`);
    } catch (saveError) {
      if (!isCurrent(generation)) return;
      const preservePending =
        saveError instanceof PendingCreateReadbackFailure ||
        (retryingPendingCreate &&
          intent !== null &&
          saveError instanceof SavedRobotApiFailure &&
          isDefinitiveWriteRejection(saveError)) ||
        (saveError instanceof SavedRobotApiFailure &&
          saveError.ambiguous &&
          !isDefinitiveWriteRejection(saveError));
      if (!preservePending) {
        pendingCreateRef.current = null;
        setPendingCreate(null);
      }
      setError(apiErrorMessage(saveError, 'No se pudo guardar el robot nuevo.'));
      setErrorKind('new');
      if (saveError instanceof SavedRobotApiFailure && saveError.code === 'conflict') {
        setConflict(saveError.current ?? null);
      }
      const authError = reportedAuthError(saveError);
      if (authError) onAuthRequired?.(authError.authContext);
    } finally {
      if (isCurrent(generation)) finishOperation(operationToken);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!selected) return;
    const generation = generationRef.current;
    const operationToken = beginOperation('save');
    setError(null);
    let desiredName: string;
    try {
      desiredName = validateSavedRobotName(name);
    } catch (validationError) {
      setError(apiErrorMessage(validationError, 'Ingresá un nombre válido para el robot.'));
      setErrorKind('save');
      finishOperation(operationToken);
      return;
    }
    let snapshot: DraftSnapshot | null;
    try {
      snapshot = (await editor.current?.captureSnapshot()) ?? null;
    } catch (captureError) {
      setError(apiErrorMessage(captureError, 'No se pudo capturar la configuración actual.'));
      setErrorKind('save');
      finishOperation(operationToken);
      return;
    }
    if (!snapshot) {
      setError(
        'No se pudo capturar la configuración actual. Reintentá cuando termine el guardado.',
      );
      setErrorKind('save');
      finishOperation(operationToken);
      return;
    }
    if (!isCurrent(generation)) {
      finishOperation(operationToken);
      return;
    }
    if (selected.name === desiredName && draftsEqual(selected.draft, snapshot.draft)) {
      setMessage('No hay cambios para guardar en este robot.');
      finishOperation(operationToken);
      return;
    }
    await saveSelected(desiredName, snapshot.draft, operationToken);
  };

  const handleDelete = async (target: SavedRobotSummary): Promise<void> => {
    if (busy) return;
    if (!window.confirm(`¿Eliminar «${target.name}»? Esta acción no se puede deshacer.`)) return;
    const generation = generationRef.current;
    const operationToken = beginOperation('delete');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    try {
      if (!isCurrent(generation)) return;
      await api.deleteRobot(target.id, target.version);
      if (!isCurrent(generation)) return;
      removeListedRobot(target.id);
      setMessage(
        `Eliminaste «${target.name}». Tu configuración actual y tus intentos siguen intactos.`,
      );
    } catch (deleteError) {
      if (!isCurrent(generation)) return;
      if (deleteError instanceof SavedRobotApiFailure && deleteError.ambiguous) {
        if (!isCurrent(generation)) return;
        try {
          await api.getRobot(target.id);
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
            onAuthRequired?.(readError.authContext);
            return;
          }
          if (isMissingError(readError)) {
            removeListedRobot(target.id);
            setMessage(`Eliminaste «${target.name}».`);
          } else {
            setError(apiErrorMessage(deleteError, 'No se pudo confirmar la eliminación.'));
            setErrorKind('delete');
          }
        }
      } else {
        if (
          deleteError instanceof SavedRobotApiFailure &&
          deleteError.code === 'conflict' &&
          (deleteError.currentSummary || deleteError.current)
        ) {
          const robot = deleteError.current;
          const summary = deleteError.currentSummary ?? (robot ? summaryFromRobot(robot) : null);
          if (summary) setDeleteConflict({ summary });
          setError(null);
          setErrorKind(null);
        } else {
          setError(apiErrorMessage(deleteError, 'No se pudo eliminar el robot guardado.'));
          setErrorKind('delete');
          if (isMissingError(deleteError)) {
            removeListedRobot(target.id);
          }
        }
      }
      if (isAuthError(deleteError)) onAuthRequired?.(deleteError.authContext);
    } finally {
      if (isCurrent(generation)) finishOperation(operationToken);
    }
  };

  const handleUseDeleteConflict = (): void => {
    if (!deleteConflict || busy) return;
    const { summary } = deleteConflict;
    updateListWithSummary(summary);
    setDeleteConflict(null);
    setMessage(
      `La copia «${summary.name}» cambió. Confirmá «Eliminar» nuevamente para borrarla. Tu configuración actual sigue intacta.`,
    );
  };

  const handleUseConflict = async (): Promise<void> => {
    if (!conflict || busy) return;
    const generation = generationRef.current;
    const operationToken = beginOperation('load');
    setError(null);
    setErrorKind(null);
    try {
      if (!isCurrent(generation)) return;
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
      setMessage(`Cargaste la versión remota de «${conflict.name}».`);
    } catch (loadError) {
      if (isCurrent(generation)) {
        setError(apiErrorMessage(loadError, 'No se pudo cargar la versión remota.'));
        setErrorKind('load');
      }
    } finally {
      if (isCurrent(generation)) finishOperation(operationToken);
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
  const canSaveAsNew = configurationAvailable || pendingCreate !== null;
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
          errorKind === 'delete' ||
          ((errorKind === 'save' || errorKind === 'new') &&
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
            {robots.map((robot) => {
              const duplicate = (copiesByName.get(robot.name) ?? 0) > 1;
              const copyLabel = `${robot.name}${duplicate ? ` Copia ${copyNumbers.get(robot.id)}` : ''}`;
              const hasDeleteConflict = deleteConflict?.summary.id === robot.id;
              return (
                <li key={robot.id}>
                  <div className="saved-robot-row">
                    <button
                      className={`saved-robot-item${selected?.id === robot.id ? ' is-selected' : ''}`}
                      type="button"
                      onClick={(event) => void handleSelect(robot, event.currentTarget)}
                      disabled={busy || !configurationAvailable}
                      aria-pressed={selected?.id === robot.id}
                    >
                      <span className="saved-robot-item-main">
                        <strong>{robot.name}</strong>
                        {duplicate && <span>Copia {copyNumbers.get(robot.id)}</span>}
                        <span>
                          {modelLabel(robot.modelKey)}, actualizado {formatDate(robot.updatedAt)}
                        </span>
                      </span>
                      <span className="saved-robot-item-date">
                        Creado {formatDate(robot.createdAt)}
                      </span>
                      <span className="saved-robot-item-load">Cargar</span>
                    </button>
                    <div className="saved-robot-row-actions">
                      <button
                        className="text-button"
                        type="button"
                        onClick={(event) => void handleInspect(robot, event.currentTarget)}
                        disabled={busy}
                        aria-label={`Ver configuración de ${copyLabel}`}
                      >
                        Ver configuración
                      </button>
                      <button
                        className="text-button danger-button"
                        type="button"
                        onClick={() => void handleDelete(robot)}
                        disabled={busy}
                        aria-label={`Eliminar ${copyLabel}`}
                      >
                        Eliminar
                      </button>
                    </div>
                    {hasDeleteConflict && (
                      <div className="saved-robots-conflict" role="alert">
                        <p>
                          La copia «{deleteConflict.summary.name}» cambió en otra pestaña. Actualizá
                          su versión y confirmá «Eliminar» nuevamente; tu configuración actual sigue
                          intacta.
                        </p>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={handleUseDeleteConflict}
                          disabled={busy}
                        >
                          Actualizar versión para Eliminar
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
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

      {(inspectionLoadingId || inspectionError || inspection) && (
        <section className="saved-robot-inspection" aria-labelledby="saved-robot-inspection-title">
          <div className="saved-robot-inspection-heading">
            <h3 id="saved-robot-inspection-title" ref={inspectionHeadingRef} tabIndex={-1}>
              {inspection ? `Configuración de ${inspection.name}` : 'Consultar configuración'}
            </h3>
            <button className="text-button" type="button" onClick={() => clearInspection(true)}>
              Cerrar
            </button>
          </div>
          {inspectionLoadingId && <p role="status">Consultando la copia…</p>}
          {inspectionError && <p role="alert">{inspectionError}</p>}
          {inspection && (
            <>
              {inspectionNotice && (
                <p className="saved-robot-inspection-notice" role="status">
                  {inspectionNotice}
                </p>
              )}
              <dl className="saved-robot-inspection-facts">
                <div>
                  <dt>Modelo</dt>
                  <dd>{modelLabel(inspection.modelKey)}</dd>
                </div>
                <div>
                  <dt>Actualizado</dt>
                  <dd>{formatDate(inspection.updatedAt)}</dd>
                </div>
              </dl>
              <div className="configuration-preview-copy">
                <h4>Instrucciones</h4>
                <p>{inspection.draft.instructions}</p>
                <h4>Habilidades</h4>
                <ul>
                  {inspection.draft.skills.map((skill) => {
                    const hasDescription = Object.prototype.hasOwnProperty.call(
                      skill,
                      'description',
                    );
                    const description = hasDescription
                      ? skill.description === ''
                        ? '(descripción vacía)'
                        : skill.description
                      : '(sin descripción)';
                    return (
                      <li key={skill.id}>
                        <strong>
                          {ROBOT_CATALOG.find((entry) => entry.id === skill.id)?.name ??
                            'Habilidad'}
                        </strong>
                        : {skill.enabled ? 'habilitada' : 'deshabilitada'}; descripción:{' '}
                        <span className="configuration-preview-literal">{description}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>
          )}
        </section>
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
            disabled={paused || locked || listBusy || operation !== null || !canSaveAsNew}
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
          {error && errorKind === 'save' && (
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
              onClick={() => void handleDelete(selectedManagementSummary!)}
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
            disabled={
              paused ||
              locked ||
              operation !== null ||
              pendingCreate !== null ||
              !configurationAvailable
            }
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
              disabled={paused || locked || operation !== null || !canSaveAsNew}
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
            Hay una versión más nueva de «{conflict.name}» guardada en otra pestaña. «Guardar» está
            bloqueado hasta que cargues esa versión o guardes el borrador visible como una copia
            nueva.
          </p>
          <div className="editor-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void handleUseConflict()}
              disabled={busy}
            >
              Cargar versión remota
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
