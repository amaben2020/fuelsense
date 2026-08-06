// Did the vehicle drive roughly where it should have?
//
// The naive version of this — compare total driven kilometres against total
// expected kilometres — is worse than useless. A driver who goes 12 km the
// wrong way and comes back matches the expected distance almost exactly, and a
// driver who takes a slightly longer but entirely legitimate road gets accused.
// Distance alone cannot tell those apart because it throws away *where*.
//
// So the comparison is geometric: buffer the expected path into a corridor and
// ask how much of the actual trip fell outside it, how far outside, and for how
// long continuously. A two-minute dip out to pass a stalled lorry and twenty
// unbroken minutes in another district produce very different numbers, which is
// the distinction a fleet manager actually cares about.
//
// Everything here is pure. No database, no HTTP — the thresholds and the
// wording can be tested without either.

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** A position fix from the trip, with when it was taken. */
export interface TrackedFix extends GeoPoint {
  at: Date;
}

const METRES_PER_DEG_LAT = 111_320;

/** Metres between two coordinates (equirectangular — exact enough at corridor scale). */
export function metresBetween(a: GeoPoint, b: GeoPoint): number {
  const mPerDegLng = METRES_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * METRES_PER_DEG_LAT, (b.lng - a.lng) * mPerDegLng);
}

/** Perpendicular distance in metres from p to the segment a-b. */
export function distanceToSegmentM(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const refLat = (a.lat * Math.PI) / 180;
  const mPerDegLng = METRES_PER_DEG_LAT * Math.cos(refLat);

  const ax = a.lng * mPerDegLng;
  const ay = a.lat * METRES_PER_DEG_LAT;
  const bx = b.lng * mPerDegLng;
  const by = b.lat * METRES_PER_DEG_LAT;
  const px = p.lng * mPerDegLng;
  const py = p.lat * METRES_PER_DEG_LAT;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Distance from a point to the nearest part of a path.
 *
 * This is the corridor test: a corridor is just "everywhere within N metres of
 * the path", so a point is inside when this returns less than the width. Doing
 * it this way avoids constructing an actual buffer polygon, which for a
 * self-crossing urban route is fiddly to build and no more accurate.
 */
export function distanceToPathM(point: GeoPoint, path: GeoPoint[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return metresBetween(point, path[0]);

  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < path.length; i += 1) {
    const d = distanceToSegmentM(point, path[i - 1], path[i]);
    if (d < nearest) nearest = d;
    if (nearest === 0) break;
  }
  return nearest;
}

/** Total length of a path in kilometres. */
export function pathLengthKm(path: GeoPoint[]): number {
  let metres = 0;
  for (let i = 1; i < path.length; i += 1) metres += metresBetween(path[i - 1], path[i]);
  return metres / 1000;
}

export interface CorridorStats {
  fixes_total: number;
  fixes_outside: number;
  pct_fixes_outside_corridor: number;
  /** Furthest any fix strayed from the corridor edge, not from the path. */
  max_deviation_distance_m: number;
  /** Longest unbroken stretch off-corridor, in seconds. */
  contiguous_outside_seconds: number;
  /** Largest gap between consecutive fixes — a dead zone the corridor cannot see into. */
  largest_gap_seconds: number;
}

/**
 * How far the actual trip strayed from the corridor.
 *
 * A gap in the fixes is deliberately not treated as time spent on-corridor:
 * `largest_gap_seconds` is reported so the caller can lower confidence rather
 * than let a tunnel or a dead zone silently vouch for the driver.
 */
export function corridorStats(
  fixes: TrackedFix[],
  path: GeoPoint[],
  corridorWidthM: number
): CorridorStats {
  const stats: CorridorStats = {
    fixes_total: fixes.length,
    fixes_outside: 0,
    pct_fixes_outside_corridor: 0,
    max_deviation_distance_m: 0,
    contiguous_outside_seconds: 0,
    largest_gap_seconds: 0,
  };

  if (fixes.length === 0 || path.length === 0) return stats;

  let runStart: Date | null = null;

  for (let i = 0; i < fixes.length; i += 1) {
    const fix = fixes[i];
    const distance = distanceToPathM(fix, path);
    const outside = distance > corridorWidthM;

    if (i > 0) {
      const gap = (fix.at.getTime() - fixes[i - 1].at.getTime()) / 1000;
      if (gap > stats.largest_gap_seconds) stats.largest_gap_seconds = Math.round(gap);
    }

    if (outside) {
      stats.fixes_outside += 1;
      // Measured from the corridor edge: 50 m past a 400 m corridor is a
      // 50 m deviation, not a 450 m one.
      const beyond = distance - corridorWidthM;
      if (beyond > stats.max_deviation_distance_m) {
        stats.max_deviation_distance_m = Math.round(beyond);
      }
      runStart = runStart ?? fix.at;
    } else if (runStart) {
      const run = (fix.at.getTime() - runStart.getTime()) / 1000;
      if (run > stats.contiguous_outside_seconds) {
        stats.contiguous_outside_seconds = Math.round(run);
      }
      runStart = null;
    }
  }

  // A trip that ended while still off-corridor never closes its run above.
  if (runStart) {
    const run = (fixes[fixes.length - 1].at.getTime() - runStart.getTime()) / 1000;
    if (run > stats.contiguous_outside_seconds) {
      stats.contiguous_outside_seconds = Math.round(run);
    }
  }

  stats.pct_fixes_outside_corridor =
    Math.round((stats.fixes_outside / stats.fixes_total) * 1000) / 10;

  return stats;
}

/**
 * Match against every candidate path and keep the kindest result.
 *
 * Real road networks offer two or three reasonable ways to the same place, and
 * the routing API returns one of them as "best". Treating that single answer as
 * the only acceptable route would flag drivers for taking the other arterial —
 * a false accusation, and the fastest way to lose a manager's trust in the
 * whole feature. A trip passes if it matches any alternative.
 */
export function bestCorridorMatch(
  fixes: TrackedFix[],
  candidatePaths: GeoPoint[][],
  corridorWidthM: number
): { stats: CorridorStats; pathIndex: number } {
  let best: { stats: CorridorStats; pathIndex: number } | null = null;

  candidatePaths.forEach((path, pathIndex) => {
    const stats = corridorStats(fixes, path, corridorWidthM);
    if (
      !best ||
      stats.pct_fixes_outside_corridor < best.stats.pct_fixes_outside_corridor ||
      (stats.pct_fixes_outside_corridor === best.stats.pct_fixes_outside_corridor &&
        stats.max_deviation_distance_m < best.stats.max_deviation_distance_m)
    ) {
      best = { stats, pathIndex };
    }
  });

  return best ?? { stats: corridorStats(fixes, [], corridorWidthM), pathIndex: -1 };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type RouteVerdict = 'on_route' | 'deviated' | 'inconclusive' | 'unknown';

export interface RouteThresholds {
  /** Corridor half-width. Wide enough to absorb GPS drift and lane choice. */
  corridorWidthM: number;
  /** Below this the trip is too short for the corridor to mean anything. */
  minTripKm: number;
  /** Share of fixes off-corridor before a trip can be called deviated. */
  deviatedPctFixes: number;
  /** How far past the corridor edge counts as going somewhere else. */
  deviatedDeviationM: number;
  /** Unbroken time off-corridor before it stops looking incidental. */
  deviatedContiguousSeconds: number;
  /** A reporting gap longer than this leaves too much of the trip unseen. */
  maxGapSeconds: number;
  /** Fewer fixes than this and there is nothing to match against. */
  minFixes: number;
}

/**
 * Defaults tuned for mixed urban work. Per-vehicle overrides exist because a
 * tight delivery round through Mararaba and a highway haul to Kaduna do not
 * share a definition of "meaningful deviation".
 */
export const DEFAULT_ROUTE_THRESHOLDS: RouteThresholds = {
  corridorWidthM: 400,
  minTripKm: 2,
  deviatedPctFixes: 15,
  deviatedDeviationM: 750,
  deviatedContiguousSeconds: 300,
  maxGapSeconds: 15 * 60,
  minFixes: 10,
};

export interface RouteVerdictInput {
  stats: CorridorStats;
  actualDistanceKm: number;
  expectedDistanceKm: number | null;
  /** False when no expected path could be established at all. */
  hasExpectedPath: boolean;
  /** Litres per 100 km for this vehicle, for costing the extra distance. */
  consumptionL100km: number | null;
  /** Naira per litre, or null when no receipt has ever established a price. */
  pricePerLiter: number | null;
  thresholds?: Partial<RouteThresholds>;
}

export interface RouteAssessment {
  verdict: RouteVerdict;
  summary: string;
  reasons: string[];
  detour_km: number | null;
  extra_liters: number | null;
  extra_cost_naira: number | null;
  stats: CorridorStats;
  thresholds: RouteThresholds;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Rule on one trip. Pure: same inputs, same verdict, no clock and no network.
 *
 * The tone is deliberate. A deviation is reported with its cost and its
 * evidence and nothing more — no attempt is made to infer intent from GPS. A
 * road closure, a traffic reroute and a personal errand all look identical from
 * here, and a system that guesses between them will eventually accuse an honest
 * driver. That judgement belongs to the manager who can ask.
 */
export function assessRoute(input: RouteVerdictInput): RouteAssessment {
  const thresholds: RouteThresholds = { ...DEFAULT_ROUTE_THRESHOLDS, ...input.thresholds };
  const { stats } = input;
  const reasons: string[] = [];

  const detourKm =
    input.expectedDistanceKm != null
      ? round1(input.actualDistanceKm - input.expectedDistanceKm)
      : null;

  const extraLiters =
    detourKm != null && detourKm > 0 && input.consumptionL100km != null
      ? round1((detourKm * input.consumptionL100km) / 100)
      : detourKm != null && detourKm > 0
        ? null
        : 0;

  const extraCost =
    extraLiters != null && extraLiters > 0 && input.pricePerLiter != null
      ? Math.round(extraLiters * input.pricePerLiter)
      : extraLiters === 0
        ? 0
        : null;

  const base = {
    detour_km: detourKm,
    extra_liters: extraLiters,
    extra_cost_naira: extraCost,
    stats,
    thresholds,
  };

  // --- Cases where no honest call can be made -----------------------------

  if (!input.hasExpectedPath) {
    return {
      ...base,
      verdict: 'unknown',
      reasons: ['No assigned route, and no reference path could be obtained for this trip.'],
      summary: 'Not checked — there is nothing to compare this trip against.',
    };
  }

  if (stats.fixes_total < thresholds.minFixes) {
    return {
      ...base,
      verdict: 'unknown',
      reasons: [`Only ${stats.fixes_total} position fixes for the whole trip.`],
      summary: 'Not checked — too few position fixes to match against a route.',
    };
  }

  if (stats.largest_gap_seconds > thresholds.maxGapSeconds) {
    return {
      ...base,
      verdict: 'unknown',
      reasons: [
        `The tracker went quiet for ${Math.round(stats.largest_gap_seconds / 60)} minutes during this trip, so part of the route was never observed.`,
      ],
      summary: 'Not checked — a reporting gap left too much of the trip unseen.',
    };
  }

  if (input.actualDistanceKm < thresholds.minTripKm) {
    return {
      ...base,
      verdict: 'inconclusive',
      reasons: [
        `The trip covered ${round1(input.actualDistanceKm)} km, below the ${thresholds.minTripKm} km floor where GPS noise stops dominating the comparison.`,
      ],
      summary: 'Too short to judge — GPS scatter alone would decide the answer.',
    };
  }

  // --- The actual comparison ---------------------------------------------

  const wentSomewhereElse =
    stats.pct_fixes_outside_corridor >= thresholds.deviatedPctFixes &&
    (stats.max_deviation_distance_m >= thresholds.deviatedDeviationM ||
      stats.contiguous_outside_seconds >= thresholds.deviatedContiguousSeconds);

  // A trip that covered no more ground than the reference route cost the fleet
  // nothing, however far it strayed from the line Google drew. Nigerian road
  // networks offer several reasonable ways to the same place, and the API
  // returns one of them; calling the others "detours" bills a manager's
  // attention for a driver who did nothing wrong. Observed on this fleet: four
  // 30 km runs matched at 38-72% off-corridor while finishing 1-2 km SHORTER
  // than the reference. Real deviation costs distance — that is the signal.
  const costlessAlternate =
    wentSomewhereElse && detourKm != null && detourKm <= 0;

  if (costlessAlternate) {
    return {
      ...base,
      verdict: 'inconclusive',
      reasons: [
        `${stats.pct_fixes_outside_corridor}% of fixes were off the reference route, but the trip covered ${round1(input.actualDistanceKm)} km against an expected ${round1(input.expectedDistanceKm ?? 0)} km.`,
        'Driving no further than planned means no fuel was lost, whichever road was taken.',
      ],
      summary: 'Took a different road, no further than the expected route — nothing lost.',
    };
  }

  if (wentSomewhereElse) {
    reasons.push(
      `${stats.pct_fixes_outside_corridor}% of position fixes fell outside the ${thresholds.corridorWidthM} m corridor around the expected route.`
    );
    if (stats.max_deviation_distance_m > 0) {
      reasons.push(
        `The vehicle reached ${(stats.max_deviation_distance_m / 1000).toFixed(1)} km beyond the corridor at its furthest.`
      );
    }
    if (stats.contiguous_outside_seconds > 0) {
      reasons.push(
        `It stayed off the expected route for ${Math.round(stats.contiguous_outside_seconds / 60)} minutes without returning.`
      );
    }
    if (detourKm != null && detourKm > 0) {
      reasons.push(
        `That is ${detourKm} km more than the expected route${
          extraLiters ? `, about ${extraLiters} L of fuel` : ''
        }${extraCost ? ` (₦${extraCost.toLocaleString('en-NG')})` : ''}.`
      );
    }

    return {
      ...base,
      verdict: 'deviated',
      reasons,
      summary:
        detourKm != null && detourKm > 0
          ? `Off the expected route, ${detourKm} km further than planned. Worth asking about — a closure or a reroute looks identical to this from GPS alone.`
          : 'Off the expected route, though the total distance is unchanged. Worth asking about.',
    };
  }

  if (stats.fixes_outside > 0) {
    return {
      ...base,
      verdict: 'inconclusive',
      reasons: [
        `${stats.pct_fixes_outside_corridor}% of fixes strayed outside the corridor, peaking ${stats.max_deviation_distance_m} m past its edge for ${Math.round(stats.contiguous_outside_seconds / 60)} minutes — under the threshold for a confident call.`,
      ],
      summary: 'Mostly on route, with brief excursions too small to call a detour.',
    };
  }

  return {
    ...base,
    verdict: 'on_route',
    reasons: ['Every position fix fell inside the expected corridor.'],
    summary: 'On route the whole way.',
  };
}
