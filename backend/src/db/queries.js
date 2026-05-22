const { sql } = require('drizzle-orm');

const getFleetByCustomerId = async (dbOrTx, customerId) => {
  const result = await dbOrTx.execute(sql`
    SELECT
      v.id,
      v.license_plate,
      v.make,
      v.model,
      v.year,
      v.tank_capacity_liters,
      v.driver_name,
      d.imei,
      d.device_model,
      d.last_seen_at,
      d.is_active AS device_active,
      t.fuel_level_liters,
      t.odometer_km,
      t.ignition_on,
      t.latitude,
      t.longitude,
      t.speed_kph,
      t.recorded_at AS last_telemetry_at,
      CASE
        WHEN d.imei IS NULL THEN 'no_device'
        WHEN d.last_seen_at > NOW() - INTERVAL '15 minutes' THEN 'online'
        ELSE 'offline'
      END AS connection_status
    FROM vehicles v
    LEFT JOIN devices d ON d.vehicle_id = v.id AND d.customer_id = v.customer_id
    LEFT JOIN LATERAL (
      SELECT fuel_level_liters, odometer_km, ignition_on, latitude, longitude, speed_kph, recorded_at
      FROM telemetry
      WHERE vehicle_id = v.id AND customer_id = v.customer_id
      ORDER BY recorded_at DESC
      LIMIT 1
    ) t ON true
    WHERE v.customer_id = ${customerId}
    ORDER BY v.license_plate ASC
  `);
  return result.rows;
};

module.exports = { getFleetByCustomerId };
