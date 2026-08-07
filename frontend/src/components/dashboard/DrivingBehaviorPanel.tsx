'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  CarFront,
  Gauge,
  MapPin,
  PlugZap,
  Radio,
  Route,
  ShieldAlert,
  Timer,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  api,
  BehaviorVehicle,
  DeviceEvent,
  DeviceEventsResponse,
  DeviceEventsSummary,
} from '@/lib/api';

const REFRESH_MS = 30000;

type EventFilter = 'all' | 'driving' | 'security' | 'trips';

const DRIVING_TYPES = new Set([
  'harsh_acceleration',
  'harsh_braking',
  'harsh_cornering',
  'overspeeding',
  'idling_start',
  'idling_end',
]);
const SECURITY_TYPES = new Set([
  'towing',
  'crash',
  'jamming_start',
  'jamming_end',
  'power_unplug',
  'power_restored',
  'geofence_enter',
  'geofence_exit',
]);
const TRIP_TYPES = new Set(['trip_start', 'trip_stop']);

const EVENT_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  harsh_acceleration: { label: 'Harsh acceleration', icon: TrendingUp },
  harsh_braking: { label: 'Harsh braking', icon: TrendingDown },
  harsh_cornering: { label: 'Harsh cornering', icon: Activity },
  overspeeding: { label: 'Overspeeding', icon: Gauge },
  idling_start: { label: 'Idling started', icon: Timer },
  idling_end: { label: 'Idling ended', icon: Timer },
  towing: { label: 'Towing detected', icon: AlertTriangle },
  crash: { label: 'Crash detected', icon: AlertTriangle },
  jamming_start: { label: 'Signal jamming', icon: Radio },
  jamming_end: { label: 'Jamming ended', icon: Radio },
  power_unplug: { label: 'Tracker unplugged', icon: PlugZap },
  power_restored: { label: 'Power restored', icon: PlugZap },
  trip_start: { label: 'Trip started', icon: Route },
  trip_stop: { label: 'Trip ended', icon: Route },
  geofence_enter: { label: 'Entered geofence', icon: MapPin },
  geofence_exit: { label: 'Left geofence', icon: MapPin },
};

const eventLabel = (type: string) =>
  EVENT_META[type]?.label ??
  type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const SEVERITY_STYLES: Record<string, string> = {
  info: 'border-l-edge bg-canvas',
  warning: 'border-l-warn bg-warn-deep/15',
  critical: 'border-l-bad bg-bad-deep/20',
};

const GRADE_STYLES: Record<string, string> = {
  A: 'bg-good/20 text-good',
  B: 'bg-good/15 text-good',
  C: 'bg-warn/20 text-warn',
  D: 'bg-warn/25 text-warn',
  F: 'bg-bad/20 text-bad',
};

function formatHours(hours: number | null | undefined): string {
  if (hours == null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  const whole = Math.floor(hours);
  const mins = Math.round((hours - whole) * 60);
  return mins > 0 ? `${whole}h ${mins}m` : `${whole}h`;
}

function scoreBarColor(score: number) {
  if (score >= 80) return 'bg-good';
  if (score >= 60) return 'bg-warn';
  return 'bg-bad';
}

function StatTile({
  label,
  value,
  hint,
  tone = 'text-ink',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <p className="text-xs uppercase tracking-wider text-ink-dim">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-dim">{hint}</p>}
    </div>
  );
}

export function countCriticalDeviceEvents(summary: DeviceEventsSummary | null): number {
  return summary?.fleet.security_events ?? 0;
}

export function DrivingBehaviorPanel({
  onViewOnMap,
}: {
  onViewOnMap?: (vehicleId: string) => void;
}) {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<DeviceEventsSummary | null>(null);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [filter, setFilter] = useState<EventFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [summaryData, eventsData] = await Promise.all([
        api<DeviceEventsSummary>(`/device-events/summary?days=${days}`),
        api<DeviceEventsResponse>(`/device-events?days=${days}&limit=150`),
      ]);
      setSummary(summaryData);
      setEvents(eventsData.events);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load device events');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  const filteredEvents = useMemo(() => {
    if (filter === 'all') return events;
    const set =
      filter === 'driving' ? DRIVING_TYPES : filter === 'security' ? SECURITY_TYPES : TRIP_TYPES;
    return events.filter((e) => set.has(e.event_type));
  }, [events, filter]);

  const vehiclesWithData = useMemo(
    () => (summary?.vehicles ?? []).filter((v) => v.total_events > 0 || v.distance_km > 0),
    [summary]
  );

  if (loading) {
    return (
      <div className="rounded-lg border border-edge bg-panel p-6 text-sm text-ink-dim">
        Loading driving behavior…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-ink">Driving behavior &amp; device events</h2>
          <p className="mt-1 text-xs text-ink-dim">
            Decoded from what the tracker actually reports — no fuel sensor required.{' '}
            <Link
              href="/documentation/signals"
              className="text-brand underline decoration-dotted underline-offset-2"
            >
              Which signals exist
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-lg border px-3 py-1.5 text-xs ${
                days === d
                  ? 'border-good bg-good/10 text-good'
                  : 'border-edge bg-panel text-ink-mid hover:bg-panel-hover'
              }`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-warn/40 bg-warn-deep/20 p-4 text-sm text-warn">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Fleet safety score"
          value={summary?.fleet.avg_score != null ? `${summary.fleet.avg_score}/100` : '—'}
          hint="Weighted harsh events per 100 km"
          tone={
            summary?.fleet.avg_score != null
              ? summary.fleet.avg_score >= 80
                ? 'text-good'
                : summary.fleet.avg_score >= 60
                  ? 'text-warn'
                  : 'text-bad'
              : 'text-ink'
          }
        />
        <StatTile
          label="Events recorded"
          value={String(summary?.fleet.total_events ?? 0)}
          hint={`Last ${days} days`}
        />
        <StatTile
          label="Security events"
          value={String(summary?.fleet.security_events ?? 0)}
          hint="Towing · crash · jamming · unplug"
          tone={(summary?.fleet.security_events ?? 0) > 0 ? 'text-bad' : 'text-good'}
        />
        <StatTile
          label="Harsh driving"
          value={String(
            (summary?.fleet.counts_by_type.harsh_acceleration ?? 0) +
              (summary?.fleet.counts_by_type.harsh_braking ?? 0) +
              (summary?.fleet.counts_by_type.harsh_cornering ?? 0)
          )}
          hint="Acceleration · braking · cornering"
        />
        {/* Idling is charged by the hour, not by the event — a forty-minute
            wait and a traffic light are not the same thing. */}
        <StatTile
          label="Time idling"
          value={formatHours(summary?.fleet.idle_hours)}
          hint={
            summary?.fleet.idle_fuel_liters
              ? `≈${summary.fleet.idle_fuel_liters.toFixed(1)} L burned parked with the engine on`
              : 'Engine on, vehicle stationary'
          }
          tone={(summary?.fleet.idle_hours ?? 0) >= 1 ? 'text-warn' : 'text-ink'}
        />
      </div>

      <div className="rounded-lg border border-edge bg-panel">
        <div className="border-b border-edge px-6 py-4">
          <h3 className="text-sm font-semibold text-ink">Driver scores</h3>
          <p className="mt-0.5 text-xs text-ink-dim">
            100 = clean driving. Crashes, overspeeding and harsh maneuvers deduct points per
            100 km, as does idling beyond the first 30 minutes.
          </p>
        </div>
        {vehiclesWithData.length === 0 ? (
          <p className="px-6 py-8 text-sm text-ink-dim">
            No scenario events. These are computed inside the tracker and only sent when
            the Eco/Green Driving, Overspeeding and Idling scenarios are switched on in its
            configuration — this fleet&apos;s devices have them off, so nothing arrives to
            score.{' '}
            <Link
              href="/documentation/signals#scenario-events"
              className="text-brand underline decoration-dotted underline-offset-2"
            >
              What it takes to enable them
            </Link>
          </p>
        ) : (
          <ul className="divide-y divide-edge">
            {vehiclesWithData.map((v: BehaviorVehicle) => (
              <li key={v.vehicle_id} className="px-6 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <CarFront className="h-5 w-5 text-ink-dim" />
                    <div>
                      <p className="font-medium text-ink">{v.license_plate ?? 'Unknown'}</p>
                      <p className="text-xs text-ink-dim">
                        {v.driver_name ?? 'Unassigned'} · {v.distance_km} km
                        {v.idle_hours != null && v.idle_hours > 0 && (
                          <span className={v.idle_hours >= 1 ? 'text-warn' : undefined}>
                            {' · '}
                            {formatHours(v.idle_hours)} idling
                            {v.idle_fuel_liters ? ` (≈${v.idle_fuel_liters.toFixed(1)} L)` : ''}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {v.security_events > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-bad/20 px-2 py-0.5 text-xs text-bad">
                        <ShieldAlert className="h-3 w-3" /> {v.security_events} security
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-sm font-bold ${GRADE_STYLES[v.grade] ?? 'bg-ink-dim/20 text-ink-mid'}`}
                    >
                      {v.grade}
                    </span>
                    <span className="w-14 text-right font-mono text-sm text-ink">
                      {v.score}/100
                    </span>
                  </div>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas">
                  <div
                    className={`h-full rounded-full ${scoreBarColor(v.score)}`}
                    style={{ width: `${v.score}%` }}
                  />
                </div>
                {v.total_events > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(v.counts)
                      .sort(([, a], [, b]) => b - a)
                      .map(([type, count]) => (
                        <span
                          key={type}
                          className="rounded-full border border-edge bg-canvas px-2 py-0.5 text-xs text-ink-mid"
                        >
                          {eventLabel(type)} × {count}
                        </span>
                      ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-edge bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-6 py-4">
          <h3 className="text-sm font-semibold text-ink">Event feed</h3>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['all', 'All'],
                ['driving', 'Driving'],
                ['security', 'Security'],
                ['trips', 'Trips'],
              ] as [EventFilter, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  filter === id
                    ? 'border-good bg-good/10 text-good'
                    : 'border-edge bg-canvas text-ink-mid hover:bg-panel-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {filteredEvents.length === 0 ? (
          <p className="px-6 py-8 text-sm text-ink-dim">
            No events in this window.
          </p>
        ) : (
          <ul className="max-h-[28rem] divide-y divide-edge overflow-y-auto">
            {filteredEvents.map((event) => {
              const Icon = EVENT_META[event.event_type]?.icon ?? Activity;
              return (
                <li
                  key={event.id}
                  className={`flex flex-wrap items-center justify-between gap-2 border-l-2 px-6 py-3 ${SEVERITY_STYLES[event.severity] ?? SEVERITY_STYLES.info}`}
                >
                  <div className="flex items-center gap-3">
                    <Icon
                      className={`h-4 w-4 ${
                        event.severity === 'critical'
                          ? 'text-bad'
                          : event.severity === 'warning'
                            ? 'text-warn'
                            : 'text-ink-dim'
                      }`}
                    />
                    <div>
                      <p className="text-sm text-ink">
                        <span className="font-medium">{event.license_plate ?? 'Unknown'}</span>
                        {' · '}
                        {eventLabel(event.event_type)}
                        {event.value != null && event.unit === 'g' && (
                          <span className="ml-1 text-ink-mid">({Number(event.value).toFixed(2)} g)</span>
                        )}
                        {event.value != null && event.unit === 'km/h' && (
                          <span className="ml-1 text-ink-mid">({Math.round(Number(event.value))} km/h)</span>
                        )}
                      </p>
                      <p className="text-xs text-ink-dim">
                        {new Date(event.occurred_at).toLocaleString()}
                        {event.driver_name ? ` · ${event.driver_name}` : ''}
                        {event.latitude != null && event.longitude != null && (
                          <span className="ml-2 inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {Number(event.latitude).toFixed(4)}, {Number(event.longitude).toFixed(4)}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  {onViewOnMap && event.vehicle_id && (
                    <button
                      type="button"
                      onClick={() => onViewOnMap(event.vehicle_id!)}
                      className="shrink-0 rounded-lg border border-edge bg-canvas px-3 py-1 text-xs text-ink-mid hover:bg-panel-hover"
                    >
                      View on map
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
