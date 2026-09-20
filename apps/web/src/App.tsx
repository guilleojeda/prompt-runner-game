import { useEffect, useRef, useState } from 'react';
import {
  AuthFailure,
  type AuthClient,
  type AuthConfig,
  type AuthIdentity,
  type AuthSession,
  createAuthClient,
  loadAuthConfig,
} from './auth.js';

type AppPhase = 'loading' | 'visitor' | 'signing-in' | 'account' | 'logging-out' | 'error';
type RetryAction = 'config' | 'restore' | 'login' | 'logout';

export interface AppProps {
  authClient?: AuthClient;
  configLoader?: () => Promise<AuthConfig>;
  clientFactory?: (config: AuthConfig) => AuthClient;
}

function errorMessage(error: unknown): string {
  if (error instanceof AuthFailure) {
    return error.message;
  }
  return 'No se pudo completar la operación. Intentá de nuevo.';
}

function LoginCard({ onLogin, busy }: { onLogin: () => void; busy: boolean }) {
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
        <button className="primary-button" type="button" onClick={onLogin} disabled={busy}>
          {busy ? 'Abriendo acceso…' : 'Entrar o crear una cuenta'}
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
        <button className="secondary-button" type="button" onClick={onLogout} disabled={busy}>
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
  configLoader = loadAuthConfig,
  clientFactory = createAuthClient,
}: AppProps) {
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [hasClient, setHasClient] = useState(Boolean(authClient));
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null);
  const clientRef = useRef<AuthClient | null>(authClient ?? null);
  const initializationRef = useRef<Promise<AuthSession | null> | null>(null);

  useEffect(() => {
    let active = true;
    if (!initializationRef.current) {
      initializationRef.current = (async (): Promise<AuthSession | null> => {
        const client = clientRef.current ?? clientFactory(await configLoader());
        clientRef.current = client;
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
      setSession(session);
      setPhase(session ? 'account' : 'visitor');
      setError(null);
      setRetryAction(null);
    }
  }, [clientFactory, configLoader, initializationAttempt]);

  useEffect(() => {
    const expiresAt = session?.user.expires_at;
    const client = clientRef.current;
    if (phase !== 'account' || !expiresAt || !client) {
      return undefined;
    }

    const delay = Math.max(1, expiresAt * 1000 - Date.now());
    const timer = window.setTimeout(() => {
      setSession(null);
      setError(null);
      setPhase('loading');
      void client
        .initialize()
        .then((renewedSession) => {
          setSession(renewedSession);
          setPhase(renewedSession ? 'account' : 'visitor');
          setRetryAction(null);
        })
        .catch((renewalError: unknown) => {
          setError(errorMessage(renewalError));
          setRetryAction(retryActionForError(renewalError, true));
          setPhase('error');
        });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [phase, session?.user.expires_at]);

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

  const logout = async () => {
    const client = clientRef.current;
    setSession(null);
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

  const restoreSession = async () => {
    const client = clientRef.current;
    if (!client) {
      setRetryAction('config');
      setPhase('error');
      setError('La configuración de acceso todavía no está lista.');
      return;
    }
    setSession(null);
    setError(null);
    setPhase('loading');
    try {
      const restoredSession = await client.initialize();
      setSession(restoredSession);
      setRetryAction(null);
      setPhase(restoredSession ? 'account' : 'visitor');
    } catch (restoreError) {
      setError(errorMessage(restoreError));
      setRetryAction(retryActionForError(restoreError, true));
      setPhase('error');
    }
  };

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

      {phase === 'visitor' && <LoginCard onLogin={() => void beginLogin()} busy={false} />}
      {phase === 'signing-in' && <LoginCard onLogin={() => void beginLogin()} busy />}
      {phase === 'account' && session && (
        <AccountCard identity={session.identity} onLogout={() => void logout()} busy={false} />
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
        {phase === 'account'
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
