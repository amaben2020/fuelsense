import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, sql, eq, and } from '../lib/db-helpers';
import { geofences } from '../db/schema';
import { logAndRespond } from '../lib/errors';

const router = express.Router();
router.use(authenticateCustomer);

const clampDays = (raw: unknown, fallback: number) =>
  Math.min(Math.max(Number(raw) || fallback, 1), 90);

router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(geofences)
      .where(eq(geofences.customerId, req.user.customerId));
    res.json(rows);
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
    res.status(201).json(row);
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
 */
router.get('/events', async (req: Request, res: Response) => {
  const days = clampDays(req.query.days, 7);
  try {
    const customerId = req.user.customerId;

    const rows = await db.execute(sql`
      WITH zones AS (
        SELECT id, name, purpose, notify_on, shape,
               center_lat::double precision AS clat,
               center_lng::double precision AS clng,
               radius_m
        FROM geofences
        WHERE customer_id = ${customerId} AND active AND shape = 'circle'
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
          (
            6371000 * 2 * ASIN(SQRT(
              POWER(SIN(RADIANS(f.lat - z.clat) / 2), 2)
              + COS(RADIANS(z.clat)) * COS(RADIANS(f.lat))
                * POWER(SIN(RADIANS(f.lng - z.clng) / 2), 2)
            ))
          ) <= z.radius_m AS inside
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
      // Polygon zones are stored but not yet evaluated here; saying so beats
      // silently returning nothing for them.
      evaluates: 'circle' as const,
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
