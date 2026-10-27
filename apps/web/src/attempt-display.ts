import type { AttemptStatus, AttemptSummary } from './attempt-api.js';
import type { RobotDraft } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import { MODEL_CATALOG } from '../../../shared/models.js';

export function isTerminal(status: AttemptStatus): boolean {
  return status !== 'pending' && status !== 'running';
}

export function technicalReasonLabel(reason: string): string | null {
  const labels: Record<string, string> = {
    start_deadline_expired: 'Tiempo de inicio agotado',
    runtime_deadline_expired: 'Tiempo de ejecución agotado',
    runtime_deadline_exceeded: 'Tiempo de ejecución insuficiente',
    throttled: 'Proveedor temporalmente saturado',
    timeout: 'Tiempo de espera agotado',
    invalid_response: 'Respuesta inválida del agente',
    truncated: 'Respuesta incompleta del agente',
    audit_failed: 'No se pudo completar el registro de auditoría',
    request_not_persisted: 'No se pudo guardar la solicitud',
    provider_error: 'Error del proveedor del agente',
  };
  return labels[reason] ?? null;
}

export function statusLabel(status: AttemptStatus): string {
  switch (status) {
    case 'pending':
      return 'Intento recibido, esperando inicio';
    case 'running':
      return 'Preparando intento';
    case 'victory':
      return 'Victoria';
    case 'defeat':
      return 'Derrota';
    case 'incomplete':
      return 'Recorrido incompleto';
    case 'cancelled':
      return 'Cancelado';
    case 'error':
      return 'Error de ejecución';
  }
}

export function formatMetric(value: number | null): string {
  return value === null ? 'desconocido' : value.toLocaleString('es-AR');
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
}

export type ResultSource = 'current' | 'history';

export function resultSourceLabel(source: ResultSource): string {
  return source === 'history' ? 'Historial' : 'Esta partida';
}

export function formatProgress(value: number): string {
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

export function objectCollectionStatus(attempt: AttemptSummary): string {
  const collected = new Set(attempt.collectedObjectIds);
  const details = LEVEL.objects.map((object) => {
    const label = object.id === 'llave-1' ? 'Llave' : 'Recompensa';
    const value = `${object.scoreValue} puntos`;
    const state = collected.has(object.id)
      ? `recogida (${value})`
      : `no recogida (${value}${object.scoreValue > 0 ? ' posibles' : ''})`;
    return `${label}: ${state}`;
  });
  return `${details.join(', ')}, valor total: ${attempt.objectPoints.toLocaleString('es-AR')} puntos`;
}

export function stableHistoryOrder(left: AttemptSummary, right: AttemptSummary): number {
  const byDate = right.createdAt.localeCompare(left.createdAt);
  return byDate === 0 ? left.id.localeCompare(right.id) : byDate;
}

export function comparableVictories(
  attempts: readonly AttemptSummary[],
): readonly AttemptSummary[] {
  return attempts
    .filter(
      (attempt) => attempt.status === 'victory' && attempt.recordComplete && attempt.score !== null,
    )
    .sort((left, right) => {
      const byScore = (right.score ?? 0) - (left.score ?? 0);
      return byScore === 0 ? stableHistoryOrder(left, right) : byScore;
    });
}

export function formatHistoryScope(count: number, hasMore: boolean): string {
  return hasMore
    ? `${count} cargados, hay más intentos para consultar`
    : `${count} cargados, todo el historial disponible está visible`;
}

export function rankFor(attempts: readonly AttemptSummary[], index: number): number {
  const score = attempts[index]?.score;
  return attempts.findIndex((attempt) => attempt.score === score) + 1;
}

export function historyComparisonMetrics(attempt: AttemptSummary): string {
  return `${attempt.turnsUsed} / ${attempt.maxTurns} turnos, ${formatMetric(attempt.gameTokens)} tokens para puntaje, ${attempt.collectedObjectIds.length} objetos, ${attempt.modelLabel}, ${formatDateTime(attempt.createdAt)}`;
}

export function historyDetailMetrics(attempt: AttemptSummary): string {
  return `Avance: ${formatProgress(attempt.progress)}, ${historyComparisonMetrics(attempt)}`;
}

export function modelLabel(modelKey: RobotDraft['modelKey']): string {
  return MODEL_CATALOG.find((model) => model.key === modelKey)?.label ?? 'Modelo no disponible';
}
