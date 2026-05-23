const { sql } = require('drizzle-orm');
const { telemetryDeltasCte } = require('./telemetry-deltas-sql');

function dailyActivitySql({ customerId, days }) {
  return sql`
    WITH ${telemetryDeltasCte({ customerId, days })},
    ordered_readings AS (
      SELECT
        t.vehicle_id,
        v.license_plate,
        v.model,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        t.recorded_at,
        t.speed_kph,
        t.ignition_on,
        LAG(t.recorded_at) OVER (
          PARTITION BY t.vehicle_id ORDER BY t.recorded_at
        ) AS prev_recorded_at,
        LAG(t.ignition_on) OVER (
          PARTITION BY t.vehicle_id ORDER BY t.recorded_at
        ) AS prev_ignition_on
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
    ),
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
    ),
    daily_idle AS (
      SELECT
        vehicle_id,
        DATE(recorded_at AT TIME ZONE 'Africa/Lagos') AS activity_date,
        COALESCE(
          SUM(
            CASE
              WHEN prev_recorded_at IS NOT NULL
                AND COALESCE(speed_kph, 0) < 2
                AND COALESCE(ignition_on, false)
              THEN EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)) / 3600.0
              ELSE 0
            END
          ),
          0
        )::numeric AS idle_hours
      FROM ordered_readings
      GROUP BY vehicle_id, DATE(recorded_at AT TIME ZONE 'Africa/Lagos')
    ),
    daily_trips AS (
      SELECT
        vehicle_id,
        DATE(recorded_at AT TIME ZONE 'Africa/Lagos') AS activity_date,
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(ignition_on, false)
                AND NOT COALESCE(prev_ignition_on, false)
              THEN 1
              ELSE 0
            END
          ),
          0
        )::int AS trip_count
      FROM ordered_readings
      GROUP BY vehicle_id, DATE(recorded_at AT TIME ZONE 'Africa/Lagos')
    )
    SELECT
      d.*,
      COALESCE(i.idle_hours, 0)::numeric AS idle_hours,
      COALESCE(t.trip_count, 0)::int AS trip_count
    FROM daily d
    LEFT JOIN daily_idle i
      ON i.vehicle_id = d.vehicle_id AND i.activity_date = d.activity_date
    LEFT JOIN daily_trips t
      ON t.vehicle_id = d.vehicle_id AND t.activity_date = d.activity_date
    WHERE d.distance_km > 0 OR d.fuel_used_liters > 0.1
    ORDER BY d.activity_date DESC, d.license_plate ASC
  `;
}

module.exports = { dailyActivitySql };
