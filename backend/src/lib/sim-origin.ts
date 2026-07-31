/**
 * Where a simulated vehicle starts.
 *
 * Previously every simulated device began at a hardcoded Lagos coordinate
 * (6.5244, 3.3792) baked into mock-device.js, DEFAULT_FLEET_PROFILES and the
 * route loops. That made the live map claim a vehicle was in Lagos regardless
 * of where its device had actually last reported, which is what prompted this
 * change.
 *
 * Resolution order for a device's origin:
 *   1. its LAST KNOWN position from the telemetry table (the real answer)
 *   2. SIM_ORIGIN_LAT / SIM_ORIGIN_LNG from the environment
 *   3. the profile's own configured start, if any
 * A location is never invented: when none of the above yields a coordinate the
 * caller is told, and it is the caller's job to surface that rather than to
 * silently drop a pin somewhere plausible.
 *
 * Route loops keep their SHAPE but no longer assert a PLACE — see
 * translateLoop: the loop is rigidly shifted so its first waypoint sits on the
 * resolved origin, so the same believable driving pattern plays out wherever
 * the device actually is.
 */

export type LatLng = { lat: number; lng: number }

export type OriginSource = 'telemetry' | 'env' | 'profile' | 'none'

export type ResolvedOrigin = {
  origin: LatLng | null
  source: OriginSource
}

/** A latitude/longitude pair that is finite and within valid ranges. */
export function isValidLatLng(value: unknown): value is LatLng {
  if (!value || typeof value !== 'object') return false
  const { lat, lng } = value as { lat?: unknown; lng?: unknown }
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    // 0,0 is Null Island — overwhelmingly a placeholder or a failed parse
    // rather than a real fix, and accepting it would put the fleet in the Gulf
    // of Guinea.
    !(lat === 0 && lng === 0)
  )
}

/** Parses a coordinate that may arrive as a numeric string (pg NUMERIC does). */
export function toLatLng(lat: unknown, lng: unknown): LatLng | null {
  const nlat = typeof lat === 'string' ? Number(lat) : lat
  const nlng = typeof lng === 'string' ? Number(lng) : lng
  const candidate = { lat: nlat as number, lng: nlng as number }
  return isValidLatLng(candidate) ? candidate : null
}

/**
 * PURE. Picks the origin from the candidates in priority order. Every input is
 * supplied by the caller — no DB, no env, no clock — so the precedence rules
 * are directly testable.
 */
export function resolveOrigin(input: {
  lastKnown?: LatLng | null
  envOrigin?: LatLng | null
  profileStart?: LatLng | null
}): ResolvedOrigin {
  if (isValidLatLng(input.lastKnown)) return { origin: input.lastKnown, source: 'telemetry' }
  if (isValidLatLng(input.envOrigin)) return { origin: input.envOrigin, source: 'env' }
  if (isValidLatLng(input.profileStart)) return { origin: input.profileStart, source: 'profile' }
  return { origin: null, source: 'none' }
}

/** Reads SIM_ORIGIN_LAT / SIM_ORIGIN_LNG, or null when unset/unparseable. */
export function envOrigin(env: NodeJS.ProcessEnv = process.env): LatLng | null {
  if (env.SIM_ORIGIN_LAT === undefined || env.SIM_ORIGIN_LNG === undefined) return null
  return toLatLng(env.SIM_ORIGIN_LAT, env.SIM_ORIGIN_LNG)
}

/**
 * PURE. Rigidly translates a loop so its FIRST waypoint lands on `origin`,
 * preserving the loop's shape and scale. Returns a copy; the input is untouched
 * so a shared loop constant can be reused across vehicles.
 */
export function translateLoop(loop: LatLng[], origin: LatLng): LatLng[] {
  if (loop.length === 0) return []
  const head = loop[0]
  const dLat = origin.lat - head.lat
  const dLng = origin.lng - head.lng
  return loop.map((point) => ({ lat: point.lat + dLat, lng: point.lng + dLng }))
}
