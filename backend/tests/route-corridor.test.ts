import { describe, it, expect } from '@jest/globals'
import {
  assessRoute,
  bestCorridorMatch,
  corridorStats,
  distanceToPathM,
  metresBetween,
  pathLengthKm,
  type GeoPoint,
  type TrackedFix,
} from '../src/lib/route-corridor'

// A straight east-west run along the Keffi–Abuja expressway, roughly.
const START: GeoPoint = { lat: 8.99, lng: 7.61 }
const along = (metresEast: number): GeoPoint => ({
  lat: START.lat,
  lng: START.lng + metresEast / (111_320 * Math.cos((START.lat * Math.PI) / 180)),
})
const north = (point: GeoPoint, metres: number): GeoPoint => ({
  lat: point.lat + metres / 111_320,
  lng: point.lng,
})

const EXPECTED_PATH: GeoPoint[] = [along(0), along(5000), along(10_000)]

const at = (minute: number): Date => new Date(`2026-08-06T09:${String(minute).padStart(2, '0')}:00Z`)

/** Fixes marching east along the expected path, one per minute. */
const onRouteFixes = (count = 20): TrackedFix[] =>
  Array.from({ length: count }, (_, i) => ({ ...along((10_000 / count) * i), at: at(i) }))

describe('geometry', () => {
  it('measures metres between coordinates', () => {
    expect(metresBetween(START, along(1000))).toBeGreaterThan(990)
    expect(metresBetween(START, along(1000))).toBeLessThan(1010)
  })

  it('measures distance to the nearest part of a path, not its endpoints', () => {
    // A point beside the middle of the path is close to it, though far from both ends.
    const beside = north(along(5000), 120)
    expect(distanceToPathM(beside, EXPECTED_PATH)).toBeGreaterThan(110)
    expect(distanceToPathM(beside, EXPECTED_PATH)).toBeLessThan(130)
  })

  it('sums path length', () => {
    expect(pathLengthKm(EXPECTED_PATH)).toBeCloseTo(10, 1)
  })
})

describe('corridorStats', () => {
  it('reports nothing outside for a trip that followed the route', () => {
    const stats = corridorStats(onRouteFixes(), EXPECTED_PATH, 400)
    expect(stats.fixes_outside).toBe(0)
    expect(stats.pct_fixes_outside_corridor).toBe(0)
    expect(stats.max_deviation_distance_m).toBe(0)
  })

  it('measures deviation from the corridor edge, not from the path', () => {
    const fixes = [...onRouteFixes(10)]
    fixes[5] = { ...north(along(5000), 1000), at: at(5) }
    const stats = corridorStats(fixes, EXPECTED_PATH, 400)
    // 1000 m from the path is 600 m beyond a 400 m corridor.
    expect(stats.max_deviation_distance_m).toBeGreaterThan(560)
    expect(stats.max_deviation_distance_m).toBeLessThan(640)
  })

  it('tracks the longest unbroken stretch off-corridor', () => {
    const fixes: TrackedFix[] = [
      { ...along(0), at: at(0) },
      { ...north(along(2000), 2000), at: at(2) },
      { ...north(along(2000), 2000), at: at(9) },
      { ...along(4000), at: at(10) },
      { ...north(along(6000), 2000), at: at(12) },
      { ...along(8000), at: at(13) },
    ]
    const stats = corridorStats(fixes, EXPECTED_PATH, 400)
    // The first excursion ran 09:02 → 09:10, the second only 09:12 → 09:13.
    expect(stats.contiguous_outside_seconds).toBe(8 * 60)
  })

  it('reports the largest reporting gap so a dead zone cannot vouch for the driver', () => {
    const fixes: TrackedFix[] = [
      { ...along(0), at: at(0) },
      { ...along(5000), at: at(25) },
      { ...along(10_000), at: at(26) },
    ]
    expect(corridorStats(fixes, EXPECTED_PATH, 400).largest_gap_seconds).toBe(25 * 60)
  })
})

describe('bestCorridorMatch', () => {
  it('passes a trip that matches any returned alternative', () => {
    // The driver took a parallel road 2 km north — the API's second choice.
    const alternative: GeoPoint[] = EXPECTED_PATH.map((p) => north(p, 2000))
    const fixes = onRouteFixes(12).map((f) => ({ ...north(f, 2000), at: f.at }))

    const match = bestCorridorMatch(fixes, [EXPECTED_PATH, alternative], 400)
    expect(match.pathIndex).toBe(1)
    expect(match.stats.fixes_outside).toBe(0)
  })
})

describe('assessRoute', () => {
  const base = {
    actualDistanceKm: 12,
    expectedDistanceKm: 10,
    hasExpectedPath: true,
    consumptionL100km: 12,
    pricePerLiter: 1300,
  }

  it('calls a trip on route when every fix is inside the corridor', () => {
    const result = assessRoute({
      ...base,
      actualDistanceKm: 10,
      stats: corridorStats(onRouteFixes(), EXPECTED_PATH, 400),
    })
    expect(result.verdict).toBe('on_route')
    expect(result.extra_cost_naira).toBe(0)
  })

  it('flags a sustained excursion and prices the extra distance', () => {
    const fixes: TrackedFix[] = [
      ...onRouteFixes(6),
      ...Array.from({ length: 8 }, (_, i) => ({
        ...north(along(6000), 3000),
        at: at(10 + i),
      })),
      ...Array.from({ length: 6 }, (_, i) => ({ ...along(7000 + i * 500), at: at(20 + i) })),
    ]

    const result = assessRoute({
      ...base,
      stats: corridorStats(fixes, EXPECTED_PATH, 400),
    })

    expect(result.verdict).toBe('deviated')
    expect(result.detour_km).toBe(2)
    // 2 km at 12 L/100km = 0.24 L, at ₦1300 = ₦312. The litre figure is rounded
    // for display only; the price is taken from the unrounded 0.24 L, so this
    // must be ₦312 and not the ₦260 that pricing a display-rounded 0.2 L gives.
    expect(result.extra_liters).toBe(0.2)
    expect(result.extra_cost_naira).toBe(312)
    expect(result.summary).toContain('closure or a reroute')
  })

  it('returns unknown when no expected path could be established', () => {
    const result = assessRoute({
      ...base,
      hasExpectedPath: false,
      expectedDistanceKm: null,
      stats: corridorStats(onRouteFixes(), [], 400),
    })
    expect(result.verdict).toBe('unknown')
    expect(result.summary).toContain('nothing to compare')
  })

  it('returns unknown when the tracker went quiet mid-trip', () => {
    const fixes: TrackedFix[] = [
      ...onRouteFixes(10),
      { ...along(10_000), at: at(45) },
    ]
    const result = assessRoute({ ...base, stats: corridorStats(fixes, EXPECTED_PATH, 400) })
    expect(result.verdict).toBe('unknown')
    expect(result.summary).toContain('reporting gap')
  })

  it('returns unknown when there are barely any fixes', () => {
    const result = assessRoute({
      ...base,
      stats: corridorStats(onRouteFixes(4), EXPECTED_PATH, 400),
    })
    expect(result.verdict).toBe('unknown')
  })

  it('refuses to judge a very short trip', () => {
    const result = assessRoute({
      ...base,
      actualDistanceKm: 1.2,
      expectedDistanceKm: 1,
      stats: corridorStats(onRouteFixes(), EXPECTED_PATH, 400),
    })
    expect(result.verdict).toBe('inconclusive')
    expect(result.summary).toContain('Too short')
  })

  it('calls a brief dip out inconclusive rather than a detour', () => {
    const fixes = [...onRouteFixes(20)]
    fixes[7] = { ...north(along(3500), 500), at: at(7) }
    const result = assessRoute({
      ...base,
      actualDistanceKm: 10.1,
      stats: corridorStats(fixes, EXPECTED_PATH, 400),
    })
    expect(result.verdict).toBe('inconclusive')
  })

  it('reports the deviation without a cost when no price has been established', () => {
    const fixes: TrackedFix[] = [
      ...onRouteFixes(6),
      ...Array.from({ length: 8 }, (_, i) => ({
        ...north(along(6000), 3000),
        at: at(10 + i),
      })),
    ]
    const result = assessRoute({
      ...base,
      pricePerLiter: null,
      stats: corridorStats(fixes, EXPECTED_PATH, 400),
    })
    expect(result.verdict).toBe('deviated')
    expect(result.extra_liters).toBe(0.2)
    expect(result.extra_cost_naira).toBeNull()
  })

  it('honours a per-route corridor width', () => {
    const fixes = [...onRouteFixes(20)]
    for (let i = 5; i < 15; i += 1) fixes[i] = { ...north(along(i * 500), 900), at: at(i) }

    const tight = assessRoute({
      ...base,
      stats: corridorStats(fixes, EXPECTED_PATH, 400),
      thresholds: { corridorWidthM: 400, deviatedDeviationM: 300 },
    })
    const wide = assessRoute({
      ...base,
      stats: corridorStats(fixes, EXPECTED_PATH, 1500),
      thresholds: { corridorWidthM: 1500 },
    })

    expect(tight.verdict).toBe('deviated')
    expect(wide.verdict).toBe('on_route')
  })
})
