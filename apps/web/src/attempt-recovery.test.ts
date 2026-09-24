// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  addPendingPresentationAck,
  clearAttemptRecovery,
  clearForegroundAttemptRecovery,
  readPendingPresentationAcks,
  removePendingPresentationAck,
  writeAttemptRecovery,
} from './attempt-recovery.js';

afterEach(() => {
  window.sessionStorage.clear();
});

describe('pending presentation acknowledgements', () => {
  it('deduplicates IDs and removes only the confirmed ID', () => {
    window.sessionStorage.setItem(
      'prompt-runner:presentation-acks',
      JSON.stringify({ sub: 'subject-a', attemptIds: ['attempt-1', 'attempt-1', 'attempt-2'] }),
    );

    expect(readPendingPresentationAcks('subject-a')).toEqual(['attempt-1', 'attempt-2']);
    expect(window.sessionStorage.getItem('prompt-runner:presentation-acks')).toBe(
      JSON.stringify({ sub: 'subject-a', attemptIds: ['attempt-1', 'attempt-2'] }),
    );
    removePendingPresentationAck('subject-a', 'attempt-1');
    expect(readPendingPresentationAcks('subject-a')).toEqual(['attempt-2']);
  });

  it('does not expose another account queue and clears the foreign entry', () => {
    expect(addPendingPresentationAck('subject-a', 'attempt-1')).toBe(true);

    expect(readPendingPresentationAcks('subject-b')).toEqual([]);
    expect(window.sessionStorage.getItem('prompt-runner:presentation-acks')).toBeNull();
  });

  it('discards corrupt queue data without returning IDs', () => {
    window.sessionStorage.setItem(
      'prompt-runner:presentation-acks',
      JSON.stringify({ sub: 'subject-a', attemptIds: ['attempt-1', 42] }),
    );

    expect(readPendingPresentationAcks('subject-a')).toEqual([]);
    expect(window.sessionStorage.getItem('prompt-runner:presentation-acks')).toBeNull();
  });

  it('preserves the queue when clearing only the foreground reference and clears both on logout', () => {
    writeAttemptRecovery({ sub: 'subject-a', attemptId: 'attempt-2' });
    expect(addPendingPresentationAck('subject-a', 'attempt-1')).toBe(true);

    clearForegroundAttemptRecovery('subject-a');
    expect(window.sessionStorage.getItem('prompt-runner:attempt-recovery')).toBeNull();
    expect(readPendingPresentationAcks('subject-a')).toEqual(['attempt-1']);

    clearAttemptRecovery('subject-a');
    expect(window.sessionStorage.getItem('prompt-runner:presentation-acks')).toBeNull();
  });
});
