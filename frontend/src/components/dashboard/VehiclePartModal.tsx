'use client';

import dynamic from 'next/dynamic';
import { X } from 'lucide-react';
import { Fuel } from 'lucide-react';
import { FleetVehicle } from '@/lib/api';
import { LiquidFuelGauge } from './Gauges';
import type { HotspotId } from './Vehicle3D';

const Battery3D = dynamic(() => import('./Battery3D').then((m) => m.Battery3D), { ssr: false });
const Tracker3D = dynamic(() => import('./Tracker3D').then((m) => m.Tracker3D), { ssr: false });

/**
 * Detail sheet for a part clicked on the 3D vehicle.
 *
 * Each part gets the model that part actually is — a lead-acid block for the
 * engine bay, the FMC150 brick for the tracker — rather than a generic icon,
 * so the picture confirms you clicked what you meant to click.
 */
export function VehiclePartModal({
  part,
  vehicle,
  externalVoltage,
  backupVoltage,
  backupPercent,
  onClose,
}: {
  part: HotspotId | null;
  vehicle: FleetVehicle;
  externalVoltage: number | null;
  backupVoltage: number | null;
  backupPercent: number | null;
  onClose: () => void;
}) {
  if (!part) return null;

  const online = vehicle.connection_status === 'online';

  const content: Record<
    HotspotId,
    { title: string; subtitle: string; body: string; rows: [string, string][]; visual: React.ReactNode }
  > = {
    engine: {
      title: '12 V vehicle battery',
      subtitle: 'Engine bay',
      body:
        'The battery that starts the engine and powers the tracker. The tracker reads its voltage on every fix, which is why a failing battery shows up here before it strands anyone. Around 12.4–12.7 V rested, 13.5–14.5 V with the engine running and the alternator charging.',
      rows: [
        ['Reading', externalVoltage != null ? `${externalVoltage.toFixed(2)} V` : 'Not reported'],
        ['Source', 'Tracker AVL 66 — External Voltage'],
        ['Healthy range', '12.4 V rested · 13.5–14.5 V running'],
      ],
      visual: (
        <Battery3D
          variant="vehicle"
          charge={
            externalVoltage == null
              ? null
              : Math.max(0, Math.min(1, (externalVoltage - 11.8) / (12.7 - 11.8)))
          }
          tone={
            externalVoltage == null
              ? 'unknown'
              : externalVoltage >= 12.4
                ? 'good'
                : externalVoltage >= 11.8
                  ? 'warn'
                  : 'bad'
          }
          charging={externalVoltage != null && externalVoltage >= 13.2}
        />
      ),
    },
    tracker: {
      title: 'Teltonika FMC150',
      subtitle: 'Fitted under the dash',
      body:
        'The tracker itself. It reads GPS, ignition and its own fuel counter, and streams them over the mobile network. Its internal Li-ion cell keeps it reporting for a short while if vehicle power is cut — which is what makes a disconnection visible rather than silent.',
      rows: [
        ['Status', online ? 'Online' : 'Offline'],
        ['Backup cell', backupVoltage != null ? `${backupVoltage.toFixed(2)} V` : 'Not reported'],
        ['Charge', backupPercent != null ? `${Math.round(backupPercent)}%` : '—'],
        [
          'Last reading',
          vehicle.last_telemetry_at
            ? new Date(vehicle.last_telemetry_at).toLocaleString()
            : 'Never',
        ],
      ],
      visual: <Tracker3D online={online} />,
    },
    tank: {
      title: 'Fuel tank',
      subtitle: 'Modelled, not measured',
      body:
        'This vehicle has no fuel-level sensor on CAN or OBD, so the level shown is a virtual tank: an anchor set at a known fill, drained by the burn the tracker counts, and credited by receipts. Its confidence falls the longer it runs since the last calibration.',
      rows: [
        [
          'Level',
          vehicle.virtual_tank_liters != null
            ? `${Number(vehicle.virtual_tank_liters).toFixed(1)} L`
            : vehicle.fuel_level_liters != null
              ? `${Number(vehicle.fuel_level_liters).toFixed(1)} L`
              : '—',
        ],
        [
          'Capacity',
          vehicle.tank_capacity_liters ? `${vehicle.tank_capacity_liters} L` : '—',
        ],
        ['Source', 'Virtual tank — AVL 12 fuel counter + receipts'],
      ],
      // The app's own fuel instrument, not a battery cell wearing a tank label.
      visual: (
        <div className="flex h-full items-center justify-center">
          <LiquidFuelGauge
            percent={
              vehicle.virtual_tank_liters != null && vehicle.tank_capacity_liters
                ? (Number(vehicle.virtual_tank_liters) /
                    Number(vehicle.tank_capacity_liters)) *
                  100
                : null
            }
            icon={Fuel}
            size={150}
            primary={
              vehicle.virtual_tank_liters != null
                ? `${Number(vehicle.virtual_tank_liters).toFixed(1)} L`
                : '—'
            }
            secondary={<span className="text-[10px] text-ink-dim">modelled</span>}
          />
        </div>
      ),
    },
  };

  const c = content[part];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={c.title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-edge px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-ink-dim">{c.subtitle}</p>
            <h2 className="text-lg font-bold text-ink">{c.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-edge text-ink-dim transition-colors hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="h-48 bg-panel-deep">{c.visual}</div>

        <div className="px-5 py-4">
          <p className="text-sm leading-relaxed text-ink-mid">{c.body}</p>
          <dl className="mt-4 space-y-2">
            {c.rows.map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-3 border-b border-edge/60 pb-2 last:border-0"
              >
                <dt className="text-xs text-ink-dim">{label}</dt>
                <dd className="text-right text-sm font-medium tabular-nums text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
