// Notices a tracker going silent, on its own, without a manager having the
// dashboard open to catch it.
//
// Before this, `connection_status` was computed fresh on every page load —
// nothing ever noticed the transition, so an outage was only visible to
// someone who happened to look. That is the gap that lets a driver blame a
// theft on "the app was down": if the platform itself never says so, the
// manager has no way to tell a real gap from an excuse.
import type { SQL } from 'drizzle-orm';
import { db, sql, alerts, eq, and, customers, notificationPreferences } from './db-helpers';
import { sendMail, mailerReady, alertEmail } from './mailer';

export const DEVICE_OFFLINE_ALERT = 'device_offline';

/**
 * How long a device can go quiet before it is worth telling the manager, for
 * accounts that have not chosen their own.
 *
 * This was 30 minutes, on the stated grounds that it "clears the FMC150's own
 * online-sleep check-in cadence, so a parked, sleeping tracker does not read
 * as an outage". Measured against the live device that is simply untrue: a
 * parked FMC150 here checks in every 60.0 minutes, twice the threshold. The
 * result was a metronome — raised at :59, resolved at :29 when the hourly
 * ping landed, raised again an hour later, 112 alerts and counting for a van
 * that was sitting still and reporting perfectly well.
 *
 * A threshold below the device's own parked cadence cannot do anything except
 * oscillate, so the default now clears 60 minutes with margin. Managers who
 * want to hear sooner can still choose 15 or 30 in Settings → Notifications,
 * which is the right place for that trade-off to be made deliberately.
 */
export const DEFAULT_OFFLINE_MINUTES = Number(
  process.env.DEVICE_OFFLINE_THRESHOLD_MINUTES || 120
);

/**
 * Minimum spacing between two "this tracker is quiet" alerts for one vehicle.
 *
 * The `NOT EXISTS` guard below only ever stopped a *second simultaneous* alert:
 * once the device pinged and the alert auto-resolved, the next quiet spell
 * raised a fresh one. For a tracker that wakes hourly that meant an alert every
 * hour, all night. A vehicle whose tracker is off is worth saying once a day,
 * not once an hour — nothing about the situation changes in between.
 */
export const REALERT_AFTER_HOURS = Number(process.env.DEVICE_OFFLINE_REALERT_HOURS || 24);

/** The choices a manager gets. Anything outside this is rejected rather than
 *  silently clamped, so the number in Settings is always the number that runs.
 *  The floor is 15 because `connection_status` itself uses a 15-minute window;
 *  below that the watchdog would fire while the dashboard still says online. */
export const OFFLINE_THRESHOLD_CHOICES = [15, 30, 60, 120, 240, 480] as const;

/** Deep link to the screen that turns these emails off. Null when the
 *  deployment has no configured address, in which case the footer still names
 *  the screen — it just cannot be clicked. */
function settingsUrl(): string | null {
  const base = process.env.APP_URL?.replace(/\/+$/, '');
  return base ? `${base}/dashboard#settings` : null;
}

/**
 * Per-customer quiet period, falling back to the platform default.
 *
 * Inlined into both queries so a fleet that wants to hear about a 15-minute
 * gap and one that only cares after eight hours can share the same sweep.
 */
const thresholdExpr = sql`
  COALESCE(
    (
      SELECT np.threshold_minutes
      FROM notification_preferences np
      WHERE np.customer_id = d.customer_id
        AND np.alert_type = ${DEVICE_OFFLINE_ALERT}
    ),
    ${DEFAULT_OFFLINE_MINUTES}
  )
`;

/**
 * Whether this vehicle has already been spoken for.
 *
 * Two conditions, and the second is the one that matters: an alert still open,
 * or any alert raised inside the re-alert window even if it has since closed.
 * The original guard tested only the first, so the moment a device pinged and
 * the alert auto-resolved the slot was free again — which for an hourly
 * check-in cadence produced an alert every hour, indefinitely.
 *
 * Exported so the rule can be asserted directly rather than inferred from
 * whichever query happens to embed it.
 */
export const alreadyAlertedGuard: SQL = sql`
  EXISTS (
    SELECT 1 FROM alerts a
    WHERE a.vehicle_id = d.vehicle_id
      AND a.alert_type = ${DEVICE_OFFLINE_ALERT}
      AND (
        a.is_resolved = false
        OR a.created_at > NOW() - (${REALERT_AFTER_HOURS} || ' hours')::INTERVAL
      )
  )
`;

interface StaleDeviceRow {
  imei: string;
  vehicle_id: string;
  customer_id: string;
  license_plate: string | null;
  last_seen_at: string;
}

/**
 * One alert per outage episode, and at most one a day per vehicle. A tracker
 * that is genuinely off is worth saying once — nothing about the situation
 * changes between one hour and the next.
 */
async function raiseOfflineAlerts(): Promise<StaleDeviceRow[]> {
  const stale = await db.execute(sql`
    SELECT d.imei, d.vehicle_id, d.customer_id, d.last_seen_at, v.license_plate
    FROM devices d
    JOIN vehicles v ON v.id = d.vehicle_id
    WHERE d.is_active = true
      AND d.vehicle_id IS NOT NULL
      AND d.last_seen_at IS NOT NULL
      AND d.last_seen_at < NOW() - ((${thresholdExpr}) || ' minutes')::INTERVAL
      AND NOT ${alreadyAlertedGuard}
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
    // The footer used to name a place that did not exist — Settings had no
    // Notifications section at all, so the one instruction the email gave a
    // manager was a dead end. It now points at the real screen, and carries a
    // link whenever the deployment knows its own address.
    linkUrl: settingsUrl(),
    linkLabel: settingsUrl() ? 'Change or turn off these emails' : null,
    footer: 'FuelSense · Settings → Notifications turns these off or changes the wait',
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
      AND d.last_seen_at > NOW() - ((${thresholdExpr}) || ' minutes')::INTERVAL
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
