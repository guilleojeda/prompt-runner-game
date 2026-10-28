// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptSummary } from './attempt-api.js';
import { HistoryResultQuery } from './AttemptActivityViews.js';
import { formatDateTime } from './attempt-display.js';

const selectedAttempt: AttemptSummary = {
  id: 'history-context-1',
  createdAt: '2026-10-27T12:00:00.000Z',
  updatedAt: '2026-10-27T12:04:00.000Z',
  status: 'victory',
  cancelRequested: false,
  levelId: 'principal',
  modelKey: 'claude-sonnet-4.6',
  modelLabel: 'Claude Sonnet 4.6',
  modelId: 'global.anthropic.claude-sonnet-4-6',
  turnsUsed: 1,
  maxTurns: 24,
  score: 321.47,
  collectedObjectIds: ['recompensa-1'],
  objectPoints: 25,
  progress: 1,
  finalSupport: 1,
  animationEnabled: false,
  presentationComplete: true,
  recordComplete: true,
  calls: 1,
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: 0,
  gameTokens: 30,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function view(state: Parameters<typeof HistoryResultQuery>[0]['state']) {
  return (
    <HistoryResultQuery
      state={state}
      sharingVisible
      onClose={vi.fn()}
      onReturnToEditor={vi.fn()}
      onReplay={vi.fn()}
      onInspect={vi.fn()}
      onConfiguration={vi.fn()}
      configurationBusy={false}
      busy={false}
    />
  );
}

describe('HistoryResultQuery result context', () => {
  it('keeps the selected creation context and heading through loading, error, and ready', () => {
    const contextText = `Historial, ${formatDateTime(selectedAttempt.createdAt)}`;
    const { rerender } = render(
      view({ targetId: selectedAttempt.id, status: 'loading', contextAttempt: selectedAttempt }),
    );

    const heading = screen.getByRole('heading', {
      name: 'Consultando el resultado guardado…',
    });
    const context = screen.getByText(contextText);
    expect(heading.id).toBe('history-result-loading-title');
    expect(screen.getByRole('button', { name: 'Volver al historial' })).toBeTruthy();

    rerender(
      view({
        targetId: selectedAttempt.id,
        status: 'error',
        message: 'No se pudo consultar.',
        contextAttempt: selectedAttempt,
      }),
    );
    expect(screen.getByRole('heading', { name: 'No se pudo abrir el resultado' })).toBe(heading);
    expect(screen.getByText(contextText)).toBe(context);

    rerender(view({ targetId: selectedAttempt.id, status: 'ready', attempt: selectedAttempt }));
    expect(screen.getByRole('heading', { name: 'Victoria' })).toBe(heading);
    expect(screen.getByText(contextText)).toBe(context);
    expect(screen.getAllByText(contextText)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Volver al editor' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Volver al historial' })).toBeTruthy();
  });
});
