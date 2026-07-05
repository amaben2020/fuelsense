import { AlertTriangle } from 'lucide-react';
import {
  Alert,
  FleetVehicle,
  fuelPercent,
  vehicleDisplayStatus,
} from '@/lib/api';

const statusStyles = {
  online: 'bg-good/20 text-good',
  idle: 'bg-warn/20 text-warn',
  offline: 'bg-bad/20 text-bad',
  no_device: 'bg-edge/40 text-ink-dim',
};

export function FleetListPanel({
  fleet,
  alerts,
  selectedId,
  onSelect,
}: {
  fleet: FleetVehicle[];
  alerts: Alert[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (fleet.length === 0) {
    return (
      <div className="rounded-lg border border-edge bg-panel p-8 text-center">
        <p className="text-ink">No vehicles yet</p>
        <p className="mt-2 text-sm text-ink-dim">
          Add a vehicle + IMEI, then run the fleet simulator or connect a real tracker.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-panel">
      <div className="border-b border-edge px-6 py-4">
        <h2 className="font-semibold text-ink">Active fleet</h2>
        <p className="text-xs text-ink-dim">Live from TCP telemetry · refreshes every 3s</p>
      </div>
      <div className="divide-y divide-divider">
        {fleet.map((vehicle) => {
          const status = vehicleDisplayStatus(vehicle);
          const pct = fuelPercent(vehicle);
          const hasAlert = alerts.some(
            (a) => a.vehicle_id === vehicle.id || a.license_plate === vehicle.license_plate
          );

          return (
            <button
              key={vehicle.id}
              type="button"
              onClick={() => onSelect(vehicle.id)}
              className={`w-full px-6 py-4 text-left transition-colors hover:bg-panel-hover ${
                selectedId === vehicle.id
                  ? 'border-l-2 border-l-brand bg-panel-hover'
                  : ''
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-ink">{vehicle.license_plate}</h3>
                    {hasAlert && <AlertTriangle className="h-4 w-4 text-bad" />}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyles[status]}`}
                    >
                      {status.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-ink-mid">
                    {[vehicle.make, vehicle.model].filter(Boolean).join(' ')}
                    {vehicle.driver_name ? ` · ${vehicle.driver_name}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg text-good">
                    {pct != null ? `${pct}%` : '—'}
                  </div>
                  <div className="text-xs text-ink-dim">
                    {vehicle.fuel_level_liters != null
                      ? `${Number(vehicle.fuel_level_liters).toFixed(1)} L`
                      : 'No reading'}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
