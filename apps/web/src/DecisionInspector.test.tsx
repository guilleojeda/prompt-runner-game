// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import {
  AttemptApiFailure,
  AttemptApiClient,
  type AttemptApi,
  type DecisionDetail,
  type DecisionIndex,
} from './attempt-api.js';
import { DecisionInspector } from './DecisionInspector.js';

const index: DecisionIndex = {
  attemptId: 'attempt-1',
  levelId: LEVEL.id,
  decisions: [
    { number: 1, decisionId: 'decision-1', originSupport: 2, hasAction: true },
    { number: 2, decisionId: 'decision-2', originSupport: 2, hasAction: false },
    { number: 3, decisionId: 'decision-3', originSupport: 5, hasAction: true },
  ],
};

const detail = (number: number): DecisionDetail => ({
  attemptId: 'attempt-1',
  levelId: LEVEL.id,
  item: index.decisions[number - 1]!,
  observation: {
    facing: 'right',
    here: { objects: ['recompensa-1'], exit: false },
    left: { kind: 'segment', terrain: 'ground' },
    right: { kind: 'segment', terrain: 'pit' },
  },
  availableActions: [
    { opaqueId: 'tool_1', label: 'Avance personalizado', description: 'Avanza un tramo.' },
    { opaqueId: 'tool_6', label: 'Esperar', description: '' },
    { opaqueId: 'tool_7', label: 'Agarrar objeto' },
  ],
  choice:
    number === 2
      ? { state: 'invalid' as const }
      : {
          state: 'selected' as const,
          opaqueId: 'tool_1',
          action: { kind: 'advance' },
          parameters: {},
        },
  result:
    number === 2
      ? { kind: 'no-action' as const, reason: 'invalid_response', turnsUsed: 2, status: 'error' }
      : {
          kind: 'action' as const,
          action: { kind: 'advance' },
          resolution: { outcome: 'moved', reason: 'moved' },
          beforeSupport: 2,
          afterSupport: 3,
          turnsUsed: number,
        },
});

function inspectorApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    getDecisionIndex: vi.fn().mockResolvedValue(index),
    getDecision: vi
      .fn()
      .mockImplementation((_id: string, number: number) => Promise.resolve(detail(number))),
    ...overrides,
  } as AttemptApi;
}

function stubScrollIntoView() {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrolledElements: HTMLElement[] = [];
  const scrollIntoView = vi.fn(function (this: HTMLElement) {
    scrolledElements.push(this);
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
    writable: true,
  });
  return {
    scrollIntoView,
    scrolledElements,
    restore() {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DecisionInspector', () => {
  it('loads detail through the real client method with its receiver intact', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(index), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail(1)), { status: 200 }));
    const api = new AttemptApiClient(
      { apiBaseUrl: 'https://api.example.test/' },
      { tokenProvider: () => 'token', fetch: fetchImpl },
    );
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://api.example.test/attempts/attempt-1/decisions?decision=1',
    );
  });

  it('shows a static map with per-support counts and the full chronological list', async () => {
    const api = inspectorApi();
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Inspeccionar decisiones' })).toBeTruthy();
    expect(
      await screen.findByRole('button', {
        name: /Casilla 2, Casilla, Tramo 1[–-]2: pozo, recompensa, 2 decisiones/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: /Casilla 5, Casilla, Tramo 4[–-]5: barrera periódica, 1 decisión/,
      }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Todas las decisiones, en orden' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Decisión [123]/ })).toHaveLength(5);
    expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Acciones disponibles' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Acción elegida' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Resultado' })).toBeTruthy();
    expect(screen.getByText('Descripción vacía.')).toBeTruthy();
    expect(screen.getByText('Descripción omitida.')).toBeTruthy();
    expect(screen.getByText(/Avance personalizado/)).toBeTruthy();
    expect(screen.queryByText('Parámetros: {}')).toBeNull();
    expect(screen.queryByText('Acción registrada: Avanzar.')).toBeNull();
    expect(screen.queryByText(/prompt|response|uso|razonamiento/i)).toBeNull();
  });

  it('shows the door requirement and map context to assistive technology', async () => {
    const doorDetail: DecisionDetail = {
      ...detail(1),
      observation: {
        facing: 'right',
        here: { objects: [], exit: false },
        left: { kind: 'segment', terrain: 'ground' },
        right: { kind: 'door', state: 'locked', requiredObjectId: 'llave-1' },
      },
    };
    const api = inspectorApi({ getDecision: vi.fn().mockResolvedValue(doorDetail) });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('A la derecha: puerta cerrada; requiere llave.')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: /Casilla 9, Casilla, Tramo 8[–-]9: suelo, Puerta en acceso 8[–-]9, sin decisiones/,
      }),
    ).toBeTruthy();
  });

  it('clears detail loading when a pending selection is changed to an empty support', async () => {
    const getDecision = vi.fn().mockReturnValue(new Promise<DecisionDetail>(() => undefined));
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: /Casilla 1, Casilla, Tramo 0[–-]1: suelo/ }),
    );

    expect(await screen.findByText('No hay decisiones en esta casilla.')).toBeTruthy();
    expect(screen.queryByText('Cargando la ficha…')).toBeNull();
    expect(screen.getByText('Elegí una decisión para ver su ficha.')).toBeTruthy();
  });

  it('renders no-action result codes in Spanish without exposing raw codes', async () => {
    const providerFailure: DecisionDetail = {
      ...detail(1),
      result: {
        kind: 'no-action',
        reason: 'provider_error',
        turnsUsed: 1,
        status: 'error',
      },
    };
    const getDecision = vi
      .fn()
      .mockImplementation((_id: string, number: number) =>
        Promise.resolve(number === 1 ? providerFailure : detail(2)),
      );
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Motivo registrado: error del proveedor.')).toBeTruthy();
    expect(screen.getByText('Cierre: error.')).toBeTruthy();
    expect(screen.queryByText('provider_error')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /Decisión 2/ })[0]!);
    expect(await screen.findByText('Motivo registrado: respuesta inválida.')).toBeTruthy();
    expect(screen.queryByText('invalid_response')).toBeNull();
  });

  it('uses an honest Spanish fallback for cancellation and unknown technical reasons', async () => {
    const cancellation: DecisionDetail = {
      ...detail(1),
      result: {
        kind: 'no-action',
        reason: 'cancelled_before_action',
        turnsUsed: 0,
        status: 'cancelled',
      },
    };
    const cancellationApi = inspectorApi({
      getDecision: vi.fn().mockResolvedValue(cancellation),
    });
    render(<DecisionInspector api={cancellationApi} attemptId="attempt-1" onClose={vi.fn()} />);
    expect(
      await screen.findByText('Motivo registrado: cancelación antes de ejecutar una acción.'),
    ).toBeTruthy();
    expect(screen.getByText('Cierre: cancelado.')).toBeTruthy();
    expect(screen.queryByText('cancelled_before_action')).toBeNull();

    cleanup();
    const unknown: DecisionDetail = {
      ...cancellation,
      result: {
        kind: 'no-action',
        reason: 'executor_specific_failure',
        turnsUsed: 0,
        status: 'error',
      },
    };
    const fallbackApi = inspectorApi({ getDecision: vi.fn().mockResolvedValue(unknown) });
    render(<DecisionInspector api={fallbackApi} attemptId="attempt-1" onClose={vi.fn()} />);
    expect(await screen.findByText('Motivo registrado: motivo técnico no detallado.')).toBeTruthy();
    expect(screen.queryByText('executor_specific_failure')).toBeNull();
  });

  it('shows meaningful action parameters while omitting empty parameter objects', async () => {
    const detailWithParameters: DecisionDetail = {
      ...detail(1),
      availableActions: [
        { opaqueId: 'tool_3', label: 'Saltar', description: 'Salta en la dirección indicada.' },
      ],
      choice: {
        state: 'selected',
        opaqueId: 'tool_3',
        action: { kind: 'jump', direction: 'right' },
        parameters: { direction: 'derecha', modo: 'experimental' },
      },
      result: {
        kind: 'action',
        action: { kind: 'jump', direction: 'right' },
        resolution: { outcome: 'moved', reason: 'moved' },
        beforeSupport: 2,
        afterSupport: 3,
        turnsUsed: 1,
      },
    };
    const api = inspectorApi({ getDecision: vi.fn().mockResolvedValue(detailWithParameters) });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Elección válida: tool_3 (Saltar).')).toBeTruthy();
    expect(
      screen.getByText('Parámetros: {"direction":"derecha","modo":"experimental"}'),
    ).toBeTruthy();
    expect(screen.queryByText(/right/)).toBeNull();
    expect(screen.queryByText('Parámetros: {}')).toBeNull();
  });

  it('translates an internal direction only for an unknown recorded action', async () => {
    const unknownChoiceDetail: DecisionDetail = {
      ...detail(1),
      choice: { state: 'unknown' },
      result: {
        kind: 'action',
        action: { kind: 'jump', direction: 'right' },
        resolution: { outcome: 'moved', reason: 'moved' },
        beforeSupport: 2,
        afterSupport: 3,
        turnsUsed: 1,
      },
    };
    const api = inspectorApi({ getDecision: vi.fn().mockResolvedValue(unknownChoiceDetail) });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Acción registrada: Saltar, dirección: derecha.')).toBeTruthy();
    expect(screen.queryByText(/dirección: right/)).toBeNull();
  });

  it('shows the recorded action in the result only when the choice is unknown', async () => {
    const unknownChoiceDetail: DecisionDetail = {
      ...detail(1),
      choice: { state: 'unknown' },
    };
    const api = inspectorApi({ getDecision: vi.fn().mockResolvedValue(unknownChoiceDetail) });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Acción registrada: Avanzar.')).toBeTruthy();
    expect(screen.queryByText(/Acción ejecutada/)).toBeNull();
  });

  it('starts at the last action, skipping a trailing no-action decision, and follows a new selection request', async () => {
    const withTrailingNoAction: DecisionIndex = {
      ...index,
      decisions: [
        ...index.decisions,
        { number: 4, decisionId: 'decision-4', originSupport: 6, hasAction: false },
      ],
    };
    const getDecision = vi
      .fn()
      .mockImplementation((_id: string, number: number) => Promise.resolve(detail(number)));
    const api = inspectorApi({
      getDecisionIndex: vi.fn().mockResolvedValue(withTrailingNoAction),
      getDecision,
    });
    const props = { api, attemptId: 'attempt-1', onClose: vi.fn() };
    const view = render(<DecisionInspector {...props} />);

    expect(await screen.findByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
    view.rerender(<DecisionInspector {...props} initialSelection="last-action-or-decision" />);
    expect(await screen.findByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
    await waitFor(() =>
      expect(getDecision).toHaveBeenLastCalledWith('attempt-1', 3, expect.any(AbortSignal)),
    );
  });

  it.each([
    ['last-action-or-decision', 2, 4],
    ['last-decision', 3, 6],
  ] as const)(
    'scrolls the loaded %s detail into view and repeats it when the same attempt is reopened',
    async (initialSelection, number, support) => {
      const scroll = stubScrollIntoView();
      const reducedMotionDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: vi.fn().mockReturnValue({ matches: false }),
        writable: true,
      });
      const selectionIndex: DecisionIndex = {
        ...index,
        decisions: [
          { number: 1, decisionId: 'decision-1', originSupport: 0, hasAction: true },
          { number: 2, decisionId: 'decision-2', originSupport: 4, hasAction: true },
          { number: 3, decisionId: 'decision-3', originSupport: 6, hasAction: false },
        ],
      };
      const pendingDetails: Array<(loaded: DecisionDetail) => void> = [];
      const getDecision = vi
        .fn()
        .mockImplementation(
          () => new Promise<DecisionDetail>((resolve) => pendingDetails.push(resolve)),
        );
      const getDecisionIndex = vi.fn().mockResolvedValue(selectionIndex);
      const api = inspectorApi({
        getDecisionIndex,
        getDecision,
      });
      const props = { api, attemptId: 'attempt-1', initialSelection, onClose: vi.fn() };
      const headingName = `Decisión ${number}, casilla ${support}`;
      const loadedDetail = (): DecisionDetail => {
        const item = selectionIndex.decisions[number - 1]!;
        const selectedDetail = detail(number);
        return {
          ...selectedDetail,
          item,
          result: item.hasAction
            ? selectedDetail.result
            : { kind: 'no-action', reason: 'timeout', turnsUsed: 2, status: 'error' },
        };
      };

      try {
        const firstOpen = render(<DecisionInspector {...props} />);
        await waitFor(() => expect(getDecisionIndex).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(getDecision).toHaveBeenCalledTimes(1));
        expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
        expect(scroll.scrollIntoView).not.toHaveBeenCalled();
        await act(async () => {
          pendingDetails.shift()!(loadedDetail());
        });
        const firstHeading = await screen.findByRole('heading', { name: headingName });
        await waitFor(() => expect(scroll.scrollIntoView).toHaveBeenCalledOnce());
        expect(scroll.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
        expect(scroll.scrolledElements[0]?.contains(firstHeading)).toBe(true);

        firstOpen.unmount();
        render(<DecisionInspector {...props} />);
        await waitFor(() => expect(getDecisionIndex).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(getDecision).toHaveBeenCalledTimes(2));
        expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
        expect(scroll.scrollIntoView).toHaveBeenCalledOnce();
        await act(async () => {
          pendingDetails.shift()!(loadedDetail());
        });
        const reopenedHeading = await screen.findByRole('heading', { name: headingName });
        await waitFor(() => expect(scroll.scrollIntoView).toHaveBeenCalledTimes(2));
        expect(scroll.scrolledElements[1]?.contains(reopenedHeading)).toBe(true);
      } finally {
        scroll.restore();
        if (reducedMotionDescriptor) {
          Object.defineProperty(window, 'matchMedia', reducedMotionDescriptor);
        } else {
          Reflect.deleteProperty(window, 'matchMedia');
        }
      }
    },
  );

  it('uses instant scrolling for reduced motion and skips ordinary and manual selections', async () => {
    const scroll = stubScrollIntoView();
    const reducedMotionDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
      writable: true,
    });

    try {
      const api = inspectorApi();
      render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);
      expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /Decisión 3/ }));
      expect(await screen.findByText('Consumió el turno 3.')).toBeTruthy();
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();

      cleanup();
      render(
        <DecisionInspector
          api={api}
          attemptId="attempt-1"
          initialSelection="last-action-or-decision"
          onClose={vi.fn()}
        />,
      );
      expect(await screen.findByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
      await waitFor(() => expect(scroll.scrollIntoView).toHaveBeenCalledOnce());
      expect(scroll.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
    } finally {
      scroll.restore();
      if (reducedMotionDescriptor) {
        Object.defineProperty(window, 'matchMedia', reducedMotionDescriptor);
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    }
  });

  it('falls back to the last recorded decision when the index has no actions', async () => {
    const noActions: DecisionIndex = {
      attemptId: 'attempt-1',
      levelId: LEVEL.id,
      decisions: [
        { number: 1, decisionId: 'decision-1', originSupport: 0, hasAction: false },
        { number: 2, decisionId: 'decision-2', originSupport: 1, hasAction: false },
      ],
    };
    const getDecision = vi.fn().mockResolvedValue({
      ...detail(2),
      item: noActions.decisions[1]!,
      result: { kind: 'no-action' as const, reason: 'timeout', turnsUsed: 0, status: 'error' },
    });
    const api = inspectorApi({
      getDecisionIndex: vi.fn().mockResolvedValue(noActions),
      getDecision,
    });
    render(
      <DecisionInspector
        api={api}
        attemptId="attempt-1"
        initialSelection="last-action-or-decision"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Decisión 2, casilla 1' })).toBeTruthy();
    await waitFor(() =>
      expect(getDecision).toHaveBeenCalledWith('attempt-1', 2, expect.any(AbortSignal)),
    );
  });

  it('filters a selected support, keeps all decisions visible, and loads the selected detail', async () => {
    const api = inspectorApi();
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Observación' });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Casilla 5, Casilla, Tramo 4[–-]5: barrera periódica, 1 decisión/,
      }),
    );

    const supportList = screen.getByRole('heading', {
      name: 'Decisiones en la casilla 5',
    }).parentElement;
    expect(supportList).not.toBeNull();
    expect(
      within(supportList as HTMLElement).getByRole('button', { name: /Decisión 3/ }),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Decisión [123]/ })).toHaveLength(4);
    await waitFor(() =>
      expect(api.getDecision).toHaveBeenLastCalledWith('attempt-1', 3, expect.any(AbortSignal)),
    );
    expect(screen.getByText('Consumió el turno 3.')).toBeTruthy();
  });

  it('activates map selection through the native button', async () => {
    const api = inspectorApi();
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Observación' });
    const support = screen.getByRole('button', {
      name: /Casilla 5, Casilla, Tramo 4[–-]5: barrera periódica, 1 decisión/,
    });
    support.focus();
    fireEvent.click(support);

    expect(await screen.findByRole('heading', { name: 'Decisiones en la casilla 5' })).toBeTruthy();
    expect(support.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(api.getDecision).toHaveBeenLastCalledWith('attempt-1', 3, expect.any(AbortSignal)),
    );
  });

  it('shows honest empty and recoverable error states', async () => {
    const empty: DecisionIndex = { attemptId: 'attempt-1', levelId: LEVEL.id, decisions: [] };
    const api = inspectorApi({ getDecisionIndex: vi.fn().mockResolvedValue(empty) });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);
    expect(await screen.findByText(/no tiene decisiones guardadas/)).toBeTruthy();

    cleanup();
    const getDecisionIndex = vi
      .fn()
      .mockRejectedValueOnce(new Error('sin red'))
      .mockResolvedValueOnce(index);
    const failingApi = inspectorApi({ getDecisionIndex });
    render(<DecisionInspector api={failingApi} attemptId="attempt-1" onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar inspección' }));
    expect(
      await screen.findByRole('button', {
        name: /Casilla 2, Casilla, Tramo 1[–-]2: pozo, recompensa, 2 decisiones/,
      }),
    ).toBeTruthy();
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
  });

  it('ignores a late index retry after the inspector is closed', async () => {
    let finishRetry!: (error: unknown) => void;
    const lateRetry = new Promise<DecisionIndex>((_resolve, reject) => {
      finishRetry = reject;
    });
    const getDecisionIndex = vi
      .fn()
      .mockRejectedValueOnce(new Error('sin red'))
      .mockReturnValueOnce(lateRetry);
    const onAuthRequired = vi.fn();
    const view = render(
      <DecisionInspector
        api={inspectorApi({ getDecisionIndex })}
        attemptId="attempt-1"
        onAuthRequired={onAuthRequired}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar inspección' }));
    await waitFor(() => expect(getDecisionIndex).toHaveBeenCalledTimes(2));
    view.unmount();

    await act(async () => {
      finishRetry(new AttemptApiFailure('authentication', 'La sesión venció.', 401));
      await Promise.resolve();
    });
    expect(onAuthRequired).not.toHaveBeenCalled();
  });

  it('retries a failed decision detail without losing the selected decision', async () => {
    const getDecision = vi
      .fn()
      .mockRejectedValueOnce(new Error('detalle no disponible'))
      .mockResolvedValueOnce(detail(1));
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar ficha' }));
    expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();
    expect(getDecision).toHaveBeenCalledTimes(2);
  });

  it('surfaces a synchronous detail failure and clears its loading state', async () => {
    const getDecision = vi.fn(() => {
      throw new Error('fallo síncrono');
    });
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Cargando la ficha…' })).toBeNull();
  });
});
