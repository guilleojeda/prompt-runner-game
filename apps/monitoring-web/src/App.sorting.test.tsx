// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

type Periods = { hours24: number | 'N/A'; days3: number | 'N/A'; days7: number | 'N/A' };
type User = {
  id: string;
  email: string;
  registeredAt: string;
  lastActiveAt: string;
  attempts: Periods;
  bedrockCostUsd: Periods;
  maxScore: number | 'N/A';
};

const timestamp = '2026-10-15T12:00:00.000Z';

function user(id: string, email: string, attempts: Periods, maxScore: number | 'N/A'): User {
  return {
    id,
    email,
    registeredAt: timestamp,
    lastActiveAt: 'N/A',
    attempts,
    bedrockCostUsd: { hours24: 'N/A', days3: 'N/A', days7: 'N/A' },
    maxScore,
  };
}

function response(users: User[]): Response {
  const unavailable = { hours24: 'N/A', days3: 'N/A', days7: 'N/A' } as const;
  return new Response(
    JSON.stringify({
      asOf: timestamp,
      generatedAt: timestamp,
      registeredUsers: users.length,
      newUsers: { hours24: 0, days3: 0, days7: 0 },
      activeUsers: unavailable,
      bedrockCostUsd: unavailable,
      users,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function visibleEmails(): string[] {
  return within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent?.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? '');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('monitoring dashboard sort preference', () => {
  it('keeps the selected attempt sort through a failed refresh and retry with new metrics', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([
          user('alpha', 'alpha@example.com', { hours24: 2, days3: 3, days7: 4 }, 1.25),
          user('zeta', 'zeta@example.com', { hours24: 10, days3: 11, days7: 12 }, 2.5),
        ]),
      )
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        response([
          user('alpha-new', 'alpha@example.com', { hours24: 9, days3: 8, days7: 7 }, 3.75),
          user('zeta-new', 'zeta@example.com', { hours24: 1, days3: 5, days7: 6 }, -2.5),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByText('alpha@example.com')).toBeTruthy();

    const attemptsHeader = screen.getByRole('columnheader', { name: /Intentos.*24/i });
    fireEvent.click(within(attemptsHeader).getByRole('button'));
    expect(attemptsHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleEmails()).toEqual(['alpha@example.com', 'zeta@example.com']);

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(screen.getByText('Cargando datos')).toBeTruthy();
    expect(screen.queryByText('alpha@example.com')).toBeNull();
    expect(
      await screen.findByText('No se pudieron traer los datos. Volvé a intentar'),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    const retry = screen.getByRole('button', { name: 'Actualizar' });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    expect(screen.getByText('Cargando datos')).toBeTruthy();

    expect(await screen.findByText('zeta@example.com')).toBeTruthy();
    const refreshedAttemptsHeader = screen.getByRole('columnheader', { name: /Intentos.*24/i });
    expect(refreshedAttemptsHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleEmails()).toEqual(['zeta@example.com', 'alpha@example.com']);
    const zetaRow = within(screen.getByRole('table')).getByRole('row', {
      name: /zeta@example\.com/,
    });
    const zetaCells = within(zetaRow).getAllByRole('cell');
    expect(zetaCells[2]?.textContent).toBe('1');
    expect(zetaCells[3]?.textContent).toBe('5');
    expect(zetaCells[4]?.textContent).toBe('6');
    expect(zetaCells[8]?.textContent).toContain('-2,5');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
