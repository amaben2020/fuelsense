import { Field, inputClass } from '@/components/AuthLayout';

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
});

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
      {title && <h4 className="font-medium text-slate-900">{title}</h4>}

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
        <p className="mt-1 text-xs text-slate-500">
          Read it off the dashboard now. The tracker only counts distance from the
          day it is fitted, so this is what makes true mileage possible.
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
        <p className="mt-1 text-xs text-slate-500">
          Found on the device box or sticker — 15 digits
        </p>
      </Field>
    </div>
  );
}
