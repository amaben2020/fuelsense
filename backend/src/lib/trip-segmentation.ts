/**
 * Server-side trip segmentation for GPS telemetry.
 *
 * A trip ends when the vehicle sits with the ignition off — or the tracker
 * goes silent — for TRIP_BREAK_MS. Paths are simplified with Douglas-Peucker
 * so a 4-hour trip ships as a few hundred points instead of thousands.
 */

export const TRIP_BREAK_MS = 30 * 60 * 1000;
const MIN_TRIP_KM = 0.3;
// A hop is judged by the speed it implies, not by raw length. A flat length cap
// silently ate real distance whenever the tracker lost signal (tunnel, dead
// zone) and the vehicle covered kilometres between fixes; implied speed accepts
// that hop while still rejecting the instant teleports that GPS glitches make.
const MAX_PLAUSIBLE_KPH = 200;
const MAX_HOP_KM = 50; // absolute ceiling — beyond this it is not one drive hop
// Sub-10 m wander reported while the vehicle is stopped is receiver noise, not
// travel. Left in, it accumulates phantom kilometres over long idles.
const JITTER_HOP_M = 10;
const STOPPED_KPH = 3;
const IDLE_HOP_CAP_S = 600;
const SIMPLIFY_TOLERANCE_M = 15;
const MAX_PATH_POINTS = 300;

export interface TelemetryTripPoint {
  lat: number;
  lng: number;
  speedKph: number | null;
  ignitionOn: boolean | null;
  recordedAt: Date;
}

/** Somewhere the vehicle actually sat still long enough to be worth asking
 *  the driver about. Address/place details are attached later by place-lookup. */
export interface TripStop {
  lat: number;
  lng: number;
  arrived_at: string;
  departed_at: string;
  duration_minutes: number;
  /** 'origin' and 'destination' bookend the trip; 'stop' is a mid-trip halt. */
  kind: 'origin' | 'stop' | 'destination';
}

export interface Trip {
  start_at: string;
  end_at: string;
  duration_minutes: number;
  distance_km: number;
  avg_speed_kph: number;
  max_speed_kph: number;
  idle_minutes: number;
  active: boolean;
  path: [number, number][];
  stops: TripStop[];
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Perpendicular distance (metres) from p to segment a-b, equirectangular approx. */
function perpendicularDistanceM(
  p: TelemetryTripPoint,
  a: TelemetryTripPoint,
  b: TelemetryTripPoint
): number {
  const refLat = (a.lat * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(refLat);
  const ax = a.lng * mPerDegLng;
  const ay = a.lat * mPerDegLat;
  const bx = b.lng * mPerDegLng;
  const by = b.lat * mPerDegLat;
  const px = p.lng * mPerDegLng;
  const py = p.lat * mPerDegLat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Iterative Douglas-Peucker (stack-based — long trips would blow recursion). */
function douglasPeucker(points: TelemetryTripPoint[], toleranceM: number): TelemetryTripPoint[] {
  if (points.length <= 2) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistanceM(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceM && maxIdx !== -1) {
      keep[maxIdx] = true;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function downsamplePath(points: TelemetryTripPoint[]): [number, number][] {
  let simplified = douglasPeucker(points, SIMPLIFY_TOLERANCE_M);
  if (simplified.length > MAX_PATH_POINTS) {
    const stride = Math.ceil(simplified.length / MAX_PATH_POINTS);
    const strided = simplified.filter((_, i) => i % stride === 0);
    if (strided[strided.length - 1] !== simplified[simplified.length - 1]) {
      strided.push(simplified[simplified.length - 1]);
    }
    simplified = strided;
  }
  return simplified.map((p) => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);
}

const isActive = (p: TelemetryTripPoint) =>
  p.ignitionOn === true || (p.speedKph != null && p.speedKph > 0);

// A halt only counts as a stop once it lasts this long — shorter pauses are
// traffic lights and junctions, which would bury the real visits in noise.
const MIN_STOP_MINUTES = 3;
// Points inside one halt wander a little; average them so the pin lands on the
// place rather than on whichever fix happened to be last.
function centroid(points: TelemetryTripPoint[]): { lat: number; lng: number } {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

function findStops(segment: TelemetryTripPoint[]): TripStop[] {
  const stops: TripStop[] = [];
  const first = segment[0];
  const last = segment[segment.length - 1];

  stops.push({
    ...centroid([first]),
    arrived_at: first.recordedAt.toISOString(),
    departed_at: first.recordedAt.toISOString(),
    duration_minutes: 0,
    kind: 'origin',
  });

  let run: TelemetryTripPoint[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const mins =
        (run[run.length - 1].recordedAt.getTime() - run[0].recordedAt.getTime()) / 60000;
      if (mins >= MIN_STOP_MINUTES) {
        stops.push({
          ...centroid(run),
          arrived_at: run[0].recordedAt.toISOString(),
          departed_at: run[run.length - 1].recordedAt.toISOString(),
          duration_minutes: Math.round(mins),
          kind: 'stop',
        });
      }
    }
    run = [];
  };

  // Skip the bookends — they are already reported as origin/destination
  for (let i = 1; i < segment.length - 1; i++) {
    const p = segment[i];
    if ((p.speedKph ?? 0) < STOPPED_KPH) run.push(p);
    else flush();
  }
  flush();

  stops.push({
    ...centroid([last]),
    arrived_at: last.recordedAt.toISOString(),
    departed_at: last.recordedAt.toISOString(),
    duration_minutes: 0,
    kind: 'destination',
  });

  return stops;
}

function buildTrip(segment: TelemetryTripPoint[], nowMs: number): Trip | null {
  if (segment.length < 2) return null;

  let distanceKm = 0;
  let maxSpeed = 0;
  let idleSeconds = 0;
  for (let i = 1; i < segment.length; i++) {
    const a = segment[i - 1];
    const b = segment[i];
    const hop = haversineKm(a.lat, a.lng, b.lat, b.lng);
    const gapS = (b.recordedAt.getTime() - a.recordedAt.getTime()) / 1000;
    const impliedKph = gapS > 0 ? (hop / gapS) * 3600 : Infinity;
    const stopped = (a.speedKph ?? 0) < STOPPED_KPH && (b.speedKph ?? 0) < STOPPED_KPH;
    const isJitter = stopped && hop * 1000 < JITTER_HOP_M;

    if (!isJitter && hop <= MAX_HOP_KM && impliedKph <= MAX_PLAUSIBLE_KPH) {
      distanceKm += hop;
    }
    if (b.speedKph != null && b.speedKph > maxSpeed) maxSpeed = b.speedKph;
    if (b.ignitionOn === true && (b.speedKph ?? 0) < 2) {
      idleSeconds += Math.min(gapS, IDLE_HOP_CAP_S);
    }
  }
  if (distanceKm < MIN_TRIP_KM) return null;

  const startMs = segment[0].recordedAt.getTime();
  const endMs = segment[segment.length - 1].recordedAt.getTime();
  const durationMin = (endMs - startMs) / 60000;

  return {
    start_at: segment[0].recordedAt.toISOString(),
    end_at: segment[segment.length - 1].recordedAt.toISOString(),
    duration_minutes: Math.round(durationMin),
    distance_km: Math.round(distanceKm * 10) / 10,
    avg_speed_kph: durationMin > 0 ? Math.round(distanceKm / (durationMin / 60)) : 0,
    max_speed_kph: Math.round(maxSpeed),
    idle_minutes: Math.round(idleSeconds / 60),
    active: nowMs - endMs < TRIP_BREAK_MS,
    path: downsamplePath(segment),
    stops: findStops(segment),
  };
}

/** Points must be chronologically ordered for a single vehicle. */
export function segmentTrips(points: TelemetryTripPoint[], nowMs = Date.now()): Trip[] {
  const trips: Trip[] = [];
  let segment: TelemetryTripPoint[] = [];
  let lastActiveAt: number | null = null;

  const close = () => {
    const trip = buildTrip(segment, nowMs);
    if (trip) trips.push(trip);
    segment = [];
    lastActiveAt = null;
  };

  for (const pt of points) {
    const t = pt.recordedAt.getTime();

    if (segment.length > 0) {
      const prevT = segment[segment.length - 1].recordedAt.getTime();
      const inactiveFor = lastActiveAt != null ? t - lastActiveAt : 0;
      if (t - prevT >= TRIP_BREAK_MS || inactiveFor >= TRIP_BREAK_MS) close();
    }

    if (segment.length === 0) {
      if (!isActive(pt)) continue; // trips start when the vehicle wakes up
      lastActiveAt = t;
      segment.push(pt);
      continue;
    }

    segment.push(pt);
    if (isActive(pt)) lastActiveAt = t;
  }
  close();

  return trips;
}
