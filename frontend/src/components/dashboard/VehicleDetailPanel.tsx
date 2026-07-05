import { Gauge, MapPin, Zap } from 'lucide-react';
import { Alert, FleetVehicle, fuelPercent } from '@/lib/api';

export function VehicleDetailPanel({
  vehicle,
  alerts,
}: {
  vehicle: FleetVehicle | null;
  alerts: Alert[];
}) {
  if (!vehicle) {
    return (
      <div className="rounded-lg border border-edge bg-panel p-6 text-center text-ink-dim">
        Select a vehicle to view live telemetry
      </div>
    );
  }

  const pct = fuelPercent(vehicle) ?? 0;
  const vehicleAlerts = alerts.filter(
    (a) => a.vehicle_id === vehicle.id || a.license_plate === vehicle.license_plate
  );
  const ringColor =
    pct > 40 ? '#4edea3' : pct > 15 ? '#ffb95f' : '#ffb4ab';

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-edge bg-panel p-6">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-ink">{vehicle.license_plate}</h2>
            <p className="text-sm text-ink-mid">
              {[vehicle.make, vehicle.model].filter(Boolean).join(' ')}
            </p>
          </div>
          <span className="rounded-full bg-canvas px-2 py-1 font-mono text-xs text-ink-dim">
            {vehicle.imei ?? 'No IMEI'}
          </span>
        </div>

        <div className="mb-6 flex flex-col items-center">
          <div className="relative h-32 w-32">
            <svg className="h-full w-full -rotate-90 transform">
              <circle cx="64" cy="64" r="56" fill="none" stroke="#2d3449" strokeWidth="12" />
              <circle
                cx="64"
                cy="64"
                r="56"
                fill="none"
                stroke={ringColor}
                strokeWidth="12"
                strokeDasharray="351.86"
                strokeDashoffset={351.86 * (1 - pct / 100)}
                strokeLinecap="round"
                className="transition-all duration-700"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-2xl font-bold text-ink">
                {vehicle.fuel_level_liters != null ? `${pct}%` : '—'}
              </span>
              <span className="text-xs text-ink-dim">
                {vehicle.fuel_level_liters != null
                  ? `${Number(vehicle.fuel_level_liters).toFixed(1)} L`
                  : 'No data'}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-center">
          <Stat label="Speed" value={vehicle.speed_kph != null ? `${vehicle.speed_kph} km/h` : '—'} />
          <Stat
            label="Ignition"
            value={vehicle.ignition_on == null ? '—' : vehicle.ignition_on ? 'ON' : 'OFF'}
            highlight={vehicle.ignition_on ? 'success' : undefined}
          />
          <Stat
            label="Odometer"
            value={
              vehicle.odometer_km != null
                ? `${Number(vehicle.odometer_km).toLocaleString()} km`
                : '—'
            }
          />
          <Stat
            label="GPS"
            value={
              vehicle.latitude && vehicle.longitude
                ? `${Number(vehicle.latitude).toFixed(4)}, ${Number(vehicle.longitude).toFixed(4)}`
                : 'No fix'
            }
            icon={MapPin}
          />
        </div>
      </div>

      <div className="rounded-lg border border-edge bg-panel p-6">
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink">
          <Gauge className="h-4 w-4" /> Live status
        </h3>
        <div className="space-y-2 text-sm text-ink-mid">
          <Row label="Connection" value={vehicle.connection_status} />
          <Row
            label="Last telemetry"
            value={
              vehicle.last_telemetry_at
                ? new Date(vehicle.last_telemetry_at).toLocaleTimeString()
                : '—'
            }
          />
          <Row
            label="Tank capacity"
            value={
              vehicle.tank_capacity_liters
                ? `${vehicle.tank_capacity_liters} L`
                : '—'
            }
          />
          {vehicle.driver_name && <Row label="Driver" value={vehicle.driver_name} />}
        </div>
      </div>

      {vehicleAlerts.length > 0 && (
        <div className="rounded-lg border border-edge bg-panel p-6">
          <h3 className="mb-3 flex items-center gap-2 font-semibold text-bad">
            <Zap className="h-4 w-4" /> Active alerts
          </h3>
          <div className="space-y-3">
            {vehicleAlerts.map((alert) => (
              <div
                key={alert.id}
                className={`rounded-lg p-3 text-sm ${
                  alert.alert_type === 'fuel_theft'
                    ? 'border-l-2 border-l-bad bg-bad-deep/20'
                    : 'border-l-2 border-l-warn bg-warn-deep/20'
                }`}
              >
                <p className="text-ink">{alert.message}</p>
                <p className="mt-1 text-xs text-ink-dim">
                  {new Date(alert.created_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
  icon: Icon,
}: {
  label: string;
  value: string;
  highlight?: 'success';
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-lg bg-canvas p-3">
      <span className="flex items-center justify-center gap-1 text-xs text-ink-dim">
        {Icon && <Icon className="h-3 w-3" />} {label}
      </span>
      <p
        className={`mt-1 font-mono text-lg font-bold ${
          highlight === 'success' ? 'text-good' : 'text-ink'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-dim">{label}</span>
      <span className="capitalize text-ink">{value}</span>
    </div>
  );
}
