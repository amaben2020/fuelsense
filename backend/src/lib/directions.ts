// The road the vehicle was supposed to take.
//
// A straight line between two points is not a route — it crosses rivers and
// buildings, and matching a real trip against it would mark almost every
// journey as a detour. That would be worse than not checking at all, because a
// flag nobody believes trains a manager to ignore all of them. So the expected
// path comes from the road network via the Directions API, as a polyline.
//
// Alternatives are requested deliberately: two arterials to the same place are
// both legitimate, and a driver must not be flagged for choosing the one Google
// ranked second.
import { db, sql } from './db-helpers';
import { chargeGoogleCall } from './google-usage';
import { GeoPoint, pathLengthKm } from './route-corridor';

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const DIRECTIONS_TIMEOUT_MS = 8000;
/** Two tries, then leave it to the sweep. A trip pipeline must not stall here. */
const DIRECTIONS_ATTEMPTS = 2;

export interface ExpectedRoute {
  /** Every acceptable path: the recommended route first, then alternatives. */
  paths: GeoPoint[][];
  /** Road distance of the recommended route. */
  distanceKm: number;
  source: 'directions_api' | 'route_assignment';
  /** Cache key, so a stored verdict can name the response it was based on. */
  reference: string;
}

/**
 * Google's polyline encoding — points packed as base64-ish varint deltas.
 * Decoding it here avoids pulling a dependency for forty lines of arithmetic.
 */
export function decodePolyline(encoded: string): GeoPoint[] {
  const points: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

const cacheKeyFor = (origin: GeoPoint, destination: GeoPoint, waypoints: GeoPoint[]): string =>
  [origin, ...waypoints, destination]
    .map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`)
    .join('|');

/**
 * Routes are cached in the database rather than in memory: the sweep re-runs
 * for up to a fortnight and restarts in between, and re-billing the same
 * origin/destination pair on every retry would make the retry policy expensive.
 */
async function cachedRoute(key: string): Promise<ExpectedRoute | null> {
  const result = await db.execute(sql`
    SELECT payload FROM route_cache WHERE route_key = ${key} LIMIT 1
  `);
  const row = result.rows[0] as { payload?: unknown } | undefined;
  if (!row?.payload) return null;
  return row.payload as ExpectedRoute;
}

async function storeRoute(key: string, route: ExpectedRoute): Promise<void> {
  await db.execute(sql`
    INSERT INTO route_cache (route_key, payload, cached_at)
    VALUES (${key}, ${JSON.stringify(route)}::jsonb, NOW())
    ON CONFLICT (route_key) DO UPDATE SET payload = EXCLUDED.payload, cached_at = NOW()
  `);
}

/**
 * The expected road path between two points, through any waypoints.
 *
 * Returns null rather than throwing when the API is unreachable or refuses:
 * the caller records `unknown` and the sweep tries again later. A failed
 * lookup must never become a deviation.
 */
export async function fetchExpectedRoute(
  origin: GeoPoint,
  destination: GeoPoint,
  waypoints: GeoPoint[] = []
): Promise<ExpectedRoute | null> {
  const key = cacheKeyFor(origin, destination, waypoints);

  const cached = await cachedRoute(key).catch(() => null);
  if (cached) return cached;

  if (!GOOGLE_KEY) return null;

  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', `${origin.lat},${origin.lng}`);
  url.searchParams.set('destination', `${destination.lat},${destination.lng}`);
  if (waypoints.length > 0) {
    url.searchParams.set(
      'waypoints',
      waypoints.map((w) => `${w.lat},${w.lng}`).join('|')
    );
  }
  // Alternatives are the guard against flagging a legitimate second-choice road.
  url.searchParams.set('alternatives', 'true');
  url.searchParams.set('key', GOOGLE_KEY);

  for (let attempt = 0; attempt < DIRECTIONS_ATTEMPTS; attempt += 1) {
    if (!(await chargeGoogleCall('directions'))) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DIRECTIONS_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), { signal: controller.signal });
      const data = (await response.json()) as {
        status?: string;
        routes?: Array<{
          overview_polyline?: { points?: string };
          legs?: Array<{ distance?: { value?: number } }>;
        }>;
      };

      if (data.status !== 'OK' || !data.routes?.length) {
        // ZERO_RESULTS is a real answer — there is no road route — and retrying
        // will not change it. Only transient statuses are worth a second go.
        if (data.status === 'ZERO_RESULTS' || data.status === 'NOT_FOUND') return null;
        continue;
      }

      const paths = data.routes
        .map((r) => (r.overview_polyline?.points ? decodePolyline(r.overview_polyline.points) : []))
        .filter((p) => p.length > 1);

      if (paths.length === 0) return null;

      const metres = data.routes[0].legs?.reduce(
        (sum, leg) => sum + (leg.distance?.value ?? 0),
        0
      );

      const route: ExpectedRoute = {
        paths,
        distanceKm:
          metres && metres > 0
            ? Math.round((metres / 1000) * 10) / 10
            : Math.round(pathLengthKm(paths[0]) * 10) / 10,
        source: 'directions_api',
        reference: key,
      };

      await storeRoute(key, route).catch(() => undefined);
      return route;
    } catch (error) {
      // Timeout or network fault — worth one more attempt, then give up and
      // let the trip be recorded as unknown.
      if (attempt === DIRECTIONS_ATTEMPTS - 1) {
        console.warn('[directions] lookup failed:', (error as Error).message);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}
