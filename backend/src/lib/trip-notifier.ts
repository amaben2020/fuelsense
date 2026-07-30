// Tells the fleet manager the moment a vehicle is taken out.
//
// The Trip scenario (AVL 250) is not enabled on our trackers, so trip starts
// are derived from the ignition element (AVL 239) instead: an off→on
// transition is a journey beginning. That works with what the device already
// sends, and needs no reconfiguration in the field.
import { db, deviceEvents, alerts, eq, and, sql } from './db-helpers';

// Ignition can flicker (stall-and-restart, cranking, a driver moving the car a
// few metres). Collapsing starts within this window keeps one journey from
// firing a burst of notifications.
const TRIP_START_DEBOUNCE_MS = 15 * 60 * 1000;

const lastIgnitionByImei = new Map<string, boolean>();
const lastTripStartByImei = new Map<string, number>();

export function resetTripNotifierState(): void {
  lastIgnitionByImei.clear();
  lastTripStartByImei.clear();
}

export interface TripStartContext {
  imei: string;
  customerId: string;
  vehicleId: string;
  latitude: string | null;
  longitude: string | null;
  occurredAt: Date;
  licensePlate?: string;
  driverName?: string | null;
}

/**
 * Feed every telemetry record here. Returns true when this record marks the
 * start of a new trip (and a notification was raised).
 */
export async function handleIgnitionForTripStart(
  ignitionOn: boolean,
  ctx: TripStartContext
): Promise<boolean> {
  const prev = lastIgnitionByImei.get(ctx.imei);
  lastIgnitionByImei.set(ctx.imei, ignitionOn);

  // Only an off→on edge starts a trip. On the very first record for a device
  // we have no previous state, so we wait for a real transition rather than
  // announcing a trip just because the server restarted mid-journey.
  if (prev !== false || !ignitionOn) return false;

  const now = ctx.occurredAt.getTime();
  const last = lastTripStartByImei.get(ctx.imei);
  if (last != null && now - last < TRIP_START_DEBOUNCE_MS) return false;
  lastTripStartByImei.set(ctx.imei, now);

  const plate = ctx.licensePlate ?? 'Vehicle';
  const driver = ctx.driverName ? ` Driver: ${ctx.driverName}.` : '';

  await db.insert(deviceEvents).values({
    imei: ctx.imei,
    customerId: ctx.customerId,
    vehicleId: ctx.vehicleId,
    eventType: 'trip_start',
    severity: 'info',
    latitude: ctx.latitude,
    longitude: ctx.longitude,
    occurredAt: ctx.occurredAt,
  });

  const [open] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.customerId, ctx.customerId),
        eq(alerts.vehicleId, ctx.vehicleId),
        eq(alerts.alertType, 'trip_start'),
        eq(alerts.isResolved, false)
      )
    )
    .limit(1);

  if (!open) {
    await db.insert(alerts).values({
      imei: ctx.imei,
      customerId: ctx.customerId,
      vehicleId: ctx.vehicleId,
      alertType: 'trip_start',
      message: `${plate} has started a trip — ignition on.${driver}`,
      latitude: ctx.latitude,
      longitude: ctx.longitude,
    });
  }

  return true;
}

/** Closes the open "on a trip" alert once the vehicle is shut off. */
export async function closeTripStartAlert(
  customerId: string,
  vehicleId: string
): Promise<void> {
  await db
    .update(alerts)
    .set({ isResolved: true, resolvedAt: sql`NOW()` })
    .where(
      and(
        eq(alerts.customerId, customerId),
        eq(alerts.vehicleId, vehicleId),
        eq(alerts.alertType, 'trip_start'),
        eq(alerts.isResolved, false)
      )
    );
}
