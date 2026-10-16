// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitoringSnapshot, MonitoringUser } from '../../../shared/monitoring.js';
import { App } from './App.js';

const periods = { hours24: 0, days3: 0, days7: 0 };
const asOf = '2026-10-16T12:00:00.000Z';

const user = (id: string, lastActiveAt: string): MonitoringUser => ({
  id,
  email: `${id}@example.com`,
  registeredAt: '2026-09-01T12:00:00.000Z',
  lastActiveAt,
  attempts: periods,
  bedrockCostUsd: periods,
  maxScore: 'N/A',
});

const response = (users: MonitoringUser[]): Response => {
  const snapshot: MonitoringSnapshot = {
    asOf,
    generatedAt: asOf,
    registeredUsers: users.length,
    newUsers: periods,
    activeUsers: { hours24: 0, days3: 2, days7: 3 },
    bedrockCostUsd: periods,
    users,
  };
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const emails = (): string[] =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getByRole('rowheader').textContent?.trim() ?? '');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('monitoring login activity', () => {
  it('renders numeric active counts, the login date in Argentina, and an unavailable date together', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          response([user('known', '2026-10-16T01:15:00.000Z'), user('unknown', 'N/A')]),
        ),
    );

    render(<App />);
    await screen.findByText('known@example.com');

    const activeCard = within(screen.getByRole('region', { name: 'Activos' }));
    for (const count of ['0', '2', '3']) {
      expect(activeCard.getByText(count, { exact: true })).toBeTruthy();
    }
    expect(activeCard.queryByText('N/A', { exact: true })).toBeNull();

    const known = within(screen.getByRole('row', { name: /^known@example\.com/ })).getAllByRole(
      'cell',
    );
    expect(known[1]?.textContent).toMatch(/15\/10\/26, (?:22:15|10:15 p\.\s*m\.)/u);
    const unknown = within(screen.getByRole('row', { name: /unknown@example\.com/ })).getAllByRole(
      'cell',
    );
    expect(unknown[1]?.textContent).toBe('N/A');
  });

  it('sorts login dates in both directions with unavailable dates last and applies fresh dates after refresh', async () => {
    const initial = [
      user('alpha', '2026-10-01T10:15:00.000Z'),
      user('middle', 'N/A'),
      user('beta', '2026-10-01T10:15:00.000Z'),
      user('zeta', '2026-09-30T23:45:00.000Z'),
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(initial))
      .mockResolvedValueOnce(
        response([user('alpha', '2026-09-01T10:15:00.000Z'), ...initial.slice(1)]),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByText('alpha@example.com');
    const header = screen.getByRole('columnheader', { name: /Última sesión/u });
    fireEvent.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(emails()).toEqual([
      'zeta@example.com',
      'alpha@example.com',
      'beta@example.com',
      'middle@example.com',
    ]);

    fireEvent.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(emails()).toEqual([
      'alpha@example.com',
      'beta@example.com',
      'zeta@example.com',
      'middle@example.com',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await screen.findByText('alpha@example.com');
    expect(emails()).toEqual([
      'beta@example.com',
      'zeta@example.com',
      'alpha@example.com',
      'middle@example.com',
    ]);
    expect(
      screen.getByRole('columnheader', { name: /Última sesión/u }).getAttribute('aria-sort'),
    ).toBe('descending');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
