import { formatNgn, type FuelAnomaly, type LossReason, type ReceiptFlagRow, type SiphonEventRow } from '@/lib/api';

/**
 * A loss figure with no cause behind it reads as an accusation. Every place
 * that shows extra fuel spend states what the tracker can account for and what
 * it cannot, and never implies a cause it did not measure.
 */
export function lossReasonLines(reason: LossReason | undefined | null): string[] {
  if (!reason || reason.excess_liters <= 0) return [];
  const lines: string[] = [];

  if (reason.idle_liters > 0) {
    lines.push(
      `${formatHours(reason.idle_hours)} with the engine running while parked burned about ${reason.idle_liters.toFixed(1)} L (${formatNgn(reason.idle_cost_ngn)})`
    );
  }
  if (reason.unexplained_liters > 0) {
    lines.push(
      `${reason.unexplained_liters.toFixed(1)} L (${formatNgn(reason.unexplained_cost_ngn)}) above the configured rate — stop-start driving is charged up to 1.3x and the benchmark does not model it`
    );
  }
  if (reason.harsh_event_count > 0) {
    lines.push(
      `${reason.harsh_event_count} harsh acceleration, braking or speeding events — these burn more than the baseline allows for`
    );
  }
  return lines;
}

/**
 * One-line summary for row-level use where a list would be too heavy.
 *
 * Deliberately no longer says "unaccounted for". Nothing here is measured
 * fuel going missing: the tank is modelled from distance and idle time (the
 * FMC150's AVL 12 element is unconfigured on this fleet and reads about 1.3 L
 * against 117 km, so it is not used), and the benchmark it is compared with is
 * the same model without the speed-bucket multiplier. The residue is therefore
 * the cost of stop-start driving, not a litre that left the tank — and
 * "unaccounted for" invited a manager to read theft into arithmetic.
 */
export function lossReasonSummary(reason: LossReason | undefined | null): string | null {
  if (!reason || reason.excess_liters <= 0) return null;
  if (reason.unexplained_liters <= 0 && reason.idle_liters > 0) {
    return `Fully explained by ${formatHours(reason.idle_hours)} of idling`;
  }
  if (reason.idle_liters <= 0) {
    return `${reason.unexplained_liters.toFixed(1)} L above the configured rate (estimate)`;
  }
  return `${reason.idle_liters.toFixed(1)} L from idling, ${reason.unexplained_liters.toFixed(1)} L above the configured rate`;
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  const whole = Math.floor(hours);
  const mins = Math.round((hours - whole) * 60);
  return mins > 0 ? `${whole}h ${mins}m` : `${whole}h`;
}

export function formatMillionsNgn(amount: number) {
  if (amount >= 1_000_000) {
    return `₦${(amount / 1_000_000).toFixed(1)}M`;
  }
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(amount);
}

/*
 * `siphonConfidence`, `receiptMismatchConfidence` and `anomalyConfidence` were
 * removed from this file.
 *
 * All three returned a number from a fixed table — anomalyConfidence was
 * literally `critical → 82, warning → 68, info → 52` — and the badge then ran
 * that number back through `severityLabel()` to recover the severity it had
 * just come from. "MEDIUM · 68%" was therefore one fact printed twice, the
 * second copy wearing the clothes of a measurement. Every warning-severity
 * alert on the Operations page read 68%, which is what gave the game away.
 *
 * A percentage promises that something was weighed. Where that is true — the
 * evidence score in event-replay, which adds points only alongside the reason
 * it is adding them for — the number stays. Here nothing was weighed, so the
 * severity is now carried on its own.
 */

export function siphonContextLines(event: SiphonEventRow): string[] {
  const lines: string[] = [];
  const parked = event.evidence.parked_duration_minutes;
  if (parked != null && parked > 0) {
    lines.push(`Vehicle stationary ~${parked} min`);
  } else {
    lines.push('Vehicle stationary during drop');
  }
  lines.push(`Rapid fuel drop (−${event.liters_stolen.toFixed(1)}L)`);
  if (event.evidence.engine_state_after === false) {
    lines.push('Ignition off after event');
  }
  lines.push('No verified refuel at this time');
  lines.push('Source: OBD sensor + idle correlation');
  return lines;
}

export function receiptMismatchContextLines(flag: ReceiptFlagRow): string[] {
  const lines: string[] = ['Receipt logged at fuel station'];
  if (flag.obd_actual_liters != null) {
    lines.push(
      `OBD refuel signal: ${flag.obd_actual_liters}L (declared ${flag.declared_liters}L)`
    );
  } else {
    lines.push('OBD refuel match pending within ±2h');
  }
  if (flag.difference_liters != null && flag.difference_liters > 5) {
    lines.push('Large gap — requires manager review');
  }
  lines.push('Source: receipt upload + FMC150 OBD');
  return lines;
}

export function anomalyContextLines(anomaly: FuelAnomaly): string[] {
  // `anomaly.details` is deliberately absent: the card renders it as the
  // description immediately above these bullets, and repeating it verbatim
  // was the single loudest piece of noise on the Operations page.
  const lines: string[] = [];
  if (anomaly.type === 'idle') lines.push('Extended engine idle detected');
  return lines;
}

/**
 * The backend's own severity, in the words the UI uses.
 *
 * Direct, rather than via a confidence number: severity is what was actually
 * classified, and routing it through a percentage only invited the percentage
 * to be displayed as though it meant something separate.
 */
export function severityRank(
  severity: 'critical' | 'warning' | 'info' | string
): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (severity === 'critical') return 'HIGH';
  if (severity === 'warning') return 'MEDIUM';
  return 'LOW';
}

/** Still used where a genuine, evidence-weighted score exists. */
export function severityLabel(confidence: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (confidence >= 75) return 'HIGH';
  if (confidence >= 60) return 'MEDIUM';
  return 'LOW';
}

/**
 * What a geofence's `purpose` describes — the place, never the person.
 *
 * Rendering the raw value capitalised made a zone named after its driver read
 * "Benneth · Customer", which states that Benneth is a customer. Kept here so
 * the map tooltip and the zones list cannot drift apart on the wording.
 */
export const ZONE_PURPOSE_LABEL: Record<string, string> = {
  depot: 'Depot',
  customer: 'Customer site',
  restricted: 'Restricted area',
};

export const TRUST_COPY = {
  siphonTitle: 'Possible fuel anomaly',
  receiptMismatchTitle: 'Receipt vs OBD mismatch — review needed',
  alertFuelTitle: 'Suspicious fuel loss pattern',
  alertReceiptTitle: 'Receipt discrepancy — review needed',
  efficiencyFlagTitle: 'Efficiency below baseline',
  investigateCta: 'Investigate event',
  viewEvidenceCta: 'View evidence replay',
  requiresReview: 'Requires review',
  notVerdict: 'Investigation assist — not a final accusation',
} as const;
