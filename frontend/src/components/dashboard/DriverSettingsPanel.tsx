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
  const [addForm, setAddForm] = useState({ full_name: '', phone: '', license_number: '' });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const handleAddDriver = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.full_name.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await api('/drivers', {
        method: 'POST',
        body: JSON.stringify(addForm),
      });
      setAddForm({ full_name: '', phone: '', license_number: '' });
      onAssigned();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add driver');
    } finally {
      setAdding(false);
    }
  };

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

      <form onSubmit={handleAddDriver} className="border-b border-[#434656] px-6 py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[#8e90a2]">Add driver</p>
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Full name *"
            value={addForm.full_name}
            onChange={(e) => setAddForm((f) => ({ ...f, full_name: e.target.value }))}
            required
            className="w-44 rounded-lg border border-[#434656] bg-[#171f33] px-3 py-1.5 text-sm text-[#dae2fd] placeholder-[#8e90a2]"
          />
          <input
            type="text"
            placeholder="Phone"
            value={addForm.phone}
            onChange={(e) => setAddForm((f) => ({ ...f, phone: e.target.value }))}
            className="w-36 rounded-lg border border-[#434656] bg-[#171f33] px-3 py-1.5 text-sm text-[#dae2fd] placeholder-[#8e90a2]"
          />
          <input
            type="text"
            placeholder="License number"
            value={addForm.license_number}
            onChange={(e) => setAddForm((f) => ({ ...f, license_number: e.target.value }))}
            className="w-40 rounded-lg border border-[#434656] bg-[#171f33] px-3 py-1.5 text-sm text-[#dae2fd] placeholder-[#8e90a2]"
          />
          <button
            type="submit"
            disabled={adding || !addForm.full_name.trim()}
            className="rounded-lg bg-[#2e5bff] px-4 py-1.5 text-sm text-white disabled:opacity-40"
          >
            {adding ? 'Adding…' : 'Add driver'}
          </button>
        </div>
        {addError && <p className="mt-2 text-xs text-[#ffb4ab]">{addError}</p>}
      </form>

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
