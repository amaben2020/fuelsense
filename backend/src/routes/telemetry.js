const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const { db, telemetry, vehicles, fuelPurchases, eq, desc, sql } = require('../lib/db-helpers');
const { fleetEfficiencyAggSql } = require('../lib/fleet-efficiency-sql');
const { dailyActivitySql } = require('../lib/daily-activity-sql');
const { buildDailyActivityReplay } = require('../lib/event-replay');
const {
  CO2_KG_PER_LITER,
  round1,
  round2,
  baselineEfficiencyKmL,
  baselineEfficiencyL100km,
  computeL100km,
  efficiencyDeviationPercentL100km,
  REFUEL_THRESHOLD_LITERS,
  DEFAULT_FUEL_PRICE_NGN_LITER,
} = require('../lib/fuel-metrics');
const {
  dailyDistanceThreshold,
  buildDailyFlags,
  classifyDailyRow,
  formatActivityDateDisplay,
  EFFICIENCY_TIERS,
  EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
  DAILY_DISTANCE_BY_MODEL,
} = require('../lib/activity-thresholds');
const { generateDemoTracksForFleet } = require('../lib/demo-tracks');
const { findObdRefuelMatch, buildReceiptTimeline, assessReceiptEvent } = require('../lib/receipt-reconciliation');

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

    const [result, alertRows, siphonRows] = await Promise.all([
      db.execute(fleetEfficiencyAggSql({ customerId, days, pricePerLiter })),
      db.execute(sql`
        SELECT vehicle_id, alert_type, estimated_loss_ngn
        FROM alerts
        WHERE customer_id = ${customerId}
          AND is_resolved = false
      `),
      db.execute(sql`
        SELECT
          vehicle_id,
          COALESCE(SUM(estimated_loss_ngn), 0)::int AS siphon_loss_ngn
        FROM siphon_events
        WHERE customer_id = ${customerId}
          AND occurred_at > NOW() - (${days} || ' days')::interval
          AND status NOT IN ('resolved', 'false_alarm')
        GROUP BY vehicle_id
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

    const siphonLossByVehicle = new Map(
      siphonRows.rows.map((row) => [row.vehicle_id, Number(row.siphon_loss_ngn) || 0])
    );

    const rows = result.rows.map((row) => {
      const distanceKm = Number(row.distance_km) || 0;
      const fuelUsed = Number(row.fuel_used_liters) || 0;
      const expectedKmL = baselineEfficiencyKmL(row.model);
      const expectedL100km = baselineEfficiencyL100km(row.model);

      const tankDistance = Number(row.tank_distance_km) || Number(row.distance_since_purchase_km) || 0;
      const tankFuel = Number(row.tank_fuel_used_liters) || Number(row.fuel_since_purchase_liters) || 0;
      const tankEfficiencyKmL =
        tankDistance > 0 && tankFuel >= 0.5 ? tankDistance / tankFuel : null;
      const tankEfficiencyL100km = computeL100km(tankFuel, tankDistance);

      const periodEfficiencyKmL =
        distanceKm > 0 && fuelUsed >= 0.5 ? distanceKm / fuelUsed : null;
      const periodEfficiencyL100km = computeL100km(fuelUsed, distanceKm);

      const variancePercent =
        periodEfficiencyL100km != null && expectedL100km > 0
          ? efficiencyDeviationPercentL100km(periodEfficiencyL100km, expectedL100km)
          : null;

      const tankVariancePercent =
        tankEfficiencyL100km != null && expectedL100km > 0
          ? efficiencyDeviationPercentL100km(tankEfficiencyL100km, expectedL100km)
          : null;

      const expectedFuelLiters = expectedKmL > 0 ? distanceKm / expectedKmL : 0;
      const expectedCostNgn = Math.round(expectedFuelLiters * pricePerLiter);

      const purchaseCostNgn = Math.round(Number(row.purchase_cost_ngn) || 0);
      const telemetryCostNgn = Math.round(fuelUsed * pricePerLiter);
      const receiptFraudLossNgn = Math.round(Number(row.receipt_fraud_loss_ngn) || 0);
      const alertTheftLossNgn = alertTheftByVehicle.get(row.vehicle_id) || 0;
      const siphonLossNgn = siphonLossByVehicle.get(row.vehicle_id) || 0;
      const theftLossNgn = receiptFraudLossNgn + alertTheftLossNgn + siphonLossNgn;

      // Receipt spend for finance view; OBD consumption for efficiency comparison
      const actualCostNgn =
        purchaseCostNgn > 0 ? purchaseCostNgn : telemetryCostNgn;

      const efficiencyLossNgn = Math.max(0, telemetryCostNgn - expectedCostNgn);
      const totalLossNgn = theftLossNgn + efficiencyLossNgn;
      const savingsNgn = expectedCostNgn - telemetryCostNgn;

      const co2EmissionsKg = Math.round(fuelUsed * CO2_KG_PER_LITER);

      let status = 'verified';
      if (theftLossNgn > 0) status = 'theft_alert';
      else if (variancePercent != null && variancePercent >= EFFICIENCY_VARIANCE_THRESHOLD_PERCENT) {
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
        efficiency_l_100km: periodEfficiencyL100km,
        expected_efficiency_km_l: expectedKmL,
        expected_efficiency_l_100km: expectedL100km,
        variance_percent: variancePercent != null ? round2(variancePercent) : null,
        tank_distance_km: Math.round(tankDistance),
        tank_fuel_used_liters: round1(tankFuel),
        tank_efficiency_km_l: tankEfficiencyKmL != null ? round2(tankEfficiencyKmL) : null,
        tank_efficiency_l_100km: tankEfficiencyL100km,
        tank_variance_percent: tankVariancePercent != null ? round2(tankVariancePercent) : null,
        expected_fuel_liters: round1(expectedFuelLiters),
        expected_cost_ngn: expectedCostNgn,
        actual_cost_ngn: actualCostNgn,
        telemetry_cost_ngn: telemetryCostNgn,
        fuel_cost_ngn: actualCostNgn,
        savings_ngn: Math.round(savingsNgn),
        total_loss_ngn: Math.round(totalLossNgn),
        efficiency_loss_ngn: Math.round(efficiencyLossNgn),
        theft_loss_ngn: theftLossNgn,
        receipt_fraud_loss_ngn: receiptFraudLossNgn,
        alert_theft_loss_ngn: alertTheftLossNgn,
        siphon_loss_ngn: siphonLossNgn,
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
      total_telemetry_cost_ngn: rows.reduce((s, r) => s + r.telemetry_cost_ngn, 0),
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
  const days = Math.min(Number(req.query.days) || 30, 90);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 50);

  try {
    const customerId = req.user.customerId;
    const result = await db.execute(dailyActivitySql({ customerId, days }));

    const allRows = result.rows.map((row) => {
      const distanceKm = Number(row.distance_km) || 0;
      const fuelUsed = Number(row.fuel_used_liters) || 0;
      const idleHours = Number(row.idle_hours) || 0;
      const tripCount = Number(row.trip_count) || 0;
      const expectedKmL = baselineEfficiencyKmL(row.model);
      const expectedL100km = baselineEfficiencyL100km(row.model);
      const efficiencyL100km = computeL100km(fuelUsed, distanceKm);
      const band = dailyDistanceThreshold(row.model);
      const deviationPercent = efficiencyDeviationPercentL100km(
        efficiencyL100km,
        expectedL100km
      );
      const activityDate =
        row.activity_date instanceof Date
          ? row.activity_date.toISOString().slice(0, 10)
          : String(row.activity_date).slice(0, 10);

      const classification = classifyDailyRow({
        model: row.model,
        distanceKm,
        fuelUsed,
        efficiencyL100km,
        expectedEfficiencyL100km: expectedL100km,
        deviationPercent,
        idleHours,
        tripCount,
      });

      return {
        vehicle_id: row.vehicle_id,
        license_plate: row.license_plate,
        driver_name: row.driver_name,
        model: row.model,
        activity_date: activityDate,
        activity_date_display: formatActivityDateDisplay(activityDate),
        distance_km: Math.round(distanceKm),
        fuel_used_liters: round1(fuelUsed),
        efficiency_l_100km:
          classification.display_efficiency_l_100km != null
            ? classification.display_efficiency_l_100km
            : null,
        raw_efficiency_l_100km: efficiencyL100km,
        expected_efficiency_l_100km: expectedL100km,
        expected_efficiency_km_l: expectedKmL,
        efficiency_deviation_percent: deviationPercent,
        status: classification.status,
        status_label: classification.status_label,
        status_severity: classification.status_severity,
        data_anomaly: classification.data_anomaly,
        insight: classification.insight,
        expected_distance_min_km: band.min,
        expected_distance_max_km: band.max,
        expected_distance_km: band.expected,
        idle_hours: round1(idleHours),
        trip_count: tripCount,
        _flags: buildDailyFlags({
          vehicleId: row.vehicle_id,
          licensePlate: row.license_plate,
          driverName: row.driver_name,
          activityDate,
          model: row.model,
          distanceKm,
          fuelUsed,
          idleHours,
          efficiencyL100km,
          expectedEfficiencyL100km: expectedL100km,
          deviationPercent,
        }),
      };
    });

    const activeFlags = allRows.flatMap((row) => row._flags);
    const total = allRows.length;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const offset = (page - 1) * limit;
    const rows = allRows.slice(offset, offset + limit).map(({ _flags, ...row }) => row);

    res.json({
      period_days: days,
      page,
      limit,
      total,
      total_pages: totalPages,
      efficiency_tiers: EFFICIENCY_TIERS.map((t) => ({
        status: t.status,
        label: t.label,
        severity: t.severity,
        max_deviation_percent: t.maxDeviation,
      })),
      efficiency_variance_threshold_percent: EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
      daily_distance_by_model: DAILY_DISTANCE_BY_MODEL,
      rows,
      active_flags: activeFlags,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/daily-activity/replay', async (req, res) => {
  const customerId = req.user.customerId;
  const vehicleId = String(req.query.vehicle_id || '').trim();
  const date = String(req.query.date || '').trim();
  const flagType = String(req.query.flag_type || 'efficiency').trim();

  if (!vehicleId || !date) {
    return res.status(400).json({ error: 'vehicle_id and date are required' });
  }

  try {
    const replay = await buildDailyActivityReplay({
      customerId,
      vehicleId,
      activityDate: date,
      flagType,
    });
    if (!replay) {
      return res.status(404).json({ error: 'No replay data for this day' });
    }
    res.json(replay);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/fuel-purchases', async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 10, 100);
  const offset = (page - 1) * limit;
  const customerId = req.user.customerId;
  const includeSummary = req.query.include_summary === 'true';

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
        ...(includeSummary
          ? {
              summary: {
                daily_totals: [],
                grand_total: {
                  receipt_count: 0,
                  total_cost_ngn: 0,
                  total_receipt_liters: 0,
                  total_obd_liters: 0,
                },
              },
            }
          : {}),
      });
    }

    const rows = await db.execute(sql`
      SELECT
        fp.id,
        fp.vehicle_id,
        v.license_plate,
        COALESCE(submit_dr.full_name, dr.full_name, v.driver_name) AS driver_name,
        fp.purchased_at AS timestamp,
        fp.obd_refuel_detected_at,
        fp.ignition_on_at,
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
      LEFT JOIN drivers dr ON dr.id = v.driver_id
      LEFT JOIN fuel_receipts fr ON fp.source = 'driver_upload'
        AND fp.receipt_reference = 'DRV-' || upper(substr(fr.id::text, 1, 8))
      LEFT JOIN drivers submit_dr ON submit_dr.id = fr.driver_id
      WHERE fp.customer_id = ${customerId}
      ORDER BY fp.purchased_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const purchases = rows.rows.map((row) => {
      const declared = Number(row.liters_declared);
      const actualRaw = row.liters_actual != null ? Number(row.liters_actual) : null;
      const actual =
        row.status === 'pending_receipt' && (actualRaw == null || actualRaw === 0)
          ? 0
          : actualRaw;
      const diff =
        actual != null ? Math.max(0, Math.round((declared - actual) * 10) / 10) : declared;
      const costPerLiter = Number(row.cost_per_liter_ngn) || DEFAULT_FUEL_PRICE_NGN_LITER;

      return {
        id: row.id,
        vehicle_id: row.vehicle_id,
        license_plate: row.license_plate,
        driver_name: row.driver_name,
        timestamp: row.timestamp,
        purchased_at: row.timestamp,
        obd_refuel_detected_at: row.obd_refuel_detected_at,
        ignition_on_at: row.ignition_on_at,
        timeline: buildReceiptTimeline({
          purchasedAt: row.timestamp,
          obdRefuelDetectedAt: row.obd_refuel_detected_at,
          ignitionOnAt: row.ignition_on_at,
        }),
        event_assessment: assessReceiptEvent({
          purchasedAt: row.timestamp,
          obdRefuelDetectedAt: row.obd_refuel_detected_at,
          ignitionOnAt: row.ignition_on_at,
          litersDeclared: declared,
          litersActual: actual,
          status: row.status,
          merchant: row.merchant,
          licensePlate: row.license_plate,
          costPerLiter,
        }),
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

    let summary;
    if (includeSummary) {
      const dailyResult = await db.execute(sql`
        SELECT
          DATE(fp.purchased_at AT TIME ZONE 'Africa/Lagos') AS activity_date,
          COALESCE(submit_dr.full_name, dr.full_name, v.driver_name, 'Unassigned') AS driver_name,
          SUM(fp.liters_declared::numeric * COALESCE(fp.cost_per_liter_ngn, ${DEFAULT_FUEL_PRICE_NGN_LITER}))::int AS total_cost_ngn,
          SUM(fp.liters_declared::numeric)::numeric AS total_receipt_liters,
          SUM(COALESCE(fp.liters_actual::numeric, 0))::numeric AS total_obd_liters,
          COUNT(*)::int AS receipt_count
        FROM fuel_purchases fp
        JOIN vehicles v ON v.id = fp.vehicle_id
        LEFT JOIN drivers dr ON dr.id = v.driver_id
        LEFT JOIN fuel_receipts fr ON fp.source = 'driver_upload'
          AND fp.receipt_reference = 'DRV-' || upper(substr(fr.id::text, 1, 8))
        LEFT JOIN drivers submit_dr ON submit_dr.id = fr.driver_id
        WHERE fp.customer_id = ${customerId}
        GROUP BY 1, 2
        ORDER BY 1 DESC, 2 ASC
      `);

      const grandResult = await db.execute(sql`
        SELECT
          SUM(fp.liters_declared::numeric * COALESCE(fp.cost_per_liter_ngn, ${DEFAULT_FUEL_PRICE_NGN_LITER}))::int AS total_cost_ngn,
          SUM(fp.liters_declared::numeric)::numeric AS total_receipt_liters,
          SUM(COALESCE(fp.liters_actual::numeric, 0))::numeric AS total_obd_liters,
          COUNT(*)::int AS receipt_count
        FROM fuel_purchases fp
        WHERE fp.customer_id = ${customerId}
      `);

      const grand = grandResult.rows[0] ?? {};
      summary = {
        daily_totals: dailyResult.rows.map((row) => ({
          activity_date: row.activity_date,
          driver_name: row.driver_name,
          receipt_count: Number(row.receipt_count),
          total_cost_ngn: Number(row.total_cost_ngn),
          total_receipt_liters: Math.round(Number(row.total_receipt_liters) * 10) / 10,
          total_obd_liters: Math.round(Number(row.total_obd_liters) * 10) / 10,
        })),
        grand_total: {
          receipt_count: Number(grand.receipt_count) || 0,
          total_cost_ngn: Number(grand.total_cost_ngn) || 0,
          total_receipt_liters: Math.round(Number(grand.total_receipt_liters || 0) * 10) / 10,
          total_obd_liters: Math.round(Number(grand.total_obd_liters || 0) * 10) / 10,
        },
      };
    }

    res.json({
      source: 'database',
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      purchases,
      ...(summary ? { summary } : {}),
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

    const obdMatch = await findObdRefuelMatch({
      vehicleId,
      customerId,
      transactionDate: when,
    });

    const litersActual = obdMatch.liters;
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
        obdRefuelDetectedAt: obdMatch.obdRefuelDetectedAt,
        ignitionOnAt: obdMatch.ignitionOnAt,
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
      purchased_at: when.toISOString(),
      obd_refuel_detected_at: obdMatch.obdRefuelDetectedAt?.toISOString() ?? null,
      ignition_on_at: obdMatch.ignitionOnAt?.toISOString() ?? null,
      timeline: buildReceiptTimeline({
        purchasedAt: when,
        obdRefuelDetectedAt: obdMatch.obdRefuelDetectedAt,
        ignitionOnAt: obdMatch.ignitionOnAt,
      }),
      actual_from: litersActual != null ? 'obd_sensor' : 'pending_obd_match',
      message:
        litersActual != null
          ? `OBD recorded ${litersActual.toFixed(1)}L at ${obdMatch.obdRefuelDetectedAt?.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Lagos' }) ?? 'refuel time'}.`
          : 'Receipt saved. OBD timestamps will attach when a refuel event is detected nearby.',
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
