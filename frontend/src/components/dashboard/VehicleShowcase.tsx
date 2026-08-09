'use client';

import Link from 'next/link';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, Fuel, Gauge as GaugeIcon, MapPin, Radio, User } from 'lucide-react';
import { FleetVehicle, formatNgn, formatOdometerMiles } from '@/lib/api';
import { useEstimatedConsumption } from './EstimatedConsumptionTable';
import { VirtualFuelGauge } from './VirtualFuelGauge';
import { FuelLevelChart } from './FuelLevelChart';
import { VehicleSignalsTable } from './VehicleSignalsTable';
import { PowerDiagnostics } from './PowerDiagnostics';
import { LiquidFuelGauge, SpeedGauge } from './Gauges';
import { HatchBar, Panel, StatusChip } from '@/components/ui/chrome';

const Vehicle3D = dynamic(() => import('./Vehicle3D').then((m) => m.Vehicle3D), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center text-sm text-ink-dim">
      Loading 3D vehicle…
    </div>
  ),
});

const SPEED_MAX_KPH = 160;

/**
 * Speed panel. The dial itself is the shared Haulix instrument; this wrapper
 * only supplies the card and the severity chip.
 */
function SpeedPanel({ speedKph }: { speedKph: number }) {
  const clamped = Math.max(0, Math.min(speedKph, SPEED_MAX_KPH));
  return (
    <Panel
      title="Speed"
      chip={
        <StatusChip tone={clamped > 100 ? 'bad' : clamped > 0 ? 'good' : 'neutral'}>
          {clamped > 100 ? 'High' : clamped > 0 ? 'Moving' : 'Stopped'}
        </StatusChip>
      }
      className="bg-panel-deep"
    >
      <SpeedGauge value={clamped} max={SPEED_MAX_KPH} unit="km/h" label="Speed" size={210} />
    </Panel>
  );
}

/**
 * Fuel panel for vehicles with a real level reading. Falls back to the 7-day
 * estimate when no sensor is fitted, which is why the heading and the chip
 * both change — a modelled figure must never be presented as a measurement.
 */
function FuelPanel({
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

  return (
    <Panel
      title={hasSensor ? 'Fuel level' : 'Fuel used (7d)'}
      chip={
        hasSensor ? (
          pct != null ? (
            <StatusChip tone={pct < 15 ? 'bad' : pct < 40 ? 'warn' : 'good'}>
              {Math.round(pct)}%
            </StatusChip>
          ) : null
        ) : (
          <StatusChip tone="accent">EST</StatusChip>
        )
      }
      className="bg-panel-deep"
    >
      <LiquidFuelGauge
        percent={pct}
        icon={Fuel}
        size={180}
        primary={
          hasSensor
            ? `${Number(fuelLiters).toFixed(1)} L`
            : estimatedUsedLiters != null
              ? `${estimatedUsedLiters.toFixed(1)} L`
              : '—'
        }
        secondary={
          <span className="text-[10px] text-ink-dim">
            {hasSensor
              ? `${Math.round(pct ?? 0)}% of tank`
              : estimatedCostNgn != null
                ? `≈ ${formatNgn(estimatedCostNgn)}`
                : 'no sensor data'}
          </span>
        }
      />
    </Panel>
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
              {/* Today against the 7-day total, so the bar reads as "share of
                  the week's driving done today" rather than a raw distance.
                  The percentage is meaningless without saying what it is a
                  percentage OF, so the caption is not optional. */}
              <p className="mt-3 text-[11px] text-ink-dim">Share of this week&rsquo;s driving</p>
              <HatchBar
                className="mt-1.5"
                tone="good"
                value={todayRow?.distance_km ?? 0}
                max={Math.max(estimateRow?.distance_km ?? 1, 1)}
              />
              <div className="mt-3 flex items-center justify-between text-xs text-ink-dim">
                <span>7-day total: {estimateRow ? `${estimateRow.distance_km.toLocaleString()} km` : '—'}</span>
                <span>
                  est. {estimateRow ? `${estimateRow.estimated_fuel_liters.toFixed(1)} L` : '—'} ·{' '}
                  {estimateRow ? formatNgn(estimateRow.estimated_cost_ngn) : '—'}
                </span>
              </div>
            </div>
          </div>

          <PowerDiagnostics
            vehicleId={vehicle.id}
            refreshKey={vehicle.last_telemetry_at ?? 0}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SpeedPanel speedKph={Number(vehicle.speed_kph ?? 0)} />
            {vehicle.fuel_source === 'virtual' || vehicle.virtual_tank_liters != null ? (
              <Panel title="Fuel level" className="bg-panel-deep">
                <VirtualFuelGauge vehicle={vehicle} />
              </Panel>
            ) : (
              <FuelPanel
                fuelLiters={vehicle.fuel_level_liters != null ? Number(vehicle.fuel_level_liters) : null}
                tankLiters={vehicle.tank_capacity_liters}
                estimatedUsedLiters={estimateRow?.estimated_fuel_liters ?? null}
                estimatedCostNgn={estimateRow?.estimated_cost_ngn ?? null}
              />
            )}
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
            <Vehicle3D plate={vehicle.license_plate} model={vehicle.model} />
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
                {vehicle.total_odometer_km != null
                  ? `${formatOdometerMiles(vehicle.total_odometer_km)} total`
                  : vehicle.odometer_km != null
                    ? `${formatOdometerMiles(vehicle.odometer_km)} since install`
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

      <div className="rounded-lg border border-edge bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-ink">Fuel telemetry</h3>
          <p className="text-xs text-ink-dim">
            {vehicle.fuel_source === 'virtual' ? (
              <>
                <Link
                  href="/documentation/signals#fuel-level"
                  className="text-brand underline decoration-dotted underline-offset-2"
                  title="No tank sensor is fitted — this curve is modelled from the tracker's fuel-burn counter"
                >
                  Virtual tank
                </Link>{' '}
                curve from GPS fuel-burn data
              </>
            ) : (
              'Fuel level over time'
            )}{' '}
            · shaded = engine idling
          </p>
        </div>
        <div className="mt-3">
          <FuelLevelChart
            key={vehicle.id}
            vehicleId={vehicle.id}
            capacityLiters={
              vehicle.tank_capacity_liters != null
                ? Number(vehicle.tank_capacity_liters)
                : vehicle.virtual_tank_capacity_liters != null
                  ? Number(vehicle.virtual_tank_capacity_liters)
                  : null
            }
            refreshKey={vehicle.last_telemetry_at ?? 0}
          />
        </div>
      </div>

      <VehicleSignalsTable
        key={vehicle.id}
        vehicleId={vehicle.id}
        refreshKey={vehicle.last_telemetry_at ?? 0}
      />
    </div>
  );
}
