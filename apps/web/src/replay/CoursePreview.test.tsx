// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CoursePreview } from './ReplayScene.js';

afterEach(cleanup);

describe('CoursePreview navigation', () => {
  it('names the start and goal beyond numbered tiles while retaining the authored scene', () => {
    render(<CoursePreview />);
    const section = screen
      .getByRole('heading', { name: 'Vista completa del terreno' })
      .closest('section')!;

    expect(within(section).getByText(/^Inicio\b/i)).toBeTruthy();
    expect(within(section).getByText(/^(?:Meta|Salida)\b/i)).toBeTruthy();
    const scene = within(section).getByRole('img', {
      name: /Recorrido completo desde la casilla 0 hasta la 10/,
    });
    expect(scene.getAttribute('data-course-preview')).toBe('static');
    expect(scene.getAttribute('data-preview-phase')).toBe('0');
    const rules = within(section).getByText('Reglas del recorrido').closest('details')!;
    expect(rules.open).toBe(false);
  });

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
