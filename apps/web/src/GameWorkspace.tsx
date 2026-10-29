import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { AuthSession } from './auth.js';
import type { ApiAuthRequired } from './api-auth.js';
import type { AttemptApi } from './attempt-api.js';
import type { DraftApi } from './draft-api.js';
import type { SavedRobotApi } from './saved-robot-api.js';
import { CoursePreview } from './replay/ReplayScene.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';
import { SavedRobots, type SavedRobotsHandle } from './SavedRobots.js';
import { useAttemptActivity } from './useAttemptActivity.js';

type WorkspaceSurface = 'preparar' | 'historial' | 'mis-robots';

export interface GameWorkspaceHandle {
  start(): void;
  returnToEditor(): void;
}

export interface GameWorkspaceProps {
  readonly attemptApi: AttemptApi;
  readonly draftApi: DraftApi;
  readonly savedRobotApi?: SavedRobotApi | null;
  readonly session: AuthSession;
  readonly editor: RefObject<RobotEditorHandle | null>;
  readonly configurationAvailable?: boolean;
  readonly onConfigurationAvailabilityChange?: (available: boolean) => void;
  readonly accessState?: 'ready' | 'checking' | 'required';
  readonly authPaused?: boolean;
  readonly onAuthRequired?: ApiAuthRequired;
  readonly onTry?: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onTryAvailabilityChange?: (available: boolean) => void;
}

function surfaceHeading(surface: WorkspaceSurface): string {
  switch (surface) {
    case 'preparar':
      return 'robot-editor-title';
    case 'historial':
      return 'attempt-history-title';
    case 'mis-robots':
      return 'saved-robots-title';
  }
}

export const GameWorkspace = forwardRef<GameWorkspaceHandle, GameWorkspaceProps>(
  function GameWorkspace(
    {
      attemptApi,
      draftApi,
      savedRobotApi,
      session,
      editor,
      configurationAvailable = true,
      onConfigurationAvailabilityChange,
      accessState = 'checking',
      authPaused = false,
      onAuthRequired,
      onTry,
      onBusyChange,
      onTryAvailabilityChange,
    },
    ref,
  ) {
    const [surface, setSurface] = useState<WorkspaceSurface>('preparar');
    const pendingFocusRef = useRef<WorkspaceSurface | null>(null);
    const previousForegroundRef = useRef(false);
    const savedRobotsRef = useRef<SavedRobotsHandle | null>(null);

    const focusCurrentSurface = useCallback(
      (target: WorkspaceSurface): void => {
        const heading = document.getElementById(surfaceHeading(target));
        if (!heading) return;
        if (target === 'preparar' && editor.current?.focusEditor) {
          editor.current.focusEditor();
          return;
        }
        heading.focus({ preventScroll: true });
      },
      [editor],
    );

    const revealPreparation = useCallback((): void => {
      if (surface === 'mis-robots') savedRobotsRef.current?.leaveSurface();
      const heading = document.getElementById(surfaceHeading('preparar'));
      if (surface !== 'preparar' || heading?.closest('[hidden]')) {
        editor.current?.openActiveSkillDescriptions?.();
      }
      pendingFocusRef.current = 'preparar';
      setSurface('preparar');
      if (surface === 'preparar' && heading && !heading.closest('[hidden]')) {
        pendingFocusRef.current = null;
        focusCurrentSurface('preparar');
      }
    }, [editor, focusCurrentSurface, surface]);

    const activity = useAttemptActivity({
      api: attemptApi,
      editor,
      session,
      configurationAvailable,
      authPaused,
      accessState,
      onBusyChange,
      onTryAvailabilityChange,
      onAuthRequired,
      onReturnToEditor: revealPreparation,
      surface,
    });
    const activityStart = activity.start;
    const activityReturnToEditor = activity.returnToEditor;
    const leaveResultPresentation = activity.leaveResultPresentation;
    const activityResultVisible = activity.resultVisible;
    const attemptForeground = activity.foreground;
    const returnToEditor = activityReturnToEditor;

    const enterSurface = useCallback(
      (next: WorkspaceSurface): void => {
        if (attemptForeground) return;
        if (next === 'preparar') {
          activityReturnToEditor();
          return;
        }
        if (surface === 'mis-robots' && next !== 'mis-robots') {
          savedRobotsRef.current?.leaveSurface();
        }
        if (
          next !== surface &&
          (activityResultVisible || activity.historyResultOpen || activity.queryVisible)
        ) {
          leaveResultPresentation();
        }
        pendingFocusRef.current = next;
        setSurface(next);
        if (next === surface) {
          pendingFocusRef.current = null;
          focusCurrentSurface(next);
        }
      },
      [
        activity.historyResultOpen,
        activity.queryVisible,
        activityResultVisible,
        activityReturnToEditor,
        attemptForeground,
        focusCurrentSurface,
        leaveResultPresentation,
        surface,
      ],
    );

    useImperativeHandle(ref, () => ({ start: activityStart, returnToEditor }), [
      activityStart,
      returnToEditor,
    ]);

    useLayoutEffect(() => {
      const target = pendingFocusRef.current;
      if (target === null || target !== surface) return;
      const heading = document.getElementById(surfaceHeading(target));
      if (!heading || heading.closest('[hidden]')) return;
      pendingFocusRef.current = null;
      focusCurrentSurface(target);
    }, [activity.queryVisible, activity.resultVisible, focusCurrentSurface, surface]);

    useLayoutEffect(() => {
      if (activity.foreground && !previousForegroundRef.current) {
        if (surface === 'mis-robots') savedRobotsRef.current?.leaveSurface();
        const heading = document.getElementById('attempt-workspace-title');
        if (heading?.isConnected) heading.focus();
      }
      previousForegroundRef.current = activity.foreground;
    }, [activity.foreground, surface]);

    const hiddenPreparation =
      surface !== 'preparar' ||
      attemptForeground ||
      activity.resultVisible ||
      activity.queryVisible;
    const hiddenActivity =
      !attemptForeground &&
      (activity.queryVisible ||
        surface === 'mis-robots' ||
        (surface === 'historial' && !activity.historyResultOpen) ||
        (surface === 'preparar' && !activity.busy && !activity.resultVisible));
    const hiddenLibrary = surface !== 'mis-robots' || attemptForeground;
    const hiddenHistory =
      surface !== 'historial' ||
      attemptForeground ||
      activity.historyResultOpen ||
      activity.queryVisible;
    const hiddenHistoryResult =
      surface !== 'historial' ||
      attemptForeground ||
      !activity.historyQueryOpen ||
      activity.configurationOpen ||
      activity.inspectorOpen;
    const hiddenConfiguration =
      !activity.configurationOpen || attemptForeground || activity.inspectorOpen;
    const hiddenInspector = !activity.inspectorActive || attemptForeground;

    return (
      <div className="game-workspace">
        <nav className="workspace-navigation" aria-label="Navegación principal">
          {(['preparar', 'historial', 'mis-robots'] as const).map((item) => {
            const label =
              item === 'preparar' ? 'Preparar' : item === 'historial' ? 'Historial' : 'Mis robots';
            return (
              <button
                key={item}
                className="workspace-navigation-button"
                type="button"
                aria-current={surface === item ? 'page' : undefined}
                aria-describedby={attemptForeground ? 'workspace-activity-lock' : undefined}
                disabled={attemptForeground}
                onClick={() => enterSurface(item)}
              >
                {label}
              </button>
            );
          })}
        </nav>

        {attemptForeground && (
          <p id="workspace-activity-lock" className="workspace-activity-lock" role="status">
            El intento está en primer plano. Esperá a que termine para cambiar de sección.
          </p>
        )}

        <section
          className="preparation-layout workspace-surface"
          aria-label="Preparar"
          hidden={hiddenPreparation}
        >
          <CoursePreview locked={activity.busy} />
          <RobotEditor
            ref={editor}
            api={draftApi}
            session={session}
            accessState={accessState}
            paused={authPaused}
            locked={activity.busy}
            tryUnavailable={!activity.tryAvailable}
            onTry={onTry ?? activity.start}
            attemptControls={activity.controls}
            onAuthRequired={onAuthRequired}
            onConfigurationAvailabilityChange={onConfigurationAvailabilityChange}
          />
        </section>

        <section
          className="workspace-surface"
          aria-label={surface === 'historial' ? 'Historial y actividad' : 'Actividad del intento'}
          hidden={hiddenActivity}
        >
          {activity.view}
        </section>

        <section
          className="workspace-surface"
          aria-label="Historial de intentos"
          hidden={hiddenHistory}
        >
          {activity.historyView}
        </section>

        <section
          className="workspace-surface"
          aria-label="Resultado consultado"
          hidden={hiddenHistoryResult}
        >
          {activity.historyResultView}
        </section>

        <section
          className="workspace-surface"
          aria-label="Configuración consultada"
          hidden={hiddenConfiguration}
        >
          {activity.configurationView}
        </section>

        <section
          className="workspace-surface"
          aria-label="Inspector de decisiones"
          hidden={hiddenInspector}
        >
          {activity.inspectorView}
        </section>

        <section className="workspace-surface" hidden={hiddenLibrary}>
          {savedRobotApi ? (
            <SavedRobots
              key={session.identity.sub}
              ref={savedRobotsRef}
              api={savedRobotApi}
              editor={editor}
              session={session}
              configurationAvailable={configurationAvailable && !authPaused}
              accessState={accessState}
              paused={authPaused}
              locked={activity.busy}
              onAuthRequired={onAuthRequired}
              onReturnToEditor={returnToEditor}
            />
          ) : (
            <section className="notice" aria-labelledby="saved-robots-title">
              <h2 id="saved-robots-title" tabIndex={-1}>
                Tus robots
              </h2>
              <p>La biblioteca no está disponible en esta sesión.</p>
            </section>
          )}
        </section>
      </div>
    );
  },
);

GameWorkspace.displayName = 'GameWorkspace';
