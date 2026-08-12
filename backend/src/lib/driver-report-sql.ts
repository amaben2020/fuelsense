import { SQL, sql } from 'drizzle-orm';
import { hopBurnLiters } from './telemetry-deltas-sql';

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

/** Calendar buckets the driver report can group on. */
export type ReportBucket = 'month' | 'week' | 'day';

export interface DriverPeriodParams {
  customerId: string;
  /** Calendar grain to group on. */
  bucket: ReportBucket;
  /** Explicit window start (inclusive). Overrides the rolling `periods` window. */
  from?: Date | null;
  /** Explicit window end (inclusive). */
  to?: Date | null;
  /** How many buckets back to look when `from`/`to` are not given. */
  periods: number;
}

/**
 * Per-driver, per-period aggregates.
 *
 * The distance, idle and fuel rules are copied from `telemetryDeltasCte`
 * deliberately rather than imported: those helpers window over a rolling
 * `NOW() - N days`, and this report has to cut on calendar boundaries or the
 * same trip lands in two different buckets depending on when you ask. Any
 * change to the capping rules there must be mirrored here, or the driver report
 * will quietly disagree with the fleet numbers.
 *
 * `bucket` is bound as a parameter to `date_trunc`, so a week view and a month
 * view run the identical aggregation — the only thing that moves is the grain.
 * An explicit `from`/`to` replaces the rolling window entirely, which is what
 * a manager picking two dates means.
 *
 * A driver is resolved through `vehicles.driver_id`, falling back to the
 * denormalised `vehicles.driver_name`. Telemetry has no driver column, so every
 * figure is "what this vehicle did while assigned to this driver" — a
 * reassignment mid-period reattributes the whole period. That is a real
 * limitation and the API reports it rather than hiding it.
 */
export function driverPeriodCte({
  customerId,
  bucket,
  from,
  to,
  periods,
}: DriverPeriodParams): SQL {
  // An explicit range wins; otherwise fall back to N whole buckets back from
  // the current one, so the newest bucket is always the one in progress.
  const window = from
    ? sql`AND t.recorded_at >= ${from}${to ? sql` AND t.recorded_at <= ${to}` : sql``}`
    : sql`AND t.recorded_at >= date_trunc(${bucket}, NOW())
            - ((${periods - 1})::text || ' ' || ${bucket})::INTERVAL
          ${to ? sql`AND t.recorded_at <= ${to}` : sql``}`;

  return sql`
    readings AS (
      SELECT
        t.vehicle_id,
        v.driver_id,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        v.license_plate,
        v.model,
        -- Only a manager-entered rate travels with the vehicle; a preset or a
        -- fill-to-fill figure is already what the model table would give.
        CASE
          WHEN v.rate_source = 'manual' THEN v.consumption_rate_l_per_100km::numeric
        END AS manual_l100km,
        date_trunc(${bucket}, t.recorded_at) AS period,
        COALESCE(t.odometer_m::double precision / 1000.0, t.odometer_km::double precision)
          AS odometer_km,
        t.fuel_level_liters::numeric AS fuel_level_liters,
        t.fuel_source,
        t.burn_ml,
        t.latitude::double precision AS latitude,
        t.longitude::double precision AS longitude,
        t.speed_kph,
        t.ignition_on,
        t.recorded_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        ${window}
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
        manual_l100km,
        period,
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
        -- Modelled burn where the row carries it, differenced level otherwise.
        -- Shares the hopBurnLiters expression with telemetryDeltasCte so the
        -- driver report and fleet figures cannot disagree about a vehicle.
        ${hopBurnLiters} AS fuel_delta
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
        period,
        recorded_at,
        LAG(recorded_at) OVER (PARTITION BY vehicle_id ORDER BY recorded_at) AS prev_moving_at
      FROM deltas
      WHERE COALESCE(speed_kph, 0) >= 2
    ),
    trip_counts AS (
      SELECT driver_name, period, COUNT(*) AS trips
      FROM moving_fixes
      WHERE prev_moving_at IS NULL
        OR recorded_at - prev_moving_at > (${gapMinutes} || ' minutes')::INTERVAL
      GROUP BY driver_name, period
    )
  `;
}

/**
 * Most-visited place per driver-period.
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
        period,
        ROUND(latitude::numeric, 4) AS lat_key,
        ROUND(longitude::numeric, 4) AS lng_key,
        COUNT(*) AS fixes
      FROM deltas
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND COALESCE(speed_kph, 0) < 2
      GROUP BY driver_id, driver_name, period, lat_key, lng_key
      HAVING COUNT(*) >= ${minFixes}
    ),
    ranked_places AS (
      SELECT
        s.*,
        pc.place_name,
        pc.formatted_address,
        ROW_NUMBER() OVER (
          PARTITION BY s.driver_id, s.driver_name, s.period ORDER BY s.fixes DESC
        ) AS rn
      FROM stationary s
      LEFT JOIN place_cache pc
        ON pc.geo_key = to_char(s.lat_key, 'FM999999990.0000')
          || ',' || to_char(s.lng_key, 'FM999999990.0000')
    )
  `;
}
