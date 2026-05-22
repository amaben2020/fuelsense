import { FleetVehicle } from '@/lib/api';

function fuelDisplay(row: FleetVehicle) {
  if (row.fuel_level_liters == null) return '—';
  const liters = Number(row.fuel_level_liters);
  let text = `${liters.toFixed(1)} L`;
  if (row.tank_capacity_liters && row.tank_capacity_liters > 0) {
    const pct = (liters / row.tank_capacity_liters) * 100;
    text += ` (${pct.toFixed(0)}%)`;
  }
  if (liters < 5) text += ' 🔴';
  else if (liters < 20) text += ' ⚠️';
  return text;
}

function statusBadge(status: FleetVehicle['connection_status']) {
  if (status === 'online') {
    return <span className="text-emerald-600">Online</span>;
  }
  if (status === 'offline') {
    return <span className="text-red-500">Offline</span>;
  }
  return <span className="text-slate-400">No device</span>;
}

export function FleetTable({
  fleet,
  selectedId,
  onSelect,
}: {
  fleet: FleetVehicle[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  if (fleet.length === 0) {
    return (
      <div className="rounded-lg bg-white p-8 text-center shadow-sm">
        <p className="text-lg font-medium text-slate-700">No vehicles yet</p>
        <p className="mt-2 text-sm text-slate-500">
          Add your first vehicle and enter the IMEI from the tracker sticker.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b bg-slate-50 text-slate-500">
            <th className="px-4 py-3 font-medium">Vehicle</th>
            <th className="px-4 py-3 font-medium">Fuel level</th>
            <th className="px-4 py-3 font-medium">Odometer</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">IMEI</th>
          </tr>
        </thead>
        <tbody>
          {fleet.map((row) => (
            <tr
              key={row.id}
              className={`border-b border-slate-100 last:border-0 ${
                onSelect ? 'cursor-pointer hover:bg-emerald-50/50' : ''
              } ${selectedId === row.id ? 'bg-emerald-50' : ''}`}
              onClick={() => onSelect?.(row.id)}
            >
              <td className="px-4 py-3">
                <p className="font-medium text-slate-900">{row.license_plate}</p>
                {(row.make || row.model) && (
                  <p className="text-xs text-slate-500">
                    {[row.make, row.model].filter(Boolean).join(' ')}
                  </p>
                )}
              </td>
              <td className="px-4 py-3">{fuelDisplay(row)}</td>
              <td className="px-4 py-3">
                {row.odometer_km != null
                  ? `${Number(row.odometer_km).toLocaleString()} km`
                  : '—'}
              </td>
              <td className="px-4 py-3">{statusBadge(row.connection_status)}</td>
              <td className="px-4 py-3 font-mono text-xs text-slate-600">
                {row.imei ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
