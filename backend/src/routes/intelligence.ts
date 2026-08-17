import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, sql } from '../lib/db-helpers';
import {
  tamperSignalsCte,
  drivingStretchesCte,
  utilisationCte,
} from '../lib/fleet-intelligence-sql';
import { round1, round2 } from '../lib/fuel-metrics';
import { localDate } from '../lib/telemetry-deltas-sql';
import { withCache, cacheKey } from '../lib/redis';
import { logAndRespond } from '../lib/errors';

const router = express.Router();
router.use(authenticateCustomer);

const clampDays = (raw: unknown, fallback: number) =>
  Math.min(Math.max(Number(raw) || fallback, 1), 90);

/** GSM bars at or below this count as "lost" for the jamming heuristic. */
const WEAK_GSM = 1;
/** Silence longer than this, begun mid-journey, is worth surfacing. */
const GAP_SECONDS = 900;
/** A rest this long ends a continuous driving stretch. */
const BREAK_MINUTES = 30;
/** Stretch length past which fatigue is worth flagging. */
const FATIGUE_HOURS = 4;

/**
 * Security signals — jamming candidates and unexplained reporting gaps.
 *
 * Deliberately called "candidates". Each row carries the evidence that produced
 * it so a manager can dismiss a tunnel without the system having pretended to
 * know the difference.
 */
router.get('/security', async (req: Request, res: Response) => {
  const days = clampDays(req.query.days, 7);
  try {
    const customerId = req.user.customerId;
    const payload = await withCache(
      cacheKey(customerId, 'intel-security', String(days)),
      60,
      async () => {
        const rows = await db.execute(sql`
          WITH ${tamperSignalsCte({
            customerId,
            days,
            weakGsm: WEAK_GSM,
            minGapSeconds: GAP_SECONDS,
          })}
          SELECT
            vehicle_id, license_plate, driver_name, recorded_at,
            latitude, longitude, signal, gsm_signal, battery_current_ma,
            prev_speed, gap_seconds
          FROM signals
          WHERE signal IS NOT NULL
          ORDER BY recorded_at DESC
          LIMIT 100
        `);

        return {
          period_days: days,
          thresholds: {
            weak_gsm_bars: WEAK_GSM,
            reporting_gap_seconds: GAP_SECONDS,
          },
          events: rows.rows.map((r) => {
            const row = r as Record<string, unknown>;
            return {
              vehicle_id: row.vehicle_id,
              license_plate: row.license_plate,
              driver_name: row.driver_name,
              at: row.recorded_at,
              latitude: row.latitude == null ? null : Number(row.latitude),
              longitude: row.longitude == null ? null : Number(row.longitude),
              kind: row.signal,
              gsm_signal: row.gsm_signal == null ? null : Number(row.gsm_signal),
              battery_current_ma:
                row.battery_current_ma == null ? null : Number(row.battery_current_ma),
              speed_before_kph: row.prev_speed == null ? null : Number(row.prev_speed),
              gap_seconds: row.gap_seconds == null ? null : Number(row.gap_seconds),
            };
          }),
        };
      }
    );
    res.json(payload);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

/**
 * Driving hours and fatigue exposure, per vehicle over the window.
 *
 * There is no hours-of-service regulation encoded here — thresholds are stated
 * in the response so the number can be argued with rather than taken on trust.
 */
router.get('/hours', async (req: Request, res: Response) => {
  const days = clampDays(req.query.days, 7);
  try {
    const customerId = req.user.customerId;
    const payload = await withCache(
      cacheKey(customerId, 'intel-hours', String(days)),
      60,
      async () => {
        const rows = await db.execute(sql`
          WITH ${drivingStretchesCte({ customerId, days, breakMinutes: BREAK_MINUTES })}
          SELECT
            vehicle_id,
            license_plate,
            driver_name,
            COUNT(*) AS stretches,
            COALESCE(SUM(hours), 0) AS total_hours,
            COALESCE(MAX(hours), 0) AS longest_hours,
            COUNT(*) FILTER (WHERE hours >= ${FATIGUE_HOURS}) AS long_stretches,
            COUNT(*) FILTER (WHERE touched_night) AS night_stretches
          FROM stretches
          GROUP BY vehicle_id, license_plate, driver_name
          ORDER BY total_hours DESC
        `);

        const longest = await db.execute(sql`
          WITH ${drivingStretchesCte({ customerId, days, breakMinutes: BREAK_MINUTES })}
          SELECT license_plate, driver_name, started_at, ended_at, hours, touched_night
          FROM stretches
          WHERE hours >= ${FATIGUE_HOURS}
          ORDER BY hours DESC
          LIMIT 20
        `);

        return {
          period_days: days,
          thresholds: {
            break_minutes: BREAK_MINUTES,
            fatigue_hours: FATIGUE_HOURS,
          },
          vehicles: rows.rows.map((r) => {
            const row = r as Record<string, unknown>;
            return {
              vehicle_id: row.vehicle_id,
              license_plate: row.license_plate,
              driver_name: row.driver_name,
              stretches: Number(row.stretches),
              total_hours: round1(Number(row.total_hours)),
              longest_hours: round1(Number(row.longest_hours)),
              long_stretches: Number(row.long_stretches),
              night_stretches: Number(row.night_stretches),
            };
          }),
          flagged: longest.rows.map((r) => {
            const row = r as Record<string, unknown>;
            return {
              license_plate: row.license_plate,
              driver_name: row.driver_name,
              started_at: row.started_at,
              ended_at: row.ended_at,
              hours: round1(Number(row.hours)),
              night: Boolean(row.touched_night),
            };
          }),
        };
      }
    );
    res.json(payload);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

/**
 * Utilisation, for deciding whether a vehicle earns its keep.
 *
 * `idle_share` is engine-hours with no distance against total engine-hours —
 * the figure that separates a busy van from one that sits running.
 */
router.get('/utilisation', async (req: Request, res: Response) => {
  const days = clampDays(req.query.days, 30);
  try {
    const customerId = req.user.customerId;
    const payload = await withCache(
      cacheKey(customerId, 'intel-utilisation', String(days)),
      60,
      async () => {
        const rows = await db.execute(sql`
          WITH ${utilisationCte({ customerId, days })}
          SELECT
            vehicle_id,
            license_plate,
            make,
            model,
            driver_name,
            COALESCE(SUM(dist_delta), 0) AS distance_km,
            COALESCE(SUM(engine_seconds), 0) AS engine_seconds,
            COALESCE(SUM(ignition_cycle), 0) AS ignition_cycles,
            COUNT(DISTINCT CASE WHEN dist_delta > 0 THEN ${localDate} END) AS active_days
          FROM util_deltas
          GROUP BY vehicle_id, license_plate, make, model, driver_name
          ORDER BY distance_km DESC
        `);

        const vehicles = rows.rows.map((r) => {
          const row = r as Record<string, unknown>;
          const distanceKm = Number(row.distance_km);
          const activeDays = Number(row.active_days);
          const engineHours = Number(row.engine_seconds) / 3600;
          return {
            vehicle_id: row.vehicle_id,
            license_plate: row.license_plate,
            make: row.make,
            model: row.model,
            driver_name: row.driver_name,
            distance_km: round1(distanceKm),
            engine_hours: round1(engineHours),
            ignition_cycles: Number(row.ignition_cycles),
            active_days: activeDays,
            /** Share of the window the vehicle actually moved on. */
            active_share: round2(activeDays / days),
            km_per_active_day: activeDays > 0 ? round1(distanceKm / activeDays) : null,
            /** Distance covered per hour the engine was running. */
            km_per_engine_hour: engineHours > 0.1 ? round1(distanceKm / engineHours) : null,
          };
        });

        return { period_days: days, vehicles };
      }
    );
    res.json(payload);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

export default router;
