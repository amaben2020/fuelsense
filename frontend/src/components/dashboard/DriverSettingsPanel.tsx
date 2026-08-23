'use client';

import { useState } from 'react';
import { DriverAvatar } from './DriverLicenceCard';
import { Driver, FleetVehicle, api } from '@/lib/api';
import { compressAvatar } from '@/lib/receipt-image';

/**
 * The manager's photo control for one driver.
 *
 * Compressed in the browser before it is sent: the column holds a data URL,
 * and a modern phone camera would otherwise put four megabytes on a row that
 * every fleet query then reads.
 */
function DriverPhotoUpload({ driver, onDone }: { driver: Driver; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (photo: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/drivers/${driver.id}/photo`, {
        method: 'PATCH',
        body: JSON.stringify({ photo }),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      send(await compressAvatar(file));
    } catch {
      setError('That file could not be read as an image.');
      setBusy(false);
    }
  };

  return (
    <span className="mt-0.5 flex items-center gap-2 text-[11px]">
      <label className="cursor-pointer text-brand hover:underline">
        {busy ? 'Saving…' : driver.photo_url ? 'Change photo' : 'Add photo'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          disabled={busy}
          onChange={(e) => onPick(e.target.files?.[0])}
        />
      </label>
      {driver.photo_url && !busy && (
        <button
          type="button"
          onClick={() => send(null)}
          className="text-ink-dim hover:text-bad"
        >
          Remove
        </button>
      )}
      {error && <span className="text-bad">{error}</span>}
    </span>
  );
}

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
    <div className="mt-6 overflow-hidden rounded-lg border border-edge bg-canvas">
      <div className="border-b border-edge px-6 py-4">
        <h3 className="font-semibold text-ink">Drivers</h3>
        <p className="mt-1 text-xs text-ink-dim">
          Each vehicle has one assigned driver. Reassign anytime — updates live on the map.
        </p>
      </div>

      <form onSubmit={handleAddDriver} className="border-b border-edge px-6 py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-dim">Add driver</p>
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Full name *"
            value={addForm.full_name}
            onChange={(e) => setAddForm((f) => ({ ...f, full_name: e.target.value }))}
            required
            className="w-44 rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-ink placeholder-ink-dim"
          />
          <input
            type="text"
            placeholder="Phone"
            value={addForm.phone}
            onChange={(e) => setAddForm((f) => ({ ...f, phone: e.target.value }))}
            className="w-36 rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-ink placeholder-ink-dim"
          />
          <input
            type="text"
            placeholder="License number"
            value={addForm.license_number}
            onChange={(e) => setAddForm((f) => ({ ...f, license_number: e.target.value }))}
            className="w-40 rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-ink placeholder-ink-dim"
          />
          <button
            type="submit"
            disabled={adding || !addForm.full_name.trim()}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm text-accent-y-ink disabled:opacity-40"
          >
            {adding ? 'Adding…' : 'Add driver'}
          </button>
        </div>
        {addError && <p className="mt-2 text-xs text-bad">{addError}</p>}
      </form>

      {error && <p className="px-6 py-2 text-sm text-bad">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-panel text-xs uppercase text-ink-dim">
            <tr>
              <th className="px-6 py-3">Driver</th>
              <th className="px-6 py-3">Phone</th>
              <th className="px-6 py-3">License</th>
              <th className="px-6 py-3">Assigned vehicle</th>
              <th className="px-6 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divider text-ink-mid">
            {drivers.map((driver) => (
              <tr key={driver.id}>
                <td className="px-6 py-3 font-medium text-ink">
                  <span className="flex items-center gap-2.5">
                    <DriverAvatar
                      name={driver.full_name}
                      photoUrl={driver.photo_url}
                      size={34}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{driver.full_name}</span>
                      <DriverPhotoUpload driver={driver} onDone={onAssigned} />
                    </span>
                  </span>
                </td>
                <td className="px-6 py-3">{driver.phone ?? '—'}</td>
                <td className="px-6 py-3 font-mono text-xs">{driver.license_number ?? '—'}</td>
                <td className="px-6 py-3">
                  <select
                    value={assignments[driver.id] ?? ''}
                    onChange={(e) =>
                      setAssignments((prev) => ({ ...prev, [driver.id]: e.target.value }))
                    }
                    className="w-full max-w-[180px] rounded-lg border border-edge bg-panel px-2 py-1.5 text-sm text-ink"
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
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-y-ink disabled:opacity-40"
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
