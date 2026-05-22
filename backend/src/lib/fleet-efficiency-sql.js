const { sql } = require('drizzle-orm');

/**
 * Per-vehicle distance + fuel consumed from consecutive telemetry readings.
 * Excludes refuel spikes and parked theft drops from consumption totals.
 */
function fleetEfficiencyAggSql({ customerId, days }) {
  return sql`
    WITH readings AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        v.model,
        v.driver_name,
        v.tank_capacity_liters,
        t.odometer_km,
        t.fuel_level_liters::numeric AS fuel_level_liters,
        t.speed_kph,
        t.ignition_on,
        t.recorded_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
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
        ) AS prev_odometer
      FROM readings
    ),
    deltas AS (
      SELECT
        vehicle_id,
        license_plate,
        model,
        driver_name,
        tank_capacity_liters,
        GREATEST(0, COALESCE(odometer_km, 0) - COALESCE(prev_odometer, 0)) AS dist_delta,
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
    SELECT
      vehicle_id,
      license_plate,
      model,
      driver_name,
      tank_capacity_liters,
      COALESCE(SUM(dist_delta), 0)::numeric AS distance_km,
      COALESCE(SUM(fuel_delta), 0)::numeric AS fuel_used_liters
    FROM deltas
    GROUP BY vehicle_id, license_plate, model, driver_name, tank_capacity_liters
    ORDER BY license_plate ASC
  `;
}

module.exports = { fleetEfficiencyAggSql };
