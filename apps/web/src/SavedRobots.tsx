import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
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
import {
  classifySavedRobotReadFailure,
  SavedRobotApiFailure,
  type SavedRobotApi,
} from './saved-robot-api.js';
import { useReadRecovery, type ReadResource } from './useReadRecovery.js';

type NameFormMode = 'new' | null;
type SavedOperation = 'save' | 'delete' | null;
type ConsultStatus = 'idle' | 'loading' | 'recovering' | 'ready' | 'error';
type CopyWriteKind = 'rename' | 'replace';
type LibraryDialog =
  | { readonly kind: 'use'; readonly target: SavedRobot }
  | { readonly kind: 'rename'; readonly target: SavedRobot; readonly name: string }
  | { readonly kind: 'replace'; readonly target: SavedRobot };

interface SavedApplication {
  readonly id: number;
  readonly label: string;
  readonly copyId: string;
  readonly identitySub: string;
  readonly controller: AbortController;
}

interface DeleteConflict {
  readonly summary: SavedRobotSummary;
}

interface CreateIntent {
  readonly id: string;
  readonly name: string;
  readonly identitySub: string;
  readonly selectedIdAtStart: string | null;
  readonly owner: number;
  readonly operationToken: number | null;
  readonly draft: RobotDraft | null;
  readonly sent: boolean;
  readonly retryAuthorized: boolean;
}

interface PendingCreate extends CreateIntent {
  readonly draft: RobotDraft;
  readonly sent: true;
  readonly inFlight: boolean;
}

type CreateReadback =
  | { readonly kind: 'match'; readonly saved: SavedRobot }
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflict'; readonly saved: SavedRobot }
  | { readonly kind: 'foreign'; readonly saved: SavedRobot };

interface PendingCopyWrite {
  readonly kind: CopyWriteKind;
  readonly target: SavedRobot;
  readonly identitySub: string;
  readonly name: string;
  readonly draft: RobotDraft;
  readonly retryAuthorized: boolean;
}

interface SavedListReadResource extends ReadResource {
  readonly cursor: string | undefined;
}

interface SavedCopyReadResource extends ReadResource {
  readonly summary: SavedRobotSummary;
}

interface SavedListFailure {
  readonly error: unknown;
  readonly cursor: string | undefined;
}

interface PendingPaginationFocus {
  readonly identity: string;
  readonly trigger: HTMLButtonElement;
  readonly targetId: string | null;
}

interface PendingCreateFocusHandoff {
  readonly identity: string;
  readonly owner: number;
  readonly trigger: HTMLButtonElement;
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

class ForeignCreateReadbackFailure extends Error {
  public constructor() {
    super('La comprobación devolvió otra copia. El guardado sigue pendiente.');
    this.name = 'ForeignCreateReadbackFailure';
  }
}

class CreateReadbackPaused extends Error {
  public constructor() {
    super('La comprobación queda pausada hasta que vuelva el acceso.');
    this.name = 'CreateReadbackPaused';
  }
}

export interface SavedRobotsProps {
  api: SavedRobotApi;
  editor: RefObject<RobotEditorHandle | null>;
  session: AuthSession;
  active?: boolean;
  configurationAvailable?: boolean;
  paused?: boolean;
  accessState?: 'ready' | 'checking' | 'required';
  locked?: boolean;
  onAuthRequired?: ApiAuthRequired;
  onReturnToEditor?: () => void;
}

export interface SavedRobotsHandle {
  leaveSurface(): void;
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
  incoming.forEach((robot) => {
    const existing = byId.get(robot.id);
    if (!existing || robot.version >= existing.version) byId.set(robot.id, robot);
  });
  return [...byId.values()];
}

function mergeSummary(
  current: readonly SavedRobotSummary[],
  incoming: SavedRobotSummary,
): SavedRobotSummary[] {
  const existing = current.find((robot) => robot.id === incoming.id);
  if (existing && existing.version > incoming.version) return [...current];
  return existing
    ? current.map((robot) => (robot.id === incoming.id ? incoming : robot))
    : [incoming, ...current];
}

function sameSavedContent(robot: SavedRobot, id: string, name: string, draft: RobotDraft): boolean {
  return robot.id === id && robot.name === name && draftsEqual(robot.draft, draft);
}

function sameSavedBase(robot: SavedRobot, target: SavedRobot): boolean {
  return (
    robot.id === target.id &&
    robot.version === target.version &&
    robot.name === target.name &&
    draftsEqual(robot.draft, target.draft)
  );
}

function copyDraft(draft: RobotDraft): RobotDraft {
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

export const SavedRobots = forwardRef<SavedRobotsHandle, SavedRobotsProps>(function SavedRobots(
  {
    api,
    editor,
    session,
    active = true,
    configurationAvailable = true,
    paused = false,
    accessState = 'checking',
    locked = false,
    onAuthRequired,
    onReturnToEditor,
  },
  ref,
) {
  const [robots, setRobots] = useState<SavedRobotSummary[]>([]);
  const [selectedSummary, setSelectedSummary] = useState<SavedRobotSummary | null>(null);
  const [selected, setSelected] = useState<SavedRobot | null>(null);
  const [consultStatus, setConsultStatus] = useState<ConsultStatus>('idle');
  const [consultError, setConsultError] = useState<string | null>(null);
  const [consultRecoveryMessage, setConsultRecoveryMessage] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [listBusy, setListBusy] = useState(true);
  const [listPageLoading, setListPageLoading] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  const [listFailure, setListFailure] = useState<SavedListFailure | null>(null);
  const [listRecoveryMessage, setListRecoveryMessage] = useState<string | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [operation, setOperation] = useState<SavedOperation>(null);
  const [nameMode, setNameMode] = useState<NameFormMode>(null);
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'save' | 'new' | 'delete' | null>(null);
  const [deleteConflict, setDeleteConflict] = useState<DeleteConflict | null>(null);
  const [application, setApplication] = useState<SavedApplication | null>(null);
  const [dialog, setDialog] = useState<LibraryDialog | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingCreateError, setPendingCreateError] = useState<string | null>(null);
  const [pendingCopyWrite, setPendingCopyWrite] = useState<PendingCopyWrite | null>(null);
  const generationRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const consultStatusRef = useRef<ConsultStatus>('idle');
  const selectedSummaryRef = useRef<SavedRobotSummary | null>(selectedSummary);
  selectedSummaryRef.current = selectedSummary;
  const selectedDocumentRef = useRef<SavedRobot | null>(selected);
  selectedDocumentRef.current = selected;
  const robotsRef = useRef(robots);
  robotsRef.current = robots;
  const listResourceRef = useRef<SavedListReadResource | null>(null);
  const selectedResourceRef = useRef<SavedCopyReadResource | null>(null);
  const listLoadedRef = useRef(false);
  const needsSelectedReadRef = useRef(false);
  const applicationIdRef = useRef(0);
  const applicationRef = useRef<SavedApplication | null>(null);
  const operationTokenRef = useRef(0);
  const operationOwnerRef = useRef<number | null>(null);
  const createOwnerIdRef = useRef(0);
  const createIntentRef = useRef<CreateIntent | null>(null);
  const pendingCreateRef = useRef<PendingCreate | null>(null);
  const pendingCopyWriteRef = useRef<PendingCopyWrite | null>(null);
  const pendingPaginationFocusRef = useRef<PendingPaginationFocus | null>(null);
  const pendingCreateFocusHandoffRef = useRef<PendingCreateFocusHandoff | null>(null);
  const identitySubRef = useRef(session.identity.sub);
  const unavailableRef = useRef(paused || locked);
  const activeSurfaceRef = useRef(active);
  const mountedRef = useRef(true);
  const previousIdentityRef = useRef(session.identity.sub);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const detailsSummaryRef = useRef<HTMLElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const newNameInputRef = useRef<HTMLInputElement | null>(null);
  const newCopyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const createDebtCheckRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const loadMoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const hadNewNameModeRef = useRef(false);
  const createFocusReturnRef = useRef<'new' | 'check' | null>(null);

  const setConsult = (status: ConsultStatus): void => {
    consultStatusRef.current = status;
    setConsultStatus(status);
  };

  const readersActive = active && operation === null;
  const managementBusy = operation !== null || listPageLoading;

  const listRecovery = useReadRecovery<
    SavedListReadResource,
    Awaited<ReturnType<SavedRobotApi['listRobots']>>
  >({
    active: readersActive,
    authPaused: paused,
    identity: session.identity.sub,
    surface: 'mis-robots',
    onAuthRequired,
    read: (resource, signal) => api.listRobots(resource.cursor, signal),
    classifyFailure: classifySavedRobotReadFailure,
    onStart: (resource) => {
      if (listResourceRef.current !== resource) return;
      setListRecoveryMessage(null);
      setListFailure(null);
      if (resource.cursor === undefined) setListBusy(true);
      else setListPageLoading(true);
    },
    onValue: (page, resource) => {
      if (
        listResourceRef.current !== resource ||
        identitySubRef.current !== resource.identity ||
        (resource.cursor !== undefined && nextCursor !== resource.cursor)
      ) {
        return true;
      }
      if (resource.cursor !== undefined && page.nextCursor === undefined) {
        const trigger = loadMoreButtonRef.current;
        if (trigger && document.activeElement === trigger) {
          const firstAdded = page.robots.find(
            (candidate) => !robotsRef.current.some((robot) => robot.id === candidate.id),
          );
          pendingPaginationFocusRef.current = {
            identity: resource.identity,
            trigger,
            targetId: firstAdded?.id ?? robotsRef.current[0]?.id ?? null,
          };
        }
      }
      if (resource.cursor === undefined) {
        setRobots([...page.robots]);
        setNextCursor(page.nextCursor);
      } else {
        setRobots((current) => mergeSummaries(current, page.robots));
        setNextCursor(page.nextCursor);
      }
      listLoadedRef.current = true;
      setListLoaded(true);
      return true;
    },
    onComplete: (resource) => {
      if (listResourceRef.current !== resource) return;
      listResourceRef.current = null;
      setListBusy(false);
      setListPageLoading(false);
      setListFailure(null);
      setListRecoveryMessage(null);
    },
    onRecovering: (resource, _error, reason) => {
      if (listResourceRef.current !== resource) return;
      setListBusy(false);
      setListPageLoading(false);
      setListFailure(null);
      setListRecoveryMessage(
        reason === 'authentication' && paused
          ? null
          : 'Volveremos a consultar tus robots guardados.',
      );
    },
    onPaused: (resource) => {
      if (listResourceRef.current !== resource) return;
      setListBusy(false);
      setListPageLoading(false);
      setListRecoveryMessage(
        paused ? null : 'La consulta se retomará cuando vuelvas a Mis robots.',
      );
    },
    onError: (resource, error) => {
      if (listResourceRef.current !== resource) return;
      setListBusy(false);
      setListPageLoading(false);
      setListRecoveryMessage(null);
      setListFailure({ error, cursor: resource.cursor });
    },
  });

  const selectedCopyRecovery = useReadRecovery<SavedCopyReadResource, SavedRobot>({
    active: readersActive,
    authPaused: paused,
    identity: session.identity.sub,
    surface: 'mis-robots',
    onAuthRequired,
    read: async (resource, signal) => {
      const robot = await api.getRobot(resource.targetId, signal);
      if (robot.id !== resource.targetId) {
        throw new SavedRobotApiFailure(
          'server',
          'La copia recibida no coincide con la seleccionada.',
          200,
        );
      }
      return robot;
    },
    classifyFailure: classifySavedRobotReadFailure,
    onStart: (resource) => {
      if (selectedResourceRef.current !== resource || selectedIdRef.current !== resource.targetId) {
        return;
      }
      setConsult('loading');
      setConsultError(null);
      setConsultRecoveryMessage(null);
    },
    onValue: (robot, resource) => {
      if (
        selectedResourceRef.current !== resource ||
        selectedIdRef.current !== resource.targetId ||
        identitySubRef.current !== resource.identity
      ) {
        return true;
      }
      const currentDocument = selectedDocumentRef.current;
      if (currentDocument?.id === resource.targetId && currentDocument.version > robot.version) {
        setConsultError(null);
        setConsultRecoveryMessage(null);
        setConsult('ready');
        return true;
      }
      const freshestSummary = [
        selectedSummaryRef.current?.id === resource.targetId ? selectedSummaryRef.current : null,
        robotsRef.current.find((item) => item.id === resource.targetId) ?? null,
      ].reduce<SavedRobotSummary | null>(
        (freshest, candidate) =>
          candidate && (!freshest || candidate.version > freshest.version) ? candidate : freshest,
        null,
      );
      if (freshestSummary && freshestSummary.version > robot.version) {
        selectedSummaryRef.current = freshestSummary;
        setSelectedSummary(freshestSummary);
        setSelected((current) =>
          current?.id === resource.targetId && current.version > robot.version ? current : null,
        );
        setConsultError(
          'La copia cambió mientras la consultabas. Seleccionala de nuevo para actualizarla.',
        );
        setConsultRecoveryMessage(null);
        setConsult('error');
        return true;
      }
      const refreshedSummary = summaryFromRobot(robot);
      selectedSummaryRef.current = refreshedSummary;
      setSelectedSummary(refreshedSummary);
      setSelected(robot);
      setConsultError(null);
      setConsultRecoveryMessage(null);
      setConsult('ready');
      setRobots((current) => mergeSummary(current, refreshedSummary));
      return true;
    },
    onComplete: (resource) => {
      if (selectedResourceRef.current === resource) selectedResourceRef.current = null;
    },
    onRecovering: (resource, error, reason) => {
      if (selectedResourceRef.current !== resource) return;
      setConsultError(null);
      setConsult('recovering');
      setConsultRecoveryMessage(
        reason === 'authentication' && !paused
          ? apiErrorMessage(error, 'Volvé a ingresar para consultar esta copia.')
          : paused
            ? null
            : 'Volveremos a consultar esta copia.',
      );
    },
    onPaused: (resource) => {
      if (selectedResourceRef.current !== resource) return;
      setConsultError(null);
      setConsult('recovering');
      setConsultRecoveryMessage('La consulta se retomará cuando vuelva a estar disponible.');
    },
    onError: (resource, error) => {
      if (selectedResourceRef.current !== resource) return;
      setConsultError(apiErrorMessage(error, 'No se pudo consultar esta copia.'));
      setConsultRecoveryMessage(null);
      setConsult('error');
      setSelected(null);
      if (isMissingError(error)) {
        setRobots((current) => current.filter((item) => item.id !== resource.targetId));
        setLibraryNotice(
          `La copia «${resource.summary.name}» ya no está disponible y se quitó de la lista.`,
        );
        selectedIdRef.current = null;
        selectedSummaryRef.current = null;
        setSelectedSummary(null);
        setConsult('idle');
        setConsultError(null);
        selectedDocumentRef.current = null;
        selectedResourceRef.current = null;
        needsSelectedReadRef.current = false;
      }
    },
  });

  const isCurrent = useCallback(
    (generation: number): boolean => generationRef.current === generation,
    [],
  );

  const createIdentityIsCurrent = (intent: CreateIntent, generation: number): boolean =>
    mountedRef.current && identitySubRef.current === intent.identitySub && isCurrent(generation);

  const isActiveCreateIntent = (intent: CreateIntent, generation: number): boolean => {
    const current = createIntentRef.current;
    return (
      current?.owner === intent.owner &&
      current.retryAuthorized &&
      current.selectedIdAtStart === selectedIdRef.current &&
      activeSurfaceRef.current &&
      !unavailableRef.current &&
      createIdentityIsCurrent(intent, generation)
    );
  };

  const isCurrentCreateDebt = (intent: CreateIntent, generation: number): boolean =>
    pendingCreateRef.current?.owner === intent.owner && createIdentityIsCurrent(intent, generation);

  const clearCreateDebt = (intent: PendingCreate, generation: number): void => {
    if (!isCurrentCreateDebt(intent, generation)) return;
    const trigger = createDebtCheckRef.current;
    if (
      trigger &&
      trigger.isConnected &&
      document.activeElement === trigger &&
      activeSurfaceRef.current &&
      !unavailableRef.current &&
      identitySubRef.current === intent.identitySub
    ) {
      pendingCreateFocusHandoffRef.current = {
        identity: intent.identitySub,
        owner: intent.owner,
        trigger,
      };
    }
    pendingCreateRef.current = null;
    setPendingCreate(null);
    setPendingCreateError(null);
    if (!newNameInputRef.current?.isConnected) setNewName('');
  };

  const cancelApplication = useCallback((): void => {
    const current = applicationRef.current;
    if (!current) return;
    applicationRef.current = null;
    applicationIdRef.current += 1;
    current.controller.abort();
    setApplication(null);
  }, []);

  const deactivatePendingCopyWrite = useCallback((): void => {
    const pending = pendingCopyWriteRef.current;
    if (!pending?.retryAuthorized) return;
    const inactive = { ...pending, retryAuthorized: false };
    pendingCopyWriteRef.current = inactive;
    setPendingCopyWrite(inactive);
  }, []);

  const closeDialog = useCallback(
    (restoreFocus = true): void => {
      if (dialogRef.current?.open) {
        if (typeof dialogRef.current.close === 'function') dialogRef.current.close();
        else dialogRef.current.removeAttribute('open');
      }
      setDialog(null);
      deactivatePendingCopyWrite();
      const trigger = dialogTriggerRef.current;
      const triggerIsInActions =
        trigger !== null && detailsSummaryRef.current?.closest('details')?.contains(trigger);
      dialogTriggerRef.current = null;
      if (!restoreFocus) return;
      queueMicrotask(() => {
        if (triggerIsInActions && detailsSummaryRef.current?.isConnected) {
          detailsSummaryRef.current.focus();
        } else if (trigger?.isConnected) {
          trigger.focus();
        }
      });
    },
    [deactivatePendingCopyWrite],
  );

  const beginApplication = (label: string, copyId: string): SavedApplication => {
    cancelApplication();
    const intent = {
      id: applicationIdRef.current + 1,
      label,
      copyId,
      identitySub: session.identity.sub,
      controller: new AbortController(),
    };
    applicationIdRef.current = intent.id;
    applicationRef.current = intent;
    setApplication(intent);
    return intent;
  };

  const isCurrentApplication = (intent: SavedApplication, generation: number): boolean =>
    applicationRef.current?.id === intent.id &&
    selectedIdRef.current === intent.copyId &&
    !intent.controller.signal.aborted &&
    !unavailableRef.current &&
    identitySubRef.current === intent.identitySub &&
    isCurrent(generation);

  const finishApplication = (intent: SavedApplication): void => {
    if (applicationRef.current?.id !== intent.id) return;
    applicationRef.current = null;
    setApplication(null);
  };

  const beginOperation = (kind: Exclude<SavedOperation, null>): number => {
    cancelApplication();
    editor.current?.cancelApplication?.();
    const token = operationTokenRef.current + 1;
    operationTokenRef.current = token;
    operationOwnerRef.current = token;
    setOperation(kind);
    return token;
  };

  const finishOperation = useCallback((token: number): void => {
    if (operationOwnerRef.current !== token) return;
    operationOwnerRef.current = null;
    setOperation(null);
  }, []);

  const closeCreateForm = useCallback((focusTarget: 'new' | 'check' | null): void => {
    createFocusReturnRef.current = focusTarget;
    setNameMode(null);
  }, []);

  const abandonCreateIntent = useCallback(
    (restoreFocus: boolean): void => {
      const intent = createIntentRef.current;
      createIntentRef.current = null;
      if (intent?.sent && intent.draft) {
        const pending: PendingCreate = {
          ...intent,
          draft: intent.draft,
          sent: true,
          inFlight:
            pendingCreateRef.current?.owner === intent.owner
              ? pendingCreateRef.current.inFlight
              : false,
          operationToken: null,
          retryAuthorized: false,
        };
        pendingCreateRef.current = pending;
        setPendingCreate(pending);
      }
      const requestStillRunning =
        intent?.sent === true &&
        pendingCreateRef.current?.owner === intent.owner &&
        pendingCreateRef.current.inFlight;
      if (
        !requestStillRunning &&
        intent?.operationToken !== null &&
        intent?.operationToken !== undefined
      ) {
        finishOperation(intent.operationToken);
      }
      closeCreateForm(restoreFocus ? (intent?.sent ? 'check' : 'new') : null);
      setNewName('');
      setMessage(null);
      if (errorKind === 'new') {
        setError(null);
        setErrorKind(null);
      }
    },
    [closeCreateForm, errorKind, finishOperation],
  );

  const openListRead = useCallback(
    (cursor: string | undefined): void => {
      const resource: SavedListReadResource = {
        identity: session.identity.sub,
        targetId: cursor ?? 'first-page',
        surface: 'mis-robots',
        cursor,
      };
      listResourceRef.current = resource;
      void listRecovery.open(resource);
    },
    [listRecovery, session.identity.sub],
  );

  const openSelectedCopyRead = useCallback(
    (summary: SavedRobotSummary): void => {
      const resource: SavedCopyReadResource = {
        identity: session.identity.sub,
        targetId: summary.id,
        surface: 'mis-robots',
        summary,
      };
      selectedResourceRef.current = resource;
      needsSelectedReadRef.current = false;
      void selectedCopyRecovery.open(resource);
    },
    [selectedCopyRecovery, session.identity.sub],
  );

  useEffect(() => {
    if (!dialog) return;
    const element = dialogRef.current;
    if (element && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    if (dialog.kind === 'rename') {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [dialog]);

  useEffect(() => {
    if (!nameMode) {
      if (hadNewNameModeRef.current && activeSurfaceRef.current && !unavailableRef.current) {
        if (createFocusReturnRef.current === 'check') {
          createDebtCheckRef.current?.focus();
        } else if (createFocusReturnRef.current === 'new') {
          newCopyTriggerRef.current?.focus();
        }
      }
      createFocusReturnRef.current = null;
      hadNewNameModeRef.current = false;
      return;
    }
    createFocusReturnRef.current = null;
    hadNewNameModeRef.current = true;
    newNameInputRef.current?.focus();
    newNameInputRef.current?.select();
  }, [nameMode]);

  useLayoutEffect(() => {
    const identityChanged = previousIdentityRef.current !== session.identity.sub;
    previousIdentityRef.current = session.identity.sub;
    identitySubRef.current = session.identity.sub;
    activeSurfaceRef.current = active;
    unavailableRef.current = paused || locked;
    if (identityChanged) {
      createIntentRef.current = null;
      pendingPaginationFocusRef.current = null;
      listRecovery.clear();
      selectedCopyRecovery.clear();
      listResourceRef.current = null;
      selectedResourceRef.current = null;
      listLoadedRef.current = false;
      needsSelectedReadRef.current = false;
      generationRef.current += 1;
      selectedIdRef.current = null;
      consultStatusRef.current = 'idle';
      setRobots([]);
      setSelectedSummary(null);
      setSelected(null);
      setConsultStatus('idle');
      setConsultError(null);
      setConsultRecoveryMessage(null);
      setNextCursor(undefined);
      setListBusy(true);
      setListPageLoading(false);
      setListLoaded(false);
      setListFailure(null);
      setListRecoveryMessage(null);
      setLibraryNotice(null);
      setOperation(null);
      operationOwnerRef.current = null;
      cancelApplication();
      closeDialog(false);
      setMessage(null);
      setError(null);
      setErrorKind(null);
      setDeleteConflict(null);
      pendingCreateRef.current = null;
      setPendingCreate(null);
      setPendingCreateError(null);
      closeCreateForm(null);
      pendingCopyWriteRef.current = null;
      setPendingCopyWrite(null);
    }

    if (!readersActive) listRecovery.pause();
    if (!active) {
      abandonCreateIntent(false);
      pendingPaginationFocusRef.current = null;
      const selectedReadWasPending = selectedResourceRef.current !== null;
      selectedCopyRecovery.clear();
      selectedResourceRef.current = null;
      needsSelectedReadRef.current =
        selectedSummaryRef.current !== null && selectedDocumentRef.current === null;
      if (selectedReadWasPending && needsSelectedReadRef.current) {
        setConsult('idle');
        setConsultError(null);
        setConsultRecoveryMessage(null);
      }
    } else if (paused) {
      abandonCreateIntent(false);
      selectedCopyRecovery.pause();
      cancelApplication();
      closeDialog(false);
    } else if (locked) {
      abandonCreateIntent(false);
      cancelApplication();
      closeDialog(false);
    } else if (operation !== null) {
      selectedCopyRecovery.pause();
    }
  }, [
    active,
    abandonCreateIntent,
    cancelApplication,
    closeCreateForm,
    closeDialog,
    listRecovery,
    locked,
    operation,
    paused,
    readersActive,
    selectedCopyRecovery,
    session.identity.sub,
  ]);

  useLayoutEffect(() => {
    const handoff = pendingCreateFocusHandoffRef.current;
    if (!handoff) return;
    if (
      !active ||
      paused ||
      locked ||
      unavailableRef.current ||
      identitySubRef.current !== handoff.identity ||
      nameMode === 'new'
    ) {
      pendingCreateFocusHandoffRef.current = null;
      return;
    }
    if (createDebtCheckRef.current?.isConnected) return;
    if (pendingCreateRef.current?.owner === handoff.owner) return;
    if (document.activeElement !== document.body && document.activeElement !== handoff.trigger) {
      pendingCreateFocusHandoffRef.current = null;
      return;
    }
    const target = newCopyTriggerRef.current;
    if (!target || target.disabled) return;
    pendingCreateFocusHandoffRef.current = null;
    target.focus();
  }, [
    active,
    configurationAvailable,
    locked,
    nameMode,
    operation,
    paused,
    pendingCreate,
    robots,
    session.identity.sub,
  ]);

  useLayoutEffect(() => {
    const pendingFocus = pendingPaginationFocusRef.current;
    if (!pendingFocus) return;
    pendingPaginationFocusRef.current = null;
    if (
      !active ||
      identitySubRef.current !== pendingFocus.identity ||
      (document.activeElement !== document.body && document.activeElement !== pendingFocus.trigger)
    ) {
      return;
    }
    const radios = listRef.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const target = pendingFocus.targetId
      ? Array.from(radios ?? []).find((radio) => radio.value === pendingFocus.targetId)
      : undefined;
    (target ?? listHeadingRef.current)?.focus({ preventScroll: true });
  }, [active, robots, session.identity.sub]);

  useEffect(() => {
    if (!readersActive || paused || listLoadedRef.current || listResourceRef.current) return;
    openListRead(undefined);
  }, [openListRead, paused, readersActive, session.identity.sub]);

  useEffect(() => {
    if (!readersActive || paused || !needsSelectedReadRef.current) return;
    const summary = selectedSummaryRef.current;
    if (!summary || selectedDocumentRef.current) {
      needsSelectedReadRef.current = false;
      return;
    }
    if (selectedResourceRef.current) return;
    needsSelectedReadRef.current = false;
    openSelectedCopyRead(summary);
  }, [openSelectedCopyRead, paused, readersActive, session.identity.sub]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      createIntentRef.current = null;
      const current = applicationRef.current;
      applicationRef.current = null;
      current?.controller.abort();
    };
  }, []);

  const busy = paused || locked || listBusy || listPageLoading || operation !== null;
  const radioLocked = paused || locked || listBusy;
  const copiesByName = new Map<string, number>();
  const copyNumbers = new Map<string, number>();
  for (const robot of robots) {
    const number = (copiesByName.get(robot.name) ?? 0) + 1;
    copiesByName.set(robot.name, number);
    copyNumbers.set(robot.id, number);
  }

  const updateListWithSummary = (summary: SavedRobotSummary): void => {
    setRobots((current) => mergeSummary(current, summary));
  };

  const updateListWith = (robot: SavedRobot): void => {
    updateListWithSummary(summaryFromRobot(robot));
  };

  const setSelectedCopy = (
    summary: SavedRobotSummary | null,
    robot: SavedRobot | null,
    status: ConsultStatus,
  ): void => {
    selectedCopyRecovery.clear();
    selectedResourceRef.current = null;
    needsSelectedReadRef.current = false;
    selectedIdRef.current = summary?.id ?? null;
    selectedSummaryRef.current = summary;
    selectedDocumentRef.current = robot;
    setSelectedSummary(summary);
    setSelected(robot);
    setConsult(status);
    setConsultError(null);
    setConsultRecoveryMessage(null);
  };

  const handleSelect = (summary: SavedRobotSummary): void => {
    if (radioLocked) return;
    const alreadySelected = selectedIdRef.current === summary.id;
    if (
      alreadySelected &&
      (selected !== null ||
        consultStatusRef.current === 'loading' ||
        consultStatusRef.current === 'recovering')
    )
      return;
    abandonCreateIntent(false);
    cancelApplication();
    editor.current?.cancelApplication?.();
    selectedCopyRecovery.clear();
    selectedResourceRef.current = null;
    needsSelectedReadRef.current = false;
    if (!alreadySelected) {
      selectedIdRef.current = summary.id;
      selectedSummaryRef.current = summary;
      setSelectedSummary(summary);
      setSelected(null);
      setLibraryNotice(null);
      setConsult('idle');
      setConsultError(null);
      setConsultRecoveryMessage(null);
      setDeleteConflict(null);
      setMessage(null);
    }
    if (dialogRef.current?.open || dialog !== null) closeDialog(false);
    setError(null);
    setErrorKind(null);
    openSelectedCopyRead(summary);
  };

  const leaveSurface = useCallback((): void => {
    abandonCreateIntent(false);
    pendingPaginationFocusRef.current = null;
    const hadApplication = applicationRef.current !== null;
    cancelApplication();
    if (hadApplication) editor.current?.cancelApplication?.();
    listRecovery.pause();
    const hadSelectedRead = selectedResourceRef.current !== null;
    selectedCopyRecovery.clear();
    selectedResourceRef.current = null;
    needsSelectedReadRef.current =
      selectedSummaryRef.current !== null && selectedDocumentRef.current === null;
    if (hadSelectedRead && needsSelectedReadRef.current) {
      setConsult('idle');
      setConsultError(null);
      setConsultRecoveryMessage(null);
    }
    closeDialog(false);
  }, [
    abandonCreateIntent,
    cancelApplication,
    closeDialog,
    editor,
    listRecovery,
    selectedCopyRecovery,
  ]);

  useImperativeHandle(ref, () => ({ leaveSurface }), [leaveSurface]);

  const handleLoadMore = (): void => {
    if (!nextCursor || busy || listRecoveryMessage || listFailure) return;
    pendingPaginationFocusRef.current = null;
    openListRead(nextCursor);
  };

  const retryListFailure = (): void => {
    if (!listFailure || busy) return;
    const restartFromFirstPage =
      listFailure.cursor !== undefined &&
      listFailure.error instanceof SavedRobotApiFailure &&
      listFailure.error.code === 'invalid';
    if (restartFromFirstPage) {
      listRecovery.clear();
      listResourceRef.current = null;
      listLoadedRef.current = false;
      setListLoaded(false);
      setRobots([]);
      setNextCursor(undefined);
      setListBusy(true);
      openListRead(undefined);
      return;
    }
    openListRead(listFailure.cursor);
  };

  const readCreate = async (intent: PendingCreate, generation: number): Promise<CreateReadback> => {
    if (unavailableRef.current) throw new CreateReadbackPaused();
    if (!createIdentityIsCurrent(intent, generation)) throw new StaleSavedOperation();
    try {
      const saved = await api.getRobot(intent.id);
      if (!createIdentityIsCurrent(intent, generation)) throw new StaleSavedOperation();
      if (saved.id !== intent.id) return { kind: 'foreign', saved };
      return sameSavedContent(saved, intent.id, intent.name, intent.draft)
        ? { kind: 'match', saved }
        : { kind: 'conflict', saved };
    } catch (readError) {
      if (readError instanceof StaleSavedOperation) throw readError;
      if (isMissingError(readError)) return { kind: 'missing' };
      throw new PendingCreateReadbackFailure(readError);
    }
  };

  const createReadbackError = (result: Exclude<CreateReadback, { kind: 'match' }>): Error => {
    if (result.kind === 'missing') {
      return new PendingCreateReadbackFailure(
        new SavedRobotApiFailure(
          'not_found',
          'La copia todavía no aparece en el servidor. Reintentá para comprobar el mismo ID.',
          404,
        ),
      );
    }
    if (result.kind === 'foreign') return new ForeignCreateReadbackFailure();
    return new SavedRobotApiFailure(
      'conflict',
      'La copia pendiente ya existe con otro contenido.',
      409,
      result.saved,
    );
  };

  const sendCreate = async (
    intent: PendingCreate,
    generation: number,
  ): Promise<SavedRobot | null> => {
    if (!isActiveCreateIntent(intent, generation)) throw new StaleSavedOperation();
    let saved: SavedRobot;
    try {
      saved = await api.saveRobot(intent.id, 0, intent.name, intent.draft);
    } catch (saveError) {
      if (saveError instanceof StaleSavedOperation) throw saveError;
      if (
        saveError instanceof SavedRobotApiFailure &&
        saveError.code === 'conflict' &&
        saveError.current &&
        sameSavedContent(saveError.current, intent.id, intent.name, intent.draft)
      ) {
        return saveError.current;
      }
      if (
        saveError instanceof SavedRobotApiFailure &&
        saveError.code === 'conflict' &&
        saveError.current?.id === intent.id
      ) {
        throw createReadbackError({ kind: 'conflict', saved: saveError.current });
      }
      const shouldRead =
        saveError instanceof SavedRobotApiFailure &&
        (saveError.ambiguous || saveError.code === 'conflict') &&
        !isDefinitiveWriteRejection(saveError);
      if (!shouldRead) throw saveError;
      const readback = await readCreate(intent, generation);
      if (readback.kind === 'match') return readback.saved;
      if (readback.kind === 'missing') {
        if (!isActiveCreateIntent(intent, generation) && isCurrentCreateDebt(intent, generation)) {
          return null;
        }
        throw saveError;
      }
      if (readback.kind === 'conflict') throw createReadbackError(readback);
      throw new PendingCreateReadbackFailure(createReadbackError(readback));
    }
    if (!createIdentityIsCurrent(intent, generation)) throw new StaleSavedOperation();
    if (sameSavedContent(saved, intent.id, intent.name, intent.draft)) return saved;
    const readback = await readCreate(intent, generation);
    if (readback.kind === 'match') return readback.saved;
    if (
      readback.kind === 'missing' &&
      !isActiveCreateIntent(intent, generation) &&
      isCurrentCreateDebt(intent, generation)
    ) {
      return null;
    }
    if (readback.kind === 'conflict') throw createReadbackError(readback);
    throw new PendingCreateReadbackFailure(createReadbackError(readback));
  };

  const reconcileCreate = async (
    intent: PendingCreate,
    generation: number,
  ): Promise<SavedRobot | null> => {
    const readback = await readCreate(intent, generation);
    if (readback.kind === 'match') return readback.saved;
    if (readback.kind !== 'missing') throw createReadbackError(readback);
    if (!isActiveCreateIntent(intent, generation)) return null;
    return sendCreate(intent, generation);
  };

  const removeListedRobot = (id: string): void => {
    listRecovery.clear();
    listResourceRef.current = null;
    setListBusy(false);
    setListPageLoading(false);
    setListRecoveryMessage(null);
    setListFailure(null);
    setRobots((items) => items.filter((item) => item.id !== id));
    const pendingCreate = pendingCreateRef.current;
    if (pendingCreate?.id === id) clearCreateDebt(pendingCreate, generationRef.current);
    if (selectedIdRef.current === id) {
      setSelectedCopy(null, null, 'idle');
    }
    setDeleteConflict((current) => (current?.summary.id === id ? null : current));
  };

  const clearSelectedReadFor = (id: string): void => {
    if (selectedIdRef.current !== id) return;
    selectedCopyRecovery.clear();
    selectedResourceRef.current = null;
    needsSelectedReadRef.current = false;
  };

  const completeCopyWrite = (intent: PendingCopyWrite, saved: SavedRobot): void => {
    if (identitySubRef.current !== intent.identitySub) return;
    clearSelectedReadFor(intent.target.id);
    pendingCopyWriteRef.current = null;
    setPendingCopyWrite(null);
    updateListWith(saved);
    if (selectedIdRef.current === intent.target.id && !unavailableRef.current) {
      selectedSummaryRef.current = summaryFromRobot(saved);
      selectedDocumentRef.current = saved;
      setSelectedSummary(summaryFromRobot(saved));
      setSelected(saved);
      setConsult('ready');
      setConsultError(null);
      setConsultRecoveryMessage(null);
      setError(null);
      setErrorKind(null);
      setMessage(
        intent.kind === 'rename'
          ? 'Cambiaste el nombre de «' + saved.name + '».'
          : 'Reemplazaste el contenido de «' + saved.name + '».',
      );
    }
    setDeleteConflict(null);
    closeDialog();
  };

  const showWriteConflict = (
    intent: PendingCopyWrite,
    remote: SavedRobot,
    detail: string,
  ): void => {
    clearSelectedReadFor(intent.target.id);
    pendingCopyWriteRef.current = null;
    setPendingCopyWrite(null);
    updateListWith(remote);
    if (selectedIdRef.current === intent.target.id) {
      selectedSummaryRef.current = summaryFromRobot(remote);
      selectedDocumentRef.current = remote;
      setSelectedSummary(summaryFromRobot(remote));
      setSelected(remote);
      setConsult('ready');
      setConsultError(null);
      setConsultRecoveryMessage(null);
      setError(detail);
      setErrorKind('save');
      setMessage(null);
    }
    closeDialog();
  };

  const reportCopyWriteFailure = (
    intent: PendingCopyWrite,
    failure: unknown,
    keepIntent: boolean,
  ): void => {
    if (identitySubRef.current !== intent.identitySub) return;
    if (!keepIntent) {
      pendingCopyWriteRef.current = null;
      setPendingCopyWrite(null);
    }
    if (selectedIdRef.current === intent.target.id && !unavailableRef.current) {
      setError(apiErrorMessage(failure, 'No se pudo guardar esta copia.'));
      setErrorKind('save');
      setMessage(null);
    }
    const authError = reportedAuthError(failure);
    if (authError) onAuthRequired?.(authError.authContext);
  };

  const runCopyWrite = async (
    intent: PendingCopyWrite,
    operationToken: number,
    reconcileFirst: boolean,
    retrySameIntent: boolean,
  ): Promise<void> => {
    const generation = generationRef.current;
    const currentIdentity = (): boolean => identitySubRef.current === intent.identitySub;
    const resolveRemote = (remote: SavedRobot): 'committed' | 'unchanged' | 'changed' => {
      if (sameSavedContent(remote, intent.target.id, intent.name, intent.draft)) {
        completeCopyWrite(intent, remote);
        return 'committed';
      }
      if (sameSavedBase(remote, intent.target)) return 'unchanged';
      showWriteConflict(
        intent,
        remote,
        'La copia guardada cambió en otra pestaña. Compará la versión actual y confirmá de nuevo.',
      );
      return 'changed';
    };
    const reconcile = async (
      retryIfUnchanged: boolean,
      retainIfUnchanged: boolean,
    ): Promise<void> => {
      try {
        if (!currentIdentity() || unavailableRef.current) return;
        const remote = await api.getRobot(intent.target.id);
        if (!currentIdentity() || unavailableRef.current) return;
        const result = resolveRemote(remote);
        if (result !== 'unchanged') return;
        if (retryIfUnchanged) {
          await sendWrite();
        } else if (retainIfUnchanged) {
          reportCopyWriteFailure(
            intent,
            new Error(
              'No se confirmó el cambio. La misma operación quedó pendiente; reintentá para conciliarla.',
            ),
            true,
          );
        } else {
          reportCopyWriteFailure(
            intent,
            new Error('El cambio anterior no se aplicó. Podés iniciar una nueva acción.'),
            false,
          );
          closeDialog();
        }
      } catch (readError) {
        if (!currentIdentity() || unavailableRef.current) return;
        if (isMissingError(readError)) {
          pendingCopyWriteRef.current = null;
          setPendingCopyWrite(null);
          removeListedRobot(intent.target.id);
        }
        reportCopyWriteFailure(intent, readError, !isMissingError(readError));
      }
    };
    const sendWrite = async (): Promise<void> => {
      if (!currentIdentity() || !isCurrent(generation) || unavailableRef.current) return;
      const retainedIntent = pendingCopyWriteRef.current;
      if (retainedIntent?.target.id !== intent.target.id || retainedIntent.retryAuthorized !== true)
        return;
      try {
        const saved = await api.saveRobot(
          intent.target.id,
          intent.target.version,
          intent.name,
          intent.draft,
        );
        if (!currentIdentity()) return;
        completeCopyWrite(intent, saved);
      } catch (writeError) {
        if (!currentIdentity()) return;
        if (
          writeError instanceof SavedRobotApiFailure &&
          writeError.code === 'conflict' &&
          writeError.current
        ) {
          if (sameSavedContent(writeError.current, intent.target.id, intent.name, intent.draft)) {
            completeCopyWrite(intent, writeError.current);
          } else {
            showWriteConflict(intent, writeError.current, writeError.message);
          }
          return;
        }
        if (
          writeError instanceof SavedRobotApiFailure &&
          writeError.ambiguous &&
          !isDefinitiveWriteRejection(writeError)
        ) {
          const retainedIntent = pendingCopyWriteRef.current;
          const pending = {
            ...intent,
            retryAuthorized:
              retainedIntent?.target.id === intent.target.id && retainedIntent.retryAuthorized,
          };
          pendingCopyWriteRef.current = pending;
          setPendingCopyWrite(pending);
          if (unavailableRef.current) {
            reportCopyWriteFailure(
              intent,
              new Error('Se conserva el cambio enviado para conciliarlo cuando vuelva el acceso.'),
              true,
            );
            return;
          }
          await reconcile(false, true);
          return;
        }
        reportCopyWriteFailure(intent, writeError, false);
      }
    };

    if (!currentIdentity() || !isCurrent(generation) || unavailableRef.current) return;
    try {
      if (reconcileFirst) await reconcile(retrySameIntent, false);
      else await sendWrite();
    } finally {
      if (isCurrent(generation)) finishOperation(operationToken);
    }
  };

  const sendCopyIntent = async (
    intent: PendingCopyWrite,
    operationToken: number,
  ): Promise<void> => {
    pendingCopyWriteRef.current = intent;
    setPendingCopyWrite(intent);
    await runCopyWrite(intent, operationToken, false, false);
  };

  const beginCopyWrite = async (
    kind: CopyWriteKind,
    target: SavedRobot,
    desiredName: string,
    candidate: RobotDraft,
  ): Promise<void> => {
    const pending = pendingCopyWriteRef.current;
    if (pending) {
      if (pending.target.id !== target.id || pending.kind !== kind) {
        setError(
          'Hay un cambio pendiente para otra copia. Volvé a esa copia para conciliarlo antes de iniciar otro.',
        );
        setErrorKind('save');
        return;
      }
      const token = beginOperation('save');
      setError(null);
      setErrorKind(null);
      setMessage(null);
      await runCopyWrite(pending, token, true, pending.retryAuthorized);
      return;
    }
    const limit = draftLimitMessage(candidate);
    if (limit) {
      setError('Esta copia no se puede escribir sin cambiar su contenido: ' + limit);
      setErrorKind('save');
      return;
    }
    const intent: PendingCopyWrite = {
      kind,
      target,
      identitySub: session.identity.sub,
      name: desiredName,
      draft: copyDraft(candidate),
      retryAuthorized: true,
    };
    const token = beginOperation('save');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    setDeleteConflict(null);
    await sendCopyIntent(intent, token);
  };

  const handleUseConfirmed = async (target: SavedRobot): Promise<void> => {
    closeDialog();
    const generation = generationRef.current;
    const intent = beginApplication(target.name, target.id);
    setError(null);
    setErrorKind(null);
    setMessage(null);
    try {
      if (!isCurrentApplication(intent, generation)) return;
      const limit = draftLimitMessage(target.draft);
      if (limit) {
        setError('Esta copia supera los límites actuales para usarla: ' + limit);
        setErrorKind('save');
        return;
      }
      const applied = await editor.current?.applyDraft(target.draft, {
        signal: intent.controller.signal,
      });
      if (!isCurrentApplication(intent, generation) || applied !== true) return;
      finishApplication(intent);
      setMessage('Cargaste «' + target.name + '».');
      if (onReturnToEditor) onReturnToEditor();
      else editor.current?.focusEditor?.();
    } catch (applyError) {
      if (isCurrentApplication(intent, generation)) {
        setError(apiErrorMessage(applyError, 'No se pudo aplicar esta copia.'));
        setErrorKind('save');
      }
    } finally {
      finishApplication(intent);
    }
  };

  const handleRenameSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (dialog?.kind !== 'rename' || managementBusy || paused || locked) return;
    const target = dialog.target;
    const pending = pendingCopyWriteRef.current;
    if (pending) {
      if (pending.target.id !== target.id || pending.kind !== 'rename') {
        setError(
          'Hay un cambio pendiente para otra acción. Volvé a esa copia para conciliarlo antes de iniciar otro.',
        );
        setErrorKind('save');
        return;
      }
      const token = beginOperation('save');
      setError(null);
      setErrorKind(null);
      setMessage(null);
      await runCopyWrite(pending, token, true, pending.retryAuthorized);
      return;
    }
    let nextName: string;
    try {
      nextName = validateSavedRobotName(dialog.name);
    } catch (validationError) {
      setError(apiErrorMessage(validationError, 'Ingresá un nombre válido para el robot.'));
      setErrorKind('save');
      return;
    }
    const limit = draftLimitMessage(target.draft);
    if (limit) {
      setError('Esta copia no se puede renombrar sin cambiar su contenido: ' + limit);
      setErrorKind('save');
      return;
    }
    if (nextName === target.name) {
      closeDialog();
      setMessage('No hay cambios para guardar en esta copia.');
      return;
    }
    await beginCopyWrite('rename', target, nextName, target.draft);
  };

  const handleReplaceConfirmed = async (target: SavedRobot): Promise<void> => {
    if (managementBusy || paused || locked) return;
    const pending = pendingCopyWriteRef.current;
    if (pending) {
      if (pending.target.id !== target.id || pending.kind !== 'replace') {
        setError(
          'Hay un cambio pendiente para otra acción. Volvé a esa copia para conciliarlo antes de iniciar otro.',
        );
        setErrorKind('save');
        return;
      }
      const token = beginOperation('save');
      setError(null);
      setErrorKind(null);
      setMessage(null);
      await runCopyWrite(pending, token, true, pending.retryAuthorized);
      return;
    }
    const generation = generationRef.current;
    const token = beginOperation('save');
    setError(null);
    setErrorKind(null);
    setMessage(null);
    try {
      const snapshot: DraftSnapshot | null = (await editor.current?.captureSnapshot()) ?? null;
      if (!snapshot) {
        setError(
          'No se pudo confirmar la configuración actual. Terminá o reintentá el guardado pendiente.',
        );
        setErrorKind('save');
        return;
      }
      if (
        !isCurrent(generation) ||
        unavailableRef.current ||
        selectedIdRef.current !== target.id ||
        !dialogRef.current?.open ||
        identitySubRef.current !== session.identity.sub
      )
        return;
      const limit = draftLimitMessage(snapshot.draft);
      if (limit) {
        setError('La configuración actual no se puede guardar como copia: ' + limit);
        setErrorKind('save');
        return;
      }
      if (draftsEqual(target.draft, snapshot.draft)) {
        closeDialog();
        setMessage('La copia ya tiene la configuración actual.');
        return;
      }
      const intent: PendingCopyWrite = {
        kind: 'replace',
        target,
        identitySub: session.identity.sub,
        name: target.name,
        draft: copyDraft(snapshot.draft),
        retryAuthorized: true,
      };
      await sendCopyIntent(intent, token);
    } catch (captureError) {
      if (isCurrent(generation)) {
        setError(apiErrorMessage(captureError, 'No se pudo confirmar la configuración actual.'));
        setErrorKind('save');
      }
    } finally {
      if (isCurrent(generation)) finishOperation(token);
    }
  };

  const completeCreate = (intent: PendingCreate, saved: SavedRobot, generation: number): void => {
    if (!createIdentityIsCurrent(intent, generation)) return;
    const activeIntent = isActiveCreateIntent(intent, generation);
    const currentDebt = isCurrentCreateDebt(intent, generation);
    if (!activeIntent && !currentDebt) return;

    clearCreateDebt(intent, generation);
    if (createIntentRef.current?.owner === intent.owner) createIntentRef.current = null;
    updateListWith(saved);
    if (!activeIntent) return;

    setNewName('');
    closeCreateForm('new');
    if (selectedIdRef.current === intent.selectedIdAtStart) {
      setSelectedCopy(summaryFromRobot(saved), saved, 'ready');
    }
    setError(null);
    setErrorKind(null);
    setMessage('Guardaste «' + saved.name + '» como robot nuevo.');
  };

  const handleSaveAsNew = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (
      paused ||
      locked ||
      !active ||
      pendingCopyWriteRef.current ||
      operationOwnerRef.current !== null ||
      (listBusy && pendingCreateRef.current === null) ||
      (listPageLoading && pendingCreateRef.current === null)
    ) {
      return;
    }

    const existing = pendingCreateRef.current;
    if (existing && (!existing.retryAuthorized || existing.inFlight)) return;
    if (createIntentRef.current && !existing) return;
    if (!existing && !configurationAvailable) return;

    let name = existing?.name;
    if (!existing) {
      try {
        name = validateSavedRobotName(newName);
      } catch (validationError) {
        setError(apiErrorMessage(validationError, 'Ingresá un nombre válido para el robot.'));
        setErrorKind('new');
        return;
      }
    }

    const generation = generationRef.current;
    const token = beginOperation('save');
    const intent: CreateIntent = existing
      ? { ...existing, operationToken: token, retryAuthorized: true }
      : {
          id: newRobotId(),
          name: name!,
          identitySub: session.identity.sub,
          selectedIdAtStart: selectedIdRef.current,
          owner: createOwnerIdRef.current + 1,
          operationToken: token,
          draft: null,
          sent: false,
          retryAuthorized: true,
        };
    if (!existing) createOwnerIdRef.current = intent.owner;
    createIntentRef.current = intent;
    setError(null);
    setErrorKind(null);
    setMessage(null);
    setPendingCreateError(null);
    setDeleteConflict(null);
    if (existing) {
      const retry = { ...existing, operationToken: token, inFlight: true };
      pendingCreateRef.current = retry;
      setPendingCreate(retry);
      setNewName(retry.name);
    }

    let sentIntent: PendingCreate | null = existing
      ? { ...existing, operationToken: token, retryAuthorized: true, inFlight: true }
      : null;
    try {
      if (!existing) {
        const snapshot: DraftSnapshot | null = (await editor.current?.captureSnapshot()) ?? null;
        if (!isActiveCreateIntent(intent, generation)) return;
        if (!snapshot) {
          createIntentRef.current = null;
          setError(
            'No se pudo capturar la configuración actual. Terminá o reintentá el guardado pendiente.',
          );
          setErrorKind('new');
          return;
        }
        sentIntent = {
          ...intent,
          draft: copyDraft(snapshot.draft),
          sent: true,
          inFlight: true,
        };
        createIntentRef.current = sentIntent;
        pendingCreateRef.current = sentIntent;
        setPendingCreate(sentIntent);
      }

      if (!sentIntent || !isActiveCreateIntent(sentIntent, generation)) return;
      const saved = existing
        ? await reconcileCreate(sentIntent, generation)
        : await sendCreate(sentIntent, generation);
      if (saved) completeCreate(sentIntent, saved, generation);
      else clearCreateDebt(sentIntent, generation);
    } catch (saveError) {
      if (saveError instanceof StaleSavedOperation) return;
      const current = sentIntent
        ? isActiveCreateIntent(sentIntent, generation)
        : createIntentRef.current?.owner === intent.owner &&
          createIdentityIsCurrent(intent, generation);
      const debt = sentIntent && isCurrentCreateDebt(sentIntent, generation);
      const sameIdConflict =
        saveError instanceof SavedRobotApiFailure &&
        saveError.code === 'conflict' &&
        saveError.current?.id === sentIntent?.id;
      const definitiveRejection =
        saveError instanceof SavedRobotApiFailure &&
        (isDefinitiveWriteRejection(saveError) || sameIdConflict);
      const preservePending =
        saveError instanceof PendingCreateReadbackFailure ||
        saveError instanceof ForeignCreateReadbackFailure ||
        saveError instanceof CreateReadbackPaused ||
        (saveError instanceof SavedRobotApiFailure &&
          ((saveError.code === 'conflict' && !sameIdConflict) ||
            (saveError.ambiguous && !isDefinitiveWriteRejection(saveError)) ||
            (existing !== null && isDefinitiveWriteRejection(saveError))));

      if (sentIntent && (current || debt)) {
        const retry = {
          ...sentIntent,
          operationToken: null,
          inFlight: false,
          retryAuthorized: current && preservePending,
        };
        pendingCreateRef.current = retry;
        setPendingCreate(retry);
        if (current && !preservePending) {
          clearCreateDebt(sentIntent, generation);
          createIntentRef.current = null;
        } else if (current) {
          createIntentRef.current = retry;
        } else if (debt && !preservePending && definitiveRejection) {
          clearCreateDebt(sentIntent, generation);
          if (createIntentRef.current?.owner === sentIntent.owner) {
            createIntentRef.current = null;
          }
        } else if (debt) {
          createIntentRef.current = null;
          setPendingCreateError(apiErrorMessage(saveError, 'No se pudo comprobar el guardado.'));
        }
      } else if (current) {
        createIntentRef.current = null;
      }

      if (current && !(saveError instanceof ForeignCreateReadbackFailure)) {
        setError(
          saveError instanceof SavedRobotApiFailure && saveError.code === 'conflict'
            ? 'Hay una versión más nueva de esta copia. Revisá la lista antes de volver a intentar.'
            : apiErrorMessage(saveError, 'No se pudo guardar el robot nuevo.'),
        );
        setErrorKind('new');
      }
      const authError = reportedAuthError(saveError);
      if (authError && createIdentityIsCurrent(intent, generation)) {
        onAuthRequired?.(authError.authContext);
      }
    } finally {
      if (sentIntent && isCurrentCreateDebt(sentIntent, generation)) {
        const currentPending = pendingCreateRef.current;
        if (currentPending?.owner === sentIntent.owner && currentPending.inFlight) {
          const settled = { ...currentPending, inFlight: false, operationToken: null };
          pendingCreateRef.current = settled;
          setPendingCreate(settled);
        }
      }
      if (isCurrent(generation)) finishOperation(token);
    }
  };

  const handleCheckCreateDebt = async (): Promise<void> => {
    const pending = pendingCreateRef.current;
    if (
      !pending ||
      pending.retryAuthorized ||
      pending.inFlight ||
      paused ||
      locked ||
      !active ||
      pendingCopyWriteRef.current !== null ||
      operationOwnerRef.current !== null
    ) {
      return;
    }
    const generation = generationRef.current;
    const token = beginOperation('save');
    const checking: PendingCreate = { ...pending, operationToken: token, inFlight: true };
    pendingCreateRef.current = checking;
    setPendingCreate(checking);
    setPendingCreateError(null);
    try {
      const result = await readCreate(checking, generation);
      if (!isCurrentCreateDebt(checking, generation)) return;
      if (result.kind === 'match') {
        updateListWith(result.saved);
        clearCreateDebt(checking, generation);
      } else if (result.kind === 'missing') {
        clearCreateDebt(checking, generation);
      } else if (result.kind === 'conflict') {
        clearCreateDebt(checking, generation);
        setLibraryNotice(
          `La copia «${checking.name}» ya existe con otro contenido. No se modificó esa copia; podés iniciar una acción nueva.`,
        );
      } else {
        setPendingCreateError(
          apiErrorMessage(createReadbackError(result), 'El guardado sigue pendiente.'),
        );
      }
    } catch (readError) {
      if (!isCurrentCreateDebt(checking, generation)) return;
      setPendingCreateError(apiErrorMessage(readError, 'No se pudo comprobar el guardado.'));
      const authError = reportedAuthError(readError);
      if (authError) onAuthRequired?.(authError.authContext);
    } finally {
      if (isCurrentCreateDebt(checking, generation)) {
        const currentPending = pendingCreateRef.current;
        if (currentPending?.owner === checking.owner) {
          const settled = { ...currentPending, inFlight: false, operationToken: null };
          pendingCreateRef.current = settled;
          setPendingCreate(settled);
        }
      }
      if (isCurrent(generation)) finishOperation(token);
    }
  };

  const handleDelete = async (target: SavedRobotSummary): Promise<void> => {
    if (paused || locked || managementBusy) return;
    if (pendingCopyWriteRef.current) {
      setError('Hay un cambio pendiente para una copia. Conciliá esa operación antes de eliminar.');
      setErrorKind('save');
      return;
    }
    if (!window.confirm('¿Eliminar «' + target.name + '»? Esta acción no se puede deshacer.'))
      return;
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
        'Eliminaste «' + target.name + '». Tu configuración actual y tus intentos siguen intactos.',
      );
    } catch (deleteError) {
      if (!isCurrent(generation)) return;
      if (deleteError instanceof SavedRobotApiFailure && deleteError.ambiguous) {
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
            setMessage('Eliminaste «' + target.name + '».');
          } else {
            setError(apiErrorMessage(deleteError, 'No se pudo confirmar la eliminación.'));
            setErrorKind('delete');
          }
        }
      } else if (
        deleteError instanceof SavedRobotApiFailure &&
        deleteError.code === 'conflict' &&
        (deleteError.currentSummary || deleteError.current)
      ) {
        const robot = deleteError.current;
        const summary = deleteError.currentSummary ?? (robot ? summaryFromRobot(robot) : null);
        if (summary) {
          setDeleteConflict({ summary });
          updateListWithSummary(summary);
        }
        setError(null);
        setErrorKind(null);
      } else {
        setError(apiErrorMessage(deleteError, 'No se pudo eliminar el robot guardado.'));
        setErrorKind('delete');
        if (isMissingError(deleteError)) removeListedRobot(target.id);
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
    if (selectedIdRef.current === summary.id) {
      selectedSummaryRef.current = summary;
      setSelectedSummary(summary);
    }
    setDeleteConflict(null);
    setMessage(
      'La copia «' +
        summary.name +
        '» cambió. Confirmá «Eliminar» nuevamente para borrarla. Tu configuración actual sigue intacta.',
    );
  };

  const openUse = (trigger: HTMLButtonElement): void => {
    if (!selected || !selectedSummary || paused || locked || managementBusy) return;
    dialogTriggerRef.current = trigger;
    setError(null);
    setErrorKind(null);
    setDialog({ kind: 'use', target: selected });
  };

  const openRename = (trigger: HTMLButtonElement): void => {
    if (!selected || paused || locked || managementBusy) return;
    dialogTriggerRef.current = trigger;
    setError(null);
    setErrorKind(null);
    const pending = pendingCopyWriteRef.current;
    setDialog({
      kind: 'rename',
      target: selected,
      name:
        pending?.target.id === selected.id && pending.kind === 'rename'
          ? pending.name
          : selected.name,
    });
  };

  const openReplace = (trigger: HTMLButtonElement): void => {
    if (!selected || paused || locked || managementBusy) return;
    dialogTriggerRef.current = trigger;
    setError(null);
    setErrorKind(null);
    setDialog({ kind: 'replace', target: selected });
  };

  const canSaveAsNew =
    configurationAvailable || (pendingCreate !== null && pendingCreate.retryAuthorized);
  const canStartNew =
    !paused &&
    !locked &&
    active &&
    operation === null &&
    !listPageLoading &&
    pendingCopyWrite === null &&
    pendingCreate === null &&
    !listBusy &&
    canSaveAsNew;
  const selectedLimit = selected ? draftLimitMessage(selected.draft) : null;
  const loadMoreBlocked = busy || !!listRecoveryMessage || !!listFailure;
  const keepLoadMoreFocusable = listPageLoading || !!listRecoveryMessage || !!listFailure;
  const globalErrorVisible = error !== null && errorKind === 'delete';
  const openNewCopy = (): void => {
    if (!canStartNew) return;
    setNameMode('new');
    setNewName('');
    setError(null);
    setErrorKind(null);
    setPendingCreateError(null);
    setLibraryNotice(null);
    setMessage(null);
  };
  const newCopyButton = (
    <button
      ref={newCopyTriggerRef}
      className="secondary-button"
      type="button"
      onClick={openNewCopy}
      disabled={!canStartNew}
    >
      Guardar robot actual
    </button>
  );
  return (
    <section
      className="saved-robots"
      aria-labelledby="saved-robots-title"
      aria-busy={busy || application !== null}
    >
      <header className="saved-robots-heading">
        <div>
          <p className="card-kicker">Copias guardadas</p>
          <h2 id="saved-robots-title" tabIndex={-1}>
            Mis robots
          </h2>
        </div>
        {robots.length > 0 && nameMode !== 'new' && newCopyButton}
        {listBusy && <span className="spinner" aria-label="Cargando robots guardados" />}
      </header>

      {paused && (
        <p className="editor-paused" role="status">
          {accessState === 'required'
            ? 'El acceso a tu cuenta fue rechazado. Volvé a ingresar para continuar. Tus robots guardados siguen protegidos.'
            : 'Verificando tu sesión… Tus robots guardados siguen protegidos.'}
        </p>
      )}
      {listFailure && (
        <div className="saved-robots-error" role="alert" aria-live="assertive">
          <p>
            {apiErrorMessage(listFailure.error, 'No se pudieron consultar tus robots guardados.')}
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={retryListFailure}
            disabled={busy}
          >
            {listFailure.cursor !== undefined &&
            listFailure.error instanceof SavedRobotApiFailure &&
            listFailure.error.code === 'invalid'
              ? 'Volver a cargar la lista'
              : 'Reintentar consulta'}
          </button>
        </div>
      )}
      {globalErrorVisible && (
        <div className="saved-robots-error" role="alert" aria-live="assertive">
          <p>{error}</p>
        </div>
      )}
      {application && (
        <div className="saved-robots-message" role="status" aria-live="polite">
          <span>Aplicando «{application.label}»…</span>
          <button
            className="text-button"
            type="button"
            onClick={cancelApplication}
            disabled={paused || locked}
          >
            Cancelar aplicación
          </button>
        </div>
      )}
      {message && (
        <p className="saved-robots-message" role="status" aria-live="polite">
          {message}
        </p>
      )}

      <div className="saved-robots-layout">
        <section className="saved-robots-list-panel" aria-label="Robots guardados">
          <h3 ref={listHeadingRef} tabIndex={-1}>
            Robots guardados
          </h3>
          {!paused && listRecoveryMessage && (
            <p className="saved-robots-message" role="status" aria-live="polite">
              {listRecoveryMessage}
            </p>
          )}
          {pendingCreate && !pendingCreate.retryAuthorized && nameMode !== 'new' && (
            <div className="saved-robots-pending-create" role="status" aria-live="polite">
              <p>
                El guardado de «{pendingCreate.name}» se envió y todavía no se confirmó. Comprobá el
                mismo ID antes de iniciar otra copia.
              </p>
              {pendingCreateError && <p role="alert">{pendingCreateError}</p>}
              <button
                ref={createDebtCheckRef}
                className="secondary-button"
                type="button"
                onClick={() => void handleCheckCreateDebt()}
                disabled={
                  paused ||
                  locked ||
                  !active ||
                  pendingCopyWrite !== null ||
                  (operation !== null && !pendingCreate.inFlight)
                }
                aria-disabled={pendingCreate.inFlight || operation !== null ? true : undefined}
              >
                Comprobar guardado
              </button>
            </div>
          )}
          {libraryNotice && (
            <p className="saved-robots-message" role="status" aria-live="polite">
              {libraryNotice}
            </p>
          )}
          {listLoaded && robots.length === 0 && !listFailure && (
            <p className="saved-robots-empty">Todavía no guardaste ninguna copia.</p>
          )}
          <div className="saved-robots-list-wrap">
            <ul ref={listRef} className="saved-robots-list" aria-label="Robots guardados">
              {robots.map((robot) => {
                const duplicate = (copiesByName.get(robot.name) ?? 0) > 1;
                const copyNumber = copyNumbers.get(robot.id);
                const copyLabel = duplicate
                  ? robot.name + ' Copia ' + copyNumber
                  : robot.name + ' guardado';
                return (
                  <li key={robot.id}>
                    <label
                      className={
                        'saved-robot-choice' +
                        (selectedSummary?.id === robot.id ? ' is-selected' : '')
                      }
                    >
                      <input
                        type="radio"
                        name="saved-robot-selection"
                        value={robot.id}
                        checked={selectedSummary?.id === robot.id}
                        aria-label={
                          duplicate
                            ? copyLabel
                            : copyLabel +
                              ', ' +
                              modelLabel(robot.modelKey) +
                              ', actualizado ' +
                              formatDate(robot.updatedAt)
                        }
                        disabled={radioLocked}
                        onChange={(event) => {
                          if (event.currentTarget.checked) {
                            event.currentTarget.focus();
                            handleSelect(robot);
                          }
                        }}
                        onClick={() => {
                          if (
                            selectedIdRef.current === robot.id &&
                            !selected &&
                            consultStatusRef.current !== 'loading'
                          ) {
                            handleSelect(robot);
                          }
                        }}
                      />
                      <span className="saved-robot-choice-copy">
                        <strong>
                          {robot.name}
                          {duplicate ? ' · Copia ' + copyNumber : ''}
                        </strong>
                        <span>Actualizado {formatDate(robot.updatedAt)}</span>
                      </span>
                    </label>
                    {deleteConflict?.summary.id === robot.id && (
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
                  </li>
                );
              })}
            </ul>
            {nextCursor && (
              <button
                ref={loadMoreButtonRef}
                className="text-button"
                type="button"
                onClick={handleLoadMore}
                disabled={loadMoreBlocked && !keepLoadMoreFocusable}
                aria-disabled={loadMoreBlocked ? true : undefined}
              >
                {listPageLoading ? 'Cargando…' : 'Cargar más'}
              </button>
            )}
          </div>
        </section>

        <section
          className="saved-robots-detail"
          role="region"
          aria-label="Copia seleccionada"
          aria-busy={consultStatus === 'loading'}
        >
          {selectedSummary ? (
            <>
              <div className="saved-robots-detail-heading">
                <div>
                  <p className="card-kicker">Copia seleccionada</p>
                  <h3>{selectedSummary.name}</h3>
                </div>
                {consultStatus === 'loading' && (
                  <span className="spinner" aria-label="Consultando la copia" />
                )}
              </div>
              <dl className="saved-robot-inspection-facts">
                <div>
                  <dt>Modelo</dt>
                  <dd>{modelLabel(selectedSummary.modelKey)}</dd>
                </div>
                <div>
                  <dt>Actualizado</dt>
                  <dd>{formatDate(selectedSummary.updatedAt)}</dd>
                </div>
              </dl>
              {consultStatus === 'loading' && <p role="status">Consultando la copia…</p>}
              {!paused && consultRecoveryMessage && (
                <p className="saved-robots-message" role="status" aria-live="polite">
                  {consultRecoveryMessage}
                </p>
              )}
              {consultError && (
                <p className="saved-robots-error" role="alert">
                  {consultError}
                </p>
              )}
              {selected && (
                <div className="configuration-preview-copy saved-robot-preview">
                  <h4>Instrucciones</h4>
                  <p className="configuration-preview-literal">{selected.draft.instructions}</p>
                  <h4>Habilidades</h4>
                  <ul>
                    {selected.draft.skills.map((skill) => {
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
              )}
              {selectedLimit && selected && (
                <p className="saved-robot-inspection-notice" role="status">
                  Esta copia supera los límites actuales para usarla o escribirla: {selectedLimit}
                </p>
              )}
              {error && errorKind === 'save' && selectedSummary.id === selectedIdRef.current && (
                <p className="saved-robots-control-error" role="alert" aria-live="assertive">
                  {error}
                </p>
              )}
              {pendingCopyWrite?.target.id === selectedSummary.id && (
                <p className="saved-robots-pending" role="status">
                  El resultado de{' '}
                  {pendingCopyWrite.kind === 'rename' ? 'este cambio de nombre' : 'este reemplazo'}{' '}
                  todavía no se confirmó. La misma copia y el mismo contenido quedan pendientes de
                  conciliación.
                </p>
              )}
              {pendingCopyWrite && pendingCopyWrite.target.id !== selectedSummary.id && (
                <p className="saved-robots-pending" role="status">
                  Hay un cambio pendiente en «{pendingCopyWrite.target.name}». Elegí esa copia para
                  conciliarlo antes de iniciar otra modificación.
                </p>
              )}
              <div className="saved-robots-actions saved-robots-primary-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={(event) => openUse(event.currentTarget)}
                  disabled={!selected || paused || locked || managementBusy || !!selectedLimit}
                >
                  Usar este robot
                </button>
              </div>
              <details
                className="saved-robots-more-actions"
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || !event.currentTarget.open) return;
                  event.preventDefault();
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                }}
              >
                <summary ref={detailsSummaryRef}>Más acciones</summary>
                <div className="saved-robots-more-actions-content">
                  <button
                    className="text-button"
                    type="button"
                    onClick={(event) => openRename(event.currentTarget)}
                    disabled={
                      !selected ||
                      paused ||
                      locked ||
                      managementBusy ||
                      (pendingCopyWrite !== null &&
                        (pendingCopyWrite.target.id !== selectedSummary.id ||
                          pendingCopyWrite.kind !== 'rename'))
                    }
                  >
                    Renombrar
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={(event) => openReplace(event.currentTarget)}
                    disabled={
                      !selected ||
                      paused ||
                      locked ||
                      managementBusy ||
                      !configurationAvailable ||
                      (pendingCopyWrite !== null &&
                        (pendingCopyWrite.target.id !== selectedSummary.id ||
                          pendingCopyWrite.kind !== 'replace'))
                    }
                  >
                    Reemplazar con mi robot actual…
                  </button>
                  <button
                    className="text-button danger-button"
                    type="button"
                    onClick={() => void handleDelete(selectedSummary)}
                    disabled={paused || locked || managementBusy || pendingCopyWrite !== null}
                  >
                    Eliminar copia…
                  </button>
                </div>
              </details>
            </>
          ) : (
            <div className="saved-robots-detail-empty">
              <p className="card-kicker">Copia seleccionada</p>
              <h3>Elegí una copia</h3>
              <p>Elegí un robot guardado para consultar su configuración.</p>
              {pendingCopyWrite && (
                <p className="saved-robots-pending" role="status">
                  Hay un cambio pendiente en «{pendingCopyWrite.target.name}». Elegí esa copia para
                  conciliarlo antes de iniciar otra modificación.
                </p>
              )}
            </div>
          )}

          {nameMode === 'new' && (
            <form
              className="saved-robots-name-form"
              onSubmit={(event) => void handleSaveAsNew(event)}
            >
              <label htmlFor="saved-robot-name">Nombre para la nueva copia</label>
              <input
                ref={newNameInputRef}
                id="saved-robot-name"
                type="text"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                required
                disabled={
                  paused ||
                  locked ||
                  managementBusy ||
                  pendingCreate !== null ||
                  pendingCopyWrite !== null ||
                  !configurationAvailable
                }
              />
              {error && errorKind === 'new' && (
                <p className="saved-robots-control-error" role="alert">
                  {error}
                </p>
              )}
              {pendingCreate && (
                <p className="saved-robots-pending" role="status">
                  No se confirmó la respuesta. Reintentá esta acción para consultar la misma copia
                  sin crear otra.
                </p>
              )}
              <div className="editor-actions">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    paused ||
                    locked ||
                    listBusy ||
                    managementBusy ||
                    pendingCopyWrite !== null ||
                    !canSaveAsNew
                  }
                >
                  Guardar una copia
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => abandonCreateIntent(true)}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}
          {robots.length === 0 && nameMode !== 'new' && (
            <div className="saved-robots-actions saved-robots-create-action">{newCopyButton}</div>
          )}
        </section>
      </div>

      <dialog
        ref={dialogRef}
        className="saved-robots-dialog"
        aria-labelledby="saved-robots-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
      >
        {dialog?.kind === 'use' && (
          <div className="saved-robots-dialog-content">
            <h3 id="saved-robots-dialog-title">Usar «{dialog.target.name}»</h3>
            <p>
              Se reemplazarán las instrucciones y habilidades actuales del editor por la
              configuración consultada de «{dialog.target.name}».
            </p>
            <div className="editor-actions">
              <button className="secondary-button" type="button" onClick={() => closeDialog()}>
                Cancelar
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void handleUseConfirmed(dialog.target)}
              >
                Usar este robot
              </button>
            </div>
          </div>
        )}
        {dialog?.kind === 'rename' && (
          <form
            className="saved-robots-dialog-content"
            onSubmit={(event) => void handleRenameSubmit(event)}
          >
            <h3 id="saved-robots-dialog-title">Renombrar «{dialog.target.name}»</h3>
            <label htmlFor="saved-robots-rename-name">Nombre</label>
            <input
              ref={renameInputRef}
              id="saved-robots-rename-name"
              type="text"
              value={dialog.name}
              maxLength={160}
              onChange={(event) =>
                setDialog((current) =>
                  current?.kind === 'rename' ? { ...current, name: event.target.value } : current,
                )
              }
              required
              disabled={
                managementBusy ||
                paused ||
                locked ||
                (pendingCopyWrite?.target.id === dialog.target.id &&
                  pendingCopyWrite.kind === 'rename' &&
                  !pendingCopyWrite.retryAuthorized)
              }
            />
            {error && errorKind === 'save' && (
              <p className="saved-robots-control-error" role="alert">
                {error}
              </p>
            )}
            {pendingCopyWrite?.target.id === dialog.target.id &&
              pendingCopyWrite.kind === 'rename' &&
              !pendingCopyWrite.retryAuthorized && (
                <p className="saved-robots-pending" role="status">
                  Este diálogo sólo puede conciliar el cambio ya enviado. Después podrás iniciar un
                  cambio nuevo.
                </p>
              )}
            <p>Solo cambia el nombre. El contenido de esta copia se conserva exactamente.</p>
            <div className="editor-actions">
              <button
                className="text-button"
                type="button"
                onClick={() => closeDialog()}
                disabled={managementBusy}
              >
                Cancelar
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={managementBusy || paused || locked}
              >
                {pendingCopyWrite?.target.id === dialog.target.id &&
                pendingCopyWrite.kind === 'rename' &&
                !pendingCopyWrite.retryAuthorized
                  ? 'Comprobar cambio pendiente'
                  : 'Guardar nombre'}
              </button>
            </div>
          </form>
        )}
        {dialog?.kind === 'replace' && (
          <div className="saved-robots-dialog-content">
            <h3 id="saved-robots-dialog-title">Reemplazar «{dialog.target.name}»</h3>
            <p>
              El contenido de «{dialog.target.name}» se reemplazará por las instrucciones y
              habilidades actuales, confirmadas en el editor.
            </p>
            {error && errorKind === 'save' && (
              <p className="saved-robots-control-error" role="alert">
                {error}
              </p>
            )}
            {pendingCopyWrite?.target.id === dialog.target.id &&
              pendingCopyWrite.kind === 'replace' &&
              !pendingCopyWrite.retryAuthorized && (
                <p className="saved-robots-pending" role="status">
                  Esta confirmación sólo puede conciliar el cambio ya enviado. Después podrás
                  iniciar un reemplazo nuevo.
                </p>
              )}
            <div className="editor-actions">
              <button
                className="text-button"
                type="button"
                onClick={() => closeDialog()}
                disabled={managementBusy}
              >
                Cancelar
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void handleReplaceConfirmed(dialog.target)}
                disabled={managementBusy || paused || locked || !configurationAvailable}
              >
                {pendingCopyWrite?.target.id === dialog.target.id &&
                pendingCopyWrite.kind === 'replace' &&
                !pendingCopyWrite.retryAuthorized
                  ? 'Comprobar cambio pendiente'
                  : 'Reemplazar copia'}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </section>
  );
});

SavedRobots.displayName = 'SavedRobots';
