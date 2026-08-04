// What a litre of fuel actually cost this fleet.
//
// Every naira figure the app shows is derived from a price per litre. The only
// price we can honestly claim is one a driver actually paid, so it comes from
// the most recent logged purchase. Until a receipt exists there is no real
// price, and callers get null — the UI then shows litres without money rather
// than presenting an assumed rate as fact.
import { db, fuelPurchases, fuelPrices, eq, and, desc, sql } from './db-helpers';

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

// ---------------------------------------------------------------------------
// Benchmark prices
//
// A receipt says what one driver paid at one pump on one day. For "what should
// this fleet be spending per kilometre", the manager needs a figure they
// control, because Nigerian pump prices move faster than receipts accumulate.
//
// Benchmark prices are effective-dated and never edited in place: setting a new
// price opens a new period and leaves every earlier period valued at the price
// that actually applied. Receipts remain the authority on actual spend — this
// only drives expected cost and the cost-per-km benchmark.
// ---------------------------------------------------------------------------

export interface BenchmarkPrice {
  ngnPerLiter: number;
  effectiveFrom: Date;
  source: string;
  note: string | null;
}

/** Every price period for a customer, newest first. */
export async function benchmarkPriceHistory(customerId: string): Promise<BenchmarkPrice[]> {
  const rows = await db
    .select({
      price: fuelPrices.ngnPerLiter,
      effectiveFrom: fuelPrices.effectiveFrom,
      source: fuelPrices.source,
      note: fuelPrices.note,
    })
    .from(fuelPrices)
    .where(eq(fuelPrices.customerId, customerId))
    .orderBy(desc(fuelPrices.effectiveFrom));

  return rows.map((row) => ({
    ngnPerLiter: Number(row.price),
    effectiveFrom: row.effectiveFrom,
    source: row.source,
    note: row.note,
  }));
}

/**
 * The benchmark price in force at a given moment — the newest period that had
 * already started. Returns null when the fleet had not set a price yet, so
 * callers can fall back rather than back-dating today's price onto history.
 */
export async function benchmarkPriceAt(
  customerId: string,
  at: Date
): Promise<BenchmarkPrice | null> {
  const [row] = await db
    .select({
      price: fuelPrices.ngnPerLiter,
      effectiveFrom: fuelPrices.effectiveFrom,
      source: fuelPrices.source,
      note: fuelPrices.note,
    })
    .from(fuelPrices)
    .where(and(eq(fuelPrices.customerId, customerId), sql`${fuelPrices.effectiveFrom} <= ${at}`))
    .orderBy(desc(fuelPrices.effectiveFrom))
    .limit(1);

  if (!row?.price) return null;
  return {
    ngnPerLiter: Number(row.price),
    effectiveFrom: row.effectiveFrom,
    source: row.source,
    note: row.note,
  };
}

/** The price a manager would see as "current". */
export async function currentBenchmarkPrice(customerId: string): Promise<BenchmarkPrice | null> {
  return benchmarkPriceAt(customerId, new Date());
}

export interface SetBenchmarkPriceInput {
  ngnPerLiter: number;
  /** Defaults to now — back-dating is allowed so a missed change can be recorded. */
  effectiveFrom?: Date;
  note?: string | null;
  source?: string;
}

/** Opens a new price period. Earlier periods are left untouched. */
export async function setBenchmarkPrice(
  customerId: string,
  input: SetBenchmarkPriceInput
): Promise<BenchmarkPrice> {
  const effectiveFrom = input.effectiveFrom ?? new Date();

  await db.insert(fuelPrices).values({
    customerId,
    ngnPerLiter: input.ngnPerLiter.toFixed(2),
    effectiveFrom,
    source: input.source ?? 'manager',
    note: input.note ?? null,
  });

  return {
    ngnPerLiter: input.ngnPerLiter,
    effectiveFrom,
    source: input.source ?? 'manager',
    note: input.note ?? null,
  };
}

/**
 * The price to value a period with, in priority order: the manager's benchmark
 * for that moment, then the newest receipt, then null. Callers that must show a
 * number fall back to DEFAULT_FUEL_PRICE_NGN_LITER themselves and should label
 * it as an assumption.
 */
export async function effectivePriceAt(
  customerId: string,
  at: Date
): Promise<{ ngnPerLiter: number; source: 'benchmark' | 'receipt' } | null> {
  const benchmark = await benchmarkPriceAt(customerId, at);
  if (benchmark) return { ngnPerLiter: benchmark.ngnPerLiter, source: 'benchmark' };

  const receipt = await latestReceiptPrice(customerId);
  if (receipt) return { ngnPerLiter: receipt.ngnPerLiter, source: 'receipt' };

  return null;
}
