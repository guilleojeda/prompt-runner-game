// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

type MetricValue = number | 'N/A';
type PeriodValues = { hours24: MetricValue; days3: MetricValue; days7: MetricValue };
type UserRow = {
  id: string;
  email: string;
  registeredAt: string | 'N/A';
  lastActiveAt: 'N/A';
  bedrockCostUsd: PeriodValues;
};
type Metrics = {
  asOf: string;
  generatedAt: string;
  registeredUsers: MetricValue;
  newUsers: PeriodValues;
  activeUsers: PeriodValues;
  bedrockCostUsd: PeriodValues;
  users: UserRow[];
};

const at = '2026-10-15T12:00:00.000Z';
const unknownPeriods = (): PeriodValues => ({ hours24: 'N/A', days3: 'N/A', days7: 'N/A' });
const zeroPeriods = (): PeriodValues => ({ hours24: 0, days3: 0, days7: 0 });

const metrics = (overrides: Partial<Metrics> = {}): Metrics => ({
  asOf: at,
  generatedAt: at,
  registeredUsers: 0,
  newUsers: zeroPeriods(),
  activeUsers: unknownPeriods(),
  bedrockCostUsd: unknownPeriods(),
  users: [],
  ...overrides,
});

const userRow = (overrides: Partial<UserRow> & Pick<UserRow, 'id' | 'email'>): UserRow => ({
  registeredAt: 'N/A',
  lastActiveAt: 'N/A',
  bedrockCostUsd: unknownPeriods(),
  ...overrides,
});

const jsonResponse = (body: Metrics, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const tableRows = (): string[] =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .filter((row) => row.textContent?.includes('@'))
    .map((row) => row.textContent?.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? '');

const sortedHeader = (name: string): HTMLElement =>
  screen.getByRole('columnheader', { name: new RegExp(name, 'i') });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('monitoring dashboard', () => {
  it('fetches fresh data on entry, refresh, and a new mount without showing a previous response', async () => {
    const first = metrics({
      registeredUsers: 42,
      users: [userRow({ id: 'first', email: 'first@example.com' })],
    });
    const refreshed = metrics({
      registeredUsers: 43,
      users: [userRow({ id: 'refreshed', email: 'refreshed@example.com' })],
    });
    const remounted = metrics({
      registeredUsers: 44,
      users: [userRow({ id: 'remounted', email: 'remounted@example.com' })],
    });
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let resolveRemount!: (response: Response) => void;
    const remountResponse = new Promise<Response>((resolve) => {
      resolveRemount = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockReturnValueOnce(refreshResponse)
      .mockReturnValueOnce(remountResponse);
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<App />);
    expect(await screen.findByText('42', { exact: true })).toBeTruthy();
    expect(screen.getByText('first@example.com')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const update = screen.getByRole('button', { name: 'Actualizar' }) as HTMLButtonElement;
    fireEvent.click(update);
    expect(update.disabled).toBe(true);
    expect(screen.getByText('Cargando datos')).toBeTruthy();
    expect(screen.queryByText('42', { exact: true })).toBeNull();
    expect(screen.queryByText('first@example.com')).toBeNull();
    await act(async () => resolveRefresh(jsonResponse(refreshed)));
    expect(await screen.findByText('43', { exact: true })).toBeTruthy();
    expect(screen.getByText('refreshed@example.com')).toBeTruthy();
    expect(update.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.unmount();
    render(<App />);
    expect(screen.getByText('Cargando datos')).toBeTruthy();
    expect(screen.queryByText('43', { exact: true })).toBeNull();
    expect(screen.queryByText('refreshed@example.com')).toBeNull();
    await act(async () => resolveRemount(jsonResponse(remounted)));
    expect(await screen.findByText('44', { exact: true })).toBeTruthy();
    expect(screen.getByText('remounted@example.com')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).toBe('/api/metrics');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    }
  });

  it('clears the previous data on refresh failure and lets the user retry', async () => {
    const oldData = metrics({
      registeredUsers: 7,
      users: [userRow({ id: 'old', email: 'old@example.com' })],
    });
    const newData = metrics({
      registeredUsers: 8,
      users: [userRow({ id: 'new', email: 'new@example.com' })],
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(oldData))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(newData));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByText('old@example.com')).toBeTruthy();
    const update = screen.getByRole('button', { name: 'Actualizar' });
    fireEvent.click(update);
    expect(screen.queryByText('old@example.com')).toBeNull();
    expect(
      await screen.findByText('No se pudieron traer los datos. Volvé a intentar'),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Actualizar' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText('new@example.com')).toBeTruthy();
    expect(screen.queryByText('No se pudieron traer los datos. Volvé a intentar')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shows numeric and zero summary values while leaving unavailable activity and costs as N/A', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        metrics({
          registeredUsers: 42,
          newUsers: { hours24: 3, days3: 8, days7: 11 },
          users: [
            userRow({
              id: 'one',
              email: 'one@example.com',
              registeredAt: '2026-10-15T12:00:00.000Z',
            }),
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByText('42', { exact: true });
    const content = screen.getByRole('main');
    const text = content.textContent ?? '';
    expect(text).toContain('Registrados');
    expect(text).toContain('Nuevos');
    expect(text).toContain('Activos');
    expect(text).toContain('Gasto Bedrock');
    expect(text).toContain('24 horas');
    expect(text).toContain('3 días');
    expect(text).toContain('7 días');
    for (const value of ['42', '3', '8', '11']) {
      expect(within(content).getByText(value, { exact: true })).toBeTruthy();
    }
    expect(within(content).getAllByText('N/A', { exact: true }).length).toBeGreaterThanOrEqual(10);
    const row = within(screen.getByRole('table')).getByRole('row', {
      name: /one@example\.com/,
    });
    expect(within(row).getAllByText('N/A', { exact: true })).toHaveLength(4);
    expect(text).not.toContain('Intentos');
    expect(text).not.toContain('Puntaje máximo');
    expect(text).toMatch(/0?9:00/);
    expect(text).toMatch(/Argentina|ART|GMT[−-]3/);
  });

  it('keeps an empty verified-user table distinct from zero counts and unavailable metrics', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(metrics()));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findAllByText('0', { exact: true });
    const table = screen.getByRole('table');
    expect(within(table).queryByText(/@/)).toBeNull();
    expect(within(screen.getByRole('main')).getAllByText('0', { exact: true }).length).toBe(4);
    expect(within(screen.getByRole('main')).getAllByText('N/A', { exact: true }).length).toBe(6);
  });

  it('does not poll or persist dashboard data and handles a rejected network request', async () => {
    const first = metrics({
      registeredUsers: 1,
      users: [userRow({ id: 'first', email: 'first@example.com' })],
    });
    const retried = metrics({
      registeredUsers: 2,
      users: [userRow({ id: 'retried', email: 'retried@example.com' })],
    });
    let rejectRefresh!: (reason: unknown) => void;
    const refreshResponse = new Promise<Response>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockReturnValueOnce(refreshResponse)
      .mockResolvedValueOnce(jsonResponse(retried));
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const localStorageKeys = Object.keys(window.localStorage);
    const sessionStorageKeys = Object.keys(window.sessionStorage);
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByText('first@example.com')).toBeTruthy();
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.useRealTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(screen.getByText('Cargando datos')).toBeTruthy();
    expect(screen.queryByText('first@example.com')).toBeNull();
    await act(async () => {
      rejectRefresh(new TypeError('offline'));
    });
    expect(
      await screen.findByText('No se pudieron traer los datos. Volvé a intentar'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText('retried@example.com')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(Object.keys(window.localStorage)).toEqual(localStorageKeys);
    expect(Object.keys(window.sessionStorage)).toEqual(sessionStorageKeys);
  });

  it('supports both sort directions on every phase-one table column with aria-sort', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        metrics({
          registeredUsers: 4,
          users: [
            userRow({
              id: 'late',
              email: 'zeta@example.com',
              registeredAt: '2026-10-15T13:00:00Z',
              bedrockCostUsd: { hours24: 10, days3: 2, days7: 'N/A' },
            }),
            userRow({
              id: 'unknown',
              email: 'middle@example.com',
              registeredAt: 'N/A',
              bedrockCostUsd: unknownPeriods(),
            }),
            userRow({
              id: 'tie',
              email: 'beta@example.com',
              registeredAt: '2026-10-15T12:00:00Z',
              bedrockCostUsd: { hours24: 'N/A', days3: 'N/A', days7: 2 },
            }),
            userRow({
              id: 'early',
              email: 'alpha@example.com',
              registeredAt: '2026-10-15T12:00:00Z',
              bedrockCostUsd: { hours24: 2, days3: 10, days7: 10 },
            }),
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByText('zeta@example.com');

    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader');
    const sortable = headers.filter((header) => within(header).queryByRole('button'));
    expect(sortable).toHaveLength(6);
    const headerText = sortable.map((header) => header.textContent ?? '').join(' ');
    expect(headerText).toMatch(/Usuario/i);
    expect(headerText).toMatch(/Registro/i);
    expect(headerText).toMatch(/Última sesión/i);
    expect(headerText).toMatch(/Bedrock/i);
    expect(headerText).toMatch(/24\s*(h|horas)/i);
    expect(headerText).toMatch(/3\s*(días|d)/i);
    expect(headerText).toMatch(/7\s*(días|d)/i);

    for (const header of sortable) {
      const button = within(header).getByRole('button');
      fireEvent.click(button);
      const firstDirection = header.getAttribute('aria-sort');
      fireEvent.click(button);
      const secondDirection = header.getAttribute('aria-sort');
      expect(new Set([firstDirection, secondDirection])).toEqual(
        new Set(['ascending', 'descending']),
      );
    }

    const sortCases = [
      {
        name: 'Usuario',
        ascending: [
          'alpha@example.com',
          'beta@example.com',
          'middle@example.com',
          'zeta@example.com',
        ],
        descending: [
          'zeta@example.com',
          'middle@example.com',
          'beta@example.com',
          'alpha@example.com',
        ],
      },
      {
        name: 'Registro',
        ascending: [
          'alpha@example.com',
          'beta@example.com',
          'zeta@example.com',
          'middle@example.com',
        ],
        descending: [
          'zeta@example.com',
          'alpha@example.com',
          'beta@example.com',
          'middle@example.com',
        ],
      },
      {
        name: 'Última sesión',
        ascending: [
          'alpha@example.com',
          'beta@example.com',
          'middle@example.com',
          'zeta@example.com',
        ],
        descending: [
          'alpha@example.com',
          'beta@example.com',
          'middle@example.com',
          'zeta@example.com',
        ],
      },
      {
        name: 'Bedrock.*24',
        ascending: [
          'alpha@example.com',
          'zeta@example.com',
          'beta@example.com',
          'middle@example.com',
        ],
        descending: [
          'zeta@example.com',
          'alpha@example.com',
          'beta@example.com',
          'middle@example.com',
        ],
      },
      {
        name: 'Bedrock.*3',
        ascending: [
          'zeta@example.com',
          'alpha@example.com',
          'beta@example.com',
          'middle@example.com',
        ],
        descending: [
          'alpha@example.com',
          'zeta@example.com',
          'beta@example.com',
          'middle@example.com',
        ],
      },
      {
        name: 'Bedrock.*7',
        ascending: [
          'beta@example.com',
          'alpha@example.com',
          'middle@example.com',
          'zeta@example.com',
        ],
        descending: [
          'alpha@example.com',
          'beta@example.com',
          'middle@example.com',
          'zeta@example.com',
        ],
      },
    ];
    for (const { name, ascending, descending } of sortCases) {
      const header = sortedHeader(name);
      const button = within(header).getByRole('button');
      fireEvent.click(button);
      const firstDirection = header.getAttribute('aria-sort');
      expect(tableRows()).toEqual(firstDirection === 'ascending' ? ascending : descending);
      fireEvent.click(button);
      const secondDirection = header.getAttribute('aria-sort');
      expect(secondDirection).not.toBe(firstDirection);
      expect(tableRows()).toEqual(secondDirection === 'ascending' ? ascending : descending);
    }
  });
});
