import { fuelPurchases } from '../db/schema';
import { sql } from 'drizzle-orm';
import type { db as DbType } from '../db';

export function receiptReferenceFor(receiptId: string): string {
  return `DRV-${String(receiptId).slice(0, 8).toUpperCase()}`;
}

export function purchaseStatusFromReceipt(reconciliationStatus: string): string {
  if (reconciliationStatus === 'flagged_theft') return 'flagged_theft';
  if (reconciliationStatus === 'matched') return 'verified';
  return 'pending_receipt';
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface ReceiptRow {
  id: string;
  customer_id?: string;
  customerId?: string;
  vehicle_id?: string;
  vehicleId?: string;
  merchant_name?: string | null;
  merchantName?: string | null;
  transaction_date?: Date | string | null;
  transactionDate?: Date | string | null;
  declared_liters?: number | string;
  declaredLiters?: number | string;
  price_per_liter?: number | string | null;
  pricePerLiter?: number | string | null;
  obd_liters_actual?: number | string | null;
  obdLitersActual?: number | string | null;
  obd_refuel_detected_at?: Date | string | null;
  obdRefuelDetectedAt?: Date | string | null;
  ignition_on_at?: Date | string | null;
  ignitionOnAt?: Date | string | null;
  odometer_km?: number | null;
  odometerKm?: number | null;
  reconciliation_status?: string;
  reconciliationStatus?: string;
}

export function buildPurchaseValuesFromReceipt(receipt: ReceiptRow): {
  customerId: string;
  vehicleId: string;
  purchasedAt: Date;
  merchant: string | null | undefined;
  receiptReference: string;
  litersDeclared: string;
  litersActual: string | null;
  obdRefuelDetectedAt: Date | null;
  ignitionOnAt: Date | null;
  costPerLiterNgn: number;
  odometerKm: number | null;
  status: string;
  source: string;
} {
  const price = Number(receipt.price_per_liter || receipt.pricePerLiter) || 650;
  const declared = Number(receipt.declared_liters || receipt.declaredLiters);
  const reconciliationStatus =
    receipt.reconciliation_status || receipt.reconciliationStatus || 'pending';

  return {
    customerId: (receipt.customer_id || receipt.customerId) as string,
    vehicleId: (receipt.vehicle_id || receipt.vehicleId) as string,
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

export async function backfillDriverReceiptPurchases(db: typeof DbType): Promise<number> {
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
    await db.insert(fuelPurchases).values(buildPurchaseValuesFromReceipt(row as ReceiptRow));
    synced += 1;
  }

  if (synced > 0) {
    console.log(`[driver-receipt-sync] Backfilled ${synced} driver receipt(s) into fuel_purchases`);
  }

  return synced;
}
