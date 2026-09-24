import {
  MAX_DRAFT_BYTES,
  ROBOT_SCHEMA_VERSION,
  draftByteLength,
  validateDraft,
  type RobotDraft,
} from '../../../shared/robot.js';

const STORAGE_KEY = 'prompt-runner:attempt-recovery';
const PRESENTATION_ACKS_KEY = 'prompt-runner:presentation-acks';

export interface AttemptRecoveryReference {
  readonly sub: string;
  readonly requestKey?: string;
  readonly attemptId?: string;
  readonly expectedVersion?: number;
  readonly draft?: RobotDraft;
  readonly animationEnabled?: boolean;
}

interface PendingPresentationAcks {
  readonly sub: string;
  readonly attemptIds: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const RECOVERY_KEYS = new Set([
  'sub',
  'requestKey',
  'attemptId',
  'expectedVersion',
  'draft',
  'animationEnabled',
]);

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
      hasOwn(value, 'expectedVersion') !== hasOwn(value, 'draft') ||
      (hasOwn(value, 'animationEnabled') && typeof value.animationEnabled !== 'boolean')
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
        ...(typeof value.animationEnabled === 'boolean'
          ? { animationEnabled: value.animationEnabled }
          : {}),
        ...(typeof value.attemptId === 'string' ? { attemptId: value.attemptId } : {}),
      };
    }
    return {
      sub,
      ...(typeof value.requestKey === 'string' ? { requestKey: value.requestKey } : {}),
      ...(typeof value.attemptId === 'string' ? { attemptId: value.attemptId } : {}),
      ...(typeof value.animationEnabled === 'boolean'
        ? { animationEnabled: value.animationEnabled }
        : {}),
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
  clearForegroundAttemptRecovery(sub);
  clearPendingPresentationAcks(sub);
}

export function clearForegroundAttemptRecovery(sub?: string): void {
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

export function readPendingPresentationAcks(sub: string): readonly string[] {
  try {
    const raw = window.sessionStorage.getItem(PRESENTATION_ACKS_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && typeof value.sub === 'string' && value.sub !== sub) {
      clearPendingPresentationAcks(value.sub);
      return [];
    }
    if (
      !isRecord(value) ||
      value.sub !== sub ||
      typeof value.sub !== 'string' ||
      !Array.isArray(value.attemptIds) ||
      Object.keys(value).some((key) => key !== 'sub' && key !== 'attemptIds') ||
      value.attemptIds.some(
        (attemptId) =>
          typeof attemptId !== 'string' || attemptId.length === 0 || attemptId.length > 256,
      )
    ) {
      window.sessionStorage.removeItem(PRESENTATION_ACKS_KEY);
      return [];
    }
    const attemptIds = [...new Set(value.attemptIds as string[])];
    if (attemptIds.length !== value.attemptIds.length) {
      writePendingPresentationAcks({ sub, attemptIds });
    }
    return attemptIds;
  } catch {
    window.sessionStorage.removeItem(PRESENTATION_ACKS_KEY);
    return [];
  }
}

export function addPendingPresentationAck(sub: string, attemptId: string): boolean {
  if (!attemptId || attemptId.length > 256) return false;
  const attemptIds = readPendingPresentationAcks(sub);
  if (attemptIds.includes(attemptId)) return true;
  return writePendingPresentationAcks({ sub, attemptIds: [...attemptIds, attemptId] });
}

export function removePendingPresentationAck(sub: string, attemptId: string): void {
  const attemptIds = readPendingPresentationAcks(sub);
  const remaining = attemptIds.filter((id) => id !== attemptId);
  if (remaining.length === attemptIds.length) return;
  if (remaining.length === 0) {
    clearPendingPresentationAcks(sub);
  } else {
    writePendingPresentationAcks({ sub, attemptIds: remaining });
  }
}

export function hasPendingPresentationAck(sub: string, attemptId: string): boolean {
  return readPendingPresentationAcks(sub).includes(attemptId);
}

export function clearPendingPresentationAcks(sub?: string): void {
  try {
    const current = window.sessionStorage.getItem(PRESENTATION_ACKS_KEY);
    if (!current || !sub) {
      window.sessionStorage.removeItem(PRESENTATION_ACKS_KEY);
      return;
    }
    const value: unknown = JSON.parse(current);
    if (!isRecord(value) || value.sub === sub) {
      window.sessionStorage.removeItem(PRESENTATION_ACKS_KEY);
    }
  } catch {
    window.sessionStorage.removeItem(PRESENTATION_ACKS_KEY);
  }
}

function writePendingPresentationAcks(value: PendingPresentationAcks): boolean {
  try {
    if (value.attemptIds.length === 0) {
      window.sessionStorage.removeItem(PRESENTATION_ACKS_KEY);
    } else {
      window.sessionStorage.setItem(PRESENTATION_ACKS_KEY, JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
}
