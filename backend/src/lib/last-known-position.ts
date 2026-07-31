import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { telemetry } from '../db/schema'
import { toLatLng, type LatLng } from './sim-origin'

/**
 * The most recent real position a device reported, or null if it has never
 * reported one. Impure half of the origin resolution — all the precedence
 * logic lives in the pure sim-origin module.
 *
 * Filters on latitude/longitude being NOT NULL rather than just taking the
 * newest row: a telemetry record can carry fuel/odometer with no GPS fix
 * (tunnel, cold start, indoor), and the newest such row would otherwise mask a
 * perfectly good fix from a minute earlier.
 */
export async function lastKnownPosition(imei: string): Promise<LatLng | null> {
  const rows = await db
    .select({ latitude: telemetry.latitude, longitude: telemetry.longitude })
    .from(telemetry)
    .where(
      and(eq(telemetry.imei, imei), isNotNull(telemetry.latitude), isNotNull(telemetry.longitude)),
    )
    .orderBy(desc(telemetry.recordedAt))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  // pg returns NUMERIC as a string — toLatLng coerces and validates.
  return toLatLng(row.latitude, row.longitude)
}
