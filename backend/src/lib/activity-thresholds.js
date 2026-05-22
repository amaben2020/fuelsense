/** Daily distance bands for Lagos commercial fleet (km/day). */
const DAILY_DISTANCE_BY_MODEL = {
  Hiace: { min: 80, max: 480, expected: 320 },
  Hilux: { min: 70, max: 450, expected: 300 },
  RAV4: { min: 60, max: 520, expected: 280 },
  Camry: { min: 50, max: 380, expected: 220 },
};

const DEFAULT_DAILY_DISTANCE = { min: 60, max: 420, expected: 260 };

/** Flag when actual efficiency is this % below model baseline. */
const EFFICIENCY_VARIANCE_THRESHOLD_PERCENT = -10;

/** Flag when daily distance exceeds model max. */
const DISTANCE_OVER_MAX_FLAG = true;

/** Flag when daily distance below model min (possible idle misuse). */
const DISTANCE_UNDER_MIN_FLAG = true;

function dailyDistanceThreshold(model) {
  return DAILY_DISTANCE_BY_MODEL[model] || DEFAULT_DAILY_DISTANCE;
}

function evaluateDailyFlags({
  model,
  distanceKm,
  efficiencyKmL,
  expectedEfficiencyKmL,
}) {
  const band = dailyDistanceThreshold(model);
  const flags = [];

  if (DISTANCE_OVER_MAX_FLAG && distanceKm > band.max) {
    flags.push('high_distance');
  }
  if (DISTANCE_UNDER_MIN_FLAG && distanceKm > 0 && distanceKm < band.min) {
    flags.push('low_utilization');
  }
  if (
    efficiencyKmL != null &&
    expectedEfficiencyKmL > 0 &&
    ((efficiencyKmL - expectedEfficiencyKmL) / expectedEfficiencyKmL) * 100 <=
      EFFICIENCY_VARIANCE_THRESHOLD_PERCENT
  ) {
    flags.push('below_efficiency');
  }

  return flags;
}

module.exports = {
  DAILY_DISTANCE_BY_MODEL,
  DEFAULT_DAILY_DISTANCE,
  EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
  dailyDistanceThreshold,
  evaluateDailyFlags,
};
