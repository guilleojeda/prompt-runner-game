// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import type { RefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import type { AttemptSummary, ReplayRecordView } from '../../../shared/attempt.js';
import type { AuthSession } from './auth.js';
import { AttemptApiClient } from './attempt-api.js';
import { AttemptWorkspace } from './AttemptWorkspace.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import { writeAttemptRecovery } from './attempt-recovery.js';
import { doorVictoryRecord } from './replay/replay.test-support.js';

vi.mock('./replay/ReplayScene.js', () => ({
  ReplayScene: ({ onReady, onComplete }: { onReady: () => void; onComplete: () => void }) => (
    <div>
      <button type="button" onClick={onReady}>
        Recursos listos
      </button>
      <button type="button" onClick={onComplete}>
        Completar reproducción
      </button>
    </div>
  ),
}));

const ACCOUNT = 'subject-a';
const ATTEMPT_ID = 'attempt-a';
const ACK_DELAY = 60_000;

function session(): AuthSession {
  return {
    identity: { sub: ACCOUNT, email: `${ACCOUNT}@example.com` },
    user: new User({
      access_token: 'token-a',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: 1,
        exp: 9999999999,
        sub: ACCOUNT,
        email: `${ACCOUNT}@example.com`,
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

function attempt(presentationComplete = false): AttemptSummary {
  return {
    id: ATTEMPT_ID,
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:01.000Z',
    status: 'victory',
    cancelRequested: false,
    levelId: LEVEL.id,
    modelKey: 'claude-sonnet-4.6',
    modelLabel: 'Claude Sonnet 4.6',
    modelId: 'global.anthropic.claude-sonnet-4-6',
    turnsUsed: 8,
    maxTurns: LEVEL.maxTurns,
    calls: 8,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    gameTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    score: null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: 1,
    finalSupport: LEVEL.exit.support,
    animationEnabled: true,
    presentationComplete,
    recordComplete: true,
  };
}

function replayRecord(): ReplayRecordView {
  const source = doorVictoryRecord();
  const snapshots = source.snapshots.slice(0, 9);
  const actions = source.actions.slice(0, 8);
  return {
    recordVersion: source.recordVersion,
    id: ATTEMPT_ID,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    config: { level: source.config.level },
    snapshots,
    actions,
    closure: {
      ...source.closure,
      status: 'victory',
      actionCount: actions.length,
      finalStateId: snapshots.at(-1)!.id,
    },
    metrics: source.metrics,
    score: source.score,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleRead(path: string, pending: AttemptSummary): Response {
  if (path === '/animation-preference') {
    return response({ animationEnabled: true, version: 0 });
  }
  if (path === '/quota') {
    return response({
      day: '2026-09-21',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
  }
  if (path === '/attempts') return response({ attempts: [] });
  if (path === `/attempts/${ATTEMPT_ID}/replay`) return response({ record: replayRecord() });
  if (path === `/attempts/${ATTEMPT_ID}`) return response({ attempt: pending });
  throw new Error(`Unexpected HTTP request ${path}`);
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AttemptWorkspace API renewal with a pending presentation ACK', () => {
  it('uses the renewed API only at the existing reconciliation deadline', async () => {
    const pending = attempt();
    const oldFetch = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/attempts/${ATTEMPT_ID}/presentation-complete`) {
        return response({ attempt: { id: ATTEMPT_ID } });
      }
      return handleRead(path, pending);
    });
    const oldClient = new AttemptApiClient(
      { apiBaseUrl: 'https://old.example.test/' },
      {
        tokenProvider: () => ({ accessToken: 'old-token', authContext: 1 }),
        fetch: oldFetch,
      },
    );
    const renewedTrace: string[] = [];
    const renewedFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://renewed.example.test');
      if (url.pathname === `/attempts/${ATTEMPT_ID}`) renewedTrace.push(`GET:${ATTEMPT_ID}`);
      if (url.pathname === `/attempts/${ATTEMPT_ID}/presentation-complete`) {
        renewedTrace.push(`POST:${ATTEMPT_ID}`);
        expect(init?.method).toBe('POST');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init).not.toHaveProperty('body');
        return response({ attempt: attempt(true) });
      }
      return handleRead(url.pathname, pending);
    });
    const renewedClient = new AttemptApiClient(
      { apiBaseUrl: 'https://renewed.example.test/' },
      {
        tokenProvider: () => ({ accessToken: 'renewed-token', authContext: 2 }),
        fetch: renewedFetch,
      },
    );
    const editor = { current: null } as RefObject<RobotEditorHandle | null>;
    writeAttemptRecovery({ sub: ACCOUNT, attemptId: ATTEMPT_ID });
    const view = render(
      <AttemptWorkspace api={oldClient} editor={editor} session={session()} accessState="ready" />,
    );
    await screen.findByRole('button', { name: 'Completar reproducción' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Recursos listos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completar reproducción' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(
      oldFetch.mock.calls.filter(
        ([url, init]) => String(url).includes('/presentation-complete') && init?.method === 'POST',
      ),
    ).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    view.rerender(
      <AttemptWorkspace
        api={renewedClient}
        editor={editor}
        session={session()}
        accessState="ready"
      />,
    );
    await settle();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Completar reproducción' })).toBeNull();
    expect(renewedTrace).toEqual([]);

    view.rerender(
      <AttemptWorkspace
        api={renewedClient}
        editor={editor}
        session={session()}
        accessState="ready"
        onAuthRequired={() => false}
      />,
    );
    await settle();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
    expect(renewedTrace).toEqual([]);

    await act(async () => vi.advanceTimersByTimeAsync(ACK_DELAY - 20_001));
    expect(renewedTrace).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(renewedTrace).toEqual([`GET:${ATTEMPT_ID}`, `POST:${ATTEMPT_ID}`]);
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(2 * ACK_DELAY));
    await settle();
    expect(renewedTrace).toEqual([`GET:${ATTEMPT_ID}`, `POST:${ATTEMPT_ID}`]);
  });
});
