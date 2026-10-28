import { useEffect, useRef } from 'react';
import type { AttemptConfiguration, AttemptSummary } from './attempt-api.js';
import { DEFAULT_SCORE_RULES, LEVEL } from '../../../shared/game.js';
import { ROBOT_CATALOG } from '../../../shared/robot.js';
import { ResultSharing } from './ResultSharing.js';
import { formatScore } from './result-sharing.js';
import type {
  AttemptDisplayContext,
  DecisionInitialSelection,
  AttemptResultQueryState,
  HistoryView,
} from './useAttemptHistory.js';
import {
  comparableVictories,
  formatHistoryScope,
  formatDateTime,
  formatMetric,
  formatProgress,
  modelLabel,
  rankFor,
  resultSourceLabel,
  statusLabel,
  technicalReasonLabel,
  isTerminal,
  type ResultSource,
} from './attempt-display.js';

function ResultContext({ source, createdAt }: { source: ResultSource; createdAt: string }) {
  return (
    <p className="attempt-result-context">
      {resultSourceLabel(source)}, {formatDateTime(createdAt)}
    </p>
  );
}

export function ResultCard({
  attempt,
  source,
  createdAt,
  sharingVisible,
  onReplay,
  onInspect,
  onConfiguration,
  configurationBusy,
  busy,
  onReturnToEditor,
  onReturnToHistory,
  headingId = 'attempt-result-title',
  showHeading = true,
  showContext = true,
}: {
  attempt: AttemptSummary;
  source: ResultSource;
  createdAt: string;
  sharingVisible: boolean;
  onReplay: () => void;
  onInspect?: (initialSelection: DecisionInitialSelection) => void;
  onConfiguration: () => void;
  configurationBusy: boolean;
  busy: boolean;
  onReturnToEditor: () => void;
  onReturnToHistory?: () => void;
  headingId?: string;
  showHeading?: boolean;
  showContext?: boolean;
}) {
  const technicalError = attempt.reason ? technicalReasonLabel(attempt.reason) : null;
  const tokenPenalty =
    attempt.gameTokens === null
      ? null
      : DEFAULT_SCORE_RULES.tokenWeight * (attempt.gameTokens / DEFAULT_SCORE_RULES.tokenUnit);
  const inspect = attempt.recordComplete ? onInspect : undefined;
  return (
    <section className="attempt-result" aria-labelledby={headingId}>
      {showHeading && (
        <div className="attempt-result-heading">
          <div>
            <p className="card-kicker">Resultado del recorrido</p>
            <h3 id={headingId} tabIndex={-1}>
              {statusLabel(attempt.status)}
            </h3>
            {showContext && <ResultContext source={source} createdAt={createdAt} />}
          </div>
          {onReturnToHistory && (
            <button
              className="text-button attempt-result-history-return"
              type="button"
              onClick={onReturnToHistory}
              disabled={busy}
            >
              Volver al historial
            </button>
          )}
        </div>
      )}
      {!showHeading && showContext && <ResultContext source={source} createdAt={createdAt} />}
      {!showHeading && onReturnToHistory && (
        <div className="attempt-result-back">
          <button
            className="text-button attempt-result-history-return"
            type="button"
            onClick={onReturnToHistory}
            disabled={busy}
          >
            Volver al historial
          </button>
        </div>
      )}
      {attempt.status === 'victory' && (
        <div className="attempt-result-score" aria-label="Puntaje de la victoria">
          <span>Puntaje</span>
          <strong>{attempt.score === null ? 'Desconocido' : formatScore(attempt.score)}</strong>
        </div>
      )}
      {attempt.status === 'error' && (
        <p className="attempt-result-note">
          <strong>Causa:</strong> {technicalError ?? 'el cálculo no pudo completarse.'}{' '}
          <strong>Acción:</strong> Podés volver al editor y probar de nuevo; un nuevo intento
          consume cuota.
        </p>
      )}
      <dl className="attempt-result-summary">
        {attempt.status !== 'victory' && (
          <div>
            <dt>Avance máximo</dt>
            <dd>{formatProgress(attempt.progress)}</dd>
          </div>
        )}
        <div>
          <dt>Turnos</dt>
          <dd>
            {attempt.turnsUsed} / {attempt.maxTurns}
          </dd>
        </div>
        {LEVEL.objects.map((object) => {
          const collected = attempt.collectedObjectIds.includes(object.id);
          const isKey = object.id === 'llave-1';
          return (
            <div key={object.id}>
              <dt>{isKey ? 'Llave' : 'Recompensa'}</dt>
              <dd>
                {collected ? 'Recogida' : 'No recogida'}
                {!isKey && `, ${object.scoreValue} puntos${!collected ? ' posibles' : ''}`}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="attempt-result-actions">
        {isTerminal(attempt.status) && (
          <button
            className="primary-button"
            type="button"
            onClick={onReturnToEditor}
            disabled={busy}
          >
            Volver al editor
          </button>
        )}
        {attempt.recordComplete && attempt.turnsUsed > 0 && (
          <button className="secondary-button" type="button" onClick={onReplay} disabled={busy}>
            Ver de nuevo
          </button>
        )}
        {inspect && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => inspect('first')}
            disabled={busy}
          >
            Inspeccionar decisiones
          </button>
        )}
        {inspect && attempt.status !== 'victory' && (
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              inspect(attempt.status === 'defeat' ? 'last-action-or-decision' : 'last-decision')
            }
            disabled={busy}
          >
            {attempt.status === 'defeat' ? 'Ir a la última acción' : 'Ver último paso'}
          </button>
        )}
        {isTerminal(attempt.status) && (
          <button
            className="secondary-button"
            type="button"
            onClick={onConfiguration}
            disabled={busy || configurationBusy}
          >
            {configurationBusy ? 'Cargando configuración…' : 'Ver configuración'}
          </button>
        )}
      </div>
      {sharingVisible && <ResultSharing key={attempt.id} attempt={attempt} disabled={busy} />}
      {attempt.status === 'victory' && (
        <details className="attempt-score-breakdown">
          <summary>Desglose del puntaje</summary>
          <dl>
            <div>
              <dt>Base</dt>
              <dd>+{DEFAULT_SCORE_RULES.base.toLocaleString('es-AR')} puntos</dd>
            </div>
            <div>
              <dt>Objetos recogidos</dt>
              <dd>+{attempt.objectPoints.toLocaleString('es-AR')} puntos</dd>
            </div>
            <div>
              <dt>
                Descuento por turnos ({attempt.turnsUsed} x {DEFAULT_SCORE_RULES.turnWeight})
              </dt>
              <dd>
                -{(DEFAULT_SCORE_RULES.turnWeight * attempt.turnsUsed).toLocaleString('es-AR')}{' '}
                puntos
              </dd>
            </div>
            <div>
              <dt>
                Descuento por tokens (
                {attempt.gameTokens === null
                  ? 'desconocido'
                  : `${attempt.gameTokens.toLocaleString('es-AR')} / ${DEFAULT_SCORE_RULES.tokenUnit.toLocaleString('es-AR')}`}
                )
              </dt>
              <dd>
                {tokenPenalty === null
                  ? 'desconocido'
                  : `-${tokenPenalty.toLocaleString('es-AR', { maximumFractionDigits: 3 })} puntos`}
              </dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>
                {attempt.score === null ? 'desconocido' : `${formatScore(attempt.score)} puntos`}
              </dd>
            </div>
          </dl>
          <p className="attempt-score-rounding-note">
            El total guardado se expresa con {DEFAULT_SCORE_RULES.decimalPlaces} decimales.
          </p>
        </details>
      )}
      <details className="attempt-agent-details">
        <summary>Detalles del agente</summary>
        <p className="attempt-status" data-status={attempt.status}>
          {attempt.recordComplete ? 'Registro completo' : 'Registro incompleto'}
        </p>
        <p className="attempt-token-help">
          Tokens: unidades de texto procesadas por el modelo; pueden ser desconocidas según el
          proveedor.
        </p>
        <dl className="attempt-metrics">
          <div>
            <dt>Modelo</dt>
            <dd>{attempt.modelLabel}</dd>
          </div>
          <div>
            <dt>Nivel</dt>
            <dd>{attempt.levelId}</dd>
          </div>
          {technicalError && (
            <div>
              <dt>Error técnico</dt>
              <dd>{technicalError}</dd>
            </div>
          )}
          <div>
            <dt>Llamadas</dt>
            <dd>{attempt.calls}</dd>
          </div>
          <div>
            <dt>Tokens usados para puntaje</dt>
            <dd>{formatMetric(attempt.gameTokens)}</dd>
          </div>
          <div>
            <dt>Entrada</dt>
            <dd>{formatMetric(attempt.inputTokens)}</dd>
          </div>
          <div>
            <dt>Salida</dt>
            <dd>{formatMetric(attempt.outputTokens)}</dd>
          </div>
          <div>
            <dt>Razonamiento (incluido en salida)</dt>
            <dd>{formatMetric(attempt.reasoningTokens)}</dd>
          </div>
          <div>
            <dt>Caché leída</dt>
            <dd>{formatMetric(attempt.cacheReadTokens)}</dd>
          </div>
          <div>
            <dt>Caché escrita</dt>
            <dd>{formatMetric(attempt.cacheWriteTokens)}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

export function HistoryResultQuery({
  state,
  sharingVisible,
  onRetry,
  onClose,
  onReturnToEditor,
  onReplay,
  onInspect,
  onConfiguration,
  configurationBusy,
  busy,
}: {
  state: AttemptResultQueryState;
  sharingVisible: boolean;
  onRetry: () => void;
  onClose: () => void;
  onReturnToEditor: () => void;
  onReplay: (attemptId: string) => void;
  onInspect: (attempt: AttemptSummary, selection: DecisionInitialSelection) => void;
  onConfiguration: (attempt: AttemptSummary) => void;
  configurationBusy: boolean;
  busy: boolean;
}) {
  const title =
    state.status === 'loading'
      ? 'Consultando el resultado guardado…'
      : state.status === 'error'
        ? 'No se pudo abrir el resultado'
        : statusLabel(state.attempt.status);

  return (
    <section className="attempt-result-query" aria-labelledby="history-result-loading-title">
      <h3 id="history-result-loading-title" tabIndex={-1}>
        {title}
      </h3>
      {state.status === 'ready' ? (
        <ResultContext source="history" createdAt={state.attempt.createdAt} />
      ) : (
        state.contextAttempt && (
          <ResultContext source="history" createdAt={state.contextAttempt.createdAt} />
        )
      )}
      {state.status !== 'ready' && (
        <div className="attempt-result-back">
          <button
            className="text-button attempt-result-history-return"
            type="button"
            onClick={onClose}
          >
            Volver al historial
          </button>
        </div>
      )}
      {state.status === 'loading' && (
        <p className="attempt-message" role="status">
          Cargando el intento seleccionado del historial.
        </p>
      )}
      {state.status === 'error' && (
        <div className="attempt-error" role="alert">
          <p>{state.message}</p>
          <button className="secondary-button" type="button" onClick={onRetry}>
            Reintentar consulta
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <ResultCard
          attempt={state.attempt}
          sharingVisible={sharingVisible}
          source="history"
          createdAt={state.attempt.createdAt}
          onReplay={() => onReplay(state.attempt.id)}
          onInspect={(selection) => onInspect(state.attempt, selection)}
          onConfiguration={() => onConfiguration(state.attempt)}
          onReturnToEditor={onReturnToEditor}
          onReturnToHistory={onClose}
          configurationBusy={configurationBusy}
          busy={busy}
          headingId="history-result-loading-title"
          showHeading={false}
          showContext={false}
        />
      )}
    </section>
  );
}

export function HistoryList({
  attempts,
  view,
  nextCursor,
  error,
  loading,
  busy,
  onOpen,
  onReplay,
  onInspect,
  onConfiguration,
  configurationBusyId,
  onMore,
  onRetry,
  onSelectView,
  onPrepare,
}: {
  attempts: readonly AttemptSummary[];
  view: HistoryView;
  nextCursor?: string;
  error: string | null;
  loading: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onReplay: (id: string) => void;
  onInspect?: (id: string, initialSelection: DecisionInitialSelection) => void;
  onConfiguration: (attempt: AttemptSummary) => void;
  configurationBusyId: string | null;
  onMore: () => void;
  onRetry: () => void;
  onSelectView: (view: HistoryView) => void;
  onPrepare?: () => void;
}) {
  const ranked = comparableVictories(attempts);
  const visibleAttempts = view === 'best' ? ranked : attempts;
  return (
    <section className="attempt-history" aria-labelledby="attempt-history-title">
      <div className="attempt-section-heading">
        <div>
          <p className="card-kicker">Tus recorridos</p>
          <h3 id="attempt-history-title" tabIndex={-1}>
            Historial
          </h3>
        </div>
        {(attempts.length > 0 || (!loading && error === null)) && (
          <span className="history-count">
            {formatHistoryScope(attempts.length, nextCursor !== undefined)}
          </span>
        )}
      </div>
      {error && (
        <div className="attempt-error" role="alert">
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={onRetry} disabled={busy}>
            Reintentar historial
          </button>
        </div>
      )}
      <div className="history-view-toggle" role="group" aria-label="Vista del historial">
        <button
          className="history-view-button"
          type="button"
          aria-pressed={view === 'recent'}
          onClick={() => onSelectView('recent')}
        >
          Recientes
        </button>
        <button
          className="history-view-button"
          type="button"
          aria-pressed={view === 'best'}
          onClick={() => onSelectView('best')}
        >
          Mejores
        </button>
      </div>
      {view === 'best' && (
        <div className="history-best-context">
          <p>
            {ranked.length} {ranked.length === 1 ? 'victoria comparable' : 'victorias comparables'}
          </p>
          <details className="history-methodology">
            <summary>Cómo se comparan</summary>
            <p>
              Sólo incluye victorias con registro completo y puntaje conocido del nivel vigente de
              las páginas cargadas. Los puntos ordenan de mayor a menor y los empates conservan la
              misma posición. La comparación usa los tokens de juego registrados; cada modelo puede
              contar tokens con un tokenizador distinto.
            </p>
          </details>
        </div>
      )}
      {loading && attempts.length === 0 && error === null ? (
        <p className="attempt-message" role="status">
          Recuperando tus intentos…
        </p>
      ) : attempts.length === 0 && !loading && error === null ? (
        <div className="history-empty">
          <p>Todavía no hay intentos guardados.</p>
          <button
            className="primary-button"
            type="button"
            aria-label="Preparar un robot"
            onClick={onPrepare}
          >
            Preparar
          </button>
        </div>
      ) : view === 'best' && attempts.length > 0 && ranked.length === 0 ? (
        <p className="history-empty">
          Todavía no hay victorias comparables entre los intentos cargados.
        </p>
      ) : (
        <ul className="history-list">
          {visibleAttempts.map((item, index) => (
            <li key={item.id} data-history-row-id={item.id}>
              <div className="history-metadata">
                <div className="history-row-heading">
                  <strong>{statusLabel(item.status)}</strong>
                  <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                </div>
                <span>
                  {view === 'best' ? `#${rankFor(ranked, index)}, ` : ''}
                  {item.status === 'victory'
                    ? item.score === null
                      ? 'Puntaje desconocido'
                      : `Puntaje: ${formatMetric(item.score)} puntos`
                    : `Avance: ${formatProgress(item.progress)}`}
                </span>
                <span>
                  {item.turnsUsed} / {item.maxTurns} turnos
                </span>
              </div>
              <div className="history-row-actions">
                <button
                  className="primary-button history-open-button"
                  type="button"
                  data-history-attempt-id={item.id}
                  data-history-action="open"
                  onClick={() => onOpen(item.id)}
                  disabled={busy}
                >
                  Abrir
                </button>
                {isTerminal(item.status) && (
                  <details className="history-actions-disclosure">
                    <summary>Más acciones</summary>
                    <div className="history-actions">
                      {item.recordComplete && item.turnsUsed > 0 && (
                        <button
                          className="secondary-button"
                          type="button"
                          data-history-attempt-id={item.id}
                          data-history-action="replay"
                          onClick={() => onReplay(item.id)}
                          disabled={busy}
                        >
                          Ver de nuevo
                        </button>
                      )}
                      {item.recordComplete && item.presentationComplete && onInspect && (
                        <>
                          <button
                            className="secondary-button"
                            type="button"
                            data-history-attempt-id={item.id}
                            data-history-action="inspect"
                            onClick={() => onInspect(item.id, 'first')}
                            disabled={busy}
                          >
                            Inspeccionar decisiones
                          </button>
                          {item.status !== 'victory' && (
                            <button
                              className="secondary-button"
                              type="button"
                              data-history-attempt-id={item.id}
                              data-history-action="inspect-last"
                              onClick={() =>
                                onInspect(
                                  item.id,
                                  item.status === 'defeat'
                                    ? 'last-action-or-decision'
                                    : 'last-decision',
                                )
                              }
                              disabled={busy}
                            >
                              {item.status === 'defeat'
                                ? 'Ir a la última acción'
                                : 'Ver último paso'}
                            </button>
                          )}
                        </>
                      )}
                      <button
                        className="secondary-button"
                        type="button"
                        data-history-attempt-id={item.id}
                        data-history-action="configuration"
                        onClick={() => onConfiguration(item)}
                        disabled={busy || configurationBusyId === item.id}
                      >
                        {configurationBusyId === item.id
                          ? 'Cargando configuración…'
                          : 'Ver configuración'}
                      </button>
                    </div>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <button
          className="secondary-button history-load-more"
          type="button"
          onClick={onMore}
          disabled={busy}
        >
          Cargar 20 más
        </button>
      )}
    </section>
  );
}

export function ConfigurationPreview({
  state,
  busy,
  configurationAvailable,
  onApply,
  onRetry,
  onClose,
}: {
  state: {
    readonly targetId: string;
    readonly displayContext?: AttemptDisplayContext;
    readonly status: 'loading' | 'ready' | 'applying' | 'error';
    readonly configuration?: AttemptConfiguration;
    readonly message?: string;
    readonly applied?: boolean;
  };
  busy: boolean;
  configurationAvailable: boolean;
  onApply: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.status === 'loading') headingRef.current?.focus();
  }, [state.status, state.targetId]);
  return (
    <section className="attempt-configuration" aria-labelledby="attempt-configuration-title">
      <div className="attempt-section-heading">
        <div>
          <p className="card-kicker">Configuración fijada</p>
          <h3 id="attempt-configuration-title" ref={headingRef} tabIndex={-1}>
            Configuración del intento
          </h3>
        </div>
        <button className="text-button" type="button" onClick={onClose} disabled={busy}>
          Cerrar
        </button>
      </div>
      {state.displayContext && (
        <ResultContext
          source={state.displayContext.source}
          createdAt={state.displayContext.createdAt}
        />
      )}
      <p className="configuration-attempt-id">Intento: {state.targetId}</p>
      {state.status === 'loading' && (
        <p className="attempt-message" role="status">
          Cargando la configuración guardada…
        </p>
      )}
      {state.status === 'error' && state.message && (
        <div className="attempt-error" role="alert">
          <p>{state.message}</p>
          {!state.configuration && (
            <button className="secondary-button" type="button" onClick={onRetry} disabled={busy}>
              Reintentar carga
            </button>
          )}
        </div>
      )}
      {state.configuration && (
        <>
          <dl className="configuration-facts">
            <div>
              <dt>Modelo</dt>
              <dd>{modelLabel(state.configuration.draft.modelKey)}</dd>
            </div>
            <div>
              <dt>Habilidades activas</dt>
              <dd>
                {state.configuration.draft.skills
                  .filter((skill) => skill.enabled)
                  .map(
                    (skill) =>
                      ROBOT_CATALOG.find((entry) => entry.id === skill.id)?.name ??
                      'Habilidad no disponible',
                  )
                  .join(', ') || 'ninguna'}
              </dd>
            </div>
          </dl>
          <div className="configuration-preview-copy">
            <h4>Instrucciones generales</h4>
            <p>{state.configuration.draft.instructions || 'Sin instrucciones.'}</p>
            <h4>Habilidades y descripciones guardadas</h4>
            <ul>
              {state.configuration.draft.skills.map((skill) =>
                (() => {
                  const entry = ROBOT_CATALOG.find((candidate) => candidate.id === skill.id);
                  const description =
                    skill.description === undefined
                      ? 'omitida'
                      : skill.description === ''
                        ? 'vacía'
                        : skill.description;
                  return (
                    <li key={skill.id}>
                      <strong>{entry?.name ?? 'Habilidad no disponible'}</strong>,{' '}
                      {skill.enabled ? 'enviada al agente' : 'no enviada al agente'}, descripción:{' '}
                      {description}
                    </li>
                  );
                })(),
              )}
            </ul>
          </div>
          {state.applied && (
            <p className="configuration-applied" role="status">
              Configuración cargada en el editor. Se guarda como una edición normal.
            </p>
          )}
          <button
            className="primary-button"
            type="button"
            onClick={onApply}
            disabled={busy || state.status === 'applying' || !configurationAvailable}
          >
            {state.status === 'applying' ? 'Aplicando configuración…' : 'Usar esta configuración'}
          </button>
        </>
      )}
    </section>
  );
}
