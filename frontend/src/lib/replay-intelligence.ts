import type { EventReplayMoment, EventReplayReading, EventReplayResponse } from '@/lib/api';
import { TRUST_COPY } from '@/lib/trust-language';

export function formatReplayClock(iso: string) {
  return new Date(iso).toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Lagos',
  });
}

function secondsBetween(a: string, b: string) {
  return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
}

function dropWindow(readings: EventReplayReading[], anomalyIndex: number) {
  const end = readings[anomalyIndex];
  if (!end?.fuel_level_liters) return { drop: 0, seconds: 0, startIndex: anomalyIndex };

  let startIndex = anomalyIndex;
  let drop = 0;
  for (let i = anomalyIndex; i > 0; i -= 1) {
    const prev = readings[i - 1];
    const curr = readings[i];
    if (prev.fuel_level_liters == null || curr.fuel_level_liters == null) break;
    const step = prev.fuel_level_liters - curr.fuel_level_liters;
    if (step <= 0.2) break;
    drop += step;
    startIndex = i - 1;
  }
  if (drop <= 0 && anomalyIndex > 0) {
    const prev = readings[anomalyIndex - 1];
    if (prev.fuel_level_liters != null && end.fuel_level_liters != null) {
      drop = Math.max(0, prev.fuel_level_liters - end.fuel_level_liters);
      startIndex = anomalyIndex - 1;
    }
  }

  const start = readings[startIndex];
  const seconds =
    start && end ? secondsBetween(start.recorded_at, end.recorded_at) : 0;
  return { drop, seconds, startIndex };
}

export function buildPrimaryExplanation(
  data: EventReplayResponse,
  readings: EventReplayReading[],
  anomalyIndex: number
) {
  const { drop, seconds } = dropWindow(readings, anomalyIndex);
  const at = readings[anomalyIndex];
  const ignition = at?.ignition_on ? 'ON' : 'OFF';
  const speed = at?.speed_kph ?? 0;

  if (data.event_type === 'receipt_fraud') {
    const declared = data.anomaly.declared_liters;
    const observed = data.anomaly.obd_liters_actual;
    if (declared != null && observed != null) {
      return `Receipt claimed ${declared.toFixed(1)}L but the tank rose ${observed.toFixed(1)}L within the refuel window — ${TRUST_COPY.requiresReview.toLowerCase()}.`;
    }
    return `Receipt volume could not be matched to any tank rise — ${TRUST_COPY.requiresReview.toLowerCase()}.`;
  }

  if (drop >= 0.5) {
    const dur =
      seconds >= 60
        ? `${Math.round(seconds / 60)} min`
        : `${seconds} second${seconds === 1 ? '' : 's'}`;
    return `Modelled tank level fell ${drop.toFixed(1)}L within ${dur} while ignition ${ignition} and speed ${speed} km/h.`;
  }

  return data.anomaly.reasons[0] ?? TRUST_COPY.siphonTitle;
}

export type CausalStep = {
  time: string;
  label: string;
  kind: 'context' | 'signal' | 'anomaly' | 'alert';
};

export function buildCausalTimeline(
  data: EventReplayResponse,
  readings: EventReplayReading[],
  moments: EventReplayMoment[],
  anomalyIndex: number
): CausalStep[] {
  const steps: CausalStep[] = [];
  const { startIndex } = dropWindow(readings, anomalyIndex);

  const parkedBefore = readings.findIndex(
    (r, i) => i <= startIndex && (r.speed_kph ?? 0) === 0
  );
  if (parkedBefore >= 0) {
    steps.push({
      time: readings[parkedBefore].recorded_at,
      label: 'Vehicle parked (0 km/h)',
      kind: 'context',
    });
  }

  const ignitionOff = readings.find(
    (r, i) => i <= anomalyIndex && !r.ignition_on
  );
  if (ignitionOff) {
    steps.push({
      time: ignitionOff.recorded_at,
      label: 'Ignition OFF',
      kind: 'signal',
    });
  }

  const dropMoment =
    moments.find((m) => m.type === 'fuel_drop' || m.type === 'anomaly') ??
    data.anomaly_moment;
  if (dropMoment) {
    const liters =
      dropMoment.fuel_drop_liters ??
      data.anomaly.liters_lost;
    steps.push({
      time: dropMoment.recorded_at,
      label: `Fuel level rapidly drops (−${liters.toFixed(1)}L)`,
      kind: 'anomaly',
    });
  }

  const afterDrop = readings[anomalyIndex + 1] ?? readings[anomalyIndex];
  if (afterDrop && (afterDrop.speed_kph ?? 0) === 0) {
    steps.push({
      time: afterDrop.recorded_at,
      label: 'Vehicle remains stationary',
      kind: 'context',
    });
  }

  steps.push({
    time: data.anomaly_at,
    label: 'Flag generated for manager review',
    kind: 'alert',
  });

  const byTime = new Map<string, CausalStep>();
  for (const s of steps) byTime.set(s.time, s);
  return [...byTime.values()].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
}

/**
 * Client-side fallback for when the API predates the honest payload.
 *
 * Only facts that can be read off the readings in hand appear here. The earlier
 * version opened every list with "Stable OBD fuel readings in replay window",
 * which was untrue on two counts: these trackers send no OBD or CAN element,
 * and the level plotted is a tank modelled from distance and idle time.
 */
export function buildConfidenceFactors(
  data: EventReplayResponse,
  readings: EventReplayReading[] = [],
  anomalyIndex = 0
): string[] {
  if (data.anomaly.confidence_factors?.length) return data.anomaly.confidence_factors;

  const { startIndex } = dropWindow(readings, anomalyIndex);
  const window = readings.slice(startIndex, anomalyIndex + 1);
  const factors: string[] = [];

  if (window.length) {
    factors.push(`${window.length} GPS fix${window.length === 1 ? '' : 'es'} across the drop window`);
    if (window.every((r) => !r.ignition_on)) factors.push('Ignition logged OFF for the whole drop');
    if (window.every((r) => (r.speed_kph ?? 0) === 0))
      factors.push('Vehicle stationary throughout (0 km/h)');
  }

  const refuel = readings.some((r, i) => {
    if (i === 0) return false;
    const prev = readings[i - 1].fuel_level_liters;
    return prev != null && r.fuel_level_liters != null && r.fuel_level_liters - prev >= 5;
  });
  if (!refuel && readings.length) factors.push('No refuel of 5L or more in this window');

  return factors;
}

export function buildBaselineComparison(
  readings: EventReplayReading[],
  anomalyIndex: number
) {
  const { drop, seconds } = dropWindow(readings, anomalyIndex);
  const hours = Math.max(seconds / 3600, 1 / 3600);
  const observedRate = drop / hours;

  return {
    observed:
      seconds < 90
        ? `${drop.toFixed(1)}L in ${seconds}s`
        : `${drop.toFixed(1)}L in ~${Math.max(1, Math.round(seconds / 60))} min`,
    observedRatePerHour: observedRate,
    isAbnormal: observedRate > 1.5 || drop >= 3,
  };
}

export type CorrelationRow = {
  signal: string;
  state: string;
  detail: string;
  tone: 'neutral' | 'warn' | 'alert';
};

export function buildCorrelationAt(
  reading: EventReplayReading | undefined,
  data: EventReplayResponse
): CorrelationRow[] {
  if (!reading) return [];

  const speed = reading.speed_kph ?? 0;
  const ignition = reading.ignition_on;
  const fuelState =
    data.anomaly.liters_lost >= 3 ? 'RAPID DROP' : data.anomaly.liters_lost > 0 ? 'DROP' : 'STABLE';

  return [
    {
      signal: 'Ignition',
      state: ignition ? 'ON' : 'OFF',
      detail: ignition ? 'Engine running' : 'Engine off — typical for parked review',
      tone: ignition ? 'neutral' : 'warn',
    },
    {
      signal: 'Movement',
      state: speed === 0 ? 'NONE' : 'ACTIVE',
      detail: speed === 0 ? 'Stationary' : `Moving at ${speed} km/h`,
      tone: speed === 0 ? 'neutral' : 'warn',
    },
    {
      signal: 'Speed',
      state: `${speed} km/h`,
      detail: speed === 0 ? '0 km/h' : 'Non-zero speed during window',
      tone: speed === 0 ? 'neutral' : 'warn',
    },
    {
      // Not an OBD reading. The level is a tank modelled from distance driven
      // and idle time, so the label says so rather than borrowing the
      // authority of a sensor this hardware does not have.
      signal: 'Fuel (modelled)',
      state: fuelState,
      detail:
        fuelState === 'RAPID DROP'
          ? `−${data.anomaly.liters_lost.toFixed(1)}L vs prior reading`
          : 'Within normal drift for this scrubber position',
      tone: fuelState === 'RAPID DROP' ? 'alert' : 'neutral',
    },
  ];
}

export function buildRecommendedActions(data: EventReplayResponse): string[] {
  if (data.anomaly.recommended_actions?.length) return data.anomaly.recommended_actions;

  const actions = [
    'Walk through synchronized replay before deciding',
    TRUST_COPY.requiresReview,
  ];

  if (data.event_type === 'receipt_fraud') {
    actions.push('Verify fuel receipt and station timestamp');
    actions.push('Compare declared litres against the tank curve');
  } else {
    actions.push('Verify fuel receipts for this vehicle on the same day');
    actions.push('Contact assigned driver for operational context');
    actions.push('Review depot CCTV if available');
  }

  return actions;
}

export function improveWhyFlagged(
  data: EventReplayResponse,
  readings: EventReplayReading[],
  anomalyIndex: number
): string[] {
  if (data.anomaly.why_flagged?.length) return data.anomaly.why_flagged;

  const primary = buildPrimaryExplanation(data, readings, anomalyIndex);
  const rest = data.anomaly.reasons.filter((r) => !primary.includes(r.slice(0, 12)));
  return [primary, ...rest, TRUST_COPY.notVerdict].slice(0, 6);
}

export function anomalyDisplayTitle(data: EventReplayResponse) {
  if (data.event_type === 'receipt_fraud') return TRUST_COPY.receiptMismatchTitle;
  if (data.event_type === 'siphon') return TRUST_COPY.siphonTitle;
  return data.anomaly.type;
}
