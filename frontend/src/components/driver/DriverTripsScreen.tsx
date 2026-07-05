'use client';

import { useEffect, useState } from 'react';
import { Calendar, Loader2, Route } from 'lucide-react';
import { DriverTripsResponse, fetchDriverTrips } from '@/lib/driver-api';

export function DriverTripsScreen() {
  const [data, setData] = useState<DriverTripsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDriverTrips(14)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load trips'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    );
  }

  if (error) {
    return <p className="rounded-xl bg-bad-deep/20 p-4 text-sm text-bad">{error}</p>;
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-edge bg-panel p-4">
        <p className="text-xs uppercase tracking-wider text-ink-dim">Last 14 days</p>
        <p className="mt-1 text-lg font-semibold text-ink">{data.license_plate}</p>
        <p className="text-xs text-ink-dim">
          {data.daily_history.reduce((s, d) => s + d.trip_count, 0)} trips ·{' '}
          {Math.round(data.daily_history.reduce((s, d) => s + d.distance_km, 0))} km ·{' '}
          {Math.round(data.daily_history.reduce((s, d) => s + d.fuel_used_liters, 0) * 10) / 10} L
          fuel
        </p>
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
          <Calendar className="h-3.5 w-3.5" /> Daily history
        </h3>
        <div className="space-y-2">
          {data.daily_history.length === 0 ? (
            <p className="text-sm text-ink-dim">No trip data yet.</p>
          ) : (
            data.daily_history.map((day) => (
              <div
                key={String(day.activity_date)}
                className="rounded-xl border border-edge bg-panel px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-ink">
                    {formatDay(String(day.activity_date))}
                  </p>
                  <span className="text-xs text-brand">{day.trip_count} trips</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                  <div>
                    <p className="text-ink-dim">Distance</p>
                    <p className="font-mono text-ink">{day.distance_km} km</p>
                  </div>
                  <div>
                    <p className="text-ink-dim">Fuel used</p>
                    <p className="font-mono text-good">{day.fuel_used_liters} L</p>
                  </div>
                  <div>
                    <p className="text-ink-dim">Idle</p>
                    <p className="font-mono text-warn">{day.idle_hours} h</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
          <Route className="h-3.5 w-3.5" /> Recent trip starts
        </h3>
        <div className="space-y-2">
          {data.recent_starts.length === 0 ? (
            <p className="text-sm text-ink-dim">No ignition-on events recorded.</p>
          ) : (
            data.recent_starts.map((trip) => (
              <div
                key={trip.started_at}
                className="flex items-center justify-between rounded-xl border border-edge bg-panel/80 px-4 py-3"
              >
                <div>
                  <p className="text-sm text-ink">
                    {new Date(trip.started_at).toLocaleString('en-NG', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZone: 'Africa/Lagos',
                    })}
                  </p>
                  {trip.odometer_km != null && (
                    <p className="text-xs text-ink-dim">
                      Odometer {trip.odometer_km.toLocaleString()} km
                    </p>
                  )}
                </div>
                {trip.latitude != null && (
                  <a
                    href={`https://www.google.com/maps?q=${trip.latitude},${trip.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-brand"
                  >
                    Map
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function formatDay(isoDate: string) {
  const d = new Date(isoDate.includes('T') ? isoDate : `${isoDate}T12:00:00`);
  return d.toLocaleDateString('en-NG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}
