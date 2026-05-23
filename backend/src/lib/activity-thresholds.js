/** Daily distance bands for Lagos commercial fleet (km/day). */
const DAILY_DISTANCE_BY_MODEL = {
  Hiace: { min: 80, max: 480, expected: 320 },
  Hilux: { min: 70, max: 450, expected: 300 },
  RAV4: { min: 60, max: 520, expected: 280 },
  Camry: { min: 50, max: 380, expected: 220 },
};

const DEFAULT_DAILY_DISTANCE = { min: 60, max: 420, expected: 260 };

/** L/100km deviation tiers — positive % = worse than baseline. */
const EFFICIENCY_TIERS = [
  { maxDeviation: 10, status: 'normal', label: 'NORMAL', severity: 'none' },
  { maxDeviation: 25, status: 'low_efficiency', label: 'LOW EFFICIENCY', severity: 'medium' },
  { maxDeviation: 50, status: 'low_efficiency', label: 'LOW EFFICIENCY', severity: 'high' },
  { maxDeviation: Infinity, status: 'low_efficiency', label: 'LOW EFFICIENCY', severity: 'critical' },
];

/** Flag when L/100km exceeds baseline by this % (fleet-efficiency compat). */
const EFFICIENCY_VARIANCE_THRESHOLD_PERCENT = 10;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatActivityDateDisplay(activityDate) {
  const iso = String(activityDate).slice(0, 10);
  const d = new Date(`${iso}T12:00:00Z`);
  const weekday = WEEKDAYS[d.getUTCDay()] ?? '';
  const [, month, day] = iso.split('-');
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const monthLabel = months[Number(month) - 1] ?? month;
  return `${weekday}, ${Number(day)} ${monthLabel}`;
}

function detectDataAnomaly({ distanceKm, fuelUsed, efficiencyL100km, idleHours }) {
  if (distanceKm < 15 && fuelUsed >= 5) return true;
  if (distanceKm > 0 && fuelUsed / distanceKm > 2) return true;
  if (efficiencyL100km != null && efficiencyL100km > 200 && distanceKm >= 1) return true;
  if (distanceKm < 5 && idleHours >= 2 && fuelUsed >= 3) return true;
  return false;
}

function classifyDailyRow({
  model,
  distanceKm,
  fuelUsed,
  efficiencyL100km,
  expectedEfficiencyL100km,
  deviationPercent,
  idleHours,
  tripCount,
}) {
  const band = dailyDistanceThreshold(model);
  const dev =
    deviationPercent ??
    efficiencyDeviationPercent(efficiencyL100km, expectedEfficiencyL100km);
  const dataAnomaly = detectDataAnomaly({
    distanceKm,
    fuelUsed,
    efficiencyL100km,
    idleHours,
  });

  if (dataAnomaly) {
    return {
      status: 'data_anomaly',
      status_label: 'DATA ANOMALY',
      status_severity: 'critical',
      data_anomaly: true,
      display_efficiency_l_100km: null,
      insight: buildDailyInsight({
        dataAnomaly: true,
        distanceKm,
        fuelUsed,
        idleHours,
        tripCount,
        model,
        band,
        deviationPercent: dev,
        efficiencyL100km,
        expectedEfficiencyL100km,
      }),
    };
  }

  if (distanceKm > band.max) {
    return {
      status: 'high_usage',
      status_label: 'HIGH USAGE',
      status_severity: 'medium',
      data_anomaly: false,
      display_efficiency_l_100km: efficiencyL100km,
      insight: buildDailyInsight({
        dataAnomaly: false,
        distanceKm,
        fuelUsed,
        idleHours,
        tripCount,
        model,
        band,
        deviationPercent: dev,
        displayStatus: 'high_usage',
        efficiencyL100km,
        expectedEfficiencyL100km,
      }),
    };
  }

  const tier = getEfficiencyStatus(dev);
  if (dev != null && dev > 10) {
    return {
      status: 'low_efficiency',
      status_label: 'LOW EFFICIENCY',
      status_severity: tier.severity === 'none' ? 'medium' : tier.severity,
      data_anomaly: false,
      display_efficiency_l_100km: efficiencyL100km,
      insight: buildDailyInsight({
        dataAnomaly: false,
        distanceKm,
        fuelUsed,
        idleHours,
        tripCount,
        model,
        band,
        deviationPercent: dev,
        displayStatus: 'low_efficiency',
        efficiencyL100km,
        expectedEfficiencyL100km,
      }),
    };
  }

  return {
    status: 'normal',
    status_label: 'NORMAL',
    status_severity: 'none',
    data_anomaly: false,
    display_efficiency_l_100km: efficiencyL100km,
    insight: buildDailyInsight({
      dataAnomaly: false,
      distanceKm,
      fuelUsed,
      idleHours,
      tripCount,
      model,
      band,
      deviationPercent: dev,
      displayStatus: 'normal',
      efficiencyL100km,
      expectedEfficiencyL100km,
    }),
  };
}

function buildDailyInsight({
  dataAnomaly,
  distanceKm,
  fuelUsed,
  idleHours,
  tripCount,
  model,
  band,
  deviationPercent,
  displayStatus,
  efficiencyL100km,
  expectedEfficiencyL100km,
}) {
  const vehicleType = model ?? 'fleet vehicle';

  if (dataAnomaly) {
    if (distanceKm < 15 && fuelUsed >= 5) {
      const idleNote =
        idleHours >= 2
          ? ` — ${idleHours.toFixed(1)}h idle recorded`
          : '';
      return `Likely idle-heavy or incomplete trip data: ${fuelUsed.toFixed(1)}L used for only ${Math.round(distanceKm)} km${idleNote}`;
    }
    return 'Sensor or trip data inconsistency — verify OBD readings before acting';
  }

  if (displayStatus === 'high_usage') {
    return `Distance ${Math.round(distanceKm)} km exceeds typical ${vehicleType} daily range (max ${band.max} km)`;
  }

  if (displayStatus === 'low_efficiency' && deviationPercent != null) {
    return `High fuel burn: ${efficiencyL100km?.toFixed(1) ?? '—'} L/100km vs ${expectedEfficiencyL100km?.toFixed(1) ?? '—'} L/100km target (+${Math.round(deviationPercent)}%)`;
  }

  if (distanceKm > 0 && distanceKm < band.min) {
    return `Underutilized day — ${Math.round(distanceKm)} km vs expected ${band.min}–${band.max} km for ${vehicleType}`;
  }

  if (tripCount <= 1 && distanceKm < band.expected * 0.5) {
    return `Light usage day — ${tripCount} trip(s), within range but below typical ${vehicleType} workload`;
  }

  if (efficiencyL100km != null && expectedEfficiencyL100km != null) {
    return `Operating within target — ${efficiencyL100km.toFixed(1)} L/100km vs ${expectedEfficiencyL100km.toFixed(1)} L/100km baseline`;
  }

  return `Operating within normal pattern for ${vehicleType}`;
}

function dailyDistanceThreshold(model) {
  return DAILY_DISTANCE_BY_MODEL[model] || DEFAULT_DAILY_DISTANCE;
}

/** Positive % = worse (more L/100km than baseline). */
function efficiencyDeviationPercent(actualL100km, baselineL100km) {
  if (actualL100km == null || baselineL100km == null || baselineL100km <= 0) return null;
  return Math.round(((actualL100km - baselineL100km) / baselineL100km) * 1000) / 10;
}

function getEfficiencyStatus(deviationPercent) {
  if (deviationPercent == null) {
    return { status: 'unknown', label: '—', severity: 'none' };
  }
  if (deviationPercent <= 10) return EFFICIENCY_TIERS[0];
  if (deviationPercent <= 25) return EFFICIENCY_TIERS[1];
  if (deviationPercent <= 50) return EFFICIENCY_TIERS[2];
  return EFFICIENCY_TIERS[3];
}

const FLAG_META = {
  low_efficiency: {
    label: 'Low Efficiency',
    suggestion: 'Investigate idle time or route inefficiency',
  },
  high_fuel_per_km: {
    label: 'High Fuel Consumption',
    suggestion: 'Review driving behaviour and load factors',
  },
  high_distance: {
    label: 'High Distance',
    suggestion: 'Verify route assignment and odometer integrity',
  },
  low_distance_use: {
    label: 'Low Distance Use',
    suggestion: 'Check vehicle assignment and utilization',
  },
};

function buildDailyFlags({
  vehicleId,
  licensePlate,
  driverName,
  activityDate,
  model,
  distanceKm,
  fuelUsed,
  idleHours,
  efficiencyL100km,
  expectedEfficiencyL100km,
  deviationPercent,
}) {
  const band = dailyDistanceThreshold(model);
  const dev =
    deviationPercent ??
    efficiencyDeviationPercent(efficiencyL100km, expectedEfficiencyL100km);
  const flags = [];

  if (dev != null && dev > 10) {
    const tier = getEfficiencyStatus(dev);
    flags.push({
      id: `${vehicleId}-${activityDate}-low_efficiency`,
      vehicle_id: vehicleId,
      license_plate: licensePlate,
      driver_name: driverName,
      activity_date: activityDate,
      flag_type: 'low_efficiency',
      flag_label: FLAG_META.low_efficiency.label,
      severity: tier.severity,
      reason: `${Math.round(dev)}% above L/100km baseline`,
      impact:
        dev > 50
          ? 'Critical fuel waste'
          : dev > 25
            ? 'High fuel waste'
            : 'Elevated fuel cost',
      suggestion: FLAG_META.low_efficiency.suggestion,
    });

    if (dev > 25) {
      flags.push({
        id: `${vehicleId}-${activityDate}-high_fuel_per_km`,
        vehicle_id: vehicleId,
        license_plate: licensePlate,
        driver_name: driverName,
        activity_date: activityDate,
        flag_type: 'high_fuel_per_km',
        flag_label: FLAG_META.high_fuel_per_km.label,
        severity: 'medium',
        reason: `${efficiencyL100km?.toFixed(1) ?? '—'} L/100km vs ${expectedEfficiencyL100km?.toFixed(1) ?? '—'} target`,
        impact: 'High fuel consumption per 100 km',
        suggestion: FLAG_META.high_fuel_per_km.suggestion,
      });
    }
  }

  if (distanceKm > band.max) {
    flags.push({
      id: `${vehicleId}-${activityDate}-high_distance`,
      vehicle_id: vehicleId,
      license_plate: licensePlate,
      driver_name: driverName,
      activity_date: activityDate,
      flag_type: 'high_distance',
      flag_label: FLAG_META.high_distance.label,
      severity: 'medium',
      reason: `${Math.round(distanceKm)} km exceeds max ${band.max} km/day`,
      impact: 'Possible overuse or route anomaly',
      suggestion: FLAG_META.high_distance.suggestion,
    });
  }

  if (distanceKm > 0 && distanceKm < band.min) {
    flags.push({
      id: `${vehicleId}-${activityDate}-low_distance_use`,
      vehicle_id: vehicleId,
      license_plate: licensePlate,
      driver_name: driverName,
      activity_date: activityDate,
      flag_type: 'low_distance_use',
      flag_label: FLAG_META.low_distance_use.label,
      severity: 'low',
      reason: `Below expected daily range (${band.min}–${band.max} km)`,
      impact: 'Underutilization',
      suggestion: FLAG_META.low_distance_use.suggestion,
    });
  }

  if (
    detectDataAnomaly({
      distanceKm,
      fuelUsed,
      efficiencyL100km,
      idleHours: idleHours ?? 0,
    })
  ) {
    flags.push({
      id: `${vehicleId}-${activityDate}-data_anomaly`,
      vehicle_id: vehicleId,
      license_plate: licensePlate,
      driver_name: driverName,
      activity_date: activityDate,
      flag_type: 'data_anomaly',
      flag_label: 'Data Anomaly',
      severity: 'critical',
      reason: 'Fuel/distance ratio inconsistent with normal operation',
      impact: 'Metrics unreliable until verified',
      suggestion: 'Check for idle burn, siphon event, or sensor gap',
    });
  }

  return flags;
}

/** @deprecated use buildDailyFlags */
function evaluateDailyFlags(args) {
  return buildDailyFlags(args).map((f) => f.flag_type);
}

module.exports = {
  DAILY_DISTANCE_BY_MODEL,
  DEFAULT_DAILY_DISTANCE,
  EFFICIENCY_TIERS,
  EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
  FLAG_META,
  WEEKDAYS,
  formatActivityDateDisplay,
  dailyDistanceThreshold,
  efficiencyDeviationPercent,
  getEfficiencyStatus,
  detectDataAnomaly,
  classifyDailyRow,
  buildDailyInsight,
  buildDailyFlags,
  evaluateDailyFlags,
};
