import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, sql, eq, and } from '../lib/db-helpers';
import { geofences } from '../db/schema';
import { logAndRespond } from '../lib/errors';

const router = express.Router();
router.use(authenticateCustomer);

const clampDays = (raw: unknown, fallback: number) =>
  Math.min(Math.max(Number(raw) || fallback, 1), 90);

type GeofenceRow = typeof geofences.$inferSelect;

/**
 * Zones go out in snake_case, like every other payload this API serves.
 *
 * Returning Drizzle's rows straight sent camelCase (`centerLat`, `radiusM`),
 * which no caller expected: the POST body on this same route already speaks
 * snake_case, /geofences/events does too, and the frontend's Geofence type
 * declares it. The mismatch meant `center_lat` and `radius_m` read as
 * undefined in the client, so saved circle zones silently failed the
 * "has a centre" check and were never drawn on the map at all.
 */
function serialize(row: GeofenceRow) {
  return {
    id: row.id,
    name: row.name,
    shape: row.shape,
    center_lat: row.centerLat,
    center_lng: row.centerLng,
    radius_m: row.radiusM,
    polygon: row.polygon,
    purpose: row.purpose,
    notify_on: row.notifyOn,
    vehicle_id: row.vehicleId,
    driver_id: row.driverId,
    active: row.active,
    created_at: row.createdAt,
  };
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(geofences)
      .where(eq(geofences.customerId, req.user.customerId));
    res.json(rows.map(serialize));
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.post('/', async (req: Request, res: Response) => {
  const {
    name,
    shape = 'circle',
    center_lat: lat,
    center_lng: lng,
    radius_m: radiusM,
    polygon,
    purpose = 'depot',
    notify_on: notifyOn = 'both',
    vehicle_id: vehicleId = null,
    driver_id: driverId = null,
  } = req.body ?? {};

  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (shape === 'circle' && (lat == null || lng == null || !radiusM)) {
    res.status(400).json({ error: 'circle zones need center_lat, center_lng and radius_m' });
    return;
  }
  if (shape === 'polygon' && (!Array.isArray(polygon) || polygon.length < 3)) {
    res.status(400).json({ error: 'polygon zones need at least 3 points' });
    return;
  }

  try {
    const [row] = await db
      .insert(geofences)
      .values({
        customerId: req.user.customerId,
        name: String(name).trim(),
        shape,
        centerLat: lat == null ? null : String(lat),
        centerLng: lng == null ? null : String(lng),
        radiusM: radiusM == null ? null : Number(radiusM),
        polygon: shape === 'polygon' ? polygon : null,
        purpose,
        notifyOn,
        // Null scope = whole fleet. Empty strings arrive from unset <select>
        // elements and must not be inserted as invalid uuids.
        vehicleId: vehicleId || null,
        driverId: driverId || null,
      })
      .returning();
    res.status(201).json(serialize(row));
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .delete(geofences)
      .where(
        and(
          eq(geofences.id, String(req.params.id)),
          eq(geofences.customerId, req.user.customerId)
        )
      )
      .returning({ id: geofences.id });
    if (!row) {
      res.status(404).json({ error: 'Geofence not found' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

/**
 * Entry and exit crossings per zone.
 *
 * Containment is evaluated in SQL against every fix in the window, then only
 * the frames where containment *changed* are kept — reporting every fix inside
 * a depot would bury the one crossing that matters under thousands of rows.
 *
 * Circles use the haversine distance rather than a bounding box: at Nigerian
 * latitudes a naive degree box is noticeably wider than it is tall, which
 * silently enlarges every zone on its east-west axis.
 *
 * Polygons (which is also how rectangles are stored) are tested with Postgres'
 * native polygon containment on a plane, matching the ray casting the live
 * monitor does in JS. The planar approximation is what both sides already
 * assume and is accurate at the scale of a depot; it would only break for a
 * zone spanning the antimeridian.
 */
router.get('/events', async (req: Request, res: Response) => {
  const days = clampDays(req.query.days, 7);
  try {
    const customerId = req.user.customerId;

    const rows = await db.execute(sql`
      WITH zones AS (
        SELECT g.id, g.name, g.purpose, g.notify_on, g.shape,
               g.center_lat::double precision AS clat,
               g.center_lng::double precision AS clng,
               g.radius_m,
               -- Rings are stored [[lat, lng], ...]; Postgres points are (x, y),
               -- so longitude becomes x. That matches pointInPolygon() in
               -- geofence-monitor.ts, which also treats longitude as x — the
               -- live alert and this history view must not disagree about
               -- whether a given fix was inside a zone.
               CASE
                 WHEN g.shape = 'polygon'
                   AND jsonb_typeof(g.polygon) = 'array'
                   AND jsonb_array_length(g.polygon) >= 3
                 THEN (
                   SELECT ('(' || string_agg(
                             '(' || (p->>1) || ',' || (p->>0) || ')', ',' ORDER BY o
                           ) || ')')::polygon
                   FROM jsonb_array_elements(g.polygon) WITH ORDINALITY AS t(p, o)
                 )
                 ELSE NULL
               END AS poly
        FROM geofences g
        WHERE g.customer_id = ${customerId}
          AND g.active
          AND g.shape IN ('circle', 'polygon')
      ),
      fixes AS (
        SELECT
          t.vehicle_id,
          v.license_plate,
          COALESCE(dr.full_name, v.driver_name) AS driver_name,
          t.recorded_at,
          t.latitude::double precision AS lat,
          t.longitude::double precision AS lng
        FROM telemetry t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
        WHERE t.customer_id = ${customerId}
          AND t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
          AND t.latitude IS NOT NULL
          AND t.longitude IS NOT NULL
      ),
      contained AS (
        SELECT
          f.*,
          z.id AS zone_id,
          z.name AS zone_name,
          z.purpose,
          z.notify_on,
          CASE
            WHEN z.shape = 'circle' AND z.clat IS NOT NULL AND z.radius_m IS NOT NULL THEN (
              6371000 * 2 * ASIN(SQRT(
                POWER(SIN(RADIANS(f.lat - z.clat) / 2), 2)
                + COS(RADIANS(z.clat)) * COS(RADIANS(f.lat))
                  * POWER(SIN(RADIANS(f.lng - z.clng) / 2), 2)
              ))
            ) <= z.radius_m
            WHEN z.poly IS NOT NULL THEN z.poly @> point(f.lng, f.lat)
            ELSE NULL
          END AS inside
        FROM fixes f
        CROSS JOIN zones z
      ),
      transitions AS (
        SELECT
          *,
          LAG(inside) OVER (
            PARTITION BY vehicle_id, zone_id ORDER BY recorded_at
          ) AS prev_inside
        FROM contained
      )
      SELECT
        vehicle_id, license_plate, driver_name, zone_id, zone_name,
        purpose, notify_on, recorded_at, lat, lng,
        CASE WHEN inside THEN 'entered' ELSE 'exited' END AS direction
      FROM transitions
      WHERE prev_inside IS NOT NULL
        AND inside <> prev_inside
        AND (notify_on = 'both' OR notify_on = CASE WHEN inside THEN 'enter' ELSE 'exit' END)
      ORDER BY recorded_at DESC
      LIMIT 200
    `);

    res.json({
      period_days: days,
      // Both shapes are evaluated now. Rectangles are stored as four-point
      // polygons, so they need no separate case here or in the live monitor.
      evaluates: 'circle+polygon' as const,
      events: rows.rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          vehicle_id: row.vehicle_id,
          license_plate: row.license_plate,
          driver_name: row.driver_name,
          zone_id: row.zone_id,
          zone_name: row.zone_name,
          purpose: row.purpose,
          direction: row.direction,
          at: row.recorded_at,
          latitude: Number(row.lat),
          longitude: Number(row.lng),
        };
      }),
    });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

export default router;
