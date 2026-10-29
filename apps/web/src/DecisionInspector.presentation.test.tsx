// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import {
  type AttemptApi,
  type DecisionDetail,
  type DecisionIndex,
  type DecisionIndexItem,
} from './attempt-api.js';
import { DecisionInspector } from './DecisionInspector.js';

const attemptId = 'attempt-presentation';

function decisionItem(number: number, originSupport = number + 1): DecisionIndexItem {
  return {
    number,
    decisionId: `decision-${number}`,
    originSupport,
    hasAction: true,
  };
}

function decisionIndex(...items: readonly DecisionIndexItem[]): DecisionIndex {
  return { attemptId, levelId: LEVEL.id, decisions: items };
}

function decisionDetail(
  item: DecisionIndexItem,
  overrides: Partial<DecisionDetail> = {},
): DecisionDetail {
  return {
    attemptId,
    levelId: LEVEL.id,
    item,
    observation: {
      facing: 'right',
      here: { objects: [], exit: false },
      left: { kind: 'segment', terrain: 'ground' },
      right: { kind: 'boundary' },
    },
    availableActions: [],
    choice: {
      state: 'selected',
      opaqueId: 'tool_1',
      action: { kind: 'advance' },
      parameters: {},
    },
    result: {
      kind: 'action',
      action: { kind: 'advance' },
      resolution: { outcome: 'moved', reason: 'moved' },
      beforeSupport: item.originSupport,
      afterSupport: item.originSupport + 1,
      turnsUsed: 1,
    },
    ...overrides,
  };
}

function inspectorApi(
  index: DecisionIndex,
  details: ReadonlyMap<number, DecisionDetail>,
  getDecisionOverride?: AttemptApi['getDecision'],
) {
  const getDecisionIndex = vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(index);
  const getDecision = getDecisionOverride
    ? vi.fn<AttemptApi['getDecision']>(getDecisionOverride)
    : vi.fn<AttemptApi['getDecision']>().mockImplementation(async (_id, number) => {
        const loaded = details.get(number);
        if (!loaded) throw new Error(`No fixture for decision ${number}.`);
        return loaded;
      });
  const effects = {
    createAttempt: vi.fn(),
    startAttempt: vi.fn(),
    cancelAttempt: vi.fn(),
    getAttempt: vi.fn(),
    getConfiguration: vi.fn(),
    getReplay: vi.fn(),
    completePresentation: vi.fn(),
  };
  return {
    api: { getDecisionIndex, getDecision, ...effects } as unknown as AttemptApi,
    getDecisionIndex,
    getDecision,
    effects,
  };
}

async function waitForDecisionCard(number = 1): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: 'Observación' });
  return screen.getByRole('group', { name: new RegExp(`Decisión ${number}, casilla`) });
}

function literalDisclosure(card: HTMLElement): HTMLDetailsElement | null {
  return within(card).getByText('Opciones y datos literales').closest('details');
}

function factBlock(card: HTMLElement, label: string): HTMLElement {
  const heading = within(card).getByRole('heading', { name: label });
  let parent = heading.parentElement;
  while (parent && parent !== card) {
    if (parent.querySelectorAll('h1,h2,h3,h4,h5,h6').length === 1) return parent;
    parent = parent.parentElement;
  }
  throw new Error(`No se encontró el bloque de ${label}.`);
}

function nestedJsonValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return [value, ...value.flatMap(nestedJsonValues)];
  if (typeof value === 'object' && value !== null) {
    return [value, ...Object.values(value).flatMap(nestedJsonValues)];
  }
  return [value];
}

function parsedJsonValues(root: HTMLElement): unknown[] {
  const values: unknown[] = [];
  for (const element of root.querySelectorAll('*')) {
    if (element.children.length > 0) continue;
    const text = element.textContent?.trim();
    if (!text) continue;
    try {
      values.push(...nestedJsonValues(JSON.parse(text) as unknown));
    } catch {
      // Narrative and labels are not raw JSON values.
    }
  }
  return values;
}

function stubScrollIntoView() {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  return {
    scrollIntoView,
    restore() {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DecisionInspector presentation', () => {
  it('puts observation, chosen action, and resolution before a closed native disclosure', async () => {
    const item = decisionItem(1);
    const loaded = decisionDetail(item);
    const { api } = inspectorApi(decisionIndex(item), new Map([[1, loaded]]));
    render(<DecisionInspector api={api} attemptId={attemptId} onClose={vi.fn()} />);

    const card = await waitForDecisionCard();
    const observation = within(card).getByRole('heading', { name: 'Observación' });
    const action = within(card).getByRole('heading', { name: 'Acción elegida' });
    const resolution = within(card).getByRole('heading', { name: 'Resolución' });
    const disclosure = literalDisclosure(card);

    expect(
      observation.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      action.compareDocumentPosition(resolution) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(disclosure).not.toBeNull();
    if (!disclosure) return;
    expect(
      resolution.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(disclosure.open).toBe(false);
  });

  it('shows a human action and Spanish direction first, with option IDs inside the disclosure', async () => {
    const item = decisionItem(1);
    const loaded = decisionDetail(item, {
      availableActions: [{ opaqueId: 'tool_3', label: 'Saltar', description: 'Cruza la rama.' }],
      choice: {
        state: 'selected',
        opaqueId: 'tool_3',
        action: { kind: 'jump', direction: 'right' },
        parameters: { direction: 'right' },
      },
      result: {
        kind: 'action',
        action: { kind: 'jump', direction: 'right' },
        resolution: { outcome: 'moved', reason: 'moved' },
        beforeSupport: item.originSupport,
        afterSupport: item.originSupport + 1,
        turnsUsed: 1,
      },
    });
    const { api } = inspectorApi(decisionIndex(item), new Map([[1, loaded]]));
    render(<DecisionInspector api={api} attemptId={attemptId} onClose={vi.fn()} />);

    const card = await waitForDecisionCard();
    const summaryText = factBlock(card, 'Acción elegida').textContent ?? '';
    expect(summaryText).toContain('Saltar');
    expect(summaryText).toContain('derecha');
    expect(summaryText).not.toContain('tool_3');
    expect(summaryText).not.toContain('right');
    expect(summaryText).not.toMatch(/[{}]/);

    const disclosure = literalDisclosure(card);
    expect(disclosure).not.toBeNull();
    if (!disclosure) return;
    fireEvent.click(within(disclosure).getByText('Opciones y datos literales'));
    const option = within(disclosure)
      .getAllByRole('listitem')
      .find((element) => element.textContent?.includes('tool_3'));
    expect(option).toBeTruthy();
    const optionText = option?.textContent ?? '';
    expect(optionText.indexOf('Saltar')).toBeGreaterThanOrEqual(0);
    expect(optionText.indexOf('Saltar')).toBeLessThan(optionText.indexOf('tool_3'));
  });

  it('keeps full descriptions and projected JSON values available across disclosure close and reopen', async () => {
    const item = decisionItem(1);
    const longDescription = '  Avanza con cuidado\ncon la opción 🚀 y conserva espacios.  ';
    const choiceAction = {
      kind: 'jump',
      direction: 'right',
      providerAction: { flag: false, rank: 0, note: null },
    };
    const choiceParameters = {
      direction: 'right',
      extension: { values: ['opaco', null, false, 0] },
    };
    const resultAction = {
      kind: 'jump',
      direction: 'right',
      providerResult: { accepted: false, count: 0, omitted: null },
    };
    const resultResolution = {
      outcome: 'moved',
      reason: 'moved',
      providerResolution: { detail: null, verified: false, score: 0 },
    };
    const loaded = decisionDetail(item, {
      availableActions: [
        { opaqueId: 'tool_3', label: 'Saltar', description: longDescription },
        { opaqueId: 'tool_6', label: 'Esperar' },
        { opaqueId: 'tool_7', label: 'Agarrar objeto', description: '' },
      ],
      choice: {
        state: 'selected',
        opaqueId: 'tool_3',
        action: choiceAction,
        parameters: choiceParameters,
      },
      result: {
        kind: 'action',
        action: resultAction,
        resolution: resultResolution,
        beforeSupport: item.originSupport,
        afterSupport: item.originSupport + 1,
        turnsUsed: 1,
      },
    });
    const { api, getDecisionIndex, getDecision, effects } = inspectorApi(
      decisionIndex(item),
      new Map([[1, loaded]]),
    );
    render(<DecisionInspector api={api} attemptId={attemptId} onClose={vi.fn()} />);

    const card = await waitForDecisionCard();
    const disclosure = literalDisclosure(card);
    expect(disclosure).not.toBeNull();
    if (!disclosure) return;
    const summary = within(disclosure).getByText('Opciones y datos literales');
    expect(disclosure.open).toBe(false);
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain(longDescription);
    const omittedOption = within(disclosure)
      .getAllByRole('listitem')
      .find((element) => element.textContent?.includes('tool_6'));
    const emptyOption = within(disclosure)
      .getAllByRole('listitem')
      .find((element) => element.textContent?.includes('tool_7'));
    expect(omittedOption?.textContent).toMatch(
      /omitid|no (?:se )?(?:registr[oó]|incluy[oó]|envi[oó])/i,
    );
    expect(emptyOption?.textContent).toMatch(/vac[ií]a|sin (?:texto|contenido)/i);
    const jsonValues = parsedJsonValues(disclosure);
    expect(jsonValues).toEqual(
      expect.arrayContaining([choiceAction, choiceParameters, resultAction, resultResolution]),
    );
    expect(jsonValues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptId,
          levelId: LEVEL.id,
          item: expect.any(Object),
          observation: expect.any(Object),
          availableActions: expect.any(Array),
          choice: expect.any(Object),
          result: expect.any(Object),
        }),
      ]),
    );

    fireEvent.click(summary);
    expect(disclosure.open).toBe(false);
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    expect(parsedJsonValues(disclosure)).toEqual(
      expect.arrayContaining([choiceAction, choiceParameters, resultAction, resultResolution]),
    );
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    expect(getDecision).toHaveBeenCalledOnce();
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('uses the recorded action as the honest fallback for an unknown choice and exposes its literal data', async () => {
    const item = decisionItem(1);
    const recordedActionData = {
      kind: 'crouch',
      direction: 'left',
      extension: { source: 'executor', value: false },
    };
    const resolution = {
      outcome: 'no_op',
      reason: 'swim_no_effect',
      extension: { measured: 0, detail: null },
    };
    const loaded = decisionDetail(item, {
      availableActions: [],
      choice: { state: 'unknown' },
      result: {
        kind: 'action',
        action: recordedActionData,
        resolution,
        beforeSupport: item.originSupport,
        afterSupport: item.originSupport,
        turnsUsed: 1,
      },
    });
    const { api } = inspectorApi(decisionIndex(item), new Map([[1, loaded]]));
    render(<DecisionInspector api={api} attemptId={attemptId} onClose={vi.fn()} />);

    const card = await waitForDecisionCard();
    const recordedActionText = factBlock(card, 'Resolución').textContent ?? '';
    expect(recordedActionText).toMatch(/acción registrada/i);
    expect(recordedActionText).toContain('Agacharse');
    expect(recordedActionText).toContain('izquierda');
    const disclosure = literalDisclosure(card);
    expect(disclosure).not.toBeNull();
    if (!disclosure) return;
    fireEvent.click(within(disclosure).getByText('Opciones y datos literales'));
    expect(parsedJsonValues(disclosure)).toEqual(
      expect.arrayContaining([recordedActionData, resolution]),
    );
  });

  it('replaces expanded decision A with B without mixing data or moving manual focus or scroll', async () => {
    const scroll = stubScrollIntoView();
    const first = decisionItem(1, 2);
    const second = decisionItem(2, 4);
    const firstDetail = decisionDetail(first, {
      choice: {
        state: 'selected',
        opaqueId: 'tool_1',
        action: { kind: 'advance', fixtureMarker: 'A_ONLY_ACTION' },
        parameters: { fixtureMarker: 'A_ONLY_PARAMETERS' },
      },
    });
    const secondDetail = decisionDetail(second, {
      choice: {
        state: 'selected',
        opaqueId: 'tool_3',
        action: { kind: 'jump', direction: 'left', fixtureMarker: 'B_ONLY_ACTION' },
        parameters: { fixtureMarker: 'B_ONLY_PARAMETERS' },
      },
      result: {
        kind: 'action',
        action: { kind: 'jump', fixtureMarker: 'B_RESULT' },
        resolution: { outcome: 'moved', fixtureMarker: 'B_RESOLUTION' },
        beforeSupport: second.originSupport,
        afterSupport: second.originSupport + 1,
        turnsUsed: 1,
      },
    });
    let resolveSecond!: (detail: DecisionDetail) => void;
    const secondResponse = new Promise<DecisionDetail>((resolve) => {
      resolveSecond = resolve;
    });
    const { api, getDecisionIndex, getDecision } = inspectorApi(
      decisionIndex(first, second),
      new Map([
        [1, firstDetail],
        [2, secondDetail],
      ]),
      vi.fn<AttemptApi['getDecision']>((_id, number) =>
        number === 1 ? Promise.resolve(firstDetail) : secondResponse,
      ),
    );

    try {
      render(<DecisionInspector api={api} attemptId={attemptId} onClose={vi.fn()} />);
      const firstCard = await waitForDecisionCard(1);
      const firstDisclosure = literalDisclosure(firstCard);
      expect(firstDisclosure).not.toBeNull();
      if (!firstDisclosure) return;
      fireEvent.click(within(firstDisclosure).getByText('Opciones y datos literales'));
      expect(firstDisclosure.open).toBe(true);
      expect(parsedJsonValues(firstDisclosure)).toContainEqual(
        expect.objectContaining({ fixtureMarker: 'A_ONLY_PARAMETERS' }),
      );

      const secondButton = screen.getAllByRole('button', { name: /Decisión 2/ })[0]!;
      secondButton.focus();
      fireEvent.click(secondButton);
      expect(document.activeElement).toBe(secondButton);
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();

      await act(async () => {
        resolveSecond(secondDetail);
      });
      const secondCard = screen.getByRole('group', { name: /Decisión 2, casilla/ });
      expect(within(secondCard).getByText(/Saltar/)).toBeTruthy();
      expect(secondCard.textContent).not.toContain('A_ONLY');
      expect(secondCard.textContent).toContain('B_ONLY_ACTION');
      expect(document.activeElement).toBe(secondButton);
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();
      expect(getDecisionIndex).toHaveBeenCalledOnce();
      expect(getDecision).toHaveBeenCalledTimes(2);
    } finally {
      scroll.restore();
    }
  });

  it.each([
    {
      name: 'invalid choice',
      choice: { state: 'invalid' as const },
      choiceCopy: /elección registrada.*inválida/i,
    },
    {
      name: 'missing choice',
      choice: null,
      choiceCopy: /no hubo una elección registrada/i,
    },
  ])(
    'explains a no-action result with an $name without inventing a turn',
    async ({ choice, choiceCopy }) => {
      const item = { ...decisionItem(1), hasAction: false };
      const loaded = decisionDetail(item, {
        availableActions: null,
        choice,
        result: {
          kind: 'no-action',
          turnsUsed: 0,
          status: 'error',
          reason: 'invalid_response',
        },
      });
      const { api } = inspectorApi(decisionIndex(item), new Map([[1, loaded]]));
      render(<DecisionInspector api={api} attemptId={attemptId} onClose={vi.fn()} />);

      const card = await waitForDecisionCard();
      expect(within(card).getByText(/no se ejecutó ninguna acción/i)).toBeTruthy();
      expect(within(card).getByText(choiceCopy)).toBeTruthy();
      expect(within(card).getByText(/respuesta inválida/i)).toBeTruthy();
      expect(card.textContent).not.toMatch(/turno\s+0/i);
      expect(card.textContent).not.toContain('invalid_response');

      const disclosure = literalDisclosure(card);
      expect(disclosure).not.toBeNull();
      if (!disclosure) return;
      fireEvent.click(within(disclosure).getByText('Opciones y datos literales'));
      const literalValues = JSON.stringify(parsedJsonValues(disclosure));
      expect(literalValues).not.toContain('invalid_response');
      expect(literalValues).not.toContain('"reason"');
      expect(literalValues).not.toContain('"status"');
    },
  );

  it.each([
    {
      availableActions: null,
      expectedCopy: /acciones.*no disponibles/i,
    },
    {
      availableActions: [] as const,
      expectedCopy: /no había acciones disponibles|ninguna acción disponible/i,
    },
  ])(
    'distinguishes unavailable actions from an empty list after disclosure',
    async ({ availableActions, expectedCopy }) => {
      const item = decisionItem(1);
      const loaded = decisionDetail(item, { availableActions });
      const { api } = inspectorApi(decisionIndex(item), new Map([[1, loaded]]));
      render(<DecisionInspector api={api} attemptId={attemptId} onClose={vi.fn()} />);

      const card = await waitForDecisionCard();
      const disclosure = literalDisclosure(card);
      expect(disclosure).not.toBeNull();
      if (!disclosure) return;
      fireEvent.click(within(disclosure).getByText('Opciones y datos literales'));
      expect(within(disclosure).getByText(expectedCopy)).toBeTruthy();
    },
  );
});
