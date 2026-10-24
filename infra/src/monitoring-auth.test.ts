import { describe, expect, it } from 'vitest';
import {
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
});
