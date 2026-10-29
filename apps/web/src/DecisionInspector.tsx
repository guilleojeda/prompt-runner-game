import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LEVEL, type LevelSegment } from '../../../shared/game.js';
import { ROBOT_CATALOG, type RobotCatalogEntry, type RobotSkillId } from '../../../shared/robot.js';
import {
  AttemptApiFailure,
  classifyAttemptReadFailure,
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
import type { ApiAuthRequired } from './api-auth.js';
import { useReadRecovery, type ReadResource } from './useReadRecovery.js';

interface DecisionDetailResource extends ReadResource {
  readonly decisionNumber: number;
}

interface DecisionInspectorProps {
  readonly api: AttemptApi;
  readonly attemptId: string;
  readonly identity?: string;
  readonly surface?: string;
  readonly active?: boolean;
  readonly authPaused?: boolean;
  readonly targetLabel?: string;
  readonly initialSelection?: 'first' | 'last-action-or-decision' | 'last-decision';
  readonly onAuthRequired?: ApiAuthRequired;
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

const actionText = (action: unknown, opaqueId?: string, parameters?: unknown): string => {
  if (!isRecord(action)) {
    const catalogEntry = opaqueId ? catalogByOpaqueId.get(opaqueId) : undefined;
    return catalogEntry?.name ?? 'Acción registrada';
  }
  const id = typeof action.opaqueId === 'string' ? action.opaqueId : opaqueId;
  const catalogEntry = id ? catalogByOpaqueId.get(id) : undefined;
  const kind = typeof action.kind === 'string' ? action.kind : undefined;
  const kindEntry = kind ? humanEntryFor({ kind }) : undefined;
  const label = catalogEntry?.name ?? kindEntry?.name ?? 'Acción registrada';
  const parameterDirection = isRecord(parameters) ? parameters.direction : undefined;
  const direction =
    typeof action.direction === 'string'
      ? action.direction
      : typeof parameterDirection === 'string'
        ? parameterDirection
        : undefined;
  return `${label}${direction ? `, dirección: ${directionLabel(direction)}` : ''}`;
};

interface DecisionLiteralData {
  readonly labels: string[];
  readonly json: string;
}

const literalDecisionData = (detail: DecisionDetail): DecisionLiteralData[] => {
  const choice = detail.choice;
  const values: Array<{ readonly label: string; readonly value: unknown }> = [
    ...(choice?.state === 'selected'
      ? [
          { label: 'Acción de la elección', value: choice.action },
          { label: 'Parámetros de la elección', value: choice.parameters },
        ]
      : choice?.state === 'invalid' && choice.parameters !== undefined
        ? [{ label: 'Parámetros de la elección', value: choice.parameters }]
        : []),
    ...(detail.result.kind === 'action'
      ? [
          { label: 'Acción registrada', value: detail.result.action },
          { label: 'Resolución registrada', value: detail.result.resolution },
        ]
      : []),
  ];
  const entries = new Map<string, DecisionLiteralData>();
  for (const { label, value } of values) {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) continue;
    const existing = entries.get(json);
    if (existing) existing.labels.push(label);
    else entries.set(json, { labels: [label], json });
  }
  return [...entries.values()];
};

const resolutionLabel = (resolution: unknown): string | null => {
  if (!isRecord(resolution)) return null;
  const parts: string[] = [];
  if (typeof resolution.outcome === 'string') {
    const outcome: Record<string, string> = {
      moved: 'se movió',
      no_op: 'el robot permaneció en la misma casilla',
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
      swim_no_effect: 'nadar mantuvo al robot en la misma casilla',
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
  return parts.length > 0 ? parts.join(', ') : null;
};

const initialDecision = (
  index: DecisionIndex,
  selection: 'first' | 'last-action-or-decision' | 'last-decision',
): DecisionIndexItem | undefined => {
  if (selection === 'first') return index.decisions[0];
  if (selection === 'last-decision') return index.decisions[index.decisions.length - 1];
  for (let position = index.decisions.length - 1; position >= 0; position -= 1) {
    const item = index.decisions[position];
    if (item?.hasAction) return item;
  }
  return index.decisions[index.decisions.length - 1];
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

const resultCodeLabel = (code: string): string => {
  const labels: Record<string, string> = {
    invalid_input: 'entrada inválida',
    invalid_response: 'respuesta inválida',
    provider_error: 'error del proveedor',
    audit_failed: 'falló la auditoría de la llamada',
    incomplete_response: 'respuesta incompleta',
    truncated: 'respuesta truncada',
    timeout: 'tiempo de espera agotado',
    throttled: 'proveedor saturado',
    request_not_persisted: 'solicitud no conservada',
    cancelled_before_action: 'cancelación antes de ejecutar una acción',
    cancelled_by_user: 'cancelación solicitada',
    cancelled_during_retry: 'cancelación durante un reintento',
    runtime_deadline_exceeded: 'se agotó el tiempo de ejecución',
    runtime_deadline_expired: 'se agotó el tiempo de ejecución',
    start_deadline_expired: 'se agotó el tiempo de inicio',
    cancelled: 'cancelado',
    incomplete: 'incompleto',
    error: 'error',
  };
  return labels[code] ?? 'motivo técnico no detallado';
};

const actionResultText = (result: DecisionResult, choice: DecisionChoice | null): string[] => {
  if (result.kind === 'no-action') {
    const details = [
      'No se ejecutó ninguna acción y no se consumió turno.',
      ...(result.reason ? [`Motivo registrado: ${resultCodeLabel(result.reason)}.`] : []),
      ...(result.status ? [`Cierre: ${resultCodeLabel(result.status)}.`] : []),
    ];
    return details;
  }
  const recordedAction = actionText(result.action);
  const details = [
    ...(choice?.state === 'unknown' && recordedAction !== 'Acción registrada'
      ? [`Acción registrada: ${recordedAction}.`]
      : []),
    ...(resolutionLabel(result.resolution)
      ? [`Resolución: ${resolutionLabel(result.resolution)}.`]
      : []),
    ...(result.afterSupport === undefined ? [] : [`Terminó en la casilla ${result.afterSupport}.`]),
    ...(result.turnsUsed === undefined ? [] : [`Consumió el turno ${result.turnsUsed}.`]),
  ];
  return details;
};

const errorText = (error: unknown): string => {
  if (error instanceof AttemptApiFailure) return error.message;
  return 'No se pudo cargar la inspección.';
};

const recoveryText = (
  resource: 'mapa' | 'ficha',
  reason: 'transient' | 'pending' | 'authentication',
): string => {
  if (reason === 'authentication') return 'Se necesita recuperar el acceso para continuar.';
  if (reason === 'pending') {
    return 'Las decisiones todavía no están listas. Se volverán a consultar automáticamente.';
  }
  return `No se pudo cargar ${resource === 'mapa' ? 'el mapa' : 'la ficha'}. Se volverá a consultar automáticamente.`;
};

const mapSupportLabel = (
  support: number,
  count: number,
  location: string,
  segment: string | null,
  object: string | null,
  door: string | null,
): string => {
  const features = [
    location,
    ...(segment ? [segment] : []),
    ...(object ? [object] : []),
    ...(door ? [door] : []),
  ];
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
        const door =
          LEVEL.door?.support === support ? `Puerta en acceso ${support - 1}–${support}` : null;
        const location = marker ?? 'Casilla';
        const segment =
          support > 0 && support <= LEVEL.segments.length
            ? `Tramo ${support - 1}–${support}: ${segmentLabel(LEVEL.segments[support - 1])}`
            : null;
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
              segment,
              object ? objectLabel(object.id) : null,
              door,
            )}
            onClick={() => onSelect(support)}
          >
            <span className="decision-map-cell-number">{support}</span>
            <span className="decision-map-cell-name">{location}</span>
            {segment && <span className="decision-map-cell-segment">{segment}</span>}
            {object && <span className="decision-map-cell-object">{objectLabel(object.id)}</span>}
            {door && <span className="decision-map-cell-door">{door}</span>}
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
  onNavigateToDetail,
}: {
  readonly item: DecisionIndexItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onNavigateToDetail: () => void;
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
          Casilla {item.originSupport}, {item.hasAction ? 'con acción' : 'sin acción'}
        </span>
      </button>
      {selected && (
        <a className="decision-detail-link" href="#decision-detail" onClick={onNavigateToDetail}>
          Ver ficha seleccionada
        </a>
      )}
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
  const choiceText = !choice
    ? 'No hubo una elección registrada.'
    : choice.state === 'invalid'
      ? 'La elección registrada fue inválida.'
      : choice.state === 'unknown'
        ? 'No se conoce la elección registrada.'
        : `Elección válida: ${actionText(choice.action, choice.opaqueId, choice.parameters)}.`;
  const choiceId =
    choice?.state === 'selected'
      ? choice.opaqueId
      : choice?.state === 'invalid'
        ? choice.opaqueId
        : undefined;
  const available = detail.availableActions;
  const literalData = literalDecisionData(detail);
  return (
    <section className="decision-detail" aria-label={`Ficha de decisión ${detail.item.number}`}>
      <div className="decision-fact">
        <h4>Observación</h4>
        <div className="decision-fact-copy">
          {observationText(detail.observation).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
      <div className="decision-fact">
        <h4>Acción elegida</h4>
        <p>{choiceText}</p>
      </div>
      <div className="decision-fact">
        <h4>Resolución</h4>
        <div className="decision-fact-copy">
          {actionResultText(detail.result, detail.choice).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
      <details className="decision-options" key={detail.item.number}>
        <summary>Opciones y datos literales</summary>
        <div className="decision-options-content">
          {choiceId && (
            <p className="decision-choice-id">
              ID de la elección: <code>{choiceId}</code>
            </p>
          )}
          <div className="decision-fact">
            <h4>Acciones disponibles</h4>
            {available === null ? (
              <p>Acciones no disponibles en el registro.</p>
            ) : available.length === 0 ? (
              <p>No había acciones disponibles.</p>
            ) : (
              <ul className="decision-action-list">
                {available.map((action: DecisionAvailableAction) => {
                  const description =
                    action.description === undefined
                      ? 'Descripción omitida.'
                      : action.description === ''
                        ? 'Descripción vacía.'
                        : action.description;
                  return (
                    <li key={action.opaqueId}>
                      <strong>
                        {action.label}{' '}
                        <span className="decision-action-id">({action.opaqueId})</span>
                      </strong>
                      <span>{description}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {literalData.map(({ labels, json }) => (
            <section className="decision-literal-data" key={labels.join(' / ')}>
              <h4>{labels.join(' / ')}</h4>
              <pre>
                <code>{json}</code>
              </pre>
            </section>
          ))}
        </div>
      </details>
    </section>
  );
}

export function DecisionInspector({
  api,
  attemptId,
  identity,
  surface = 'historial',
  active = true,
  authPaused = false,
  targetLabel,
  initialSelection = 'first',
  onAuthRequired,
  onClose,
}: DecisionInspectorProps) {
  const recoveryIdentity = identity ?? 'decision-inspector';
  const [index, setIndex] = useState<DecisionIndex | null>(null);
  const [selectedSupport, setSelectedSupport] = useState<number | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [loadingIndex, setLoadingIndex] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [indexRecoveryMessage, setIndexRecoveryMessage] = useState<string | null>(null);
  const [detailRecoveryMessage, setDetailRecoveryMessage] = useState<string | null>(null);
  const indexResourceRef = useRef<ReadResource | null>(null);
  const detailResourceRef = useRef<DecisionDetailResource | null>(null);
  const selectedNumberRef = useRef<number | null>(null);
  const openingIdentityRef = useRef(recoveryIdentity);
  const openingSurfaceRef = useRef(surface);
  const abandonedRef = useRef(false);
  const initialScrollNumberRef = useRef<number | null>(null);
  const detailContainerRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [attemptId]);

  const detailRecovery = useReadRecovery<DecisionDetailResource, DecisionDetail>({
    active,
    authPaused,
    identity: recoveryIdentity,
    surface,
    onAuthRequired,
    read: (resource, signal) => api.getDecision(resource.targetId, resource.decisionNumber, signal),
    classifyFailure: classifyAttemptReadFailure,
    onStart: (resource) => {
      if (detailResourceRef.current !== resource) return;
      setLoadingDetail(true);
      setDetailError(null);
      setDetailRecoveryMessage(null);
    },
    onValue: (loaded, resource, _signal, isCurrent) => {
      if (
        !isCurrent() ||
        detailResourceRef.current !== resource ||
        selectedNumberRef.current !== resource.decisionNumber ||
        resource.targetId !== attemptId ||
        resource.identity !== recoveryIdentity
      ) {
        return false;
      }
      if (
        loaded.attemptId !== resource.targetId ||
        loaded.levelId !== LEVEL.id ||
        loaded.item.number !== resource.decisionNumber
      ) {
        throw new AttemptApiFailure(
          'server',
          'La ficha recibida no coincide con la decisión elegida.',
          200,
        );
      }
      setDetail(loaded);
      setDetailError(null);
      setDetailRecoveryMessage(null);
      setLoadingDetail(false);
      return true;
    },
    onRecovering: (resource, _loadError, reason) => {
      if (detailResourceRef.current !== resource) return;
      setLoadingDetail(false);
      setDetail(null);
      setDetailError(null);
      setDetailRecoveryMessage(recoveryText('ficha', reason));
    },
    onPaused: (resource) => {
      if (detailResourceRef.current !== resource) return;
      setLoadingDetail(false);
      setDetailRecoveryMessage(
        authPaused
          ? recoveryText('ficha', 'authentication')
          : 'La consulta se retomará cuando vuelva a estar disponible.',
      );
    },
    onError: (resource, loadError) => {
      if (detailResourceRef.current !== resource) return;
      setLoadingDetail(false);
      setDetailRecoveryMessage(null);
      setDetailError(errorText(loadError));
      setDetail(null);
    },
  });

  const openDetail = (number: number | null): void => {
    if (number === null) {
      detailRecovery.clear();
      detailResourceRef.current = null;
      selectedNumberRef.current = null;
      setSelectedNumber(null);
      setDetail(null);
      setDetailError(null);
      setDetailRecoveryMessage(null);
      setLoadingDetail(false);
      return;
    }

    const indexResource = indexResourceRef.current;
    selectedNumberRef.current = number;
    setSelectedNumber(number);
    setDetail(null);
    setDetailError(null);
    setDetailRecoveryMessage(null);
    const resource = indexResource ? { ...indexResource, decisionNumber: number } : null;
    detailResourceRef.current = resource;
    if (!resource) {
      detailRecovery.clear();
      setLoadingDetail(false);
      return;
    }
    void detailRecovery.open(resource);
  };

  const indexRecovery = useReadRecovery<ReadResource, DecisionIndex>({
    active,
    authPaused,
    identity: recoveryIdentity,
    surface,
    onAuthRequired,
    read: (resource, signal) => api.getDecisionIndex(resource.targetId, signal),
    classifyFailure: classifyAttemptReadFailure,
    onStart: (resource) => {
      if (indexResourceRef.current !== resource) return;
      setLoadingIndex(true);
      setError(null);
      setIndexRecoveryMessage(null);
    },
    onValue: (loaded, resource, _signal, isCurrent) => {
      if (
        !isCurrent() ||
        indexResourceRef.current !== resource ||
        resource.targetId !== attemptId ||
        resource.identity !== recoveryIdentity
      ) {
        return false;
      }
      if (loaded.attemptId !== resource.targetId || loaded.levelId !== LEVEL.id) {
        throw new AttemptApiFailure('server', 'El índice no coincide con el intento abierto.', 200);
      }

      const selected = initialDecision(loaded, initialSelection);
      setIndex(loaded);
      setError(null);
      setIndexRecoveryMessage(null);
      setLoadingIndex(false);
      initialScrollNumberRef.current =
        initialSelection === 'first' ? null : (selected?.number ?? null);
      setSelectedSupport(selected?.originSupport ?? null);
      if (selected) openDetail(selected.number);
      else openDetail(null);
      return true;
    },
    onRecovering: (resource, _loadError, reason) => {
      if (indexResourceRef.current !== resource) return;
      setLoadingIndex(false);
      setError(null);
      setIndexRecoveryMessage(recoveryText('mapa', reason));
    },
    onPaused: (resource) => {
      if (indexResourceRef.current !== resource) return;
      setLoadingIndex(false);
      setIndexRecoveryMessage(
        authPaused
          ? recoveryText('mapa', 'authentication')
          : 'La consulta se retomará cuando vuelva a estar disponible.',
      );
    },
    onError: (resource, loadError) => {
      if (indexResourceRef.current !== resource) return;
      setLoadingIndex(false);
      setIndexRecoveryMessage(null);
      setError(errorText(loadError));
    },
  });

  useLayoutEffect(() => {
    if (recoveryIdentity === openingIdentityRef.current && surface === openingSurfaceRef.current) {
      return;
    }
    abandonedRef.current = true;
    indexRecovery.clear();
    detailRecovery.clear();
    indexResourceRef.current = null;
    detailResourceRef.current = null;
    selectedNumberRef.current = null;
    setIndex(null);
    setSelectedSupport(null);
    setSelectedNumber(null);
    setDetail(null);
    setLoadingIndex(false);
    setLoadingDetail(false);
    setError(null);
    setDetailError(null);
    setIndexRecoveryMessage(null);
    setDetailRecoveryMessage(null);
  }, [detailRecovery.clear, indexRecovery.clear, recoveryIdentity, surface]);

  useLayoutEffect(() => {
    if (abandonedRef.current) return;
    indexRecovery.clear();
    detailRecovery.clear();
    setIndex(null);
    setSelectedSupport(null);
    setSelectedNumber(null);
    selectedNumberRef.current = null;
    setDetail(null);
    setLoadingIndex(true);
    setLoadingDetail(false);
    setError(null);
    setDetailError(null);
    setIndexRecoveryMessage(null);
    setDetailRecoveryMessage(null);
    initialScrollNumberRef.current = null;

    const resource: ReadResource = {
      identity: openingIdentityRef.current,
      targetId: attemptId,
      surface: openingSurfaceRef.current,
    };
    indexResourceRef.current = resource;
    void indexRecovery.open(resource);

    return () => {
      indexRecovery.clear();
      detailRecovery.clear();
      if (indexResourceRef.current === resource) {
        indexResourceRef.current = null;
        detailResourceRef.current = null;
        selectedNumberRef.current = null;
      }
    };
  }, [attemptId, detailRecovery.clear, indexRecovery.clear, indexRecovery.open, initialSelection]);

  const closeInspector = (): void => {
    indexRecovery.clear();
    detailRecovery.clear();
    indexResourceRef.current = null;
    detailResourceRef.current = null;
    selectedNumberRef.current = null;
    onClose();
  };

  const bySupport = useMemo(
    () => index?.decisions.filter((item) => item.originSupport === selectedSupport) ?? [],
    [index, selectedSupport],
  );
  const selectedItem = index?.decisions.find((item) => item.number === selectedNumber) ?? null;
  const selectSupport = (support: number): void => {
    initialScrollNumberRef.current = null;
    setSelectedSupport(support);
    const first = index?.decisions.find((item) => item.originSupport === support);
    if (selectedNumberRef.current === (first?.number ?? null)) return;
    openDetail(first?.number ?? null);
  };
  const selectDecision = (item: DecisionIndexItem): void => {
    initialScrollNumberRef.current = null;
    setSelectedSupport(item.originSupport);
    if (selectedNumberRef.current === item.number) return;
    openDetail(item.number);
  };
  const navigateToDetail = (): void => {
    initialScrollNumberRef.current = null;
    detailContainerRef.current?.focus({ preventScroll: true });
  };

  const [visibilityRevision, setVisibilityRevision] = useState(0);

  useEffect(() => {
    const handleWake = (): void => {
      if (
        initialScrollNumberRef.current === null ||
        document.hidden ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      setVisibilityRevision((revision) => revision + 1);
    };
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);
    return () => {
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, []);

  useEffect(() => {
    if (
      !detail ||
      loadingDetail ||
      detailError ||
      authPaused ||
      !active ||
      document.hidden ||
      document.visibilityState === 'hidden' ||
      detail.item.number !== selectedNumberRef.current ||
      initialScrollNumberRef.current !== detail.item.number
    ) {
      return;
    }
    initialScrollNumberRef.current = null;
    detailContainerRef.current?.scrollIntoView?.({
      block: 'start',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [active, authPaused, detail, detailError, loadingDetail, visibilityRevision]);

  return (
    <section className="decision-inspector" aria-labelledby="decision-inspector-title">
      <div className="decision-inspector-heading">
        <div>
          <p className="card-kicker">Mapa para el jugador</p>
          <h3 id="decision-inspector-title" ref={headingRef} tabIndex={-1}>
            Inspeccionar decisiones
          </h3>
          {targetLabel && (
            <p className="decision-inspector-target">Intento inspeccionado: {targetLabel}</p>
          )}
          <p>Consultá las decisiones guardadas del recorrido sin volver a ejecutarlo.</p>
        </div>
        <button className="secondary-button" type="button" onClick={closeInspector}>
          Cerrar inspección
        </button>
      </div>
      {authPaused && (
        <p className="attempt-message" role="status">
          Se conserva la inspección hasta recuperar el acceso.
        </p>
      )}
      {loadingIndex && (
        <p className="attempt-message" role="status">
          Cargando el mapa de decisiones…
        </p>
      )}
      {!authPaused && !loadingIndex && indexRecoveryMessage && (
        <p className="attempt-message" role="status">
          {indexRecoveryMessage}
        </p>
      )}
      {error && (
        <div className="attempt-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {!loadingIndex && !error && index && (
        <>
          <StaticLevelMap
            index={index}
            selectedSupport={selectedSupport}
            onSelect={selectSupport}
          />
          <p className="decision-map-help">
            Desplazá el mapa horizontalmente para ver todas las casillas.
          </p>
          {index.decisions.length === 0 ? (
            <p className="decision-inspector-empty" role="status">
              Este intento no tiene decisiones guardadas para inspeccionar.
            </p>
          ) : (
            <>
              <div className="decision-inspector-support">
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
                        onNavigateToDetail={navigateToDetail}
                      />
                    ))}
                  </ol>
                  {bySupport.length === 0 && <p>No hay decisiones en esta casilla.</p>}
                </section>
                <div
                  className="decision-detail-wrap"
                  id="decision-detail"
                  ref={detailContainerRef}
                  role="group"
                  aria-labelledby={selectedItem ? 'decision-detail-title' : undefined}
                  aria-label={selectedItem ? undefined : 'Ficha sin selección'}
                  tabIndex={-1}
                >
                  {selectedItem && (
                    <h4 className="decision-detail-heading" id="decision-detail-title">
                      Decisión {selectedItem.number}, casilla {selectedItem.originSupport}
                    </h4>
                  )}
                  {loadingDetail && (
                    <p className="attempt-message" role="status">
                      Cargando la ficha…
                    </p>
                  )}
                  {!authPaused && !loadingDetail && detailRecoveryMessage && (
                    <p className="attempt-message" role="status">
                      {detailRecoveryMessage}
                    </p>
                  )}
                  {detailError && (
                    <div className="attempt-error" role="alert">
                      <p>{detailError}</p>
                    </div>
                  )}
                  {!loadingDetail && !detailError && !detailRecoveryMessage && (
                    <DecisionDetailCard detail={detail} />
                  )}
                </div>
              </div>
              <section
                className="decision-inspector-chronology"
                aria-labelledby="decision-all-title"
              >
                <h4 id="decision-all-title">Todas las decisiones, en orden</h4>
                <ol className="decision-list">
                  {index.decisions.map((item) => (
                    <DecisionCard
                      item={item}
                      key={item.number}
                      selected={selectedNumber === item.number}
                      onSelect={() => selectDecision(item)}
                      onNavigateToDetail={navigateToDetail}
                    />
                  ))}
                </ol>
              </section>
            </>
          )}
        </>
      )}
    </section>
  );
}
