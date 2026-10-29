// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import {
  AttemptApiFailure,
  type AttemptApi,
  type DecisionDetail,
  type DecisionIndex,
  type DecisionIndexItem,
} from './attempt-api.js';
import { DecisionInspector } from './DecisionInspector.js';

const MINUTE = 60_000;
const TEST_NOW = new Date('2026-10-28T12:00:00.000Z');
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

const items: readonly DecisionIndexItem[] = [
  { number: 1, decisionId: 'decision-1', originSupport: 2, hasAction: true },
  { number: 2, decisionId: 'decision-2', originSupport: 2, hasAction: false },
  { number: 3, decisionId: 'decision-3', originSupport: 5, hasAction: true },
];

const index: DecisionIndex = { attemptId: 'attempt-1', levelId: LEVEL.id, decisions: items };

function detail(number: number, overrides: Partial<DecisionDetail> = {}): DecisionDetail {
  const item = items[number - 1]!;
  return {
    attemptId: 'attempt-1',
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

function inspectorApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    getDecisionIndex: vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(index),
    getDecision: vi
      .fn<AttemptApi['getDecision']>()
      .mockImplementation(async (_id, number) => detail(number)),
    ...overrides,
  } as AttemptApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
}

async function openInspector(
  api: AttemptApi,
  props: { attemptId?: string; initialSelection?: 'first' | 'last-action-or-decision' } = {},
) {
  const view = render(
    <DecisionInspector
      api={api}
      attemptId={props.attemptId ?? 'attempt-1'}
      initialSelection={props.initialSelection}
      onClose={vi.fn()}
    />,
  );
  await advance(0);
  return view;
}

function selectDecision(number: number): void {
  fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`Decisión ${number}`) })[0]!);
}

function setVisibility(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
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
  vi.restoreAllMocks();
  if (originalVisibilityState) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, 'visibilityState');
  }
  if (originalHidden) {
    Object.defineProperty(document, 'hidden', originalHidden);
  } else {
    Reflect.deleteProperty(document, 'hidden');
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
  setVisibility(false);
});

describe('DecisionInspector read recovery acceptance', () => {
  it('starts one index read on open, schedules from the failure, and retries index and pending detail independently', async () => {
    const firstIndex = deferred<DecisionIndex>();
    const getDecisionIndex = vi
      .fn<AttemptApi['getDecisionIndex']>()
      .mockReturnValueOnce(firstIndex.promise)
      .mockResolvedValueOnce(index);
    const getDecision = vi
      .fn<AttemptApi['getDecision']>()
      .mockRejectedValueOnce(
        new AttemptApiFailure('pending', 'Las decisiones siguen pendientes.', 409),
      )
      .mockResolvedValueOnce(detail(1));
    await openInspector(inspectorApi({ getDecisionIndex, getDecision }));

    expect(getDecisionIndex).toHaveBeenCalledOnce();
    expect(getDecision).not.toHaveBeenCalled();
    const initialSignal = getDecisionIndex.mock.calls[0]?.[1];
    await advance(3 * MINUTE);
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    expect(initialSignal?.aborted).toBe(false);

    await act(async () => {
      firstIndex.reject(new AttemptApiFailure('network', 'Sin conexión.'));
      await Promise.resolve();
    });
    await settle();
    expect.soft(screen.queryByRole('alert')).toBeNull();
    expect.soft(screen.queryByRole('button', { name: /Reintentar/i })).toBeNull();
    expect.soft(screen.queryByRole('status')).not.toBeNull();
    await advance(MINUTE - 1);
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    await advance(1);
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
    expect(getDecision).toHaveBeenCalledOnce();
    expect(getDecisionIndex.mock.calls.map(([id]) => id)).toEqual(['attempt-1', 'attempt-1']);

    await advance(MINUTE - 1);
    expect(getDecision).toHaveBeenCalledOnce();
    await advance(1);
    expect(getDecision).toHaveBeenCalledTimes(2);
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();

    await advance(3 * MINUTE);
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
    expect(getDecision).toHaveBeenCalledTimes(2);
  });

  it('continues temporary recovery without an attempt limit or a retry control', async () => {
    const getDecisionIndex = vi
      .fn<AttemptApi['getDecisionIndex']>()
      .mockRejectedValue(new AttemptApiFailure('network', 'Sin conexión.'));
    await openInspector(inspectorApi({ getDecisionIndex }));

    await advance(61 * MINUTE);

    expect(getDecisionIndex).toHaveBeenCalledTimes(62);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /Reintentar/i })).toBeNull();
  });

  it.each([
    [
      'pending conflict 409',
      new AttemptApiFailure('pending', 'El registro sigue pendiente.', 409),
      2,
    ],
    ['temporary server 503', new AttemptApiFailure('server', 'Temporal.', 503), 2],
    [
      'incompatible record',
      new AttemptApiFailure('incompatible', 'Registro incompatible.', 500),
      1,
    ],
    [
      'invalid protocol payload on 200',
      new AttemptApiFailure('server', 'Respuesta inválida.', 200),
      1,
    ],
    ['missing record 404', new AttemptApiFailure('not_found', 'No existe.', 404), 1],
    ['invalid request 400', new AttemptApiFailure('invalid', 'Número inválido.', 400), 1],
    [
      'unavailable replay conflict 409',
      new AttemptApiFailure('conflict', 'Registro no disponible.', 409),
      1,
    ],
  ])('classifies %s for automatic detail recovery', async (_name, failure, expectedReads) => {
    const getDecisionIndex = vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(index);
    const getDecision = vi
      .fn<AttemptApi['getDecision']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(detail(1));
    await openInspector(inspectorApi({ getDecisionIndex, getDecision }));

    expect(getDecision).toHaveBeenCalledOnce();
    await advance(MINUTE);

    expect(getDecision).toHaveBeenCalledTimes(expectedReads);
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    if (expectedReads === 2) {
      expect.soft(screen.queryByRole('alert')).toBeNull();
      expect.soft(screen.queryByRole('button', { name: /Reintentar/i })).toBeNull();
      expect.soft(screen.queryByRole('status')).not.toBeNull();
    }
  });

  it.each([
    ['index attempt mismatch', 'index', { attemptId: 'other-attempt' }],
    ['index level mismatch', 'index', { levelId: 'other-level' }],
    ['detail attempt mismatch', 'detail', { attemptId: 'other-attempt' }],
    ['detail level mismatch', 'detail', { levelId: 'other-level' }],
    ['detail number mismatch', 'detail', { number: 2 }],
  ] as const)('does not retry a definitive %s', async (_name, resource, mismatch) => {
    const wrongIndex = {
      ...index,
      ...(resource === 'index' ? mismatch : {}),
    } as DecisionIndex;
    const wrongDetail = detail(
      1,
      resource === 'detail'
        ? {
            ...('attemptId' in mismatch ? { attemptId: mismatch.attemptId } : {}),
            ...('levelId' in mismatch ? { levelId: mismatch.levelId } : {}),
            ...('number' in mismatch ? { item: { ...items[0]!, number: mismatch.number } } : {}),
          }
        : {},
    );
    const getDecisionIndex = vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(wrongIndex);
    const getDecision = vi.fn<AttemptApi['getDecision']>().mockResolvedValue(wrongDetail);
    await openInspector(inspectorApi({ getDecisionIndex, getDecision }));

    expect(getDecisionIndex).toHaveBeenCalledOnce();
    if (resource === 'detail') expect(getDecision).toHaveBeenCalledOnce();
    const errorMessage = screen.getByRole('alert');
    expect(errorMessage.textContent?.trim()).not.toBe('');
    if (resource === 'index') {
      expect(screen.queryByRole('group', { name: 'Mapa estático del recorrido' })).toBeNull();
    } else {
      expect(screen.getByRole('group', { name: 'Mapa estático del recorrido' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Observación' })).toBeNull();
    }
    await advance(MINUTE);
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    expect(getDecision).toHaveBeenCalledTimes(resource === 'detail' ? 1 : 0);
  });

  it('cancels the old decision deadline on a new selection and clears the new deadline for an empty support', async () => {
    const getDecision = vi
      .fn<AttemptApi['getDecision']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Ficha no disponible.'))
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Ficha no disponible.'));
    await openInspector(inspectorApi({ getDecision }));
    expect(getDecision).toHaveBeenCalledOnce();

    await advance(MINUTE / 2);
    selectDecision(3);
    await settle();
    expect(getDecision).toHaveBeenCalledTimes(2);
    await advance(MINUTE / 2);
    expect(getDecision).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Casilla 1, Casilla, Tramo 0[–-]1/ }));
    expect(screen.getByText('No hay decisiones en esta casilla.')).toBeTruthy();
    expect(screen.getByText('Elegí una decisión para ver su ficha.')).toBeTruthy();
    await advance(MINUTE / 2);
    expect(getDecision).toHaveBeenCalledTimes(2);
  });

  it('aborts and ignores a late old detail after selecting another decision', async () => {
    const oldDetail = deferred<DecisionDetail>();
    const getDecision = vi
      .fn<AttemptApi['getDecision']>()
      .mockReturnValueOnce(oldDetail.promise)
      .mockResolvedValueOnce(detail(3));
    await openInspector(inspectorApi({ getDecision }));
    const firstSignal = getDecision.mock.calls[0]?.[2];
    selectDecision(3);
    await settle();

    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      oldDetail.resolve(detail(1));
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Observación' })).toBeTruthy();
    expect(getDecision).toHaveBeenCalledTimes(2);
  });

  it('ignores the first A response after switching A to B and back to A', async () => {
    const firstA = deferred<DecisionDetail>();
    const secondA = deferred<DecisionDetail>();
    const getDecision = vi
      .fn<AttemptApi['getDecision']>()
      .mockReturnValueOnce(firstA.promise)
      .mockResolvedValueOnce(detail(3, { result: { ...detail(3).result, turnsUsed: 3 } }))
      .mockReturnValueOnce(secondA.promise);
    const getDecisionIndex = vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(index);
    await openInspector(inspectorApi({ getDecisionIndex, getDecision }));
    const firstSignal = getDecision.mock.calls[0]?.[2];

    selectDecision(3);
    await settle();
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.getByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
    expect(screen.getByText('Consumió el turno 3.')).toBeTruthy();
    const destination = screen.getByRole('group', { name: 'Decisión 3, casilla 5' });
    destination.focus();

    selectDecision(1);
    await settle();
    expect(getDecision).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
    expect(document.activeElement).toBe(destination);
    await act(async () => {
      firstA.resolve(detail(1, { result: { ...detail(1).result, turnsUsed: 99 } }));
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByText('Consumió el turno 99.')).toBeNull();
    expect(screen.getByText('Cargando la ficha…')).toBeTruthy();

    secondA.resolve(detail(1, { result: { ...detail(1).result, turnsUsed: 7 } }));
    await settle();
    expect(screen.getByText('Consumió el turno 7.')).toBeTruthy();
    expect(screen.queryByText('Consumió el turno 99.')).toBeNull();
    expect(getDecisionIndex).toHaveBeenCalledOnce();
  });

  it('does not overlap a pending last-action detail and recovers it without moving focus or scrolling twice', async () => {
    const scroll = stubScrollIntoView();
    const pendingDetail = deferred<DecisionDetail>();
    const getDecision = vi
      .fn<AttemptApi['getDecision']>()
      .mockReturnValueOnce(pendingDetail.promise)
      .mockResolvedValueOnce(detail(3));
    const getDecisionIndex = vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(index);
    try {
      await openInspector(inspectorApi({ getDecisionIndex, getDecision }), {
        initialSelection: 'last-action-or-decision',
      });
      expect(getDecision).toHaveBeenCalledOnce();
      const pendingSignal = getDecision.mock.calls[0]?.[2];
      const focusDestination = document.activeElement;

      await advance(3 * MINUTE);
      expect(getDecision).toHaveBeenCalledOnce();
      expect(pendingSignal?.aborted).toBe(false);
      await act(async () => {
        pendingDetail.reject(new AttemptApiFailure('network', 'Ficha demorada.'));
        await Promise.resolve();
      });
      await settle();
      expect(screen.getByRole('heading', { name: 'Decisión 3, casilla 5' })).toBeTruthy();
      expect(screen.getByRole('group', { name: 'Mapa estático del recorrido' })).toBeTruthy();
      expect.soft(screen.queryByRole('alert')).toBeNull();
      expect.soft(screen.queryByRole('button', { name: /Reintentar/i })).toBeNull();
      expect.soft(screen.queryByRole('status')).not.toBeNull();
      await advance(MINUTE - 1);
      expect(getDecision).toHaveBeenCalledOnce();
      await advance(1);

      expect(getDecision).toHaveBeenCalledTimes(2);
      expect(getDecisionIndex).toHaveBeenCalledOnce();
      expect(screen.getByRole('heading', { name: 'Observación' })).toBeTruthy();
      expect(document.activeElement).toBe(focusDestination);
      expect(scroll.scrollIntoView).toHaveBeenCalledOnce();
      expect(scroll.scrolledElements[0]?.id).toBe('decision-detail');
      await advance(MINUTE);
      expect(getDecision).toHaveBeenCalledTimes(2);
      expect(scroll.scrollIntoView).toHaveBeenCalledOnce();
    } finally {
      scroll.restore();
    }
  });

  it('cancels pending last-action autoscroll after a manual decision selection', async () => {
    const scroll = stubScrollIntoView();
    const getDecision = vi
      .fn<AttemptApi['getDecision']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Ficha no disponible.'))
      .mockResolvedValueOnce(detail(1));
    const getDecisionIndex = vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(index);
    try {
      await openInspector(inspectorApi({ getDecisionIndex, getDecision }), {
        initialSelection: 'last-action-or-decision',
      });
      expect(getDecision).toHaveBeenCalledOnce();
      selectDecision(1);
      await settle();

      expect(getDecision).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
      expect(screen.getByRole('group', { name: 'Mapa estático del recorrido' })).toBeTruthy();
      await advance(MINUTE);
      expect(getDecision).toHaveBeenCalledTimes(2);
      expect(getDecisionIndex).toHaveBeenCalledOnce();
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();
    } finally {
      scroll.restore();
    }
  });

  it('retains a failure deadline while hidden and wakes once after it is due', async () => {
    const getDecisionIndex = vi
      .fn<AttemptApi['getDecisionIndex']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Sin conexión.'))
      .mockResolvedValue(index);
    await openInspector(inspectorApi({ getDecisionIndex }));

    setVisibility(true);
    fireEvent(document, new Event('visibilitychange'));
    await advance(2 * MINUTE);
    expect(getDecisionIndex).toHaveBeenCalledOnce();

    setVisibility(false);
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('heading', { name: 'Observación' })).toBeTruthy();

    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
  });

  it('does not retry early when waking before the original deadline', async () => {
    const getDecisionIndex = vi
      .fn<AttemptApi['getDecisionIndex']>()
      .mockRejectedValueOnce(new AttemptApiFailure('network', 'Sin conexión.'))
      .mockResolvedValue(index);
    await openInspector(inspectorApi({ getDecisionIndex }));

    setVisibility(true);
    fireEvent(document, new Event('visibilitychange'));
    await advance(MINUTE / 2);
    setVisibility(false);
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();
    expect(getDecisionIndex).toHaveBeenCalledOnce();

    await advance(MINUTE / 2 - 1);
    expect(getDecisionIndex).toHaveBeenCalledOnce();
    await advance(1);
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
  });

  it('aborts and invalidates an in-flight index when the document becomes hidden', async () => {
    const lateIndex = deferred<DecisionIndex>();
    const staleIndex: DecisionIndex = {
      ...index,
      decisions: [{ number: 9, decisionId: 'stale-decision', originSupport: 7, hasAction: true }],
    };
    const freshIndex: DecisionIndex = {
      ...index,
      decisions: [{ number: 1, decisionId: 'fresh-decision', originSupport: 2, hasAction: true }],
    };
    const getDecisionIndex = vi
      .fn<AttemptApi['getDecisionIndex']>()
      .mockReturnValueOnce(lateIndex.promise)
      .mockResolvedValueOnce(freshIndex);
    await openInspector(inspectorApi({ getDecisionIndex }));
    const firstSignal = getDecisionIndex.mock.calls[0]?.[1];

    setVisibility(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      lateIndex.resolve(staleIndex);
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByRole('group', { name: 'Mapa estático del recorrido' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Decisión 9, casilla 7' })).toBeNull();

    setVisibility(false);
    fireEvent(document, new Event('visibilitychange'));
    await settle();
    expect(getDecisionIndex).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('group', { name: 'Mapa estático del recorrido' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Decisión 1, casilla 2' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Decisión 9, casilla 7' })).toBeNull();
  });
});
