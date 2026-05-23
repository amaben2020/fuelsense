const { fuelPurchases } = require('../db/schema');
const { sql } = require('drizzle-orm');

function receiptReferenceFor(receiptId) {
  return `DRV-${String(receiptId).slice(0, 8).toUpperCase()}`;
}

function purchaseStatusFromReceipt(reconciliationStatus) {
  if (reconciliationStatus === 'flagged_theft') return 'flagged_theft';
  if (reconciliationStatus === 'matched') return 'verified';
  return 'pending_receipt';
}

function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildPurchaseValuesFromReceipt(receipt) {
  const price = Number(receipt.price_per_liter || receipt.pricePerLiter) || 650;
  const declared = Number(receipt.declared_liters || receipt.declaredLiters);
  const reconciliationStatus =
    receipt.reconciliation_status || receipt.reconciliationStatus || 'pending';

  return {
    customerId: receipt.customer_id || receipt.customerId,
    vehicleId: receipt.vehicle_id || receipt.vehicleId,
    purchasedAt: toDate(receipt.transaction_date || receipt.transactionDate) ?? new Date(),
    merchant: receipt.merchant_name || receipt.merchantName,
    receiptReference: receiptReferenceFor(receipt.id),
    litersDeclared: declared.toFixed(2),
    litersActual:
      receipt.obd_liters_actual != null || receipt.obdLitersActual != null
        ? Number(receipt.obd_liters_actual ?? receipt.obdLitersActual).toFixed(2)
        : null,
    obdRefuelDetectedAt: toDate(receipt.obd_refuel_detected_at ?? receipt.obdRefuelDetectedAt),
    ignitionOnAt: toDate(receipt.ignition_on_at ?? receipt.ignitionOnAt),
    costPerLiterNgn: Math.round(price),
    odometerKm: receipt.odometer_km ?? receipt.odometerKm ?? null,
    status: purchaseStatusFromReceipt(reconciliationStatus),
    source: 'driver_upload',
  };
}

async function backfillDriverReceiptPurchases(db) {
  const orphaned = await db.execute(sql`
    SELECT
      r.id,
      r.customer_id,
      r.vehicle_id,
      r.merchant_name,
      r.transaction_date,
      r.declared_liters,
      r.price_per_liter,
      r.obd_liters_actual,
      r.obd_refuel_detected_at,
      r.ignition_on_at,
      r.odometer_km,
      r.reconciliation_status
    FROM fuel_receipts r
    WHERE NOT EXISTS (
      SELECT 1
      FROM fuel_purchases fp
      WHERE fp.receipt_reference = 'DRV-' || upper(substr(r.id::text, 1, 8))
    )
    ORDER BY r.uploaded_at ASC
  `);

  let synced = 0;
  for (const row of orphaned.rows) {
    await db.insert(fuelPurchases).values(buildPurchaseValuesFromReceipt(row));
    synced += 1;
  }

  if (synced > 0) {
    console.log(`[driver-receipt-sync] Backfilled ${synced} driver receipt(s) into fuel_purchases`);
  }

  return synced;
}

module.exports = {
  receiptReferenceFor,
  purchaseStatusFromReceipt,
  buildPurchaseValuesFromReceipt,
  backfillDriverReceiptPurchases,
};
