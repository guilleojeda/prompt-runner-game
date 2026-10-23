// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CoursePreview } from './ReplayScene.js';

afterEach(cleanup);

describe('CoursePreview navigation', () => {
  it('explains how to slide the map without opening its rules and keeps the map focusable', () => {
    render(<CoursePreview />);

    const section = screen
      .getByRole('heading', { name: 'Vista completa del terreno' })
      .closest('section')!;
    const guidance = within(section).getByText(/(?:deslizá|desplazá).*mapa/i);
    expect(guidance.closest('details')).toBeNull();
    expect(guidance.closest('[hidden], [aria-hidden="true"]')).toBeNull();

    const scroller = within(section).getByLabelText('Recorrido desplazable');
    expect(scroller.tabIndex).toBe(0);
    scroller.focus();
    expect(document.activeElement).toBe(scroller);
    expect(
      within(scroller).getByRole('img', { name: /Recorrido completo desde la casilla 0/ }),
    ).toBeTruthy();
  });
});
