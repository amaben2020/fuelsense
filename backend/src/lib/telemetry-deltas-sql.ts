import { sql, SQL } from 'drizzle-orm';
import { FUEL_MARKER_SOURCES } from './fuel-metrics';

interface TelemetryDeltasParams {
  customerId: string;
  days: number;
}

/** Every figure in this app is reported against the fleet's local clock. */
export const FLEET_TZ = 'Africa/Lagos';

/**
 * The instant a window of `days` calendar days begins, in the fleet's timezone.
 *
 * `days` counts calendar days *including today*, so 1 is midnight this morning
 * and 7 is midnight six days ago. It used to mean `NOW() - N days`, a window
 * that slid with the wall clock: at 14:30 on Wednesday the "Today" tab reached
 * back to 14:30 on Tuesday, so a fleet that had not moved all Wednesday was
 * shown Tuesday afternoon's 28.6 km under a heading that said today. The table
 * underneath, which grouped by date, correctly labelled the same rows "TUE 11
 * AUG" — the panel disagreed with itself on screen.
 *
 * Anchoring on the local midnight also stops the boundary drifting through the
 * day, so two loads an hour apart report the same "today".
 */
export function windowStart(days: number): SQL {
  return sql`((DATE(NOW() AT TIME ZONE ${FLEET_TZ}) - ((${days} - 1) || ' days')::INTERVAL)
    AT TIME ZONE ${FLEET_TZ})`;
}

/** The local calendar date a reading falls on. */
export const localDate: SQL = sql`DATE(recorded_at AT TIME ZONE ${FLEET_TZ})`;

/**
 * `fuel_source IN (...)` over the marker provenances, each bound as a parameter
 * so the list stays in one place instead of being spelled out per query.
 */
export const isFuelMarker: SQL = sql`fuel_source IN (${sql.join(
  FUEL_MARKER_SOURCES.map((source) => sql`${source}`),
  sql`, `,
)})`;

/**
 * Longest gap between two readings that may still be counted as idling.
 *
 * A tracker that stops reporting leaves a hole, and both ends of that hole can
 * legitimately read "ignition on, not moving". Without a cap the whole outage
 * is booked as idle time: a 42.6-hour silence between 18 and 20 August was
 * reported to the driver as 42.7 hours idling on the 20th, which is not a
 * number a day can hold. Capping each hop also guarantees the daily total
 * cannot exceed the hours actually elapsed.
 */
export const IDLE_GAP_CAP_SECONDS = 600;

/**
 * Seconds of idling one hop represents — engine running, wheels stopped.
 *
 * Shared so the rule cannot drift between queries. It had drifted: both delta
 * CTEs capped the gap while the daily-activity query, which feeds the driver's
 * own history screen, summed it uncapped.
 */
export const idleDeltaSeconds: SQL = sql`
  CASE
    WHEN prev_recorded_at IS NOT NULL
      AND COALESCE(ignition_on, false)
      AND COALESCE(speed_kph, 0) < 2
    THEN LEAST(
      EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)),
      ${IDLE_GAP_CAP_SECONDS}
    )
    ELSE 0
  END`;

/**
 * Fuel burned over one hop, in litres.
 *
 * Prefers `burn_ml`, the modelled figure recorded on the row itself. Summing
 * that is exact and order-independent. The fallback differences
 * `fuel_level_liters` and exists only for rows written before `burn_ml` did —
 * it is the lossy path: the column is rounded to 2 dp and the series is not
 * monotonic once ordered by the device's own timestamps, so counting every
 * down-step while discarding every up-step over-reports. On 2026-08-11 that
 * turned a real 10.2 L into 11.3 L and invented "1.0 L unaccounted for".
 *
 * Marker rows are re-anchors, not burn, and are zero on both paths.
 */
export const hopBurnLiters: SQL = sql`
  CASE
    WHEN ${isFuelMarker} THEN 0
    WHEN burn_ml IS NOT NULL THEN burn_ml / 1000.0
    WHEN prev_fuel IS NULL OR fuel_level_liters IS NULL THEN 0
    WHEN fuel_level_liters - prev_fuel >= 5 THEN 0
    WHEN prev_fuel - fuel_level_liters >= 12
      AND NOT COALESCE(ignition_on, false)
      AND COALESCE(speed_kph, 0) < 2
      THEN 0
    WHEN fuel_level_liters < prev_fuel THEN prev_fuel - fuel_level_liters
    ELSE 0
  END`;

/**
 * Distance-only delta CTEs — no fuel-level or odometer required.
 * Uses odometer deltas when available, otherwise GPS haversine hops,
 * both capped by speed × elapsed time to reject GPS jumps.
 */
export function distanceDeltasCte({ customerId, days }: TelemetryDeltasParams): SQL {
  return sql`
    readings AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        v.model,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        -- AVL 16 arrives in metres. Reading the rounded km column made every
        -- delta a 0 or a 1, and the speed cap below then clipped each integer
        -- flip to a fraction of a kilometre — a day of 10.9 real km reported
        -- as 5. Metres first, rounded km only for rows recorded before
        -- odometer_m existed.
        COALESCE(t.odometer_m::double precision / 1000.0, t.odometer_km::double precision)
          AS odometer_km,
        t.latitude::double precision AS latitude,
        t.longitude::double precision AS longitude,
        t.speed_kph,
        t.ignition_on,
        t.recorded_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at >= ${windowStart(days)}
    ),
    ordered AS (
      SELECT
        *,
        LAG(odometer_km) OVER w AS prev_odometer,
        LAG(latitude) OVER w AS prev_latitude,
        LAG(longitude) OVER w AS prev_longitude,
        LAG(recorded_at) OVER w AS prev_recorded_at
      FROM readings
      WINDOW w AS (PARTITION BY vehicle_id ORDER BY recorded_at)
    ),
    hops AS (
      SELECT
        vehicle_id,
        license_plate,
        model,
        driver_name,
        recorded_at,
        speed_kph,
        ignition_on,
        ${idleDeltaSeconds} AS idle_delta_s,
        CASE
          WHEN odometer_km IS NOT NULL AND prev_odometer IS NOT NULL
            AND odometer_km >= prev_odometer
            THEN (odometer_km - prev_odometer)::double precision
        END AS odo_km,
        CASE
          WHEN latitude IS NOT NULL AND longitude IS NOT NULL
            AND prev_latitude IS NOT NULL AND prev_longitude IS NOT NULL
            THEN 6371 * 2 * ASIN(SQRT(
              POWER(SIN(RADIANS(latitude - prev_latitude) / 2), 2)
              + COS(RADIANS(prev_latitude)) * COS(RADIANS(latitude))
                * POWER(SIN(RADIANS(longitude - prev_longitude) / 2), 2)
            ))
        END AS gps_km,
        GREATEST(
          COALESCE(speed_kph, 0)
            * EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at))
            / 3600.0
            * 1.25,
          CASE
            WHEN EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)) <= 15 THEN 0.25
            WHEN EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)) <= 600 THEN 12
            ELSE 35
          END
        )::double precision AS cap_km
      FROM ordered
      WHERE prev_recorded_at IS NOT NULL
    ),
    deltas AS (
      SELECT
        vehicle_id,
        license_plate,
        model,
        driver_name,
        recorded_at,
        idle_delta_s,
        CASE
          WHEN odo_km IS NOT NULL THEN LEAST(odo_km, cap_km)
          -- ignore stationary GPS jitter
          WHEN gps_km IS NOT NULL AND COALESCE(speed_kph, 0) >= 2
            THEN LEAST(gps_km, cap_km)
          ELSE 0
        END AS dist_delta
      FROM hops
    )
  `;
}

/** Shared telemetry delta CTEs — capped distance, consumption-only fuel deltas. */
export function telemetryDeltasCte({ customerId, days }: TelemetryDeltasParams): SQL {
  return sql`
    readings AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        v.model,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        v.tank_capacity_liters,
        -- Metre precision, same reason as distanceDeltasCte above.
        COALESCE(t.odometer_m::double precision / 1000.0, t.odometer_km::double precision)
          AS odometer_km,
        t.fuel_level_liters::numeric AS fuel_level_liters,
        t.fuel_source,
        t.burn_ml,
        t.speed_kph,
        t.ignition_on,
        t.recorded_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at >= ${windowStart(days)}
    ),
    ordered AS (
      SELECT
        *,
        LAG(fuel_level_liters) OVER (
          PARTITION BY vehicle_id ORDER BY recorded_at
        ) AS prev_fuel,
        LAG(odometer_km) OVER (
          PARTITION BY vehicle_id ORDER BY recorded_at
        ) AS prev_odometer,
        LAG(recorded_at) OVER (
          PARTITION BY vehicle_id ORDER BY recorded_at
        ) AS prev_recorded_at
      FROM readings
    ),
    deltas AS (
      SELECT
        vehicle_id,
        license_plate,
        model,
        driver_name,
        tank_capacity_liters,
        recorded_at,
        ${idleDeltaSeconds} AS idle_delta_s,
        CASE
          WHEN prev_recorded_at IS NULL OR prev_odometer IS NULL OR odometer_km IS NULL THEN 0
          WHEN odometer_km < prev_odometer THEN 0
          ELSE LEAST(
            GREATEST(0, odometer_km - prev_odometer),
            GREATEST(
              COALESCE(speed_kph, 0)
                * EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at))
                / 3600.0
                * 1.25,
              CASE
                WHEN EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)) <= 15 THEN 0.25
                WHEN EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)) <= 600 THEN 12
                ELSE 35
              END
            )
          )
        END AS dist_delta,
        -- Modelled burn where the row carries it, differenced level otherwise.
        -- Marker rows (calibration, credited receipt) are re-anchors rather
        -- than burn: a calibration from 29.95 L to 20 L is a 9.95 L drop, under
        -- the 12 L siphon guard and nothing like a 5 L rise, so the thresholds
        -- alone would book it as consumption.
        ${hopBurnLiters} AS fuel_delta
      FROM ordered
      WHERE prev_fuel IS NOT NULL OR burn_ml IS NOT NULL
    )
  `;
}
