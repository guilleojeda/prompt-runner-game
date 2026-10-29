import { describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import { AttemptApiClient, AttemptApiFailure, isTransientReadFailure } from './attempt-api.js';

const config = { apiBaseUrl: 'https://api.example.test/' };
const PRIVATE_MARKER = 'private-decisions-read-recovery-fixture';

type DecisionRead = Readonly<{
  readonly name: 'index' | 'detail';
  readonly url: (id: string) => string;
  readonly read: (client: AttemptApiClient, id: string, signal?: AbortSignal) => Promise<unknown>;
}>;

const reads: readonly DecisionRead[] = [
  {
    name: 'index',
    url: (id) => `${config.apiBaseUrl}attempts/${encodeURIComponent(id)}/decisions`,
    read: (client, id, signal) => client.getDecisionIndex(id, signal),
  },
  {
    name: 'detail',
    url: (id) => `${config.apiBaseUrl}attempts/${encodeURIComponent(id)}/decisions?decision=1`,
    read: (client, id, signal) => client.getDecision(id, 1, signal),
  },
];

type FailureCase = Readonly<{
  readonly name: string;
  readonly status: number;
  readonly body: unknown;
  readonly code: string;
  readonly transient: boolean;
}>;

const failureCases: readonly FailureCase[] = [
  {
    name: 'active attempt decisions_pending',
    status: 409,
    body: { code: 'decisions_pending', message: PRIVATE_MARKER },
    code: 'pending',
    transient: false,
  },
  {
    name: 'incomplete replay record',
    status: 409,
    body: { code: 'replay_unavailable', message: PRIVATE_MARKER },
    code: 'conflict',
    transient: false,
  },
  {
    name: 'stored attempt incompatibility',
    status: 500,
    body: { code: 'stored_attempt_incompatible', message: PRIVATE_MARKER },
    code: 'incompatible',
    transient: false,
  },
  {
    name: 'general store dependency failure',
    status: 503,
    body: { code: 'dependency_unavailable', message: PRIVATE_MARKER },
    code: 'server',
    transient: true,
  },
  {
    name: 'raw SDK internal failure',
    status: 500,
    body: { code: 'internal', message: PRIVATE_MARKER },
    code: 'server',
    transient: true,
  },
  {
    name: 'invalid request',
    status: 400,
    body: { code: 'invalid', message: PRIVATE_MARKER },
    code: 'invalid',
    transient: false,
  },
  {
    name: 'missing or foreign attempt',
    status: 404,
    body: { code: 'not_found', message: PRIVATE_MARKER },
    code: 'not_found',
    transient: false,
  },
  {
    name: 'unrecognized conflict',
    status: 409,
    body: { code: 'conflict', message: PRIVATE_MARKER },
    code: 'conflict',
    transient: false,
  },
];

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('AttemptApiClient decision-read recovery classification', () => {
  const failureReads = reads.flatMap((read) =>
    failureCases.map((testCase) => ({ read, testCase })),
  );

  it.each(failureReads)(
    'classifies $read.name GET $testCase.name by status and response code',
    async ({ read, testCase }) => {
      const id = 'attempt/20';
      const controller = new AbortController();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(testCase.body, testCase.status));
      const client = new AttemptApiClient(config, {
        tokenProvider: () => ({ accessToken: 'private-access-token', authContext: 20 }),
        fetch,
      });
      let failure: unknown;
      try {
        await read.read(client, id, controller.signal);
      } catch (error) {
        failure = error;
      }

      expect(failure, testCase.name).toBeInstanceOf(AttemptApiFailure);
      expect(failure, testCase.name).toMatchObject({
        code: testCase.code,
        status: testCase.status,
      });
      expect(isTransientReadFailure(failure), testCase.name).toBe(testCase.transient);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toBe(read.url(id));
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({
        method: 'GET',
        signal: controller.signal,
        headers: expect.objectContaining({ Authorization: 'Bearer private-access-token' }),
      });
      expect(JSON.stringify(failure)).not.toContain('private-access-token');
    },
  );

  it.each(reads)('treats malformed successful $name protocol data as definite', async (read) => {
    const id = 'attempt/20';
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({}));
    const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch });
    let failure: unknown;
    try {
      await read.read(client, id);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AttemptApiFailure);
    expect(failure).toMatchObject({ code: 'server', status: 200 });
    expect(isTransientReadFailure(failure)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(read.url(id));
  });

  it.each(reads)(
    'accepts a healthy $name projection with absent private data in one GET',
    async (read) => {
      const id = 'attempt/20';
      const body =
        read.name === 'index'
          ? { attemptId: id, levelId: LEVEL.id, decisions: [] }
          : {
              attemptId: id,
              levelId: LEVEL.id,
              item: { number: 1, decisionId: 'decision-1', originSupport: 0, hasAction: false },
              observation: null,
              availableActions: null,
              choice: { state: 'unknown' },
              result: { kind: 'no-action', turnsUsed: 0, status: 'cancelled' },
            };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body));
      const client = new AttemptApiClient(config, { tokenProvider: () => 'token', fetch });

      await expect(read.read(client, id)).resolves.toMatchObject(
        read.name === 'index'
          ? { attemptId: id, decisions: [] }
          : { attemptId: id, choice: { state: 'unknown' } },
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toBe(read.url(id));
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    },
  );
});
