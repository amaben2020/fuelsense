'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APIProvider,
  Map,
  Marker,
  Polyline,
  useMap,
} from '@vis.gl/react-google-maps';
import {
  AlertTriangle,
  ChevronLeft,
  MapPin,
  Pause,
  Play,
  Truck,
} from 'lucide-react';
import { EventReplayResponse, api, formatNgn } from '@/lib/api';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const PLAY_INTERVAL_MS = 600;

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRange(start: string, end: string) {
  return `${formatTime(start)} → ${formatTime(end)}`;
}

function ReplayMap({
  readings,
  activeIndex,
  anomalyIndex,
}: {
  readings: EventReplayResponse['readings'];
  activeIndex: number;
  anomalyIndex: number;
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
      : path[path.length - 1] ?? LAGOS;

  const anomaly = readings[anomalyIndex];
  const anomalyPos =
    anomaly?.latitude != null && anomaly?.longitude != null
      ? { lat: anomaly.latitude, lng: anomaly.longitude }
      : null;

  useEffect(() => {
    if (!map || !activePos) return;
    map.panTo(activePos);
  }, [map, activePos.lat, activePos.lng]);

  return (
    <>
      {path.length > 1 && (
        <Polyline
          path={path}
          strokeColor="#2e5bff"
          strokeOpacity={0.85}
          strokeWeight={4}
          geodesic
        />
      )}
      {path.length > 1 && (
        <Polyline
          path={path.slice(0, activeIndex + 1)}
          strokeColor="#4edea3"
          strokeOpacity={0.95}
          strokeWeight={5}
          geodesic
        />
      )}
      {anomalyPos && (
        <Marker
          position={anomalyPos}
          title="Anomaly"
          label={{ text: '⚠', color: '#ffb4ab', fontSize: '14px' }}
        />
      )}
      <Marker position={activePos} title="Replay position" />
    </>
  );
}

function FuelChart({
  readings,
  activeIndex,
  anomalyIndex,
}: {
  readings: EventReplayResponse['readings'];
  activeIndex: number;
  anomalyIndex: number;
}) {
  const fuels = readings.map((r) => r.fuel_level_liters).filter((v): v is number => v != null);
  if (!fuels.length) {
    return <p className="text-xs text-[#8e90a2]">No fuel readings in this window</p>;
  }

  const min = Math.max(0, Math.min(...fuels) - 5);
  const max = Math.max(...fuels) + 5;
  const width = 640;
  const height = 140;
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

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full min-w-[320px]">
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
              anomaly
            </text>
          </>
        )}
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

export function EventReplayPanel({
  type,
  eventId,
  onClose,
}: {
  type: 'siphon' | 'receipt';
  eventId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<EventReplayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<number | null>(null);

  const path =
    type === 'siphon'
      ? `/fuel-events/siphon-events/${eventId}/replay`
      : `/fuel-events/receipts/${eventId}/replay`;

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

  useEffect(() => {
    if (!playing || !data?.readings.length) return;
    playRef.current = window.setInterval(() => {
      setActiveIndex((prev) => {
        if (prev >= data.readings.length - 1) {
          setPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, PLAY_INTERVAL_MS);
    return () => {
      if (playRef.current) window.clearInterval(playRef.current);
    };
  }, [playing, data?.readings.length]);

  const readings = data?.readings ?? [];
  const anomalyIndex = data?.anomaly_index ?? 0;
  const mapPath = readings.filter((r) => r.latitude != null && r.longitude != null);
  const mapCenter = mapPath[activeIndex] ?? mapPath[0];

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
              <p className="text-xs text-[#8e90a2]">
                {data.driver_name ?? '—'} · {formatRange(data.range_start, data.range_end)}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!readings.length}
            onClick={() => setPlaying((p) => !p)}
            className="inline-flex items-center gap-2 rounded-lg bg-[#2e5bff] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            Replay {playing ? 'pause' : 'play'}
          </button>
        </div>
      </header>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-[#8e90a2]">Loading replay…</div>
      )}
      {error && (
        <div className="flex flex-1 items-center justify-center text-[#ffb4ab]">{error}</div>
      )}

      {!loading && !error && data && (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_320px]">
          <div className="flex min-h-0 flex-col border-b border-[#434656] lg:border-b-0 lg:border-r">
            <div className="relative min-h-[220px] flex-1 bg-[#171f33]">
              {!MAPS_KEY ? (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[#8e90a2]">
                  <div>
                    <MapPin className="mx-auto mb-2 h-8 w-8 text-[#b8c3ff]" />
                    GPS trace unavailable — add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
                    {mapCenter && (
                      <p className="mt-2 font-mono text-xs">
                        {mapCenter.latitude?.toFixed(5)}, {mapCenter.longitude?.toFixed(5)}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <APIProvider apiKey={MAPS_KEY}>
                  <Map
                    mapId={MAP_ID}
                    colorScheme="DARK"
                    defaultCenter={
                      mapCenter?.latitude != null && mapCenter?.longitude != null
                        ? { lat: mapCenter.latitude, lng: mapCenter.longitude }
                        : LAGOS
                    }
                    defaultZoom={14}
                    gestureHandling="greedy"
                    style={{ width: '100%', height: '100%' }}
                  >
                    <ReplayMap
                      readings={readings}
                      activeIndex={activeIndex}
                      anomalyIndex={anomalyIndex}
                    />
                  </Map>
                </APIProvider>
              )}
            </div>

            <div className="shrink-0 space-y-4 border-t border-[#434656] p-4">
              <div>
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
              </div>

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

              <div>
                <p className="mb-2 text-[10px] uppercase tracking-wide text-[#8e90a2]">Fuel level (OBD)</p>
                <FuelChart readings={readings} activeIndex={activeIndex} anomalyIndex={anomalyIndex} />
              </div>
            </div>
          </div>

          <aside className="overflow-y-auto p-4 md:p-6">
            <div className="rounded-lg border border-[#ffb4ab]/30 bg-[#ffb4ab]/10 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#ffb4ab]" />
                <div>
                  <p className="font-semibold text-[#ffb4ab]">{data.anomaly.type}</p>
                  <p className="mt-1 text-2xl font-bold text-[#dae2fd]">
                    −{data.anomaly.liters_lost.toFixed(1)} L
                  </p>
                  <p className="text-sm text-[#ffb4ab]">{formatNgn(data.anomaly.estimated_loss_ngn)} est. loss</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-[#c4c5d9]">
                Confidence:{' '}
                <span className="font-mono font-semibold text-[#4edea3]">
                  {data.anomaly.confidence_percent}%
                </span>
              </p>
            </div>

            {data.event_type === 'receipt_fraud' && data.anomaly.declared_liters != null && (
              <div className="mt-4 rounded-lg border border-[#434656] bg-[#171f33] p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-[#8e90a2]">Receipt claimed</span>
                  <span className="font-mono text-[#dae2fd]">{data.anomaly.declared_liters.toFixed(1)} L</span>
                </div>
                <div className="mt-2 flex justify-between">
                  <span className="text-[#8e90a2]">OBD recorded</span>
                  <span className="font-mono text-[#ffb4ab]">
                    {data.anomaly.obd_liters_actual?.toFixed(1) ?? '—'} L
                  </span>
                </div>
              </div>
            )}

            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#8e90a2]">Why flagged</p>
              <ul className="space-y-2">
                {data.anomaly.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2 text-sm text-[#c4c5d9]">
                    <span className="text-[#ffb4ab]">•</span>
                    {reason}
                  </li>
                ))}
              </ul>
            </div>

            {data.location_name && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-[#434656] bg-[#171f33] p-3 text-sm text-[#c4c5d9]">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#b8c3ff]" />
                {data.location_name}
              </div>
            )}

            <div className="mt-4 rounded-lg border border-[#434656] bg-[#171f33] p-3 text-xs text-[#8e90a2]">
              <p className="font-semibold text-[#c4c5d9]">At scrubber position</p>
              <div className="mt-2 space-y-1 font-mono">
                <p>Fuel: {readings[activeIndex]?.fuel_level_liters?.toFixed(1) ?? '—'} L</p>
                <p>Speed: {readings[activeIndex]?.speed_kph ?? 0} km/h</p>
                <p>Ignition: {readings[activeIndex]?.ignition_on ? 'ON' : 'OFF'}</p>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
