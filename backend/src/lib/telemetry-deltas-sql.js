const { sql } = require('drizzle-orm');

/** Shared telemetry delta CTEs — capped distance, consumption-only fuel deltas. */
function telemetryDeltasCte({ customerId, days }) {
  return sql`
    readings AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        v.model,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        v.tank_capacity_liters,
        t.odometer_km,
        t.fuel_level_liters::numeric AS fuel_level_liters,
        t.speed_kph,
        t.ignition_on,
        t.recorded_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
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
      WHERE prev_fuel IS NOT NULL
    )
  `;
}

module.exports = { telemetryDeltasCte };
