const { db, siphonEvents, vehicles, eq, and } = require('./db-helpers');

async function recordSiphonEvent({
  customerId,
  vehicleId,
  driverId,
  alertId,
  occurredAt,
  litersStolen,
  estimatedLossNgn,
  fuelLevelBefore,
  fuelLevelAfter,
  engineStateBefore,
  engineStateAfter,
  parkedDurationMinutes,
  latitude,
  longitude,
  locationName,
}) {
  if (alertId != null) {
    const [existing] = await db
      .select({ id: siphonEvents.id })
      .from(siphonEvents)
      .where(eq(siphonEvents.alertId, alertId))
      .limit(1);
    if (existing) return existing.id;
  }

  let resolvedDriverId = driverId ?? null;
  if (!resolvedDriverId) {
    const [vehicle] = await db
      .select({ driverId: vehicles.driverId })
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId))
      .limit(1);
    resolvedDriverId = vehicle?.driverId ?? null;
  }

  const [row] = await db
    .insert(siphonEvents)
    .values({
      customerId,
      vehicleId,
      driverId: resolvedDriverId,
      alertId: alertId ?? null,
      occurredAt: occurredAt ?? new Date(),
      litersStolen: Number(litersStolen).toFixed(2),
      estimatedLossNgn,
      fuelLevelBefore:
        fuelLevelBefore != null ? Number(fuelLevelBefore).toFixed(2) : null,
      fuelLevelAfter:
        fuelLevelAfter != null ? Number(fuelLevelAfter).toFixed(2) : null,
      engineStateBefore: engineStateBefore ?? false,
      engineStateAfter: engineStateAfter ?? false,
      parkedDurationMinutes: parkedDurationMinutes ?? null,
      latitude: latitude?.toString() ?? null,
      longitude: longitude?.toString() ?? null,
      locationName: locationName ?? null,
      status: 'active',
    })
    .returning({ id: siphonEvents.id });

  return row.id;
}

module.exports = { recordSiphonEvent };
