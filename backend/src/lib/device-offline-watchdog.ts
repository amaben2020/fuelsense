// Notices a tracker going silent, on its own, without a manager having the
// dashboard open to catch it.
//
// Before this, `connection_status` was computed fresh on every page load —
// nothing ever noticed the transition, so an outage was only visible to
// someone who happened to look. That is the gap that lets a driver blame a
// theft on "the app was down": if the platform itself never says so, the
// manager has no way to tell a real gap from an excuse.
import { db, sql, alerts, eq, and, customers, notificationPreferences } from './db-helpers';
import { sendMail, mailerReady, alertEmail } from './mailer';

export const DEVICE_OFFLINE_ALERT = 'device_offline';

/** How long a device can go quiet before it is worth telling the manager.
 *  Double the 15-minute window `connection_status` itself uses (see
 *  `getFleetByCustomerId`), so the watchdog never fires before the badge the
 *  manager can already see would agree with it — and it clears the FMC150's
 *  own "online sleep" check-in cadence, so a parked, sleeping tracker does
 *  not read as an outage. */
const OFFLINE_THRESHOLD_MINUTES = Number(process.env.DEVICE_OFFLINE_THRESHOLD_MINUTES || 30);

interface StaleDeviceRow {
  imei: string;
  vehicle_id: string;
  customer_id: string;
  license_plate: string | null;
  last_seen_at: string;
}

/**
 * One alert per outage episode: the `NOT EXISTS` guard means a device stuck
 * offline for days is flagged once, not every five minutes.
 */
async function raiseOfflineAlerts(): Promise<StaleDeviceRow[]> {
  const stale = await db.execute(sql`
    SELECT d.imei, d.vehicle_id, d.customer_id, d.last_seen_at, v.license_plate
    FROM devices d
    JOIN vehicles v ON v.id = d.vehicle_id
    WHERE d.is_active = true
      AND d.vehicle_id IS NOT NULL
      AND d.last_seen_at IS NOT NULL
      AND d.last_seen_at < NOW() - (${OFFLINE_THRESHOLD_MINUTES} || ' minutes')::INTERVAL
      AND NOT EXISTS (
        SELECT 1 FROM alerts a
        WHERE a.vehicle_id = d.vehicle_id
          AND a.alert_type = ${DEVICE_OFFLINE_ALERT}
          AND a.is_resolved = false
      )
    LIMIT 100
  `);

  const rows = stale.rows as unknown as StaleDeviceRow[];

  for (const row of rows) {
    const lastSeen = new Date(row.last_seen_at);
    const plate = row.license_plate ?? 'A vehicle';
    try {
      await db.insert(alerts).values({
        imei: row.imei,
        customerId: row.customer_id,
        vehicleId: row.vehicle_id,
        alertType: DEVICE_OFFLINE_ALERT,
        message: `${plate}'s tracker has not reported since ${lastSeen.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} — no data is being collected right now.`,
      });
    } catch (err) {
      console.error('[device_offline_watchdog] alert insert failed:', err);
      continue;
    }

    await emailOffline(row, plate, lastSeen).catch((err) =>
      console.error('[device_offline_watchdog] email failed:', err)
    );
  }

  return rows;
}

async function emailOffline(row: StaleDeviceRow, plate: string, lastSeen: Date): Promise<void> {
  if (!mailerReady()) return;

  const [pref] = await db
    .select({
      enabled: notificationPreferences.emailEnabled,
      address: notificationPreferences.emailAddress,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.customerId, row.customer_id),
        eq(notificationPreferences.alertType, DEVICE_OFFLINE_ALERT)
      )
    )
    .limit(1);

  // No row means not opted in — notifications are never on by default.
  if (!pref?.enabled) return;

  const [account] = await db
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, row.customer_id))
    .limit(1);

  const to = pref.address || account?.email;
  if (!to) return;

  const { text, html } = alertEmail({
    title: `${plate} — tracker has gone quiet`,
    imageUrl: null,
    imageCaption: null,
    lines: [
      ['Vehicle', plate],
      ['Last reported', lastSeen.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })],
      ['Status', 'No telemetry since — nothing is being watched on this vehicle right now'],
    ],
    linkUrl: null,
    linkLabel: null,
    footer: 'FuelSense · turn these off in Settings → Notifications',
  });

  await sendMail({
    to,
    subject: `${plate}: tracker offline since ${lastSeen.toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos' })}`,
    text,
    html,
  });
}

/** Clears the open alert the moment telemetry resumes. No follow-up email —
 *  the alert simply leaving the active list (`GET /alerts` filters on
 *  `is_resolved = false`) is the signal that it is over. */
async function resolveRecoveredAlerts(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE alerts a
    SET is_resolved = true, resolved_at = NOW()
    FROM devices d
    WHERE a.vehicle_id = d.vehicle_id
      AND a.alert_type = ${DEVICE_OFFLINE_ALERT}
      AND a.is_resolved = false
      AND d.last_seen_at IS NOT NULL
      AND d.last_seen_at > NOW() - (${OFFLINE_THRESHOLD_MINUTES} || ' minutes')::INTERVAL
    RETURNING a.id
  `);
  return result.rows.length;
}

export async function sweepDeviceOffline(): Promise<{ raised: number; resolved: number }> {
  const raisedRows = await raiseOfflineAlerts();
  const resolved = await resolveRecoveredAlerts();
  return { raised: raisedRows.length, resolved };
}

let timer: NodeJS.Timeout | null = null;

/** Runs on an interval for as long as the process is up. Failures are logged,
 *  never thrown — a background pass must not take the server down. */
export function startDeviceOfflineWatchdog(intervalMs = 5 * 60 * 1000): void {
  if (timer) return;

  const run = async () => {
    try {
      const { raised, resolved } = await sweepDeviceOffline();
      if (raised || resolved) {
        console.log(`[device_offline_watchdog] ${raised} alert(s) raised, ${resolved} resolved`);
      }
    } catch (error) {
      console.error('[device_offline_watchdog] failed:', (error as Error).message);
    }
  };

  timer = setInterval(run, intervalMs);
  // Don't hold the event loop open on shutdown.
  timer.unref?.();
  void run();
}
