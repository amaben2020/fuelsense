const { db, telemetry, eq, and, sql } = require('./db-helpers');
const { REFUEL_THRESHOLD_LITERS, DEFAULT_FUEL_PRICE_NGN_LITER } = require('./fuel-metrics');

const RECEIPT_FRAUD_THRESHOLD_LITERS = 5;
const MATCH_TOLERANCE_LITERS = 3;

/**
 * Find max OBD refuel delta near transaction time (FMC150 IO 390).
 */
async function findObdRefuelLiters({ vehicleId, customerId, transactionDate }) {
  const when = transactionDate instanceof Date ? transactionDate : new Date(transactionDate);

  const result = await db.execute(sql`
    WITH readings AS (
      SELECT fuel_level_liters::numeric AS fuel, recorded_at
      FROM telemetry
      WHERE vehicle_id = ${vehicleId}
        AND customer_id = ${customerId}
        AND recorded_at BETWEEN ${when.toISOString()}::timestamp - INTERVAL '2 hours'
          AND ${when.toISOString()}::timestamp + INTERVAL '2 hours'
      ORDER BY recorded_at ASC
    ),
    ordered AS (
      SELECT fuel, LAG(fuel) OVER (ORDER BY recorded_at) AS prev_fuel FROM readings
    )
    SELECT MAX(fuel - prev_fuel) AS max_refuel
    FROM ordered
    WHERE prev_fuel IS NOT NULL AND fuel - prev_fuel >= ${REFUEL_THRESHOLD_LITERS}
  `);

  const value = result.rows[0]?.max_refuel;
  return value != null ? Number(value) : null;
}

function reconcileReceipt({ declaredLiters, obdLitersActual, pricePerLiter }) {
  const price = pricePerLiter ?? DEFAULT_FUEL_PRICE_NGN_LITER;
  const declared = Number(declaredLiters);

  if (obdLitersActual == null) {
    return {
      obdLitersActual: null,
      differenceLiters: null,
      reconciliationStatus: 'pending',
      estimatedLossNgn: 0,
    };
  }

  const actual = Number(obdLitersActual);
  const difference = Math.round((declared - actual) * 10) / 10;
  let reconciliationStatus = 'pending';

  if (difference > RECEIPT_FRAUD_THRESHOLD_LITERS) {
    reconciliationStatus = 'flagged_theft';
  } else if (Math.abs(difference) <= MATCH_TOLERANCE_LITERS) {
    reconciliationStatus = 'matched';
  }

  const estimatedLossNgn =
    difference > 0 ? Math.round(difference * price) : 0;

  return {
    obdLitersActual: actual,
    differenceLiters: difference,
    reconciliationStatus,
    estimatedLossNgn,
  };
}

module.exports = {
  RECEIPT_FRAUD_THRESHOLD_LITERS,
  findObdRefuelLiters,
  reconcileReceipt,
};
