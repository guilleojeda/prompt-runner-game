import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthFailure,
  type AuthClient,
  type AuthConfig,
  type AuthIdentity,
  type AuthSession,
  createAuthClient,
  loadAuthConfig,
} from './auth.js';
import { createDraftApiClient, type DraftApi } from './draft-api.js';
import { RobotEditor, type RobotEditorHandle } from './RobotEditor.js';
import { createAttemptApiClient, type AttemptApi } from './attempt-api.js';
import { AttemptWorkspace, type AttemptWorkspaceHandle } from './AttemptWorkspace.js';
import {
  CognitoPendingConfirmationClient,
  ConfirmationFailure,
  type PendingConfirmationClient,
} from './pending-confirmation.js';

type AppPhase =
  | 'loading'
  | 'visitor'
  | 'signing-in'
  | 'account'
  | 'logging-out'
  | 'pending-confirmation'
  | 'error';
type RetryAction = 'config' | 'restore' | 'login' | 'logout';
type ConfirmationOperation = 'confirm' | 'resend' | null;

export interface AppProps {
  authClient?: AuthClient;
  draftApi?: DraftApi;
  attemptApi?: AttemptApi;
  confirmationClient?: PendingConfirmationClient;
  configLoader?: () => Promise<AuthConfig>;
  clientFactory?: (config: AuthConfig) => AuthClient;
  draftApiFactory?: (config: AuthConfig, tokenProvider: () => string) => DraftApi;
  attemptApiFactory?: (config: AuthConfig, tokenProvider: () => string) => AttemptApi;
  confirmationClientFactory?: (config: AuthConfig) => PendingConfirmationClient;
}

function errorMessage(error: unknown): string {
  if (error instanceof AuthFailure) {
    return error.message;
  }
  return 'No se pudo completar la operación. Intentá de nuevo.';
}

function confirmationErrorMessage(error: unknown): string {
  if (error instanceof ConfirmationFailure) {
    return error.message;
  }
  return 'No se pudo completar la confirmación. Intentá de nuevo.';
}

function createDefaultConfirmationClient(config: AuthConfig): PendingConfirmationClient {
  return new CognitoPendingConfirmationClient(config);
}

function LoginCard({
  onLogin,
  onPendingConfirmation,
  busy,
  message,
}: {
  onLogin: () => void;
  onPendingConfirmation: () => void;
  busy: boolean;
  message: string | null;
}) {
  return (
    <section className="auth-card" aria-labelledby="access-title">
      <div className="robot" aria-hidden="true">
        <span className="robot-eye" />
        <span className="robot-eye" />
      </div>
      <div className="auth-card-content">
        <p className="card-kicker">Acceso seguro</p>
        <h2 id="access-title">Entrá para continuar</h2>
        <p>Registrate con tu email o ingresá a tu cuenta.</p>
        {message && (
          <p className="confirmation-success" role="status" aria-live="polite">
            {message}
          </p>
        )}
        <button className="primary-button" type="button" onClick={onLogin} disabled={busy}>
          {busy ? 'Abriendo acceso…' : 'Entrar o crear una cuenta'}
        </button>
        <button
          className="text-button"
          type="button"
          onClick={onPendingConfirmation}
          disabled={busy}
        >
          Confirmar una cuenta pendiente
        </button>
      </div>
    </section>
  );
}

function PendingConfirmationCard({
  onBack,
  onConfirm,
  onResend,
  busy,
  error,
  message,
  operation,
}: {
  onBack: () => void;
  onConfirm: (email: string, code: string) => void;
  onResend: (email: string) => void;
  busy: boolean;
  error: string | null;
  message: string | null;
  operation: ConfirmationOperation;
}) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  return (
    <section className="auth-card confirmation-card" aria-labelledby="confirmation-title">
      <div className="account-mark" aria-hidden="true">
        @
      </div>
      <div className="auth-card-content">
        <p className="card-kicker">Confirmación de email</p>
        <h2 id="confirmation-title">Retomá tu cuenta</h2>
        <p>Usá el código que recibiste para confirmar el email con el que te registraste.</p>
        {error && (
          <p className="form-error" role="alert" aria-live="assertive">
            {error}
          </p>
        )}
        {message && (
          <p className="confirmation-success" role="status" aria-live="polite">
            {message}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(email, code);
          }}
        >
          <label htmlFor="pending-email">Email</label>
          <input
            id="pending-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            disabled={busy}
          />
          <label htmlFor="pending-code">Código de confirmación</label>
          <input
            id="pending-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
            disabled={busy}
          />
          <button className="primary-button" type="submit" disabled={busy}>
            {operation === 'confirm' ? 'Confirmando…' : 'Confirmar email'}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onResend(email)}
            disabled={busy || !email.trim()}
          >
            {operation === 'resend' ? 'Reenviando…' : 'Reenviar código'}
          </button>
        </form>
        <button className="text-button" type="button" onClick={onBack} disabled={busy}>
          Volver al ingreso
        </button>
      </div>
    </section>
  );
}

function AccountCard({
  identity,
  onLogout,
  busy,
}: {
  identity: AuthIdentity;
  onLogout: () => void;
  busy: boolean;
}) {
  return (
    <section className="auth-card account-card" aria-labelledby="account-title">
      <div className="account-mark" aria-hidden="true">
        ✓
      </div>
      <div className="auth-card-content">
        <p className="card-kicker">Cuenta confirmada</p>
        <h2 id="account-title">Cuenta confirmada</h2>
        <p>
          Sesión activa para <strong>{identity.email}</strong>.
        </p>
        <button
          className="secondary-button"
          type="button"
          onClick={onLogout}
          disabled={busy}
          aria-label="Cerrar sesión"
        >
          {busy ? 'Cerrando sesión…' : 'Cerrar sesión'}
        </button>
      </div>
    </section>
  );
}

function ErrorNotice({
  message,
  onRetry,
  retryLabel,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <section className="notice error-notice" role="alert" aria-live="assertive">
      <p>{message}</p>
      {onRetry && (
        <button className="secondary-button" type="button" onClick={onRetry}>
          {retryLabel ?? 'Reintentar'}
        </button>
      )}
    </section>
  );
}

export function App({
  authClient,
  draftApi,
  attemptApi,
  confirmationClient,
  configLoader = loadAuthConfig,
  clientFactory = createAuthClient,
  draftApiFactory = (config, tokenProvider) => createDraftApiClient(config, tokenProvider),
  attemptApiFactory = (config, tokenProvider) => createAttemptApiClient(config, tokenProvider),
  confirmationClientFactory = createDefaultConfirmationClient,
}: AppProps) {
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [hasClient, setHasClient] = useState(Boolean(authClient));
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [confirmationMessage, setConfirmationMessage] = useState<string | null>(null);
  const [confirmationOperation, setConfirmationOperation] = useState<ConfirmationOperation>(null);
  const [renewing, setRenewing] = useState(false);
  const [logoutPrompt, setLogoutPrompt] = useState(false);
  const [logoutChoiceBusy, setLogoutChoiceBusy] = useState(false);
  const [apiAuthError, setApiAuthError] = useState(false);
  const [editorApi, setEditorApi] = useState<DraftApi | null>(draftApi ?? null);
  const [runnerApi, setRunnerApi] = useState<AttemptApi | null>(attemptApi ?? null);
  const [editorConfig, setEditorConfig] = useState<AuthConfig | null>(null);
  const [attemptBusy, setAttemptBusy] = useState(false);
  const clientRef = useRef<AuthClient | null>(authClient ?? null);
  const configRef = useRef<AuthConfig | null>(null);
  const draftApiRef = useRef<DraftApi | null>(draftApi ?? null);
  const runnerApiRef = useRef<AttemptApi | null>(attemptApi ?? null);
  const currentSessionRef = useRef<AuthSession | null>(null);
  const editorRef = useRef<RobotEditorHandle | null>(null);
  const attemptWorkspaceRef = useRef<AttemptWorkspaceHandle | null>(null);
  const logoutAttemptRef = useRef(0);
  const draftApiFactoryRef = useRef(draftApiFactory);
  const attemptApiFactoryRef = useRef(attemptApiFactory);
  const confirmationRef = useRef<PendingConfirmationClient | null>(confirmationClient ?? null);
  const initializationRef = useRef<Promise<AuthSession | null> | null>(null);

  useEffect(() => {
    let active = true;
    if (!initializationRef.current) {
      initializationRef.current = (async (): Promise<AuthSession | null> => {
        let client = clientRef.current;
        if (!client) {
          const config = await configLoader();
          configRef.current = config;
          setEditorConfig(config);
          const nextClient = clientFactory(config);
          const nextConfirmationClient =
            confirmationRef.current ?? confirmationClientFactory(config);
          clientRef.current = nextClient;
          confirmationRef.current = nextConfirmationClient;
          client = nextClient;
          draftApiRef.current ??= draftApiFactoryRef.current(
            config,
            () => currentSessionRef.current?.user.access_token ?? '',
          );
          setEditorApi(draftApiRef.current);
          runnerApiRef.current ??= attemptApiFactoryRef.current(
            config,
            () => currentSessionRef.current?.user.access_token ?? '',
          );
          setRunnerApi(runnerApiRef.current);
        } else if (draftApiRef.current && !configRef.current) {
          const config = await configLoader();
          configRef.current = config;
          setEditorConfig(config);
          runnerApiRef.current ??= attemptApiFactoryRef.current(
            config,
            () => currentSessionRef.current?.user.access_token ?? '',
          );
          setRunnerApi(runnerApiRef.current);
        }
        setHasClient(true);
        return client.initialize();
      })();
    }
    void initializationRef.current
      .then((initializedSession) => {
        if (!active) {
          return;
        }
        applySession(initializedSession);
      })
      .catch((initializationError: unknown) => {
        if (!active) {
          return;
        }
        setError(errorMessage(initializationError));
        setRetryAction(retryActionForError(initializationError, clientRef.current !== null));
        setPhase('error');
      });
    return () => {
      active = false;
    };

    function applySession(session: AuthSession | null): void {
      currentSessionRef.current = session;
      setSession(session);
      setRenewing(false);
      setApiAuthError(false);
      setPhase(session ? 'account' : 'visitor');
      setError(null);
      setRetryAction(null);
    }
  }, [clientFactory, configLoader, confirmationClientFactory, initializationAttempt]);

  useEffect(() => {
    const expiresAt = session?.user.expires_at;
    const client = clientRef.current;
    if (phase !== 'account' || !expiresAt || !client) {
      return undefined;
    }

    const delay = Math.max(1, expiresAt * 1000 - Date.now());
    const timer = window.setTimeout(() => {
      setRenewing(true);
      setError(null);
      setPhase('loading');
      void client
        .initialize()
        .then((renewedSession) => {
          const sameIdentity =
            renewedSession !== null && renewedSession.identity.sub === session.identity.sub;
          currentSessionRef.current = sameIdentity ? renewedSession : null;
          setRenewing(false);
          setSession(sameIdentity ? renewedSession : null);
          setPhase(sameIdentity ? 'account' : 'visitor');
          setRetryAction(null);
        })
        .catch((renewalError: unknown) => {
          setError(errorMessage(renewalError));
          setRetryAction(retryActionForError(renewalError, true));
          setRenewing(true);
          setPhase('error');
        });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [phase, session?.identity.sub, session?.user.expires_at]);

  const beginLogin = async () => {
    const client = clientRef.current;
    if (!client) {
      setError('La configuración de acceso todavía no está lista.');
      setRetryAction('config');
      setPhase('error');
      return;
    }
    setError(null);
    setPhase('signing-in');
    setRetryAction(null);
    try {
      await client.beginLogin();
    } catch (loginError) {
      setError(errorMessage(loginError));
      setRetryAction('login');
      setPhase('error');
    }
  };

  const showPendingConfirmation = () => {
    setConfirmationError(null);
    setConfirmationMessage(null);
    setPhase('pending-confirmation');
  };

  const ensureConfirmationClient = async (): Promise<PendingConfirmationClient | null> => {
    if (confirmationRef.current) {
      return confirmationRef.current;
    }
    try {
      const config = await configLoader();
      const nextClient = confirmationClientFactory(config);
      confirmationRef.current = nextClient;
      return nextClient;
    } catch (configurationError) {
      setConfirmationError(errorMessage(configurationError));
      return null;
    }
  };

  const confirmPending = async (email: string, code: string) => {
    setConfirmationError(null);
    setConfirmationMessage(null);
    setConfirmationBusy(true);
    setConfirmationOperation('confirm');
    const client = await ensureConfirmationClient();
    if (!client) {
      setConfirmationBusy(false);
      setConfirmationOperation(null);
      return;
    }
    try {
      await client.confirm(email, code);
      setConfirmationMessage('Email confirmado. Ahora ingresá para continuar.');
      setPhase('visitor');
    } catch (confirmationFailure) {
      setConfirmationError(confirmationErrorMessage(confirmationFailure));
    } finally {
      setConfirmationBusy(false);
      setConfirmationOperation(null);
    }
  };

  const resendPending = async (email: string) => {
    setConfirmationError(null);
    setConfirmationMessage(null);
    setConfirmationBusy(true);
    setConfirmationOperation('resend');
    const client = await ensureConfirmationClient();
    if (!client) {
      setConfirmationBusy(false);
      setConfirmationOperation(null);
      return;
    }
    try {
      await client.resend(email);
      setConfirmationMessage(
        'Te enviamos un nuevo código. Usá ese código para confirmar tu email.',
      );
    } catch (confirmationFailure) {
      setConfirmationError(confirmationErrorMessage(confirmationFailure));
    } finally {
      setConfirmationBusy(false);
      setConfirmationOperation(null);
    }
  };

  const performLogout = async () => {
    logoutAttemptRef.current += 1;
    const client = clientRef.current;
    currentSessionRef.current = null;
    setSession(null);
    setRenewing(false);
    setLogoutPrompt(false);
    if (!client) {
      setPhase('visitor');
      return;
    }
    setError(null);
    setPhase('logging-out');
    try {
      await client.logout();
      setRetryAction(null);
      setPhase('visitor');
    } catch (logoutError) {
      setSession(null);
      setError(errorMessage(logoutError));
      setRetryAction('logout');
      setPhase('error');
    }
  };

  const logout = () => {
    if (attemptBusy) {
      return;
    }
    if (editorRef.current?.hasUnconfirmedChanges()) {
      setLogoutPrompt(true);
      return;
    }
    void performLogout();
  };

  const waitAndLogout = async () => {
    const attempt = logoutAttemptRef.current + 1;
    logoutAttemptRef.current = attempt;
    setLogoutChoiceBusy(true);
    const saved = await editorRef.current?.flushPending();
    if (logoutAttemptRef.current !== attempt) {
      return;
    }
    setLogoutChoiceBusy(false);
    if (saved) {
      await performLogout();
    }
  };

  const discardAndLogout = () => {
    logoutAttemptRef.current += 1;
    setLogoutChoiceBusy(false);
    editorRef.current?.discardPending();
    void performLogout();
  };

  const restoreSession = async () => {
    const client = clientRef.current;
    if (!client) {
      setRetryAction('config');
      setPhase('error');
      setError('La configuración de acceso todavía no está lista.');
      return;
    }
    if (!renewing) {
      setSession(null);
      currentSessionRef.current = null;
    }
    setError(null);
    setPhase('loading');
    try {
      const restoredSession = await client.initialize();
      const previous = currentSessionRef.current;
      const sameIdentity =
        restoredSession !== null &&
        (previous === null || restoredSession.identity.sub === previous.identity.sub);
      currentSessionRef.current = sameIdentity ? restoredSession : null;
      setRenewing(false);
      setSession(sameIdentity ? restoredSession : null);
      setRetryAction(null);
      setPhase(sameIdentity ? 'account' : 'visitor');
    } catch (restoreError) {
      setError(errorMessage(restoreError));
      setRetryAction(retryActionForError(restoreError, true));
      setPhase('error');
    }
  };

  const handleAttemptBusyChange = useCallback((busy: boolean): void => {
    setAttemptBusy(busy);
    if (!busy) {
      editorRef.current?.releaseAttemptLock();
    }
  }, []);

  const handleApiAuthRequired = useCallback((): void => {
    setApiAuthError(true);
  }, []);

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Taller de agentes</p>
        <h1>Enseñale a jugar al robot</h1>
        <p className="intro">
          Configurá sus instrucciones y observá cómo decide recorrer el mundo, una decisión a la
          vez.
        </p>
      </header>

      {phase === 'loading' && (
        <section className="notice" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <p>Comprobando tu sesión…</p>
        </section>
      )}

      {phase === 'visitor' && (
        <LoginCard
          onLogin={() => void beginLogin()}
          onPendingConfirmation={showPendingConfirmation}
          busy={false}
          message={confirmationMessage}
        />
      )}
      {phase === 'signing-in' && (
        <LoginCard
          onLogin={() => void beginLogin()}
          onPendingConfirmation={showPendingConfirmation}
          busy
          message={confirmationMessage}
        />
      )}
      {phase === 'pending-confirmation' && (
        <PendingConfirmationCard
          onBack={() => {
            setConfirmationError(null);
            setConfirmationMessage(null);
            setPhase('visitor');
          }}
          onConfirm={(email, code) => void confirmPending(email, code)}
          onResend={(email) => void resendPending(email)}
          busy={confirmationBusy}
          error={confirmationError}
          message={confirmationMessage}
          operation={confirmationOperation}
        />
      )}
      {phase === 'account' && session && (
        <AccountCard identity={session.identity} onLogout={logout} busy={attemptBusy || renewing} />
      )}
      {session &&
        (phase === 'account' ||
          phase === 'loading' ||
          phase === 'error' ||
          phase === 'signing-in') && (
          <>
            {editorApi && editorConfig && session.user.scopes.includes(editorConfig.apiScope) && (
              <RobotEditor
                ref={editorRef}
                api={editorApi}
                session={session}
                paused={renewing || phase !== 'account' || apiAuthError}
                locked={attemptBusy}
                onTry={runnerApi ? () => attemptWorkspaceRef.current?.start() : undefined}
                onAuthRequired={handleApiAuthRequired}
              />
            )}
            {runnerApi &&
              editorApi &&
              editorConfig &&
              session.user.scopes.includes(editorConfig.apiScope) && (
                <AttemptWorkspace
                  ref={attemptWorkspaceRef}
                  api={runnerApi}
                  editor={editorRef}
                  session={session}
                  authPaused={renewing || phase !== 'account' || apiAuthError}
                  onBusyChange={handleAttemptBusyChange}
                  onAuthRequired={handleApiAuthRequired}
                />
              )}
            {editorApi && editorConfig && !session.user.scopes.includes(editorConfig.apiScope) && (
              <section className="notice error-notice" role="alert">
                <p>Para guardar tu robot, necesitás volver a ingresar con tu cuenta.</p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void beginLogin()}
                >
                  Volver a ingresar
                </button>
              </section>
            )}
            {apiAuthError && (
              <section className="notice error-notice" role="alert">
                <p>
                  La sesión dejó de tener acceso a esta cuenta. Volvé a ingresar para continuar.
                </p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void beginLogin()}
                >
                  Volver a ingresar
                </button>
              </section>
            )}
          </>
        )}
      {logoutPrompt && session && (
        <section
          className="notice logout-prompt"
          role="alert"
          aria-labelledby="logout-prompt-title"
        >
          <div>
            <h2 id="logout-prompt-title">Tenés cambios sin confirmar</h2>
            <p>
              Elegí si querés esperar el guardado, reintentarlo o descartar esos cambios antes de
              cerrar sesión. Una escritura que ya salió puede haberse guardado; al descartar se
              pierden los cambios locales pendientes.
            </p>
          </div>
          <div className="editor-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => void waitAndLogout()}
              disabled={logoutChoiceBusy}
            >
              {logoutChoiceBusy ? 'Esperando guardado…' : 'Esperar guardado'}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void waitAndLogout()}
              disabled={logoutChoiceBusy}
            >
              Reintentar guardado
            </button>
            <button className="text-button" type="button" onClick={discardAndLogout}>
              Descartar cambios locales y salir
            </button>
          </div>
        </section>
      )}
      {phase === 'logging-out' && session === null && (
        <section className="notice" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <p>Cerrando tu sesión…</p>
        </section>
      )}
      {phase === 'error' && error && (
        <ErrorNotice
          message={error}
          onRetry={() => {
            if (retryAction === 'config') {
              initializationRef.current = null;
              setError(null);
              setPhase('loading');
              setInitializationAttempt((attempt) => attempt + 1);
            } else if (retryAction === 'restore') {
              void restoreSession();
            } else if (retryAction === 'logout') {
              void logout();
            } else {
              void beginLogin();
            }
          }}
          retryLabel={retryLabel(retryAction, hasClient)}
        />
      )}

      <p className="status" role="status">
        {apiAuthError
          ? 'La sesión necesita volver a validarse antes de continuar.'
          : phase === 'account'
            ? 'Tu cuenta está confirmada y la sesión es válida.'
            : 'El acceso, la confirmación y la recuperación se realizan en una página segura.'}
      </p>
    </main>
  );
}

function retryActionForError(error: unknown, hasClient: boolean): RetryAction {
  if (!hasClient) {
    return 'config';
  }
  return error instanceof AuthFailure && error.code === 'callback' ? 'login' : 'restore';
}

function retryLabel(action: RetryAction | null, hasClient: boolean): string {
  if (action === 'config' || !hasClient) {
    return 'Reintentar';
  }
  if (action === 'restore') {
    return 'Revalidar sesión';
  }
  if (action === 'logout') {
    return 'Completar cierre remoto';
  }
  return 'Volver a entrar';
}
