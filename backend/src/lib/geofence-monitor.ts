// Turns position fixes into zone entry/exit alerts.
//
// The /geofences/events endpoint answers "what crossings happened last week"
// retrospectively in SQL. That is the wrong shape for a manager who wants to
// know *now* that a vehicle left a site, so containment is also evaluated on
// every incoming record here and a crossing raises an alert immediately.
import { db, alerts, vehicles, eq, and, sql } from './db-helpers';
import { geofences, geofenceStates } from '../db/schema';
import { alertEmail, sendMail } from './mailer';
import { resolveAlertRecipient } from './alert-mail';

const EARTH_RADIUS_M = 6_371_000;

/**
 * Hysteresis band around the boundary, in metres.
 *
 * A vehicle parked exactly on a depot edge with 10 m of GPS scatter would
 * otherwise alternate inside/outside on consecutive fixes and emit an alert
 * storm. Crossing only counts once the fix is clear of the band it was last in.
 */
const BOUNDARY_HYSTERESIS_M = 25;

export interface GeofenceContext {
  imei: string;
  customerId: string;
  vehicleId: string;
  latitude: number | null;
  longitude: number | null;
  recordedAt: Date;
  licensePlate?: string;
  driverName?: string | null;
}

export interface GeofenceCrossing {
  zoneId: string;
  zoneName: string;
  purpose: string;
  direction: 'entered' | 'exited';
}

/** Great-circle distance. Equirectangular is not good enough near a boundary. */
export function haversineMetres(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ray casting for polygon zones, on [lat, lng] rings.
 *
 * Longitude is treated as x. This is safe for the zone sizes fleets actually
 * draw and breaks only for a polygon spanning the antimeridian, which no
 * depot does.
 */
export function pointInPolygon(
  lat: number,
  lng: number,
  ring: [number, number][]
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const straddles = latI > lat !== latJ > lat;
    if (!straddles) continue;
    const x = ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (lng < x) inside = !inside;
  }
  return inside;
}

interface ZoneRow {
  id: string;
  name: string;
  shape: string;
  centerLat: string | null;
  centerLng: string | null;
  radiusM: number | null;
  polygon: unknown;
  purpose: string;
  notifyOn: string;
}

/**
 * Signed distance from the boundary: negative inside, positive outside.
 * Returns null when the zone is unusable (missing centre, degenerate ring).
 */
function signedDistanceM(zone: ZoneRow, lat: number, lng: number): number | null {
  if (zone.shape === 'circle') {
    if (zone.centerLat == null || zone.centerLng == null || !zone.radiusM) return null;
    const d = haversineMetres(lat, lng, Number(zone.centerLat), Number(zone.centerLng));
    return d - zone.radiusM;
  }

  if (zone.shape === 'polygon') {
    const ring = zone.polygon as [number, number][] | null;
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const inside = pointInPolygon(lat, lng, ring);
    // Distance to the nearest vertex is a cheap stand-in for distance to the
    // nearest edge — only its sign and rough magnitude matter, and it is used
    // solely to drive the hysteresis band.
    let nearest = Infinity;
    for (const [vLat, vLng] of ring) {
      nearest = Math.min(nearest, haversineMetres(lat, lng, vLat, vLng));
    }
    return inside ? -nearest : nearest;
  }

  return null;
}

function phrase(
  zone: ZoneRow,
  direction: 'entered' | 'exited',
  plate: string,
  driver: string | null | undefined
): string {
  const who = driver ? `${plate} (${driver})` : plate;
  if (zone.purpose === 'restricted') {
    return direction === 'entered'
      ? `${who} entered restricted zone "${zone.name}".`
      : `${who} left restricted zone "${zone.name}".`;
  }
  if (zone.purpose === 'customer') {
    return direction === 'entered'
      ? `${who} arrived at customer site "${zone.name}".`
      : `${who} departed customer site "${zone.name}".`;
  }
  return direction === 'entered'
    ? `${who} arrived at "${zone.name}".`
    : `${who} left "${zone.name}".`;
}

function wants(notifyOn: string, direction: 'entered' | 'exited'): boolean {
  if (notifyOn === 'both') return true;
  return notifyOn === (direction === 'entered' ? 'enter' : 'exit');
}

/**
 * Mail the manager that a vehicle crossed a zone boundary.
 *
 * Until now a crossing only wrote an `alerts` row, so "notify on exit" meant
 * "appear in a list the next time somebody opens the dashboard" — which is not
 * a notification. A vehicle leaving a site at 02:00 is exactly the case where
 * nobody is looking at a screen.
 *
 * Opt-in is respected as it is everywhere else: `resolveAlertRecipient`
 * returns null unless the manager has switched this alert type on, so enabling
 * geofencing never starts mailing an account that never asked. Failures are
 * swallowed — a bounced alert must not stop the tracker ingesting telemetry,
 * and the alert row is already durable regardless.
 */
async function notifyCrossing(
  zone: ZoneRow,
  direction: 'entered' | 'exited',
  ctx: GeofenceContext
): Promise<void> {
  try {
    const to = await resolveAlertRecipient(
      ctx.customerId,
      direction === 'entered' ? 'geofence_entry' : 'geofence_exit'
    );
    if (!to) return;

    const plate = ctx.licensePlate ?? 'Vehicle';
    const verb = direction === 'entered' ? 'entered' : 'left';
    const { text, html } = alertEmail({
      title: `${plate} ${verb} ${zone.name}`,
      lines: [
        ['Vehicle', plate],
        ['Driver', ctx.driverName || 'Unassigned'],
        ['Zone', `${zone.name} (${zone.purpose})`],
        ['Movement', direction === 'entered' ? 'Entered the zone' : 'Left the zone'],
        ['Time', ctx.recordedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
      ],
      linkUrl:
        ctx.latitude != null && ctx.longitude != null
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${ctx.latitude},${ctx.longitude}`)}`
          : null,
      linkLabel: 'Where the vehicle crossed',
      footer: 'FuelSense · turn these off in Settings → Notifications',
    });

    await sendMail({
      to,
      subject: `${plate} ${verb} ${zone.name}`,
      text,
      html,
    });
  } catch {
    // Deliberately silent: see above.
  }
}

/**
 * Feed every telemetry record here. Returns the crossings that raised alerts.
 *
 * Zones with a NULL vehicle_id apply fleet-wide; a zone bound to a vehicle only
 * evaluates for that vehicle. A driver-bound zone additionally requires that
 * driver to be the one currently assigned, so reassigning a vehicle silently
 * moves its zone obligations with the driver.
 */
export async function handleGeofenceForRecord(
  ctx: GeofenceContext
): Promise<GeofenceCrossing[]> {
  const { latitude, longitude, vehicleId, customerId } = ctx;
  if (latitude == null || longitude == null || !vehicleId || !customerId) return [];

  const zones = (await db
    .select({
      id: geofences.id,
      name: geofences.name,
      shape: geofences.shape,
      centerLat: geofences.centerLat,
      centerLng: geofences.centerLng,
      radiusM: geofences.radiusM,
      polygon: geofences.polygon,
      purpose: geofences.purpose,
      notifyOn: geofences.notifyOn,
    })
    .from(geofences)
    .where(
      and(
        eq(geofences.customerId, customerId),
        eq(geofences.active, true),
        sql`(${geofences.vehicleId} IS NULL OR ${geofences.vehicleId} = ${vehicleId}::uuid)`,
        sql`(${geofences.driverId} IS NULL OR ${geofences.driverId} = (
              SELECT driver_id FROM ${vehicles} WHERE id = ${vehicleId}::uuid
            ))`
      )
    )) as ZoneRow[];

  if (!zones.length) return [];

  const priorRows = await db
    .select({ geofenceId: geofenceStates.geofenceId, inside: geofenceStates.inside })
    .from(geofenceStates)
    .where(eq(geofenceStates.vehicleId, vehicleId));
  const prior = new Map(priorRows.map((r) => [r.geofenceId, r.inside]));

  const crossings: GeofenceCrossing[] = [];

  for (const zone of zones) {
    const signed = signedDistanceM(zone, latitude, longitude);
    if (signed == null) continue;

    const was = prior.get(zone.id);
    let isInside: boolean;

    if (was == null) {
      // First sighting establishes a baseline. Emitting an alert here would
      // announce "entered depot" for a vehicle that has been parked there all
      // along, so the first fix is recorded silently.
      isInside = signed < 0;
    } else {
      // Only flip once clear of the hysteresis band; otherwise hold the last
      // verdict so GPS scatter on the boundary cannot oscillate.
      if (was && signed > BOUNDARY_HYSTERESIS_M) isInside = false;
      else if (!was && signed < -BOUNDARY_HYSTERESIS_M) isInside = true;
      else isInside = was;
    }

    const changed = was == null || was !== isInside;
    if (!changed) continue;

    await db
      .insert(geofenceStates)
      .values({ geofenceId: zone.id, vehicleId, inside: isInside })
      .onConflictDoUpdate({
        target: [geofenceStates.geofenceId, geofenceStates.vehicleId],
        set: { inside: isInside, changedAt: sql`NOW()`, updatedAt: sql`NOW()` },
      });

    if (was == null) continue;

    const direction: 'entered' | 'exited' = isInside ? 'entered' : 'exited';
    if (!wants(zone.notifyOn, direction)) continue;

    const plate = ctx.licensePlate ?? 'Vehicle';
    await db.insert(alerts).values({
      imei: ctx.imei,
      customerId,
      vehicleId,
      alertType: direction === 'entered' ? 'geofence_entry' : 'geofence_exit',
      message: phrase(zone, direction, plate, ctx.driverName),
      latitude: latitude.toString(),
      longitude: longitude.toString(),
    });

    // Not awaited into the ingest path's critical section beyond this call:
    // the alert row above is what makes the crossing durable, and the mail is
    // best-effort on top of it.
    await notifyCrossing(zone, direction, ctx);

    crossings.push({
      zoneId: zone.id,
      zoneName: zone.name,
      purpose: zone.purpose,
      direction,
    });
  }

  return crossings;
}
