import { Buffer } from 'node:buffer';
import * as crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  cloudFrontBasicAuthCode,
  requireMonitoringAuthVerifier,
  validateMonitoringAuthVerifier,
} from './monitoring-auth.js';

const verifier = 'a'.repeat(64);

describe('monitoring authentication synthesis configuration', () => {
  it('requires an explicit verifier and never supplies a local or CI fallback', () => {
    expect(() => requireMonitoringAuthVerifier({})).toThrow(/MONITORING_BASIC_AUTH_SHA256/u);
    expect(() => validateMonitoringAuthVerifier(undefined)).toThrow(
      /MONITORING_BASIC_AUTH_SHA256/u,
    );
  });

  it('accepts only a lowercase SHA-256 hex digest', () => {
    expect(validateMonitoringAuthVerifier(verifier)).toBe(verifier);
    for (const invalid of ['', 'not-a-digest', verifier.toUpperCase(), `${verifier}0`]) {
      expect(() => validateMonitoringAuthVerifier(invalid)).toThrow(
        /MONITORING_BASIC_AUTH_SHA256/u,
      );
    }
  });

  it('rejects a noncanonical Basic token that permissive base64 decoding accepts', () => {
    const password = 'fixture-only-password';
    const credentials = `monitor:${password}`;
    const authVerifier = crypto.createHash('sha256').update(credentials, 'utf8').digest('hex');
    const token = Buffer.from(credentials, 'utf8').toString('base64');
    expect(Buffer.from(`${token}!`, 'base64').toString('utf8')).toBe(credentials);

    const invoke = (authorization: string) => {
      const event = {
        request: {
          method: 'GET',
          uri: '/api/metrics',
          querystring: {},
          headers: { authorization: { value: authorization } },
          cookies: {},
        },
      };
      return runInNewContext(`${cloudFrontBasicAuthCode(authVerifier)}; handler(event)`, {
        event,
        Buffer,
        require: (name: string) => {
          if (name !== 'crypto') throw new Error(`Unexpected edge dependency ${name}`);
          return crypto;
        },
      });
    };

    const accepted = invoke(`Basic ${token}`) as { headers: Record<string, unknown> };
    expect(accepted.headers.authorization).toBeUndefined();

    const rejected = invoke(`Basic ${token}!`) as {
      statusCode: number;
      headers: Record<string, { value: string }>;
    };
    expect(rejected.statusCode).toBe(401);
    expect(rejected.headers['www-authenticate'].value).toMatch(/^Basic /u);
    expect(rejected.headers['cache-control'].value).toBe('no-store');
  });
});
