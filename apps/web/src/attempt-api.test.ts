import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { createClosedAttemptRecordFixture } from '../../../shared/attempt.fixture.js';
import { LEVEL } from '../../../shared/game.js';
import { AttemptApiClient } from './attempt-api.js';

const config = { apiBaseUrl: 'https://api.example.test/', apiScope: 'prompt-runner/robot' };

const summary = {
  id: 'attempt-1',
  createdAt: '2026-09-21T12:00:00.000Z',
  updatedAt: '2026-09-21T12:00:01.000Z',
  status: 'victory',
  cancelRequested: false,
  levelId: LEVEL.id,
  modelKey: 'claude-sonnet-4.6',
  modelLabel: 'Claude Sonnet 4.6',
  modelId: 'global.anthropic.claude-sonnet-4-6',
  turnsUsed: 16,
  maxTurns: LEVEL.maxTurns,
  calls: 16,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  gameTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  score: null,
  collectedObjectIds: ['llave-1'],
  objectPoints: 0,
  progress: 1,
  finalSupport: LEVEL.exit.support,
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

    const result = await client.createAttempt('request-key', 0, draft, true);

    expect(result.attempt.id).toBe('attempt-1');
    expect(result.attempt.modelKey).toBe('claude-sonnet-4.6');
    expect(result.attempt.modelLabel).toBe('Claude Sonnet 4.6');
    expect(result.attempt.reasoningTokens).toBeNull();
    expect(result.dispatchConfirmed).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/attempts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        body: JSON.stringify({
          requestKey: 'request-key',
          expectedVersion: 0,
          draft,
          animationEnabled: true,
        }),
      }),
    );
  });

  it('loads and strictly validates the terminal attempt configuration', async () => {
    const draft = createDefaultDraft();
    const preservedDraft = {
      ...draft,
      skills: draft.skills.map((skill, index) =>
        index === 0 ? { id: skill.id, enabled: skill.enabled } : skill,
      ),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ attemptId: 'attempt-1', draft: preservedDraft }), {
        status: 200,
      }),
    );
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    const result = await client.getConfiguration('attempt 1');

    expect(result).toEqual({ attemptId: 'attempt-1', draft: preservedDraft });
    expect(result.draft.skills[0]).not.toHaveProperty('description');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/attempts/attempt%201/configuration',
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
      }),
    );
  });

  it('rejects an attempt configuration with extra fields or an obsolete draft', async () => {
    const draft = createDefaultDraft();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ attemptId: 'attempt-1', draft, extra: true }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attemptId: 'attempt-1',
            draft: { ...draft, catalogVersion: 2 },
          }),
          { status: 200 },
        ),
      );
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getConfiguration('attempt-1')).rejects.toMatchObject({ code: 'server' });
    await expect(client.getConfiguration('attempt-1')).rejects.toMatchObject({ code: 'server' });
  });

  it('keeps the current server-normalized model identity on an attempt summary', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          attempt: {
            ...summary,
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

    expect(result.modelKey).toBe('claude-sonnet-4.6');
    expect(result.modelLabel).toBe('Claude Sonnet 4.6');
    expect(result.modelId).toBe('global.anthropic.claude-sonnet-4-6');
    expect(result.reasoningTokens).toBe(17);
  });

  it('rejects an attempt summary with an obsolete model profile', async () => {
    const obsolete = {
      ...summary,
      modelKey: 'claude-sonnet-5',
      modelLabel: 'Claude Sonnet 5',
      modelId: 'global.anthropic.claude-sonnet-5',
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ attempt: obsolete }), { status: 200 }));
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getAttempt('attempt-1')).rejects.toMatchObject({ code: 'server' });
  });

  it('rejects an attempt summary from the retired phase 5 level', async () => {
    const obsolete = { ...summary, levelId: 'principal-periodico-v2' };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ attempt: obsolete }), { status: 200 }));
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getAttempt('attempt-old')).rejects.toMatchObject({ code: 'server' });
  });

  it('keeps the collected reward summary and rejects inconsistent reward points', async () => {
    const collected = {
      ...summary,
      collectedObjectIds: ['recompensa-1', 'llave-1'],
      objectPoints: 25,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ attempt: collected }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attempt: { ...collected, collectedObjectIds: ['llave-1'], objectPoints: 25 },
          }),
          { status: 200 },
        ),
      );
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getAttempt('attempt-1')).resolves.toMatchObject({
      collectedObjectIds: ['recompensa-1', 'llave-1'],
      objectPoints: 25,
    });
    await expect(client.getAttempt('attempt-1')).rejects.toMatchObject({ code: 'server' });
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

    await expect(client.createAttempt('key', 1, createDefaultDraft(), false)).rejects.toMatchObject(
      {
        code: 'quota_exceeded',
        status: 429,
        ambiguous: false,
      },
    );
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

  it('reads and version-saves the per-user animation preference', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ animationEnabled: true, version: 0 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ animationEnabled: false, version: 1 }), { status: 200 }),
      );
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'token',
      fetch: fetchImpl,
    });

    await expect(client.getAnimationPreference()).resolves.toEqual({
      animationEnabled: true,
      version: 0,
    });
    await expect(client.putAnimationPreference(false, 0)).resolves.toEqual({
      animationEnabled: false,
      version: 1,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.test/animation-preference');
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ animationEnabled: false, expectedVersion: 0 }),
    });
  });

  it('loads a narrow replay view and marks presentation complete without another admission', async () => {
    const source = createClosedAttemptRecordFixture();
    const states = new Map(source.snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const record = {
      recordVersion: source.recordVersion,
      id: source.id,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      config: { level: source.config.level },
      snapshots: source.snapshots,
      actions: source.actions.map((action) => ({
        ...action,
        before: states.get(action.beforeStateId),
        after: states.get(action.afterStateId),
      })),
      closure: source.closure,
      metrics: source.metrics,
      score: source.score,
    };
    const completedAttempt = { ...summary, animationEnabled: true, presentationComplete: true };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ record }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ attempt: completedAttempt }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            record: {
              ...record,
              snapshots: record.snapshots.map((snapshot, index) =>
                index === 0 ? { ...snapshot, facing: undefined } : snapshot,
              ),
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            record: {
              ...record,
              snapshots: record.snapshots.map((snapshot, index) =>
                index === 0 ? { ...snapshot, exitEnabled: true } : snapshot,
              ),
            },
          }),
          { status: 200 },
        ),
      );
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'token',
      fetch: fetchImpl,
    });

    const view = await client.getReplay(source.id);
    expect(view.id).toBe(source.id);
    expect(view.actions[0]).toMatchObject({
      before: { id: 'state-0' },
      after: { id: 'state-1' },
    });
    await expect(client.completePresentation('attempt / one')).resolves.toMatchObject({
      id: 'attempt-1',
      animationEnabled: true,
      presentationComplete: true,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/attempts/${source.id}/replay`,
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://api.example.test/attempts/attempt%20%2F%20one/presentation-complete',
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    await expect(client.getReplay(source.id)).rejects.toMatchObject({ code: 'server' });
    await expect(client.getReplay(source.id)).rejects.toMatchObject({ code: 'server' });
  });

  it('rejects replay data with a terrain cause that contradicts the recorded action', async () => {
    const source = createClosedAttemptRecordFixture();
    const states = new Map(source.snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const record = {
      recordVersion: source.recordVersion,
      id: source.id,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      config: { level: source.config.level },
      snapshots: source.snapshots,
      actions: source.actions.map((action, index) => ({
        ...action,
        before: states.get(action.beforeStateId),
        after: states.get(action.afterStateId),
        ...(index === 0 ? { resolution: { ...action.resolution, reason: 'walk_into_pit' } } : {}),
      })),
      closure: source.closure,
      metrics: source.metrics,
      score: source.score,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ record }), { status: 200 }));
    const client = new AttemptApiClient(config, {
      tokenProvider: () => 'token',
      fetch: fetchImpl,
    });

    await expect(client.getReplay(source.id)).rejects.toMatchObject({ code: 'server' });
  });

  it('loads the decision index and detail without exposing an audit body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attemptId: summary.id,
            levelId: LEVEL.id,
            decisions: [
              { number: 1, decisionId: 'decision-1', originSupport: 2, hasAction: true },
              { number: 2, decisionId: 'decision-2', originSupport: 2, hasAction: false },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attemptId: summary.id,
            levelId: LEVEL.id,
            item: { number: 1, decisionId: 'decision-1', originSupport: 2, hasAction: true },
            observation: {
              facing: 'right',
              here: { objects: ['recompensa-1'] },
              left: { kind: 'segment', terrain: 'ground' },
              right: { kind: 'segment', terrain: 'pit' },
            },
            availableActions: [
              { opaqueId: 'tool_1', label: 'Avanzar', description: 'Avanza un tramo.' },
              { opaqueId: 'tool_6', label: 'Esperar', description: '' },
            ],
            choice: {
              state: 'selected',
              opaqueId: 'tool_1',
              action: { kind: 'advance' },
              parameters: {},
            },
            result: {
              kind: 'action',
              action: { kind: 'advance' },
              resolution: { outcome: 'moved', reason: 'moved' },
              beforeSupport: 2,
              afterSupport: 3,
              turnsUsed: 1,
            },
          }),
          { status: 200 },
        ),
      );
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getDecisionIndex(summary.id)).resolves.toEqual({
      attemptId: summary.id,
      levelId: LEVEL.id,
      decisions: [
        { number: 1, decisionId: 'decision-1', originSupport: 2, hasAction: true },
        { number: 2, decisionId: 'decision-2', originSupport: 2, hasAction: false },
      ],
    });
    await expect(client.getDecision(summary.id, 1)).resolves.toMatchObject({
      item: { number: 1, originSupport: 2 },
      observation: { facing: 'right', here: { objects: ['recompensa-1'] } },
      availableActions: [
        { opaqueId: 'tool_1', label: 'Avanzar', description: 'Avanza un tramo.' },
        { opaqueId: 'tool_6', description: '' },
      ],
      choice: { state: 'selected', opaqueId: 'tool_1' },
      result: { kind: 'action', beforeSupport: 2, afterSupport: 3, turnsUsed: 1 },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/attempts/${summary.id}/decisions`,
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      `https://api.example.test/attempts/${summary.id}/decisions?decision=1`,
    );
  });

  it('rejects an index that is not chronological', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          attemptId: summary.id,
          levelId: LEVEL.id,
          decisions: [{ number: 2, decisionId: 'decision-1', originSupport: 1, hasAction: true }],
        }),
        { status: 200 },
      ),
    );
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getDecisionIndex(summary.id)).rejects.toMatchObject({ code: 'server' });
  });

  it('rejects an available action without the required human label', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          attemptId: summary.id,
          levelId: LEVEL.id,
          item: { number: 1, decisionId: 'decision-1', originSupport: 0, hasAction: false },
          observation: null,
          availableActions: [{ opaqueId: 'tool_1', humanLabel: 'Avanzar' }],
          choice: null,
          result: { kind: 'no-action', turnsUsed: 0, status: 'error' },
        }),
        { status: 200 },
      ),
    );
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch: fetchImpl });

    await expect(client.getDecision(summary.id, 1)).rejects.toMatchObject({ code: 'server' });
  });
});
