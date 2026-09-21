import { describe, expect, it } from 'vitest';
import {
  DraftValidationError,
  MAX_DRAFT_BYTES,
  ROBOT_CATALOG,
  createDefaultDraft,
  draftByteLength,
  draftsEqual,
  validateDraft,
} from './robot';

const draftWithInstructionBytes = (bytes: number) => {
  const base = createDefaultDraft();
  const withoutInstructions = { ...base, instructions: '' };
  const padding = bytes - draftByteLength(withoutInstructions);
  if (padding < 0) {
    throw new Error('The requested fixture is smaller than the fixed catalog.');
  }
  return { ...withoutInstructions, instructions: 'x'.repeat(padding) };
};

describe('robot draft contract', () => {
  it('publishes stable catalog order, opaque IDs, and the approved default', () => {
    const draft = createDefaultDraft();

    expect(ROBOT_CATALOG.map((entry) => entry.id)).toEqual([
      'advance',
      'retreat',
      'jump',
      'crouch',
      'swim',
    ]);
    expect(ROBOT_CATALOG.map((entry) => entry.opaqueId)).toEqual([
      'tool_1',
      'tool_2',
      'tool_3',
      'tool_4',
      'tool_5',
    ]);
    expect(ROBOT_CATALOG[3].name).toBe('Agacharse y avanzar');
    expect(ROBOT_CATALOG[4].description).toContain('ningún efecto');
    expect(draft.instructions).toBe(
      'Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo',
    );
    expect(draft.skills.filter((skill) => skill.enabled).map((skill) => skill.id)).toEqual([
      'advance',
    ]);
    expect(draft.skills.every((skill) => skill.description === '')).toBe(true);
    expect(ROBOT_CATALOG[2].inputSchema).toMatchObject({
      properties: { direction: { enum: ['izquierda', 'derecha'] } },
    });
  });

  it('canonicalizes order while preserving literal values and description presence', () => {
    const original = createDefaultDraft();
    const input = {
      ...original,
      instructions: '  línea 1\n🦾 línea 2  ',
      skills: [...original.skills]
        .reverse()
        .map(({ id, enabled }) =>
          id === 'jump'
            ? { id, enabled, description: '<texto literal>' }
            : id === 'retreat'
              ? { id, enabled }
              : { id, enabled, description: '' },
        ),
    };
    const parsed = validateDraft(input);

    expect(parsed.skills.map((skill) => skill.id)).toEqual(ROBOT_CATALOG.map((entry) => entry.id));
    expect(parsed.instructions).toBe('  línea 1\n🦾 línea 2  ');
    expect(parsed.skills.find((skill) => skill.id === 'jump')).toHaveProperty(
      'description',
      '<texto literal>',
    );
    expect(parsed.skills.find((skill) => skill.id === 'retreat')).not.toHaveProperty('description');
  });

  it('rejects schema, owner, unknown version, duplicate, and unknown IDs', () => {
    const draft = createDefaultDraft();
    const cases: unknown[] = [
      { ...draft, owner: 'USER#other' },
      {
        ...draft,
        skills: draft.skills.map((skill) =>
          skill.id === 'advance' ? { ...skill, inputSchema: { type: 'string' } } : skill,
        ),
      },
      { ...draft, schemaVersion: 99 },
      { ...draft, skills: [...draft.skills.slice(0, -1), { ...draft.skills[0] }] },
      {
        ...draft,
        skills: draft.skills.map((skill) =>
          skill.id === 'advance' ? { ...skill, id: 'unknown' } : skill,
        ),
      },
    ];

    for (const value of cases) {
      expect(() => validateDraft(value)).toThrowError(DraftValidationError);
    }
  });

  it.each([MAX_DRAFT_BYTES - 1, MAX_DRAFT_BYTES, MAX_DRAFT_BYTES + 1])(
    'measures the UTF-8 boundary at %i bytes',
    (bytes) => {
      const draft = draftWithInstructionBytes(bytes);
      expect(draftByteLength(draft)).toBe(bytes);
      if (bytes <= MAX_DRAFT_BYTES) {
        expect(validateDraft(draft)).toEqual(draft);
      } else {
        expect(() => validateDraft(draft)).toThrowError(
          expect.objectContaining({ code: 'too_large' }),
        );
      }
    },
  );

  it('counts multibyte UTF-8 text and distinguishes omitted from empty descriptions', () => {
    const draft = createDefaultDraft();
    const omitted = validateDraft({
      ...draft,
      skills: draft.skills.map(({ id, enabled }) => ({ id, enabled })),
    });
    const empty = validateDraft(draft);

    expect(draftByteLength({ ...draft, instructions: '🦾' })).toBe(
      draftByteLength({ ...draft, instructions: '' }) + 4,
    );
    expect(draftByteLength({ ...draft, instructions: '\\"\\\\' })).toBe(
      draftByteLength({ ...draft, instructions: '' }) + 8,
    );
    expect(draftsEqual(omitted, empty)).toBe(false);
    expect(draftsEqual(omitted, omitted)).toBe(true);
  });

  it('serializes frozen catalog schemas directly without mutating them', () => {
    const before = JSON.stringify(ROBOT_CATALOG);
    const bytes = draftByteLength(createDefaultDraft());

    expect(bytes).toBe(1480);
    expect(JSON.stringify(ROBOT_CATALOG)).toBe(before);
    expect(Object.isFrozen(ROBOT_CATALOG)).toBe(true);
    expect(Object.isFrozen(ROBOT_CATALOG[0].inputSchema)).toBe(true);
  });
});
