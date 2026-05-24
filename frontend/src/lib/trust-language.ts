import type { FuelAnomaly, ReceiptFlagRow, SiphonEventRow } from '@/lib/api';

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

export function siphonConfidence(event: SiphonEventRow): number {
  const parked = event.evidence.parked_duration_minutes ?? 0;
  const drop = event.liters_stolen;
  let score = 72;
  if (parked >= 10) score += 8;
  if (event.evidence.engine_state_after === false) score += 6;
  if (drop >= 5 && drop <= 40) score += 4;
  return Math.min(94, score);
}

export function receiptMismatchConfidence(flag: ReceiptFlagRow): number {
  const declared = flag.declared_liters;
  const actual = flag.obd_actual_liters;
  if (actual == null) return 55;
  const ratio = actual / Math.max(declared, 0.1);
  if (ratio < 0.3) return 78;
  if (ratio < 0.6) return 68;
  return 58;
}

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
  const lines: string[] = [];
  if (anomaly.details) lines.push(anomaly.details);
  if (anomaly.type === 'idle') lines.push('Extended engine idle detected');
  if (anomaly.type === 'theft' || anomaly.type === 'fraud') {
    lines.push('Pattern flagged for investigation — not a final verdict');
  }
  lines.push('Source: live telemetry');
  return lines.slice(0, 4);
}

export function anomalyConfidence(anomaly: FuelAnomaly): number {
  if (anomaly.severity === 'critical') return 82;
  if (anomaly.severity === 'warning') return 68;
  return 52;
}

export function severityLabel(confidence: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (confidence >= 75) return 'HIGH';
  if (confidence >= 60) return 'MEDIUM';
  return 'LOW';
}

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
