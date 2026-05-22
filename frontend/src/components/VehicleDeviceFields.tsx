import { Field, inputClass } from '@/components/AuthLayout';

export interface VehicleFormData {
  licensePlate: string;
  make: string;
  model: string;
  year: string;
  tankCapacityLiters: string;
  imei: string;
}

export const emptyVehicle = (): VehicleFormData => ({
  licensePlate: '',
  make: '',
  model: '',
  year: '',
  tankCapacityLiters: '',
  imei: '',
});

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
