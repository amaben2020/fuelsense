/** Realistic km/L baselines for Nigerian fleet vehicles (diesel/petrol mix). */
export const VEHICLE_EFFICIENCY: Record<string, { min: number; max: number; avg: number }> = {
  Hiace: { min: 6.5, max: 8.5, avg: 7.5 },
  Hilux: { min: 7.0, max: 9.0, avg: 8.0 },
  RAV4: { min: 9.0, max: 12.0, avg: 10.5 },
  Camry: { min: 10.0, max: 14.0, avg: 12.0 },
};

const DEFAULT_EFFICIENCY = { min: 7.0, max: 10.0, avg: 8.5 };

/** Vehicle classes with their industry-average starting figures. These are only
 *  a seed: once a vehicle has enough logged fill-ups, its own measured rate
 *  replaces the preset entirely (see CALIBRATION_MIN_PURCHASES). */
export type VehicleType =
  | 'sedan'
  | 'suv_pickup'
  | 'van_bus'
  | 'medium_truck'
  | 'heavy_truck'
  | 'motorcycle';

export interface VehicleTypePreset {
  consumptionL100km: number;
  idleBurnLph: number;
  label: string;
}

export const VEHICLE_TYPE_PRESETS: Record<VehicleType, VehicleTypePreset> = {
  sedan: { consumptionL100km: 8, idleBurnLph: 0.7, label: 'Sedan' },
  suv_pickup: { consumptionL100km: 11.5, idleBurnLph: 0.9, label: 'SUV / Pickup' },
  van_bus: { consumptionL100km: 12.5, idleBurnLph: 1.15, label: 'Van / Bus' },
  medium_truck: { consumptionL100km: 21, idleBurnLph: 1.55, label: 'Medium truck' },
  heavy_truck: { consumptionL100km: 35, idleBurnLph: 2.4, label: 'Heavy truck' },
  motorcycle: { consumptionL100km: 2.5, idleBurnLph: 0.2, label: 'Motorcycle' },
};

export const DEFAULT_VEHICLE_TYPE: VehicleType = 'suv_pickup';

export function isVehicleType(value: unknown): value is VehicleType {
  return typeof value === 'string' && value in VEHICLE_TYPE_PRESETS;
}

export function presetForVehicleType(type: string | null | undefined): VehicleTypePreset {
  return VEHICLE_TYPE_PRESETS[isVehicleType(type) ? type : DEFAULT_VEHICLE_TYPE];
}

/** Fill-ups needed before a vehicle's measured rate replaces its class preset. */
export const CALIBRATION_MIN_PURCHASES = Number(process.env.CALIBRATION_MIN_PURCHASES || 2);

/** Real-world economy follows a U-curve: stop-start crawling and motorway speeds
 *  both burn more than a mid-range cruise. Applied as a multiplier on top of the
 *  vehicle's base rate rather than baked into it, so the base stays comparable. */
export const SPEED_BUCKETS: Array<{ maxKph: number; multiplier: number; label: string }> = [
  { maxKph: 20, multiplier: 1.3, label: 'Stop-start' },
  { maxKph: 60, multiplier: 1.0, label: 'Urban / baseline' },
  { maxKph: 100, multiplier: 1.1, label: 'Highway' },
  { maxKph: Infinity, multiplier: 1.25, label: 'High speed' },
];

export function speedBucketMultiplier(avgSpeedKph: number | null | undefined): number {
  // No usable average (very short or stationary segment) — don't invent an
  // adjustment; the baseline is the honest answer.
  if (avgSpeedKph == null || !Number.isFinite(avgSpeedKph) || avgSpeedKph <= 0) return 1;
  return SPEED_BUCKETS.find((b) => avgSpeedKph < b.maxKph)?.multiplier ?? 1;
}

export function speedBucketLabel(avgSpeedKph: number | null | undefined): string | null {
  if (avgSpeedKph == null || avgSpeedKph <= 0) return null;
  return SPEED_BUCKETS.find((b) => avgSpeedKph < b.maxKph)?.label ?? null;
}

export const CO2_KG_PER_LITER = 2.31;
export const REFUEL_THRESHOLD_LITERS = 5;
export const THEFT_DROP_THRESHOLD_LITERS = 12;
export const IDLE_BURN_LITERS_PER_HOUR = 0.9;
export const DEFAULT_FUEL_PRICE_NGN_LITER = 1300;

export function efficiencyProfileForModel(model: string): { min: number; max: number; avg: number } {
  return VEHICLE_EFFICIENCY[model] || DEFAULT_EFFICIENCY;
}

export function sampleEfficiencyKmL(model: string, seed = Math.random()): number {
  const profile = efficiencyProfileForModel(model);
  return profile.min + seed * (profile.max - profile.min);
}

export function fuelUsedForDistanceKm(distanceKm: number, efficiencyKmL: number): number {
  if (distanceKm <= 0 || efficiencyKmL <= 0) return 0;
  return distanceKm / efficiencyKmL;
}

export function idleFuelBurnLiters(intervalHours: number): number {
  return IDLE_BURN_LITERS_PER_HOUR * intervalHours;
}

export function isRefuelEvent(prevFuel: number | null, nextFuel: number | null): boolean {
  return nextFuel != null && prevFuel != null && nextFuel - prevFuel >= REFUEL_THRESHOLD_LITERS;
}

export function isTheftDrop(
  prevFuel: number | null,
  nextFuel: number | null,
  speedKph: number | null,
  ignitionOn: boolean | null
): boolean {
  if (prevFuel == null || nextFuel == null) return false;
  const drop = prevFuel - nextFuel;
  if (drop < THEFT_DROP_THRESHOLD_LITERS) return false;
  return !ignitionOn || (speedKph != null && speedKph < 2);
}

export function consumptionFromFuelDelta(
  prevFuel: number | null,
  nextFuel: number | null,
  speedKph: number | null,
  ignitionOn: boolean | null
): number {
  if (prevFuel == null || nextFuel == null) return 0;
  if (isRefuelEvent(prevFuel, nextFuel)) return 0;
  if (isTheftDrop(prevFuel, nextFuel, speedKph, ignitionOn)) return 0;
  if (nextFuel < prevFuel) return prevFuel - nextFuel;
  return 0;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function baselineEfficiencyKmL(model: string): number {
  return efficiencyProfileForModel(model).avg;
}

/** Liters per 100 km — standard Nigerian fleet metric (lower is better). */
export function computeL100km(fuelLiters: number, distanceKm: number): number | null {
  if (distanceKm <= 0 || fuelLiters < 0.5) return null;
  return round1((fuelLiters / distanceKm) * 100);
}

export function kmLToL100km(kmL: number | null): number | null {
  if (!kmL || kmL <= 0) return null;
  return round1(100 / kmL);
}

export function baselineEfficiencyL100km(model: string): number {
  return kmLToL100km(baselineEfficiencyKmL(model)) as number;
}

/** 1 km/L = 2.35215 miles per US gallon. */
export const KM_PER_LITER_TO_MPG = 2.35215;

export function kmLToMpg(kmL: number | null): number | null {
  if (!kmL || kmL <= 0) return null;
  return round1(kmL * KM_PER_LITER_TO_MPG);
}

/** Positive % = worse (more fuel per 100 km than baseline). */
export function efficiencyDeviationPercentL100km(
  actualL100km: number | null,
  baselineL100km: number | null
): number | null {
  if (actualL100km == null || baselineL100km == null || baselineL100km <= 0) return null;
  return Math.round(((actualL100km - baselineL100km) / baselineL100km) * 1000) / 10;
}
