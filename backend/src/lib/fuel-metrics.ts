/** Realistic km/L baselines for Nigerian fleet vehicles (diesel/petrol mix). */
export const VEHICLE_EFFICIENCY: Record<string, { min: number; max: number; avg: number }> = {
  Hiace: { min: 6.5, max: 8.5, avg: 7.5 },
  Hilux: { min: 7.0, max: 9.0, avg: 8.0 },
  RAV4: { min: 9.0, max: 12.0, avg: 10.5 },
  Camry: { min: 10.0, max: 14.0, avg: 12.0 },
};

const DEFAULT_EFFICIENCY = { min: 7.0, max: 10.0, avg: 8.5 };

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
