'use client';

import { useEffect, useState } from 'react';
import { Fuel, Gauge, Loader2, MapPin, Navigation } from 'lucide-react';
import { DriverVehicleStatus, fetchDriverVehicleStatus } from '@/lib/driver-api';

export function DriverVehicleScreen() {
  const [status, setStatus] = useState<DriverVehicleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setStatus(await fetchDriverVehicleStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load vehicle');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !status) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    );
  }

  if (error && !status) {
    return <p className="rounded-xl bg-bad-deep/20 p-4 text-sm text-bad">{error}</p>;
  }

  if (!status) return null;

  const fuelPct =
    status.fuel_level_liters != null && status.tank_capacity_liters
      ? Math.min(100, Math.round((status.fuel_level_liters / status.tank_capacity_liters) * 100))
      : null;

  const mapsUrl =
    status.latitude != null && status.longitude != null
      ? `https://www.google.com/maps?q=${status.latitude},${status.longitude}`
      : null;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-edge bg-panel p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-dim">Your vehicle</p>
            <p className="mt-1 text-2xl font-bold text-ink">{status.license_plate}</p>
            <p className="text-sm text-ink-dim">
              {[status.make, status.model].filter(Boolean).join(' ') || 'Assigned vehicle'}
            </p>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              status.connection_status === 'online'
                ? 'bg-good/20 text-good'
                : 'bg-bad/20 text-bad'
            }`}
          >
            {status.connection_status}
          </span>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <StatCard
            icon={Fuel}
            label="Fuel in tank"
            value={
              status.fuel_level_liters != null
                ? `${status.fuel_level_liters.toFixed(1)} L`
                : '—'
            }
            accent="text-good"
            sub={fuelPct != null ? `${fuelPct}% of tank` : undefined}
          />
          <StatCard
            icon={Gauge}
            label="Speed"
            value={status.speed_kph != null ? `${status.speed_kph} km/h` : '—'}
            accent="text-brand"
            sub={status.ignition_on ? 'Engine on' : 'Engine off'}
          />
          <StatCard
            icon={Navigation}
            label="Odometer"
            value={
              status.odometer_km != null
                ? `${status.odometer_km.toLocaleString()} km`
                : '—'
            }
            accent="text-ink"
          />
          <StatCard
            icon={MapPin}
            label="Last GPS"
            value={
              status.recorded_at
                ? new Date(status.recorded_at).toLocaleTimeString('en-NG', {
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZone: 'Africa/Lagos',
                  })
                : '—'
            }
            accent="text-warn"
            sub={
              status.latitude != null
                ? `${status.latitude.toFixed(4)}, ${status.longitude?.toFixed(4)}`
                : undefined
            }
          />
        </div>

        {fuelPct != null && (
          <div className="mt-5">
            <div className="mb-1 flex justify-between text-xs text-ink-dim">
              <span>Tank level</span>
              <span>{fuelPct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-gradient-to-r from-good to-accent"
                style={{ width: `${fuelPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {mapsUrl && (
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-2xl border border-accent/40 bg-accent/15 py-4 text-sm font-medium text-brand"
        >
          <MapPin className="h-4 w-4" /> Open location in Maps
        </a>
      )}

      <p className="text-center text-[10px] text-ink-dim">
        Updates every 5s from FMC150 telemetry
        {status.last_seen_at &&
          ` · last device ping ${new Date(status.last_seen_at).toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos' })}`}
      </p>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
  sub,
}: {
  icon: typeof Fuel;
  label: string;
  value: string;
  accent: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl bg-canvas p-3">
      <Icon className={`mb-2 h-4 w-4 ${accent}`} />
      <p className="text-[10px] uppercase tracking-wider text-ink-dim">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold ${accent}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-ink-dim">{sub}</p>}
    </div>
  );
}
