// Periodic pass over receipts and forecourt stops.
//
// Two things cannot be settled at the moment a receipt is submitted:
//
//   1. A receipt logged from a phone with no signal, or before the tracker
//      reported its position, has no evidence to judge yet. It must be looked
//      at again once the telemetry lands, or it stays pending forever — which
//      is exactly what used to happen.
//
//   2. A fuel stop only becomes suspicious once enough time has passed for the
//      driver to have logged a receipt and not done so.
import { db, sql, alerts, vehicles, eq } from './db-helpers';
import { verifyReceipt } from './receipt-verification';
import { latestReceiptPrice } from './fuel-price';
import { DEFAULT_FUEL_PRICE_NGN_LITER } from './fuel-metrics';
import { lookupPlace } from './place-lookup';

/** How far back to keep retrying. Older than this and the telemetry that would
 *  have settled it is never arriving. */
const REVERIFY_WINDOW_DAYS = Number(process.env.RECEIPT_REVERIFY_DAYS || 14);

/** Grace period before an unlogged fill is worth telling the manager about. */
const UNLOGGED_FILL_GRACE_HOURS = Number(process.env.UNLOGGED_FILL_GRACE_HOURS || 3);

export async function reverifyPendingReceipts(): Promise<number> {
  const pending = await db.execute(sql`
    SELECT
      r.id,
      r.vehicle_id,
      r.customer_id,
      r.transaction_date,
      r.declared_liters,
      r.price_per_liter,
      r.receipt_latitude,
      r.receipt_longitude,
      r.merchant_name,
      v.tank_capacity_liters,
      v.license_plate
    FROM fuel_receipts r
    JOIN vehicles v ON v.id = r.vehicle_id
    WHERE r.reconciliation_status = 'pending'
      AND r.transaction_date > NOW() - (${REVERIFY_WINDOW_DAYS} || ' days')::INTERVAL
    ORDER BY r.transaction_date DESC
    LIMIT 200
  `);

  let settled = 0;

  for (const row of pending.rows as Array<Record<string, unknown>>) {
    const verification = await verifyReceipt({
      receiptId: String(row.id),
      vehicleId: String(row.vehicle_id),
      customerId: String(row.customer_id),
      transactionDate: new Date(row.transaction_date as string),
      declaredLiters: Number(row.declared_liters),
      pricePerLiter: row.price_per_liter != null ? Number(row.price_per_liter) : null,
      receiptLatitude: row.receipt_latitude as string | null,
      receiptLongitude: row.receipt_longitude as string | null,
      tankCapacityLiters:
        row.tank_capacity_liters != null ? Number(row.tank_capacity_liters) : null,
    });

    // Still nothing to go on — leave the row untouched so `reconciled_at`
    // keeps meaning "a verdict was reached".
    if (verification.status === 'pending') continue;

    await db.execute(sql`
      UPDATE fuel_receipts
      SET reconciliation_status = ${verification.status},
          verification = ${JSON.stringify(verification)}::jsonb,
          difference_liters = ${verification.overclaimedLiters},
          reconciled_at = NOW()
      WHERE id = ${row.id}
    `);

    await db.execute(sql`
      UPDATE fuel_purchases
      SET status = ${verification.status === 'flagged_theft' ? 'flagged_theft' : 'verified'}
      WHERE receipt_reference = ${'DRV-' + String(row.id).slice(0, 8).toUpperCase()}
    `);

    if (verification.status === 'flagged_theft') {
      await db.insert(alerts).values({
        customerId: String(row.customer_id),
        vehicleId: String(row.vehicle_id),
        alertType: 'receipt_fraud',
        message: `Receipt problem on ${row.license_plate}: ${Number(row.declared_liters)}L claimed at ${row.merchant_name}. ${verification.summary} Est. exposure ₦${verification.estimatedLossNgn.toLocaleString('en-NG')}.`,
        fuelDropLiters: (verification.overclaimedLiters ?? Number(row.declared_liters)).toFixed(2),
        estimatedLossNgn: verification.estimatedLossNgn,
        latitude: (row.receipt_latitude as string) ?? null,
        longitude: (row.receipt_longitude as string) ?? null,
      });
    }

    settled += 1;
  }

  return settled;
}

/**
 * Fuel stops with no receipt against them.
 *
 * This is the other half of the fraud picture: a driver who fills the tank on
 * the company card and never logs it leaves no receipt to compare — but the
 * forecourt stop is still in the telemetry.
 */
export async function alertUnloggedFills(): Promise<number> {
  const stops = await db.execute(sql`
    SELECT e.id, e.customer_id, e.vehicle_id, e.occurred_at, e.value, e.latitude, e.longitude
    FROM device_events e
    WHERE e.event_type = 'fuel_stop'
      AND e.occurred_at < NOW() - (${UNLOGGED_FILL_GRACE_HOURS} || ' hours')::INTERVAL
      AND e.occurred_at > NOW() - INTERVAL '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM fuel_receipts r
        WHERE r.vehicle_id = e.vehicle_id
          AND r.transaction_date BETWEEN e.occurred_at - INTERVAL '2 hours'
            AND e.occurred_at + INTERVAL '2 hours'
      )
      AND NOT EXISTS (
        SELECT 1 FROM alerts a
        WHERE a.vehicle_id = e.vehicle_id
          AND a.alert_type = 'unlogged_fill'
          AND a.created_at BETWEEN e.occurred_at AND e.occurred_at + INTERVAL '12 hours'
      )
    ORDER BY e.occurred_at DESC
    LIMIT 50
  `);

  let raised = 0;

  for (const row of stops.rows as Array<Record<string, unknown>>) {
    const [vehicle] = await db
      .select({ licensePlate: vehicles.licensePlate })
      .from(vehicles)
      .where(eq(vehicles.id, String(row.vehicle_id)));

    const price = await latestReceiptPrice(String(row.customer_id)).catch(() => null);
    const at = new Date(row.occurred_at as string);

    // A stop nearby proves proximity to a forecourt, not that the driver was
    // at the pump — the vehicle could have parked next door. "Stopped at a
    // filling station" claimed the second thing on the evidence for the
    // first, so the wording only says what is actually measured (a stop of
    // this length, this near a station) and states the fuel-bought part as
    // the open question it is.
    const address =
      row.latitude != null && row.longitude != null
        ? await lookupPlace(Number(row.latitude), Number(row.longitude))
            .then((place) => place.formatted_address || place.place_name)
            .catch(() => null)
        : null;

    await db.insert(alerts).values({
      customerId: String(row.customer_id),
      vehicleId: String(row.vehicle_id),
      alertType: 'unlogged_fill',
      message: `${vehicle?.licensePlate ?? 'Vehicle'} parked near a filling station for ${Number(row.value ?? 0)} min on ${at.toISOString().slice(0, 10)} at ${at.toISOString().slice(11, 16)}${address ? ` (${address})` : ''} and no receipt was logged. If fuel was bought here, it's unaccounted for at about ₦${Math.round(price?.ngnPerLiter ?? DEFAULT_FUEL_PRICE_NGN_LITER).toLocaleString('en-NG')}/L.`,
      latitude: (row.latitude as string) ?? null,
      longitude: (row.longitude as string) ?? null,
    });

    raised += 1;
  }

  return raised;
}

/**
 * Fill in station imagery on receipts that were settled before it existed, or
 * where Google had nothing to show at the time.
 *
 * Kept separate from re-verification because it must never change a verdict —
 * it only patches the `station` branch of the stored evidence. Google calls
 * are cached per ~11 m cell and capped, so a fleet that fuels at the same
 * handful of stations costs almost nothing here.
 */
export async function refreshStationEvidence(): Promise<number> {
  const rows = await db.execute(sql`
    SELECT r.id, r.vehicle_id, r.customer_id, r.transaction_date, r.declared_liters,
           r.receipt_latitude, r.receipt_longitude
    FROM fuel_receipts r
    WHERE r.transaction_date > NOW() - (${REVERIFY_WINDOW_DAYS} || ' days')::INTERVAL
      AND r.verification IS NOT NULL
      AND r.verification -> 'station' ->> 'photoUrl' IS NULL
    ORDER BY r.transaction_date DESC
    LIMIT 25
  `);

  let patched = 0;

  for (const row of rows.rows as Array<Record<string, unknown>>) {
    const fresh = await verifyReceipt({
      receiptId: String(row.id),
      vehicleId: String(row.vehicle_id),
      customerId: String(row.customer_id),
      transactionDate: new Date(row.transaction_date as string),
      declaredLiters: Number(row.declared_liters),
      receiptLatitude: row.receipt_latitude as string | null,
      receiptLongitude: row.receipt_longitude as string | null,
    });

    if (!fresh.station?.photoUrl) continue;

    await db.execute(sql`
      UPDATE fuel_receipts
      SET verification = jsonb_set(verification, '{station}', ${JSON.stringify(fresh.station)}::jsonb)
      WHERE id = ${row.id}
    `);

    patched += 1;
  }

  return patched;
}

/**
 * Clears unlogged-fill alerts whose receipt turned up late.
 *
 * `alertUnloggedFills` only asks "is there a receipt?" at the instant it
 * raises the alert. A driver who uploads the next morning — the common case,
 * since the grace period is three hours and people fuel at the end of a shift
 * — therefore left the accusation standing forever. The manager saw a demand
 * for a receipt that was already filed, which is precisely the kind of stale
 * alert that teaches people to ignore the whole feed.
 *
 * Matched on the same ±2h window the alert was raised against, so a receipt
 * only ever clears the stop it actually belongs to. Resolved rather than
 * deleted: the alert did describe something real at the time it fired, and the
 * record of it having been answered is worth keeping.
 */
export async function resolveAnsweredUnloggedFills(): Promise<number> {
  const result = await db.execute(sql`
    WITH bound AS (
      -- Exactly one stop per alert: the latest forecourt stop at or before it.
      --
      -- A plain join on "within 12 hours" is not enough. A vehicle that calls
      -- at two stations in an afternoon puts both inside the window, and the
      -- alert then matches whichever the planner reaches first — so a receipt
      -- for the midday stop could clear an alert raised about the evening one,
      -- silently dismissing the very thing the manager needed to see.
      --
      -- The binding is done here rather than in an UPDATE ... FROM LATERAL,
      -- which Postgres rejects: the update target cannot be referenced from
      -- its own FROM clause.
      SELECT a.id AS alert_id, stop.occurred_at, stop.vehicle_id
      FROM alerts a
      JOIN LATERAL (
        SELECT e.occurred_at, e.vehicle_id
        FROM device_events e
        WHERE e.event_type = 'fuel_stop'
          AND e.vehicle_id = a.vehicle_id
          AND e.occurred_at <= a.created_at
          AND e.occurred_at > a.created_at - INTERVAL '12 hours'
        ORDER BY e.occurred_at DESC
        LIMIT 1
      ) stop ON true
      WHERE a.alert_type = 'unlogged_fill'
        AND a.is_resolved = false
    ),
    answered AS (
      SELECT b.alert_id
      FROM bound b
      WHERE EXISTS (
        SELECT 1 FROM fuel_receipts r
        WHERE r.vehicle_id = b.vehicle_id
          AND r.transaction_date BETWEEN b.occurred_at - INTERVAL '2 hours'
                                     AND b.occurred_at + INTERVAL '2 hours'
      )
    )
    UPDATE alerts
    SET is_resolved = true, resolved_at = NOW()
    WHERE id IN (SELECT alert_id FROM answered)
    RETURNING id
  `);
  return result.rows.length;
}

let timer: NodeJS.Timeout | null = null;

/** Runs both passes on an interval. Failures are logged, never thrown — this
 *  is a background pass and must not take the process down. */
export function startReceiptSweep(intervalMs = 15 * 60 * 1000): void {
  if (timer) return;

  const run = async () => {
    try {
      const settled = await reverifyPendingReceipts();
      // Clear answered alerts before raising new ones, so a receipt that
      // arrived since the last pass is honoured on this one.
      const cleared = await resolveAnsweredUnloggedFills();
      const raised = await alertUnloggedFills();
      const patched = await refreshStationEvidence();
      if (settled || cleared || raised || patched) {
        console.log(
          `[receipt_sweep] ${settled} receipt(s) settled, ${cleared} unlogged fill(s) cleared by a late receipt, ${raised} unlogged fill(s) flagged, ${patched} station image(s) added`
        );
      }
    } catch (error) {
      console.error('[receipt_sweep] failed:', (error as Error).message);
    }
  };

  timer = setInterval(run, intervalMs);
  // Don't hold the event loop open on shutdown.
  timer.unref?.();
  void run();
}
