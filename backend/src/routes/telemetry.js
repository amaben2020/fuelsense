const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const { db, telemetry, vehicles, eq, desc, sql } = require('../lib/db-helpers');

const router = express.Router();

router.use(authenticateCustomer);

router.get('/latest', async (req, res) => {
  try {
    const [row] = await db
      .select({
        id: telemetry.id,
        imei: telemetry.imei,
        customer_id: telemetry.customerId,
        vehicle_id: telemetry.vehicleId,
        recorded_at: telemetry.recordedAt,
        fuel_level_liters: telemetry.fuelLevelLiters,
        odometer_km: telemetry.odometerKm,
        latitude: telemetry.latitude,
        longitude: telemetry.longitude,
        speed_kph: telemetry.speedKph,
        ignition_on: telemetry.ignitionOn,
        created_at: telemetry.createdAt,
        license_plate: vehicles.licensePlate,
      })
      .from(telemetry)
      .leftJoin(vehicles, eq(telemetry.vehicleId, vehicles.id))
      .where(eq(telemetry.customerId, req.user.customerId))
      .orderBy(desc(telemetry.recordedAt))
      .limit(1);

    res.json(row || null);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  try {
    const rows = await db
      .select({
        id: telemetry.id,
        imei: telemetry.imei,
        customer_id: telemetry.customerId,
        vehicle_id: telemetry.vehicleId,
        recorded_at: telemetry.recordedAt,
        fuel_level_liters: telemetry.fuelLevelLiters,
        odometer_km: telemetry.odometerKm,
        latitude: telemetry.latitude,
        longitude: telemetry.longitude,
        speed_kph: telemetry.speedKph,
        ignition_on: telemetry.ignitionOn,
        created_at: telemetry.createdAt,
        license_plate: vehicles.licensePlate,
      })
      .from(telemetry)
      .leftJoin(vehicles, eq(telemetry.vehicleId, vehicles.id))
      .where(eq(telemetry.customerId, req.user.customerId))
      .orderBy(desc(telemetry.recordedAt))
      .limit(limit);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tracks', async (req, res) => {
  const minutes = Math.min(Number(req.query.minutes) || 60, 240);
  const limit = Math.min(Number(req.query.limit) || 2000, 5000);

  try {
    const result = await db.execute(sql`
      SELECT
        t.vehicle_id,
        t.imei,
        v.license_plate,
        v.make,
        v.model,
        v.driver_name,
        t.latitude,
        t.longitude,
        t.speed_kph,
        t.fuel_level_liters,
        t.ignition_on,
        t.recorded_at
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      WHERE t.customer_id = ${req.user.customerId}
        AND t.recorded_at > NOW() - (${minutes} || ' minutes')::INTERVAL
        AND t.latitude IS NOT NULL
        AND t.longitude IS NOT NULL
      ORDER BY t.vehicle_id ASC, t.recorded_at ASC
      LIMIT ${limit}
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/fleet-efficiency', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || 650);
  const co2KgPerLiter = 2.35;

  try {
    const result = await db.execute(sql`
      WITH readings AS (
        SELECT
          t.vehicle_id,
          v.license_plate,
          v.tank_capacity_liters,
          t.odometer_km,
          t.fuel_level_liters::numeric AS fuel_level_liters,
          t.recorded_at
        FROM telemetry t
        JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.customer_id = ${req.user.customerId}
          AND t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
      ),
      agg AS (
        SELECT
          vehicle_id,
          license_plate,
          tank_capacity_liters,
          MIN(odometer_km) FILTER (WHERE odometer_km IS NOT NULL) AS odometer_start,
          MAX(odometer_km) FILTER (WHERE odometer_km IS NOT NULL) AS odometer_end,
          MAX(fuel_level_liters) AS fuel_max,
          MIN(fuel_level_liters) AS fuel_min
        FROM readings
        GROUP BY vehicle_id, license_plate, tank_capacity_liters
      )
      SELECT
        vehicle_id,
        license_plate,
        tank_capacity_liters,
        GREATEST(0, COALESCE(odometer_end, 0) - COALESCE(odometer_start, 0)) AS distance_km,
        GREATEST(0, COALESCE(fuel_max, 0) - COALESCE(fuel_min, 0)) AS fuel_used_liters
      FROM agg
      ORDER BY license_plate ASC
    `);

    const rows = result.rows.map((row) => {
      const distanceKm = Number(row.distance_km) || 0;
      const fuelUsed = Number(row.fuel_used_liters) || 0;
      const efficiencyKmL = fuelUsed > 0 ? distanceKm / fuelUsed : null;
      const fuelCostNgn = Math.round(fuelUsed * pricePerLiter);
      const co2EmissionsKg = Math.round(fuelUsed * co2KgPerLiter);

      return {
        vehicle_id: row.vehicle_id,
        license_plate: row.license_plate,
        tank_capacity_liters: row.tank_capacity_liters,
        distance_km: Math.round(distanceKm),
        fuel_used_liters: Math.round(fuelUsed * 10) / 10,
        efficiency_km_l: efficiencyKmL != null ? Math.round(efficiencyKmL * 100) / 100 : null,
        fuel_cost_ngn: fuelCostNgn,
        co2_emissions_kg: co2EmissionsKg,
        period_days: days,
      };
    });

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/efficiency', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 90);

  try {
    const result = await db.execute(sql`
      SELECT
        DATE(recorded_at) as date,
        AVG(odometer_km) as avg_odometer,
        AVG(fuel_level_liters) as avg_fuel
      FROM telemetry
      WHERE customer_id = ${req.user.customerId}
        AND recorded_at > NOW() - (${days} || ' days')::INTERVAL
      GROUP BY DATE(recorded_at)
      ORDER BY date DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
