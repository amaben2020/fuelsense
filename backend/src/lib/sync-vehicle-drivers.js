const { vehicles, drivers } = require('../db/schema');
const { eq, sql } = require('drizzle-orm');

const DEMO_VEHICLE_DRIVERS = [
  { plate: 'ABC-123', driverCode: 'CHIDI-ABC', driverName: 'Chidi Okonkwo' },
  { plate: 'LAG-456-CD', driverCode: 'AMARA-456', driverName: 'Amara Eze' },
  { plate: 'LAG-789-EF', driverCode: 'NGOZI-789', driverName: 'Ngozi Obi' },
  { plate: 'ABJ-101-GH', driverCode: 'EMEKA-101', driverName: 'Emeka Nwosu' },
  { plate: 'RIV-202-IJ', driverCode: 'IBRAHIM-202', driverName: 'Ibrahim Musa' },
];

async function syncDemoVehicleDrivers(db) {
  let updated = 0;

  for (const mapping of DEMO_VEHICLE_DRIVERS) {
    const [driver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.driverCode, mapping.driverCode))
      .limit(1);

    if (!driver) continue;

    const needsUpdate = await db.execute(sql`
      SELECT id FROM vehicles
      WHERE license_plate = ${mapping.plate}
        AND (driver_id IS DISTINCT FROM ${driver.id}::uuid OR driver_name IS DISTINCT FROM ${mapping.driverName})
      LIMIT 1
    `);

    if (needsUpdate.rows.length > 0) {
      await db
        .update(vehicles)
        .set({ driverId: driver.id, driverName: mapping.driverName })
        .where(eq(vehicles.licensePlate, mapping.plate));
      updated += 1;
    }
  }

  if (updated > 0) {
    console.log(`[sync-vehicle-drivers] Corrected ${updated} vehicle assignment(s)`);
  }

  return updated;
}

module.exports = { syncDemoVehicleDrivers, DEMO_VEHICLE_DRIVERS };
