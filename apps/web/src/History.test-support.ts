import { act, fireEvent, screen, within } from '@testing-library/react';
import { expect } from 'vitest';

export function historySection(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'Historial' });
  const section = heading.closest('section');
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

export function selectHistoryView(name: 'Recientes' | 'Mejores'): void {
  fireEvent.click(within(historySection()).getByText(name, { exact: true }));
}

export async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
  });
}

export function openHistoryActionMenus(section = historySection()): void {
  for (const menu of within(section).queryAllByText('Más acciones', { selector: 'summary' })) {
    const disclosure = menu.closest('details');
    if (!disclosure?.open) fireEvent.click(menu);
  }
}

async function waitForHistoryRows(section: HTMLElement): Promise<HTMLElement[]> {
  let rows: HTMLElement[] = [];
  await act(async () => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      rows = within(section).queryAllByRole('listitem');
      if (rows.length > 0) return;
      await Promise.resolve();
    }
  });
  expect(rows.length).toBeGreaterThan(0);
  return rows;
}

export async function historyActions(name: string): Promise<HTMLButtonElement[]> {
  await settle();
  const section = historySection();
  await waitForHistoryRows(section);
  if (name !== 'Abrir') {
    expect(
      within(section).getAllByText('Más acciones', { selector: 'summary' }).length,
    ).toBeGreaterThan(0);
    openHistoryActionMenus(section);
  }
  const matches = within(section).queryAllByRole('button', { name }) as HTMLButtonElement[];
  expect(matches.length).toBeGreaterThan(0);
  return matches;
}

export async function historyAction(name: string): Promise<HTMLButtonElement> {
  return (await historyActions(name))[0]!;
}

export async function historyActionForRow(
  name: string,
  rowText: string,
): Promise<HTMLButtonElement> {
  await settle();
  const section = historySection();
  await waitForHistoryRows(section);
  const matchingRows = within(section)
    .getAllByRole('listitem')
    .filter((row) => row.textContent?.includes(rowText));
  expect(matchingRows).toHaveLength(1);
  const [row] = matchingRows;
  openHistoryActionMenus(row!);
  return within(row!).getByRole('button', { name }) as HTMLButtonElement;
}
