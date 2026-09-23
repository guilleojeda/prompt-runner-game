import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { AttemptApiClient } from './attempt-api.js';

const config = { apiBaseUrl: 'https://api.example.test/', apiScope: 'prompt-runner/robot' };

const summary = {
  id: 'attempt-1',
  createdAt: '2026-09-21T12:00:00.000Z',
  updatedAt: '2026-09-21T12:00:01.000Z',
  status: 'victory',
  cancelRequested: false,
  levelId: 'principal-estatico-v1',
  modelKey: 'claude-sonnet-5',
  modelLabel: 'Claude Sonnet 5',
  modelId: 'global.anthropic.claude-sonnet-5',
  turnsUsed: 5,
  maxTurns: 12,
  calls: 5,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  gameTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  score: null,
  progress: 1,
  finalSupport: 5,
  animationEnabled: false,
  presentationComplete: true,
  recordComplete: true,
} as const;

afterEach(() => vi.restoreAllMocks());

describe('AttemptApiClient', () => {
  it('posts the captured key/version/draft and parses the admission wrapper', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ attempt: summary, dispatchConfirmed: false }), {
        status: 200,
      }),
    );
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });
    const draft = createDefaultDraft();

    const result = await client.createAttempt('request-key', 0, draft);

    expect(result.attempt.id).toBe('attempt-1');
    expect(result.attempt.modelKey).toBe('claude-sonnet-5');
    expect(result.attempt.modelLabel).toBe('Claude Sonnet 5');
    expect(result.attempt.reasoningTokens).toBeNull();
    expect(result.dispatchConfirmed).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/attempts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        body: JSON.stringify({ requestKey: 'request-key', expectedVersion: 0, draft }),
      }),
    );
  });

  it('keeps the attempt model identity returned by the server', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          attempt: {
            ...summary,
            modelKey: 'claude-opus-5',
            modelLabel: 'Claude Opus 5',
            modelId: 'global.anthropic.claude-opus-5',
            reasoningTokens: 17,
          },
        }),
        { status: 200 },
      ),
    );
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'token',
      fetch: fetchImpl,
    });

    const result = await client.getAttempt('attempt-1');

    expect(result.modelKey).toBe('claude-opus-5');
    expect(result.modelLabel).toBe('Claude Opus 5');
    expect(result.modelId).toBe('global.anthropic.claude-opus-5');
    expect(result.reasoningTokens).toBe(17);
  });

  it('rejects an attempt response without the server-normalized model identity', async () => {
    const legacy = Object.fromEntries(
      Object.entries(summary).filter(
        ([key]) => key !== 'modelKey' && key !== 'modelLabel' && key !== 'modelId',
      ),
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ attempt: legacy }), { status: 200 }));
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getAttempt('attempt-1')).rejects.toMatchObject({ code: 'server' });
  });

  it('keeps unknown usage as null and reports quota errors without pretending the attempt ended', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 'quota_exceeded', message: 'Se alcanzó la cuota.' }), {
        status: 429,
      }),
    );
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.createAttempt('key', 1, createDefaultDraft())).rejects.toMatchObject({
      code: 'quota_exceeded',
      status: 429,
      ambiguous: false,
    });
  });

  it('uses the request lookup route for an ambiguous admission recovery', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ attempt: summary }), { status: 200 }));
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    const result = await client.getAttemptRequest('key with spaces');

    expect(result.id).toBe('attempt-1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/attempt-requests/key%20with%20spaces',
    );
  });

  it('rejects a response with a missing metric instead of relabeling it as unknown usage', async () => {
    const malformed = { ...summary, inputTokens: undefined };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ attempt: malformed }), { status: 200 }));
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getAttempt('attempt-1')).rejects.toMatchObject({ code: 'server' });
  });
});
