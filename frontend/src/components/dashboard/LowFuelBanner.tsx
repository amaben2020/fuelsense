'use client';

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { FleetVehicle, fuelPercent, isInFuelReserve } from '@/lib/api';

/**
 * The low-fuel telltale, as a car dashboard draws it: a solid pump silhouette,
 * not a thin outline.
 *
 * Lucide's `Fuel` is a 2px-stroke line icon — correct next to the other nav
 * glyphs, and wrong here. A warning lamp is filled, and its whole job is to be
 * the one thing on the panel that is unmistakably lit. Same red as the fuel
 * dial's ring (--bad-bright, #ff6b6b), so the banner and the gauge read as one
 * signal rather than two coincidences.
 */
function LowFuelLamp({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {/* Tank body — the pump's reservoir, squared off with a soft radius the
          way the real telltale is drawn. */}
      <path d="M3.5 3.25A2.25 2.25 0 0 1 5.75 1h6.5a2.25 2.25 0 0 1 2.25 2.25V21h1a.75.75 0 0 1 0 1.5H2.5a.75.75 0 0 1 0-1.5h1V3.25Zm2.25 2A.75.75 0 0 0 5 6v3.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75V6a.75.75 0 0 0-.75-.75h-6.5Z" />
      {/* Filler neck and hose, rising to the right — what makes the silhouette
          read as a fuel pump rather than a bottle at 14px. */}
      <path d="M16.25 6.5a.75.75 0 0 1 .75.75v9.25a1.5 1.5 0 0 0 3 0V11.5a2.5 2.5 0 0 1-2-2.45V6.31l-.72-.72a.75.75 0 1 1 1.06-1.06l2 2a.75.75 0 0 1 .22.53v1.99a1 1 0 0 0 .69.95.75.75 0 0 1 .5.71v5.79a3 3 0 0 1-6 0V7.25a.75.75 0 0 1 .75-.75h-.25Z" />
    </svg>
  );
}

/**
 * The same point the fuel dial turns red — see RESERVE_PCT in Gauges.tsx.
 *
 * Deliberately one threshold, not a softer "getting low" tier as well. The
 * banner has to mean the same thing as the gauge a manager is already looking
 * at; a banner that appears while the dial is still amber teaches people that
 * the two disagree.
 */
const RESERVE_PCT = 11;

const STORAGE_KEY = 'fuelsense_low_fuel_dismissed';

/** Vehicles at or below the reserve band, with the figure that put them there. */
export interface LowFuelVehicle {
  id: string;
  plate: string;
  liters: number | null;
  percent: number | null;
}

export const lowFuelVehicles = (fleet: FleetVehicle[]): LowFuelVehicle[] =>
  fleet
    .filter((v) => {
      const liters = v.fuel_level_liters == null ? null : Number(v.fuel_level_liters);
      const pct = fuelPercent(v);
      // A vehicle with no fuel reading is not low — it is unknown, and saying
      // otherwise would put every device-less vehicle in the banner forever.
      if (liters == null && pct == null) return false;
      return isInFuelReserve(liters) || (pct != null && pct <= RESERVE_PCT);
    })
    .map((v) => ({
      id: v.id,
      plate: v.license_plate,
      liters: v.fuel_level_liters == null ? null : Number(v.fuel_level_liters),
      percent: fuelPercent(v),
    }));

/**
 * Dismissals, as vehicle id -> litres in the tank when it was dismissed.
 *
 * Storing the level rather than a bare id is what makes the dismissal lapse on
 * its own. The only way out of the reserve band is a refuel, so "the tank now
 * holds more than it did when you dismissed this" is exactly the condition that
 * should un-silence the vehicle — and it can be evaluated while rendering,
 * with no effect keeping a second copy of the truth in sync.
 */
type DismissedAt = Record<string, number>;

/** Slack on the comparison, in litres. The modelled level drifts by small
 *  amounts between frames, and a 0.2L wobble is not a refuel. */
const REFUEL_EPSILON_L = 1;

const readDismissed = (): DismissedAt => {
  if (!globalThis.window) return {};
  try {
    const raw = globalThis.window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DismissedAt)
      : {};
  } catch {
    return {};
  }
};

const writeDismissed = (map: DismissedAt): void => {
  if (!globalThis.window) return;
  try {
    globalThis.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A browser refusing storage is not worth breaking the banner over; the
    // dismissal simply lasts for this page view.
  }
};

/** Whether a dismissal still applies to the vehicle's current state. */
const stillDismissed = (v: LowFuelVehicle, dismissed: DismissedAt): boolean => {
  const at = dismissed[v.id];
  if (at == null) return false;
  // No reading to compare against — honour the dismissal rather than nagging.
  if (v.liters == null) return true;
  return v.liters <= at + REFUEL_EPSILON_L;
};

interface Props {
  fleet: FleetVehicle[];
  /** Focus a vehicle and jump to the live map. */
  onSelectVehicle?: (vehicleId: string) => void;
}

/**
 * Fleet-wide low fuel notice, above the page header.
 *
 * Dismissal is per vehicle rather than per banner. Dismissing "LAG-001-FS is in
 * reserve" must not also silence a second vehicle dropping into reserve an hour
 * later — that is the case where the banner earns its place.
 *
 * A dismissal is dropped as soon as the vehicle climbs back out of the reserve
 * band, so the next time it runs low it is announced again. Without that,
 * dismissing once would silence the vehicle permanently, which is the usual way
 * these banners quietly stop working.
 */
export function LowFuelBanner({ fleet, onSelectVehicle }: Props) {
  const [dismissed, setDismissed] = useState<DismissedAt>({});
  // Storage is read after mount, never during render: the server renders with
  // nothing dismissed, and reading localStorage inline would produce a
  // different first paint on the client and a hydration mismatch.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
    setReady(true);
  }, []);

  const low = useMemo(() => lowFuelVehicles(fleet), [fleet]);

  // Re-arm is derived, not stored: a vehicle whose tank has risen since it was
  // dismissed has been refuelled, and its dismissal no longer applies.
  const showing = low.filter((v) => !stillDismissed(v, dismissed));
  if (!ready || showing.length === 0) return null;

  const dismiss = () => {
    const next = { ...dismissed };
    for (const v of showing) {
      // Vehicles with no reading get 0, which no real level can fall below —
      // so the dismissal holds until a reading exists to compare against.
      next[v.id] = v.liters ?? 0;
    }
    setDismissed(next);
    writeDismissed(next);
  };

  const first = showing[0];
  const others = showing.length - 1;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-xl border border-bad/40 bg-bad/10 px-4 py-3"
    >
      {/* Lit, like the lamp it imitates: the ring and wash carry the glow so
          the icon itself stays a clean silhouette at 16px. */}
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-bad-bright/40 bg-bad-bright/15 text-bad-bright shadow-[0_0_12px_-2px_rgba(255,107,107,0.55)]">
        <LowFuelLamp className="h-[18px] w-[18px]" />
      </span>

      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-bad-bright">
          {showing.length === 1
            ? 'Low fuel'
            : `Low fuel on ${showing.length} vehicles`}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-mid">
          {showing.slice(0, 3).map((v, i) => (
            <span key={v.id}>
              {i > 0 && ', '}
              {onSelectVehicle ? (
                <button
                  type="button"
                  onClick={() => onSelectVehicle(v.id)}
                  className="font-medium text-ink underline decoration-dotted underline-offset-2 hover:text-bad-bright"
                >
                  {v.plate}
                </button>
              ) : (
                <span className="font-medium text-ink">{v.plate}</span>
              )}
              {v.liters != null && (
                <span className="text-ink-dim">
                  {' '}
                  {v.liters.toFixed(1)}L
                  {v.percent != null ? ` · ${v.percent}% usable` : ''}
                </span>
              )}
            </span>
          ))}
          {others >= 3 && <span className="text-ink-dim"> and {showing.length - 3} more</span>}
          {'. '}
          {/* Says what "low" means here, because 16.6L in a 60L tank does not
              read as low until you know 11L of it is reserve the pump cannot
              reach. */}
          <span className="text-ink-dim">
            At or below the reserve the tank holds back — refuel before the next
            trip.
          </span>
        </p>
      </div>

      <button
        type="button"
        onClick={dismiss}
        aria-label={
          showing.length === 1
            ? `Dismiss low fuel warning for ${first.plate}`
            : 'Dismiss low fuel warning'
        }
        title="Dismiss"
        className="shrink-0 rounded-full border border-edge p-1.5 text-ink-dim transition-colors hover:bg-panel-hover hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
