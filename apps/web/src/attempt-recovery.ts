const STORAGE_KEY = 'prompt-runner:attempt-recovery';

export interface AttemptRecoveryReference {
  readonly sub: string;
  readonly requestKey?: string;
  readonly attemptId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readAttemptRecovery(sub: string): AttemptRecoveryReference | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.sub !== sub) return null;
    if (
      (value.requestKey !== undefined && typeof value.requestKey !== 'string') ||
      (value.attemptId !== undefined && typeof value.attemptId !== 'string') ||
      (typeof value.requestKey !== 'string' && typeof value.attemptId !== 'string')
    ) {
      return null;
    }
    return {
      sub,
      ...(typeof value.requestKey === 'string' ? { requestKey: value.requestKey } : {}),
      ...(typeof value.attemptId === 'string' ? { attemptId: value.attemptId } : {}),
    };
  } catch {
    return null;
  }
}

export function writeAttemptRecovery(reference: AttemptRecoveryReference): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(reference));
  } catch {
    // Storage is a recovery hint; the server remains authoritative.
  }
}

export function clearAttemptRecovery(sub?: string): void {
  try {
    const current = window.sessionStorage.getItem(STORAGE_KEY);
    if (!current || !sub) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    const value: unknown = JSON.parse(current);
    if (isRecord(value) && value.sub === sub) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
  }
}
