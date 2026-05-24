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
    const obd = data.anomaly.obd_liters_actual;
    if (declared != null && obd != null) {
      return `Receipt claimed ${declared.toFixed(1)}L but OBD recorded ${obd.toFixed(1)}L within the refuel window — ${TRUST_COPY.requiresReview.toLowerCase()}.`;
    }
    return `Receipt volume could not be matched to OBD refuel signal — ${TRUST_COPY.requiresReview.toLowerCase()}.`;
  }

  if (drop >= 0.5) {
    const dur =
      seconds >= 60
        ? `${Math.round(seconds / 60)} min`
        : `${seconds} second${seconds === 1 ? '' : 's'}`;
    return `Fuel dropped ${drop.toFixed(1)}L within ${dur} while ignition ${ignition} and speed ${speed} km/h.`;
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

export function buildConfidenceFactors(data: EventReplayResponse): string[] {
  if (data.anomaly.confidence_factors?.length) return data.anomaly.confidence_factors;

  const factors: string[] = ['Stable OBD fuel readings in replay window'];
  if (data.event_type === 'siphon' || data.event_type === 'daily_flag') {
    factors.push('Ignition OFF correlated with fuel drop');
    factors.push('No verified refuel in same window');
    factors.push('Vehicle stationary during drop');
  }
  if (data.event_type === 'receipt_fraud') {
    factors.push('Receipt timestamp matched to telemetry window');
    factors.push('OBD refuel delta below declared volume');
    factors.push('Gap exceeds review threshold');
  }
  return factors;
}

export type CertaintyPoint = { time: string; percent: number };

export function buildCertaintyTimeline(
  readings: EventReplayReading[],
  anomalyIndex: number,
  finalPercent: number
): CertaintyPoint[] {
  const { startIndex } = dropWindow(readings, anomalyIndex);
  const start = readings[startIndex];
  const peak = readings[anomalyIndex];
  if (!start || !peak) {
    return [{ time: peak?.recorded_at ?? new Date().toISOString(), percent: finalPercent }];
  }

  const midTime = new Date(
    (new Date(start.recorded_at).getTime() + new Date(peak.recorded_at).getTime()) / 2
  ).toISOString();

  const low = Math.max(38, Math.round(finalPercent * 0.45));
  const mid = Math.max(low + 8, Math.round(finalPercent * 0.75));

  return [
    { time: start.recorded_at, percent: low },
    { time: midTime, percent: mid },
    { time: peak.recorded_at, percent: finalPercent },
  ];
}

export function buildBaselineComparison(
  readings: EventReplayReading[],
  anomalyIndex: number
) {
  const { drop, seconds } = dropWindow(readings, anomalyIndex);
  const hours = Math.max(seconds / 3600, seconds / 3600 || 1 / 3600);
  const observedRate = drop / Math.max(hours, 1 / 3600);

  return {
    normalRange: '0.1–0.3 L/hr',
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
      signal: 'Fuel (OBD)',
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
    actions.push('Compare declared liters to OBD refuel curve');
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
