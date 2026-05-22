/** Realistic km/L baselines for Nigerian fleet vehicles (diesel/petrol mix). */
const VEHICLE_EFFICIENCY = {
  Hiace: { min: 6.5, max: 8.5, avg: 7.5 },
  Hilux: { min: 7.0, max: 9.0, avg: 8.0 },
  RAV4: { min: 9.0, max: 12.0, avg: 10.5 },
  Camry: { min: 10.0, max: 14.0, avg: 12.0 },
};

const DEFAULT_EFFICIENCY = { min: 7.0, max: 10.0, avg: 8.5 };

const CO2_KG_PER_LITER = 2.31;
const REFUEL_THRESHOLD_LITERS = 5;
const THEFT_DROP_THRESHOLD_LITERS = 12;
const IDLE_BURN_LITERS_PER_HOUR = 0.9;

function efficiencyProfileForModel(model) {
  return VEHICLE_EFFICIENCY[model] || DEFAULT_EFFICIENCY;
}

function sampleEfficiencyKmL(model, seed = Math.random()) {
  const profile = efficiencyProfileForModel(model);
  return profile.min + seed * (profile.max - profile.min);
}

function fuelUsedForDistanceKm(distanceKm, efficiencyKmL) {
  if (distanceKm <= 0 || efficiencyKmL <= 0) return 0;
  return distanceKm / efficiencyKmL;
}

function idleFuelBurnLiters(intervalHours) {
  return IDLE_BURN_LITERS_PER_HOUR * intervalHours;
}

function isRefuelEvent(prevFuel, nextFuel) {
  return nextFuel != null && prevFuel != null && nextFuel - prevFuel >= REFUEL_THRESHOLD_LITERS;
}

function isTheftDrop(prevFuel, nextFuel, speedKph, ignitionOn) {
  if (prevFuel == null || nextFuel == null) return false;
  const drop = prevFuel - nextFuel;
  if (drop < THEFT_DROP_THRESHOLD_LITERS) return false;
  return !ignitionOn || (speedKph != null && speedKph < 2);
}

function consumptionFromFuelDelta(prevFuel, nextFuel, speedKph, ignitionOn) {
  if (prevFuel == null || nextFuel == null) return 0;
  if (isRefuelEvent(prevFuel, nextFuel)) return 0;
  if (isTheftDrop(prevFuel, nextFuel, speedKph, ignitionOn)) return 0;
  if (nextFuel < prevFuel) return prevFuel - nextFuel;
  return 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function baselineEfficiencyKmL(model) {
  return efficiencyProfileForModel(model).avg;
}

module.exports = {
  VEHICLE_EFFICIENCY,
  CO2_KG_PER_LITER,
  REFUEL_THRESHOLD_LITERS,
  THEFT_DROP_THRESHOLD_LITERS,
  IDLE_BURN_LITERS_PER_HOUR,
  efficiencyProfileForModel,
  baselineEfficiencyKmL,
  sampleEfficiencyKmL,
  fuelUsedForDistanceKm,
  idleFuelBurnLiters,
  isRefuelEvent,
  isTheftDrop,
  consumptionFromFuelDelta,
  round1,
  round2,
};
