import { SQL, sql } from 'drizzle-orm';

/**
 * Per-hop distance ceiling, matching the caps in `distanceDeltasCte`. Written
 * as one expression because it is applied to both the odometer and the GPS
 * branch: a device that goes offline for an hour must not book the whole gap
 * as distance travelled when it reconnects.
 */
const DIST_CAP = sql`GREATEST(
  COALESCE(speed_kph, 0)
    * EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at))
    / 3600.0
    * 1.25,
  CASE
    WHEN EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)) <= 15 THEN 0.25
    WHEN EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)) <= 600 THEN 12
    ELSE 35
  END
)::double precision`;

/**
 * Per-driver, per-calendar-month aggregates.
 *
 * The distance, idle and fuel rules are copied from `telemetryDeltasCte`
 * deliberately rather than imported: those helpers window over a rolling
 * `NOW() - N days`, and a monthly report has to cut on calendar boundaries or
 * the same trip lands in two different months depending on when you ask. Any
 * change to the capping rules there must be mirrored here, or the driver report
 * will quietly disagree with the fleet numbers.
 *
 * A driver is resolved through `vehicles.driver_id`, falling back to the
 * denormalised `vehicles.driver_name`. Telemetry has no driver column, so every
 * figure is "what this vehicle did while assigned to this driver" — a
 * reassignment mid-month reattributes the whole month. That is a real
 * limitation and the API reports it rather than hiding it.
 */
export function driverMonthlyCte({
  customerId,
  months,
}: {
  customerId: string;
  months: number;
}): SQL {
  return sql`
    readings AS (
      SELECT
        t.vehicle_id,
        v.driver_id,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        v.license_plate,
        v.model,
        date_trunc('month', t.recorded_at) AS month,
        COALESCE(t.odometer_m::double precision / 1000.0, t.odometer_km::double precision)
          AS odometer_km,
        t.fuel_level_liters::numeric AS fuel_level_liters,
        t.latitude::double precision AS latitude,
        t.longitude::double precision AS longitude,
        t.speed_kph,
        t.ignition_on,
        t.recorded_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at >= date_trunc('month', NOW()) - (${months - 1} || ' months')::INTERVAL
    ),
    ordered AS (
      SELECT
        *,
        LAG(odometer_km) OVER w AS prev_odometer,
        LAG(fuel_level_liters) OVER w AS prev_fuel,
        LAG(latitude) OVER w AS prev_latitude,
        LAG(longitude) OVER w AS prev_longitude,
        LAG(recorded_at) OVER w AS prev_recorded_at
      FROM readings
      WINDOW w AS (PARTITION BY vehicle_id ORDER BY recorded_at)
    ),
    deltas AS (
      SELECT
        vehicle_id,
        driver_id,
        driver_name,
        license_plate,
        model,
        month,
        recorded_at,
        latitude,
        longitude,
        speed_kph,
        ignition_on,
        CASE
          WHEN COALESCE(ignition_on, false) AND COALESCE(speed_kph, 0) < 2
            THEN LEAST(EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)), 600)
          ELSE 0
        END AS idle_delta_s,
        CASE
          WHEN COALESCE(speed_kph, 0) >= 2
            THEN LEAST(EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)), 600)
          ELSE 0
        END AS moving_delta_s,
        -- Distance prefers the odometer and falls back to GPS, exactly as
        -- distanceDeltasCte does. Odometer-only produced a flat 0 km for months
        -- whose rows predate the odometer_m column while still logging hours of
        -- movement — a driver shown as having driven nothing all month.
        CASE
          WHEN prev_recorded_at IS NULL THEN 0
          WHEN odometer_km IS NOT NULL AND prev_odometer IS NOT NULL
            AND odometer_km >= prev_odometer
            THEN LEAST(odometer_km - prev_odometer, ${DIST_CAP})
          WHEN latitude IS NOT NULL AND longitude IS NOT NULL
            AND prev_latitude IS NOT NULL AND prev_longitude IS NOT NULL
            AND COALESCE(speed_kph, 0) >= 2
            THEN LEAST(
              6371 * 2 * ASIN(SQRT(
                POWER(SIN(RADIANS(latitude - prev_latitude) / 2), 2)
                + COS(RADIANS(prev_latitude)) * COS(RADIANS(latitude))
                  * POWER(SIN(RADIANS(longitude - prev_longitude) / 2), 2)
              )),
              ${DIST_CAP}
            )
          ELSE 0
        END AS dist_delta,
        -- Consumption only: a rise of 5 L+ is a refuel, and a 12 L+ drop while
        -- parked with the engine off is a suspected siphon, not burn.
        CASE
          WHEN prev_fuel IS NULL OR fuel_level_liters IS NULL THEN 0
          WHEN fuel_level_liters - prev_fuel >= 5 THEN 0
          WHEN prev_fuel - fuel_level_liters >= 12
            AND NOT COALESCE(ignition_on, false)
            AND COALESCE(speed_kph, 0) < 2
            THEN 0
          WHEN fuel_level_liters < prev_fuel THEN prev_fuel - fuel_level_liters
          ELSE 0
        END AS fuel_delta
      FROM ordered
      WHERE prev_recorded_at IS NOT NULL
    )
  `;
}

/**
 * Trip counting, as movement sessions rather than ignition edges.
 *
 * Counting ignition off->on transitions returned 784 "trips" in a single month
 * for one vehicle: the ignition flag flickers between frames, and every flicker
 * read as another trip. A session — a run of movement bounded by a sustained
 * stop — is both defensible and what a manager means by "a trip".
 */
export function driverTripsCte({ gapMinutes }: { gapMinutes: number }): SQL {
  return sql`
    moving_fixes AS (
      SELECT
        driver_name,
        month,
        recorded_at,
        LAG(recorded_at) OVER (PARTITION BY vehicle_id ORDER BY recorded_at) AS prev_moving_at
      FROM deltas
      WHERE COALESCE(speed_kph, 0) >= 2
    ),
    trip_counts AS (
      SELECT driver_name, month, COUNT(*) AS trips
      FROM moving_fixes
      WHERE prev_moving_at IS NULL
        OR recorded_at - prev_moving_at > (${gapMinutes} || ' minutes')::INTERVAL
      GROUP BY driver_name, month
    )
  `;
}

/**
 * Most-visited place per driver-month.
 *
 * Stops are not stored anywhere — they are derived in-process by the trip
 * segmenter — so this reconstructs them in SQL: consecutive stationary fixes
 * (engine off or crawling) bucketed onto the same 4-decimal grid the place
 * cache is keyed on (~11 m), which lets the cached name join straight on.
 *
 * A bucket only counts as a visit once it holds enough fixes to rule out a
 * traffic light, and only cached places get a name — an uncached bucket is
 * returned with coordinates and a null name rather than a fabricated label.
 */
export function driverTopPlaceCte({ minFixes }: { minFixes: number }): SQL {
  return sql`
    stationary AS (
      SELECT
        driver_id,
        driver_name,
        month,
        ROUND(latitude::numeric, 4) AS lat_key,
        ROUND(longitude::numeric, 4) AS lng_key,
        COUNT(*) AS fixes
      FROM deltas
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND COALESCE(speed_kph, 0) < 2
      GROUP BY driver_id, driver_name, month, lat_key, lng_key
      HAVING COUNT(*) >= ${minFixes}
    ),
    ranked_places AS (
      SELECT
        s.*,
        pc.place_name,
        pc.formatted_address,
        ROW_NUMBER() OVER (
          PARTITION BY s.driver_id, s.driver_name, s.month ORDER BY s.fixes DESC
        ) AS rn
      FROM stationary s
      LEFT JOIN place_cache pc
        ON pc.geo_key = to_char(s.lat_key, 'FM999999990.0000')
          || ',' || to_char(s.lng_key, 'FM999999990.0000')
    )
  `;
}
