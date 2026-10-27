import { describe, expect, it, vi } from 'vitest';
import { createAttemptApiClient } from './attempt-api.js';

const config = { apiBaseUrl: 'https://api.example.test/' };
const preference = { animationEnabled: false, version: 4 };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('animation preference recovery API contracts', () => {
  it('marks a lost PUT response uncertain without repeating the mutation', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const api = createAttemptApiClient(config, () => 'fixture-token', fetch);

    await expect(api.putAnimationPreference(false, 3)).rejects.toMatchObject({
      code: 'network',
      ambiguous: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/animation-preference',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ animationEnabled: false, expectedVersion: 3 }),
      }),
    );
  });

  it.each([500, 503])('marks a PUT %i response uncertain', async (status) => {
    const fetch = vi.fn().mockResolvedValue(response({ message: 'Unavailable' }, status));
    const api = createAttemptApiClient(config, () => 'fixture-token', fetch);

    await expect(api.putAnimationPreference(false, 3)).rejects.toMatchObject({
      code: 'server',
      status,
      ambiguous: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([null, { animationEnabled: false }, { ...preference, version: -1 }])(
    'marks malformed PUT success %j uncertain',
    async (body) => {
      const fetch = vi.fn().mockResolvedValue(response(body));
      const api = createAttemptApiClient(config, () => 'fixture-token', fetch);

      await expect(api.putAnimationPreference(false, 3)).rejects.toMatchObject({
        code: 'server',
        status: 200,
        ambiguous: true,
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [400, 'invalid'],
    [401, 'authentication'],
    [403, 'authentication'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'attempt_unavailable'],
  ] as const)('preserves a definite PUT %i rejection as %s', async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(response({ message: 'Rejected' }, status));
    const api = createAttemptApiClient(config, () => 'fixture-token', fetch);

    await expect(api.putAnimationPreference(false, 3)).rejects.toMatchObject({
      code,
      status,
      ambiguous: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps malformed preference GET data distinguishable from transient HTTP failures', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ...preference, version: '4' }));
    const api = createAttemptApiClient(config, () => 'fixture-token', fetch);

    await expect(api.getAnimationPreference()).rejects.toMatchObject({
      code: 'server',
      status: 200,
      ambiguous: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps a gateway 429 from the preference GET separate from exhausted player quota', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ message: 'Too many requests' }, 429));
    const api = createAttemptApiClient(config, () => 'fixture-token', fetch);

    await expect(api.getAnimationPreference()).rejects.toMatchObject({
      code: 'attempt_unavailable',
      status: 429,
      ambiguous: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves a control abort rather than converting it to a retryable PUT failure', async () => {
    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    const fetch = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw abort;
    });
    const api = createAttemptApiClient(config, () => 'fixture-token', fetch);

    await expect(api.putAnimationPreference(false, 3, controller.signal)).rejects.toBe(abort);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
