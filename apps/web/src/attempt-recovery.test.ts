// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultDraft,
  ROBOT_CATALOG_VERSION,
  ROBOT_SCHEMA_VERSION,
} from '../../../shared/robot.js';
import {
  clearAttemptRecovery,
  readAttemptRecovery,
  writeAttemptRecovery,
} from './attempt-recovery.js';

const STORAGE_KEY = 'prompt-runner:attempt-recovery';

afterEach(() => window.sessionStorage.clear());

describe('attempt recovery references', () => {
  it('round trips a current frozen admission snapshot', () => {
    const draft = createDefaultDraft();
    const reference = {
      sub: 'subject-a',
      requestKey: 'request-key',
      expectedVersion: 4,
      draft,
      animationEnabled: true,
    };

    writeAttemptRecovery(reference);

    expect(readAttemptRecovery('subject-a')).toEqual(reference);
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      draftContract: {
        schemaVersion: ROBOT_SCHEMA_VERSION,
        catalogVersion: ROBOT_CATALOG_VERSION,
      },
    });
  });

  it('round trips a current foreground attempt reference without a local draft', () => {
    writeAttemptRecovery({ sub: 'subject-a', attemptId: 'attempt-current' });

    expect(readAttemptRecovery('subject-a')).toEqual({
      sub: 'subject-a',
      attemptId: 'attempt-current',
    });
  });

  it('ignores a frozen admission without its saved animation choice', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sub: 'subject-a',
        draftContract: {
          schemaVersion: ROBOT_SCHEMA_VERSION,
          catalogVersion: ROBOT_CATALOG_VERSION,
        },
        requestKey: 'old-frozen-key',
        expectedVersion: 2,
        draft: createDefaultDraft(),
      }),
    );

    expect(readAttemptRecovery('subject-a')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it.each([
    undefined,
    { schemaVersion: 2, catalogVersion: 1 },
    { schemaVersion: 3, catalogVersion: 1 },
  ])('ignores and clears references without the current draft contract: %s', (draftContract) => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sub: 'subject-a',
        attemptId: 'attempt-obsolete',
        ...(draftContract === undefined ? {} : { draftContract }),
      }),
    );

    expect(readAttemptRecovery('subject-a')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not return another account’s reference and clears that stale identity', () => {
    writeAttemptRecovery({ sub: 'subject-a', attemptId: 'attempt-a' });

    expect(readAttemptRecovery('subject-b')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clears only the requested account reference', () => {
    writeAttemptRecovery({ sub: 'subject-a', attemptId: 'attempt-a' });
    clearAttemptRecovery('subject-b');
    expect(readAttemptRecovery('subject-a')).toEqual({ sub: 'subject-a', attemptId: 'attempt-a' });

    clearAttemptRecovery('subject-a');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
