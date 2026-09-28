// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import {
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
    { opaqueId: 'tool_1', label: 'Avanzar', description: 'Avanza un tramo.' },
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
    expect(await screen.findByRole('button', { name: 'Casilla 2, 2 decisiones' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Casilla 5, 1 decisión' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Todas las decisiones, en orden' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Decisión [123]/ })).toHaveLength(5);
    expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Decisión 1 · Casilla 2' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Acciones disponibles' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Acción elegida' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Resultado' })).toBeTruthy();
    expect(screen.getByText('Descripción vacía.')).toBeTruthy();
    expect(screen.getByText('Descripción omitida.')).toBeTruthy();
    expect(screen.queryByText('Parámetros: {}')).toBeNull();
    expect(screen.queryByText('Acción registrada: Avanzar.')).toBeNull();
    expect(screen.queryByText(/prompt|response|uso|razonamiento/i)).toBeNull();
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

    expect(
      await screen.findByText('Acción registrada: tool_3 (Saltar) · dirección: derecha.'),
    ).toBeTruthy();
    expect(screen.queryByText(/dirección: right/)).toBeNull();
  });

  it('shows the recorded action in the result only when the choice is unknown', async () => {
    const unknownChoiceDetail: DecisionDetail = {
      ...detail(1),
      choice: { state: 'unknown' },
    };
    const api = inspectorApi({ getDecision: vi.fn().mockResolvedValue(unknownChoiceDetail) });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Acción registrada: tool_1 (Avanzar).')).toBeTruthy();
    expect(screen.queryByText(/Acción ejecutada/)).toBeNull();
  });

  it('filters a selected support, keeps all decisions visible, and loads the selected detail', async () => {
    const api = inspectorApi();
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Observación' });
    fireEvent.click(screen.getByRole('button', { name: 'Casilla 5, 1 decisión' }));

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

  it('activates map selection from the keyboard', async () => {
    const api = inspectorApi();
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Observación' });
    const support = screen.getByRole('button', { name: 'Casilla 5, 1 decisión' });
    support.focus();
    fireEvent.keyDown(support, { key: 'Enter' });

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
    expect(await screen.findByRole('button', { name: 'Casilla 2, 2 decisiones' })).toBeTruthy();
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
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
