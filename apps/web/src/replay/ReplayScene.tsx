import { useEffect, useRef, useState } from 'react';
import type { ReplayRecordView } from '../../../../shared/attempt.js';
import { effectiveTerrain, LEVEL, type TerrainState } from '../../../../shared/game.js';
import artworkUrl from './art/replay-symbols.svg?url';
import './ReplayScene.css';
import {
  prepareReplay,
  type PreparedReplay,
  type ReplayPose,
  type ReplaySample,
  REPLAY_BARRIER_HIGH_Y,
  REPLAY_BARRIER_INSET,
  REPLAY_BARRIER_LOW_Y,
  REPLAY_PIT_LEDGE_WIDTH,
  REPLAY_SEGMENT_WIDTH,
  REPLAY_SUPPORT_START_X,
  REPLAY_VIEW_WIDTH,
  REPLAY_WORLD_WIDTH,
} from './prepare.js';

export interface ReplaySceneProps {
  readonly record: ReplayRecordView;
  readonly onReady: () => void;
  readonly onComplete: () => void;
  readonly onError: (error: Error) => void;
}

const WIDTH = REPLAY_VIEW_WIDTH;
const PREVIEW_HEIGHT = 360;
const GROUND_Y = 250;
const ROBOT_SCALE = 0.62;
const SUPPORT_START_X = REPLAY_SUPPORT_START_X;
const SEGMENT_WIDTH = REPLAY_SEGMENT_WIDTH;
const ROBOT_SYMBOL: Readonly<Record<ReplayPose, string>> = Object.freeze({
  idle: 'robot-idle',
  'step-a': 'robot-step-a',
  'step-b': 'robot-step-b',
  jump: 'robot-jump',
  crouch: 'robot-crouch',
  collect: 'robot-collect',
  fall: 'robot-fall',
  impact: 'robot-impact',
  celebrate: 'robot-celebrate',
});

const symbolHref = (symbol: string): string => `${artworkUrl}#${symbol}`;

const preloadSymbols = async (symbols: readonly string[]): Promise<void> => {
  if (!artworkUrl) throw new Error('No se encontró el catálogo gráfico de la animación.');
  const response = await fetch(artworkUrl, { cache: 'force-cache' });
  if (!response.ok)
    throw new Error(`No se pudo cargar el catálogo gráfico (HTTP ${response.status}).`);
  const source = await response.text();
  const available = new Set(
    [...source.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]),
  );
  const referenced = [...source.matchAll(/\bhref=["']#([^"']+)["']/g)].map((match) => match[1]);
  const missing = [...new Set([...symbols, ...referenced])].filter(
    (symbol) => !available.has(symbol),
  );
  if (missing.length > 0) {
    throw new Error(`Faltan símbolos del catálogo gráfico actual: ${missing.join(', ')}.`);
  }
};

const poseLabel = (pose: ReplayPose): string => {
  switch (pose) {
    case 'idle':
      return 'quieto';
    case 'step-a':
    case 'step-b':
      return 'caminando';
    case 'jump':
      return 'saltando';
    case 'crouch':
      return 'agachado';
    case 'collect':
      return 'recolectando';
    case 'fall':
      return 'cayendo';
    case 'impact':
      return 'en el impacto';
    case 'celebrate':
      return 'celebrando';
  }
};

const groundHref = symbolHref('terrain-ground');
const bridgeLeafHref = symbolHref('terrain-bridge-leaf');
const bridgeHingeHref = symbolHref('terrain-bridge-hinge');
const pitHref = symbolHref('terrain-pit-edge');
const branchBackHref = symbolHref('terrain-branch-back');
const branchFrontHref = symbolHref('terrain-branch-front');
const barrierPanelHref = symbolHref('terrain-barrier-panel');
const exitHref = symbolHref('terrain-exit');
const impactHref = symbolHref('effect-impact');
const pickupHref = symbolHref('effect-pickup');
const victoryHref = symbolHref('effect-victory');
const rewardHref = symbolHref('reward-object');
const keyHref = symbolHref('key-object');
const closedDoorHref = symbolHref('door-closed');
const openDoorHref = symbolHref('door-open');

const terrainStateProgress = (sample: ReplaySample, index: number, state: TerrainState): number => {
  const current = Number(sample.terrain[index] === state);
  const transition = sample.terrainTransition;
  return transition
    ? current + (Number(transition.to[index] === state) - current) * transition.progress
    : current;
};

const Backdrop = ({ width = WIDTH }: { readonly width?: number }) => (
  <>
    <rect width={width} height="330" fill="#eaf8fc" />
    <circle cx="665" cy="65" r="29" fill="#ffcf71" opacity="0.9" />
    <path d="M0 228Q92 202 185 226t183-2q100-23 198 1t194-2v107H0z" fill="#d6edf0" />
    <path d="M0 245Q102 223 206 243t205-1q99-19 193 0t156 1v87H0z" fill="#edf8f4" />
    {width > WIDTH && (
      <>
        <path
          d={`M${WIDTH} 228Q${WIDTH + (width - WIDTH) * 0.25} 202 ${WIDTH + (width - WIDTH) * 0.5} 226T${width} 224v107H${WIDTH}z`}
          fill="#d6edf0"
        />
        <path
          d={`M${WIDTH} 245Q${WIDTH + (width - WIDTH) * 0.25} 223 ${WIDTH + (width - WIDTH) * 0.5} 243T${width} 244v87H${WIDTH}z`}
          fill="#edf8f4"
        />
      </>
    )}
    <g fill="#fff" opacity="0.8">
      <path d="M88 80a18 18 0 0 1 35-5 16 16 0 0 1 27 13H79a14 14 0 0 1 9-8z" />
      <path d="M402 55a14 14 0 0 1 27-4 13 13 0 0 1 23 10h-64a11 11 0 0 1 14-6z" />
    </g>
  </>
);

const TerrainBack = ({ sample }: { readonly sample: ReplaySample }) => {
  const endSupport = sample.terrain.length;
  return (
    <g data-replay-layer="terrain-back" aria-hidden="true">
      <use href={groundHref} x="0" y="236" width={SUPPORT_START_X} height="70" />
      {sample.terrain.map((state, index) => {
        const x = SUPPORT_START_X + index * SEGMENT_WIDTH;
        const segment = LEVEL.segments[index];
        return (
          <g
            key={`segment-back-${index}`}
            data-segment-type={segment?.type}
            data-terrain-state={state}
          >
            {state === 'pit' || segment?.type === 'platform' ? (
              <g>
                <path d={`M${x + 22} 254h76v69H${x + 22}z`} fill="#dff6fa" opacity="0.62" />
                <path
                  d={`M${x + 35} 280q25-11 49 0`}
                  fill="none"
                  stroke="#a4dce4"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </g>
            ) : (
              <g>
                {state === 'branch' && (
                  <use
                    data-terrain-symbol="branch-tree"
                    href={branchBackHref}
                    x={x}
                    y="0"
                    width="180"
                    height="250"
                  />
                )}
                <use
                  href={groundHref}
                  data-terrain-art="ground"
                  x={x}
                  y="236"
                  width={SEGMENT_WIDTH}
                  height="70"
                />
              </g>
            )}
          </g>
        );
      })}
      <use
        href={groundHref}
        x={SUPPORT_START_X + endSupport * SEGMENT_WIDTH}
        y="236"
        width={REPLAY_WORLD_WIDTH - SUPPORT_START_X - endSupport * SEGMENT_WIDTH}
        height="70"
      />
      <use
        href={exitHref}
        data-exit-state="free"
        data-exit-support={endSupport}
        x={SUPPORT_START_X + endSupport * SEGMENT_WIDTH - 35}
        y="156"
        width="70"
        height="94"
      />
      <use
        data-door-state={sample.doorState}
        data-door-support={LEVEL.door!.support}
        href={sample.doorState === 'open' ? openDoorHref : closedDoorHref}
        x={SUPPORT_START_X + LEVEL.door!.support * SEGMENT_WIDTH - 28}
        y="154"
        width="56"
        height="94"
      />
    </g>
  );
};

const PlatformBridge = ({
  sample,
  index,
  x,
}: {
  readonly sample: ReplaySample;
  readonly index: number;
  readonly x: number;
}) => {
  const angle = 90 * terrainStateProgress(sample, index, 'pit');
  const length = (SEGMENT_WIDTH - 2 * REPLAY_PIT_LEDGE_WIDTH) / 2;
  const left = x + REPLAY_PIT_LEDGE_WIDTH;
  const right = x + SEGMENT_WIDTH - REPLAY_PIT_LEDGE_WIDTH;
  return (
    <g data-platform-angle={angle}>
      <g data-platform-leaf="left" transform={`translate(${left} ${GROUND_Y}) rotate(${angle})`}>
        <use href={bridgeLeafHref} width={length} height="12" />
      </g>
      <g
        data-platform-leaf="right"
        transform={`translate(${right} ${GROUND_Y}) scale(-1 1) rotate(${angle})`}
      >
        <use href={bridgeLeafHref} width={length} height="12" />
      </g>
      <use href={bridgeHingeHref} x={left - 5} y={GROUND_Y - 5} width="10" height="10" />
      <use href={bridgeHingeHref} x={right - 5} y={GROUND_Y - 5} width="10" height="10" />
    </g>
  );
};

const TerrainFront = ({ sample }: { readonly sample: ReplaySample }) => (
  <g data-replay-layer="terrain-front" aria-hidden="true">
    {sample.terrain.map((state, index) => {
      const x = SUPPORT_START_X + index * SEGMENT_WIDTH;
      const platform = LEVEL.segments[index]?.type === 'platform';
      const barrierY =
        REPLAY_BARRIER_LOW_Y +
        (REPLAY_BARRIER_HIGH_Y - REPLAY_BARRIER_LOW_Y) *
          terrainStateProgress(sample, index, 'barrier_high');
      return (
        <g key={`segment-front-${index}`} data-segment-type={LEVEL.segments[index]?.type}>
          {(state === 'pit' || platform) && (
            <g>
              <use
                data-terrain-symbol="pit-edge"
                href={pitHref}
                x={x}
                y="236"
                width={REPLAY_PIT_LEDGE_WIDTH}
                height="70"
              />
              <use
                data-terrain-symbol="pit-edge"
                href={pitHref}
                x="0"
                y="236"
                width={REPLAY_PIT_LEDGE_WIDTH}
                height="70"
                transform={`translate(${x + SEGMENT_WIDTH} 0) scale(-1 1)`}
              />
            </g>
          )}
          {platform && <PlatformBridge sample={sample} index={index} x={x} />}
          {state === 'branch' && (
            <use
              data-terrain-symbol="branch-front"
              href={branchFrontHref}
              x={x}
              y="0"
              width={SEGMENT_WIDTH}
              height="250"
            />
          )}
          {(state === 'barrier_low' || state === 'barrier_high') && (
            <use
              data-terrain-symbol={state}
              data-barrier-y={barrierY}
              href={barrierPanelHref}
              x={x}
              y={barrierY - 13}
              width={SEGMENT_WIDTH}
              height="40"
            />
          )}
        </g>
      );
    })}
  </g>
);

const Robot = ({ sample }: { readonly sample: ReplaySample }) => {
  const centerX = SUPPORT_START_X + sample.support * SEGMENT_WIDTH;
  const scaleX = sample.facing === 'left' ? -ROBOT_SCALE : ROBOT_SCALE;
  const symbol = ROBOT_SYMBOL[sample.pose];
  const footY = GROUND_Y + sample.drop;
  return (
    <g
      aria-hidden="true"
      data-center-x={centerX}
      data-facing={sample.facing}
      data-foot-y={footY}
      data-drop={sample.drop}
      data-pose={sample.pose}
      transform={`translate(${centerX} ${footY}) scale(${scaleX} ${ROBOT_SCALE}) translate(-50 -108)`}
    >
      <use href={symbolHref(symbol)} x="0" y="0" width="100" height="112" />
    </g>
  );
};

const Objects = ({ sample }: { readonly sample: ReplaySample }) => (
  <g data-replay-layer="objects" aria-hidden="true">
    {LEVEL.objects
      .filter((object) => sample.remainingObjects.includes(object.id))
      .map((object) => {
        const centerX = SUPPORT_START_X + object.support * SEGMENT_WIDTH;
        return (
          <use
            key={object.id}
            className="replay-scene__object"
            data-object-id={object.id}
            data-object-kind={object.id === 'llave-1' ? 'key' : 'reward'}
            href={object.id === 'llave-1' ? keyHref : rewardHref}
            x={centerX + 14}
            y={object.id === 'llave-1' ? '204' : '202'}
            width="36"
            height={object.id === 'llave-1' ? '36' : '40'}
          />
        );
      })}
  </g>
);

const Effects = ({
  sample,
  record,
}: {
  readonly sample: ReplaySample;
  readonly record: ReplayRecordView;
}) => {
  if (sample.effect === 'none') return null;
  const centerX = SUPPORT_START_X + sample.support * SEGMENT_WIDTH;
  const victory = sample.effect === 'victory';
  const pickup = sample.effect === 'pickup';
  const size = victory ? 74 : pickup ? 46 : 34;
  let x = victory ? centerX - size / 2 : centerX + (sample.facing === 'left' ? -24 : 34) - size / 2;
  let y = victory ? 132 : pickup ? 184 : 146;
  const resolution =
    sample.actionIndex === null ? undefined : record.actions[sample.actionIndex]?.resolution;
  if (sample.effect === 'impact' && resolution?.outcome === 'collision') {
    const terrain = sample.terrain[resolution.segment];
    if (terrain === 'barrier_low' || terrain === 'barrier_high') {
      x =
        SUPPORT_START_X +
        resolution.segment * SEGMENT_WIDTH +
        (sample.facing === 'left' ? SEGMENT_WIDTH - REPLAY_BARRIER_INSET : REPLAY_BARRIER_INSET) -
        size / 2;
      y =
        (terrain === 'barrier_low' ? REPLAY_BARRIER_LOW_Y : REPLAY_BARRIER_HIGH_Y) + 11 - size / 2;
    } else if (terrain === 'branch') {
      x = centerX - size / 2;
      y = 185 - size / 2;
    }
  }
  return (
    <use
      aria-hidden="true"
      data-effect={sample.effect}
      href={victory ? victoryHref : pickup ? pickupHref : impactHref}
      x={x}
      y={y}
      width={size}
      height={size}
    />
  );
};

const ReplayCanvas = ({
  sample,
  record,
}: {
  readonly sample: ReplaySample;
  readonly record: ReplayRecordView;
}) => (
  <svg
    className="replay-scene__canvas"
    viewBox={`0 0 ${WIDTH} 330`}
    role="img"
    aria-label="Reproducción del intento."
    data-profile={LEVEL.id}
    data-complete={sample.complete}
    data-action-index={sample.actionIndex ?? ''}
    data-closure-status={sample.closureStatus}
    data-camera-x={sample.cameraX}
    data-terrain-transition-progress={sample.terrainTransition?.progress ?? ''}
  >
    <title>Reproducción del intento: robot {poseLabel(sample.pose)}</title>
    <g data-replay-layer="backdrop">
      <Backdrop />
    </g>
    <g
      data-replay-world="true"
      transform={`translate(${-sample.cameraX} 0)`}
      data-world-width={REPLAY_WORLD_WIDTH}
    >
      <TerrainBack sample={sample} />
      <Objects sample={sample} />
      <g data-replay-layer="robot">
        <Robot sample={sample} />
      </g>
      <TerrainFront sample={sample} />
      {sample.effect !== 'none' && <Effects sample={sample} record={record} />}
    </g>
    <g aria-hidden="true" fontFamily="system-ui, sans-serif">
      <rect x="22" y="20" width="110" height="34" rx="17" fill="#fff" fillOpacity="0.78" />
      <text x="77" y="42" textAnchor="middle" fill="#23445b" fontSize="15" fontWeight="600">
        {record.actions.length === 0
          ? 'Sin acciones'
          : `Turno ${sample.actionNumber} / ${record.actions.length}`}
      </text>
    </g>
  </svg>
);

const initialCourseSample: ReplaySample = Object.freeze({
  time: 0,
  support: 0,
  drop: 0,
  facing: 'right',
  pose: 'idle',
  terrain: effectiveTerrain(LEVEL, 0),
  remainingObjects: LEVEL.objects.map(({ id }) => id),
  inventory: Object.freeze([]),
  doorState: 'locked',
  terrainTransition: null,
  cameraX: 0,
  actionIndex: null,
  actionNumber: 0,
  closureStatus: 'incomplete',
  effect: 'none',
  complete: true,
});

const CourseTileNumbers = () => (
  <g
    data-replay-layer="course-tile-numbers"
    aria-hidden="true"
    fontFamily="system-ui, sans-serif"
    fontSize="15"
    fontWeight="700"
    textAnchor="middle"
  >
    {Array.from({ length: LEVEL.exit.support + 1 }, (_, tile) => {
      const x = SUPPORT_START_X + tile * SEGMENT_WIDTH;
      return (
        <g key={tile} data-tile-number={tile}>
          <path d={`M${x} 306v9`} stroke="#54716e" strokeWidth="2" />
          <circle cx={x} cy="333" r="16" fill="#fff" stroke="#54716e" strokeWidth="2" />
          <text x={x} y="338" fill="#23445b">
            {tile}
          </text>
        </g>
      );
    })}
  </g>
);

/** A static first-phase overview, rendered with the same authored terrain as replay. */
export const CoursePreview = () => (
  <section className="course-preview" aria-labelledby="course-preview-title">
    <div className="course-preview__heading">
      <div>
        <p className="course-preview__kicker">Mapa del recorrido</p>
        <h2 id="course-preview-title">Vista completa del terreno</h2>
      </div>
      <span className="course-preview__phase">Fase inicial</span>
    </div>
    <div className="course-preview__scroller" tabIndex={0} aria-label="Recorrido desplazable">
      <svg
        className="course-preview__canvas"
        width={REPLAY_WORLD_WIDTH}
        height={PREVIEW_HEIGHT}
        viewBox={`0 0 ${REPLAY_WORLD_WIDTH} ${PREVIEW_HEIGHT}`}
        role="img"
        aria-label="Recorrido completo desde la casilla 0 hasta la 10, con recompensa, llave, puerta y salida."
        data-course-preview="static"
        data-preview-phase="0"
        data-world-width={REPLAY_WORLD_WIDTH}
      >
        <title>Vista completa del terreno en la fase inicial</title>
        <desc>Las barreras y la plataforma cambian de fase después de cada acción.</desc>
        <Backdrop width={REPLAY_WORLD_WIDTH} />
        <TerrainBack sample={initialCourseSample} />
        <Objects sample={initialCourseSample} />
        <TerrainFront sample={initialCourseSample} />
        <CourseTileNumbers />
      </svg>
    </div>
    <p className="course-preview__description">
      Las barreras y la plataforma cambian de fase después de cada acción. En la casilla 2 hay una
      recompensa opcional de 25 puntos. La llave de la casilla 6 abre la puerta de la casilla 9. La
      salida está en la casilla 10. Hay hasta 24 acciones para llegar.
    </p>
  </section>
);

const ReplayPlayer = ({ record, onReady, onComplete, onError }: ReplaySceneProps) => {
  const [playback, setPlayback] = useState<PreparedReplay | null>(null);
  const [sample, setSample] = useState<ReplaySample | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [started, setStarted] = useState(false);
  const onReadyRef = useRef(onReady);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  const readySent = useRef(false);
  const completeSent = useRef(false);

  useEffect(() => {
    onReadyRef.current = onReady;
    onCompleteRef.current = onComplete;
    onErrorRef.current = onError;
  }, [onReady, onComplete, onError]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => prepareReplay(record))
      .then((prepared) => preloadSymbols(prepared.requiredSymbols).then(() => prepared))
      .then((prepared) => {
        if (!cancelled) setPlayback(prepared);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const replayError = cause instanceof Error ? cause : new Error(String(cause));
        setError(replayError);
        onErrorRef.current(replayError);
      });
    return () => {
      cancelled = true;
    };
  }, [record]);

  useEffect(() => {
    if (!playback) return undefined;
    let frameId = 0;
    let startAt: number | null = null;
    const tick = (timestamp: number) => {
      if (startAt === null) startAt = timestamp;
      const elapsed = (timestamp - startAt) / 1000;
      const nextSample = playback.sample(elapsed);
      setSample(nextSample);
      setStarted(true);
      if (!nextSample.complete) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [playback]);

  useEffect(() => {
    if (started && !readySent.current) {
      readySent.current = true;
      onReadyRef.current();
    }
    if (started && sample?.complete && !completeSent.current) {
      completeSent.current = true;
      onCompleteRef.current();
    }
  }, [sample, started]);

  if (error)
    return (
      <div className="replay-scene__error" role="alert">
        {error.message}
      </div>
    );
  if (!sample)
    return (
      <div className="replay-scene__preparing" role="status">
        Preparando animación…
      </div>
    );
  return <ReplayCanvas sample={sample} record={record} />;
};

export const ReplayScene = (props: ReplaySceneProps) => (
  <ReplayPlayer key={`${props.record.id}:${props.record.updatedAt}`} {...props} />
);
