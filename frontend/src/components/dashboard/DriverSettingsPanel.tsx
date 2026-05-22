'use client';

import { useState } from 'react';
import { Driver, FleetVehicle, api } from '@/lib/api';

export function DriverSettingsPanel({
  drivers,
  fleet,
  onAssigned,
}: {
  drivers: Driver[];
  fleet: FleetVehicle[];
  onAssigned: () => void;
}) {
  const [assignments, setAssignments] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const d of drivers) {
      if (d.vehicle_id) map[d.id] = d.vehicle_id;
    }
    return map;
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAssign = async (driverId: string) => {
    const vehicleId = assignments[driverId];
    if (!vehicleId) return;
    setSaving(driverId);
    setError(null);
    try {
      await api('/drivers/assign', {
        method: 'PATCH',
        body: JSON.stringify({ driver_id: driverId, vehicle_id: vehicleId }),
      });
      onAssigned();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assignment failed');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-[#434656] bg-[#0b1326]">
      <div className="border-b border-[#434656] px-6 py-4">
        <h3 className="font-semibold text-[#dae2fd]">Drivers</h3>
        <p className="mt-1 text-xs text-[#8e90a2]">
          Each vehicle has one assigned driver. Reassign anytime — updates live on the map.
        </p>
      </div>
      {error && <p className="px-6 py-2 text-sm text-[#ffb4ab]">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-[#171f33] text-xs uppercase text-[#8e90a2]">
            <tr>
              <th className="px-6 py-3">Driver</th>
              <th className="px-6 py-3">Phone</th>
              <th className="px-6 py-3">License</th>
              <th className="px-6 py-3">Assigned vehicle</th>
              <th className="px-6 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2d3449] text-[#c4c5d9]">
            {drivers.map((driver) => (
              <tr key={driver.id}>
                <td className="px-6 py-3 font-medium text-[#dae2fd]">{driver.full_name}</td>
                <td className="px-6 py-3">{driver.phone ?? '—'}</td>
                <td className="px-6 py-3 font-mono text-xs">{driver.license_number ?? '—'}</td>
                <td className="px-6 py-3">
                  <select
                    value={assignments[driver.id] ?? ''}
                    onChange={(e) =>
                      setAssignments((prev) => ({ ...prev, [driver.id]: e.target.value }))
                    }
                    className="w-full max-w-[180px] rounded-lg border border-[#434656] bg-[#171f33] px-2 py-1.5 text-sm text-[#dae2fd]"
                  >
                    <option value="">Unassigned</option>
                    {fleet.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.license_plate}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-6 py-3">
                  <button
                    type="button"
                    disabled={!assignments[driver.id] || saving === driver.id}
                    onClick={() => handleAssign(driver.id)}
                    className="rounded-lg bg-[#2e5bff] px-3 py-1.5 text-xs text-white disabled:opacity-40"
                  >
                    {saving === driver.id ? 'Saving…' : 'Assign'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
