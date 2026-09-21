// @vitest-environment jsdom

import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AuthFailure, type AuthClient, type AuthConfig, type AuthSession } from './auth.js';
import type { PendingConfirmationClient } from './pending-confirmation.js';

const config: AuthConfig = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'client-public',
  domain: 'https://prompt-runner.auth.us-east-1.amazoncognito.com',
  redirectUri: 'https://d1ilpq1n58tzqo.cloudfront.net/',
  logoutUri: 'https://d1ilpq1n58tzqo.cloudfront.net/',
};

const invalidConfirmationConfig: AuthConfig = {
  ...config,
  issuer: 'https://invalid.example/us-east-1_test',
};

function session(
  email = 'a@example.com',
  expiresAt = Math.floor(Date.now() / 1000) + 600,
): AuthSession {
  return {
    identity: { sub: 'subject-a', email },
    user: new User({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      session_state: null,
      profile: {
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
        aud: 'client-public',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        sub: 'subject-a',
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
});
