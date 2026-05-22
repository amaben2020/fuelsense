require('dotenv').config();

const { db, initDatabase, closePool } = require('./db');
const { customers, fuelPurchases } = require('./db/schema');
const { eq, sql } = require('drizzle-orm');
const { REFUEL_THRESHOLD_LITERS, DEFAULT_FUEL_PRICE_NGN_LITER } = require('./lib/fuel-metrics');

const DEMO_EMAIL = 'demo@fuelsense.local';
const MERCHANTS = [
  'TotalEnergies Ikeja',
  'Mobil Ojota',
  'NNPC Apapa',
  'MRS Lekki',
  'Oando VI',
  'Conoil Surulere',
];

const seedFuelPurchases = async () => {
  await initDatabase();

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, DEMO_EMAIL));

  if (!customer) {
    throw new Error('Run npm run seed first');
  }

  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

  await db.delete(fuelPurchases).where(eq(fuelPurchases.customerId, customer.id));

  const refuelResult = await db.execute(sql`
    WITH readings AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        t.fuel_level_liters::numeric AS fuel_level_liters,
        t.odometer_km,
        t.recorded_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      WHERE t.customer_id = ${customer.id}
        AND t.recorded_at > NOW() - INTERVAL '30 days'
        AND t.fuel_level_liters IS NOT NULL
    ),
    ordered AS (
      SELECT
        *,
        LAG(fuel_level_liters) OVER (
          PARTITION BY vehicle_id ORDER BY recorded_at
        ) AS prev_fuel
      FROM readings
    ),
    refuels AS (
      SELECT *
      FROM ordered
      WHERE prev_fuel IS NOT NULL
        AND fuel_level_liters - prev_fuel >= ${REFUEL_THRESHOLD_LITERS}
    )
    SELECT * FROM refuels ORDER BY recorded_at DESC
  `);

  let count = 0;

  for (let i = 0; i < refuelResult.rows.length; i += 1) {
    const row = refuelResult.rows[i];
    const actual = Math.round(Number(row.fuel_level_liters - row.prev_fuel) * 10) / 10;
    const fraudPlate = row.license_plate === 'LAG-456-CD' && i % 4 === 0;
    const declared = fraudPlate ? actual + 15 : actual + (Math.random() < 0.2 ? 2 : 0);
    const diff = Math.max(0, Math.round((declared - actual) * 10) / 10);
    const costPerLiter = pricePerLiter + (i % 3) * 10;

    let status = 'verified';
    if (diff >= 10) status = 'flagged_theft';
    else if (diff > 2) status = 'pending_receipt';

    await db.insert(fuelPurchases).values({
      customerId: customer.id,
      vehicleId: row.vehicle_id,
      purchasedAt: new Date(row.recorded_at),
      merchant: MERCHANTS[i % MERCHANTS.length],
      receiptReference: `RCP-${String(count + 1).padStart(5, '0')}`,
      litersDeclared: declared.toFixed(2),
      litersActual: actual.toFixed(2),
      costPerLiterNgn: costPerLiter,
      odometerKm: row.odometer_km,
      status,
      source: 'obd_reconciliation',
    });
    count += 1;
  }

  console.log(`Fuel purchases seeded: ${count} records (actual liters from OBD refuel deltas)`);
  await closePool();
};

seedFuelPurchases().catch((error) => {
  console.error('Fuel purchase seed failed:', error);
  process.exit(1);
});
