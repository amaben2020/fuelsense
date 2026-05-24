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
import { EventReplayMoment, EventReplayResponse, api, formatNgn } from '@/lib/api';
import {
  anomalyDisplayTitle,
  buildBaselineComparison,
  buildCausalTimeline,
  buildCertaintyTimeline,
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
  EmphasizedRoute,
  MapResizeFix,
  VehicleCarMarker,
} from '@/components/maps/SharedMapLayers';

const REPLAY_MAP_MIN_HEIGHT = 220;
const FUEL_CHART_HEIGHT = 200;
const PLAY_INTERVAL_MS = 550;
const PAUSE_MOMENT_TYPES = new Set<EventReplayMoment['type']>(['anomaly', 'fuel_drop']);

const replayMapStyle = fleetMapContainerStyle(REPLAY_MAP_MIN_HEIGHT);

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
}: {
  readings: EventReplayResponse['readings'];
  activeIndex: number;
  anomalyIndex: number;
  moments: EventReplayMoment[];
}) {
  const map = useMap();
  const path = useMemo(
    () =>
      readings
        .filter((r) => r.latitude != null && r.longitude != null)
        .map((r) => ({ lat: r.latitude!, lng: r.longitude! })),
    [readings]
  );

  const active = readings[activeIndex];
  const activePos =
    active?.latitude != null && active?.longitude != null
      ? { lat: active.latitude, lng: active.longitude }
      : path[path.length - 1] ?? LAGOS_CENTER;

  const heading = useMemo(() => {
    if (activeIndex > 0 && path[activeIndex] && path[activeIndex - 1]) {
      const prev = path[activeIndex - 1];
      const curr = path[activeIndex];
      return bearingDeg(prev.lat, prev.lng, curr.lat, curr.lng);
    }
    if (path.length > 1) {
      return bearingDeg(path[0].lat, path[0].lng, path[1].lat, path[1].lng);
    }
    return 0;
  }, [activeIndex, path]);

  const anomaly = readings[anomalyIndex];
  const anomalyPos =
    anomaly?.latitude != null && anomaly?.longitude != null
      ? { lat: anomaly.latitude, lng: anomaly.longitude }
      : null;

  const atMoment = moments.some(
    (m) => m.index === activeIndex && PAUSE_MOMENT_TYPES.has(m.type)
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
      <EmphasizedRoute
        path={path}
        traveledPath={path.slice(0, activeIndex + 1)}
        emphasized
      />
      {anomalyPos && <AnomalyMapMarker lat={anomalyPos.lat} lng={anomalyPos.lng} />}
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
  const fuels = readings.map((r) => r.fuel_level_liters).filter((v): v is number => v != null);
  if (!fuels.length) {
    return <p className="text-xs text-[#8e90a2]">No fuel readings in this window</p>;
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
      const y = pad.top + innerH - ((r.fuel_level_liters - min) / Math.max(max - min, 1)) * innerH;
      return { x, y, fuel: r.fuel_level_liters, index: i };
    })
    .filter(Boolean) as { x: number; y: number; fuel: number; index: number }[];

  const line = points.map((p) => `${p.x},${p.y}`).join(' ');
  const anomalyPoint = points.find((p) => p.index === anomalyIndex) ?? points[Math.floor(points.length / 2)];
  const activePoint = points.find((p) => p.index === activeIndex) ?? points[points.length - 1];
  const momentPoints = moments
    .filter((m) => PAUSE_MOMENT_TYPES.has(m.type))
    .map((m) => points.find((p) => p.index === m.index))
    .filter(Boolean) as typeof points;

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-52 w-full min-w-[320px]">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = pad.top + innerH * (1 - t);
          const val = min + (max - min) * t;
          return (
            <g key={t}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#2d3449" strokeWidth="1" />
              <text x={4} y={y + 4} fill="#8e90a2" fontSize="10">
                {val.toFixed(0)}L
              </text>
            </g>
          );
        })}
        <polyline fill="none" stroke="#2e5bff" strokeWidth="2.5" points={line} />
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
            <text x={anomalyPoint.x + 4} y={pad.top + 10} fill="#ffb4ab" fontSize="10">
              flagged
            </text>
          </>
        )}
        {momentPoints.map((p) => (
          <circle key={`moment-${p.index}`} cx={p.x} cy={p.y} r="4" fill="#ffb4ab" opacity="0.85" />
        ))}
        <circle cx={activePoint.x} cy={activePoint.y} r="5" fill="#4edea3" stroke="#0b1326" strokeWidth="2" />
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
      <p className="mb-1 text-[10px] uppercase tracking-wide text-[#8e90a2]">{label}</p>
      <div className="flex h-6 overflow-hidden rounded border border-[#2d3449] bg-[#0b1326]">
        {readings.map((r, i) => (
          <div
            key={`${label}-${i}`}
            title={value(r)}
            className={`flex-1 border-r border-[#171f33] last:border-r-0 ${
              i === activeIndex ? 'ring-1 ring-inset ring-[#4edea3]' : ''
            } ${i <= activeIndex ? 'bg-[#2e5bff]/35' : 'bg-[#171f33]'}`}
          />
        ))}
      </div>
      <p className="mt-1 font-mono text-xs text-[#dae2fd]">{value(readings[activeIndex])}</p>
    </div>
  );
}

function ReplayMapSection({
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
  const mapPath = readings.filter((r) => r.latitude != null && r.longitude != null);
  const mapCenter = mapPath[activeIndex] ?? mapPath[0];

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg border border-[#434656] bg-[#151a28]"
      style={{ minHeight: REPLAY_MAP_MIN_HEIGHT }}
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
        />
      </Map>
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
              ? 'border-[#ffb4ab]/40 bg-[#93000a]/15'
              : row.tone === 'warn'
                ? 'border-[#ffb95f]/30 bg-[#996100]/10'
                : 'border-[#434656] bg-[#0b1326]'
          }`}
        >
          <p className="text-[10px] uppercase tracking-wide text-[#8e90a2]">{row.signal}</p>
          <p className="mt-0.5 font-mono text-sm font-semibold text-[#dae2fd]">{row.state}</p>
          <p className="mt-0.5 text-[10px] leading-snug text-[#8e90a2]">{row.detail}</p>
        </div>
      ))}
    </div>
  );
}

function CausalTimelineList({ steps }: { steps: ReturnType<typeof buildCausalTimeline> }) {
  return (
    <ol className="relative space-y-0 border-l border-[#434656] pl-4">
      {steps.map((step, i) => (
        <li key={`${step.time}-${i}`} className="relative pb-4 last:pb-0">
          <span
            className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-[#0b1326] ${
              step.kind === 'anomaly'
                ? 'bg-[#ffb4ab]'
                : step.kind === 'alert'
                  ? 'bg-[#2e5bff]'
                  : 'bg-[#8e90a2]'
            }`}
          />
          <p className="font-mono text-xs text-[#b8c3ff]">{formatReplayClock(step.time)}</p>
          <p
            className={`text-sm ${
              step.kind === 'anomaly' ? 'font-medium text-[#ffb4ab]' : 'text-[#c4c5d9]'
            }`}
          >
            {step.label}
          </p>
        </li>
      ))}
    </ol>
  );
}

function CertaintyTimelineList({
  points,
}: {
  points: ReturnType<typeof buildCertaintyTimeline>;
}) {
  return (
    <ul className="space-y-2">
      {points.map((point, i) => (
        <li key={`${point.time}-${i}`} className="flex items-center justify-between gap-3 text-sm">
          <span className="font-mono text-xs text-[#b8c3ff]">{formatReplayClock(point.time)}</span>
          <div className="flex flex-1 items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#171f33]">
              <div
                className="h-full rounded-full bg-[#4edea3]"
                style={{ width: `${point.percent}%` }}
              />
            </div>
            <span className="w-10 font-mono text-xs font-semibold text-[#4edea3]">
              {point.percent}%
            </span>
          </div>
        </li>
      ))}
    </ul>
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
      setActiveIndex(result.anomaly_index ?? 0);
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
      factors: buildConfidenceFactors(data),
      causal: buildCausalTimeline(data, readings, moments, anomalyIndex),
      certainty:
        data.anomaly.certainty_timeline ??
        buildCertaintyTimeline(readings, anomalyIndex, confidence),
      baseline: data.anomaly.baseline_comparison
        ? {
            normalRange: data.anomaly.baseline_comparison.normal_range,
            observed: data.anomaly.baseline_comparison.observed_value,
            isAbnormal: true,
          }
        : buildBaselineComparison(readings, anomalyIndex),
      correlation: buildCorrelationAt(readings[activeIndex], data),
      actions: buildRecommendedActions(data),
      severity: severityLabel(confidence),
    };
  }, [data, readings, moments, anomalyIndex, activeIndex]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0b1326]">
      <header className="flex shrink-0 items-center justify-between border-b border-[#434656] px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[#c4c5d9] hover:bg-[#171f33]"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-[#dae2fd]">
              <Truck className="h-5 w-5 text-[#b8c3ff]" />
              {data?.vehicle_plate ?? 'Loading…'}
            </h2>
            {data && (
              <>
                <p className="text-xs text-[#8e90a2]">
                  {data.driver_name ?? '—'} · {formatRange(data.range_start, data.range_end)}
                </p>
                <p className="mt-0.5 text-[10px] text-[#8e90a2]">{TRUST_COPY.notVerdict}</p>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!readings.length}
            onClick={jumpToAnomaly}
            className="hidden items-center gap-1.5 rounded-lg border border-[#ffb4ab]/40 bg-[#ffb4ab]/10 px-3 py-2 text-xs font-medium text-[#ffb4ab] disabled:opacity-40 sm:inline-flex"
          >
            <Crosshair className="h-3.5 w-3.5" />
            Jump to anomaly
          </button>
          <button
            type="button"
            disabled={!readings.length}
            onClick={() => setPlaying((p) => !p)}
            className="inline-flex items-center gap-2 rounded-lg bg-[#2e5bff] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {playing ? 'Pause' : 'Play timeline'}
          </button>
        </div>
      </header>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-[#8e90a2]">Loading replay…</div>
      )}
      {error && (
        <div className="flex flex-1 items-center justify-center text-[#ffb4ab]">{error}</div>
      )}

      {!loading && !error && data && intelligence && (
        <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]">
          <div className="flex min-h-0 flex-col overflow-y-auto border-b border-[#434656] xl:border-b-0 xl:border-r">
            <div className="space-y-5 p-4 md:p-6">
              <section className="rounded-xl border border-[#ffb4ab]/30 bg-gradient-to-br from-[#93000a]/15 to-[#171f33] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#ffb4ab]">
                  What happened (operational summary)
                </p>
                <p className="mt-2 text-base leading-relaxed text-[#dae2fd]">
                  {intelligence.primary}
                </p>
              </section>

              <section>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[#8e90a2]">
                  Signal correlation (scrubber position)
                </p>
                <CorrelationGrid rows={intelligence.correlation} />
              </section>

              <section className="rounded-xl border border-[#434656] bg-[#171f33] p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[#dae2fd]">Fuel level — primary evidence</p>
                  <span className="font-mono text-xs text-[#8e90a2]">
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

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="rounded-xl border border-[#434656] bg-[#171f33] p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#8e90a2]">
                    Incident timeline (causality)
                  </p>
                  <CausalTimelineList steps={intelligence.causal} />
                </section>
                <section className="rounded-xl border border-[#434656] bg-[#171f33] p-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8e90a2]">
                    Detection confidence rising
                  </p>
                  <p className="mb-3 text-[10px] text-[#8e90a2]">
                    How certainty built as telemetry accumulated
                  </p>
                  <CertaintyTimelineList points={intelligence.certainty} />
                </section>
              </div>

              <section className="rounded-xl border border-[#434656] bg-[#171f33] p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#8e90a2]">
                  Synchronized playback
                </p>
                <div className="mb-2 flex items-center justify-between text-xs text-[#8e90a2]">
                  <span>{formatTime(readings[0]?.recorded_at ?? data.range_start)}</span>
                  <span className="font-mono text-[#dae2fd]">
                    {readings[activeIndex]
                      ? formatTime(readings[activeIndex].recorded_at)
                      : '—'}
                  </span>
                  <span>{formatTime(readings[readings.length - 1]?.recorded_at ?? data.range_end)}</span>
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
                  className="w-full accent-[#2e5bff]"
                />
                {moments.length > 0 && (
                  <div className="relative mt-2 h-3">
                    {moments.map((m) => {
                      const pct =
                        readings.length > 1 ? (m.index / (readings.length - 1)) * 100 : 50;
                      return (
                        <button
                          key={`${m.type}-${m.index}`}
                          type="button"
                          title={m.label}
                          onClick={() => jumpToMoment(m.index)}
                          style={{ left: `${pct}%` }}
                          className={`absolute top-0 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-[#0b1326] ${
                            PAUSE_MOMENT_TYPES.has(m.type)
                              ? 'bg-[#ffb4ab]'
                              : 'bg-[#2e5bff]'
                          } ${m.index === activeIndex ? 'ring-2 ring-[#4edea3]' : ''}`}
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

              <section>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[#8e90a2]">
                  Location context (secondary)
                </p>
                {!FLEET_MAPS_KEY ? (
                  <div className="rounded-lg border border-[#434656] p-4 text-center text-sm text-[#8e90a2]">
                    GPS map unavailable — add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
                  </div>
                ) : (
                  <APIProvider apiKey={FLEET_MAPS_KEY}>
                    <ReplayMapSection
                      readings={readings}
                      activeIndex={activeIndex}
                      anomalyIndex={anomalyIndex}
                      moments={moments}
                    />
                  </APIProvider>
                )}
                {data.location_name && (
                  <p className="mt-2 flex items-center gap-1 text-xs text-[#8e90a2]">
                    <MapPin className="h-3 w-3" />
                    {data.location_name}
                  </p>
                )}
              </section>
            </div>
          </div>

          <aside className="overflow-y-auto border-[#434656] bg-[#0b1326] p-4 md:p-6 xl:border-l">
            <div className="rounded-lg border border-[#ffb4ab]/30 bg-[#ffb4ab]/10 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#ffb4ab]" />
                  <div>
                    <p className="font-semibold text-[#ffb4ab]">{intelligence.title}</p>
                    <p className="mt-1 text-2xl font-bold text-[#dae2fd]">
                      −{data.anomaly.liters_lost.toFixed(1)} L
                    </p>
                    <p className="text-sm text-[#c4c5d9]">
                      Est. impact {formatNgn(data.anomaly.estimated_loss_ngn)} ·{' '}
                      {TRUST_COPY.requiresReview}
                    </p>
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    intelligence.severity === 'HIGH'
                      ? 'bg-[#ffb4ab]/20 text-[#ffb4ab]'
                      : intelligence.severity === 'MEDIUM'
                        ? 'bg-[#ffb95f]/20 text-[#ffb95f]'
                        : 'bg-[#8e90a2]/20 text-[#c4c5d9]'
                  }`}
                >
                  {intelligence.severity} · {data.anomaly.confidence_percent}%
                </span>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-[#434656] bg-[#171f33] p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#8e90a2]">
                Why flagged
              </p>
              <ul className="mt-3 space-y-2">
                {intelligence.whyFlagged.map((reason) => (
                  <li key={reason} className="flex gap-2 text-sm leading-relaxed text-[#c4c5d9]">
                    <span className="text-[#b8c3ff]">•</span>
                    {reason}
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-4 rounded-lg border border-[#434656] bg-[#171f33] p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#8e90a2]">
                Confidence based on
              </p>
              <ul className="mt-3 space-y-1.5">
                {intelligence.factors.map((factor) => (
                  <li key={factor} className="text-sm text-[#c4c5d9]">
                    • {factor}
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-4 rounded-lg border border-[#2e5bff]/30 bg-[#2e5bff]/10 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#b8c3ff]">
                Compare vs normal behavior
              </p>
              <div className="mt-3 grid gap-2 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-[#8e90a2]">Normal fuel drift while parked</span>
                  <span className="font-mono text-[#4edea3]">
                    {data.anomaly.baseline_comparison?.normal_range ??
                      intelligence.baseline.normalRange}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#8e90a2]">Observed during event</span>
                  <span
                    className={`font-mono font-semibold ${
                      intelligence.baseline.isAbnormal ? 'text-[#ffb4ab]' : 'text-[#dae2fd]'
                    }`}
                  >
                    {data.anomaly.baseline_comparison?.observed_value ??
                      intelligence.baseline.observed}
                  </span>
                </div>
              </div>
            </div>

            {data.event_type === 'receipt_fraud' && data.anomaly.declared_liters != null && (
              <div className="mt-4 rounded-lg border border-[#434656] bg-[#171f33] p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-[#8e90a2]">Receipt claimed</span>
                  <span className="font-mono text-[#dae2fd]">
                    {data.anomaly.declared_liters.toFixed(1)} L
                  </span>
                </div>
                <div className="mt-2 flex justify-between">
                  <span className="text-[#8e90a2]">OBD recorded</span>
                  <span className="font-mono text-[#ffb4ab]">
                    {data.anomaly.obd_liters_actual?.toFixed(1) ?? '—'} L
                  </span>
                </div>
              </div>
            )}

            <div className="mt-4 rounded-lg border border-[#4edea3]/30 bg-[#4edea3]/10 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#4edea3]">
                Recommended next steps
              </p>
              <ul className="mt-3 space-y-2">
                {intelligence.actions.map((action) => (
                  <li key={action} className="flex gap-2 text-sm text-[#c4c5d9]">
                    <span className="text-[#4edea3]">→</span>
                    {action}
                  </li>
                ))}
              </ul>
            </div>

            {moments.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#8e90a2]">
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
                            ? 'border-[#4edea3] bg-[#4edea3]/10 text-[#dae2fd]'
                            : 'border-[#2d3449] bg-[#171f33] text-[#c4c5d9] hover:border-[#434656]'
                        }`}
                      >
                        <span
                          className={
                            PAUSE_MOMENT_TYPES.has(moment.type)
                              ? 'text-[#ffb4ab]'
                              : 'text-[#b8c3ff]'
                          }
                        >
                          {formatTime(moment.recorded_at)}
                        </span>
                        <span className="mt-0.5 block text-[#8e90a2]">{moment.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
