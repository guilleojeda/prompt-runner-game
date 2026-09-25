import { useEffect, useRef, useState } from 'react';
import type { ReplayRecordView } from '../../../../shared/attempt.js';
import { LEVEL, type TerrainState } from '../../../../shared/game.js';
import artworkUrl from './art/replay-symbols.svg?url';
import './ReplayScene.css';
import {
  prepareReplay,
  type PreparedReplay,
  type ReplayPose,
  type ReplaySample,
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
const platformGroundHref = symbolHref('terrain-platform-ground');
const platformFrameHref = symbolHref('terrain-platform-frame');
const pitHref = symbolHref('terrain-pit-edge');
const branchBackHref = symbolHref('terrain-branch-back');
const branchFrontHref = symbolHref('terrain-branch-front');
const barrierLowHref = symbolHref('terrain-barrier-low');
const barrierHighHref = symbolHref('terrain-barrier-high');
const exitHref = symbolHref('terrain-exit');
const impactHref = symbolHref('effect-impact');
const pickupHref = symbolHref('effect-pickup');
const victoryHref = symbolHref('effect-victory');
const rewardHref = symbolHref('reward-object');
const keyHref = symbolHref('key-object');
const closedDoorHref = symbolHref('door-closed');
const openDoorHref = symbolHref('door-open');

interface TerrainLayer {
  readonly state: TerrainState;
  readonly opacity: number;
}

const terrainLayers = (sample: ReplaySample, index: number): readonly TerrainLayer[] => {
  const current = sample.terrain[index];
  if (!current) return [];
  const next = sample.terrainTransition?.to[index];
  if (!next || next === current) return [{ state: current, opacity: 1 }];
  const progress = sample.terrainTransition!.progress;
  return [
    { state: current, opacity: 1 - progress },
    { state: next, opacity: progress },
  ];
};

const Backdrop = () => (
  <>
    <rect width={WIDTH} height="330" fill="#eaf8fc" />
    <circle cx="665" cy="65" r="29" fill="#ffcf71" opacity="0.9" />
    <path d="M0 228Q92 202 185 226t183-2q100-23 198 1t194-2v107H0z" fill="#d6edf0" />
    <path d="M0 245Q102 223 206 243t205-1q99-19 193 0t156 1v87H0z" fill="#edf8f4" />
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
      {sample.terrain.map((_terrain, index) => {
        const x = SUPPORT_START_X + index * SEGMENT_WIDTH;
        const segment = LEVEL.segments[index];
        return (
          <g key={`segment-back-${index}`} data-segment-type={segment?.type}>
            {segment?.type === 'platform' && (
              <use href={platformFrameHref} x={x} y="216" width={SEGMENT_WIDTH} height="100" />
            )}
            {terrainLayers(sample, index).map(({ state, opacity }) => {
              if (state === 'pit') {
                return (
                  <g key={`${state}-${opacity}`} opacity={opacity} data-terrain-state={state}>
                    <path d={`M${x + 22} 254h76v69H${x + 22}z`} fill="#dff6fa" opacity="0.62" />
                    <path
                      d={`M${x + 35} 280q25-11 49 0`}
                      fill="none"
                      stroke="#a4dce4"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  </g>
                );
              }
              return (
                <g key={`${state}-${opacity}`} opacity={opacity} data-terrain-state={state}>
                  {state === 'branch' && (
                    <use href={branchBackHref} x={x} y="133" width={SEGMENT_WIDTH} height="92" />
                  )}
                  <use
                    href={segment?.type === 'platform' ? platformGroundHref : groundHref}
                    data-terrain-art={segment?.type === 'platform' ? 'platform-ground' : 'ground'}
                    x={x}
                    y="236"
                    width={SEGMENT_WIDTH}
                    height="70"
                  />
                </g>
              );
            })}
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

const TerrainFront = ({ sample }: { readonly sample: ReplaySample }) => (
  <g data-replay-layer="terrain-front" aria-hidden="true">
    {sample.terrain.map((_terrain, index) => {
      const x = SUPPORT_START_X + index * SEGMENT_WIDTH;
      return (
        <g key={`segment-front-${index}`} data-segment-type={LEVEL.segments[index]?.type}>
          {terrainLayers(sample, index).map(({ state, opacity }) => {
            if (state === 'pit') {
              return (
                <g key={`${state}-${opacity}`} opacity={opacity} data-terrain-state={state}>
                  <use
                    data-terrain-symbol="pit-edge"
                    href={pitHref}
                    x={x}
                    y="236"
                    width="24"
                    height="70"
                  />
                  <use
                    data-terrain-symbol="pit-edge"
                    href={pitHref}
                    x="0"
                    y="236"
                    width="24"
                    height="70"
                    transform={`translate(${x + SEGMENT_WIDTH} 0) scale(-1 1)`}
                  />
                </g>
              );
            }
            if (state === 'branch') {
              return (
                <use
                  key={`${state}-${opacity}`}
                  data-terrain-symbol="branch-front"
                  opacity={opacity}
                  href={branchFrontHref}
                  x={x}
                  y="167"
                  width={SEGMENT_WIDTH}
                  height="44"
                />
              );
            }
            if (state === 'barrier_low' || state === 'barrier_high') {
              return (
                <use
                  key={`${state}-${opacity}`}
                  data-terrain-symbol={state}
                  opacity={opacity}
                  href={state === 'barrier_low' ? barrierLowHref : barrierHighHref}
                  x={x}
                  y="150"
                  width={SEGMENT_WIDTH}
                  height="100"
                />
              );
            }
            return null;
          })}
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

const Effects = ({ sample }: { readonly sample: ReplaySample }) => {
  if (sample.effect === 'none') return null;
  const centerX = SUPPORT_START_X + sample.support * SEGMENT_WIDTH;
  const victory = sample.effect === 'victory';
  const pickup = sample.effect === 'pickup';
  const size = victory ? 74 : pickup ? 46 : 34;
  const x = victory
    ? centerX - size / 2
    : centerX + (sample.facing === 'left' ? -24 : 34) - size / 2;
  const y = victory ? 132 : pickup ? 184 : 146;
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
      {sample.effect !== 'none' && <Effects sample={sample} />}
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
