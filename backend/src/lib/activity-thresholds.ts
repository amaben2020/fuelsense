/** Daily distance bands for Lagos commercial fleet (km/day). */
export const DAILY_DISTANCE_BY_MODEL: Record<string, { min: number; max: number; expected: number }> = {
  Hiace: { min: 80, max: 480, expected: 320 },
  Hilux: { min: 70, max: 450, expected: 300 },
  RAV4: { min: 60, max: 520, expected: 280 },
  Camry: { min: 50, max: 380, expected: 220 },
};

export const DEFAULT_DAILY_DISTANCE = { min: 60, max: 420, expected: 260 };

/** L/100km deviation tiers — positive % = worse than baseline. */
export const EFFICIENCY_TIERS = [
  { maxDeviation: 10, status: 'normal', label: 'NORMAL', severity: 'none' },
  { maxDeviation: 25, status: 'low_efficiency', label: 'LOW EFFICIENCY', severity: 'medium' },
  { maxDeviation: 50, status: 'low_efficiency', label: 'LOW EFFICIENCY', severity: 'high' },
  { maxDeviation: Infinity, status: 'low_efficiency', label: 'LOW EFFICIENCY', severity: 'critical' },
];

/** Flag when L/100km exceeds baseline by this % (fleet-efficiency compat). */
export const EFFICIENCY_VARIANCE_THRESHOLD_PERCENT = 10;

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatActivityDateDisplay(activityDate: string): string {
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

interface DataAnomalyParams {
  distanceKm: number;
  fuelUsed: number;
  efficiencyL100km: number | null;
  idleHours: number;
}

export function detectDataAnomaly({ distanceKm, fuelUsed, efficiencyL100km, idleHours }: DataAnomalyParams): boolean {
  if (distanceKm < 15 && fuelUsed >= 5) return true;
  if (distanceKm > 0 && fuelUsed / distanceKm > 2) return true;
  if (efficiencyL100km != null && efficiencyL100km > 200 && distanceKm >= 1) return true;
  if (distanceKm < 5 && idleHours >= 2 && fuelUsed >= 3) return true;
  return false;
}

interface ClassifyDailyRowParams {
  model: string | null;
  distanceKm: number;
  fuelUsed: number;
  efficiencyL100km: number | null;
  expectedEfficiencyL100km: number | null;
  deviationPercent?: number | null;
  idleHours: number;
  tripCount: number;
}

interface DailyRowClassification {
  status: string;
  status_label: string;
  status_severity: string;
  data_anomaly: boolean;
  display_efficiency_l_100km: number | null;
  insight: string;
}

export function classifyDailyRow({
  model,
  distanceKm,
  fuelUsed,
  efficiencyL100km,
  expectedEfficiencyL100km,
  deviationPercent,
  idleHours,
  tripCount,
}: ClassifyDailyRowParams): DailyRowClassification {
  const band = dailyDistanceThreshold(model ?? '');
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

interface BuildDailyInsightParams {
  dataAnomaly: boolean;
  distanceKm: number;
  fuelUsed: number;
  idleHours: number;
  tripCount: number;
  model: string | null | undefined;
  band: { min: number; max: number; expected: number };
  deviationPercent?: number | null;
  displayStatus?: string;
  efficiencyL100km: number | null;
  expectedEfficiencyL100km: number | null;
}

export function buildDailyInsight({
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
}: BuildDailyInsightParams): string {
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

export function dailyDistanceThreshold(model: string): { min: number; max: number; expected: number } {
  return DAILY_DISTANCE_BY_MODEL[model] || DEFAULT_DAILY_DISTANCE;
}

/** Positive % = worse (more L/100km than baseline). */
export function efficiencyDeviationPercent(
  actualL100km: number | null,
  baselineL100km: number | null
): number | null {
  if (actualL100km == null || baselineL100km == null || baselineL100km <= 0) return null;
  return Math.round(((actualL100km - baselineL100km) / baselineL100km) * 1000) / 10;
}

export function getEfficiencyStatus(deviationPercent: number | null): { status: string; label: string; severity: string } {
  if (deviationPercent == null) {
    return { status: 'unknown', label: '—', severity: 'none' };
  }
  if (deviationPercent <= 10) return EFFICIENCY_TIERS[0];
  if (deviationPercent <= 25) return EFFICIENCY_TIERS[1];
  if (deviationPercent <= 50) return EFFICIENCY_TIERS[2];
  return EFFICIENCY_TIERS[3];
}

export const FLAG_META: Record<string, { label: string; suggestion: string }> = {
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

interface BuildDailyFlagsParams {
  vehicleId: string;
  licensePlate: string;
  driverName: string | null;
  activityDate: string;
  model: string | null;
  distanceKm: number;
  fuelUsed: number;
  idleHours?: number;
  efficiencyL100km: number | null;
  expectedEfficiencyL100km: number | null;
  deviationPercent?: number | null;
}

export function buildDailyFlags({
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
}: BuildDailyFlagsParams): unknown[] {
  const band = dailyDistanceThreshold(model ?? '');
  const dev =
    deviationPercent ??
    efficiencyDeviationPercent(efficiencyL100km, expectedEfficiencyL100km);
  const flags: unknown[] = [];

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
export function evaluateDailyFlags(args: BuildDailyFlagsParams): string[] {
  return (buildDailyFlags(args) as Array<{ flag_type: string }>).map((f) => f.flag_type);
}
