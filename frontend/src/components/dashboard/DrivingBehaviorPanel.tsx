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
  Play,
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
import { EventReplayPanel } from '@/components/dashboard/EventReplayPanel';
import { ReplayTarget } from '@/lib/replay-target';
import { parseServerTime } from '@/lib/map-utils';

// A harsh brake or a swerve is a claim about how someone drove. Replaying the
// surrounding telemetry is what turns it into something you can discuss with
// the driver rather than a number to wave at them.
const REPLAYABLE_TYPES = new Set([
  'harsh_braking',
  'harsh_cornering',
  'harsh_acceleration',
  'overspeeding',
  'crash',
]);

const REFRESH_MS = 30000;

type EventFilter = 'attention' | 'all' | 'driving' | 'security' | 'trips';

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

// Raw ignition and trip edges are how the tracker talks, not what a manager
// needs to see. They stay available under "Everything" but never lead the feed.
const HOUSEKEEPING_TYPES = new Set([
  'ignition_on',
  'ignition_off',
  'trip_start',
  'trip_stop',
]);

/** An idle spell shorter than this is a junction or a queue, not a habit. */
const IDLE_ATTENTION_MINUTES = 10;
const IDLE_BURN_LPH_FALLBACK = 0.9;

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
  // A flat saturated orange card is the single most recognisable
  // "AI-generated dashboard" tell — flag events get a duller, warmer copper
  // and a thin border only, not a full tinted wash.
  warning: 'border-l-flag bg-canvas',
  critical: 'border-l-bad bg-bad-deep/20',
};

const GRADE_STYLES: Record<string, string> = {
  A: 'bg-good/20 text-good',
  B: 'bg-good/15 text-good',
  C: 'bg-warn/20 text-warn',
  D: 'bg-warn/25 text-warn',
  F: 'bg-bad/20 text-bad',
};

type FeedItem = {
  id: string;
  eventType: string;
  label: string;
  vehicleId: string | null;
  plate: string;
  driverName: string | null;
  occurredAt: string;
  severity: string;
  latitude: number | null;
  longitude: number | null;
  detail: string | null;
  /** Set for merged idle spells so the row can lead with the duration. */
  idleMinutes?: number;
  idleLiters?: number;
  needsAttention: boolean;
};

/**
 * The device reports edges — idling started, idling ended, ignition on, ignition
 * off. Rendering them one per row produced a feed that was technically complete
 * and operationally useless. This pairs each idle spell into a single row that
 * leads with how long the engine ran while parked, and marks the housekeeping
 * edges so they can be kept out of the default view.
 */
function buildFeed(events: DeviceEvent[], idleBurnLph: number): FeedItem[] {
  const chronological = [...events].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
  const openIdle = new Map<string, DeviceEvent>();
  const items: FeedItem[] = [];

  const base = (e: DeviceEvent) => ({
    vehicleId: e.vehicle_id ?? null,
    plate: e.license_plate ?? 'Unknown',
    driverName: e.driver_name ?? null,
    severity: e.severity,
    latitude: e.latitude != null ? Number(e.latitude) : null,
    longitude: e.longitude != null ? Number(e.longitude) : null,
  });

  for (const e of chronological) {
    const key = e.vehicle_id ?? 'unknown';

    if (e.event_type === 'idling_start') {
      openIdle.set(key, e);
      continue;
    }

    if (e.event_type === 'idling_end') {
      const start = openIdle.get(key);
      openIdle.delete(key);
      if (!start) continue;
      const minutes =
        (new Date(e.occurred_at).getTime() - new Date(start.occurred_at).getTime()) / 60000;
      if (minutes <= 0) continue;
      const liters = (minutes / 60) * idleBurnLph;
      items.push({
        ...base(start),
        id: `idle-${start.id}`,
        eventType: 'idling',
        label: `Idled ${formatMinutes(minutes)}`,
        occurredAt: start.occurred_at,
        detail: `Engine running while stationary · ≈${liters.toFixed(2)} L burned`,
        idleMinutes: minutes,
        idleLiters: liters,
        needsAttention: minutes >= IDLE_ATTENTION_MINUTES,
      });
      continue;
    }

    items.push({
      ...base(e),
      id: String(e.id),
      eventType: e.event_type,
      label: eventLabel(e.event_type),
      occurredAt: e.occurred_at,
      detail: eventValueDetail(e),
      needsAttention:
        !HOUSEKEEPING_TYPES.has(e.event_type) &&
        (e.severity !== 'info' || SECURITY_TYPES.has(e.event_type)),
    });
  }

  // An idle spell still running when the window ends is real and worth showing.
  for (const start of openIdle.values()) {
    items.push({
      ...base(start),
      id: `idle-open-${start.id}`,
      eventType: 'idling',
      label: 'Idling started',
      occurredAt: start.occurred_at,
      detail: 'Still idling at the end of this window',
      needsAttention: true,
    });
  }

  return items.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  );
}

function eventValueDetail(e: DeviceEvent): string | null {
  if (e.value == null) return null;
  if (e.unit === 'g') return `${Number(e.value).toFixed(2)} g`;
  if (e.unit === 'km/h') return `${Math.round(Number(e.value))} km/h`;
  return null;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

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
  const [filter, setFilter] = useState<EventFilter>('attention');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replayTarget, setReplayTarget] = useState<ReplayTarget | null>(null);

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

  const feed = useMemo(
    () => buildFeed(events, summary?.idle_burn_liters_per_hour ?? IDLE_BURN_LPH_FALLBACK),
    [events, summary]
  );

  const filteredEvents = useMemo(() => {
    if (filter === 'all') return feed;
    if (filter === 'attention') return feed.filter((e) => e.needsAttention);
    if (filter === 'driving') {
      return feed.filter((e) => DRIVING_TYPES.has(e.eventType) || e.eventType === 'idling');
    }
    const set = filter === 'security' ? SECURITY_TYPES : TRIP_TYPES;
    return feed.filter((e) => set.has(e.eventType));
  }, [feed, filter]);

  const mutedCount = feed.length - feed.filter((e) => e.needsAttention).length;

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
      {replayTarget && (
        <EventReplayPanel target={replayTarget} onClose={() => setReplayTarget(null)} />
      )}
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
          hint="Harsh manoeuvres and idling, per 100 km"
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
          <div>
            <h3 className="text-sm font-semibold text-ink">Event feed</h3>
            <p className="mt-0.5 text-xs text-ink-dim">
              {filter === 'attention' && mutedCount > 0
                ? `${mutedCount} ignition and trip edges hidden — switch to Everything to see them`
                : 'Idle spells are merged into one row with the time the engine ran'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['attention', 'Needs attention'],
                ['driving', 'Driving'],
                ['security', 'Security'],
                ['trips', 'Trips'],
                ['all', 'Everything'],
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
            {filter === 'attention'
              ? 'Nothing needs attention in this window. Switch to Everything to see the raw device feed.'
              : 'No events in this window.'}
          </p>
        ) : (
          <ul className="max-h-[28rem] divide-y divide-edge overflow-y-auto">
            {filteredEvents.map((item) => {
              const Icon =
                item.eventType === 'idling' ? Timer : EVENT_META[item.eventType]?.icon ?? Activity;
              const tone =
                item.severity === 'critical'
                  ? 'text-bad'
                  : item.eventType === 'idling'
                    ? 'text-warn'
                    : item.severity === 'warning'
                      ? 'text-flag'
                      : 'text-ink-dim';
              return (
                <li
                  key={item.id}
                  className={`flex flex-wrap items-center justify-between gap-2 border-l-2 px-6 py-3 ${
                    SEVERITY_STYLES[item.severity] ?? SEVERITY_STYLES.info
                  } ${item.needsAttention ? '' : 'opacity-60'}`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel ${tone}`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-sm text-ink">
                        <span className="font-medium">{item.plate}</span>
                        {' · '}
                        <span className={item.eventType === 'idling' ? 'text-warn' : undefined}>
                          {item.label}
                        </span>
                      </p>
                      {item.detail && (
                        <p className="text-xs text-ink-mid">{item.detail}</p>
                      )}
                      <p className="text-xs text-ink-dim">
                        {new Date(item.occurredAt).toLocaleString()}
                        {item.driverName ? ` · ${item.driverName}` : ''}
                        {item.latitude != null && item.longitude != null && (
                          <span className="ml-2 inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {item.latitude.toFixed(4)}, {item.longitude.toFixed(4)}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {REPLAYABLE_TYPES.has(item.eventType) && item.vehicleId && (
                      <button
                        type="button"
                        onClick={() =>
                          setReplayTarget({
                            kind: 'daily',
                            vehicleId: item.vehicleId!,
                            activityDate: item.occurredAt.slice(0, 10),
                            flagType: item.eventType,
                            // `occurred_at` is a naive Postgres timestamp
                            // holding UTC — "2026-08-11 15:44:49.752", no zone
                            // marker. `new Date()` reads that as *local* time,
                            // so in Lagos it shifted every event an hour early
                            // and the replay opened on the wrong stretch of the
                            // day: clicking a 15:44 harsh cornering produced a
                            // window with no cornering in it at all, captioned
                            // as though it did. Parse it as the UTC it is.
                            at: parseServerTime(item.occurredAt)?.toISOString(),
                          })
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-y-ink"
                      >
                        <Play className="h-3.5 w-3.5" /> Replay
                      </button>
                    )}
                    {onViewOnMap && item.vehicleId && (
                      <button
                        type="button"
                        onClick={() => onViewOnMap(item.vehicleId!)}
                        className="rounded-lg border border-edge bg-canvas px-3 py-1 text-xs text-ink-mid hover:bg-panel-hover"
                      >
                        View on map
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
