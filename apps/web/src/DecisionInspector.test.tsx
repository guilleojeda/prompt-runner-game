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
    expect(screen.getByRole('heading', { name: 'Decisión 1 · Casilla 2' })).toBeTruthy();
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

    expect(await screen.findByText('Acción registrada: Saltar · dirección: derecha.')).toBeTruthy();
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
