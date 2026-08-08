'use client';

import { useState } from 'react';
import { Fuel, ShieldCheck, ShieldAlert, X } from 'lucide-react';
import { FleetVehicle, calibrateVirtualTank } from '@/lib/api';
import { LiquidFuelGauge } from './Gauges';

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Ring gauge for the software-modelled tank. Shows model confidence and the
// last calibration anchor so a manager knows how much to trust the number,
// and lets them re-anchor it after a known fill-up.
export function VirtualFuelGauge({
  vehicle,
  onCalibrated,
}: {
  vehicle: FleetVehicle;
  onCalibrated?: () => void;
}) {
  const [calibrating, setCalibrating] = useState(false);
  const [customLiters, setCustomLiters] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isVirtual = vehicle.fuel_source === 'virtual' || vehicle.virtual_tank_liters != null;
  const capacity =
    Number(vehicle.virtual_tank_capacity_liters ?? vehicle.tank_capacity_liters) || null;
  const liters =
    vehicle.fuel_level_liters != null
      ? Number(vehicle.fuel_level_liters)
      : vehicle.virtual_tank_liters != null
        ? Number(vehicle.virtual_tank_liters)
        : null;
  const pct =
    liters != null && capacity ? Math.min(100, Math.round((liters / capacity) * 100)) : null;
  const confidence = vehicle.virtual_tank_confidence ?? null;
  const calibratedAt = vehicle.virtual_tank_calibrated_at ?? null;

  const submitCalibration = async (litersValue: number | null) => {
    setSaving(true);
    setError(null);
    try {
      await calibrateVirtualTank(vehicle.id, litersValue);
      setCalibrating(false);
      setCustomLiters('');
      onCalibrated?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-center">
      <LiquidFuelGauge
        percent={pct}
        icon={Fuel}
        size={170}
        primary={liters != null ? `${liters.toFixed(1)} L` : '—'}
        secondary={
          <span className="text-xs text-ink-dim">
            {pct != null ? `${pct}% of tank` : 'No data'}
          </span>
        }
      />

      {isVirtual && (
        <div className="mt-3 flex flex-col items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs ${
              confidence != null && confidence >= 70
                ? 'bg-good/15 text-good'
                : confidence != null && confidence >= 40
                  ? 'bg-warn/15 text-warn'
                  : 'bg-bad/15 text-bad'
            }`}
            title="Level is computed from GPS fuel-burn telemetry, not a tank sensor. Confidence decays with consumption and time since the last calibration."
          >
            {confidence != null && confidence >= 70 ? (
              <ShieldCheck className="h-3 w-3" />
            ) : (
              <ShieldAlert className="h-3 w-3" />
            )}
            Virtual model{confidence != null ? ` · ${confidence}% confidence` : ''}
          </span>
          <span className="text-[11px] text-ink-dim">
            {calibratedAt
              ? `Calibrated ${relativeTime(calibratedAt)}`
              : 'Not calibrated — set the level after a fill-up'}
          </span>
          <button
            type="button"
            onClick={() => setCalibrating(true)}
            className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-edge bg-canvas px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-brand hover:text-brand"
          >
            <Fuel className="h-3.5 w-3.5" /> Calibrate tank
          </button>
        </div>
      )}

      {calibrating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg border border-edge bg-panel p-6">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-ink">Calibrate virtual tank</h3>
                <p className="mt-1 text-xs text-ink-dim">
                  {vehicle.license_plate}
                  {capacity ? ` · ${capacity} L capacity` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCalibrating(false)}
                className="text-ink-dim hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm text-ink-mid">
              Use this right after a known refuel. The model resets to the level you
              set and confidence returns to 100%.
            </p>

            <button
              type="button"
              disabled={saving}
              onClick={() => submitCalibration(null)}
              className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-accent-y-ink transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : `Full tank${capacity ? ` (${capacity} L)` : ''}`}
            </button>

            <div className="mt-3 flex gap-2">
              <input
                type="number"
                min={0}
                max={capacity ?? undefined}
                step="0.5"
                value={customLiters}
                onChange={(e) => setCustomLiters(e.target.value)}
                placeholder="Custom litres"
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                disabled={saving || customLiters === '' || Number(customLiters) < 0}
                onClick={() => submitCalibration(Number(customLiters))}
                className="shrink-0 rounded-lg border border-edge px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
              >
                Set
              </button>
            </div>

            {error && <p className="mt-3 text-xs text-bad">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
