'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, BulkVehiclesResponse, Customer, getToken } from '@/lib/api';
import { emptyVehicle, VehicleDeviceFields, VehicleFormData } from '@/components/VehicleDeviceFields';

type FleetSize = 'small' | 'medium' | 'large';
type Step = 'size' | 'vehicles' | 'large-fleet' | 'done';

const MAX_BY_SIZE: Record<FleetSize, number> = {
  small: 5,
  medium: 20,
  large: 0,
};

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('size');
  const [fleetSize, setFleetSize] = useState<FleetSize>('small');
  const [vehicles, setVehicles] = useState<VehicleFormData[]>([emptyVehicle()]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
    }
  }, [router]);

  const maxVehicles = MAX_BY_SIZE[fleetSize];

  const updateVehicle = (index: number, data: VehicleFormData) => {
    setVehicles((prev) => prev.map((v, i) => (i === index ? data : v)));
  };

  const addVehicleSlot = () => {
    if (vehicles.length < maxVehicles) {
      setVehicles((prev) => [...prev, emptyVehicle()]);
    }
  };

  const handleSizeContinue = () => {
    if (fleetSize === 'large') {
      setStep('large-fleet');
      return;
    }
    setVehicles([emptyVehicle()]);
    setStep('vehicles');
  };

  const handleBulkSubmit = async () => {
    setLoading(true);
    setError(null);

    const payload = vehicles.filter(
      (v) => v.licensePlate.trim() && v.imei.length === 15
    );

    if (payload.length === 0) {
      setError('Add at least one complete vehicle with a valid 15-digit IMEI');
      setLoading(false);
      return;
    }

    try {
      await api<BulkVehiclesResponse>('/vehicles/bulk', {
        method: 'POST',
        body: JSON.stringify({
          vehicles: payload.map((v) => ({
            licensePlate: v.licensePlate,
            make: v.make,
            model: v.model,
            year: v.year,
            tankCapacityLiters: v.tankCapacityLiters,
            imei: v.imei,
          })),
        }),
      });
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save vehicles');
    } finally {
      setLoading(false);
    }
  };

  const skipToDashboard = async () => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }

    setLoading(true);
    try {
      await api<Customer>('/auth/onboarding', { method: 'PATCH' });
    } catch {
      // still redirect — user can add devices from dashboard
    }
    router.replace('/dashboard');
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">
          FuelSense
        </p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">
          Welcome! Let&apos;s set up your fleet.
        </h1>

        <StepIndicator step={step} />

        {error && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {step === 'size' && (
          <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">
              How many vehicles are you adding today?
            </h2>
            <div className="mt-4 space-y-3">
              {(
                [
                  ['small', '1–5 vehicles', 'Recommended for first-time setup'],
                  ['medium', '5–20 vehicles', 'Add multiple trackers at once'],
                  ['large', '20+ vehicles', 'We\'ll help with bulk setup'],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${
                    fleetSize === value
                      ? 'border-emerald-500 bg-emerald-50'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="fleetSize"
                    value={value}
                    checked={fleetSize === value}
                    onChange={() => setFleetSize(value)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium text-slate-900">{label}</p>
                    <p className="text-sm text-slate-500">{hint}</p>
                  </div>
                </label>
              ))}
            </div>
            <button
              onClick={handleSizeContinue}
              className="mt-6 w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700"
            >
              Continue
            </button>
          </section>
        )}

        {step === 'vehicles' && (
          <section className="mt-8 space-y-6">
            <p className="text-sm text-slate-600">
              Step 2 of 3 — Enter each vehicle and the IMEI from its device sticker.
            </p>

            {vehicles.map((vehicle, index) => (
              <div key={index} className="rounded-xl bg-white p-6 shadow-sm">
                <VehicleDeviceFields
                  title={`Vehicle #${index + 1}`}
                  data={vehicle}
                  onChange={(data) => updateVehicle(index, data)}
                />
              </div>
            ))}

            {vehicles.length < maxVehicles && (
              <button
                type="button"
                onClick={addVehicleSlot}
                className="w-full rounded-lg border-2 border-dashed border-slate-300 py-3 text-sm font-medium text-slate-600 hover:border-emerald-400 hover:text-emerald-700"
              >
                + Add another vehicle
              </button>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep('size')}
                className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700"
              >
                Back
              </button>
              <button
                onClick={handleBulkSubmit}
                disabled={loading}
                className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {loading ? 'Saving...' : 'Complete setup'}
              </button>
            </div>
          </section>
        )}

        {step === 'large-fleet' && (
          <section className="mt-8 rounded-xl bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Bulk fleet setup</h2>
            <p className="mt-2 text-slate-600">
              For fleets with 20+ vehicles, contact us for assisted onboarding and CSV
              import. You can still add vehicles one at a time from your dashboard.
            </p>
            <p className="mt-4 text-sm text-slate-500">
              Email:{' '}
              <a href="mailto:support@fuelsense.app" className="text-emerald-700 hover:underline">
                support@fuelsense.app
              </a>
            </p>
            <button
              onClick={skipToDashboard}
              disabled={loading}
              className="mt-6 w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              Go to dashboard
            </button>
          </section>
        )}

        {step === 'done' && (
          <section className="mt-8 rounded-xl bg-white p-8 text-center shadow-sm">
            <p className="text-4xl">✓</p>
            <h2 className="mt-4 text-xl font-bold text-slate-900">Fleet setup complete</h2>
            <p className="mt-2 text-slate-600">
              Power on your trackers — live fuel data will appear within a few minutes.
            </p>
            <button
              onClick={() => router.replace('/dashboard')}
              className="mt-6 w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700"
            >
              View dashboard
            </button>
          </section>
        )}

        {step !== 'done' && step !== 'large-fleet' && (
          <button
            type="button"
            onClick={skipToDashboard}
            className="mt-6 text-sm text-slate-500 hover:text-slate-700"
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps = [
    { id: 'size', label: 'Fleet size' },
    { id: 'vehicles', label: 'Add vehicles' },
    { id: 'done', label: 'Connect devices' },
  ];

  const currentIndex =
    step === 'large-fleet' ? 1 : steps.findIndex((s) => s.id === step);

  return (
    <ol className="mt-6 flex gap-2">
      {steps.map((s, i) => (
        <li
          key={s.id}
          className={`flex-1 rounded-lg px-3 py-2 text-center text-xs font-medium ${
            i <= currentIndex
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-slate-200 text-slate-500'
          }`}
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}
