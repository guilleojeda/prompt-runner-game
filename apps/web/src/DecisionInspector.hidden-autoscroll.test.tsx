// @vitest-environment jsdom

import { Profiler, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../../shared/game.js';
import {
  type AttemptApi,
  type DecisionDetail,
  type DecisionIndex,
  type DecisionIndexItem,
} from './attempt-api.js';
import { DecisionInspector } from './DecisionInspector.js';

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

const items: readonly DecisionIndexItem[] = [
  { number: 1, decisionId: 'decision-1', originSupport: 0, hasAction: true },
  { number: 2, decisionId: 'decision-2', originSupport: 1, hasAction: false },
];

const index: DecisionIndex = { attemptId: 'attempt-1', levelId: LEVEL.id, decisions: items };

function detail(number: number): DecisionDetail {
  return {
    attemptId: 'attempt-1',
    levelId: LEVEL.id,
    item: items[number - 1]!,
    observation: null,
    availableActions: null,
    choice: { state: 'unknown' },
    result: { kind: 'no-action', turnsUsed: 0, status: 'cancelled' },
  };
}

function inspectorApi() {
  const getDecisionIndex = vi.fn<AttemptApi['getDecisionIndex']>().mockResolvedValue(index);
  const getDecision = vi
    .fn<AttemptApi['getDecision']>()
    .mockImplementation(async (_id, number) => detail(number));
  return {
    api: { getDecisionIndex, getDecision } as unknown as AttemptApi,
    getDecisionIndex,
    getDecision,
  };
}

function stubScrollIntoView() {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
    writable: true,
  });
  return {
    scrollIntoView,
    restore() {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    },
  };
}

function setVisibility(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
}

function renderInspector(
  api: AttemptApi,
  options: { readonly hideBeforeDetailEffect?: boolean; readonly onClose?: () => void } = {},
) {
  let hiddenAtDetailCommit = false;

  function InspectorHost() {
    const [open, setOpen] = useState(true);
    const onRender = (): void => {
      if (
        options.hideBeforeDetailEffect &&
        !hiddenAtDetailCommit &&
        document.querySelector('[aria-label="Ficha de decisión 1"]')
      ) {
        hiddenAtDetailCommit = true;
        setVisibility(true);
      }
    };

    return (
      <Profiler id="decision-inspector" onRender={onRender}>
        {open && (
          <DecisionInspector
            api={api}
            attemptId="attempt-1"
            initialSelection="last-action-or-decision"
            onClose={() => {
              options.onClose?.();
              setOpen(false);
            }}
          />
        )}
      </Profiler>
    );
  }

  const view = render(<InspectorHost />);
  return { ...view, hiddenAtDetailCommit: () => hiddenAtDetailCommit };
}

function wakeDocument(): void {
  act(() => {
    setVisibility(false);
    fireEvent(document, new Event('visibilitychange'));
  });
  act(() => {
    fireEvent(window, new Event('focus'));
  });
}

function clickWithoutNavigation(element: HTMLElement): void {
  const preventDefault = (event: Event): void => {
    if (event.target === element) event.preventDefault();
  };
  document.addEventListener('click', preventDefault, true);
  try {
    fireEvent.click(element);
  } finally {
    document.removeEventListener('click', preventDefault, true);
  }
}

afterEach(() => {
  cleanup();
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

beforeEach(() => setVisibility(false));

describe('DecisionInspector hidden initial autoscroll', () => {
  it('scrolls the pending latest detail once on wake without refetching or moving focus', async () => {
    const api = inspectorApi();
    const scroll = stubScrollIntoView();
    try {
      const view = renderInspector(api.api, { hideBeforeDetailEffect: true });

      expect(await screen.findByRole('region', { name: 'Ficha de decisión 1' })).toBeTruthy();
      expect(view.hiddenAtDetailCommit()).toBe(true);
      expect(scroll.scrollIntoView).not.toHaveBeenCalled();
      expect(api.getDecisionIndex).toHaveBeenCalledOnce();
      expect(api.getDecision).toHaveBeenCalledOnce();
      const focusBeforeWake = document.activeElement;

      wakeDocument();

      expect(scroll.scrollIntoView).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(focusBeforeWake);
      expect(api.getDecisionIndex).toHaveBeenCalledOnce();
      expect(api.getDecision).toHaveBeenCalledOnce();
    } finally {
      scroll.restore();
    }
  });

  it.each(['selection', 'link', 'close'] as const)(
    'does not scroll on wake after a manual %s action',
    async (action) => {
      const api = inspectorApi();
      const scroll = stubScrollIntoView();
      const onClose = vi.fn();
      try {
        const view = renderInspector(api.api, { hideBeforeDetailEffect: true, onClose });

        expect(await screen.findByRole('region', { name: 'Ficha de decisión 1' })).toBeTruthy();
        expect(view.hiddenAtDetailCommit()).toBe(true);
        expect(scroll.scrollIntoView).not.toHaveBeenCalled();

        if (action === 'selection') {
          fireEvent.click(screen.getAllByRole('button', { name: /Decisión 2/ })[0]!);
          expect(screen.getByRole('heading', { name: 'Decisión 2, casilla 1' })).toBeTruthy();
        } else if (action === 'link') {
          clickWithoutNavigation(
            screen.getAllByRole('link', { name: 'Ver ficha seleccionada' })[0]!,
          );
        } else {
          fireEvent.click(screen.getByRole('button', { name: 'Cerrar inspección' }));
          expect(onClose).toHaveBeenCalledOnce();
          expect(screen.queryByRole('region', { name: 'Ficha de decisión 1' })).toBeNull();
        }

        const indexReadsBeforeWake = api.getDecisionIndex.mock.calls.length;
        const detailReadsBeforeWake = api.getDecision.mock.calls.length;
        wakeDocument();

        if (action === 'selection') {
          expect(await screen.findByRole('region', { name: 'Ficha de decisión 2' })).toBeTruthy();
          expect(api.getDecision).toHaveBeenCalledTimes(detailReadsBeforeWake + 1);
        } else {
          expect(api.getDecision).toHaveBeenCalledTimes(detailReadsBeforeWake);
        }

        expect(scroll.scrollIntoView).not.toHaveBeenCalled();
        expect(api.getDecisionIndex).toHaveBeenCalledTimes(indexReadsBeforeWake);
      } finally {
        scroll.restore();
      }
    },
  );

  it('does not repeat a latest-detail scroll that was already consumed before hiding', async () => {
    const api = inspectorApi();
    const scroll = stubScrollIntoView();
    try {
      renderInspector(api.api);

      expect(await screen.findByRole('region', { name: 'Ficha de decisión 1' })).toBeTruthy();
      expect(scroll.scrollIntoView).toHaveBeenCalledOnce();
      expect(api.getDecisionIndex).toHaveBeenCalledOnce();
      expect(api.getDecision).toHaveBeenCalledOnce();

      setVisibility(true);
      setVisibility(false);
      fireEvent(document, new Event('visibilitychange'));
      fireEvent(window, new Event('focus'));

      expect(scroll.scrollIntoView).toHaveBeenCalledOnce();
      expect(api.getDecisionIndex).toHaveBeenCalledOnce();
      expect(api.getDecision).toHaveBeenCalledOnce();
    } finally {
      scroll.restore();
    }
  });
});
