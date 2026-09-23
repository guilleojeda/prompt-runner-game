import {
  MAX_DRAFT_BYTES,
  ROBOT_SCHEMA_VERSION,
  draftByteLength,
  validateDraft,
  type RobotDraft,
} from '../../../shared/robot.js';

const STORAGE_KEY = 'prompt-runner:attempt-recovery';

export interface AttemptRecoveryReference {
  readonly sub: string;
  readonly requestKey?: string;
  readonly attemptId?: string;
  readonly expectedVersion?: number;
  readonly draft?: RobotDraft;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const RECOVERY_KEYS = new Set(['sub', 'requestKey', 'attemptId', 'expectedVersion', 'draft']);

type RecoverySnapshotRecord = Record<string, unknown> & {
  readonly requestKey: string;
  readonly expectedVersion: number;
  readonly draft: RobotDraft;
};

function isRecoverySnapshot(value: Record<string, unknown>): value is RecoverySnapshotRecord {
  if (
    typeof value.requestKey !== 'string' ||
    value.requestKey.length === 0 ||
    typeof value.expectedVersion !== 'number' ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0 ||
    value.draft === undefined
  ) {
    return false;
  }
  if (!isRecord(value.draft) || value.draft.schemaVersion !== ROBOT_SCHEMA_VERSION) {
    return false;
  }
  try {
    const draft = validateDraft(value.draft);
    return draftByteLength(draft) <= MAX_DRAFT_BYTES;
  } catch {
    return false;
  }
}

export function readAttemptRecovery(sub: string): AttemptRecoveryReference | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && typeof value.sub === 'string' && value.sub !== sub) {
      clearAttemptRecovery(value.sub);
      return null;
    }
    if (
      !isRecord(value) ||
      value.sub !== sub ||
      typeof value.sub !== 'string' ||
      value.sub.length === 0 ||
      Object.keys(value).some((key) => !RECOVERY_KEYS.has(key))
    ) {
      return null;
    }
    if (
      (value.requestKey !== undefined && typeof value.requestKey !== 'string') ||
      (value.attemptId !== undefined && typeof value.attemptId !== 'string') ||
      (typeof value.requestKey === 'string' && value.requestKey.length === 0) ||
      (typeof value.attemptId === 'string' && value.attemptId.length === 0) ||
      (typeof value.requestKey !== 'string' && typeof value.attemptId !== 'string') ||
      hasOwn(value, 'expectedVersion') !== hasOwn(value, 'draft')
    ) {
      return null;
    }
    const snapshot = hasOwn(value, 'expectedVersion') && hasOwn(value, 'draft');
    if (snapshot) {
      if (!isRecoverySnapshot(value)) return null;
      return {
        sub,
        requestKey: value.requestKey,
        expectedVersion: value.expectedVersion,
        draft: validateDraft(value.draft),
        ...(typeof value.attemptId === 'string' ? { attemptId: value.attemptId } : {}),
      };
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
