import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, sql } from '../lib/db-helpers';
import { distanceDeltasCte } from '../lib/telemetry-deltas-sql';
import { IDLE_BURN_LITERS_PER_HOUR, round1 } from '../lib/fuel-metrics';
import { logAndRespond } from '../lib/errors';

const router = express.Router();

router.use(authenticateCustomer);

// Driving-behavior penalty weights, applied per event and normalised per
// 100 km so a vehicle that drives more isn't punished for exposure.
const SCORE_WEIGHTS: Record<string, number> = {
  crash: 30,
  overspeeding: 4,
  harsh_braking: 3,
  harsh_acceleration: 2,
  harsh_cornering: 2,
};

// Idling is charged by the hour, not by the event. Counting idling_start made
// one forty-minute wait and one traffic light cost the same point.
const IDLE_PENALTY_PER_HOUR = 6;
// Below this, idling is traffic and junctions rather than a habit worth scoring.
const IDLE_FREE_HOURS = 0.5;

const SECURITY_EVENT_TYPES = [
  'towing',
  'crash',
  'jamming_start',
  'power_unplug',
  'geofence_exit',
];

/**
 * Turns a penalty rate into a 0-100 score that keeps meaning at the bad end.
 *
 * This was `100 - penaltyPer100km`, clamped. Any fleet past 100 penalty per
 * 100 km therefore read exactly 0 — the real vehicle here scored 128.8 and
 * showed "0/100", indistinguishable from one ten times worse. The number had
 * stopped ranking anything.
 *
 * Exponential decay never reaches zero, so ordering survives however bad the
 * driving gets. The constant is 100 because that makes the initial gradient
 * identical to the old straight line: a fleet scoring in the healthy range
 * sees essentially the number it saw before (a penalty of 10 gave 90, and now
 * gives 90.5), and only the saturated end behaves differently.
 */
export function scoreForPenalty(penaltyPer100km: number): number {
  if (!Number.isFinite(penaltyPer100km) || penaltyPer100km <= 0) return 100;
  return 100 * Math.exp(-penaltyPer100km / 100);
}

const gradeForScore = (score: number): string => {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  return 'F';
};

router.get('/', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const type = String(req.query.type || '').trim();
  const vehicleId = String(req.query.vehicle_id || '').trim();
  const customerId = req.user.customerId;

  try {
    const filters = [
      sql`e.customer_id = ${customerId}`,
      sql`e.occurred_at > NOW() - (${days} || ' days')::INTERVAL`,
    ];
    if (type === 'security') {
      filters.push(
        sql`e.event_type IN (${sql.join(
          SECURITY_EVENT_TYPES.map((t) => sql`${t}`),
          sql`, `
        )})`
      );
    } else if (type) {
      filters.push(sql`e.event_type = ${type}`);
    }
    if (vehicleId) filters.push(sql`e.vehicle_id = ${vehicleId}::uuid`);

    const result = await db.execute(sql`
      SELECT
        e.id,
        e.vehicle_id,
        v.license_plate,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        e.event_type,
        e.severity,
        e.value,
        e.unit,
        e.speed_kph,
        e.latitude,
        e.longitude,
        e.occurred_at
      FROM device_events e
      LEFT JOIN vehicles v ON v.id = e.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY e.occurred_at DESC
      LIMIT ${limit}
    `);

    res.json({ period_days: days, events: result.rows });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.get('/summary', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const customerId = req.user.customerId;

  try {
    const [countsResult, distanceResult, vehiclesResult] = await Promise.all([
      db.execute(sql`
        SELECT vehicle_id, event_type, COUNT(*)::int AS count,
               MAX(occurred_at) AS last_at
        FROM device_events
        WHERE customer_id = ${customerId}
          AND occurred_at > NOW() - (${days} || ' days')::INTERVAL
        GROUP BY vehicle_id, event_type
      `),
      db.execute(sql`
        WITH ${distanceDeltasCte({ customerId, days })}
        SELECT
          vehicle_id,
          COALESCE(SUM(dist_delta), 0)::int AS distance_km,
          COALESCE(SUM(idle_delta_s), 0)::numeric AS idle_seconds
        FROM deltas
        GROUP BY vehicle_id
      `),
      db.execute(sql`
        SELECT v.id AS vehicle_id, v.license_plate, v.model,
               COALESCE(dr.full_name, v.driver_name) AS driver_name
        FROM vehicles v
        LEFT JOIN drivers dr ON dr.id = v.driver_id
        WHERE v.customer_id = ${customerId}
      `),
    ]);

    const distanceByVehicle = new Map<string, number>();
    const idleHoursByVehicle = new Map<string, number>();
    for (const row of distanceResult.rows) {
      const r = row as Record<string, unknown>;
      distanceByVehicle.set(String(r.vehicle_id), Math.max(0, Number(r.distance_km) || 0));
      idleHoursByVehicle.set(String(r.vehicle_id), (Number(r.idle_seconds) || 0) / 3600);
    }

    const countsByVehicle = new Map<string, Record<string, number>>();
    const lastEventByVehicle = new Map<string, string>();
    const fleetCounts: Record<string, number> = {};
    for (const row of countsResult.rows) {
      const r = row as Record<string, unknown>;
      const vid = String(r.vehicle_id);
      const eventType = String(r.event_type);
      const count = Number(r.count) || 0;
      if (!countsByVehicle.has(vid)) countsByVehicle.set(vid, {});
      countsByVehicle.get(vid)![eventType] = count;
      fleetCounts[eventType] = (fleetCounts[eventType] || 0) + count;
      const lastAt = String(r.last_at);
      const prev = lastEventByVehicle.get(vid);
      if (!prev || lastAt > prev) lastEventByVehicle.set(vid, lastAt);
    }

    const vehicles = vehiclesResult.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const vid = String(r.vehicle_id);
      const counts = countsByVehicle.get(vid) ?? {};
      const distanceKm = distanceByVehicle.get(vid) ?? 0;
      const idleHours = idleHoursByVehicle.get(vid) ?? 0;
      const billableIdleHours = Math.max(0, idleHours - IDLE_FREE_HOURS);

      let penalty = 0;
      for (const [eventType, weight] of Object.entries(SCORE_WEIGHTS)) {
        penalty += (counts[eventType] || 0) * weight;
      }
      penalty += billableIdleHours * IDLE_PENALTY_PER_HOUR;
      // Floor the divisor so a single short trip with one harsh brake
      // doesn't produce a catastrophic score.
      const penaltyPer100km = (penalty * 100) / Math.max(distanceKm, 20);
      const score = Math.round(scoreForPenalty(penaltyPer100km));

      const securityEvents = SECURITY_EVENT_TYPES.reduce(
        (s, t) => s + (counts[t] || 0),
        0
      );
      const totalEvents = Object.values(counts).reduce((s, c) => s + c, 0);

      return {
        vehicle_id: vid,
        license_plate: r.license_plate,
        driver_name: r.driver_name,
        model: r.model,
        distance_km: distanceKm,
        idle_hours: round1(idleHours),
        idle_fuel_liters: round1(idleHours * IDLE_BURN_LITERS_PER_HOUR),
        score,
        grade: gradeForScore(score),
        total_events: totalEvents,
        security_events: securityEvents,
        counts,
        last_event_at: lastEventByVehicle.get(vid) ?? null,
      };
    });

    // Vehicles with worse behavior first; untouched vehicles at the end
    vehicles.sort((a, b) => a.score - b.score || b.total_events - a.total_events);

    const scored = vehicles.filter((v) => v.total_events > 0 || v.distance_km > 0);
    const avgScore = scored.length
      ? Math.round(scored.reduce((s, v) => s + v.score, 0) / scored.length)
      : null;

    res.json({
      period_days: days,
      fleet: {
        avg_score: avgScore,
        total_events: Object.values(fleetCounts).reduce((s, c) => s + c, 0),
        security_events: SECURITY_EVENT_TYPES.reduce(
          (s, t) => s + (fleetCounts[t] || 0),
          0
        ),
        idle_hours: round1(vehicles.reduce((s, v) => s + v.idle_hours, 0)),
        idle_fuel_liters: round1(vehicles.reduce((s, v) => s + v.idle_fuel_liters, 0)),
        counts_by_type: fleetCounts,
      },
      idle_burn_liters_per_hour: IDLE_BURN_LITERS_PER_HOUR,
      vehicles,
    });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

export default router;
