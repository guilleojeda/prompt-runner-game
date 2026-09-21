import { describe, expect, it } from 'vitest';
import {
  createClosedAttemptRecordFixture,
  representativeAttemptItems,
  utf8ByteLength,
} from './attempt.fixture.js';
import { ATTEMPT_RECORD_VERSION } from './attempt.js';

const DYNAMODB_ITEM_LIMIT = 400 * 1024;
const REQUIRED_ITEM_MARGIN = 16 * 1024;

describe('durable closed attempt contract fixture', () => {
  it('keeps the immutable record version, level and effective score parameters', () => {
    const record = createClosedAttemptRecordFixture();

    expect(record.recordVersion).toBe(ATTEMPT_RECORD_VERSION);
    expect(record.config.level.id).toBe('principal-estatico-v1');
    expect(record.config.level.version).toBe(1);
    expect(record.config.level.rulesVersion).toBe(1);
    expect(record.config.scoreRules).toMatchObject({
      base: 1000,
      turnWeight: 10,
      tokenWeight: 1,
      tokenUnit: 1000,
      decimalPlaces: 2,
      allowNegative: true,
    });
    expect(Object.isFrozen(record.config)).toBe(true);
    expect(Object.isFrozen(record.config.scoreRules)).toBe(true);
    expect(record.score).toBe(949.4);
  });

  it('forms a closed reference chain without duplicating posterior snapshots in actions', () => {
    const record = createClosedAttemptRecordFixture();
    const snapshotIds = record.snapshots.map((snapshot) => snapshot.id);

    expect(snapshotIds).toEqual(['state-0', 'state-1', 'state-2', 'state-3', 'state-4', 'state-5']);
    expect(new Set(snapshotIds).size).toBe(snapshotIds.length);
    expect(record.actions).toHaveLength(record.snapshots.length - 1);
    for (const [index, action] of record.actions.entries()) {
      expect(action.seq).toBe(index + 1);
      expect(action.beforeStateId).toBe(snapshotIds[index]);
      expect(action.afterStateId).toBe(snapshotIds[index + 1]);
      expect(action).not.toHaveProperty('before');
      expect(action).not.toHaveProperty('after');
    }
    expect(record.closure).toEqual({
      status: 'victory',
      actionCount: 5,
      finalStateId: 'state-5',
      recordComplete: true,
    });
  });

  it('checks representative DynamoDB projections per item, leaving bodies in S3 references', () => {
    const record = createClosedAttemptRecordFixture();
    const items = representativeAttemptItems(record);
    const keys = items.map(({ PK, SK }) => `${PK}/${SK}`);

    expect(keys).toContain('USER#fixture-owner/ATTEMPT#fixture-closed-attempt');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/META');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/STATE#state-0');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/STATE#state-5');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/ACTION#00000001');
    expect(keys).toContain('ATTEMPT#fixture-closed-attempt/CALL#00000001');
    expect(
      items.every((item) => utf8ByteLength(item) < DYNAMODB_ITEM_LIMIT - REQUIRED_ITEM_MARGIN),
    ).toBe(true);

    const call = items.find(({ SK }) => SK === 'CALL#00000001');
    expect(call?.value).toMatchObject({
      requestBytes: 1024,
      responseBytes: 2048,
      requestKey: expect.stringContaining('/request.json'),
      responseKey: expect.stringContaining('/response.json'),
    });
    expect(call?.value).not.toHaveProperty('requestBody');
    expect(call?.value).not.toHaveProperty('responseBody');
  });
});
