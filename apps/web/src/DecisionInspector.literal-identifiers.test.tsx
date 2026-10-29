// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import {
  type AttemptApi,
  type DecisionChoice,
  type DecisionDetail,
  type DecisionIndex,
  type DecisionIndexItem,
} from './attempt-api.js';
import { DecisionInspector } from './DecisionInspector.js';

const attemptId = 'attempt-literal-identifiers';
const opaqueChoiceId = 'tool_choice_9';

function inspectorApi(
  choice: DecisionChoice,
  availableActions: DecisionDetail['availableActions'],
) {
  const item: DecisionIndexItem = {
    number: 1,
    decisionId: 'decision-1',
    originSupport: 2,
    hasAction: choice.state !== 'invalid',
  };
  const index: DecisionIndex = { attemptId, levelId: LEVEL.id, decisions: [item] };
  const detail: DecisionDetail = {
    attemptId,
    levelId: LEVEL.id,
    item,
    observation: null,
    availableActions,
    choice,
    result:
      choice.state === 'invalid'
        ? { kind: 'no-action', turnsUsed: 0, status: 'error', reason: 'invalid_response' }
        : {
            kind: 'action',
            action: { kind: 'jump', direction: 'right' },
            resolution: { outcome: 'moved', reason: 'moved' },
            beforeSupport: item.originSupport,
            afterSupport: item.originSupport + 1,
            turnsUsed: 1,
          },
  };
  const getDecisionIndex = vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(index);
  const getDecision = vi.fn<AttemptApi['getDecision']>().mockResolvedValue(detail);
  return {
    api: { getDecisionIndex, getDecision } as unknown as AttemptApi,
    getDecisionIndex,
    getDecision,
  };
}

async function openLiteralOptions() {
  await screen.findByRole('heading', { name: 'Observación' });
  const disclosure = screen.getByText('Opciones y datos literales').closest('details');
  expect(disclosure).not.toBeNull();
  if (!disclosure) throw new Error('No se encontró el desplegable de opciones.');
  fireEvent.click(within(disclosure).getByText('Opciones y datos literales'));
  return disclosure;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DecisionInspector literal choice identifiers', () => {
  it.each([
    { availableActions: null, label: 'unavailable actions' },
    { availableActions: [], label: 'an empty action list' },
  ])('keeps a selected choice ID consultable with $label', async ({ availableActions }) => {
    const { api, getDecisionIndex, getDecision } = inspectorApi(
      {
        state: 'selected',
        opaqueId: opaqueChoiceId,
        action: { kind: 'jump', direction: 'right' },
        parameters: { direction: 'right' },
      },
      availableActions,
    );
    render(<DecisionInspector api={api} attemptId={attemptId} onClose={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Observación' });
    const action = screen.getByRole('heading', { name: 'Acción elegida' }).parentElement;
    expect(action?.textContent).not.toContain(opaqueChoiceId);
    const initialDisclosure = screen.getByText('Opciones y datos literales').closest('details');
    expect(initialDisclosure?.open).toBe(false);
    expect(screen.getByText(opaqueChoiceId, { selector: 'code' }).closest('details')).toBe(
      initialDisclosure,
    );

    const disclosure = await openLiteralOptions();
    expect(disclosure).toBe(initialDisclosure);
    const idLabel = within(disclosure).getByText(/ID de la elección:/);
    expect(disclosure.open).toBe(true);
    expect(idLabel.textContent).toContain(opaqueChoiceId);
    expect(idLabel.closest('details')).toBe(disclosure);
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    expect(getDecision).toHaveBeenCalledOnce();
  });

  it('shows an optional ID for an invalid choice and invents none for an unknown choice', async () => {
    const invalidApi = inspectorApi(
      { state: 'invalid', opaqueId: opaqueChoiceId, parameters: null },
      [],
    );
    render(<DecisionInspector api={invalidApi.api} attemptId={attemptId} onClose={vi.fn()} />);

    const invalidDisclosure = await openLiteralOptions();
    expect(within(invalidDisclosure).getByText(/ID de la elección:/).textContent).toContain(
      opaqueChoiceId,
    );

    cleanup();
    const unknownApi = inspectorApi({ state: 'unknown' }, []);
    render(<DecisionInspector api={unknownApi.api} attemptId={attemptId} onClose={vi.fn()} />);

    const unknownDisclosure = await openLiteralOptions();
    expect(within(unknownDisclosure).queryByText(/ID de la elección:/)).toBeNull();
    expect(within(unknownDisclosure).queryByText(/tool_choice_9/)).toBeNull();
  });
});
