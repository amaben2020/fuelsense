'use client';

import { useState } from 'react';
import { Clock, Droplet, Gauge, MapPin, Route, X } from 'lucide-react';
import { ServerTrip, TripStop, formatNgn } from '@/lib/api';
import { StopDetailModal } from './StopDetailModal';

function timeRange(trip: ServerTrip): string {
  const s = new Date(trip.start_at);
  const e = new Date(trip.end_at);
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  return `${s.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${s.toLocaleTimeString([], opts)}–${e.toLocaleTimeString([], opts)}`;
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
              <ul className="space-y-4">
                {trips.map((trip, i) => {
                  const realStops = trip.stops.filter((s) => s.kind === 'stop');
                  return (
                    <li key={trip.start_at} className="rounded-lg border border-edge bg-canvas p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium text-ink">{timeRange(trip)}</p>
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

                      <div className="mt-3 space-y-1.5">
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
                          className="mt-3 text-xs font-medium text-brand hover:underline"
                        >
                          Show this trip on the map
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
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
