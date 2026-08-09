import { SQL, sql } from 'drizzle-orm';

/**
 * Derivations over the AVL elements the FMC150 actually sends.
 *
 * The device supports scenario events for most of this (geofence, tamper,
 * jamming, idling) but has never emitted one — only event IDs 0, 239 and 240
 * have ever arrived. Enabling them is a configurator change on hardware that is
 * currently in a vehicle in Abuja, so every signal below is reconstructed
 * server-side from the 15 elements that do arrive. Nothing here needs a CAN
 * adapter, and nothing is hardcoded per-customer.
 *
 * Elements in play:
 *   16  total odometer (m)      21  GSM signal (0-5)     24  speed (km/h)
 *   68  battery current (mA)    69  GNSS status          239 ignition
 *   240 movement                449 ignition-on counter
 */

/**
 * Power-cut and GSM-jamming candidates.
 *
 * Two distinct signatures, deliberately kept apart because they mean different
 * things to a fleet manager:
 *
 *   - Jamming: GSM signal AND GNSS validity fail together *while moving*. Loss
 *     of one alone is ordinary Nigerian coverage; losing both at speed is the
 *     signature that precedes a theft.
 *   - Reporting gap: a silence that started mid-journey, which is what a unit
 *     being pulled or powered down actually looks like from the server.
 *
 * Battery current (AVL 68) is carried as supporting evidence but never as a
 * trigger: it reads 0 whenever the engine is off, so a "drop to zero" rule
 * would fire on every normal parking event.
 *
 * Both are reported as candidates with their evidence, never as verdicts — a
 * tunnel and a jammer look identical for the first thirty seconds.
 */
export function tamperSignalsCte({
  customerId,
  days,
  weakGsm,
  minGapSeconds,
}: {
  customerId: string;
  days: number;
  weakGsm: number;
  minGapSeconds: number;
}): SQL {
  return sql`
    frames AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        t.recorded_at,
        t.latitude::double precision AS latitude,
        t.longitude::double precision AS longitude,
        t.speed_kph,
        t.ignition_on,
        -- These three never made it into columns on the telemetry table; they
        -- live only in the raw frame. Reading them here avoids a migration and
        -- a backfill over every historical row.
        (f.io_raw -> '21' ->> 'dec')::int AS gsm_signal,
        (f.io_raw -> '68' ->> 'dec')::int AS battery_current_ma,
        (f.io_raw -> '69' ->> 'dec')::int AS gnss_status,
        LAG(t.recorded_at) OVER w AS prev_at,
        LAG((f.io_raw -> '21' ->> 'dec')::int) OVER w AS prev_gsm,
        LAG(t.speed_kph) OVER w AS prev_speed
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      JOIN device_frames f ON f.telemetry_id = t.id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
      WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.recorded_at)
    ),
    signals AS (
      SELECT
        vehicle_id,
        license_plate,
        driver_name,
        recorded_at,
        latitude,
        longitude,
        gsm_signal,
        battery_current_ma,
        prev_speed,
        EXTRACT(EPOCH FROM (recorded_at - prev_at))::int AS gap_seconds,
        CASE
          -- Signal and satellite lock failing together at speed. Either alone
          -- is ordinary coverage; both at once is the jamming signature.
          WHEN COALESCE(prev_gsm, 5) > ${weakGsm}
            AND COALESCE(gsm_signal, 0) <= ${weakGsm}
            AND COALESCE(gnss_status, 1) = 0
            AND COALESCE(prev_speed, 0) >= 15
            THEN 'signal_loss'
          -- A silence that began mid-journey. A unit switched off in motion
          -- cannot report the gap; the frame after it is the only evidence.
          WHEN prev_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (recorded_at - prev_at)) > ${minGapSeconds}
            AND COALESCE(prev_speed, 0) >= 15
            THEN 'reporting_gap'
        END AS signal
      FROM frames
    )
  `;
}

/**
 * Continuous driving stretches, for fatigue and hours-of-service.
 *
 * A stretch is unbroken movement; a rest of `breakMinutes` or more ends it.
 * Derived from ignition and speed because the device sends no HOS events, and
 * counted in wall-clock time between the first and last moving fix rather than
 * summed frame gaps — the latter silently shortens a stretch every time the
 * device drops a report.
 */
export function drivingStretchesCte({
  customerId,
  days,
  breakMinutes,
}: {
  customerId: string;
  days: number;
  breakMinutes: number;
}): SQL {
  return sql`
    moving AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        t.recorded_at,
        LAG(t.recorded_at) OVER w AS prev_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
        AND COALESCE(t.speed_kph, 0) >= 2
      WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.recorded_at)
    ),
    marked AS (
      SELECT
        *,
        CASE
          WHEN prev_at IS NULL
            OR recorded_at - prev_at > (${breakMinutes} || ' minutes')::INTERVAL
          THEN 1 ELSE 0
        END AS is_start
      FROM moving
    ),
    grouped AS (
      SELECT
        *,
        SUM(is_start) OVER (PARTITION BY vehicle_id ORDER BY recorded_at) AS stretch_id
      FROM marked
    ),
    stretches AS (
      SELECT
        vehicle_id,
        license_plate,
        driver_name,
        stretch_id,
        MIN(recorded_at) AS started_at,
        MAX(recorded_at) AS ended_at,
        EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at))) / 3600.0 AS hours,
        -- Night driving carries a materially higher risk profile and is worth
        -- separating from total hours rather than burying in an average.
        BOOL_OR(EXTRACT(HOUR FROM recorded_at) >= 22 OR EXTRACT(HOUR FROM recorded_at) < 5)
          AS touched_night
      FROM grouped
      GROUP BY vehicle_id, license_plate, driver_name, stretch_id
      HAVING EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at))) > 300
    )
  `;
}

/**
 * Utilisation, for right-sizing a fleet.
 *
 * The question is not "how far did it go" but "did owning it pay". Distance
 * comes from the odometer delta over the window; active days count calendar
 * days with real movement, which is what separates a van doing 200 km across
 * twenty days from one doing it in a single run.
 */
export function utilisationCte({
  customerId,
  days,
}: {
  customerId: string;
  days: number;
}): SQL {
  return sql`
    util_readings AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        v.model,
        v.make,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        t.recorded_at,
        COALESCE(t.odometer_m::double precision / 1000.0, t.odometer_km::double precision)
          AS odometer_km,
        t.speed_kph,
        t.ignition_on,
        LAG(COALESCE(t.odometer_m::double precision / 1000.0, t.odometer_km::double precision))
          OVER w AS prev_odometer,
        LAG(t.recorded_at) OVER w AS prev_at,
        LAG(t.ignition_on) OVER w AS prev_ignition
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
      WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.recorded_at)
    ),
    util_deltas AS (
      SELECT
        vehicle_id,
        license_plate,
        model,
        make,
        driver_name,
        recorded_at,
        CASE
          WHEN prev_odometer IS NOT NULL AND odometer_km >= prev_odometer
            THEN LEAST(odometer_km - prev_odometer, 35)
          ELSE 0
        END AS dist_delta,
        CASE
          WHEN COALESCE(ignition_on, false) AND NOT COALESCE(prev_ignition, false) THEN 1
          ELSE 0
        END AS ignition_cycle,
        CASE
          WHEN COALESCE(ignition_on, false)
            THEN LEAST(EXTRACT(EPOCH FROM (recorded_at - prev_at)), 600)
          ELSE 0
        END AS engine_seconds
      FROM util_readings
      WHERE prev_at IS NOT NULL
    )
  `;
}
