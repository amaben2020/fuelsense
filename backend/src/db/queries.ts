import { sql } from 'drizzle-orm';
import type { db as DbType } from './index';

type DbOrTx = typeof DbType | Parameters<Parameters<typeof DbType.transaction>[0]>[0];

export const getFleetByCustomerId = async (dbOrTx: DbOrTx, customerId: string): Promise<unknown[]> => {
  const result = await (dbOrTx as typeof DbType).execute(sql`
    SELECT
      v.id,
      v.license_plate,
      v.make,
      v.model,
      v.year,
      v.tank_capacity_liters,
      COALESCE(dr.full_name, v.driver_name) AS driver_name,
      v.driver_id,
      d.imei,
      d.device_model,
      d.last_seen_at,
      d.is_active AS device_active,
      CASE
        WHEN vt.vehicle_id IS NOT NULL AND (t.fuel_source = 'virtual' OR t.fuel_source IS NULL OR t.fuel_level_liters IS NULL)
          THEN ROUND(vt.level_ml / 1000.0, 2)
        ELSE t.fuel_level_liters
      END AS fuel_level_liters,
      t.fuel_source,
      t.fuel_rate_lph,
      t.odometer_km,
      t.ignition_on,
      -- A parked vehicle indoors reports 0 satellites, so its newest rows carry
      -- no fix. Fall back to the last known position rather than dropping the
      -- vehicle off the map entirely.
      COALESCE(t.latitude, lastfix.latitude) AS latitude,
      COALESCE(t.longitude, lastfix.longitude) AS longitude,
      lastfix.recorded_at AS last_gps_fix_at,
      (t.latitude IS NULL AND lastfix.latitude IS NOT NULL) AS gps_stale,
      t.speed_kph,
      t.recorded_at AS last_telemetry_at,
      vt.capacity_liters AS virtual_tank_capacity_liters,
      ROUND(vt.level_ml / 1000.0, 2) AS virtual_tank_liters,
      vt.confidence AS virtual_tank_confidence,
      vt.calibrated_at AS virtual_tank_calibrated_at,
      vt.learned_idle_lph,
      CASE
        WHEN d.imei IS NULL THEN 'no_device'
        WHEN d.last_seen_at > NOW() - INTERVAL '15 minutes' THEN 'online'
        ELSE 'offline'
      END AS connection_status
    FROM vehicles v
    LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
    LEFT JOIN devices d ON d.vehicle_id = v.id AND d.customer_id = v.customer_id
    LEFT JOIN virtual_tanks vt ON vt.vehicle_id = v.id
    LEFT JOIN LATERAL (
      SELECT fuel_level_liters, fuel_source, fuel_rate_lph, odometer_km, ignition_on, latitude, longitude, speed_kph, recorded_at
      FROM telemetry
      WHERE vehicle_id = v.id AND customer_id = v.customer_id
      ORDER BY recorded_at DESC
      LIMIT 1
    ) t ON true
    LEFT JOIN LATERAL (
      SELECT latitude, longitude, recorded_at
      FROM telemetry
      WHERE vehicle_id = v.id AND customer_id = v.customer_id AND latitude IS NOT NULL
      ORDER BY recorded_at DESC
      LIMIT 1
    ) lastfix ON true
    WHERE v.customer_id = ${customerId}
    ORDER BY v.license_plate ASC
  `);
  return result.rows;
};
