/**
 * These controls render in two places — the marketing register flow and the
 * dashboard's "Add device" — and only the former loads `marketing.css`, where
 * the shared `fs-input` class is defined. Reusing it here produced borderless,
 * invisible fields on the dashboard: a form you could not see you were filling
 * in. The same workaround already exists in `dashboard/orders/new`; this fixes
 * it at the source instead.
 *
 * The dashboard tokens come from `globals.css`, which the root layout loads on
 * every route, so these work in both contexts and follow the light/dark theme.
 */
import { useEffect, useState } from 'react';
import {
  ECONOMY_UNIT_LABELS,
  EconomyUnit,
  VehicleCatalogue,
  fetchVehicleCatalogue,
} from '@/lib/api';
import { VehicleBodyPreview } from '@/components/VehicleBodyPreview';

/** Sentinel for a make the catalogue does not carry. */
const OTHER = '__other__';

/**
 * Year bounds used only when the catalogue has not loaded. Read once at module
 * load rather than per render: `new Date()` during render is impure, and the
 * option list should not be able to shift between two renders of the same
 * form.
 */
const FALLBACK_MAX_YEAR = new Date().getFullYear() + 1;
const FALLBACK_MIN_YEAR = 1998;

const FIELD_LABEL =
  'mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-ink-dim';

/**
 * Deliberately carries no width.
 *
 * It used to start with `w-full`, which was fine for a field on its own row and
 * broken for the two that sit beside a unit selector. Tailwind emits `w-full`
 * after the numeric widths, so `w-24` on the select lost to the `w-full` it had
 * inherited from this same string — both children then demanded 100%, and the
 * number input collapsed to an empty stub while the unit dropdown took the row.
 * The odometer and economy fields were unusable, and they are the two figures
 * the whole fuel model is anchored on.
 *
 * Width is now the caller's decision: `w-full` on its own row, `flex-1 min-w-0`
 * when paired.
 */
const FIELD_INPUT =
  'rounded-xl border border-edge bg-panel-deep px-3.5 py-2.5 text-sm text-ink ' +
  'placeholder:text-ink-dim transition-colors focus:border-brand focus:outline-none ' +
  'focus:ring-1 focus:ring-brand';

const inputClass = `${FIELD_INPUT} w-full`;
/** A control sharing its row with a unit selector. */
const pairedInputClass = `${FIELD_INPUT} min-w-0 flex-1`;
const unitSelectClass = `${FIELD_INPUT} shrink-0`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  );
}

export interface VehicleFormData {
  licensePlate: string;
  make: string;
  model: string;
  year: string;
  tankCapacityLiters: string;
  imei: string;
  odometerReading: string;
  /** Asked explicitly: imported vehicles run miles dashboards, local ones km,
   *  and guessing wrong silently skews every distance figure built on it. */
  odometerUnit: 'mi' | 'km';
  /** The vehicle's own economy readout. Without it the tank burns at a figure
   *  guessed from the model name, so this is asked for at onboarding rather
   *  than left to be discovered later in Calibration. */
  economyReading: string;
  economyUnit: EconomyUnit;
}

export const emptyVehicle = (): VehicleFormData => ({
  licensePlate: '',
  make: '',
  model: '',
  year: '',
  tankCapacityLiters: '',
  imei: '',
  odometerReading: '',
  odometerUnit: 'mi',
  economyReading: '',
  economyUnit: 'mpg_us',
});

/**
 * The make as it should be stored.
 *
 * "Other / not listed" is a UI affordance, not a manufacturer — submitting the
 * sentinel would put `__other__` on the vehicle record and in every report that
 * names it. A blank make is the honest representation of "not in our list".
 */
export function makeForSubmit(data: VehicleFormData): string {
  return data.make === OTHER ? '' : data.make;
}

/** The economy entry as the API wants it, or null when it was left blank. */
export function economyInput(
  data: VehicleFormData
): { value: number; unit: EconomyUnit } | null {
  const value = Number(data.economyReading);
  if (!data.economyReading.trim() || !Number.isFinite(value) || value <= 0) return null;
  return { value, unit: data.economyUnit };
}

/** Form odometer → kilometres for storage. The API and database are km
 *  throughout; miles exist only at the edges (dashboards and our UI). */
export function odometerToKm(data: VehicleFormData): number | undefined {
  const raw = Number(data.odometerReading);
  if (!data.odometerReading.trim() || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.round(data.odometerUnit === 'mi' ? raw * 1.609344 : raw);
}

interface VehicleDeviceFieldsProps {
  data: VehicleFormData;
  onChange: (data: VehicleFormData) => void;
  title?: string;
  imeiRequired?: boolean;
}

export function VehicleDeviceFields({
  data,
  onChange,
  title,
  imeiRequired = true,
}: VehicleDeviceFieldsProps) {
  const set = (key: keyof VehicleFormData, value: string) =>
    onChange({ ...data, [key]: value });

  const [catalogue, setCatalogue] = useState<VehicleCatalogue | null>(null);

  useEffect(() => {
    let live = true;
    fetchVehicleCatalogue()
      .then((c) => {
        if (live) setCatalogue(c);
      })
      // A fleet running something unusual is never blocked by this: the make
      // list simply falls back to free text.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const makes = catalogue?.makes ?? [];
  const isOther = data.make === OTHER;
  const models = makes.find((m) => m.make === data.make)?.models ?? [];
  const selected = models.find((m) => m.model === data.model) ?? null;

  // Years the chosen model was actually sold, newest first — an open-ended
  // number box let someone register a 2019 Hiace as a 1019.
  //
  // Deliberately not memoised. It is at most a few dozen numbers rendered
  // straight into <option> elements, and the manual useMemo made React
  // Compiler skip optimising this component entirely: its dependencies
  // (`selected`, `isOther`) are themselves recomputed every render, so the
  // memo could not be preserved. Dropping it lets the compiler memoise the
  // whole component instead of none of it.
  const years = (() => {
    if (isOther) {
      const max = catalogue?.max_year ?? FALLBACK_MAX_YEAR;
      const min = catalogue?.min_year ?? FALLBACK_MIN_YEAR;
      return Array.from({ length: max - min + 1 }, (_, i) => max - i);
    }
    if (!selected) return [];
    return Array.from(
      { length: selected.year_to - selected.year_from + 1 },
      (_, i) => selected.year_to - i
    );
  })();

  return (
    <div className="space-y-3">
      {title && <h4 className="font-medium text-ink">{title}</h4>}

      <Field label="License plate">
        <input
          required
          value={data.licensePlate}
          onChange={(e) => set('licensePlate', e.target.value)}
          className={inputClass}
          placeholder="LAG-123-AB"
        />
      </Field>

      {/* Make, model and year are chosen rather than typed.
          Free text meant "RAV4", "Rav 4" and "rav-4" were three different
          vehicles to the catalogue, so none of them matched and every one fell
          back to the generic SUV average. Picking from the list is what lets
          the estimate start from this vehicle's real figures. */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Make">
          <select
            required
            value={data.make}
            onChange={(e) => {
              // Changing make invalidates the model beneath it, and the year
              // range with it.
              onChange({ ...data, make: e.target.value, model: '', year: '' });
            }}
            className={inputClass}
          >
            <option value="">Select a make…</option>
            {makes.map((m) => (
              <option key={m.make} value={m.make}>
                {m.make}
              </option>
            ))}
            <option value={OTHER}>Other / not listed</option>
          </select>
        </Field>
        <Field label="Model">
          {isOther ? (
            <input
              required
              value={data.model}
              onChange={(e) => set('model', e.target.value)}
              className={inputClass}
              placeholder="Model name"
            />
          ) : (
            <select
              required
              value={data.model}
              disabled={!data.make}
              onChange={(e) => onChange({ ...data, model: e.target.value, year: '' })}
              className={`${inputClass} disabled:opacity-50`}
            >
              <option value="">{data.make ? 'Select a model…' : 'Pick a make first'}</option>
              {models.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.model}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Year">
          <select
            required
            value={data.year}
            disabled={!isOther && !data.model}
            onChange={(e) => set('year', e.target.value)}
            className={`${inputClass} disabled:opacity-50`}
          >
            <option value="">{years.length ? 'Select a year…' : 'Pick a model first'}</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tank capacity (L)">
          <input
            type="number"
            value={data.tankCapacityLiters}
            onChange={(e) => set('tankCapacityLiters', e.target.value)}
            className={inputClass}
            placeholder={selected ? String(selected.tank_liters) : '80'}
          />
        </Field>
      </div>

      {/* What picking this model will actually do to the estimate, stated
          before it is applied rather than discovered later in Calibration. */}
      {selected && (
        <div className="mb-4 flex gap-3 rounded-xl border border-edge bg-panel-deep p-3">
          <VehicleBodyPreview
            bodyClass={selected.type}
            className="h-24 w-32 shrink-0 rounded-lg bg-canvas"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">
              {data.make} {selected.model}
              {data.year ? ` · ${data.year}` : ''}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-mid">
              Starts at{' '}
              <span className="font-mono text-ink">
                {selected.consumption_l_per_100km} L/100 km
              </span>{' '}
              and a <span className="font-mono text-ink">{selected.tank_liters} L</span> tank.
              Your fill-ups replace that with this vehicle&apos;s measured rate.
            </p>
            <p className="mt-1 text-[11px] text-ink-dim">
              Body-type illustration — not a render of this exact model.
            </p>
          </div>
        </div>
      )}

      <Field label="Current odometer reading">
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            value={data.odometerReading}
            onChange={(e) => set('odometerReading', e.target.value)}
            className={pairedInputClass}
            placeholder="50813"
          />
          <select
            value={data.odometerUnit}
            onChange={(e) => set('odometerUnit', e.target.value)}
            className={`${unitSelectClass} w-24`}
            aria-label="Odometer unit"
          >
            <option value="mi">miles</option>
            <option value="km">km</option>
          </select>
        </div>
        <p className="mt-1 text-xs text-ink-dim">
          Read it off the dashboard now. The tracker only counts distance from the
          day it is fitted, so this is what makes true mileage possible.
        </p>
      </Field>

      <Field label="Fuel economy from the dashboard (optional)">
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            step="0.1"
            value={data.economyReading}
            onChange={(e) => set('economyReading', e.target.value)}
            className={pairedInputClass}
            placeholder="15"
          />
          {/* The unit is chosen, never assumed: 15 mpg is 6.38 km/L on a US
              gauge and 5.31 on an imperial one — a 20% error in the figure the
              whole fuel model is anchored on. */}
          <select
            value={data.economyUnit}
            onChange={(e) => set('economyUnit', e.target.value)}
            className={`${unitSelectClass} w-40`}
            aria-label="Fuel economy unit"
          >
            {(Object.keys(ECONOMY_UNIT_LABELS) as EconomyUnit[]).map((u) => (
              <option key={u} value={u}>
                {ECONOMY_UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-xs text-ink-dim">
          Long-term average from the trip computer. Without it we fall back to a figure for the
          model, which ignores this vehicle&apos;s age and condition. You can change it later in
          Calibration.
        </p>
      </Field>

      <Field label="IMEI (from device sticker)">
        <input
          required={imeiRequired}
          pattern="\d{15}"
          maxLength={15}
          value={data.imei}
          onChange={(e) => set('imei', e.target.value.replace(/\D/g, ''))}
          className={`${inputClass} font-mono`}
          placeholder="356307042441013"
        />
        <p className="mt-1 text-xs text-ink-dim">
          Found on the device box or sticker — 15 digits
        </p>
      </Field>
    </div>
  );
}
