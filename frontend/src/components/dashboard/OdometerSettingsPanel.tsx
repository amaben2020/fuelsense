'use client';

import { useMemo, useState } from 'react';
import { Gauge, Search, TriangleAlert } from 'lucide-react';
import {
  FleetVehicle,
  KM_TO_MILES,
  formatOdometerMiles,
  milesToKm,
  setVehicleOdometer,
} from '@/lib/api';

/** Above this many vehicles the list gets a filter box. Below it, a filter is
 *  just another control to ignore. */
const FILTER_THRESHOLD = 6;

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/** What the vehicle currently reports as its total, in km, or null if it has
 *  never been anchored — in which case all we have is distance since the
 *  tracker was fitted. */
const currentTotalKm = (v: FleetVehicle): number | null =>
  v.total_odometer_km ?? (v.odometer_baseline_km != null ? v.odometer_baseline_km : null);

interface Props {
  fleet: FleetVehicle[];
  /** Re-fetches the dashboard so the new reading is reflected everywhere it is
   *  shown — the fleet table, maintenance intervals, the vehicle cards. */
  onChanged: () => void;
}

/**
 * Per-vehicle odometer anchoring.
 *
 * The tracker only reports AVL 16 — distance accumulated since it was fitted —
 * so a vehicle's true mileage is a number only the manager can supply. Anchoring
 * stores that reading alongside the device's counter at the same instant, and
 * every total from then on is the sum of the two.
 *
 * This lives in Settings rather than only in Maintenance because the control
 * there is gated on `!odometer_anchored`: it appears once, then disappears, and
 * a reading typed with a digit missing can never be corrected. Here every
 * vehicle is always editable.
 */
export function OdometerSettingsPanel({ fleet, onChanged }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Unanchored vehicles first: they are the ones whose mileage is currently
  // wrong everywhere it appears, so they are what this panel is for. Plate
  // order within each group keeps a long list scannable.
  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...fleet]
      .filter((v) =>
        q === ''
          ? true
          : `${v.license_plate} ${v.make ?? ''} ${v.model ?? ''}`.toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const anchored = Number(a.odometer_baseline_km != null) -
          Number(b.odometer_baseline_km != null);
        if (anchored !== 0) return anchored;
        return a.license_plate.localeCompare(b.license_plate);
      });
  }, [fleet, query]);

  const unanchoredCount = fleet.filter((v) => v.odometer_baseline_km == null).length;

  const open = (v: FleetVehicle) => {
    setEditing(v.id);
    setError(null);
    setSaved(null);
    // Prefilled with what the vehicle reads now, so correcting a typo is an
    // edit rather than a retype — and so a re-anchor starts from the truth.
    const km = currentTotalKm(v);
    setValue(km == null ? '' : String(Math.round(km * KM_TO_MILES)));
  };

  const save = async (v: FleetVehicle) => {
    const miles = Number(value);
    if (!Number.isFinite(miles) || miles < 0) {
      setError('Enter the mileage showing on the dashboard, in miles.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await setVehicleOdometer(v.id, Math.round(milesToKm(miles)));
      setEditing(null);
      setValue('');
      setSaved(v.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this reading');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-edge bg-panel p-6">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-accent-y" />
        <h2 className="font-semibold text-ink">Vehicle odometers</h2>
      </div>
      <p className="mt-1 text-xs text-ink-dim">
        The tracker only counts distance since it was fitted, so true mileage has to come from the
        dashboard once. Anchoring a vehicle sets every mileage figure shown for it — including the
        intervals its service schedules are measured against.
      </p>

      {unanchoredCount > 0 && (
        <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink-mid">
          <span className="font-semibold text-warn">
            {unanchoredCount} vehicle{unanchoredCount === 1 ? '' : 's'} not anchored.
          </span>{' '}
          Their mileage reads as distance since the tracker was fitted, which is lower than the
          real figure — usually by the whole life of the vehicle.
        </p>
      )}

      {fleet.length > FILTER_THRESHOLD && (
        <label className="mt-3 flex items-center gap-2 rounded-md border border-edge bg-canvas px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-dim" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by plate, make or model"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-dim"
          />
        </label>
      )}

      {fleet.length === 0 && (
        <p className="mt-4 text-sm text-ink-dim">No vehicles registered yet.</p>
      )}

      {fleet.length > 0 && ordered.length === 0 && (
        <p className="mt-4 text-sm text-ink-dim">No vehicle matches “{query}”.</p>
      )}

      <ul className="mt-3 divide-y divide-edge/60">
        {ordered.map((v) => {
          const anchored = v.odometer_baseline_km != null;
          const totalKm = currentTotalKm(v);
          const isEditing = editing === v.id;
          // A reading below what the vehicle already reports is not necessarily
          // wrong — an odometer swap legitimately resets it — but it is worth
          // saying out loud before it is saved.
          const entered = Number(value);
          const goesBackwards =
            isEditing &&
            Number.isFinite(entered) &&
            totalKm != null &&
            entered < Math.round(totalKm * KM_TO_MILES);

          return (
            <li key={v.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {v.license_plate}
                    {v.make || v.model ? (
                      <span className="ml-2 font-normal text-ink-dim">
                        {[v.make, v.model].filter(Boolean).join(' ')}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-dim">
                    {anchored ? (
                      <>
                        Anchored
                        {v.odometer_baseline_at
                          ? ` ${formatDate(v.odometer_baseline_at)}`
                          : ''}{' '}
                        at {formatOdometerMiles(v.odometer_baseline_km)}
                      </>
                    ) : (
                      <span className="text-warn">
                        Not anchored — showing {formatOdometerMiles(v.odometer_km)} since fitting
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-ink">
                    {anchored ? formatOdometerMiles(totalKm) : '—'}
                  </span>
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => open(v)}
                      className="rounded-full border border-edge px-3 py-1 text-[11px] font-semibold text-ink-mid hover:bg-panel-hover"
                    >
                      {anchored ? 'Update' : 'Anchor'}
                    </button>
                  )}
                </div>
              </div>

              {isEditing && (
                <div className="mt-2.5 rounded-lg border border-edge bg-canvas p-3">
                  <div className="flex flex-wrap items-end gap-2.5">
                    <label className="min-w-[160px] flex-1">
                      <span className="text-xs text-ink-dim">Dashboard reading (miles)</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        autoFocus
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder="72500"
                        className="mt-1 w-full rounded-md border border-edge bg-panel px-3 py-2 font-mono text-sm text-ink outline-none focus:border-brand"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => save(v)}
                      disabled={saving}
                      className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-accent-y-ink disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(null);
                        setError(null);
                      }}
                      className="rounded-md border border-edge px-3 py-2 text-sm text-ink-mid hover:bg-panel-hover"
                    >
                      Cancel
                    </button>
                  </div>

                  {anchored && (
                    <p className="mt-2 text-[11px] text-ink-dim">
                      Replaces the current anchor of{' '}
                      {formatOdometerMiles(v.odometer_baseline_km)}. Mileage-based service
                      intervals for this vehicle are measured against the new figure.
                    </p>
                  )}

                  {goesBackwards && (
                    <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warn">
                      <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                      Lower than the {formatOdometerMiles(totalKm)} this vehicle reports now. Right
                      if the odometer was replaced; otherwise check the digits.
                    </p>
                  )}
                </div>
              )}

              {saved === v.id && !isEditing && (
                <p className="mt-1.5 text-[11px] text-good">Reading saved.</p>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="mt-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
