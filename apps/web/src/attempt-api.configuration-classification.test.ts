import { describe, expect, it, vi } from 'vitest';
import { AttemptApiClient, isTransientReadFailure } from './attempt-api.js';

const config = {
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};

const SHARED_MESSAGE = 'La configuración del intento no es compatible con la versión actual.';

const configurationErrors = [
  {
    name: 'pending configuration',
    body: { code: 'configuration_pending', message: SHARED_MESSAGE },
    expectedCode: 'pending',
  },
  {
    name: 'incompatible configuration',
    body: { code: 'configuration_incompatible', message: SHARED_MESSAGE },
    expectedCode: 'incompatible',
  },
  {
    name: 'generic conflict',
    body: { code: 'conflict', message: SHARED_MESSAGE },
    expectedCode: 'conflict',
  },
] as const;

const rejectedValue = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the configuration read to fail.');
};

describe('AttemptApiClient configuration error classification proposal', () => {
  it.each(configurationErrors)(
    'classifies $name by response code while preserving the request and read identity',
    async ({ body, expectedCode }) => {
      const id = 'attempt/17';
      const controller = new AbortController();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 409 }));
      const client = new AttemptApiClient(config, {
        tokenProvider: () => ({ accessToken: 'private-access-token', authContext: 31 }),
        fetch: fetchImpl,
      });

      const failure = await rejectedValue(client.getConfiguration(id, controller.signal));

      expect.soft(failure).toMatchObject({
        code: expectedCode,
        status: 409,
        message: SHARED_MESSAGE,
      });
      expect(isTransientReadFailure(failure)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        `${config.apiBaseUrl}attempts/${encodeURIComponent(id)}/configuration`,
      );
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
        method: 'GET',
        signal: controller.signal,
        headers: expect.objectContaining({ Authorization: 'Bearer private-access-token' }),
      });
      expect(JSON.stringify(failure)).not.toContain('private-access-token');
    },
  );
});
