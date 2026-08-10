'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { BatteryCharging, Plug, TriangleAlert } from 'lucide-react';
import { VehicleSignal, getVehicleSignals } from '@/lib/api';
import { Panel, StatusChip } from '@/components/ui/chrome';
import type { ChargeTone } from './Battery3D';

const Battery3D = dynamic(() => import('./Battery3D').then((m) => m.Battery3D), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

// AVL elements this panel reads. All four are already decoded server-side by
// avl-catalogue.ts — /vehicle-signals is driven by the frame, not a fixed
// column set, so enabling them in the Configurator is the only step needed.
const EXTERNAL_VOLTAGE = 66;
const BACKUP_VOLTAGE = 67;
const BACKUP_CURRENT = 68;
const BACKUP_LEVEL = 113;

// FMC150 internal backup cell is a 170 mAh Li-Ion: ~3.5 V flat, ~4.2 V full.
const BACKUP_EMPTY_V = 3.5;
const BACKUP_FULL_V = 4.2;

/** Reads a 12 V lead-acid rail and says what the number actually means. */
function externalVerdict(volts: number): { label: string; tone: ChargeTone } {
  if (volts >= 13.2) return { label: 'Alternator charging', tone: 'good' };
  if (volts >= 12.4) return { label: 'Healthy · engine off', tone: 'good' };
  if (volts >= 11.8) return { label: 'Low charge', tone: 'warn' };
  if (volts >= 6) return { label: 'Weak — check battery', tone: 'bad' };
  return { label: 'Disconnected or cranking', tone: 'bad' };
}

function signalValue(signals: VehicleSignal[], avlId: number): number | null {
  const hit = signals.find((s) => s.avl_id === avlId);
  return hit?.value ?? null;
}

export function PowerDiagnostics({
  vehicleId,
  refreshKey,
}: {
  vehicleId: string;
  refreshKey?: string | number;
}) {
  // Loaded data is tagged with the request it answers, so `loading` is derived
  // rather than reset synchronously inside the effect — a stale panel from the
  // previously selected vehicle never renders as if it were current.
  const requestKey = `${vehicleId}:${refreshKey ?? ''}`;
  const [loaded, setLoaded] = useState<{ key: string; signals: VehicleSignal[] } | null>(null);
  const loading = loaded?.key !== requestKey;
  const signals = loaded?.key === requestKey ? loaded.signals : null;

  useEffect(() => {
    let cancelled = false;
    getVehicleSignals(vehicleId, 1)
      .then((res) => {
        if (!cancelled) setLoaded({ key: requestKey, signals: res.signals });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: requestKey, signals: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [vehicleId, requestKey]);

  const power = useMemo(() => {
    const list = signals ?? [];
    const external = signalValue(list, EXTERNAL_VOLTAGE);
    const backupV = signalValue(list, BACKUP_VOLTAGE);
    const backupPct = signalValue(list, BACKUP_LEVEL);
    const currentMa = signalValue(list, BACKUP_CURRENT);

    // Prefer the device's own percentage; fall back to the voltage curve.
    const charge =
      backupPct != null
        ? Math.max(0, Math.min(1, backupPct / 100))
        : backupV != null
          ? Math.max(
              0,
              Math.min(1, (backupV - BACKUP_EMPTY_V) / (BACKUP_FULL_V - BACKUP_EMPTY_V))
            )
          : null;

    const verdict = external != null ? externalVerdict(external) : null;

    // 12 V lead-acid state of charge: ~11.8 V flat, ~12.7 V rested full. Above
    // 13.2 V the alternator is driving the rail, so it is pinned full rather
    // than reported as >100%.
    const externalCharge =
      external == null
        ? null
        : Math.max(0, Math.min(1, (external - 11.8) / (12.7 - 11.8)));
    const externalTone: ChargeTone =
      external == null
        ? 'unknown'
        : external >= 12.4
          ? 'good'
          : external >= 11.8
            ? 'warn'
            : 'bad';
    const tone: ChargeTone =
      charge == null ? 'unknown' : charge >= 0.55 ? 'good' : charge >= 0.25 ? 'warn' : 'bad';

    return {
      external,
      backupV,
      backupPct,
      currentMa,
      charge,
      verdict,
      tone,
      externalCharge,
      externalTone,
      // Current into the cell means it is topping up off vehicle power.
      charging: currentMa != null && currentMa > 0,
      reported: external != null || backupV != null,
    };
  }, [signals]);

  return (
    <Panel
      icon={Plug}
      title="Power diagnostics"
      chip={
        power.verdict ? (
          <StatusChip tone={power.verdict.tone === 'unknown' ? 'neutral' : power.verdict.tone}>
            {power.verdict.label}
          </StatusChip>
        ) : undefined
      }
      className="bg-panel-deep"
    >
      <p className="-mt-1 mb-3 text-xs text-ink-dim">
        Two separate batteries. The vehicle&rsquo;s starts the engine; the tracker&rsquo;s keeps
        reporting if that one is disconnected.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Vehicle 12 V block */}
        <div className="rounded-xl border border-edge bg-panel-deep p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
            Vehicle battery
          </p>
          <p className="mt-0.5 text-[10px] text-ink-dim">12 V lead-acid · starts the engine</p>
          <div className="mt-1 h-[120px]">
            <Battery3D
              variant="vehicle"
              charge={power.externalCharge}
              tone={power.externalTone}
              charging={power.external != null && power.external >= 13.2}
            />
          </div>
          <p className="text-2xl font-bold tabular-nums text-ink">
            {power.external != null ? `${power.external.toFixed(2)} V` : '—'}
          </p>
          {power.verdict && (
            <p className="mt-0.5 text-[11px] text-ink-mid">{power.verdict.label}</p>
          )}
        </div>

        {/* Tracker backup cell */}
        <div className="rounded-xl border border-edge bg-panel-deep p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
            Tracker backup cell
          </p>
          <p className="mt-0.5 text-[10px] text-ink-dim">
            Li-ion inside the FMC150 · survives power cuts
          </p>
          <div className="mt-1 h-[120px]">
            <Battery3D
              variant="cell"
              charge={power.charge}
              tone={power.tone}
              charging={power.charging}
            />
          </div>
          <p className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-ink">
              {power.backupV != null ? `${power.backupV.toFixed(2)} V` : '—'}
            </span>
            {power.charge != null && (
              <span className="text-xs tabular-nums text-ink-mid">
                {Math.round(power.charge * 100)}%
              </span>
            )}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-mid">
            {power.charging && <BatteryCharging className="h-3.5 w-3.5 text-brand" />}
            {power.currentMa != null
              ? power.charging
                ? `Charging · ${power.currentMa} mA`
                : `${power.currentMa} mA · no current flowing`
              : '—'}
          </p>
        </div>
      </div>

      {/* The elements are decoded the moment they arrive, so a missing reading
          is always a device-side configuration gap — say so explicitly rather
          than rendering a dead gauge. */}
      {!loading && !power.reported && (
        <div className="mt-4 flex gap-2.5 rounded-lg border border-warn/40 bg-warn-deep/20 px-3 py-2.5 text-xs text-warn">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Not reported by this tracker. Enable <strong>External Voltage</strong> (66) and{' '}
            <strong>Battery Voltage</strong> (67) at Low priority in Configurator → I/O settings —
            no backend change is needed, they decode automatically once they arrive.
          </span>
        </div>
      )}
    </Panel>
  );
}
