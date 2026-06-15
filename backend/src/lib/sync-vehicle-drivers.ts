import { vehicles, drivers } from '../db/schema';
import { eq, isNotNull } from 'drizzle-orm';
import type { db as DbType } from '../db';

/**
 * Keeps vehicle.driver_name in sync with the assigned driver's full_name.
 */
export async function syncDemoVehicleDrivers(db: typeof DbType): Promise<number> {
  const assigned = await db
    .select({
      vehicleId: vehicles.id,
      vehicleDriverId: vehicles.driverId,
      vehicleDriverName: vehicles.driverName,
      driverFullName: drivers.fullName,
    })
    .from(vehicles)
    .innerJoin(drivers, eq(vehicles.driverId, drivers.id))
    .where(isNotNull(vehicles.driverId));

  let updated = 0;

  for (const row of assigned) {
    if (row.vehicleDriverName !== row.driverFullName) {
      await db
        .update(vehicles)
        .set({ driverName: row.driverFullName })
        .where(eq(vehicles.id, row.vehicleId));
      updated += 1;
    }
  }

  if (updated > 0) {
    console.log(`[sync-vehicle-drivers] Synced driver names on ${updated} vehicle(s)`);
  }

  return updated;
}
