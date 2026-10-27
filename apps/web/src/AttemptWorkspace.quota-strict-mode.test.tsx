// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from './auth.js';
import type { AttemptApi, QuotaSummary } from './attempt-api.js';
import { AttemptWorkspace } from './AttemptWorkspace.js';
import type { RobotEditorHandle } from './RobotEditor.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');

function session(): AuthSession {
  return {
    identity: { sub: 'strict-subject', email: 'strict@example.com' },
    user: new User({
      access_token: 'strict-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
        sub: 'strict-subject',
        email: 'strict@example.com',
      },
    }),
  };
}

function quota(remaining: number): QuotaSummary {
  return {
    day: new Date(Date.now()).toISOString().slice(0, 10),
    used: 100 - remaining,
    limit: 100,
    remaining,
    resetsAt: new Date(Date.now() + 5_000).toISOString(),
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AttemptWorkspace quota StrictMode lifecycle', () => {
  it('starts a replacement quota read after StrictMode replays effects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const getQuota = vi.fn().mockImplementation(async () => quota(0));
    const runner: AttemptApi = {
      getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: true, version: 0 }),
      putAnimationPreference: vi.fn(),
      createAttempt: vi.fn(),
      getAttemptRequest: vi.fn(),
      getAttempt: vi.fn(),
      getConfiguration: vi.fn(),
      listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
      startAttempt: vi.fn(),
      cancelAttempt: vi.fn(),
      getReplay: vi.fn(),
      getDecisionIndex: vi.fn(),
      getDecision: vi.fn(),
      completePresentation: vi.fn(),
      getQuota,
    };
    const editor = { current: null } as unknown as { current: RobotEditorHandle | null };
    render(
      <StrictMode>
        <AttemptWorkspace api={runner} editor={editor} session={session()} accessState="ready" />
      </StrictMode>,
    );

    await settle();
    expect(getQuota.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getQuota.mock.calls[0]?.[0]?.aborted).toBe(true);
    expect(screen.getByLabelText('Cuota: 0 de 100 intentos disponibles')).toBeTruthy();
    expect(screen.getByText('No quedan partidas disponibles.')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
    expect(getQuota.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
