import { AlertTriangle } from 'lucide-react';
import {
  Alert,
  FleetVehicle,
  fuelPercent,
  vehicleDisplayStatus,
} from '@/lib/api';

const statusStyles = {
  online: 'bg-[#4edea3]/20 text-[#4edea3]',
  idle: 'bg-[#ffb95f]/20 text-[#ffb95f]',
  offline: 'bg-[#ffb4ab]/20 text-[#ffb4ab]',
  no_device: 'bg-[#434656]/40 text-[#8e90a2]',
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
      <div className="rounded-lg border border-[#434656] bg-[#171f33] p-8 text-center">
        <p className="text-[#dae2fd]">No vehicles yet</p>
        <p className="mt-2 text-sm text-[#8e90a2]">
          Add a vehicle + IMEI, then run the fleet simulator or connect a real tracker.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[#434656] bg-[#171f33]">
      <div className="border-b border-[#434656] px-6 py-4">
        <h2 className="font-semibold text-[#dae2fd]">Active fleet</h2>
        <p className="text-xs text-[#8e90a2]">Live from TCP telemetry · refreshes every 3s</p>
      </div>
      <div className="divide-y divide-[#2d3449]">
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
              className={`w-full px-6 py-4 text-left transition-colors hover:bg-[#222a3d] ${
                selectedId === vehicle.id
                  ? 'border-l-2 border-l-[#b8c3ff] bg-[#222a3d]'
                  : ''
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-[#dae2fd]">{vehicle.license_plate}</h3>
                    {hasAlert && <AlertTriangle className="h-4 w-4 text-[#ffb4ab]" />}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyles[status]}`}
                    >
                      {status.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[#c4c5d9]">
                    {[vehicle.make, vehicle.model].filter(Boolean).join(' ')}
                    {vehicle.driver_name ? ` · ${vehicle.driver_name}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg text-[#4edea3]">
                    {pct != null ? `${pct}%` : '—'}
                  </div>
                  <div className="text-xs text-[#8e90a2]">
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
