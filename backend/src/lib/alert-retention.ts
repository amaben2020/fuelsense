import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { alerts } from '../db/schema';
import { sweepableTypesByWindow } from './alert-taxonomy';

/**
 * Closes alerts that have stopped being actionable.
 *
 * Nothing but the device-offline watchdog ever resolved an alert, so open
 * alerts only ever accumulated: the demo fleet was carrying notices from
 * twelve days earlier, and because the health score subtracts points per open
 * alert, the score drifted toward "critical" with the passage of time rather
 * than with the condition of the fleet. A one-vehicle fleet would eventually
 * reach zero however well it was driven.
 *
 * Windows come from alert-taxonomy: informational after a day, warnings after
 * a fortnight, and anything involving possible loss never — those wait for a
 * person to decide. Resolving is not deleting; the rows stay, and history and
 * the alerts feed are unaffected.
 */
export async function sweepAlertRetention(): Promise<number> {
  let resolved = 0;

  for (const { days, types } of sweepableTypesByWindow()) {
    const result = await db
      .update(alerts)
      .set({ isResolved: true, resolvedAt: new Date() })
      .where(
        and(
          eq(alerts.isResolved, false),
          inArray(alerts.alertType, types),
          lt(alerts.createdAt, sql`NOW() - (${days} || ' days')::INTERVAL`)
        )
      )
      .returning({ id: alerts.id });

    resolved += result.length;
  }

  return resolved;
}

let timer: NodeJS.Timeout | null = null;

/** Hourly is ample for windows measured in days, and keeps the query cheap. */
export function startAlertRetentionSweep(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;

  const run = async () => {
    try {
      const resolved = await sweepAlertRetention();
      if (resolved) {
        console.log(`[alert_retention] ${resolved} stale alert(s) auto-resolved`);
      }
    } catch (error) {
      console.error('[alert_retention] failed:', (error as Error).message);
    }
  };

  timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
}
