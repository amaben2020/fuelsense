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
import { ECONOMY_UNIT_LABELS, EconomyUnit } from '@/lib/api';

const FIELD_LABEL =
  'mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-ink-dim';
const FIELD_INPUT =
  'w-full rounded-xl border border-edge bg-panel-deep px-3.5 py-2.5 text-sm text-ink ' +
  'placeholder:text-ink-dim transition-colors focus:border-brand focus:outline-none ' +
  'focus:ring-1 focus:ring-brand';

const inputClass = FIELD_INPUT;

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

      <div className="grid grid-cols-2 gap-3">
        <Field label="Make">
          <input
            required
            value={data.make}
            onChange={(e) => set('make', e.target.value)}
            className={inputClass}
            placeholder="Toyota"
          />
        </Field>
        <Field label="Model">
          <input
            required
            value={data.model}
            onChange={(e) => set('model', e.target.value)}
            className={inputClass}
            placeholder="Hiace"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Year">
          <input
            type="number"
            required
            value={data.year}
            onChange={(e) => set('year', e.target.value)}
            className={inputClass}
            placeholder="2019"
          />
        </Field>
        <Field label="Tank capacity (L)">
          <input
            type="number"
            value={data.tankCapacityLiters}
            onChange={(e) => set('tankCapacityLiters', e.target.value)}
            className={inputClass}
            placeholder="80"
          />
        </Field>
      </div>

      <Field label="Current odometer reading">
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            value={data.odometerReading}
            onChange={(e) => set('odometerReading', e.target.value)}
            className={inputClass}
            placeholder="50813"
          />
          <select
            value={data.odometerUnit}
            onChange={(e) => set('odometerUnit', e.target.value)}
            className={`${inputClass} w-24 shrink-0`}
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
            className={inputClass}
            placeholder="15"
          />
          {/* The unit is chosen, never assumed: 15 mpg is 6.38 km/L on a US
              gauge and 5.31 on an imperial one — a 20% error in the figure the
              whole fuel model is anchored on. */}
          <select
            value={data.economyUnit}
            onChange={(e) => set('economyUnit', e.target.value)}
            className={`${inputClass} w-40 shrink-0`}
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
