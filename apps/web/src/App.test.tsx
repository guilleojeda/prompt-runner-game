// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AuthFailure, type AuthClient, type AuthConfig, type AuthSession } from './auth.js';
import { DraftApiClient, type DraftApi } from './draft-api.js';
import type { AttemptApi } from './attempt-api.js';
import type { PendingConfirmationClient } from './pending-confirmation.js';
import { createDefaultDraft, type DraftSnapshot } from '../../../shared/robot.js';

const config: AuthConfig = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'client-public',
  domain: 'https://prompt-runner.auth.us-east-1.amazoncognito.com',
  redirectUri: 'https://d1ilpq1n58tzqo.cloudfront.net/',
  logoutUri: 'https://d1ilpq1n58tzqo.cloudfront.net/',
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};

const invalidConfirmationConfig: AuthConfig = {
  ...config,
  issuer: 'https://invalid.example/us-east-1_test',
};

function session(
  email = 'a@example.com',
  expiresAt = Math.floor(Date.now() / 1000) + 600,
  accessToken = 'access-token',
  sub = 'subject-a',
): AuthSession {
  return {
    identity: { sub, email },
    user: new User({
      access_token: accessToken,
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      session_state: null,
      profile: {
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
        aud: 'client-public',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        sub,
        email,
      },
      expires_at: expiresAt,
    }),
  };
}

function client(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    initialize: vi.fn().mockResolvedValue(null),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function emptyAttemptApi(): AttemptApi {
  return {
    createAttempt: vi.fn(),
    getAttemptRequest: vi.fn(),
    getAttempt: vi.fn(),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-09-21',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: '2026-09-22T03:00:00.000Z',
    }),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('access screen', () => {
  it('does not remain loading when StrictMode runs the effect twice', async () => {
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });

    render(
      <StrictMode>
        <App authClient={authClient} />
      </StrictMode>,
    );

    expect(await screen.findByText('a@example.com')).toBeTruthy();
    expect(authClient.initialize).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows a visitor and starts managed access from the visible button', async () => {
    const beginLogin = vi.fn().mockResolvedValue(undefined);
    const authClient = client({ beginLogin });
    render(<App authClient={authClient} />);

    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Entrar o crear una cuenta' }));
    await waitFor(() => expect(beginLogin).toHaveBeenCalledOnce());
  });

  it('confirms a pending account with an already received code before any resend', async () => {
    const authClient = client();
    const confirmationClient: PendingConfirmationClient = {
      confirm: vi.fn().mockResolvedValue(undefined),
      resend: vi.fn().mockResolvedValue(undefined),
    };
    render(<App authClient={authClient} confirmationClient={confirmationClient} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar una cuenta pendiente' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'pending@example.com' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Código de confirmación' }), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar email' }));

    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(confirmationClient.confirm).toHaveBeenCalledWith('pending@example.com', '123456');
    expect(confirmationClient.resend).not.toHaveBeenCalled();
    expect(authClient.beginLogin).not.toHaveBeenCalled();
    expect(screen.queryByText('Cuenta confirmada')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
    expect(screen.getByText('Email confirmado. Ahora ingresá para continuar.')).toBeTruthy();
  });

  it('clears resend success before a failed confirmation and shows operation-specific busy text', async () => {
    let releaseResend!: () => void;
    const confirmationClient: PendingConfirmationClient = {
      confirm: vi.fn().mockRejectedValue(new Error('código inválido')),
      resend: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseResend = resolve;
          }),
      ),
    };
    render(<App authClient={client()} confirmationClient={confirmationClient} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar una cuenta pendiente' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'pending@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar código' }));
    expect(await screen.findByRole('button', { name: 'Reenviando…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirmar email' })).toBeTruthy();
    releaseResend();
    expect(
      await screen.findByText(
        'Te enviamos un nuevo código. Usá ese código para confirmar tu email.',
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Código de confirmación' }), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar email' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No se pudo completar la confirmación',
    );
    expect(
      screen.queryByText('Te enviamos un nuevo código. Usá ese código para confirmar tu email.'),
    ).toBeNull();
  });

  it('keeps a remote logout failure without rendering the prior identity', async () => {
    const authClient = client({
      initialize: vi.fn().mockResolvedValue(session()),
      logout: vi
        .fn()
        .mockRejectedValue(
          new AuthFailure(
            'logout',
            'Se cerró la sesión local, pero no se pudo completar el cierre remoto.',
          ),
        ),
    });
    render(<App authClient={authClient} />);

    await screen.findByText('a@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'no se pudo completar el cierre remoto',
    );
    expect(screen.queryByText('a@example.com')).toBeNull();
    expect(screen.getByRole('button', { name: 'Completar cierre remoto' })).toBeTruthy();
  });

  it('retries a configuration failure and reaches the visitor state', async () => {
    const authClient = client();
    const configLoader = vi
      .fn<() => Promise<AuthConfig>>()
      .mockRejectedValueOnce(
        new AuthFailure('configuration', 'La configuración no está disponible.'),
      )
      .mockResolvedValue(config);
    const clientFactory = vi.fn().mockReturnValue(authClient);
    render(<App configLoader={configLoader} clientFactory={clientFactory} />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'configuración no está disponible',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(configLoader).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenCalledOnce();
  });

  it('reloads config when a default confirmation client factory rejects', async () => {
    const authClient = client();
    const configLoader = vi
      .fn<() => Promise<AuthConfig>>()
      .mockResolvedValueOnce(invalidConfirmationConfig)
      .mockResolvedValue(config);
    const clientFactory = vi.fn().mockReturnValue(authClient);

    render(
      <StrictMode>
        <App configLoader={configLoader} clientFactory={clientFactory} />
      </StrictMode>,
    );

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(configLoader).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenNthCalledWith(1, invalidConfirmationConfig);
    expect(clientFactory).toHaveBeenNthCalledWith(2, config);
    expect(authClient.initialize).toHaveBeenCalledOnce();
  });

  it('revalidates an existing session after a transient restore error', async () => {
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(new AuthFailure('network', 'No se pudo validar la sesión.'))
      .mockResolvedValueOnce(null);
    const authClient = client({ initialize });
    render(<App authClient={authClient} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revalidar sesión' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revalidar sesión' }));
    expect(await screen.findByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('renews the session when the access token expires while the tab remains open', async () => {
    const first = session('a@example.com', Math.floor(Date.now() / 1000));
    const renewed = session('a@example.com', Math.floor(Date.now() / 1000) + 600);
    const initialize = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(renewed);
    const authClient = client({ initialize });
    render(<App authClient={authClient} />);

    expect(await screen.findByText('a@example.com')).toBeTruthy();
    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
    expect(screen.getByText('a@example.com')).toBeTruthy();
  });

  it('keeps a pending draft through same-sub renewal and saves with the renewed token', async () => {
    vi.useFakeTimers();
    const first = session('a@example.com', (Date.now() + 800) / 1000, 'old-token');
    const renewed = session('a@example.com', (Date.now() + 600_000) / 1000, 'new-token');
    let currentSession = first;
    let resolveRenewal!: (value: AuthSession) => void;
    const initialize = vi
      .fn<() => Promise<AuthSession | null>>()
      .mockImplementationOnce(async () => {
        currentSession = first;
        return first;
      })
      .mockImplementationOnce(
        () =>
          new Promise<AuthSession>((resolve) => {
            resolveRenewal = (value) => {
              currentSession = value;
              resolve(value);
            };
          }),
      );
    const authClient = client({ initialize });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          expectedVersion: number;
          draft: ReturnType<typeof createDefaultDraft>;
        };
        return new Response(
          JSON.stringify({ version: body.expectedVersion + 1, draft: body.draft }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response(JSON.stringify({ version: 0, draft: createDefaultDraft() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const draftApi = new DraftApiClient(config, {
      tokenProvider: () => currentSession.user.access_token,
      fetch: fetchImpl,
    });
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={emptyAttemptApi()}
        configLoader={async () => config}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Qué debe tener en cuenta el robot')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Texto pendiente durante la renovación' },
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0);
    expect(screen.getByDisplayValue('Texto pendiente durante la renovación')).toBeTruthy();

    await act(async () => {
      resolveRenewal(renewed);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    const putCall = fetchImpl.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(putCall?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer new-token' }),
    });
    expect(screen.getByDisplayValue('Texto pendiente durante la renovación')).toBeTruthy();
  });

  it('keeps local discard and logout available while waiting for a never-resolving save', async () => {
    vi.useFakeTimers();
    const current = session('a@example.com', (Date.now() + 600_000) / 1000);
    const initialize = vi.fn().mockResolvedValue(current);
    const logout = vi.fn().mockResolvedValue(undefined);
    const authClient = client({ initialize, logout });
    let resolvePut!: (value: DraftSnapshot) => void;
    const putDraft = vi.fn<DraftApi['putDraft']>().mockReturnValue(
      new Promise<DraftSnapshot>((resolve) => {
        resolvePut = resolve;
      }),
    );
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft,
    };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={emptyAttemptApi()}
        configLoader={async () => config}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('Qué debe tener en cuenta el robot'), {
      target: { value: 'Guardado que no responde' },
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(putDraft).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(screen.getByRole('heading', { name: 'Tenés cambios sin confirmar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Esperar guardado' }));
    await act(async () => {
      await Promise.resolve();
    });
    const discard = screen.getByRole('button', { name: 'Descartar cambios locales y salir' });
    expect((discard as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(discard);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(logout).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Entrar o crear una cuenta' })).toBeTruthy();
    resolvePut({ version: 1, draft: createDefaultDraft() });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(logout).toHaveBeenCalledOnce();
  });

  it('locks editor fields and logout in the same click that starts admission', async () => {
    const authClient = client({ initialize: vi.fn().mockResolvedValue(session()) });
    const draftApi: DraftApi = {
      getDraft: vi.fn().mockResolvedValue({ version: 0, draft: createDefaultDraft() }),
      putDraft: vi.fn().mockResolvedValue({ version: 1, draft: createDefaultDraft() }),
    };
    const createAttempt = vi.fn(() => new Promise<never>(() => undefined));
    const attemptApi = { ...emptyAttemptApi(), createAttempt };
    render(
      <App
        authClient={authClient}
        draftApi={draftApi}
        attemptApi={attemptApi}
        configLoader={async () => config}
      />,
    );

    await screen.findByLabelText('Qué debe tener en cuenta el robot');
    const tryButton = await screen.findByRole('button', { name: 'Probar' });
    await waitFor(() => expect((tryButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(tryButton);

    expect(
      (
        screen
          .getByLabelText('Qué debe tener en cuenta el robot')
          .closest('fieldset') as HTMLFieldSetElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Cerrar sesión' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
