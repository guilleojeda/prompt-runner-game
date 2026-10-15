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
  bedrockCostUsd: Periods;
};

const timestamp = '2026-10-15T12:00:00.000Z';

function user(id: string, email: string, hours24: number): User {
  return {
    id,
    email,
    registeredAt: timestamp,
    lastActiveAt: 'N/A',
    bedrockCostUsd: { hours24, days3: 'N/A', days7: 'N/A' },
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
  it('keeps the selected column and direction while refreshed data replaces the previous snapshot', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([user('alpha', 'alpha@example.com', 2), user('zeta', 'zeta@example.com', 10)]),
      )
      .mockResolvedValueOnce(
        response([
          user('alpha-new', 'alpha@example.com', 10),
          user('zeta-new', 'zeta@example.com', 2),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByText('alpha@example.com')).toBeTruthy();

    const costHeader = screen.getByRole('columnheader', { name: /Bedrock.*24 horas/i });
    fireEvent.click(within(costHeader).getByRole('button'));
    expect(costHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleEmails()).toEqual(['alpha@example.com', 'zeta@example.com']);

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(screen.getByText('Cargando datos')).toBeTruthy();
    expect(screen.queryByText('alpha@example.com')).toBeNull();

    expect(await screen.findByText('zeta@example.com')).toBeTruthy();
    const refreshedCostHeader = screen.getByRole('columnheader', { name: /Bedrock.*24 horas/i });
    expect(refreshedCostHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleEmails()).toEqual(['zeta@example.com', 'alpha@example.com']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
