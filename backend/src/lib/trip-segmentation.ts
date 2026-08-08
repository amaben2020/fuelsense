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
  kind: 'origin' | 'stop' | 'pause' | 'traffic' | 'destination';
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
  /** 0-100. How much weight the fuel figure for this trip can carry. */
  confidence: number;
  /** Plain-language reasons the score is not higher. */
  confidence_notes: string[];
}

// Never 100. Fuel here is modelled from movement, not measured from a tank,
// so a perfect score would be a promise the hardware cannot keep.
const CONFIDENCE_CEILING = 99;
const CONFIDENCE_FLOOR = 35;

// Above this share of the trip spent stationary with the engine running, the
// distance-derived part of the estimate is covering less and less of the fuel
// actually burned.
const IDLE_SHARE_TOLERANCE = 0.2;
const IDLE_PENALTY_MAX = 32;

// A gap this long between fixes means both distance and burn across it are
// interpolated rather than observed.
const GAP_TOLERANCE_S = 300;
const GAP_PENALTY_MAX = 26;

// Fewer fixes than this per minute and the shape of the trip is a guess.
const SPARSE_POINTS_PER_MIN = 0.5;
const SPARSE_PENALTY_MAX = 18;

export interface ConfidenceInput {
  durationMinutes: number;
  idleMinutes: number;
  points: number;
  longestGapSeconds: number;
  distanceKm: number;
}

/**
 * How much the fuel figure for a trip can be leaned on.
 *
 * Three things erode it, and each is something the FMC150's own data reveals:
 *
 *  1. Idling. Ignition on with movement off is the case the model handles
 *     worst, because GNSS registers no distance while the engine keeps
 *     burning. Three hours crawling in Lagos traffic is mostly this.
 *  2. Reporting gaps. Anything the tracker did not send is interpolated.
 *  3. Sparse fixes. Too few points and the route itself is approximate.
 *
 * The score is deliberately explainable: every deduction comes back as a note
 * a fleet manager can read, so a low number prompts a question rather than
 * suspicion of the software.
 */
export function tripConfidence(input: ConfidenceInput): {
  score: number;
  notes: string[];
} {
  const notes: string[] = [];
  let score = CONFIDENCE_CEILING;

  const duration = Math.max(input.durationMinutes, 1);
  const idleShare = Math.min(1, input.idleMinutes / duration);
  if (idleShare > IDLE_SHARE_TOLERANCE) {
    const over = (idleShare - IDLE_SHARE_TOLERANCE) / (1 - IDLE_SHARE_TOLERANCE);
    score -= Math.round(over * IDLE_PENALTY_MAX);
    notes.push(
      `${Math.round(idleShare * 100)}% of this trip was spent stationary with the engine ` +
        'running, where fuel burns but no distance is recorded.'
    );
  }

  if (input.longestGapSeconds > GAP_TOLERANCE_S) {
    const gapShare = Math.min(1, input.longestGapSeconds / (duration * 60));
    score -= Math.round(gapShare * GAP_PENALTY_MAX);
    notes.push(
      `The tracker went quiet for ${Math.round(input.longestGapSeconds / 60)} minutes, so that ` +
        'stretch is estimated rather than observed.'
    );
  }

  const density = input.points / duration;
  if (density < SPARSE_POINTS_PER_MIN) {
    const shortfall = 1 - density / SPARSE_POINTS_PER_MIN;
    score -= Math.round(shortfall * SPARSE_PENALTY_MAX);
    notes.push('Few position fixes for the length of this trip, so the route is approximate.');
  }

  return {
    score: Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEILING, score)),
    notes,
  };
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

// A halt only counts as parked once it lasts this long. Anything shorter is a
// pause, not a visit — the driver did not get out and do anything.
const MIN_STOP_MINUTES = 5;
// Below the stop threshold but long enough that the driver remembers it. These
// are reported as 'pause' rather than dropped: silently discarding a halt the
// driver knows happened makes the whole trail look wrong to them.
const MIN_PAUSE_MINUTES = 1.5;
// Crawling, not halted: the engine is on and the vehicle is moving, just barely.
// Sustained long enough it is congestion, which explains both the lost time and
// the fuel burned — and it is not the driver's fault, so it is labelled as
// traffic rather than counted against them.
const TRAFFIC_MAX_KPH = 15;
const MIN_TRAFFIC_MINUTES = 5;
// How close two fixes must be to count as "did not move" across a long gap.
const STATIONARY_GAP_M = 120;
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
      if (mins >= MIN_PAUSE_MINUTES) {
        stops.push({
          ...centroid(run),
          arrived_at: run[0].recordedAt.toISOString(),
          departed_at: run[run.length - 1].recordedAt.toISOString(),
          duration_minutes: Math.round(mins),
          kind: mins >= MIN_STOP_MINUTES ? 'stop' : 'pause',
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

  // Congestion: moving, but at a crawl, with the engine on. Detected separately
  // from halts because the vehicle never stops — a run of slow fixes would
  // otherwise read as normal driving and the lost time would go unexplained.
  let crawl: TelemetryTripPoint[] = [];
  const flushCrawl = () => {
    if (crawl.length >= 2) {
      const mins =
        (crawl[crawl.length - 1].recordedAt.getTime() - crawl[0].recordedAt.getTime()) / 60000;
      if (mins >= MIN_TRAFFIC_MINUTES) {
        stops.push({
          ...centroid(crawl),
          arrived_at: crawl[0].recordedAt.toISOString(),
          departed_at: crawl[crawl.length - 1].recordedAt.toISOString(),
          duration_minutes: Math.round(mins),
          kind: 'traffic',
        });
      }
    }
    crawl = [];
  };

  for (let i = 1; i < segment.length - 1; i++) {
    const p = segment[i];
    const speed = p.speedKph ?? 0;
    const crawling = speed >= STOPPED_KPH && speed < TRAFFIC_MAX_KPH && p.ignitionOn !== false;
    if (crawling) crawl.push(p);
    else flushCrawl();
  }
  flushCrawl();

  // Sparse-data fallback. Trackers throttle to occasional heartbeats once the
  // engine is off, so a real stop can produce too few points to form a run —
  // a shop or market visit would vanish entirely. Two consecutive fixes far
  // apart in time but not in space describe exactly that: the vehicle sat there.
  for (let i = 1; i < segment.length; i++) {
    const a = segment[i - 1];
    const b = segment[i];
    const mins = (b.recordedAt.getTime() - a.recordedAt.getTime()) / 60000;
    if (mins < MIN_STOP_MINUTES) continue;
    if (haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000 > STATIONARY_GAP_M) continue;

    // Don't duplicate a stop the run-based pass already reported.
    const already = stops.some(
      (s) =>
        Math.abs(new Date(s.arrived_at).getTime() - a.recordedAt.getTime()) < 60_000 ||
        Math.abs(new Date(s.departed_at).getTime() - b.recordedAt.getTime()) < 60_000
    );
    if (already) continue;

    stops.push({
      ...centroid([a, b]),
      arrived_at: a.recordedAt.toISOString(),
      departed_at: b.recordedAt.toISOString(),
      duration_minutes: Math.round(mins),
      kind: 'stop',
    });
  }

  stops.sort((x, y) => new Date(x.arrived_at).getTime() - new Date(y.arrived_at).getTime());

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
  let longestGapSeconds = 0;
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
    if (gapS > longestGapSeconds) longestGapSeconds = gapS;
    if (b.speedKph != null && b.speedKph > maxSpeed) maxSpeed = b.speedKph;
    if (b.ignitionOn === true && (b.speedKph ?? 0) < 2) {
      idleSeconds += Math.min(gapS, IDLE_HOP_CAP_S);
    }
  }
  if (distanceKm < MIN_TRIP_KM) return null;

  const startMs = segment[0].recordedAt.getTime();
  const endMs = segment[segment.length - 1].recordedAt.getTime();
  const durationMin = (endMs - startMs) / 60000;

  const { score, notes } = tripConfidence({
    durationMinutes: durationMin,
    idleMinutes: idleSeconds / 60,
    points: segment.length,
    longestGapSeconds,
    distanceKm,
  });

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
    confidence: score,
    confidence_notes: notes,
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
