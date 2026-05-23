require('dotenv').config();

const { db, initDatabase, closePool } = require('./db');
const { alerts, vehicles } = require('./db/schema');
const { eq, and } = require('drizzle-orm');
const { recordSiphonEvent } = require('./lib/siphon-recorder');

const seedFuelEvents = async () => {
  await initDatabase();

  const theftAlerts = await db
    .select({
      id: alerts.id,
      customerId: alerts.customerId,
      vehicleId: alerts.vehicleId,
      message: alerts.message,
      fuelDropLiters: alerts.fuelDropLiters,
      estimatedLossNgn: alerts.estimatedLossNgn,
      latitude: alerts.latitude,
      longitude: alerts.longitude,
      createdAt: alerts.createdAt,
      licensePlate: vehicles.licensePlate,
    })
    .from(alerts)
    .innerJoin(vehicles, eq(alerts.vehicleId, vehicles.id))
    .where(and(eq(alerts.alertType, 'fuel_theft'), eq(alerts.isResolved, false)));

  let count = 0;
  for (const row of theftAlerts) {
    if (!row.vehicleId || !row.customerId) continue;
    await recordSiphonEvent({
      customerId: row.customerId,
      vehicleId: row.vehicleId,
      alertId: row.id,
      occurredAt: row.createdAt,
      litersStolen: Number(row.fuelDropLiters) || 10,
      estimatedLossNgn: Number(row.estimatedLossNgn) || 0,
      fuelLevelAfter: 0,
      fuelLevelBefore: Number(row.fuelDropLiters) || 10,
      engineStateBefore: false,
      engineStateAfter: false,
      latitude: row.latitude,
      longitude: row.longitude,
      locationName: row.licensePlate ? `Near ${row.licensePlate} last GPS` : null,
    });
    count += 1;
  }

  console.log(`Siphon events synced from alerts: ${count}`);
  await closePool();
};

seedFuelEvents().catch((err) => {
  console.error(err);
  process.exit(1);
});
