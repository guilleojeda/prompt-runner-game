// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { AuthClient, AuthSession } from './auth.js';

vi.mock('./replay/ReplayScene.js', () => ({
  CoursePreview: () => null,
  ReplayScene: () => null,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function authenticatedSession(expiresAt = Math.floor(Date.now() / 1000) + 600): AuthSession {
  const sub = 'account-header-test';
  const email = 'player@example.com';
  return {
    identity: { sub, email },
    user: new User({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      scope: 'openid email',
      session_state: null,
      profile: {
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
        aud: 'client-public',
        iat: Math.floor(Date.now() / 1000),
        exp: expiresAt,
        sub,
        email,
      },
      expires_at: expiresAt,
    }),
  };
}

describe('account header focus behavior', () => {
  it('closes on Escape and restores the trigger after focus leaves the account control', async () => {
    const authClient: AuthClient = {
      initialize: vi.fn().mockResolvedValue(authenticatedSession()),
      beginLogin: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
    };
    render(<App authClient={authClient} />);

    const trigger = await screen.findByRole('button', { name: 'Cuenta' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const brandLink = screen.getByRole('link', { name: 'Acerca de Robot Runner' });

    fireEvent.keyDown(trigger, { key: 'Tab', shiftKey: true });
    brandLink.focus();
    expect(document.activeElement).toBe(brandLink);

    fireEvent.keyDown(brandLink, { key: 'Escape' });

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
  });

  it.each([
    { focusTarget: 'trigger', expectedFocus: 'header' },
    { focusTarget: 'logout', expectedFocus: 'header' },
    { focusTarget: 'brand', expectedFocus: 'brand' },
  ] as const)(
    'closes the panel on renewal and keeps usable focus when it was on $focusTarget',
    async ({ focusTarget, expectedFocus }) => {
      vi.useFakeTimers();
      const initialSession = authenticatedSession(Date.now() / 1000 + 60);
      let resolveRenewal!: (nextSession: AuthSession | null) => void;
      const initialize = vi.fn<AuthClient['initialize']>();
      initialize.mockResolvedValueOnce(initialSession).mockImplementationOnce(
        () =>
          new Promise<AuthSession | null>((resolve) => {
            resolveRenewal = resolve;
          }),
      );
      const authClient: AuthClient = {
        initialize,
        beginLogin: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
      };
      render(<App authClient={authClient} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const trigger = screen.getByRole('button', { name: 'Cuenta' });
      fireEvent.click(trigger);
      const panelId = trigger.getAttribute('aria-controls');
      const brandLink = screen.getByRole('link', { name: 'Acerca de Robot Runner' });
      const logoutButton = screen.getByRole('button', { name: 'Cerrar sesión' });
      const focusTargetElement =
        focusTarget === 'brand' ? brandLink : focusTarget === 'logout' ? logoutButton : trigger;
      focusTargetElement.focus();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(focusTargetElement);
      const header = trigger.closest('header');
      expect(header).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      const currentTrigger = screen.getByRole('button', { name: 'Cuenta' }) as HTMLButtonElement;
      expect(currentTrigger.disabled).toBe(true);
      expect(currentTrigger).toBe(trigger);
      expect(currentTrigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(expectedFocus === 'brand' ? brandLink : header);
      expect(brandLink.isConnected).toBe(true);
      expect(document.getElementById(panelId as string)?.hidden).toBe(true);
      expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
      expect(initialize).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveRenewal(authenticatedSession());
        await Promise.resolve();
      });
      expect(currentTrigger.disabled).toBe(false);
      expect(document.activeElement).toBe(expectedFocus === 'brand' ? brandLink : header);
    },
  );
});
