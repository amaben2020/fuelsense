// Background pass over recent trips, checking each against its expected route.
//
// Deliberately not run inside the telemetry pipeline: a Directions lookup can
// be slow or refused, and nothing about a route check should be able to delay a
// frame being written. Trips are checked after the fact, and any that came back
// `unknown` — a routing failure, a dead-zone gap, too few fixes — are retried
// for a fortnight, because the evidence that settles them often arrives later.
import { db, sql } from './db-helpers';
import { segmentTrips, TelemetryTripPoint } from './trip-segmentation';
import { recordRouteCheck, verifyTripRoute, TripToCheck } from './route-verification';

const RECHECK_WINDOW_DAYS = Number(process.env.ROUTE_RECHECK_DAYS || 14);
/** Bounded so one sweep cannot spend the day's Directions budget in a burst. */
const MAX_TRIPS_PER_SWEEP = Number(process.env.ROUTE_SWEEP_MAX_TRIPS || 20);

interface VehicleRow {
  vehicle_id: string;
  customer_id: string;
  license_plate: string | null;
  model: string | null;
  consumption_rate_l_per_100km: string | null;
}

/**
 * Trips with no settled verdict yet — never checked, or checked and unknown.
 * A trip whose verdict is already on_route/deviated/inconclusive is left alone.
 */
export async function checkRecentTrips(): Promise<{ checked: number; deviated: number }> {
  const vehicles = (
    await db.execute(sql`
      SELECT v.id AS vehicle_id, v.customer_id, v.license_plate, v.model,
             v.consumption_rate_l_per_100km
      FROM vehicles v
    `)
  ).rows as unknown as VehicleRow[];

  let checked = 0;
  let deviated = 0;

  for (const vehicle of vehicles) {
    if (checked >= MAX_TRIPS_PER_SWEEP) break;

    const points = (
      await db.execute(sql`
        SELECT latitude::double precision AS lat, longitude::double precision AS lng,
               speed_kph, ignition_on, recorded_at
        FROM telemetry
        WHERE vehicle_id = ${vehicle.vehicle_id}
          AND recorded_at > NOW() - (${RECHECK_WINDOW_DAYS} || ' days')::INTERVAL
          AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY recorded_at ASC
      `)
    ).rows as Array<Record<string, unknown>>;

    if (points.length === 0) continue;

    const tripPoints: TelemetryTripPoint[] = points.map((p) => ({
      lat: Number(p.lat),
      lng: Number(p.lng),
      speedKph: p.speed_kph != null ? Number(p.speed_kph) : 0,
      ignitionOn: Boolean(p.ignition_on),
      recordedAt: new Date(p.recorded_at as string),
    }));

    const settled = (
      await db.execute(sql`
        SELECT trip_start_at FROM route_checks
        WHERE vehicle_id = ${vehicle.vehicle_id}
          AND verdict <> 'unknown'
          AND trip_start_at > NOW() - (${RECHECK_WINDOW_DAYS} || ' days')::INTERVAL
      `)
    ).rows as Array<{ trip_start_at: string }>;

    const done = new Set(settled.map((r) => new Date(r.trip_start_at).getTime()));

    for (const trip of segmentTrips(tripPoints)) {
      if (checked >= MAX_TRIPS_PER_SWEEP) break;
      // An in-progress trip has no destination yet; wait for it to finish.
      if (trip.active) continue;
      if (done.has(new Date(trip.start_at).getTime())) continue;

      const fixes = tripPoints
        .filter((p) => {
          const at = p.recordedAt.getTime();
          return (
            at >= new Date(trip.start_at).getTime() && at <= new Date(trip.end_at).getTime()
          );
        })
        .map((p) => ({ lat: p.lat, lng: p.lng, at: p.recordedAt }));

      const toCheck: TripToCheck = {
        vehicleId: vehicle.vehicle_id,
        customerId: vehicle.customer_id,
        startAt: new Date(trip.start_at),
        endAt: new Date(trip.end_at),
        distanceKm: trip.distance_km,
        fixes,
        stops: trip.stops
          .filter((s) => s.kind === 'stop')
          .map((s) => ({ lat: s.lat, lng: s.lng })),
        licensePlate: vehicle.license_plate,
        model: vehicle.model,
        consumptionL100km:
          vehicle.consumption_rate_l_per_100km != null
            ? Number(vehicle.consumption_rate_l_per_100km)
            : null,
      };

      try {
        const result = await verifyTripRoute(toCheck);
        await recordRouteCheck(toCheck, result);
        checked += 1;
        if (result.verdict === 'deviated') deviated += 1;
      } catch (error) {
        console.error('[route_sweep] trip check failed:', (error as Error).message);
      }
    }
  }

  return { checked, deviated };
}

let timer: NodeJS.Timeout | null = null;

/** Mirrors the receipt sweep's cadence. Failures are logged, never thrown. */
export function startRouteSweep(intervalMs = 15 * 60 * 1000): void {
  if (timer) return;

  const run = async () => {
    try {
      const { checked, deviated } = await checkRecentTrips();
      if (checked > 0) {
        console.log(`[route_sweep] ${checked} trip(s) checked, ${deviated} off route`);
      }
    } catch (error) {
      console.error('[route_sweep] failed:', (error as Error).message);
    }
  };

  timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
}
