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

const MINUTE = 60_000;
const TEST_NOW = new Date('2026-10-28T12:00:00.000Z');

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

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function expectDiscreteRecovery(loadingMessage: string): void {
  const status = screen
    .queryAllByRole('status')
    .find((element) => !element.textContent?.includes(loadingMessage));
  expect(status).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: /Reintentar (inspección|ficha)/ })).toBeNull();
}

function clickWithoutNativeNavigation(link: HTMLElement): void {
  const preventDefault = (event: Event): void => {
    if (event.target === link) event.preventDefault();
  };
  document.addEventListener('click', preventDefault, true);
  try {
    fireEvent.click(link);
  } finally {
    document.removeEventListener('click', preventDefault, true);
  }
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
    expect(screen.getByRole('heading', { name: 'Acción elegida' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Resolución' })).toBeTruthy();
    fireEvent.click(screen.getByText('Opciones y datos literales'));
    expect(screen.getByRole('heading', { name: 'Acciones disponibles' })).toBeTruthy();
    expect(screen.getByText('Descripción vacía.')).toBeTruthy();
    expect(screen.getByText('Descripción omitida.')).toBeTruthy();
    expect(screen.getByText(/Avance personalizado/)).toBeTruthy();
    expect(screen.queryByText('Parámetros: {}')).toBeNull();
    expect(screen.queryByText('Acción registrada: Avanzar.')).toBeNull();
    expect(screen.queryByText(/prompt|response|uso|razonamiento/i)).toBeNull();
  });

  it('keeps the map, selected support, detail, and chronological list in DOM reading order', async () => {
    const api = inspectorApi();
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Observación' });

    const map = screen.getByRole('group', { name: 'Mapa estático del recorrido' });
    const supportHeading = screen.getByRole('heading', { name: 'Decisiones en la casilla 2' });
    const detailHeading = screen.getByRole('heading', { name: 'Observación' });
    const chronologicalHeading = screen.getByRole('heading', {
      name: 'Todas las decisiones, en orden',
    });
    const followsInDom = (before: Element, after: Element): boolean =>
      Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(followsInDom(map, supportHeading)).toBe(true);
    expect(followsInDom(supportHeading, detailHeading)).toBe(true);
    expect(followsInDom(detailHeading, chronologicalHeading)).toBe(true);
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

  it('clears the previous detail and its links when selecting an empty support after success', async () => {
    const getDecision = vi.fn().mockResolvedValue(detail(1));
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Ver ficha seleccionada' })).toHaveLength(2);

    fireEvent.click(
      screen.getByRole('button', { name: /Casilla 1, Casilla, Tramo 0[–-]1: suelo/ }),
    );

    expect(await screen.findByText('Elegí una decisión para ver su ficha.')).toBeTruthy();
    expect(screen.getByText('No hay decisiones en esta casilla.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Ficha de decisión 1' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ver ficha seleccionada' })).toBeNull();
    expect(getDecision).toHaveBeenCalledTimes(1);
  });

  it('keeps both selected-row links on one focusable destination through load, error, automatic recovery, and success', async () => {
    const crowdedIndex: DecisionIndex = {
      ...index,
      decisions: Array.from({ length: 8 }, (_, position) => ({
        number: position + 1,
        decisionId: `decision-${position + 1}`,
        originSupport: 2,
        hasAction: position % 2 === 0,
      })),
    };
    let rejectInitial!: (reason: unknown) => void;
    let resolveRetry!: (loaded: DecisionDetail) => void;
    const getDecision = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((_resolve, reject) => {
            rejectInitial = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    const getDecisionIndex = vi.fn().mockResolvedValue(crowdedIndex);
    const api = inspectorApi({ getDecisionIndex, getDecision });
    const scroll = stubScrollIntoView();

    const readLinksAndDestination = () => {
      const links = screen.getAllByRole('link', { name: 'Ver ficha seleccionada' });
      expect(links).toHaveLength(2);
      const href = links[0]?.getAttribute('href');
      expect(href).not.toBeNull();
      expect(links[1]?.getAttribute('href')).toBe(href);

      const fragment = new URL(href!, window.location.href).hash.slice(1);
      expect(fragment).not.toBe('');
      const destination = document.getElementById(decodeURIComponent(fragment));
      expect(destination).not.toBeNull();
      expect(links.map((link) => link.closest('ol')).filter(Boolean)).toHaveLength(2);
      expect(new Set(links.map((link) => link.closest('ol'))).size).toBe(2);

      for (const link of links) {
        const selectedButton = link.parentElement?.querySelector('button[aria-pressed="true"]');
        expect(selectedButton).not.toBeNull();
        expect(selectedButton?.parentElement).toBe(link.parentElement);
        expect(selectedButton?.textContent).toContain('Decisión 1');
      }

      return { links, href, destination: destination! };
    };
    const focusDestination = (destination: HTMLElement): void => {
      destination.focus();
      expect(document.activeElement).toBe(destination);
    };
    try {
      render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

      expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
      const supportList = screen.getByRole('region', { name: 'Decisiones en la casilla 2' });
      const chronologicalList = screen.getByRole('region', {
        name: 'Todas las decisiones, en orden',
      });
      expect(within(supportList).getAllByRole('button', { name: /^Decisión \d+/ })).toHaveLength(8);
      expect(
        within(chronologicalList).getAllByRole('button', { name: /^Decisión \d+/ }),
      ).toHaveLength(8);
      for (const list of [supportList, chronologicalList]) {
        const selected = within(list).getAllByRole('button', { pressed: true });
        expect(selected).toHaveLength(1);
        expect(selected[0]?.textContent).toContain('Decisión 1');
      }

      const loading = readLinksAndDestination();
      focusDestination(loading.destination);
      clickWithoutNativeNavigation(loading.links[0]!);
      expect(getDecisionIndex).toHaveBeenCalledTimes(1);
      expect(getDecision).toHaveBeenCalledTimes(1);
      expect(readLinksAndDestination().destination).toBe(loading.destination);

      await act(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(TEST_NOW);
        rejectInitial(new Error('detalle no disponible'));
        await Promise.resolve();
      });
      expectDiscreteRecovery('Cargando la ficha…');
      const failed = readLinksAndDestination();
      expect(failed.href).toBe(loading.href);
      expect(failed.destination).toBe(loading.destination);
      expect(document.activeElement).toBe(loading.destination);
      focusDestination(failed.destination);

      clickWithoutNativeNavigation(failed.links[0]!);
      expect(getDecision).toHaveBeenCalledTimes(1);
      expectDiscreteRecovery('Cargando la ficha…');
      await advance(MINUTE - 1);
      expect(getDecision).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(loading.destination);
      await advance(1);
      expect(screen.getByText('Cargando la ficha…')).toBeTruthy();
      expect(getDecision).toHaveBeenCalledTimes(2);
      const recovering = readLinksAndDestination();
      expect(recovering.href).toBe(loading.href);
      expect(recovering.destination).toBe(loading.destination);
      expect(document.activeElement).toBe(recovering.destination);
      const scrollCallsBeforeSuccess = scroll.scrollIntoView.mock.calls.length;

      const selectedDetail: DecisionDetail = {
        ...detail(1),
        item: crowdedIndex.decisions[0]!,
      };
      await act(async () => {
        resolveRetry(selectedDetail);
      });

      expect(await screen.findByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
      expect(screen.getAllByRole('heading', { name: 'Observación' })).toHaveLength(1);
      const loaded = readLinksAndDestination();
      expect(loaded.href).toBe(loading.href);
      expect(loaded.destination).toBe(loading.destination);
      expect(document.activeElement).toBe(loading.destination);
      expect(scroll.scrollIntoView).toHaveBeenCalledTimes(scrollCallsBeforeSuccess);
      expect(getDecisionIndex).toHaveBeenCalledTimes(1);
      expect(getDecision).toHaveBeenCalledTimes(2);
    } finally {
      scroll.restore();
    }
  });

  it('does not move focus back to an automatically recovered detail after a later decision is selected', async () => {
    let rejectInitial!: (reason: unknown) => void;
    let resolveRecovery!: (loaded: DecisionDetail) => void;
    const getDecision = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((_resolve, reject) => {
            rejectInitial = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((resolve) => {
            resolveRecovery = resolve;
          }),
      )
      .mockImplementation((_id: string, number: number) => Promise.resolve(detail(number)));
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    await act(async () => {
      rejectInitial(new Error('detalle no disponible'));
      await Promise.resolve();
    });
    expectDiscreteRecovery('Cargando la ficha…');
    const failedDecision = screen.getAllByRole('button', { name: /Decisión 1/ })[0]!;
    failedDecision.focus();
    await advance(MINUTE);
    expect(getDecision).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Cargando la ficha…')).toBeTruthy();
    expect(document.activeElement).toBe(failedDecision);

    const laterDecision = screen.getAllByRole('button', { name: /Decisión 3/ })[0]!;
    laterDecision.focus();
    fireEvent.click(laterDecision);
    expect(await screen.findByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
    expect(document.activeElement).toBe(laterDecision);

    await act(async () => {
      resolveRecovery(detail(1));
    });

    expect(screen.getByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
    expect(screen.queryByText('Consumió el turno 1.')).toBeNull();
    expect(screen.getByText('Consumió el turno 3.')).toBeTruthy();
    expect(document.activeElement).toBe(laterDecision);
    expect(getDecision).toHaveBeenCalledTimes(3);
  });

  it('keeps the detail focused when an automatic recovery fails again', async () => {
    let rejectInitial!: (reason: unknown) => void;
    let rejectRecovery!: (reason: unknown) => void;
    const getDecision = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((_resolve, reject) => {
            rejectInitial = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((_resolve, reject) => {
            rejectRecovery = reject;
          }),
      )
      .mockResolvedValue(detail(1));
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
    const destination = document.getElementById('decision-detail');
    expect(destination).not.toBeNull();
    destination?.focus();
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    await act(async () => {
      rejectInitial(new Error('primer fallo'));
      await Promise.resolve();
    });
    expectDiscreteRecovery('Cargando la ficha…');
    await advance(MINUTE);
    expect(getDecision).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Cargando la ficha…')).toBeTruthy();
    expect(document.activeElement).toBe(destination);

    await act(async () => {
      rejectRecovery(new Error('segundo fallo'));
      await Promise.resolve();
    });

    expectDiscreteRecovery('Cargando la ficha…');
    expect(document.activeElement).toBe(destination);
    await advance(MINUTE - 1);
    expect(getDecision).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getDecision).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
    expect(document.activeElement).toBe(destination);
  });

  it.each(['decision list', 'selected support on the map'] as const)(
    'keeps the loaded detail when reselecting the active decision from the %s',
    async (control) => {
      const getDecision = vi.fn().mockResolvedValue(detail(1));
      const api = inspectorApi({ getDecision });
      render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

      expect(await screen.findByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
      fireEvent.click(
        control === 'decision list'
          ? screen.getAllByRole('button', { name: /Decisión 1/ })[0]!
          : screen.getByRole('button', {
              name: /Casilla 2, Casilla, Tramo 1[–-]2: pozo, recompensa, 2 decisiones/,
            }),
      );
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
      expect(screen.queryByText('Elegí una decisión para ver su ficha.')).toBeNull();
      expect(getDecision).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the failed detail deadline when reselecting the same decision', async () => {
    let rejectInitial!: (reason: unknown) => void;
    const getDecision = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((_resolve, reject) => {
            rejectInitial = reject;
          }),
      )
      .mockResolvedValue(detail(1));
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
    expect(getDecision).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    await act(async () => {
      rejectInitial(new Error('local transient failure'));
      await Promise.resolve();
    });
    expectDiscreteRecovery('Cargando la ficha…');
    await advance(MINUTE / 2);

    fireEvent.click(screen.getAllByRole('button', { name: /Decisión 1/ })[0]!);
    await act(async () => {
      await Promise.resolve();
    });

    expectDiscreteRecovery('Cargando la ficha…');
    expect(getDecision).toHaveBeenCalledTimes(1);
    await advance(MINUTE / 2 - 1);
    expect(getDecision).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(screen.getByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
    expect(getDecision).toHaveBeenCalledTimes(2);
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

  it('describes no-op actions as staying in the same square', async () => {
    const noOpDetail: DecisionDetail = {
      ...detail(1),
      result: {
        kind: 'action',
        action: { kind: 'swim' },
        resolution: { outcome: 'no_op', reason: 'swim_no_effect' },
        beforeSupport: 2,
        afterSupport: 2,
        turnsUsed: 1,
      },
    };
    const api = inspectorApi({ getDecision: vi.fn().mockResolvedValue(noOpDetail) });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(
      await screen.findByText(
        'Resolución: el robot permaneció en la misma casilla, nadar mantuvo al robot en la misma casilla.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no produjo cambios|no produce efecto/)).toBeNull();
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

    await screen.findByRole('heading', { name: 'Observación' });
    const choice = screen.getByRole('heading', { name: 'Acción elegida' }).parentElement!;
    expect(choice.textContent).toContain('Saltar');
    expect(choice.textContent).toContain('derecha');
    expect(choice.textContent).not.toContain('right');
    expect(choice.textContent).not.toContain('Parámetros: {}');

    const disclosure = screen.getByText('Opciones y datos literales');
    fireEvent.click(disclosure);
    const literal = disclosure.closest('details')!;
    const json = JSON.stringify(
      Array.from(literal.querySelectorAll('pre')).map((entry) =>
        JSON.parse(entry.textContent ?? 'null'),
      ),
    );
    expect(json).toContain('"direction":"derecha"');
    expect(json).toContain('"modo":"experimental"');
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

      const manualSelection = screen.getByRole('button', { name: /Decisión 3/ });
      manualSelection.focus();
      fireEvent.click(manualSelection);
      expect(await screen.findByText('Consumió el turno 3.')).toBeTruthy();
      expect(document.activeElement).toBe(manualSelection);
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

  it('does not repeat the pending latest-detail scroll when its selected-row link is activated', async () => {
    let resolveDetail!: (loaded: DecisionDetail) => void;
    const getDecision = vi.fn(
      () =>
        new Promise<DecisionDetail>((resolve) => {
          resolveDetail = resolve;
        }),
    );
    const getDecisionIndex = vi.fn().mockResolvedValue(index);
    const api = inspectorApi({ getDecisionIndex, getDecision });
    const scroll = stubScrollIntoView();
    const preventNativeNavigation = (event: Event): void => {
      if (event.target instanceof HTMLAnchorElement) event.preventDefault();
    };

    try {
      render(
        <DecisionInspector
          api={api}
          attemptId="attempt-1"
          initialSelection="last-action-or-decision"
          onClose={vi.fn()}
        />,
      );

      expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
      const links = screen.getAllByRole('link', { name: 'Ver ficha seleccionada' });
      expect(links).toHaveLength(2);
      const href = links[0]?.getAttribute('href');
      expect(href).not.toBeNull();
      expect(links[1]?.getAttribute('href')).toBe(href);
      const fragment = new URL(href!, window.location.href).hash.slice(1);
      const destination = document.getElementById(decodeURIComponent(fragment));
      expect(destination).not.toBeNull();

      document.addEventListener('click', preventNativeNavigation, true);
      try {
        fireEvent.click(links[0]!);
      } finally {
        document.removeEventListener('click', preventNativeNavigation, true);
      }
      const scrollCallsAfterActivation = scroll.scrollIntoView.mock.calls.length;

      expect(getDecisionIndex).toHaveBeenCalledTimes(1);
      expect(getDecision).toHaveBeenCalledTimes(1);
      expect(getDecision).toHaveBeenCalledWith('attempt-1', 3, expect.any(AbortSignal));
      await act(async () => {
        resolveDetail(detail(3));
      });

      expect(await screen.findByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
      const loadedLinks = screen.getAllByRole('link', { name: 'Ver ficha seleccionada' });
      expect(loadedLinks).toHaveLength(2);
      expect(loadedLinks[0]?.getAttribute('href')).toBe(href);
      expect(loadedLinks[1]?.getAttribute('href')).toBe(href);
      expect(document.getElementById(decodeURIComponent(fragment))).toBe(destination);
      expect(scroll.scrollIntoView).toHaveBeenCalledTimes(scrollCallsAfterActivation);
      expect(getDecisionIndex).toHaveBeenCalledTimes(1);
      expect(getDecision).toHaveBeenCalledTimes(1);
    } finally {
      scroll.restore();
    }
  });

  it('cancels pending latest-detail scroll through the explicit detail link before recovery', async () => {
    let rejectInitial!: (reason: unknown) => void;
    const getDecision = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((_resolve, reject) => {
            rejectInitial = reject;
          }),
      )
      .mockResolvedValueOnce(detail(3));
    const api = inspectorApi({ getDecision });
    const scroll = stubScrollIntoView();

    try {
      render(
        <DecisionInspector
          api={api}
          attemptId="attempt-1"
          initialSelection="last-action-or-decision"
          onClose={vi.fn()}
        />,
      );

      expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
      const destination = document.getElementById('decision-detail');
      expect(destination).not.toBeNull();
      expect(getDecision).toHaveBeenCalledWith('attempt-1', 3, expect.any(AbortSignal));
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();

      vi.useFakeTimers();
      vi.setSystemTime(TEST_NOW);
      await act(async () => {
        rejectInitial(new Error('initial detail unavailable'));
        await Promise.resolve();
      });
      expectDiscreteRecovery('Cargando la ficha…');
      const detailLink = screen.getAllByRole('link', { name: 'Ver ficha seleccionada' })[0]!;
      clickWithoutNativeNavigation(detailLink);
      expect(document.activeElement).toBe(destination);
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();

      await advance(MINUTE);

      expect(await screen.findByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
      expect(document.activeElement).toBe(destination);
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();
      expect(getDecision).toHaveBeenCalledTimes(2);
    } finally {
      scroll.restore();
    }
  });

  it('ignores a late detail response after selecting a different decision', async () => {
    let resolveFirst!: (loaded: DecisionDetail) => void;
    const getDecision = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DecisionDetail>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation((_id: string, number: number) => Promise.resolve(detail(number)));
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Decisión 3/ })[0]!);
    expect(await screen.findByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
    expect(getDecision).toHaveBeenCalledWith('attempt-1', 3, expect.any(AbortSignal));

    await act(async () => {
      resolveFirst(detail(1));
    });

    expect(screen.getByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
    expect(screen.queryByText('Consumió el turno 1.')).toBeNull();
    expect(screen.getByText('Consumió el turno 3.')).toBeTruthy();
    expect(getDecision).toHaveBeenCalledTimes(2);
  });

  it('does not show a late response from the previous inspected attempt as the new attempt detail', async () => {
    const secondIndex: DecisionIndex = { ...index, attemptId: 'attempt-2' };
    const secondDetail: DecisionDetail = {
      ...detail(1),
      attemptId: 'attempt-2',
      result: {
        ...detail(1).result,
        turnsUsed: 9,
      },
    };
    let resolveFirstAttempt!: (loaded: DecisionDetail) => void;
    let resolveSecondAttempt!: (loaded: DecisionDetail) => void;
    const oldResponse = new Promise<DecisionDetail>((resolve) => {
      resolveFirstAttempt = resolve;
    });
    const currentResponse = new Promise<DecisionDetail>((resolve) => {
      resolveSecondAttempt = resolve;
    });
    const getDecisionIndex = vi.fn((id: string) =>
      Promise.resolve(id === 'attempt-1' ? index : secondIndex),
    );
    const getDecision = vi.fn((id: string) => (id === 'attempt-1' ? oldResponse : currentResponse));
    const api = inspectorApi({ getDecisionIndex, getDecision });
    const props = { api, attemptId: 'attempt-1', onClose: vi.fn() };
    const view = render(<DecisionInspector {...props} />);

    expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
    view.rerender(<DecisionInspector {...props} attemptId="attempt-2" />);
    await waitFor(() =>
      expect(getDecisionIndex).toHaveBeenCalledWith('attempt-2', expect.any(AbortSignal)),
    );
    await waitFor(() =>
      expect(getDecision).toHaveBeenCalledWith('attempt-2', 1, expect.any(AbortSignal)),
    );

    await act(async () => {
      resolveSecondAttempt(secondDetail);
    });
    expect(await screen.findByText('Consumió el turno 9.')).toBeTruthy();

    await act(async () => {
      resolveFirstAttempt(detail(1));
    });

    expect(screen.getByText('Consumió el turno 9.')).toBeTruthy();
    expect(screen.queryByText('Consumió el turno 1.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
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

  it('shows empty state, recovers a transient index error, and keeps definitive errors visible', async () => {
    const empty: DecisionIndex = { attemptId: 'attempt-1', levelId: LEVEL.id, decisions: [] };
    const api = inspectorApi({ getDecisionIndex: vi.fn().mockResolvedValue(empty) });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);
    expect(await screen.findByText(/no tiene decisiones guardadas/)).toBeTruthy();

    cleanup();
    let rejectIndex!: (reason: unknown) => void;
    const indexFailure = new Promise<DecisionIndex>((_resolve, reject) => {
      rejectIndex = reject;
    });
    const getDecisionIndex = vi
      .fn()
      .mockImplementationOnce(() => indexFailure)
      .mockResolvedValueOnce(index);
    const failingApi = inspectorApi({ getDecisionIndex });
    render(<DecisionInspector api={failingApi} attemptId="attempt-1" onClose={vi.fn()} />);
    await waitFor(() => expect(getDecisionIndex).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    await act(async () => {
      rejectIndex(new Error('sin red'));
      await Promise.resolve();
    });
    expectDiscreteRecovery('Cargando el mapa de decisiones…');
    await advance(MINUTE - 1);
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    await advance(1);
    expect(
      screen.getByRole('button', {
        name: /Casilla 2, Casilla, Tramo 1[–-]2: pozo, recompensa, 2 decisiones/,
      }),
    ).toBeTruthy();
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);

    cleanup();
    vi.useRealTimers();
    const definitiveFailure = new AttemptApiFailure(
      'invalid',
      'El índice guardado no es válido.',
      400,
    );
    const getDefinitiveIndex = vi.fn().mockRejectedValue(definitiveFailure);
    render(
      <DecisionInspector
        api={inspectorApi({ getDecisionIndex: getDefinitiveIndex })}
        attemptId="attempt-1"
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(definitiveFailure.message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar inspección' })).toBeNull();
    vi.useFakeTimers();
    await advance(MINUTE * 2);
    expect(getDefinitiveIndex).toHaveBeenCalledOnce();
    expect(screen.getByText(definitiveFailure.message)).toBeTruthy();
  });

  it('ignores a late index recovery after the inspector is closed', async () => {
    let rejectInitial!: (error: unknown) => void;
    let finishRecovery!: (error: unknown) => void;
    const initialFailure = new Promise<DecisionIndex>((_resolve, reject) => {
      rejectInitial = reject;
    });
    const lateRetry = new Promise<DecisionIndex>((_resolve, reject) => {
      finishRecovery = reject;
    });
    const getDecisionIndex = vi
      .fn()
      .mockReturnValueOnce(initialFailure)
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

    await waitFor(() => expect(getDecisionIndex).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    await act(async () => {
      rejectInitial(new Error('sin red'));
      await Promise.resolve();
    });
    expectDiscreteRecovery('Cargando el mapa de decisiones…');
    await advance(MINUTE);
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
    const recoverySignal = getDecisionIndex.mock.calls[1]?.[1];
    expect(recoverySignal).toBeInstanceOf(AbortSignal);
    view.unmount();
    expect(recoverySignal?.aborted).toBe(true);

    await act(async () => {
      finishRecovery(new AttemptApiFailure('authentication', 'La sesión venció.', 401));
      await Promise.resolve();
    });
    expect(onAuthRequired).not.toHaveBeenCalled();
  });

  it('recovers a failed decision detail without losing the selected decision', async () => {
    let rejectInitial!: (reason: unknown) => void;
    const initialFailure = new Promise<DecisionDetail>((_resolve, reject) => {
      rejectInitial = reject;
    });
    const getDecision = vi
      .fn()
      .mockReturnValueOnce(initialFailure)
      .mockResolvedValueOnce(detail(1));
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByText('Cargando la ficha…')).toBeTruthy();
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    await act(async () => {
      rejectInitial(new Error('detalle no disponible'));
      await Promise.resolve();
    });
    expectDiscreteRecovery('Cargando la ficha…');
    await advance(MINUTE);
    expect(screen.getByRole('heading', { name: 'Observación' })).toBeTruthy();
    expect(getDecision).toHaveBeenCalledTimes(2);
  });

  it('keeps a definitive synchronous detail failure visible without an automatic retry', async () => {
    const getDecision = vi.fn(() => {
      throw new AttemptApiFailure('invalid', 'El detalle no es válido.', 400);
    });
    const api = inspectorApi({ getDecision });
    render(<DecisionInspector api={api} attemptId="attempt-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('El detalle no es válido.')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Cargando la ficha…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reintentar ficha' })).toBeNull();
    expect(getDecision).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    await advance(MINUTE * 2);
    expect(getDecision).toHaveBeenCalledOnce();
    expect(screen.getByText('El detalle no es válido.')).toBeTruthy();
  });
});
