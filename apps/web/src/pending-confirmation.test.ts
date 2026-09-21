// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitoPendingConfirmationClient, ConfirmationFailure } from './pending-confirmation.js';

const config = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  clientId: 'client-public',
  domain: 'https://prompt-runner.auth.us-east-1.amazoncognito.com',
  redirectUri: 'https://d1ilpq1n58tzqo.cloudfront.net/',
  logoutUri: 'https://d1ilpq1n58tzqo.cloudfront.net/',
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};

describe('pending Cognito confirmation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('confirms with the public API and the code already received, without resending', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    const client = new CognitoPendingConfirmationClient(config, { fetch: fetchImpl });

    await client.confirm(' pending@example.com ', ' 123456 ');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://cognito-idp.us-east-1.amazonaws.com/');
    expect(request?.method).toBe('POST');
    expect(request?.headers).toEqual({
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.ConfirmSignUp',
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      ClientId: 'client-public',
      Username: 'pending@example.com',
      ConfirmationCode: '123456',
    });
  });

  it('resends through the public API without including a confirmation code', async () => {
    const fetchImpl = vi.fn<typeof fetch>(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const client = new CognitoPendingConfirmationClient(config, { fetch: fetchImpl });

    await expect(client.resend('pending@example.com')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://cognito-idp.us-east-1.amazonaws.com/');
    expect(request?.method).toBe('POST');
    expect(request?.headers).toEqual({
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.ResendConfirmationCode',
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      ClientId: 'client-public',
      Username: 'pending@example.com',
    });
  });

  it('surfaces an invalid code without claiming confirmation succeeded', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ __type: 'CodeMismatchException' }), {
        status: 400,
        headers: { 'Content-Type': 'application/x-amz-json-1.1' },
      }),
    );
    const client = new CognitoPendingConfirmationClient(config, { fetch: fetchImpl });

    await expect(client.confirm('pending@example.com', 'wrong')).rejects.toMatchObject({
      code: 'invalid-code',
    });
  });

  it('surfaces expired code, quota, and network failures as recoverable errors', async () => {
    const responses = [
      new Response(JSON.stringify({ __type: 'ExpiredCodeException' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({ __type: 'LimitExceededException' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({ __type: 'LimitExceededException' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(responses[0]!)
      .mockResolvedValueOnce(responses[1]!)
      .mockResolvedValueOnce(responses[2]!)
      .mockRejectedValueOnce(new TypeError('offline'));
    const client = new CognitoPendingConfirmationClient(config, { fetch: fetchImpl });

    await expect(client.confirm('pending@example.com', 'old')).rejects.toMatchObject({
      code: 'expired-code',
    });
    await expect(client.confirm('pending@example.com', 'old')).rejects.toMatchObject({
      code: 'operation-limit',
    });
    await expect(client.resend('pending@example.com')).rejects.toMatchObject({
      code: 'rate-limit',
    });
    await expect(client.resend('pending@example.com')).rejects.toMatchObject({ code: 'network' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('treats a resend parameter error as invalid email input', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ __type: 'InvalidParameterException' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new CognitoPendingConfirmationClient(config, { fetch: fetchImpl });

    await expect(client.resend('pending@example.com')).rejects.toMatchObject({ code: 'account' });
  });

  it('rejects an email without making a network request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new CognitoPendingConfirmationClient(config, { fetch: fetchImpl });

    await expect(client.resend('  ')).rejects.toBeInstanceOf(ConfirmationFailure);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
