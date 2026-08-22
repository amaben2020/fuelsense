/**
 * What each kind of alert means, in one place.
 *
 * Three separate features were each carrying their own idea of which alerts
 * matter — the alerts feed, the alerts workbench, and the fleet health score —
 * and they disagreed. The health score in particular counted *every*
 * unresolved alert equally, so a driver correctly filing a receipt cost the
 * fleet the same two points as driving off its route. On the demo fleet that
 * put 12 of 27 open alerts into a score they had no business being in, and
 * reported a healthy single-vehicle fleet as "critical".
 */

/** How seriously an alert should be taken. */
export type AlertClass =
  /** Someone has to look at this and decide. Never expires on its own. */
  | 'critical'
  /** Worth attention, but stale after a while. */
  | 'warning'
  /** A notification that something happened. Not a problem. */
  | 'informational'
  /** Reachability, not fleet health. Has its own tile, and self-resolves. */
  | 'connectivity';

const CLASSIFICATION: Record<string, AlertClass> = {
  // Money or trust is at stake; a human decides when these are closed.
  fuel_theft: 'critical',
  receipt_fraud: 'critical',
  unlogged_fill: 'critical',
  fuel_discrepancy: 'critical',

  // Driving and fuel behaviour. Real signal, but it ages out of relevance.
  excessive_idle: 'warning',
  idle_fuel_waste: 'warning',
  route_deviation: 'warning',
  overspeeding: 'warning',
  low_fuel: 'warning',
  harsh_driving: 'warning',

  // Things that happened. Nothing to action, nothing to fix.
  receipt_uploaded: 'informational',
  trip_start: 'informational',
  geofence_entry: 'informational',
  geofence_exit: 'informational',
  immobilizer_engaged: 'informational',
  immobilizer_released: 'informational',

  // The device-offline watchdog raises and clears these itself as the tracker
  // comes and goes, so they must not be swept or scored here.
  device_offline: 'connectivity',
};

/** Unknown types are treated as warnings: visible, but not score-wrecking. */
export function classifyAlert(alertType: string): AlertClass {
  return CLASSIFICATION[alertType] ?? 'warning';
}

/**
 * Whether an alert says something about how the fleet is being driven and
 * fuelled — the only question the health score is trying to answer.
 */
export function countsTowardHealth(alertType: string): boolean {
  const c = classifyAlert(alertType);
  return c === 'critical' || c === 'warning';
}

/**
 * How long an unresolved alert stays open before the retention sweep closes
 * it, in days. `null` means never — it waits for a person.
 *
 * Informational alerts describe a moment, so a day is generous. Warnings get a
 * fortnight: long enough to review a week's driving, short enough that they
 * stop accumulating into a permanently red dashboard. Nothing that involves
 * possible loss expires at all.
 */
export function autoResolveAfterDays(alertType: string): number | null {
  switch (classifyAlert(alertType)) {
    case 'informational':
      return 1;
    case 'warning':
      return 14;
    // Critical waits for a human; connectivity is owned by the watchdog.
    case 'critical':
    case 'connectivity':
    default:
      return null;
  }
}

/** Types the retention sweep may close, grouped by their window. */
export function sweepableTypesByWindow(): Array<{ days: number; types: string[] }> {
  const buckets = new Map<number, string[]>();
  for (const type of Object.keys(CLASSIFICATION)) {
    const days = autoResolveAfterDays(type);
    if (days == null) continue;
    const list = buckets.get(days) ?? [];
    list.push(type);
    buckets.set(days, list);
  }
  return [...buckets.entries()].map(([days, types]) => ({ days, types }));
}
