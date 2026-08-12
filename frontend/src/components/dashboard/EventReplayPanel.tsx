'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import {
  AlertTriangle,
  ChevronLeft,
  Crosshair,
  MapPin,
  Pause,
  Play,
  Truck,
} from 'lucide-react';
import {
  EventReplayManoeuvre,
  EventReplayMoment,
  EventReplayResponse,
  api,
  formatNgn,
} from '@/lib/api';
import {
  anomalyDisplayTitle,
  buildBaselineComparison,
  buildCausalTimeline,
  buildConfidenceFactors,
  buildCorrelationAt,
  buildPrimaryExplanation,
  buildRecommendedActions,
  formatReplayClock,
  improveWhyFlagged,
} from '@/lib/replay-intelligence';
import { TRUST_COPY, severityLabel } from '@/lib/trust-language';
import { ReplayTarget, replayApiPath } from '@/lib/replay-target';
import { bearingDeg } from '@/lib/map-utils';
import {
  FLEET_MAPS_KEY,
  LAGOS_CENTER,
  fleetMapContainerStyle,
  fleetMapDefaults,
} from '@/lib/fleet-map-theme';
import {
  AnomalyMapMarker,
  MANOEUVRE_STYLE,
  MapResizeFix,
  SpeedGradedRoute,
  VehicleCarMarker,
} from '@/components/maps/SharedMapLayers';

const REPLAY_MAP_HEIGHT = 'min(42vh, 420px)';
const REPLAY_MAP_MIN_HEIGHT_PX = 300;
const FUEL_CHART_HEIGHT = 200;
const PLAY_INTERVAL_MS = 550;
/** Fixes of run-up shown before the flagged moment when the replay opens. */
const APPROACH_FIXES = 8;
const PAUSE_MOMENT_TYPES = new Set<EventReplayMoment['type']>([
  'anomaly',
  'fuel_drop',
]);

const replayMapStyle = fleetMapContainerStyle(REPLAY_MAP_MIN_HEIGHT_PX);

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-NG', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Lagos',
  });
}

function formatRange(start: string, end: string) {
  return `${formatTime(start)} → ${formatTime(end)}`;
}

function ReplayMap({
  readings,
  activeIndex,
  anomalyIndex,
  moments,
  manoeuvres,
  speedLimitKph,
}: {
  readings: EventReplayResponse['readings'];
  activeIndex: number;
  anomalyIndex: number;
  moments: EventReplayMoment[];
  manoeuvres: EventReplayManoeuvre[];
  speedLimitKph?: number | null;
}) {
  const map = useMap();

  // Readings without a fix are dropped for drawing, which shifts every later
  // position — so the manoeuvre indices, which are counted against the full
  // reading list, have to be remapped onto the drawn path or a harsh brake
  // gets painted onto the wrong corner.
  // `indexInPath[i]` is -1 for a reading that carried no fix. A plain array
  // rather than a Map because `Map` is the Google Maps component in this file.
  const { path, trackPoints, indexInPath } = useMemo(() => {
    const remap: number[] = new Array(readings.length).fill(-1);
    const pts: { lat: number; lng: number; speedKph: number }[] = [];
    readings.forEach((r, i) => {
      if (r.latitude == null || r.longitude == null) return;
      remap[i] = pts.length;
      pts.push({ lat: r.latitude, lng: r.longitude, speedKph: r.speed_kph ?? 0 });
    });
    return {
      trackPoints: pts,
      indexInPath: remap,
      path: pts.map((p) => ({ lat: p.lat, lng: p.lng })),
    };
  }, [readings]);

  const trackManoeuvres = useMemo(
    () =>
      manoeuvres
        .map((m) => ({ ...m, index: indexInPath[m.index] ?? -1 }))
        .filter((m) => m.index >= 0),
    [manoeuvres, indexInPath],
  );

  const active = readings[activeIndex];
  const activePos =
    active?.latitude != null && active?.longitude != null
      ? { lat: active.latitude, lng: active.longitude }
      : path[path.length - 1] ?? LAGOS_CENTER;

  // Same remapping as the track: `path` is indexed by drawn point, not by
  // reading, so indexing it with a reading number pointed the car down the
  // wrong bearing whenever the window contained a fix without a position.
  const mapped = indexInPath[activeIndex];
  const activePathIndex = mapped != null && mapped >= 0 ? mapped : path.length - 1;

  const heading = useMemo(() => {
    if (activePathIndex > 0 && path[activePathIndex] && path[activePathIndex - 1]) {
      const prev = path[activePathIndex - 1];
      const curr = path[activePathIndex];
      return bearingDeg(prev.lat, prev.lng, curr.lat, curr.lng);
    }
    if (path.length > 1) {
      return bearingDeg(path[0].lat, path[0].lng, path[1].lat, path[1].lng);
    }
    return 0;
  }, [activePathIndex, path]);

  const anomaly = readings[anomalyIndex];
  const anomalyPos =
    anomaly?.latitude != null && anomaly?.longitude != null
      ? { lat: anomaly.latitude, lng: anomaly.longitude }
      : null;

  const atMoment = moments.some(
    (m) => m.index === activeIndex && PAUSE_MOMENT_TYPES.has(m.type),
  );
  const nearAnomaly = Math.abs(activeIndex - anomalyIndex) <= 2 || atMoment;

  useEffect(() => {
    if (!map || !activePos) return;

    const frame = requestAnimationFrame(() => {
      map.panTo(activePos);
      map.setZoom(nearAnomaly ? 17 : 14);
      map.setTilt(45);
      google.maps.event.trigger(map, 'resize');
    });

    return () => cancelAnimationFrame(frame);
  }, [map, activePos.lat, activePos.lng, nearAnomaly]);

  return (
    <>
      <MapResizeFix />
      <SpeedGradedRoute
        points={trackPoints}
        manoeuvres={trackManoeuvres}
        speedLimitKph={speedLimitKph}
        traveledTo={activePathIndex}
      />
      {anomalyPos && (
        <AnomalyMapMarker lat={anomalyPos.lat} lng={anomalyPos.lng} />
      )}
      <VehicleCarMarker
        lat={activePos.lat}
        lng={activePos.lng}
        heading={heading}
        selected
        title="Replay position"
      />
    </>
  );
}

function FuelChart({
  readings,
  activeIndex,
  anomalyIndex,
  moments,
}: {
  readings: EventReplayResponse['readings'];
  activeIndex: number;
  anomalyIndex: number;
  moments: EventReplayMoment[];
}) {
  const fuels = readings
    .map((r) => r.fuel_level_liters)
    .filter((v): v is number => v != null);
  if (!fuels.length) {
    return (
      <p className="text-xs text-ink-dim">No fuel readings in this window</p>
    );
  }

  const min = Math.max(0, Math.min(...fuels) - 5);
  const max = Math.max(...fuels) + 5;
  const width = 640;
  const height = FUEL_CHART_HEIGHT;
  const pad = { top: 12, right: 12, bottom: 24, left: 36 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const points = readings
    .map((r, i) => {
      if (r.fuel_level_liters == null) return null;
      const x = pad.left + (i / Math.max(readings.length - 1, 1)) * innerW;
      const y =
        pad.top +
        innerH -
        ((r.fuel_level_liters - min) / Math.max(max - min, 1)) * innerH;
      return { x, y, fuel: r.fuel_level_liters, index: i };
    })
    .filter(Boolean) as { x: number; y: number; fuel: number; index: number }[];

  const line = points.map((p) => `${p.x},${p.y}`).join(' ');
  const anomalyPoint =
    points.find((p) => p.index === anomalyIndex) ??
    points[Math.floor(points.length / 2)];
  const activePoint =
    points.find((p) => p.index === activeIndex) ?? points[points.length - 1];
  const momentPoints = moments
    .filter((m) => PAUSE_MOMENT_TYPES.has(m.type))
    .map((m) => points.find((p) => p.index === m.index))
    .filter(Boolean) as typeof points;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-52 w-full min-w-[320px]"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = pad.top + innerH * (1 - t);
          const val = min + (max - min) * t;
          return (
            <g key={t}>
              <line
                x1={pad.left}
                y1={y}
                x2={width - pad.right}
                y2={y}
                stroke="#2d3449"
                strokeWidth="1"
              />
              <text x={4} y={y + 4} fill="#8e90a2" fontSize="10">
                {val.toFixed(0)}L
              </text>
            </g>
          );
        })}
        <polyline
          fill="none"
          stroke="#2e5bff"
          strokeWidth="2.5"
          points={line}
        />
        {anomalyPoint && (
          <>
            <line
              x1={anomalyPoint.x}
              y1={pad.top}
              x2={anomalyPoint.x}
              y2={height - pad.bottom}
              stroke="#ffb4ab"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <text
              x={anomalyPoint.x + 4}
              y={pad.top + 10}
              fill="#ffb4ab"
              fontSize="10"
            >
              flagged
            </text>
          </>
        )}
        {momentPoints.map((p) => (
          <circle
            key={`moment-${p.index}`}
            cx={p.x}
            cy={p.y}
            r="4"
            fill="#ffb4ab"
            opacity="0.85"
          />
        ))}
        <circle
          cx={activePoint.x}
          cy={activePoint.y}
          r="5"
          fill="#4edea3"
          stroke="#0b1326"
          strokeWidth="2"
        />
      </svg>
    </div>
  );
}

function StatusBand({
  label,
  readings,
  activeIndex,
  value,
}: {
  label: string;
  readings: EventReplayResponse['readings'];
  activeIndex: number;
  value: (r: EventReplayResponse['readings'][0]) => string;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wide text-ink-dim">
        {label}
      </p>
      <div className="flex h-6 overflow-hidden rounded border border-divider bg-canvas">
        {readings.map((r, i) => (
          <div
            key={`${label}-${i}`}
            title={value(r)}
            className={`flex-1 border-r border-panel last:border-r-0 ${
              i === activeIndex ? 'ring-1 ring-inset ring-good' : ''
            } ${i <= activeIndex ? 'bg-accent/35' : 'bg-panel'}`}
          />
        ))}
      </div>
      <p className="mt-1 font-mono text-xs text-ink">
        {value(readings[activeIndex])}
      </p>
    </div>
  );
}

function ReplayMapSection({
  readings,
  activeIndex,
  anomalyIndex,
  moments,
  manoeuvres,
  speedLimitKph,
  locationName,
}: {
  readings: EventReplayResponse['readings'];
  activeIndex: number;
  anomalyIndex: number;
  moments: EventReplayMoment[];
  manoeuvres: EventReplayManoeuvre[];
  speedLimitKph?: number | null;
  locationName?: string | null;
}) {
  const mapPath = readings.filter(
    (r) => r.latitude != null && r.longitude != null,
  );
  const mapCenter = mapPath[activeIndex] ?? mapPath[0];
  const active = readings[activeIndex];
  const atAnomaly = Math.abs(activeIndex - anomalyIndex) <= 2;

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg border border-edge bg-panel-deep"
      style={{ height: REPLAY_MAP_HEIGHT, minHeight: REPLAY_MAP_MIN_HEIGHT_PX }}
    >
      <Map
        {...fleetMapDefaults({
          defaultCenter:
            mapCenter?.latitude != null && mapCenter?.longitude != null
              ? { lat: mapCenter.latitude, lng: mapCenter.longitude }
              : LAGOS_CENTER,
          defaultZoom: 14,
          reuseMaps: true,
        })}
        style={replayMapStyle}
      >
        <ReplayMap
          readings={readings}
          activeIndex={activeIndex}
          anomalyIndex={anomalyIndex}
          moments={moments}
          manoeuvres={manoeuvres}
          speedLimitKph={speedLimitKph}
        />
      </Map>

      {/* A colour legend, because a coloured track that needs explaining in
          prose is just decoration. Manoeuvre keys appear only for the types
          actually present in this window — never as a list of what the app
          could theoretically detect. */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-edge/80 bg-canvas/90 px-3 py-2 backdrop-blur-md">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-dim">
          Speed
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-ink-mid">
          <span className="h-1 w-8 rounded-full bg-gradient-to-r from-[#4d7c3f] via-[#b5cf45] to-[#fdfbe4]" />
          slow → fast
        </span>
        {[...new Set(manoeuvres.map((m) => m.type))]
          .filter((type) => MANOEUVRE_STYLE[type])
          .map((type) => (
            <span key={type} className="flex items-center gap-1.5 text-[10px] text-ink-mid">
              <span
                className="h-1.5 w-5 rounded-full"
                style={{ backgroundColor: MANOEUVRE_STYLE[type].color }}
              />
              {MANOEUVRE_STYLE[type].label}
            </span>
          ))}
      </div>

      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 max-w-lg rounded-xl border border-edge/80 bg-canvas/90 px-4 py-3 shadow-lg backdrop-blur-md">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-dim">
          {atAnomaly ? 'At flagged moment' : 'Synchronized map'}
        </p>
        <p
          className={`mt-1 text-sm ${atAnomaly ? 'text-bad' : 'text-ink'}`}
        >
          {active
            ? `${formatTime(active.recorded_at)} · ${active.speed_kph ?? 0} km/h · ignition ${active.ignition_on ? 'ON' : 'OFF'} · ${active.fuel_level_liters?.toFixed(1) ?? '—'}L`
            : 'Scrub the timeline to move the vehicle'}
        </p>
        {locationName && (
          <p className="mt-1 flex items-center gap-1 text-xs text-ink-dim">
            <MapPin className="h-3 w-3 shrink-0" />
            {locationName}
          </p>
        )}
      </div>
    </div>
  );
}

function CorrelationGrid({
  rows,
}: {
  rows: ReturnType<typeof buildCorrelationAt>;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {rows.map((row) => (
        <div
          key={row.signal}
          className={`rounded-lg border px-3 py-2 ${
            row.tone === 'alert'
              ? 'border-bad/40 bg-bad-deep/15'
              : row.tone === 'warn'
                ? 'border-warn/30 bg-warn-deep/10'
                : 'border-edge bg-canvas'
          }`}
        >
          <p className="text-[10px] uppercase tracking-wide text-ink-dim">
            {row.signal}
          </p>
          <p className="mt-0.5 font-mono text-sm font-semibold text-ink">
            {row.state}
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-ink-dim">
            {row.detail}
          </p>
        </div>
      ))}
    </div>
  );
}

function CausalTimelineList({
  steps,
}: {
  steps: ReturnType<typeof buildCausalTimeline>;
}) {
  return (
    <ol className="relative space-y-0 border-l border-edge pl-4">
      {steps.map((step, i) => (
        <li key={`${step.time}-${i}`} className="relative pb-4 last:pb-0">
          <span
            className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-canvas ${
              step.kind === 'anomaly'
                ? 'bg-bad'
                : step.kind === 'alert'
                  ? 'bg-accent'
                  : 'bg-ink-dim'
            }`}
          />
          <p className="font-mono text-xs text-brand">
            {formatReplayClock(step.time)}
          </p>
          <p
            className={`text-sm ${
              step.kind === 'anomaly'
                ? 'font-medium text-bad'
                : 'text-ink-mid'
            }`}
          >
            {step.label}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function EventReplayPanel({
  target,
  onClose,
}: {
  target: ReplayTarget;
  onClose: () => void;
}) {
  const [data, setData] = useState<EventReplayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<number | null>(null);
  const path = replayApiPath(target);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<EventReplayResponse>(path);
      setData(result);

      // Open on the run-up, not on the event itself. Landing the scrubber
      // exactly on the flagged moment meant the manager arrived after the only
      // thing worth watching had happened, and had to drag backwards to find
      // out what led to it. Playback then starts on its own, so the answer to
      // "what did the vehicle do here" arrives without anyone hunting for a
      // Play button.
      const lead = Math.max(0, (result.anomaly_index ?? 0) - APPROACH_FIXES);
      setActiveIndex(lead);
      setPlaying((result.readings?.length ?? 0) > 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load replay');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  const readings = data?.readings ?? [];
  const anomalyIndex = data?.anomaly_index ?? 0;
  const moments = data?.moments ?? [];
  const manoeuvres = useMemo(() => data?.manoeuvres ?? [], [data]);

  useEffect(() => {
    if (!playing || !readings.length) return;
    playRef.current = window.setInterval(() => {
      setActiveIndex((prev) => {
        if (prev >= readings.length - 1) {
          setPlaying(false);
          return prev;
        }
        const next = prev + 1;
        const momentAtNext = moments.find((m) => m.index === next);
        if (momentAtNext && PAUSE_MOMENT_TYPES.has(momentAtNext.type)) {
          setPlaying(false);
        }
        return next;
      });
    }, PLAY_INTERVAL_MS);
    return () => {
      if (playRef.current) window.clearInterval(playRef.current);
    };
  }, [playing, readings.length, moments]);

  const jumpToAnomaly = () => {
    setPlaying(false);
    setActiveIndex(anomalyIndex);
  };

  const jumpToMoment = (index: number) => {
    setPlaying(false);
    setActiveIndex(index);
  };

  const intelligence = useMemo(() => {
    if (!data) return null;
    const confidence = data.anomaly.confidence_percent;
    return {
      title: anomalyDisplayTitle(data),
      primary: buildPrimaryExplanation(data, readings, anomalyIndex),
      whyFlagged: improveWhyFlagged(data, readings, anomalyIndex),
      factors: buildConfidenceFactors(data, readings, anomalyIndex),
      causal: buildCausalTimeline(data, readings, moments, anomalyIndex),
      baseline: buildBaselineComparison(readings, anomalyIndex),
      correlation: buildCorrelationAt(readings[activeIndex], data),
      actions: buildRecommendedActions(data),
      severity: severityLabel(confidence),
    };
  }, [data, readings, moments, anomalyIndex, activeIndex]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-canvas">
      <header className="flex shrink-0 items-center justify-between border-b border-edge px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-ink-mid hover:bg-panel"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
              <Truck className="h-5 w-5 text-brand" />
              {data?.vehicle_plate ?? 'Loading…'}
            </h2>
            {data && (
              <>
                <p className="text-xs text-ink-dim">
                  {data.driver_name ?? '—'} ·{' '}
                  {formatRange(data.range_start, data.range_end)}
                </p>
                <p className="mt-0.5 text-[10px] text-ink-dim">
                  {TRUST_COPY.notVerdict}
                </p>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!readings.length}
            onClick={jumpToAnomaly}
            className="hidden items-center gap-1.5 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs font-medium text-bad disabled:opacity-40 sm:inline-flex"
          >
            <Crosshair className="h-3.5 w-3.5" />
            Jump to anomaly
          </button>
          <button
            type="button"
            disabled={!readings.length}
            onClick={() => setPlaying((p) => !p)}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-y-ink disabled:opacity-40"
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {playing ? 'Pause' : 'Play timeline'}
          </button>
        </div>
      </header>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-ink-dim">
          Loading replay…
        </div>
      )}
      {error && (
        <div className="flex flex-1 items-center justify-center text-bad">
          {error}
        </div>
      )}

      {!loading && !error && data && intelligence && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-edge bg-panel p-4 md:px-6">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-dim">
              GPS trace — synced with fuel timeline
            </p>
            {!FLEET_MAPS_KEY ? (
              <div
                className="flex items-center justify-center rounded-lg border border-edge bg-canvas text-sm text-ink-dim"
                style={{
                  height: REPLAY_MAP_HEIGHT,
                  minHeight: REPLAY_MAP_MIN_HEIGHT_PX,
                }}
              >
                <div className="text-center">
                  <MapPin className="mx-auto mb-2 h-8 w-8 text-brand" />
                  Add GOOGLE_MAPS_API_KEY to show the replay map
                </div>
              </div>
            ) : (
              <APIProvider apiKey={FLEET_MAPS_KEY}>
                <ReplayMapSection
                  readings={readings}
                  activeIndex={activeIndex}
                  anomalyIndex={anomalyIndex}
                  moments={moments}
                  manoeuvres={manoeuvres}
                  speedLimitKph={data.speed_limit_kph}
                  locationName={data.location_name}
                />
              </APIProvider>
            )}
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]">
            <div className="flex min-h-0 flex-col overflow-y-auto border-b border-edge xl:border-b-0 xl:border-r">
              <div className="space-y-5 p-4 md:p-6">
                <section className="rounded-xl border border-bad/30 bg-gradient-to-br from-bad-deep/15 to-panel p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-bad">
                    What happened (operational summary)
                  </p>
                  <p className="mt-2 text-base leading-relaxed text-ink">
                    {intelligence.primary}
                  </p>
                </section>

                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                    Signal correlation (scrubber position)
                  </p>
                  <CorrelationGrid rows={intelligence.correlation} />
                </section>

                <section className="rounded-xl border border-edge bg-panel p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    {/* Not "primary evidence" — a modelled curve cannot be the
                        strongest thing in the room. The GPS trace is measured;
                        this is inferred from it. */}
                    <p className="text-sm font-semibold text-ink">
                      Tank level — modelled, not measured
                    </p>
                    <span className="font-mono text-xs text-ink-dim">
                      {readings[activeIndex]
                        ? formatTime(readings[activeIndex].recorded_at)
                        : '—'}
                    </span>
                  </div>
                  <FuelChart
                    readings={readings}
                    activeIndex={activeIndex}
                    anomalyIndex={anomalyIndex}
                    moments={moments}
                  />
                </section>

                {/* The "Detection confidence rising" panel that sat beside
                    this one has been removed. Its three rising percentages
                    were not measurements of anything — they were the final
                    score multiplied by 0.45 and 0.75 — so it showed a manager
                    certainty accruing through numbers no evidence produced. */}
                <section className="rounded-xl border border-edge bg-panel p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-dim">
                    Incident timeline (causality)
                  </p>
                  <CausalTimelineList steps={intelligence.causal} />
                </section>

                <section className="rounded-xl border border-edge bg-panel p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-dim">
                    Synchronized playback
                  </p>
                  <div className="mb-2 flex items-center justify-between text-xs text-ink-dim">
                    <span>
                      {formatTime(readings[0]?.recorded_at ?? data.range_start)}
                    </span>
                    <span className="font-mono text-ink">
                      {readings[activeIndex]
                        ? formatTime(readings[activeIndex].recorded_at)
                        : '—'}
                    </span>
                    <span>
                      {formatTime(
                        readings[readings.length - 1]?.recorded_at ??
                          data.range_end,
                      )}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(readings.length - 1, 0)}
                    value={activeIndex}
                    onChange={(e) => {
                      setPlaying(false);
                      setActiveIndex(Number(e.target.value));
                    }}
                    className="w-full accent-accent"
                  />
                  {moments.length > 0 && (
                    <div className="relative mt-2 h-3">
                      {moments.map((m) => {
                        const pct =
                          readings.length > 1
                            ? (m.index / (readings.length - 1)) * 100
                            : 50;
                        return (
                          <button
                            key={`${m.type}-${m.index}`}
                            type="button"
                            title={m.label}
                            onClick={() => jumpToMoment(m.index)}
                            style={{ left: `${pct}%` }}
                            className={`absolute top-0 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-canvas ${
                              PAUSE_MOMENT_TYPES.has(m.type)
                                ? 'bg-bad'
                                : 'bg-accent'
                            } ${m.index === activeIndex ? 'ring-2 ring-good' : ''}`}
                          />
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <StatusBand
                      label="Ignition"
                      readings={readings}
                      activeIndex={activeIndex}
                      value={(r) => (r.ignition_on ? 'ON' : 'OFF')}
                    />
                    <StatusBand
                      label="Speed"
                      readings={readings}
                      activeIndex={activeIndex}
                      value={(r) => `${r.speed_kph ?? 0} km/h`}
                    />
                  </div>
                </section>
              </div>
            </div>

            <aside className="overflow-y-auto border-edge bg-canvas p-4 md:p-6 xl:border-l">
              <div className="rounded-lg border border-bad/30 bg-bad/10 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-bad" />
                    <div>
                      <p className="font-semibold text-bad">
                        {intelligence.title}
                      </p>
                      {/* "−0.0 L" beside "Est. impact ₦52" was the same
                          quantity contradicting itself: 0.04 L rounded to one
                          decimal is a zero the naira figure disproves. Below
                          the model's resolution, say that instead. */}
                      <p className="mt-1 text-2xl font-bold text-ink">
                        {data.anomaly.liters_lost < 0.05
                          ? 'Under 0.1 L'
                          : `−${data.anomaly.liters_lost.toFixed(1)} L`}
                      </p>
                      <p className="text-sm text-ink-mid">
                        {data.anomaly.estimated_loss_ngn != null
                          ? `Est. impact ${formatNgn(data.anomaly.estimated_loss_ngn)}`
                          : 'No fuel price recorded — cannot value this'}{' '}
                        · {TRUST_COPY.requiresReview}
                      </p>
                      {/* Which rate produced that naira figure, so a manager
                          can tell a benchmark they set from a pump receipt. */}
                      {data.anomaly.price_ngn_per_liter != null && (
                        <p className="mt-0.5 text-xs text-ink-dim">
                          at {formatNgn(data.anomaly.price_ngn_per_liter)}/L
                          {data.anomaly.price_source === 'receipt'
                            ? ' from the latest receipt'
                            : ' from your benchmark price'}
                        </p>
                      )}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      intelligence.severity === 'HIGH'
                        ? 'bg-bad/20 text-bad'
                        : intelligence.severity === 'MEDIUM'
                          ? 'bg-warn/20 text-warn'
                          : 'bg-ink-dim/20 text-ink-mid'
                    }`}
                  >
                    {intelligence.severity} · {data.anomaly.confidence_percent}%
                  </span>
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-edge bg-panel p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-dim">
                  Why flagged
                </p>
                <ul className="mt-3 space-y-2">
                  {intelligence.whyFlagged.map((reason) => (
                    <li
                      key={reason}
                      className="flex gap-2 text-sm leading-relaxed text-ink-mid"
                    >
                      <span className="text-brand">•</span>
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-4 rounded-lg border border-edge bg-panel p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-dim">
                  Confidence based on
                </p>
                <ul className="mt-3 space-y-1.5">
                  {intelligence.factors.map((factor) => (
                    <li key={factor} className="text-sm text-ink-mid">
                      • {factor}
                    </li>
                  ))}
                </ul>
              </div>

              {/* The old "normal fuel drift while parked: 0.1–0.3 L/hr" was a
                  constant string, not this vehicle's figure and not derived
                  from anything. The model charges nothing at all to an
                  engine-off hop, so the honest comparison is against zero. */}
              <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-brand">
                  Compare vs expected
                </p>
                <div className="mt-3 grid gap-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-ink-dim">
                      Expected with the engine off
                    </span>
                    <span className="font-mono text-good">0.0 L</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-ink-dim">Observed during event</span>
                    <span
                      className={`font-mono font-semibold ${
                        intelligence.baseline.isAbnormal
                          ? 'text-bad'
                          : 'text-ink'
                      }`}
                    >
                      {intelligence.baseline.observed}
                    </span>
                  </div>
                </div>
                <p className="mt-2.5 text-[11px] leading-relaxed text-ink-dim">
                  The tank shown is modelled from distance driven and idle time,
                  not read from a sensor — so a drop while parked is
                  unaccounted-for rather than measured loss.
                </p>
              </div>

              {data.event_type === 'receipt_fraud' &&
                data.anomaly.declared_liters != null && (
                  <div className="mt-4 rounded-lg border border-edge bg-panel p-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-ink-dim">Receipt claimed</span>
                      <span className="font-mono text-ink">
                        {data.anomaly.declared_liters.toFixed(1)} L
                      </span>
                    </div>
                    <div className="mt-2 flex justify-between">
                      <span className="text-ink-dim">Tank rose by</span>
                      <span className="font-mono text-bad">
                        {data.anomaly.obd_liters_actual?.toFixed(1) ?? '—'} L
                      </span>
                    </div>
                  </div>
                )}

              <div className="mt-4 rounded-lg border border-good/30 bg-good/10 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-good">
                  Recommended next steps
                </p>
                <ul className="mt-3 space-y-2">
                  {intelligence.actions.map((action) => (
                    <li
                      key={action}
                      className="flex gap-2 text-sm text-ink-mid"
                    >
                      <span className="text-good">→</span>
                      {action}
                    </li>
                  ))}
                </ul>
              </div>

              {moments.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-dim">
                    Jump to moment
                  </p>
                  <ul className="space-y-2">
                    {moments.map((moment) => (
                      <li key={`${moment.type}-${moment.index}`}>
                        <button
                          type="button"
                          onClick={() => jumpToMoment(moment.index)}
                          className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                            moment.index === activeIndex
                              ? 'border-good bg-good/10 text-ink'
                              : 'border-divider bg-panel text-ink-mid hover:border-edge'
                          }`}
                        >
                          <span
                            className={
                              PAUSE_MOMENT_TYPES.has(moment.type)
                                ? 'text-bad'
                                : 'text-brand'
                            }
                          >
                            {formatTime(moment.recorded_at)}
                          </span>
                          <span className="mt-0.5 block text-ink-dim">
                            {moment.label}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}
