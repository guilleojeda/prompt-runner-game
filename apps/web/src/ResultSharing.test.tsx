// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptSummary } from './attempt-api.js';
import { ResultSharing } from './ResultSharing.js';
import { renderResultImage, shareResult, shareText } from './result-sharing.js';

vi.mock('./result-sharing.js', async (original) => ({
  ...(await original<typeof import('./result-sharing.js')>()),
  renderResultImage: vi.fn(),
}));

const victory: AttemptSummary = {
  id: 'private-attempt-id',
  createdAt: '2026-10-04T00:00:00Z',
  updatedAt: '2026-10-04T00:00:00Z',
  status: 'victory',
  cancelRequested: false,
  levelId: 'principal-puerta-v4',
  modelKey: 'claude-sonnet-4.6',
  modelLabel: 'Claude Sonnet 4.6',
  modelId: 'private-model-id',
  turnsUsed: 17,
  maxTurns: 24,
  calls: 17,
  inputTokens: 15000,
  outputTokens: 5600,
  reasoningTokens: null,
  gameTokens: 20600,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  score: 834.4,
  collectedObjectIds: ['recompensa-1', 'llave-1'],
  objectPoints: 25,
  progress: 1,
  finalSupport: 10,
  animationEnabled: false,
  presentationComplete: true,
  recordComplete: true,
};

beforeEach(() => {
  vi.mocked(renderResultImage).mockResolvedValue(new Blob(['png-fixture'], { type: 'image/png' }));
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview');
      static revokeObjectURL = vi.fn();
    },
  );
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(renderResultImage).mockReset();
});

async function open(attempt: AttemptSummary = victory) {
  render(<ResultSharing attempt={attempt} disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Compartir resultado' }));
  await screen.findByRole('link', { name: 'Descargar imagen' });
}

describe('result sharing', () => {
  it('uses persisted scores, including negatives, without recomputing from token usage', () => {
    expect(shareResult(victory)).toEqual({
      kind: 'victory',
      score: 834.4,
      turns: 17,
      reward: true,
    });
    const negative = shareResult({ ...victory, score: -37.2, gameTokens: null });
    expect(negative).not.toBeNull();
    expect(shareText(negative!, 'https://game.test/bienvenida.html')).toBe(
      'Hice -37,20 puntos. ¿Me ganás?\nRobot Runner: A puro prompt\nhttps://game.test/bienvenida.html',
    );
    const unknown = shareResult({ ...victory, score: null });
    expect(shareText(unknown!, 'https://game.test/bienvenida.html')).toContain(
      'Mi robot ganó. ¿Podés hacer que el tuyo llegue a la salida?',
    );
    expect(shareText(unknown!, 'https://game.test/bienvenida.html')).not.toMatch(/\d|puntos/);
  });

  it.each(['defeat', 'incomplete'] as const)(
    'shares maximum progress for %s, excluding a residual score and final position',
    (status) => {
      const result = shareResult({ ...victory, status, progress: 0.8, finalSupport: 2 });
      expect(result).toEqual({ kind: 'progress', percent: 80 });
      expect(shareText(result!, 'https://game.test/bienvenida.html')).toBe(
        'No pude hacerlo llegar. ¿Vos podés? Mi robot llegó al 80% del nivel.\nRobot Runner: A puro prompt\nhttps://game.test/bienvenida.html',
      );
    },
  );

  it.each(['pending', 'running', 'cancelled', 'error'] as const)(
    'offers no share action for %s',
    (status) => {
      render(<ResultSharing attempt={{ ...victory, status }} disabled={false} />);
      expect(screen.queryByRole('button', { name: 'Compartir resultado' })).toBeNull();
    },
  );

  it('previews and downloads the same PNG, copies the public landing URL, and restores focus', async () => {
    await open();
    expect(renderResultImage).toHaveBeenCalledWith(
      { kind: 'victory', score: 834.4, turns: 17, reward: true },
      window.location.origin,
    );
    const download = screen.getByRole('link', { name: 'Descargar imagen' });
    expect(download.getAttribute('href')).toBe(screen.getByRole('img').getAttribute('src'));
    expect(download.getAttribute('download')).toBe('robot-runner-resultado.png');
    expect(screen.queryByRole('button', { name: 'Compartir imagen y texto' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Compartir resultado' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copiar texto y enlace' }));
    await screen.findByText('Texto y enlace copiados.');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `Hice 834,40 puntos. ¿Me ganás?\nRobot Runner: A puro prompt\n${window.location.origin}/bienvenida.html`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Compartir resultado' }),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('sends only the public text and the generated file to native sharing, with neutral cancellation and download fallback', async () => {
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('cancel', 'AbortError'))
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    await open();
    const button = screen.getByRole('button', { name: 'Compartir imagen y texto' });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(screen.queryByText(/No se pudo compartir|Resultado compartido/)).toBeNull();
    const payload = share.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['files', 'text', 'title']);
    expect(payload.text).toBe(
      (screen.getByLabelText('Texto para compartir') as HTMLTextAreaElement).value,
    );
    expect(payload.text).not.toContain(victory.id);
    expect(payload.text).not.toContain(victory.modelId);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toMatchObject({
      name: 'robot-runner-resultado.png',
      type: 'image/png',
      size: 11,
    });
    fireEvent.click(button);
    await screen.findByText('No se pudo compartir. Podés descargar la imagen y copiar el texto.');
    expect(screen.getByRole('link', { name: 'Descargar imagen' })).toBeTruthy();
    fireEvent.click(button);
    await screen.findByText('Resultado compartido.');
  });

  it('keeps text selectable if clipboard access is denied and retries a failed image', async () => {
    vi.mocked(renderResultImage).mockRejectedValueOnce(new Error('resource unavailable'));
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    render(<ResultSharing attempt={victory} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Compartir resultado' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Copiar texto y enlace' }));
    await screen.findByText('No se pudo copiar. Seleccioná el texto de abajo y copialo.');
    expect((screen.getByLabelText('Texto para compartir') as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar tarjeta' }));
    await screen.findByRole('link', { name: 'Descargar imagen' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
