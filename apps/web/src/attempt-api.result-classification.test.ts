import { describe, expect, it, vi } from 'vitest';
import { AttemptApiClient, isTransientReadFailure } from './attempt-api.js';

const config = {
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};

type FailureCase = {
  name: string;
  status: number;
  body: unknown;
  code: string;
  transient: boolean;
  read?: 'get' | 'list';
  authContext?: number;
};

const failureCases: readonly FailureCase[] = [
  {
    name: 'stored result incompatibility from GET',
    status: 500,
    body: {
      code: 'stored_attempt_incompatible',
      message: 'El resultado guardado no es compatible con la versión actual.',
    },
    code: 'incompatible',
    transient: false,
  },
  {
    name: 'stored result incompatibility from list',
    status: 500,
    body: {
      code: 'stored_attempt_incompatible',
      message: 'El resultado guardado no es compatible con la versión actual.',
    },
    code: 'incompatible',
    transient: false,
    read: 'list',
  },
  {
    name: 'generic internal error',
    status: 500,
    body: {
      code: 'internal',
      message: 'El resultado guardado no es compatible con la versión actual.',
    },
    code: 'server',
    transient: true,
  },
  {
    name: 'dependency unavailable',
    status: 503,
    body: { code: 'dependency_unavailable', message: 'No se pudo acceder al almacenamiento.' },
    code: 'server',
    transient: true,
  },
  {
    name: 'gateway rate limit',
    status: 429,
    body: { code: 'gateway_timeout', message: 'Gateway is busy.' },
    code: 'attempt_unavailable',
    transient: true,
  },
  {
    name: 'invalid input',
    status: 400,
    body: { code: 'invalid', message: 'La solicitud no es válida.' },
    code: 'invalid',
    transient: false,
  },
  {
    name: 'missing attempt',
    status: 404,
    body: { code: 'not_found', message: 'No se encontró el intento.' },
    code: 'not_found',
    transient: false,
  },
  {
    name: 'generic conflict',
    status: 409,
    body: { code: 'conflict', message: 'La solicitud ya no es válida.' },
    code: 'conflict',
    transient: false,
  },
  {
    name: 'malformed success response',
    status: 200,
    body: {},
    code: 'server',
    transient: false,
  },
  {
    name: 'authentication rejection',
    status: 401,
    body: { code: 'unauthorized', message: 'Unauthorized.' },
    code: 'authentication',
    transient: false,
    authContext: 31,
  },
] as const;

const rejectedValue = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the attempt read to fail.');
};

describe('AttemptApiClient result-read classification proposal', () => {
  it.each(failureCases)(
    'classifies $name without changing the read identity or cancellation signal',
    async (testCase) => {
      const { status, body, code, transient } = testCase;
      const authContext = 'authContext' in testCase ? testCase.authContext : undefined;
      const read = testCase.read ?? 'get';
      const id = 'attempt/16';
      const controller = new AbortController();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body), { status }));
      const client = new AttemptApiClient(config, {
        tokenProvider: () => ({ accessToken: 'private-access-token', authContext: 31 }),
        fetch: fetchImpl,
      });

      const failure = await rejectedValue(
        read === 'list'
          ? client.listAttempts(undefined, controller.signal)
          : client.getAttempt(id, controller.signal),
      );

      expect(failure).toMatchObject({
        code,
        status,
        ...(authContext === undefined ? {} : { authContext }),
      });
      expect(isTransientReadFailure(failure)).toBe(transient);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        read === 'list'
          ? `${config.apiBaseUrl}attempts`
          : `${config.apiBaseUrl}attempts/${encodeURIComponent(id)}`,
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
