// Checking one trip against where the vehicle should have been.
//
// Same shape as receipt-verification: this file gathers evidence and persists
// verdicts, while every judgement lives in route-corridor.ts as a pure
// function. Keeping them apart is what makes the thresholds testable without a
// database, and what stops a query change quietly altering what counts as a
// detour.
import { db, sql, alerts, vehicles, eq } from './db-helpers';
import {
  assessRoute,
  bestCorridorMatch,
  metresBetween,
  pathLengthKm,
  DEFAULT_ROUTE_THRESHOLDS,
  GeoPoint,
  RouteAssessment,
  RouteThresholds,
  TrackedFix,
} from './route-corridor';
import { fetchExpectedRoute, ExpectedRoute } from './directions';
import { latestReceiptPrice } from './fuel-price';
import { baselineEfficiencyL100km } from './fuel-metrics';

/** Start and end this close together is a loop, not an A→B run. */
const LOOP_RADIUS_M = 300;

export interface TripToCheck {
  vehicleId: string;
  customerId: string;
  startAt: Date;
  endAt: Date;
  distanceKm: number;
  fixes: TrackedFix[];
  /** Mid-trip halts, used as waypoints so a delivery round is not a "detour". */
  stops?: GeoPoint[];
  licensePlate?: string | null;
  model?: string | null;
  consumptionL100km?: number | null;
}

export interface RouteCheckResult extends RouteAssessment {
  expected_path_source: 'route_assignment' | 'directions_api' | null;
  expected_distance_km: number | null;
  route_reference: string | null;
  matched_path_index: number;
  checked_at: string;
}

interface AssignedRoute {
  waypoints: GeoPoint[];
  corridorWidthM: number | null;
  name: string | null;
}

/**
 * A route someone actually planned for this vehicle beats anything inferred.
 * Assignments also carry their own corridor width, because a tight urban round
 * and a highway haul do not share a definition of "off route".
 */
async function assignedRouteFor(
  vehicleId: string,
  when: Date
): Promise<AssignedRoute | null> {
  const result = await db.execute(sql`
    SELECT name, waypoints, corridor_width_m
    FROM route_assignments
    WHERE vehicle_id = ${vehicleId}
      AND active IS TRUE
      AND (effective_from IS NULL OR effective_from <= ${when})
      AND (effective_to IS NULL OR effective_to >= ${when})
    ORDER BY effective_from DESC NULLS LAST
    LIMIT 1
  `);

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row?.waypoints) return null;

  const waypoints = row.waypoints as GeoPoint[];
  if (!Array.isArray(waypoints) || waypoints.length < 2) return null;

  return {
    waypoints,
    corridorWidthM: row.corridor_width_m != null ? Number(row.corridor_width_m) : null,
    name: (row.name as string) ?? null,
  };
}

/**
 * Resolve what the trip *should* have looked like.
 *
 * Order matters: a planned route is authoritative, the road network is a
 * reasonable inference, and a straight line is never acceptable — it would
 * cross rivers and buildings and mark honest trips as detours.
 */
async function expectedPathFor(
  trip: TripToCheck
): Promise<{ route: ExpectedRoute | null; assignment: AssignedRoute | null }> {
  const assignment = await assignedRouteFor(trip.vehicleId, trip.startAt).catch(() => null);

  if (assignment) {
    // The planned waypoints are corners, not a drivable line, so they are still
    // routed through the road network — via the API when it answers, and as a
    // waypoint chain when it does not.
    const [origin, ...rest] = assignment.waypoints;
    const destination = rest.pop() as GeoPoint;
    const routed = await fetchExpectedRoute(origin, destination, rest);

    return {
      assignment,
      route: routed
        ? { ...routed, source: 'route_assignment' }
        : {
            paths: [assignment.waypoints],
            distanceKm: Math.round(pathLengthKm(assignment.waypoints) * 10) / 10,
            source: 'route_assignment',
            reference: assignment.name ?? 'assignment',
          },
    };
  }

  const origin = trip.fixes[0];
  const destination = trip.fixes[trip.fixes.length - 1];
  if (!origin || !destination) return { route: null, assignment: null };

  // A round trip has no meaningful point-to-point route — Directions would
  // answer "0 km, you are already there". Its own stops are the only thing
  // that describes where it was supposed to go.
  const isLoop = metresBetween(origin, destination) < LOOP_RADIUS_M;
  const waypoints = trip.stops ?? [];

  if (isLoop && waypoints.length === 0) {
    return { route: null, assignment: null };
  }

  const route = await fetchExpectedRoute(origin, destination, waypoints);
  return { route, assignment: null };
}

/** Check one trip. Never throws — a failed check records `unknown`. */
export async function verifyTripRoute(trip: TripToCheck): Promise<RouteCheckResult> {
  const price = await latestReceiptPrice(trip.customerId).catch(() => null);
  const consumption =
    trip.consumptionL100km ?? baselineEfficiencyL100km(trip.model ?? '') ?? null;

  let route: ExpectedRoute | null = null;
  let assignment: AssignedRoute | null = null;

  try {
    ({ route, assignment } = await expectedPathFor(trip));
  } catch (error) {
    console.warn('[route_check] expected path lookup failed:', (error as Error).message);
  }

  const thresholds: Partial<RouteThresholds> = assignment?.corridorWidthM
    ? { corridorWidthM: assignment.corridorWidthM }
    : {};
  const corridorWidthM = thresholds.corridorWidthM ?? DEFAULT_ROUTE_THRESHOLDS.corridorWidthM;

  const match = route
    ? bestCorridorMatch(trip.fixes, route.paths, corridorWidthM)
    : { stats: bestCorridorMatch(trip.fixes, [], corridorWidthM).stats, pathIndex: -1 };

  const assessment = assessRoute({
    stats: match.stats,
    actualDistanceKm: trip.distanceKm,
    expectedDistanceKm: route?.distanceKm ?? null,
    hasExpectedPath: route != null,
    consumptionL100km: consumption,
    pricePerLiter: price?.ngnPerLiter ?? null,
    thresholds,
  });

  return {
    ...assessment,
    expected_path_source: route?.source ?? null,
    expected_distance_km: route?.distanceKm ?? null,
    route_reference: route?.reference ?? null,
    matched_path_index: match.pathIndex,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Store the verdict with its evidence.
 *
 * `reconciled_at` stays null while the answer is `unknown`, so the column keeps
 * meaning "a verdict was reached" rather than "we looked at it once" — the same
 * rule the receipt engine follows, and what lets the sweep find work to redo.
 */
export async function recordRouteCheck(
  trip: TripToCheck,
  result: RouteCheckResult
): Promise<void> {
  const settled = result.verdict !== 'unknown';

  await db.execute(sql`
    INSERT INTO route_checks (
      customer_id, vehicle_id, trip_start_at, trip_end_at, verdict,
      detour_km, extra_liters, extra_cost_ngn, evidence, reconciled_at
    ) VALUES (
      ${trip.customerId}, ${trip.vehicleId}, ${trip.startAt}, ${trip.endAt}, ${result.verdict},
      ${result.detour_km}, ${result.extra_liters}, ${result.extra_cost_naira},
      ${JSON.stringify(result)}::jsonb, ${settled ? sql`NOW()` : null}
    )
    ON CONFLICT (vehicle_id, trip_start_at) DO UPDATE SET
      verdict = EXCLUDED.verdict,
      detour_km = EXCLUDED.detour_km,
      extra_liters = EXCLUDED.extra_liters,
      extra_cost_ngn = EXCLUDED.extra_cost_ngn,
      evidence = EXCLUDED.evidence,
      reconciled_at = EXCLUDED.reconciled_at
  `);

  if (result.verdict !== 'deviated') return;

  // One alert per trip, not per re-check — the sweep re-runs the same trip for
  // a fortnight and a manager should not get the same deviation twice.
  const existing = await db.execute(sql`
    SELECT 1 FROM alerts
    WHERE vehicle_id = ${trip.vehicleId}
      AND alert_type = 'route_deviation'
      AND created_at > ${trip.startAt}::timestamp - INTERVAL '1 hour'
      AND created_at < ${trip.endAt}::timestamp + INTERVAL '14 days'
    LIMIT 1
  `);
  if (existing.rows.length > 0) return;

  const [vehicle] = await db
    .select({ licensePlate: vehicles.licensePlate })
    .from(vehicles)
    .where(eq(vehicles.id, trip.vehicleId));

  const plate = trip.licensePlate ?? vehicle?.licensePlate ?? 'Vehicle';
  const costPhrase =
    result.extra_cost_naira != null && result.extra_cost_naira > 0
      ? ` Est. ₦${result.extra_cost_naira.toLocaleString('en-NG')} of extra fuel.`
      : '';

  await db.insert(alerts).values({
    customerId: trip.customerId,
    vehicleId: trip.vehicleId,
    alertType: 'route_deviation',
    message: `${plate} left its expected route on the ${trip.startAt.toISOString().slice(11, 16)} trip. ${result.summary}${costPhrase}`,
    fuelDropLiters: result.extra_liters != null ? result.extra_liters.toFixed(2) : null,
    estimatedLossNgn: result.extra_cost_naira ?? null,
    latitude: trip.fixes[0]?.lat.toString() ?? null,
    longitude: trip.fixes[0]?.lng.toString() ?? null,
  });
}
