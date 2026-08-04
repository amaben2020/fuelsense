'use client';

import { useMemo, useState } from 'react';
import { Clock, Droplet, Gauge, MapPin, Route, X } from 'lucide-react';
import { ServerTrip, TripStop, formatNgn } from '@/lib/api';
import { StopDetailModal } from './StopDetailModal';

const HHMM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/** Clock span only — the day is already the group heading. */
function timeRange(trip: ServerTrip): string {
  const s = new Date(trip.start_at);
  const e = new Date(trip.end_at);
  return `${s.toLocaleTimeString([], HHMM)}–${e.toLocaleTimeString([], HHMM)}`;
}

/** "Today" / "Yesterday" / "Thu 30 Jul", with the year once it stops being obvious. */
function dayLabel(d: Date): string {
  const today = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const daysApart = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000);
  if (daysApart === 0) return 'Today';
  if (daysApart === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Minutes the vehicle sat between the end of one trip and the start of the next. */
function gapMinutes(prev: ServerTrip, next: ServerTrip): number {
  const ms = new Date(next.start_at).getTime() - new Date(prev.end_at).getTime();
  return ms > 0 ? Math.round(ms / 60_000) : 0;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const STOP_DOT: Record<TripStop['kind'], string> = {
  origin: 'bg-brand',
  stop: 'bg-warn',
  destination: 'bg-bad',
};

/** Full breakdown of every trip in the window — distance, idling, estimated
 *  fuel and cost, plus each stop the driver made, openable for its address. */
export function TripDetailModal({
  trips,
  licensePlate,
  driverName,
  totals,
  onClose,
  onFocusTrip,
}: {
  trips: ServerTrip[];
  licensePlate?: string;
  driverName?: string | null;
  totals?: { distance_km: number; fuel_liters: number; cost_ngn: number };
  onClose: () => void;
  onFocusTrip?: (index: number) => void;
}) {
  const [openStop, setOpenStop] = useState<TripStop | null>(null);

  // A day is the unit a manager actually thinks in ("what did the van do on
  // Thursday?"), so trips are grouped by day and laid out as one continuous
  // timeline — days newest first, but each day reads top-down in chronological
  // order with the parked gaps between journeys shown explicitly.
  const dayGroups = useMemo(() => {
    const groups = new globalThis.Map<string, { label: string; trips: ServerTrip[] }>();

    for (const trip of [...trips].sort(
      (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
    )) {
      const d = new Date(trip.start_at);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!groups.has(key)) groups.set(key, { label: dayLabel(d), trips: [] });
      groups.get(key)!.trips.push(trip);
    }

    return [...groups.values()]
      .map((g) => ({
        ...g,
        distanceKm: g.trips.reduce((s, t) => s + t.distance_km, 0),
        fuelLiters: g.trips.reduce((s, t) => s + t.estimated_fuel_liters, 0),
        durationMinutes: g.trips.reduce((s, t) => s + t.duration_minutes, 0),
        idleMinutes: g.trips.reduce((s, t) => s + t.idle_minutes, 0),
      }))
      .reverse();
  }, [trips]);

  const totalIdle = trips.reduce((s, t) => s + t.idle_minutes, 0);
  const totalStops = trips.reduce(
    (s, t) => s + t.stops.filter((x) => x.kind === 'stop').length,
    0
  );

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        onClick={onClose}
      >
        <div
          className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-xl border border-edge bg-panel shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 border-b border-edge px-6 py-4">
            <div>
              <h3 className="font-semibold text-ink">Trip details</h3>
              <p className="text-xs text-ink-dim">
                {licensePlate}
                {driverName ? ` · ${driverName}` : ''} · {trips.length} trip
                {trips.length === 1 ? '' : 's'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-ink-dim hover:text-ink"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 border-b border-edge px-6 py-4 sm:grid-cols-4">
            <Summary icon={Route} label="Distance" value={`${totals?.distance_km ?? 0} km`} />
            <Summary icon={Clock} label="Idling" value={formatDuration(totalIdle)} tone="text-warn" />
            <Summary
              icon={Droplet}
              label="Est. fuel"
              value={`${totals?.fuel_liters ?? 0} L`}
              tone="text-good"
            />
            <Summary icon={MapPin} label="Stops" value={String(totalStops)} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {trips.length === 0 ? (
              <p className="text-sm text-ink-dim">No trips in this period.</p>
            ) : (
              <div className="space-y-6">
                {dayGroups.map((group) => (
                  <section key={group.label}>
                    {/* Day header carries the totals so the rail below is just
                        the story of how the day was spent. */}
                    <div className="sticky top-0 z-10 -mx-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 bg-panel px-6 pb-2 pt-2">
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink">
                        {group.label}
                      </h4>
                      <p className="font-mono text-[11px] text-ink-dim">
                        {group.trips.length} trip{group.trips.length === 1 ? '' : 's'} ·{' '}
                        {group.distanceKm.toFixed(1)} km ·{' '}
                        {formatDuration(group.durationMinutes)} driving
                        {group.idleMinutes > 0 && (
                          <span className="text-warn"> · {formatDuration(group.idleMinutes)} idle</span>
                        )}
                      </p>
                    </div>

                    {/* One continuous rail per day: trips and the parked gaps
                        between them hang off the same line. */}
                    <ul className="ml-2 border-l border-edge pl-4">
                      {group.trips.flatMap((trip, gi) => {
                  const realStops = trip.stops.filter((s) => s.kind === 'stop');
                  // Index into the original array, so "show on map" still points
                  // at the right trip after regrouping.
                  const i = trips.indexOf(trip);
                  const prev = gi > 0 ? group.trips[gi - 1] : null;
                  const gap = prev ? gapMinutes(prev, trip) : 0;
                  return [
                    ...(gap > 0
                      ? [
                          <li
                            key={`gap-${trip.start_at}`}
                            className="relative py-2 text-xs text-ink-dim"
                          >
                            <span className="absolute -left-[21px] top-3.5 h-1.5 w-1.5 rounded-full bg-edge" />
                            Parked {formatDuration(gap)}
                          </li>,
                        ]
                      : []),
                    <li key={trip.start_at} className="relative py-2">
                      <span className="absolute -left-[23px] top-3.5 h-2.5 w-2.5 rounded-full border-2 border-panel bg-brand" />
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-mono text-sm font-medium text-ink">{timeRange(trip)}</p>
                          <p className="mt-0.5 text-xs text-ink-dim">
                            {formatDuration(trip.duration_minutes)} · avg {trip.avg_speed_kph} km/h ·
                            top {trip.max_speed_kph} km/h
                            {trip.idle_minutes > 0 && (
                              <span className="text-warn"> · idle {trip.idle_minutes}m</span>
                            )}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-sm text-ink">{trip.distance_km} km</p>
                          <p className="font-mono text-xs text-good">
                            ~{trip.estimated_fuel_liters} L · {formatNgn(trip.estimated_cost_ngn)}
                          </p>
                        </div>
                      </div>

                      <div className="mt-2 space-y-1.5">
                        {trip.stops.map((s, si) => (
                          <button
                            key={`${s.arrived_at}-${si}`}
                            type="button"
                            onClick={() => setOpenStop(s)}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-panel-hover"
                          >
                            <span className={`h-2 w-2 shrink-0 rounded-full ${STOP_DOT[s.kind]}`} />
                            <span className="text-ink-mid">
                              {s.kind === 'origin'
                                ? 'Started'
                                : s.kind === 'destination'
                                  ? 'Ended'
                                  : 'Stopped'}
                            </span>
                            <span className="text-ink-dim">
                              {new Date(s.arrived_at).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                            {s.kind === 'stop' && (
                              <span className="text-warn">for {s.duration_minutes}m</span>
                            )}
                            <span className="ml-auto text-brand">View place →</span>
                          </button>
                        ))}
                        {realStops.length === 0 && (
                          <p className="px-2 text-xs text-ink-dim">
                            No mid-trip stops over 3 minutes.
                          </p>
                        )}
                      </div>

                      {onFocusTrip && (
                        <button
                          type="button"
                          onClick={() => {
                            onFocusTrip(i);
                            onClose();
                          }}
                          className="mt-2 text-xs font-medium text-brand hover:underline"
                        >
                          Show this trip on the map
                        </button>
                      )}
                    </li>,
                  ];
                  })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <StopDetailModal
        key={openStop ? `${openStop.arrived_at}-${openStop.lat}` : 'none'}
        stop={openStop}
        licensePlate={licensePlate}
        driverName={driverName}
        onClose={() => setOpenStop(null)}
      />
    </>
  );
}

function Summary({
  icon: Icon,
  label,
  value,
  tone = 'text-ink',
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-ink-dim">
        <Icon className="h-3 w-3" /> {label}
      </p>
      <p className={`mt-1 font-mono text-lg ${tone}`}>{value}</p>
    </div>
  );
}
