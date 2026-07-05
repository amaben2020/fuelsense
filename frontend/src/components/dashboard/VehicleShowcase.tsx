'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, Fuel, Gauge as GaugeIcon, MapPin, Radio, User } from 'lucide-react';
import { FleetVehicle, formatNgn } from '@/lib/api';
import { useEstimatedConsumption } from './EstimatedConsumptionTable';

const Truck3D = dynamic(() => import('./Truck3D').then((m) => m.Truck3D), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center text-sm text-ink-dim">
      Loading 3D vehicle…
    </div>
  ),
});

const SPEED_MAX_KPH = 160;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

function SpeedGauge({ speedKph }: { speedKph: number }) {
  const clamped = Math.max(0, Math.min(speedKph, SPEED_MAX_KPH));
  const needleDeg = 180 + (clamped / SPEED_MAX_KPH) * 180;
  const [nx, ny] = polar(110, 112, 74, needleDeg);

  return (
    <div className="rounded-lg border border-edge bg-panel-deep p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-ink-dim">Speed</p>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            clamped > 100
              ? 'bg-bad-deep/30 text-bad'
              : clamped > 0
                ? 'bg-good/10 text-good'
                : 'bg-panel-hover text-ink-dim'
          }`}
        >
          {clamped > 100 ? 'High' : clamped > 0 ? 'Moving' : 'Stopped'}
        </span>
      </div>
      <svg viewBox="0 0 220 132" className="mt-2 w-full">
        {/* colored speed bands */}
        <path d={arcPath(110, 112, 88, 180, 288)} stroke="var(--good)" strokeWidth="10" fill="none" strokeLinecap="round" opacity="0.85" />
        <path d={arcPath(110, 112, 88, 292, 333)} stroke="var(--warn)" strokeWidth="10" fill="none" strokeLinecap="round" opacity="0.85" />
        <path d={arcPath(110, 112, 88, 337, 360)} stroke="var(--bad-bright)" strokeWidth="10" fill="none" strokeLinecap="round" opacity="0.85" />
        {/* tick labels */}
        {[0, 40, 80, 120, 160].map((v) => {
          const deg = 180 + (v / SPEED_MAX_KPH) * 180;
          const [tx, ty] = polar(110, 112, 64, deg);
          return (
            <text key={v} x={tx} y={ty + 3} textAnchor="middle" fontSize="10" fill="var(--ink-dim)">
              {v}
            </text>
          );
        })}
        {/* needle */}
        <line x1="110" y1="112" x2={nx} y2={ny} stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="110" cy="112" r="7" fill="var(--panel)" stroke="var(--ink)" strokeWidth="2" />
      </svg>
      <p className="text-center font-mono text-2xl font-bold text-ink">
        {Math.round(clamped)} <span className="text-sm font-normal text-ink-dim">km/h</span>
      </p>
    </div>
  );
}

function FuelGauge({
  fuelLiters,
  tankLiters,
  estimatedUsedLiters,
  estimatedCostNgn,
}: {
  fuelLiters: number | null;
  tankLiters: number | null;
  estimatedUsedLiters: number | null;
  estimatedCostNgn: number | null;
}) {
  const hasSensor = fuelLiters != null && tankLiters != null && tankLiters > 0;
  const pct = hasSensor
    ? Math.max(0, Math.min(100, (Number(fuelLiters) / Number(tankLiters)) * 100))
    : tankLiters && estimatedUsedLiters != null
      ? Math.max(0, Math.min(100, (estimatedUsedLiters / tankLiters) * 100))
      : null;

  const circumference = 2 * Math.PI * 54;
  const frac = pct != null ? pct / 100 : 0;
  const color = hasSensor
    ? pct != null && pct < 15
      ? 'var(--bad-bright)'
      : pct != null && pct < 40
        ? 'var(--warn)'
        : 'var(--good)'
    : 'var(--good)';

  return (
    <div className="rounded-lg border border-edge bg-panel-deep p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-ink-dim">
          {hasSensor ? 'Fuel level' : 'Fuel used (7d)'}
        </p>
        {!hasSensor && (
          <span className="rounded-full bg-good/10 px-2 py-0.5 text-[10px] font-semibold text-good">
            EST
          </span>
        )}
      </div>
      <div className="relative mx-auto mt-2 h-[140px] w-[140px]">
        <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
          <circle cx="70" cy="70" r="54" stroke="var(--divider)" strokeWidth="11" fill="none" />
          {pct != null && (
            <circle
              cx="70"
              cy="70"
              r="54"
              stroke={color}
              strokeWidth="11"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${(circumference * frac).toFixed(1)} ${circumference.toFixed(1)}`}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Fuel className="h-4 w-4 text-ink-dim" />
          <p className="mt-1 font-mono text-xl font-bold text-ink">
            {hasSensor
              ? `${Number(fuelLiters).toFixed(1)} L`
              : estimatedUsedLiters != null
                ? `${estimatedUsedLiters.toFixed(1)} L`
                : '—'}
          </p>
          <p className="text-[10px] text-ink-dim">
            {hasSensor
              ? `${Math.round(pct ?? 0)}% of tank`
              : estimatedCostNgn != null
                ? `≈ ${formatNgn(estimatedCostNgn)}`
                : 'no sensor data'}
          </p>
        </div>
      </div>
    </div>
  );
}

export function VehicleShowcase({
  fleet,
  selectedVehicleId,
  onSelectVehicle,
  onOpenLive,
}: {
  fleet: FleetVehicle[];
  selectedVehicleId: string | null;
  onSelectVehicle: (id: string) => void;
  onOpenLive: (vehicleId: string) => void;
}) {
  const vehicle = useMemo(
    () => fleet.find((v) => v.id === selectedVehicleId) ?? fleet[0] ?? null,
    [fleet, selectedVehicleId]
  );
  const { data: estimate } = useEstimatedConsumption(7);

  if (!vehicle) {
    return (
      <div className="rounded-lg border border-edge bg-panel p-8 text-sm text-ink-dim">
        No vehicles yet — add a device to see the vehicle view.
      </div>
    );
  }

  const estimateRow = estimate?.vehicles.find((v) => v.vehicle_id === vehicle.id) ?? null;
  const todayRow =
    estimate?.daily
      .find((d) => d.date === new Date().toISOString().slice(0, 10))
      ?.vehicles.find((v) => v.vehicle_id === vehicle.id) ?? null;

  const online = vehicle.connection_status === 'online';
  const statusLabel =
    vehicle.connection_status === 'no_device'
      ? 'No device'
      : online
        ? vehicle.ignition_on
          ? 'Driving'
          : 'Idle'
        : 'Offline';

  return (
    <div className="space-y-6">
      {fleet.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {fleet.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelectVehicle(v.id)}
              className={`rounded-lg border px-3 py-1.5 font-mono text-xs ${
                v.id === vehicle.id
                  ? 'border-good bg-good/10 text-good'
                  : 'border-edge bg-panel text-ink-mid hover:bg-panel-hover'
              }`}
            >
              {v.license_plate}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        {/* metrics column */}
        <div className="space-y-4">
          <div className="rounded-lg border border-edge bg-panel p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-mono text-xl font-bold text-ink">{vehicle.license_plate}</h2>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      online ? 'bg-good/10 text-good' : 'bg-panel-hover text-ink-dim'
                    }`}
                  >
                    {statusLabel}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-dim">
                  {[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' · ') ||
                    'Unknown model'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenLive(vehicle.id)}
                className="rounded-lg border border-edge p-2 text-ink-mid hover:bg-panel-hover"
                aria-label="View on live map"
              >
                <MapPin className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 rounded-lg bg-panel-deep p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-mid">Distance today</span>
                <span className="font-mono font-bold text-ink">
                  {todayRow ? `${todayRow.distance_km.toLocaleString()} km` : '0 km'}
                </span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-divider">
                <div
                  className="h-full rounded-full bg-good"
                  style={{
                    width: `${Math.min(100, ((todayRow?.distance_km ?? 0) / Math.max(estimateRow?.distance_km ?? 1, 1)) * 100)}%`,
                  }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-ink-dim">
                <span>7-day total: {estimateRow ? `${estimateRow.distance_km.toLocaleString()} km` : '—'}</span>
                <span>
                  est. {estimateRow ? `${estimateRow.estimated_fuel_liters.toFixed(1)} L` : '—'} ·{' '}
                  {estimateRow ? formatNgn(estimateRow.estimated_cost_ngn) : '—'}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SpeedGauge speedKph={Number(vehicle.speed_kph ?? 0)} />
            <FuelGauge
              fuelLiters={vehicle.fuel_level_liters != null ? Number(vehicle.fuel_level_liters) : null}
              tankLiters={vehicle.tank_capacity_liters}
              estimatedUsedLiters={estimateRow?.estimated_fuel_liters ?? null}
              estimatedCostNgn={estimateRow?.estimated_cost_ngn ?? null}
            />
          </div>

          {!online && vehicle.connection_status !== 'no_device' && (
            <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn-deep/20 px-4 py-3 text-sm text-warn">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Tracker offline — showing last known values
              {vehicle.last_telemetry_at
                ? ` (${new Date(vehicle.last_telemetry_at).toLocaleString()})`
                : ''}
            </div>
          )}
        </div>

        {/* 3D stage */}
        <div className="relative overflow-hidden rounded-lg border border-edge bg-panel">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_65%_55%_at_50%_38%,color-mix(in_srgb,var(--good)_7%,transparent),transparent_70%)]"
          />
          <div className="relative h-[420px] cursor-grab active:cursor-grabbing">
            <Truck3D plate={vehicle.license_plate} model={vehicle.model} />
            <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wider text-ink-dim">
              Drag to rotate · scroll to zoom
            </p>
          </div>

          <div className="relative flex flex-wrap items-center justify-between gap-4 border-t border-edge bg-panel-deep/70 px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-panel-hover">
                <User className="h-5 w-5 text-ink-mid" />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">
                  {vehicle.driver_name || 'Unassigned driver'}
                </p>
                <p className="text-xs text-ink-dim">{statusLabel}</p>
              </div>
            </div>
            <div className="flex items-center gap-6 text-xs text-ink-dim">
              <span className="flex items-center gap-1.5">
                <GaugeIcon className="h-3.5 w-3.5" />
                {vehicle.odometer_km != null
                  ? `${Number(vehicle.odometer_km).toLocaleString()} km odo`
                  : 'odometer n/a'}
              </span>
              <span className="flex items-center gap-1.5">
                <Radio className="h-3.5 w-3.5" />
                {vehicle.last_telemetry_at
                  ? `updated ${new Date(vehicle.last_telemetry_at).toLocaleTimeString()}`
                  : 'no telemetry yet'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
