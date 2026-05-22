const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const { db, telemetry, vehicles, fuelPurchases, eq, desc, sql } = require('../lib/db-helpers');
const { fleetEfficiencyAggSql } = require('../lib/fleet-efficiency-sql');
const { dailyActivitySql } = require('../lib/daily-activity-sql');
const {
  CO2_KG_PER_LITER,
  round1,
  round2,
  baselineEfficiencyKmL,
  REFUEL_THRESHOLD_LITERS,
  DEFAULT_FUEL_PRICE_NGN_LITER,
} = require('../lib/fuel-metrics');
const {
  dailyDistanceThreshold,
  evaluateDailyFlags,
  EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
  DAILY_DISTANCE_BY_MODEL,
} = require('../lib/activity-thresholds');
const { generateDemoTracksForFleet } = require('../lib/demo-tracks');

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
  const minutes = Math.min(Number(req.query.minutes) || 90, 240);
  const limit = Math.min(Number(req.query.limit) || 2000, 5000);
  const customerId = req.user.customerId;

  try {
    const recent = await db.execute(sql`
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
      WHERE t.customer_id = ${customerId}
        AND t.recorded_at > NOW() - (${minutes} || ' minutes')::INTERVAL
        AND t.latitude IS NOT NULL
        AND t.longitude IS NOT NULL
      ORDER BY t.vehicle_id ASC, t.recorded_at ASC
      LIMIT ${limit}
    `);

    let rows = recent.rows;
    let source = 'live';

    if (rows.length === 0) {
      const historical = await db.execute(sql`
        WITH ranked AS (
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
            t.recorded_at,
            ROW_NUMBER() OVER (
              PARTITION BY t.vehicle_id ORDER BY t.recorded_at DESC
            ) AS rn
          FROM telemetry t
          JOIN vehicles v ON v.id = t.vehicle_id
          WHERE t.customer_id = ${customerId}
            AND t.recorded_at > NOW() - INTERVAL '7 days'
            AND t.latitude IS NOT NULL
            AND t.longitude IS NOT NULL
        )
        SELECT
          vehicle_id,
          imei,
          license_plate,
          make,
          model,
          driver_name,
          latitude,
          longitude,
          speed_kph,
          fuel_level_liters,
          ignition_on,
          recorded_at
        FROM ranked
        WHERE rn <= 120
        ORDER BY vehicle_id ASC, recorded_at ASC
      `);
      rows = historical.rows;
      source = rows.length > 0 ? 'historical' : source;
    }

    if (rows.length === 0) {
      const fleetResult = await db.execute(sql`
        SELECT
          v.id,
          v.license_plate,
          v.make,
          v.model,
          v.driver_name,
          v.tank_capacity_liters,
          d.imei,
          latest.fuel_level_liters,
          latest.latitude,
          latest.longitude
        FROM vehicles v
        LEFT JOIN devices d ON d.vehicle_id = v.id AND d.customer_id = v.customer_id
        LEFT JOIN LATERAL (
          SELECT fuel_level_liters, latitude, longitude
          FROM telemetry t
          WHERE t.vehicle_id = v.id
          ORDER BY t.recorded_at DESC
          LIMIT 1
        ) latest ON true
        WHERE v.customer_id = ${customerId}
        ORDER BY v.license_plate ASC
      `);
      rows = generateDemoTracksForFleet(fleetResult.rows, { minutes });
      source = 'demo';
    }

    res.setHeader('X-Track-Source', source);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/fleet-efficiency', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

  try {
    const customerId = req.user.customerId;

    const [result, alertRows] = await Promise.all([
      db.execute(fleetEfficiencyAggSql({ customerId, days, pricePerLiter })),
      db.execute(sql`
        SELECT vehicle_id, alert_type, estimated_loss_ngn
        FROM alerts
        WHERE customer_id = ${customerId}
          AND is_resolved = false
      `),
    ]);

    const alertTheftByVehicle = new Map();
    for (const alert of alertRows.rows) {
      if (!alert.vehicle_id) continue;
      const prev = alertTheftByVehicle.get(alert.vehicle_id) || 0;
      const loss =
        alert.alert_type === 'fuel_theft' ? Number(alert.estimated_loss_ngn) || 0 : 0;
      alertTheftByVehicle.set(alert.vehicle_id, prev + loss);
    }

    const rows = result.rows.map((row) => {
      const distanceKm = Number(row.distance_km) || 0;
      const fuelUsed = Number(row.fuel_used_liters) || 0;
      const expectedKmL = baselineEfficiencyKmL(row.model);

      const tankDistance = Number(row.tank_distance_km) || Number(row.distance_since_purchase_km) || 0;
      const tankFuel = Number(row.tank_fuel_used_liters) || Number(row.fuel_since_purchase_liters) || 0;
      const tankEfficiencyKmL =
        tankDistance > 0 && tankFuel >= 0.5 ? tankDistance / tankFuel : null;

      const periodEfficiencyKmL =
        distanceKm > 0 && fuelUsed >= 0.5 ? distanceKm / fuelUsed : null;

      const variancePercent =
        periodEfficiencyKmL != null && expectedKmL > 0
          ? ((periodEfficiencyKmL - expectedKmL) / expectedKmL) * 100
          : null;

      const tankVariancePercent =
        tankEfficiencyKmL != null && expectedKmL > 0
          ? ((tankEfficiencyKmL - expectedKmL) / expectedKmL) * 100
          : null;

      const expectedFuelLiters = expectedKmL > 0 ? distanceKm / expectedKmL : 0;
      const expectedCostNgn = Math.round(expectedFuelLiters * pricePerLiter);

      const purchaseCostNgn = Math.round(Number(row.purchase_cost_ngn) || 0);
      const receiptFraudLossNgn = Math.round(Number(row.receipt_fraud_loss_ngn) || 0);
      const alertTheftLossNgn = alertTheftByVehicle.get(row.vehicle_id) || 0;
      const theftLossNgn = receiptFraudLossNgn + alertTheftLossNgn;

      const actualCostNgn =
        purchaseCostNgn > 0 ? purchaseCostNgn : Math.round(fuelUsed * pricePerLiter);

      const totalLossNgn = actualCostNgn - expectedCostNgn;
      const savingsNgn = expectedCostNgn - actualCostNgn;
      const efficiencyLossNgn = Math.max(0, totalLossNgn - theftLossNgn);

      const co2EmissionsKg = Math.round(fuelUsed * CO2_KG_PER_LITER);

      let status = 'verified';
      if (theftLossNgn > 0) status = 'theft_alert';
      else if (variancePercent != null && variancePercent <= EFFICIENCY_VARIANCE_THRESHOLD_PERCENT) {
        status = 'underperforming';
      }

      return {
        vehicle_id: row.vehicle_id,
        license_plate: row.license_plate,
        driver_name: row.driver_name,
        model: row.model,
        tank_capacity_liters: row.tank_capacity_liters,
        distance_km: Math.round(distanceKm),
        fuel_used_liters: round1(fuelUsed),
        efficiency_km_l: periodEfficiencyKmL != null ? round2(periodEfficiencyKmL) : null,
        expected_efficiency_km_l: expectedKmL,
        variance_percent: variancePercent != null ? round2(variancePercent) : null,
        tank_distance_km: Math.round(tankDistance),
        tank_fuel_used_liters: round1(tankFuel),
        tank_efficiency_km_l: tankEfficiencyKmL != null ? round2(tankEfficiencyKmL) : null,
        tank_variance_percent: tankVariancePercent != null ? round2(tankVariancePercent) : null,
        expected_fuel_liters: round1(expectedFuelLiters),
        expected_cost_ngn: expectedCostNgn,
        actual_cost_ngn: actualCostNgn,
        fuel_cost_ngn: actualCostNgn,
        savings_ngn: Math.round(savingsNgn),
        total_loss_ngn: Math.max(0, Math.round(totalLossNgn)),
        efficiency_loss_ngn: Math.round(efficiencyLossNgn),
        theft_loss_ngn: theftLossNgn,
        receipt_fraud_loss_ngn: receiptFraudLossNgn,
        alert_theft_loss_ngn: alertTheftLossNgn,
        co2_emissions_kg: co2EmissionsKg,
        status,
        period_days: days,
        price_per_liter_ngn: pricePerLiter,
        last_purchase_at: row.last_purchase_at ?? null,
        last_fuel_added_liters:
          row.last_fuel_added_liters != null ? round1(Number(row.last_fuel_added_liters)) : null,
        last_receipt_liters:
          row.last_receipt_liters != null ? round1(Number(row.last_receipt_liters)) : null,
        last_purchase_merchant: row.last_purchase_merchant ?? null,
        distance_since_purchase_km: Math.round(Number(row.distance_since_purchase_km) || 0),
        fuel_since_purchase_liters: round1(Number(row.fuel_since_purchase_liters) || 0),
      };
    });

    const summary = {
      total_distance_km: rows.reduce((s, r) => s + r.distance_km, 0),
      total_fuel_used_liters: round1(rows.reduce((s, r) => s + r.fuel_used_liters, 0)),
      total_expected_cost_ngn: rows.reduce((s, r) => s + r.expected_cost_ngn, 0),
      total_actual_cost_ngn: rows.reduce((s, r) => s + r.actual_cost_ngn, 0),
      total_loss_ngn: rows.reduce((s, r) => s + r.total_loss_ngn, 0),
      total_savings_ngn: rows.reduce((s, r) => s + r.savings_ngn, 0),
      total_theft_loss_ngn: rows.reduce((s, r) => s + r.theft_loss_ngn, 0),
      total_efficiency_loss_ngn: rows.reduce((s, r) => s + r.efficiency_loss_ngn, 0),
      recoverable_ngn: Math.round(rows.reduce((s, r) => s + r.total_loss_ngn, 0) * 0.9),
      price_per_liter_ngn: pricePerLiter,
      period_days: days,
    };

    res.json({ summary, vehicles: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/daily-activity', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 30);

  try {
    const customerId = req.user.customerId;
    const result = await db.execute(dailyActivitySql({ customerId, days }));

    const rows = result.rows.map((row) => {
      const distanceKm = Number(row.distance_km) || 0;
      const fuelUsed = Number(row.fuel_used_liters) || 0;
      const expectedKmL = baselineEfficiencyKmL(row.model);
      const efficiencyKmL =
        distanceKm > 0 && fuelUsed >= 0.5 ? distanceKm / fuelUsed : null;
      const band = dailyDistanceThreshold(row.model);
      const flags = evaluateDailyFlags({
        model: row.model,
        distanceKm,
        efficiencyKmL,
        expectedEfficiencyKmL: expectedKmL,
      });

      return {
        vehicle_id: row.vehicle_id,
        license_plate: row.license_plate,
        driver_name: row.driver_name,
        model: row.model,
        activity_date: row.activity_date,
        distance_km: Math.round(distanceKm),
        fuel_used_liters: round1(fuelUsed),
        efficiency_km_l: efficiencyKmL != null ? round2(efficiencyKmL) : null,
        expected_efficiency_km_l: expectedKmL,
        expected_distance_min_km: band.min,
        expected_distance_max_km: band.max,
        expected_distance_km: band.expected,
        flags,
      };
    });

    res.json({
      period_days: days,
      efficiency_variance_threshold_percent: EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
      daily_distance_by_model: DAILY_DISTANCE_BY_MODEL,
      rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/fuel-purchases', async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;
  const customerId = req.user.customerId;

  try {
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM fuel_purchases WHERE customer_id = ${customerId}
    `);
    const total = countResult.rows[0]?.total ?? 0;

    if (total === 0) {
      return res.json({
        source: 'empty',
        page,
        limit,
        total: 0,
        total_pages: 0,
        purchases: [],
        note: 'Run npm run seed-fuel-purchases after seed-telemetry',
      });
    }

    const rows = await db.execute(sql`
      SELECT
        fp.id,
        fp.vehicle_id,
        v.license_plate,
        fp.purchased_at AS timestamp,
        fp.merchant,
        fp.receipt_reference,
        fp.liters_declared,
        fp.liters_actual,
        fp.cost_per_liter_ngn,
        fp.odometer_km,
        fp.status,
        fp.source
      FROM fuel_purchases fp
      JOIN vehicles v ON v.id = fp.vehicle_id
      WHERE fp.customer_id = ${customerId}
      ORDER BY fp.purchased_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const purchases = rows.rows.map((row) => {
      const declared = Number(row.liters_declared);
      const actual = Number(row.liters_actual);
      const diff = Math.max(0, Math.round((declared - actual) * 10) / 10);
      const costPerLiter = Number(row.cost_per_liter_ngn) || DEFAULT_FUEL_PRICE_NGN_LITER;

      return {
        id: row.id,
        vehicle_id: row.vehicle_id,
        license_plate: row.license_plate,
        timestamp: row.timestamp,
        merchant: row.merchant,
        receipt_reference: row.receipt_reference,
        liters_declared: declared,
        liters_actual: actual,
        difference_liters: diff,
        cost_per_liter_ngn: costPerLiter,
        total_cost_ngn: Math.round(declared * costPerLiter),
        odometer_km: row.odometer_km,
        status: row.status,
        source: row.source,
        actual_from: 'obd_sensor',
      };
    });

    res.json({
      source: 'database',
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      purchases,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/fuel-purchases/receipt', async (req, res) => {
  const {
    vehicle_id: vehicleId,
    liters_declared: litersDeclared,
    merchant,
    receipt_reference: receiptReference,
    purchased_at: purchasedAt,
  } = req.body;

  if (!vehicleId || !litersDeclared) {
    return res.status(400).json({ error: 'vehicle_id and liters_declared are required' });
  }

  try {
    const customerId = req.user.customerId;
    const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);
    const when = purchasedAt ? new Date(purchasedAt) : new Date();

    const obdResult = await db.execute(sql`
      WITH readings AS (
        SELECT fuel_level_liters::numeric AS fuel, recorded_at
        FROM telemetry
        WHERE vehicle_id = ${vehicleId}
          AND customer_id = ${customerId}
          AND recorded_at BETWEEN ${when.toISOString()}::timestamp - INTERVAL '2 hours'
            AND ${when.toISOString()}::timestamp + INTERVAL '2 hours'
        ORDER BY recorded_at ASC
      ),
      ordered AS (
        SELECT fuel, LAG(fuel) OVER (ORDER BY recorded_at) AS prev_fuel FROM readings
      )
      SELECT MAX(fuel - prev_fuel) AS max_refuel
      FROM ordered
      WHERE prev_fuel IS NOT NULL AND fuel - prev_fuel >= ${REFUEL_THRESHOLD_LITERS}
    `);

    const litersActual = Number(obdResult.rows[0]?.max_refuel) || null;
    const declared = Number(litersDeclared);
    const diff =
      litersActual != null ? Math.max(0, Math.round((declared - litersActual) * 10) / 10) : null;

    let status = 'pending_receipt';
    if (litersActual != null) {
      if (diff >= 10) status = 'flagged_theft';
      else if (diff <= 2) status = 'verified';
    }

    const [row] = await db
      .insert(fuelPurchases)
      .values({
        customerId,
        vehicleId,
        purchasedAt: when,
        merchant: merchant || 'Manual entry',
        receiptReference: receiptReference || null,
        litersDeclared: declared.toFixed(2),
        litersActual: litersActual != null ? litersActual.toFixed(2) : null,
        costPerLiterNgn: pricePerLiter,
        status,
        source: 'receipt_upload',
      })
      .returning({ id: fuelPurchases.id });

    res.status(201).json({
      id: row.id,
      liters_declared: declared,
      liters_actual: litersActual,
      difference_liters: diff,
      status,
      actual_from: litersActual != null ? 'obd_sensor' : 'pending_obd_match',
      message:
        litersActual != null
          ? `OBD sensor recorded ${litersActual.toFixed(1)}L added near this time.`
          : 'Receipt saved. Actual liters will match when the next OBD refuel event arrives.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/readings', async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const customerId = req.user.customerId;

  try {
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM telemetry WHERE customer_id = ${customerId}
    `);
    const total = countResult.rows[0]?.total ?? 0;

    const rows = await db.execute(sql`
      SELECT
        t.id,
        t.vehicle_id,
        v.license_plate,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        t.recorded_at,
        t.fuel_level_liters,
        t.odometer_km,
        t.speed_kph,
        t.ignition_on,
        t.latitude,
        t.longitude
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id
      WHERE t.customer_id = ${customerId}
      ORDER BY t.recorded_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    res.json({
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      rows: rows.rows,
    });
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
