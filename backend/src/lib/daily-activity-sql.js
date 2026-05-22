const { sql } = require('drizzle-orm');
const { telemetryDeltasCte } = require('./telemetry-deltas-sql');

function dailyActivitySql({ customerId, days }) {
  return sql`
    WITH ${telemetryDeltasCte({ customerId, days })},
    daily AS (
      SELECT
        vehicle_id,
        license_plate,
        model,
        driver_name,
        DATE(recorded_at AT TIME ZONE 'Africa/Lagos') AS activity_date,
        COALESCE(SUM(dist_delta), 0)::numeric AS distance_km,
        COALESCE(SUM(fuel_delta), 0)::numeric AS fuel_used_liters
      FROM deltas
      GROUP BY vehicle_id, license_plate, model, driver_name, DATE(recorded_at AT TIME ZONE 'Africa/Lagos')
    )
    SELECT *
    FROM daily
    WHERE distance_km > 0 OR fuel_used_liters > 0.1
    ORDER BY activity_date DESC, license_plate ASC
  `;
}

module.exports = { dailyActivitySql };
