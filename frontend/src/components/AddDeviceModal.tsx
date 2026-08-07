'use client';

import { FormEvent, useState } from 'react';
import { api, FleetVehicle, WithDeviceResponse } from '@/lib/api';
import { emptyVehicle, odometerToKm, VehicleDeviceFields } from '@/components/VehicleDeviceFields';

interface AddDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: (row: FleetVehicle) => void;
}

export function AddDeviceModal({ isOpen, onClose, onAdded }: AddDeviceModalProps) {
  const [form, setForm] = useState(emptyVehicle());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await api<WithDeviceResponse>('/vehicles/with-device', {
        method: 'POST',
        body: JSON.stringify({
          licensePlate: form.licensePlate,
          make: form.make,
          model: form.model,
          year: form.year,
          tankCapacityLiters: form.tankCapacityLiters,
          imei: form.imei,
          odometerBaselineKm: odometerToKm(form),
          deviceModel: 'FMC150',
        }),
      });

      if (result.fleetRow) {
        onAdded(result.fleetRow);
      }

      setForm(emptyVehicle());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add vehicle');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-edge bg-panel p-6 shadow-2xl">
        <h2 className="text-xl font-bold text-ink">Add new vehicle</h2>
        <p className="mt-1 text-sm text-ink-mid">
          Link a tracker to a vehicle using the IMEI from the device sticker.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <VehicleDeviceFields data={form} onChange={setForm} />

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-edge px-4 py-2 text-sm font-medium text-ink-mid hover:bg-panel-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {loading ? 'Adding...' : 'Add vehicle'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
