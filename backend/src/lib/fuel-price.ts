// What a litre of fuel actually cost this fleet.
//
// Every naira figure the app shows is derived from a price per litre. The only
// price we can honestly claim is one a driver actually paid, so it comes from
// the most recent logged purchase. Until a receipt exists there is no real
// price, and callers get null — the UI then shows litres without money rather
// than presenting an assumed rate as fact.
import { db, fuelPurchases, eq, and, desc, sql } from './db-helpers';

export interface FuelPrice {
  ngnPerLiter: number;
  /** When the receipt this price came from was logged. */
  asOf: Date;
}

/**
 * The newest real price per litre for a customer, or null when no purchase
 * has ever been logged.
 */
export async function latestReceiptPrice(customerId: string): Promise<FuelPrice | null> {
  const [row] = await db
    .select({
      price: fuelPurchases.costPerLiterNgn,
      at: fuelPurchases.purchasedAt,
    })
    .from(fuelPurchases)
    .where(
      and(
        eq(fuelPurchases.customerId, customerId),
        sql`${fuelPurchases.costPerLiterNgn} IS NOT NULL`,
        sql`${fuelPurchases.costPerLiterNgn} > 0`
      )
    )
    .orderBy(desc(fuelPurchases.purchasedAt))
    .limit(1);

  if (!row?.price) return null;
  return { ngnPerLiter: Number(row.price), asOf: row.at };
}
