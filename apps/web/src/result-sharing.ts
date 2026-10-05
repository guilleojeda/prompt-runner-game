import type { AttemptSummary } from './attempt-api.js';
import { DEFAULT_SCORE_RULES } from '../../../shared/game.js';

export type ShareResult =
  | {
      readonly kind: 'victory';
      readonly score: number | null;
      readonly turns: number;
      readonly reward: boolean;
    }
  | { readonly kind: 'progress'; readonly percent: number };

export function formatScore(value: number): string {
  return value.toLocaleString('es-AR', {
    minimumFractionDigits: DEFAULT_SCORE_RULES.decimalPlaces,
    maximumFractionDigits: DEFAULT_SCORE_RULES.decimalPlaces,
  });
}

// Explicitly select public values. Never pass a record, draft, or account to a share API.
export function shareResult(attempt: AttemptSummary): ShareResult | null {
  if (attempt.status === 'victory') {
    return {
      kind: 'victory',
      score: attempt.score,
      turns: attempt.turnsUsed,
      reward: attempt.collectedObjectIds.includes('recompensa-1'),
    };
  }
  if (attempt.status === 'defeat' || attempt.status === 'incomplete') {
    return { kind: 'progress', percent: Math.round(attempt.progress * 100) };
  }
  return null;
}

export function shareText(result: ShareResult, url: string): string {
  const message =
    result.kind === 'victory'
      ? result.score === null
        ? 'Mi robot ganó. ¿Podés hacer que el tuyo llegue a la salida?'
        : `Hice ${formatScore(result.score)} puntos. ¿Me ganás?`
      : `No pude hacerlo llegar. ¿Vos podés? Mi robot llegó al ${result.percent}% del nivel.`;
  return `${message}\nRobot Runner: A puro prompt\n${url}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo cargar la imagen de la tarjeta.'));
    image.src = src;
  });
}

export async function renderResultImage(result: ShareResult, origin: string): Promise<Blob> {
  const [logo, route] = await Promise.all([
    loadImage('/favicon.svg'),
    result.kind === 'progress' ? loadImage('/screenshots/recorrido.jpg') : Promise.resolve(null),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = result.kind === 'victory' ? 720 : 840;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No se pudo preparar la tarjeta.');
  const ctx = context;
  ctx.fillStyle = '#1b211b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  function text(
    value: string,
    x: number,
    y: number,
    size: number,
    serif = false,
    color = '#f6f0df',
  ) {
    ctx.fillStyle = color;
    ctx.font = `${size}px ${serif ? 'Georgia' : 'Arial'}, ${serif ? 'serif' : 'sans-serif'}`;
    ctx.fillText(value, x, y);
  }

  ctx.drawImage(logo, 56, 48, 76, 76);
  text('Robot Runner', 152, 81, 36);
  text('A puro prompt', 152, 113, 24, false, '#d8b36a');
  if (result.kind === 'victory') {
    text('Mi robot ganó', 56, 208, 28, false, '#d8b36a');
    if (result.score === null) {
      text('Llegó a la salida', 56, 330, 80, true);
      text('Puntaje desconocido', 56, 382, 28);
    } else {
      const score = formatScore(result.score);
      let size = 148;
      ctx.font = `${size}px Georgia, serif`;
      while (ctx.measureText(score).width > 900 && size > 36) {
        size -= 4;
        ctx.font = `${size}px Georgia, serif`;
      }
      text(score, 56, 354, size, true);
      text('puntos', 56, 402, 32);
    }
    text(`${result.turns} turnos`, 56, 464, 28);
    text(result.reward ? 'Recompensa recogida' : 'Recompensa no recogida', 270, 464, 28);
    ctx.fillStyle = '#3c4437';
    ctx.fillRect(56, 508, 1088, 2);
    text(result.score === null ? '¿Vos también podés?' : '¿Me ganás?', 56, 576, 44);
  } else {
    text('No pude hacerlo llegar.', 56, 234, 76, true);
    text('¿Vos podés?', 56, 320, 76, true);
    if (route) {
      // Crop the static level illustration, leaving its editor controls and HUD out.
      ctx.drawImage(route, 28, 175, 950, 206, 0, 368, 1200, 260);
    }
    ctx.fillStyle = '#303e2e';
    ctx.fillRect(0, 628, 1200, 122);
    text(`${result.percent}%`, 56, 705, 66, true);
    text('del nivel', 248, 705, 30);
    text('Hasta acá llegó mi robot.', 580, 701, 30);
  }
  text(new URL(origin).hostname, 56, canvas.height - 42, 25, false, '#d8b36a');
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('No se pudo generar la imagen.'));
    }, 'image/png');
  });
}
