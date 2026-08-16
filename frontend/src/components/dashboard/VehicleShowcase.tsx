'use client';

import Link from 'next/link';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, Fuel, Gauge as GaugeIcon, MapPin, Radio, User } from 'lucide-react';
import {
  FleetVehicle,
  formatNgn,
  formatOdometerMiles,
  isInFuelReserve,
  usableFuelPercent,
} from '@/lib/api';
import { useEstimatedConsumption } from './EstimatedConsumptionTable';
import { VirtualFuelGauge } from './VirtualFuelGauge';
import { FuelLevelChart } from './FuelLevelChart';
import { VehicleSignalsTable } from './VehicleSignalsTable';
import { PowerDiagnostics } from './PowerDiagnostics';
import { VehiclePartModal } from './VehiclePartModal';
import type { HotspotId } from './Vehicle3D';
import { getVehicleSignals } from '@/lib/api';
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
 *
 * `live` distinguishes a reading from a memory. The last packet before a
 * tracker drops out is usually mid-drive — on 2026-08-10 it was 6 km/h — and
 * reporting that as "Moving" indefinitely tells a manager the vehicle is
 * running when it has been silent for half a day. The tracker's own
 * connection state already decides this everywhere else on the page, so it
 * decides it here too rather than a second staleness rule.
 */
function SpeedPanel({ speedKph, live }: { speedKph: number; live: boolean }) {
  const clamped = Math.max(0, Math.min(speedKph, SPEED_MAX_KPH));
  return (
    <Panel
      title="Speed"
      chip={
        <StatusChip tone={!live ? 'neutral' : clamped > 100 ? 'bad' : clamped > 0 ? 'good' : 'neutral'}>
          {!live ? 'No signal' : clamped > 100 ? 'High' : clamped > 0 ? 'Moving' : 'Stopped'}
        </StatusChip>
      }
      className="bg-panel-deep"
    >
      {/* A stale dial is parked at zero, not frozen at the last speed: the
          needle is the most glanceable thing on the card and must not imply
          live movement. The figure itself stays available in the caption. */}
      <SpeedGauge value={live ? clamped : 0} max={SPEED_MAX_KPH} unit="km/h" label="Speed" size={210} />
      {!live && (
        <p className="mt-2 text-center text-[11px] text-ink-dim">
          Tracker offline — last reading was {clamped} km/h
        </p>
      )}
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
  // A level and a 7-day consumption estimate are different quantities — the
  // reserve only means something against a level (litres still IN the tank),
  // so it is applied only on the sensor branch, not the estimated-used one.
  const pct = hasSensor
    ? usableFuelPercent(Number(fuelLiters), Number(tankLiters))
    : tankLiters && estimatedUsedLiters != null
      ? Math.max(0, Math.min(100, (estimatedUsedLiters / tankLiters) * 100))
      : null;
  const inReserve = hasSensor && isInFuelReserve(Number(fuelLiters));

  return (
    <Panel
      title={hasSensor ? 'Fuel level' : 'Fuel used (7d)'}
      chip={
        hasSensor ? (
          pct != null ? (
            <StatusChip tone={inReserve ? 'bad' : pct < 40 ? 'warn' : 'good'}>
              {inReserve ? 'Reserve' : `${Math.round(pct)}%`}
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
        inReserve={inReserve}
        primary={
          hasSensor
            ? `${Number(fuelLiters).toFixed(1)} L`
            : estimatedUsedLiters != null
              ? `${estimatedUsedLiters.toFixed(1)} L`
              : '—'
        }
        secondary={
          <span className={`text-[10px] ${inReserve ? 'font-semibold text-bad-bright' : 'text-ink-dim'}`}>
            {hasSensor
              ? inReserve
                ? 'In reserve — refuel soon'
                : `${Math.round(pct ?? 0)}% usable`
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
  const [openPart, setOpenPart] = useState<HotspotId | null>(null);
  // Voltages live on /vehicle-signals, not the fleet list, so the part modal
  // fetches them alongside the panel rather than inventing placeholders.
  const [volts, setVolts] = useState<{
    external: number | null;
    backup: number | null;
    percent: number | null;
  }>({ external: null, backup: null, percent: null });

  const vehicleId = vehicle?.id ?? null;
  useEffect(() => {
    if (!vehicleId) return;
    let cancelled = false;
    getVehicleSignals(vehicleId, 1)
      .then((res) => {
        if (cancelled) return;
        const pick = (id: number) => res.signals.find((x) => x.avl_id === id)?.value ?? null;
        setVolts({ external: pick(66), backup: pick(67), percent: pick(113) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vehicleId]);

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
                  {/* A dot, not a sentence. The old amber banner repeated
                      what this already says and cost a whole row. */}
                  <span
                    title={
                      vehicle.last_telemetry_at
                        ? `Last reading ${new Date(vehicle.last_telemetry_at).toLocaleString()}`
                        : 'No telemetry yet'
                    }
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-dim"
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${online ? 'bg-good' : 'bg-bad'}`}
                    />
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

            {/* Distance and week's-fuel removed: both were derived from the
                estimate endpoint's daily rows, which reported 35 km on a day
                with 0 km of telemetry and 58.2 km for a week the driver did not
                drive. Restore once those rows are verified against odometer
                deltas — a wrong number here is worse than no number. */}
          </div>

          <PowerDiagnostics
            vehicleId={vehicle.id}
            refreshKey={vehicle.last_telemetry_at ?? 0}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SpeedPanel speedKph={Number(vehicle.speed_kph ?? 0)} live={online} />
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

        </div>

        {/* 3D stage */}
        <div className="relative overflow-hidden rounded-lg border border-edge bg-panel">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_65%_55%_at_50%_38%,color-mix(in_srgb,var(--good)_7%,transparent),transparent_70%)]"
          />
          <div className="relative h-[420px] cursor-grab active:cursor-grabbing">
            <Vehicle3D
              plate={vehicle.license_plate}
              model={vehicle.model}
              onSelectHotspot={setOpenPart}
            />
            <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wider text-ink-dim">
              Drag to rotate · scroll to zoom · tap a marker for detail
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

      <VehiclePartModal
        part={openPart}
        vehicle={vehicle}
        externalVoltage={volts.external}
        backupVoltage={volts.backup}
        backupPercent={volts.percent}
        onClose={() => setOpenPart(null)}
      />
    </div>
  );
}
