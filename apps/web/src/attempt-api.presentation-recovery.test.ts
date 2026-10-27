import { describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import type { AttemptSummary } from './attempt-api.js';
import { AttemptApiClient } from './attempt-api.js';

const config = { apiBaseUrl: 'https://api.example.test/' };

function summary(id: string, presentationComplete = true): AttemptSummary {
  return {
    id,
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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('presentation ACK API contract', () => {
  it('POSTs the same encoded attempt ID without a body and forwards its abort signal', async () => {
    const id = 'attempt / one';
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ attempt: summary(id) }));
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.completePresentation(id, controller.signal)).resolves.toMatchObject({
      id,
      presentationComplete: true,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/attempts/attempt%20%2F%20one/presentation-complete',
      expect.objectContaining({
        method: 'POST',
        signal: controller.signal,
      }),
    );
    expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it.each([
    ['network loss', 'network' as const, true],
    ['server failure', 'server' as const, true],
    ['malformed successful response', 'server' as const, true],
    ['rate limit', 'attempt_unavailable' as const, false],
    ['authentication rejection', 'authentication' as const, false],
    ['missing attempt', 'not_found' as const, false],
    ['conflict', 'conflict' as const, false],
    ['invalid request', 'invalid' as const, false],
  ])('preserves ACK ambiguity for %s', async (label, code, ambiguous) => {
    const fetchImpl = vi.fn<typeof fetch>();
    if (label === 'network loss') {
      fetchImpl.mockRejectedValue(new TypeError('Failed to fetch'));
    } else if (label === 'server failure') {
      fetchImpl.mockResolvedValue(response({ message: 'Unavailable' }, 503));
    } else if (label === 'malformed successful response') {
      fetchImpl.mockResolvedValue(response({ attempt: { id: 'attempt-1' } }));
    } else {
      const statusByLabel: Record<string, number> = {
        'rate limit': 429,
        'authentication rejection': 401,
        'missing attempt': 404,
        conflict: 409,
        'invalid request': 400,
      };
      fetchImpl.mockResolvedValue(response({ message: label }, statusByLabel[label]!));
    }
    const client = new AttemptApiClient(config, {
      tokenProvider: () => ({ accessToken: 'access-token', authContext: 17 }),
      fetch: fetchImpl,
    });

    await expect(client.completePresentation('attempt-1')).rejects.toMatchObject({
      code,
      ambiguous,
      ...(label === 'authentication rejection' ? { authContext: 17 } : {}),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('GETs the same attempt ID and forwards the reconciliation signal', async () => {
    const id = 'attempt / one';
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ attempt: summary(id, false) }));
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.getAttempt(id, controller.signal)).resolves.toMatchObject({
      id,
      presentationComplete: false,
      status: 'victory',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/attempts/attempt%20%2F%20one',
      expect.objectContaining({ method: 'GET', signal: controller.signal }),
    );
  });

  it.each([
    [429, 'attempt_unavailable'],
    [400, 'invalid'],
    [401, 'authentication'],
    [404, 'not_found'],
    [409, 'conflict'],
  ] as const)(
    'classifies reconciliation GET %i %s failure without mutation ambiguity',
    async (status, code) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ message: 'Rejected' }, status));
      const client = new AttemptApiClient(config, {
        tokenProvider: () => ({ accessToken: 'access-token', authContext: 21 }),
        fetch: fetchImpl,
      });

      await expect(client.getAttempt('attempt-1')).rejects.toMatchObject({
        code,
        status,
        ambiguous: false,
        ...(status === 401 ? { authContext: 21 } : {}),
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    },
  );

  it('propagates a control abort without recasting it as a retryable POST failure', async () => {
    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw abort;
    });
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.completePresentation('attempt-1', controller.signal)).rejects.toBe(abort);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
