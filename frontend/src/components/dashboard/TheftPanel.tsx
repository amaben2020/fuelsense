'use client';

import { useEffect, useState } from 'react';
import { Lock, LockOpen, ShieldAlert, Siren } from 'lucide-react';
import {
  Alert,
  FleetVehicle,
  ImmobilizerStatus,
  engageImmobilizer,
  getImmobilizerStatus,
  releaseImmobilizer,
} from '@/lib/api';

const THEFT_ALERT_TYPES = new Set([
  'fuel_theft',
  'receipt_fraud',
  'immobilizer_engaged',
  'immobilizer_released',
]);

function VehicleImmobilizer({ vehicle }: { vehicle: FleetVehicle }) {
  const [status, setStatus] = useState<ImmobilizerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const load = async () => {
    try {
      setStatus(await getImmobilizerStatus(vehicle.id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    // Safety state can change under a manager's feet — a vehicle that was
    // stopped when the page loaded can start moving a minute later, and the
    // button must stop offering an action that is no longer safe.
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle.id]);

  const engage = async () => {
    setActing(true);
    setError(null);
    try {
      setStatus(await engageImmobilizer(vehicle.id));
      setConfirming(false);
      setConfirmText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  };

  const release = async () => {
    setActing(true);
    setError(null);
    try {
      setStatus(await releaseImmobilizer(vehicle.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="rounded-lg border border-edge bg-panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-mono text-sm font-bold text-ink">{vehicle.license_plate}</h3>
          <p className="mt-0.5 text-xs text-ink-dim">
            {[vehicle.make, vehicle.model].filter(Boolean).join(' ')}
          </p>
        </div>
        {loading ? (
          <span className="text-xs text-ink-dim">Checking…</span>
        ) : status?.immobilized ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-bad/15 px-2.5 py-1 text-xs font-semibold text-bad">
            <Lock className="h-3.5 w-3.5" /> Immobilized
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-good/15 px-2.5 py-1 text-xs font-semibold text-good">
            <LockOpen className="h-3.5 w-3.5" /> Normal
          </span>
        )}
      </div>

      {!loading && status && (
        <div className="mt-4 space-y-3">
          {status.immobilized ? (
            <>
              <p className="text-sm text-ink-mid">
                Engine start is cut. The vehicle will not start until it is released.
                {status.immobilizedAt && (
                  <> Immobilized {new Date(status.immobilizedAt).toLocaleString()}.</>
                )}
              </p>
              <button
                type="button"
                onClick={release}
                disabled={acting}
                className="inline-flex items-center gap-2 rounded-lg border border-good/40 bg-good/10 px-4 py-2 text-sm font-semibold text-good transition-colors hover:bg-good/20 disabled:opacity-50"
              >
                <LockOpen className="h-4 w-4" />
                {acting ? 'Releasing…' : 'Release vehicle'}
              </button>
            </>
          ) : confirming ? (
            <div className="rounded-lg border border-bad/40 bg-bad-deep/15 p-3">
              <p className="text-sm font-medium text-bad">
                This cuts the engine-start circuit remotely. Type the plate to confirm.
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={vehicle.license_plate}
                className="mt-2 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-bad focus:outline-none"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={engage}
                  disabled={acting || confirmText.trim().toUpperCase() !== vehicle.license_plate.toUpperCase()}
                  className="inline-flex items-center gap-2 rounded-lg bg-bad px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  <Lock className="h-4 w-4" />
                  {acting ? 'Sending…' : 'Confirm immobilize'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setConfirmText('');
                  }}
                  className="rounded-lg border border-edge px-3 py-2 text-sm text-ink-mid hover:bg-panel-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!status.canImmobilize}
                className="inline-flex items-center gap-2 rounded-lg border border-bad/40 bg-bad/10 px-4 py-2 text-sm font-semibold text-bad transition-colors hover:bg-bad/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Lock className="h-4 w-4" />
                Immobilize vehicle
              </button>
              {!status.canImmobilize && status.blockedReason && (
                <p className="text-xs text-ink-dim">{status.blockedReason}</p>
              )}
            </>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-xs text-bad">{error}</p>}
    </div>
  );
}

export function TheftPanel({ fleet, alerts }: { fleet: FleetVehicle[]; alerts: Alert[] }) {
  const theftAlerts = alerts.filter((a) => THEFT_ALERT_TYPES.has(a.alert_type));

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-edge bg-panel p-5">
        <h2 className="flex items-center gap-2 font-semibold text-ink">
          <ShieldAlert className="h-4 w-4 text-brand" /> Theft & immobilizer
        </h2>
        <p className="mt-1 text-xs text-ink-dim">
          Remote engine-start cutoff over the tracker&apos;s wired relay. Only allowed when the
          vehicle has been stopped, engine off, for at least 2 continuous minutes — there is no
          override, including while a theft looks to be in progress, because a command sent to a
          vehicle that only looks stationary is a worse risk than the theft itself.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {fleet.map((vehicle) => (
          <VehicleImmobilizer key={vehicle.id} vehicle={vehicle} />
        ))}
        {fleet.length === 0 && (
          <p className="text-sm text-ink-dim">No vehicles yet.</p>
        )}
      </div>

      <div className="rounded-lg border border-edge bg-panel p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Siren className="h-4 w-4 text-ink-mid" /> Recent theft activity
        </h3>
        {theftAlerts.length === 0 ? (
          <p className="mt-2 text-sm text-ink-dim">No theft-related activity recorded.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {theftAlerts.slice(0, 20).map((alert) => (
              <li
                key={alert.id}
                className="rounded-lg border-l-2 border-l-bad bg-panel-deep p-3 text-sm"
              >
                <p className="text-ink">{alert.message}</p>
                <p className="mt-1 text-xs text-ink-dim">
                  {new Date(alert.created_at).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
