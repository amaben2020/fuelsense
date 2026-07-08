'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, Fuel, MapPin, Route, Timer } from 'lucide-react';
import { api, formatNgn, ServerTrip, TripsResponse, TripsVehicle } from '@/lib/api';
import { tripColor } from '@/lib/map-utils';

const PERIODS = [
  { label: 'Today', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
  { label: '30 days', minutes: 43200 },
] as const;

interface FlatTrip {
  trip: ServerTrip;
  tripIndex: number;
  vehicle: TripsVehicle;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatDayHeading(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-ink-dim">
        <Icon className="h-4 w-4" /> {label}
      </p>
      <p className={`mt-2 font-mono text-2xl font-bold ${accent ? 'text-good' : 'text-ink'}`}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-ink-dim">{detail}</p>
    </div>
  );
}

function exportCsv(flat: FlatTrip[]) {
  const header = [
    'vehicle',
    'driver',
    'date',
    'start',
    'end',
    'duration_minutes',
    'distance_km',
    'avg_speed_kph',
    'max_speed_kph',
    'idle_minutes',
    'estimated_fuel_liters',
    'estimated_cost_ngn',
  ];
  const rows = flat.map(({ trip, vehicle }) => [
    vehicle.license_plate,
    vehicle.driver_name ?? '',
    trip.start_at.slice(0, 10),
    trip.start_at.slice(11, 16),
    trip.end_at.slice(11, 16),
    trip.duration_minutes,
    trip.distance_km,
    trip.avg_speed_kph,
    trip.max_speed_kph,
    trip.idle_minutes,
    trip.estimated_fuel_liters,
    trip.estimated_cost_ngn,
  ]);
  const csv = [header, ...rows]
    .map((r) => r.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fuelsense-trips-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function TripHistoryPanel({
  onViewTrip,
}: {
  onViewTrip: (vehicleId: string, tripStartAt: string) => void;
}) {
  const [minutes, setMinutes] = useState<number>(10080);
  const [vehicleFilter, setVehicleFilter] = useState<string | null>(null);
  const [data, setData] = useState<TripsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<TripsResponse>(`/telemetry/trips?minutes=${minutes}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load trips');
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [minutes]);

  const vehicles = data?.vehicles ?? [];
  const visibleVehicles = vehicleFilter
    ? vehicles.filter((v) => v.vehicle_id === vehicleFilter)
    : vehicles;

  const flat: FlatTrip[] = useMemo(
    () =>
      visibleVehicles.flatMap((vehicle) =>
        vehicle.trips.map((trip, tripIndex) => ({ trip, tripIndex, vehicle }))
      ),
    [visibleVehicles]
  );

  const byDay = useMemo(() => {
    const map = new Map<string, FlatTrip[]>();
    for (const item of flat) {
      const day = item.trip.start_at.slice(0, 10);
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(item);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, items]) => ({
        day,
        items: items.sort((a, b) => b.trip.start_at.localeCompare(a.trip.start_at)),
      }));
  }, [flat]);

  const totals = useMemo(
    () => ({
      trips: flat.length,
      km: Math.round(flat.reduce((s, f) => s + f.trip.distance_km, 0) * 10) / 10,
      minutes: flat.reduce((s, f) => s + f.trip.duration_minutes, 0),
      fuel: Math.round(flat.reduce((s, f) => s + f.trip.estimated_fuel_liters, 0) * 10) / 10,
      cost: flat.reduce((s, f) => s + f.trip.estimated_cost_ngn, 0),
    }),
    [flat]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {vehicles.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setVehicleFilter(null)}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  vehicleFilter == null
                    ? 'border-good bg-good/10 text-good'
                    : 'border-edge bg-panel text-ink-mid hover:bg-panel-hover'
                }`}
              >
                All vehicles
              </button>
              {vehicles.map((v) => (
                <button
                  key={v.vehicle_id}
                  type="button"
                  onClick={() => setVehicleFilter(v.vehicle_id)}
                  className={`rounded-lg border px-3 py-1.5 font-mono text-xs ${
                    vehicleFilter === v.vehicle_id
                      ? 'border-good bg-good/10 text-good'
                      : 'border-edge bg-panel text-ink-mid hover:bg-panel-hover'
                  }`}
                >
                  {v.license_plate}
                </button>
              ))}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {PERIODS.map((p) => (
              <button
                key={p.minutes}
                type="button"
                onClick={() => setMinutes(p.minutes)}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  minutes === p.minutes
                    ? 'border-good bg-good/10 text-good'
                    : 'border-edge bg-panel text-ink-mid hover:bg-panel-hover'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => exportCsv(flat)}
            disabled={flat.length === 0}
            className="flex items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-1.5 text-xs text-ink-mid hover:bg-panel-hover disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Route}
          label="Trips"
          value={loading && !data ? '…' : String(totals.trips)}
          detail={`${totals.km.toLocaleString()} km covered`}
        />
        <StatCard
          icon={Timer}
          label="Driving time"
          value={loading && !data ? '…' : formatDuration(totals.minutes)}
          detail="Engine-on journey time"
        />
        <StatCard
          icon={Fuel}
          label="Estimated fuel"
          value={loading && !data ? '…' : `${totals.fuel} L`}
          detail="Driving + engine-idle burn"
          accent
        />
        <StatCard
          icon={MapPin}
          label="Estimated cost"
          value={loading && !data ? '…' : formatNgn(totals.cost)}
          detail={data ? `At ${formatNgn(data.price_per_liter_ngn)}/L` : ''}
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-edge bg-panel">
        <div className="border-b border-edge px-6 py-4">
          <h2 className="font-semibold text-ink">Trip history</h2>
          <p className="mt-1 text-xs text-ink-dim">
            A trip ends after 30+ minutes with the ignition off. Fuel figures are estimates —
            driving (distance ÷ baseline) + idle burn.
            {data?.source === 'historical'
              ? ' Nothing in this window, so the most recent journeys are shown.'
              : ''}
          </p>
        </div>

        {error && <p className="px-6 py-3 text-sm text-bad">{error}</p>}

        {loading && byDay.length === 0 ? (
          <p className="p-6 text-sm text-ink-dim">Loading trips…</p>
        ) : byDay.length === 0 ? (
          <p className="p-6 text-sm text-ink-dim">No trips in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-wider text-ink-dim">
                <tr>
                  <th className="px-6 py-3">Trip</th>
                  <th className="px-6 py-3">Vehicle</th>
                  <th className="px-6 py-3">Time</th>
                  <th className="px-6 py-3">Duration</th>
                  <th className="px-6 py-3">Distance</th>
                  <th className="px-6 py-3">Avg / top speed</th>
                  <th className="px-6 py-3">Idle</th>
                  <th className="px-6 py-3">Est. fuel</th>
                  <th className="px-6 py-3">Est. cost</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-divider text-ink-mid">
                {byDay.map(({ day, items }) => {
                  const dayKm =
                    Math.round(items.reduce((s, f) => s + f.trip.distance_km, 0) * 10) / 10;
                  const dayFuel =
                    Math.round(items.reduce((s, f) => s + f.trip.estimated_fuel_liters, 0) * 10) /
                    10;
                  const dayCost = items.reduce((s, f) => s + f.trip.estimated_cost_ngn, 0);
                  return [
                    <tr key={`day-${day}`} className="bg-panel-deep">
                      <td
                        className="px-6 py-2 text-xs font-semibold uppercase tracking-wider text-brand"
                        colSpan={4}
                      >
                        {formatDayHeading(day)}
                        <span className="ml-2 font-normal normal-case text-ink-dim">
                          {items.length} trip{items.length === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td className="px-6 py-2 font-mono text-xs text-ink-dim">{dayKm} km</td>
                      <td className="px-6 py-2" colSpan={2} />
                      <td className="px-6 py-2 font-mono text-xs text-ink-dim">{dayFuel} L</td>
                      <td className="px-6 py-2 font-mono text-xs text-ink-dim">
                        {formatNgn(dayCost)}
                      </td>
                      <td className="px-6 py-2" />
                    </tr>,
                    ...items.map(({ trip, tripIndex, vehicle }) => (
                      <tr key={`${vehicle.vehicle_id}-${trip.start_at}`}>
                        <td className="px-6 py-2.5">
                          <span className="flex items-center gap-2">
                            <span
                              className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
                              style={{ backgroundColor: tripColor(tripIndex), color: '#0b0e13' }}
                            >
                              {tripIndex + 1}
                            </span>
                            {trip.active && (
                              <span className="flex items-center gap-1 text-[10px] text-good">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" />
                                live
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-6 py-2.5 font-medium text-ink">
                          {vehicle.license_plate}
                          {vehicle.driver_name && (
                            <span className="ml-2 text-xs text-ink-dim">
                              {vehicle.driver_name}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-2.5 font-mono">
                          {formatTime(trip.start_at)}–{formatTime(trip.end_at)}
                        </td>
                        <td className="px-6 py-2.5 font-mono">
                          {formatDuration(trip.duration_minutes)}
                        </td>
                        <td className="px-6 py-2.5 font-mono text-ink">
                          {trip.distance_km} km
                        </td>
                        <td className="px-6 py-2.5 font-mono">
                          {trip.avg_speed_kph} / {trip.max_speed_kph} km/h
                        </td>
                        <td className="px-6 py-2.5 font-mono">
                          {trip.idle_minutes > 0 ? `${trip.idle_minutes}m` : '—'}
                        </td>
                        <td className="px-6 py-2.5 font-mono text-good">
                          {trip.estimated_fuel_liters} L
                        </td>
                        <td className="px-6 py-2.5 font-mono">
                          {formatNgn(trip.estimated_cost_ngn)}
                        </td>
                        <td className="px-6 py-2.5">
                          <button
                            type="button"
                            onClick={() => onViewTrip(vehicle.vehicle_id, trip.start_at)}
                            className="rounded-lg border border-edge px-2 py-1 text-xs text-ink-mid hover:bg-panel-hover"
                            title="View this trip on the live map"
                          >
                            Map
                          </button>
                        </td>
                      </tr>
                    )),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
