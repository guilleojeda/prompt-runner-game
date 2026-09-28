import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LEVEL, type LevelSegment } from '../../../shared/game.js';
import { ROBOT_CATALOG, type RobotCatalogEntry, type RobotSkillId } from '../../../shared/robot.js';
import {
  AttemptApiFailure,
  type AttemptApi,
  type DecisionAvailableAction,
  type DecisionChoice,
  type DecisionDetail,
  type DecisionIndex,
  type DecisionIndexItem,
  type DecisionObservation,
  type DecisionObservationSide,
  type DecisionResult,
} from './attempt-api.js';

interface DecisionInspectorProps {
  readonly api: AttemptApi;
  readonly attemptId: string;
  readonly targetLabel?: string;
  readonly onAuthRequired?: () => void;
  readonly onClose: () => void;
}

const catalogByOpaqueId = new Map(ROBOT_CATALOG.map((entry) => [entry.opaqueId, entry]));
const catalogBySkillId = new Map(ROBOT_CATALOG.map((entry) => [entry.id, entry]));

const terrainLabel = (terrain: string): string => {
  switch (terrain) {
    case 'ground':
      return 'suelo';
    case 'pit':
      return 'pozo';
    case 'branch':
      return 'rama';
    case 'barrier_low':
      return 'barrera baja';
    case 'barrier_high':
      return 'barrera alta';
    default:
      return terrain;
  }
};

const sideLabel = (side: DecisionObservationSide): string => {
  if (side.kind === 'boundary') return 'límite del recorrido';
  if (side.kind === 'door') {
    const state = side.state === 'open' ? 'puerta abierta' : 'puerta cerrada';
    return `${state}; requiere ${objectLabel(side.requiredObjectId)}`;
  }
  if (side.kind === 'segment' && side.terrain) return terrainLabel(side.terrain);
  return side.kind;
};

const objectLabel = (id: string): string => {
  const object = LEVEL.objects.find((entry) => entry.id === id);
  if (!object) return id;
  return object.id === 'llave-1' ? 'llave' : 'recompensa';
};

const humanEntryFor = (action: {
  readonly opaqueId?: string;
  readonly kind?: string;
}): RobotCatalogEntry | undefined => {
  if (action.opaqueId) return catalogByOpaqueId.get(action.opaqueId);
  if (action.kind) return catalogBySkillId.get(action.kind as RobotSkillId);
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const directionLabel = (direction: string): string => {
  if (direction === 'left') return 'izquierda';
  if (direction === 'right') return 'derecha';
  return direction;
};

const actionText = (
  action: unknown,
  opaqueId?: string,
  options?: { readonly showInternalDirection?: boolean },
): string => {
  if (!isRecord(action)) {
    const catalogEntry = opaqueId ? catalogByOpaqueId.get(opaqueId) : undefined;
    return catalogEntry ? `${catalogEntry.opaqueId} (${catalogEntry.name})` : 'Acción registrada';
  }
  const id = typeof action.opaqueId === 'string' ? action.opaqueId : opaqueId;
  const catalogEntry = id ? catalogByOpaqueId.get(id) : undefined;
  const kind = typeof action.kind === 'string' ? action.kind : undefined;
  const kindEntry = kind ? humanEntryFor({ kind }) : undefined;
  const label = catalogEntry?.name ?? kindEntry?.name ?? 'Acción registrada';
  const identifier = id ?? catalogEntry?.opaqueId;
  const parameters: string[] = [];
  if (options?.showInternalDirection && typeof action.direction === 'string') {
    parameters.push(`dirección: ${directionLabel(action.direction)}`);
  }
  return `${identifier ? `${identifier} (${label})` : label}${
    parameters.length > 0 ? ` · ${parameters.join(' · ')}` : ''
  }`;
};

const resolutionLabel = (resolution: unknown): string | null => {
  if (!isRecord(resolution)) return null;
  const parts: string[] = [];
  if (typeof resolution.outcome === 'string') {
    const outcome: Record<string, string> = {
      moved: 'se movió',
      no_op: 'no produjo cambios',
      fall: 'terminó en una caída',
      collision: 'terminó en una colisión',
      picked_up: 'recogió un objeto',
    };
    parts.push(outcome[resolution.outcome] ?? resolution.outcome);
  }
  if (typeof resolution.reason === 'string') {
    const reason: Record<string, string> = {
      moved: 'movimiento válido',
      left_boundary: 'límite izquierdo',
      right_boundary: 'límite derecho',
      swim_no_effect: 'nadar no produce efecto',
      wait: 'espera',
      no_object_here: 'no había un objeto en la casilla',
      door_locked: 'la puerta estaba cerrada',
      walk_into_pit: 'pozo',
      crouch_into_pit: 'pozo',
      walk_into_branch: 'rama',
      jump_into_branch: 'rama',
      walk_into_barrier: 'barrera',
      crouch_into_low_barrier: 'barrera baja',
      jump_into_high_barrier: 'barrera alta',
    };
    parts.push(reason[resolution.reason] ?? resolution.reason);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
};

const segmentLabel = (segment: LevelSegment | undefined): string => {
  if (!segment) return 'recorrido';
  switch (segment.type) {
    case 'pit':
      return 'pozo';
    case 'branch':
      return 'rama';
    case 'barrier':
      return 'barrera periódica';
    case 'platform':
      return 'plataforma periódica';
    default:
      return 'suelo';
  }
};

const observationText = (observation: DecisionObservation | null): string[] => {
  if (!observation) return ['Observación no disponible en el registro.'];
  const here = observation.here.objects.length
    ? observation.here.objects.map(objectLabel).join(', ')
    : 'sin objetos';
  return [
    `Orientación: ${observation.facing === 'right' ? 'derecha' : 'izquierda'}.`,
    `Casilla actual: ${here}${observation.here.exit ? '; salida visible' : ''}.`,
    `A la izquierda: ${sideLabel(observation.left)}.`,
    `A la derecha: ${sideLabel(observation.right)}.`,
  ];
};

const hasMeaningfulParameters = (parameters: unknown): boolean => {
  if (isRecord(parameters)) return Object.keys(parameters).length > 0;
  if (Array.isArray(parameters)) return parameters.length > 0;
  return parameters !== undefined && parameters !== null;
};

const actionResultText = (result: DecisionResult, choice: DecisionChoice | null): string[] => {
  if (result.kind === 'no-action') {
    const details = [
      'No se ejecutó ninguna acción y no se consumió turno.',
      ...(result.reason ? [`Motivo registrado: ${result.reason}.`] : []),
      ...(result.status ? [`Cierre: ${result.status}.`] : []),
    ];
    return details;
  }
  const recordedAction = actionText(result.action, undefined, { showInternalDirection: true });
  const details = [
    ...(choice?.state === 'unknown' && recordedAction !== 'Acción registrada'
      ? [`Acción registrada: ${recordedAction}.`]
      : []),
    ...(resolutionLabel(result.resolution)
      ? [`Resolución: ${resolutionLabel(result.resolution)}.`]
      : []),
    ...(result.afterSupport === undefined ? [] : [`Terminó en el apoyo ${result.afterSupport}.`]),
    ...(result.turnsUsed === undefined ? [] : [`Consumió el turno ${result.turnsUsed}.`]),
  ];
  return details;
};

const errorText = (error: unknown): string => {
  if (error instanceof AttemptApiFailure) return error.message;
  return 'No se pudo cargar la inspección. Podés reintentar.';
};

const mapSupportLabel = (
  support: number,
  count: number,
  location: string,
  object: string | null,
  door: boolean,
): string => {
  const features = [location, ...(object ? [object] : []), ...(door ? ['puerta'] : [])];
  const decisionCount =
    count > 0 ? `${count} ${count === 1 ? 'decisión' : 'decisiones'}` : 'sin decisiones';
  return `Casilla ${support}, ${features.join(', ')}, ${decisionCount}`;
};

function StaticLevelMap({
  index,
  selectedSupport,
  onSelect,
}: {
  readonly index: DecisionIndex;
  readonly selectedSupport: number | null;
  readonly onSelect: (support: number) => void;
}) {
  const counts = useMemo(() => {
    const next = new Map<number, number>();
    for (const item of index.decisions) {
      next.set(item.originSupport, (next.get(item.originSupport) ?? 0) + 1);
    }
    return next;
  }, [index.decisions]);
  return (
    <div className="decision-map" role="group" aria-label="Mapa estático del recorrido">
      {Array.from({ length: LEVEL.segments.length + 1 }, (_, support) => {
        const count = counts.get(support) ?? 0;
        const marker = support === 0 ? 'Inicio' : support === LEVEL.exit.support ? 'Salida' : null;
        const object = LEVEL.objects.find((entry) => entry.support === support);
        const door = LEVEL.door?.support === support;
        const location = marker ?? segmentLabel(LEVEL.segments[support - 1]);
        return (
          <button
            className={`decision-map-cell${selectedSupport === support ? ' is-selected' : ''}${
              count > 0 ? ' has-decisions' : ''
            }`}
            key={support}
            type="button"
            aria-pressed={selectedSupport === support}
            aria-label={mapSupportLabel(
              support,
              count,
              location,
              object ? objectLabel(object.id) : null,
              door,
            )}
            onClick={() => onSelect(support)}
          >
            <span className="decision-map-cell-number">{support}</span>
            <span className="decision-map-cell-name">{location}</span>
            {object && <span className="decision-map-cell-object">{objectLabel(object.id)}</span>}
            {door && <span className="decision-map-cell-door">puerta</span>}
            <span className="decision-map-cell-count">
              {count > 0 ? `${count} ${count === 1 ? 'decisión' : 'decisiones'}` : 'sin decisiones'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DecisionCard({
  item,
  selected,
  onSelect,
}: {
  readonly item: DecisionIndexItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button
        className={`decision-list-item${selected ? ' is-selected' : ''}`}
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span>Decisión {item.number}</span>
        <span>
          Casilla {item.originSupport} · {item.hasAction ? 'con acción' : 'sin acción'}
        </span>
      </button>
    </li>
  );
}

function DecisionDetailCard({ detail }: { readonly detail: DecisionDetail | null }) {
  if (!detail) {
    return (
      <div className="decision-detail-empty" role="status">
        Elegí una decisión para ver su ficha.
      </div>
    );
  }
  const choice = detail.choice;
  const selectedChoice = choice?.state === 'selected';
  const choiceText = !choice
    ? 'No hubo una elección registrada.'
    : choice.state === 'invalid'
      ? 'La elección registrada fue inválida.'
      : choice.state === 'unknown'
        ? 'No se conoce la elección registrada.'
        : `Elección válida: ${actionText(choice.action, choice.opaqueId)}.`;
  const available = detail.availableActions;
  return (
    <section className="decision-detail" aria-label={`Ficha de decisión ${detail.item.number}`}>
      <h4 className="decision-detail-heading">
        Decisión {detail.item.number} · Casilla {detail.item.originSupport}
      </h4>
      <div className="decision-fact">
        <h4>Observación</h4>
        <div className="decision-fact-copy">
          {observationText(detail.observation).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
      <div className="decision-fact">
        <h4>Acciones disponibles</h4>
        {available === null ? (
          <p>Acciones no disponibles en el registro.</p>
        ) : available.length === 0 ? (
          <p>No había acciones disponibles.</p>
        ) : (
          <ul className="decision-action-list">
            {available.map((action: DecisionAvailableAction) => {
              const entry = humanEntryFor(action);
              const label = entry?.name ?? action.label;
              const description =
                action.description === undefined
                  ? 'Descripción omitida.'
                  : action.description === ''
                    ? 'Descripción vacía.'
                    : action.description;
              return (
                <li key={action.opaqueId}>
                  <strong>
                    {action.opaqueId} ({label})
                  </strong>
                  <span>{description}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="decision-fact">
        <h4>Acción elegida</h4>
        <p>{choiceText}</p>
        {selectedChoice &&
          choice.parameters !== undefined &&
          hasMeaningfulParameters(choice.parameters) && (
            <p className="decision-parameters">Parámetros: {JSON.stringify(choice.parameters)}</p>
          )}
      </div>
      <div className="decision-fact">
        <h4>Resultado</h4>
        <div className="decision-fact-copy">
          {actionResultText(detail.result, detail.choice).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
    </section>
  );
}

export function DecisionInspector({
  api,
  attemptId,
  targetLabel,
  onAuthRequired,
  onClose,
}: DecisionInspectorProps) {
  const [index, setIndex] = useState<DecisionIndex | null>(null);
  const [selectedSupport, setSelectedSupport] = useState<number | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [loadingIndex, setLoadingIndex] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const indexRequestRef = useRef(0);
  const indexControllerRef = useRef<AbortController | null>(null);

  const loadIndex = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const requestId = ++indexRequestRef.current;
      const ownedController = signal ? null : new AbortController();
      if (ownedController) {
        indexControllerRef.current?.abort();
        indexControllerRef.current = ownedController;
      }
      const requestSignal = signal ?? ownedController?.signal;
      setLoadingIndex(true);
      setError(null);
      try {
        const loaded = await api.getDecisionIndex(attemptId, requestSignal);
        if (requestSignal?.aborted || indexRequestRef.current !== requestId) return;
        if (loaded.attemptId !== attemptId || loaded.levelId !== LEVEL.id) {
          throw new AttemptApiFailure('server', 'El índice no coincide con el intento abierto.');
        }
        setIndex(loaded);
        const first = loaded.decisions[0];
        setSelectedSupport(first?.originSupport ?? null);
        setSelectedNumber(first?.number ?? null);
        setDetail(null);
        setDetailRetry((value) => value + 1);
      } catch (loadError) {
        if (requestSignal?.aborted || indexRequestRef.current !== requestId) return;
        if (loadError instanceof AttemptApiFailure && loadError.code === 'authentication') {
          onAuthRequired?.();
        }
        setError(errorText(loadError));
      } finally {
        if (indexRequestRef.current === requestId && !requestSignal?.aborted) {
          if (ownedController && indexControllerRef.current === ownedController) {
            indexControllerRef.current = null;
          }
          setLoadingIndex(false);
        }
      }
    },
    [api, attemptId, onAuthRequired],
  );

  const loadDecision = useCallback(
    async (number: number, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) return;
      setLoadingDetail(true);
      setDetailError(null);
      try {
        const loaded = await api.getDecision(attemptId, number, signal);
        if (signal.aborted) return;
        if (
          loaded.attemptId !== attemptId ||
          loaded.levelId !== LEVEL.id ||
          loaded.item.number !== number
        ) {
          setDetailError('La ficha recibida no coincide con la decisión elegida.');
          return;
        }
        setDetail(loaded);
      } catch (loadError: unknown) {
        if (signal.aborted) return;
        if (loadError instanceof AttemptApiFailure && loadError.code === 'authentication') {
          onAuthRequired?.();
        }
        setDetailError(errorText(loadError));
        setDetail(null);
      } finally {
        if (!signal.aborted) setLoadingDetail(false);
      }
    },
    [api, attemptId, onAuthRequired],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadIndex(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      indexRequestRef.current += 1;
      indexControllerRef.current?.abort();
      indexControllerRef.current = null;
    };
  }, [loadIndex]);

  useEffect(() => {
    if (!selectedNumber) {
      return undefined;
    }
    const controller = new AbortController();
    const number = selectedNumber;
    void Promise.resolve().then(() => loadDecision(number, controller.signal));
    return () => {
      controller.abort();
    };
  }, [detailRetry, loadDecision, selectedNumber]);

  const bySupport = useMemo(
    () => index?.decisions.filter((item) => item.originSupport === selectedSupport) ?? [],
    [index, selectedSupport],
  );
  const selectSupport = (support: number): void => {
    setSelectedSupport(support);
    const first = index?.decisions.find((item) => item.originSupport === support);
    setSelectedNumber(first?.number ?? null);
    setDetail(null);
    setDetailError(null);
  };
  const selectDecision = (item: DecisionIndexItem): void => {
    setSelectedSupport(item.originSupport);
    setSelectedNumber(item.number);
    setDetail(null);
    setDetailError(null);
  };

  return (
    <section className="decision-inspector" aria-labelledby="decision-inspector-title">
      <div className="decision-inspector-heading">
        <div>
          <p className="card-kicker">Mapa para el jugador</p>
          <h3 id="decision-inspector-title">Inspeccionar decisiones</h3>
          {targetLabel && (
            <p className="decision-inspector-target">Intento inspeccionado: {targetLabel}</p>
          )}
          <p>Consultá las decisiones guardadas del recorrido sin volver a ejecutarlo.</p>
        </div>
        <button className="secondary-button" type="button" onClick={onClose}>
          Cerrar inspección
        </button>
      </div>
      {loadingIndex && (
        <p className="attempt-message" role="status">
          Cargando el mapa de decisiones…
        </p>
      )}
      {error && (
        <div className="attempt-error" role="alert">
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={() => void loadIndex()}>
            Reintentar inspección
          </button>
        </div>
      )}
      {!loadingIndex && !error && index && (
        <>
          <StaticLevelMap
            index={index}
            selectedSupport={selectedSupport}
            onSelect={selectSupport}
          />
          {index.decisions.length === 0 ? (
            <p className="decision-inspector-empty" role="status">
              Este intento no tiene decisiones guardadas para inspeccionar.
            </p>
          ) : (
            <div className="decision-inspector-columns">
              <div className="decision-inspector-lists">
                <section aria-labelledby="decision-support-title">
                  <h4 id="decision-support-title">
                    {selectedSupport === null
                      ? 'Decisiones por casilla'
                      : `Decisiones en la casilla ${selectedSupport}`}
                  </h4>
                  <ol className="decision-list">
                    {bySupport.map((item) => (
                      <DecisionCard
                        item={item}
                        key={item.number}
                        selected={selectedNumber === item.number}
                        onSelect={() => selectDecision(item)}
                      />
                    ))}
                  </ol>
                  {bySupport.length === 0 && <p>No hay decisiones en esta casilla.</p>}
                </section>
                <section aria-labelledby="decision-all-title">
                  <h4 id="decision-all-title">Todas las decisiones, en orden</h4>
                  <ol className="decision-list">
                    {index.decisions.map((item) => (
                      <DecisionCard
                        item={item}
                        key={item.number}
                        selected={selectedNumber === item.number}
                        onSelect={() => selectDecision(item)}
                      />
                    ))}
                  </ol>
                </section>
              </div>
              <div className="decision-detail-wrap">
                {loadingDetail && (
                  <p className="attempt-message" role="status">
                    Cargando la ficha…
                  </p>
                )}
                {detailError && (
                  <div className="attempt-error" role="alert">
                    <p>{detailError}</p>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => setDetailRetry((value) => value + 1)}
                    >
                      Reintentar ficha
                    </button>
                  </div>
                )}
                {!loadingDetail && !detailError && <DecisionDetailCard detail={detail} />}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
