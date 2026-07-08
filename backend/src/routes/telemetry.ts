import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, telemetry, vehicles, fuelPurchases, eq, desc, sql } from '../lib/db-helpers';
import { withCache, invalidate, cacheKey } from '../lib/redis';
import { fleetEfficiencyAggSql } from '../lib/fleet-efficiency-sql';
import { dailyActivitySql } from '../lib/daily-activity-sql';
import { buildDailyActivityReplay } from '../lib/event-replay';
import { segmentTrips, TelemetryTripPoint } from '../lib/trip-segmentation';
import {
  CO2_KG_PER_LITER,
  round1,
  round2,
  baselineEfficiencyKmL,
  baselineEfficiencyL100km,
  computeL100km,
  efficiencyDeviationPercentL100km,
  REFUEL_THRESHOLD_LITERS,
  DEFAULT_FUEL_PRICE_NGN_LITER,
  IDLE_BURN_LITERS_PER_HOUR,
} from '../lib/fuel-metrics';
import {
  dailyDistanceThreshold,
  buildDailyFlags,
  classifyDailyRow,
  formatActivityDateDisplay,
  EFFICIENCY_TIERS,
  EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
  DAILY_DISTANCE_BY_MODEL,
} from '../lib/activity-thresholds';
import { findObdRefuelMatch, buildReceiptTimeline, assessReceiptEvent } from '../lib/receipt-reconciliation';

const router = express.Router();

router.use(authenticateCustomer);

router.get('/latest', async (req: Request, res: Response) => {
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
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/history', async (req: Request, res: Response) => {
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
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/tracks', async (req: Request, res: Response) => {
  const minutes = Math.min(Number(req.query.minutes) || 1440, 1440);
  const limit = Math.min(Number(req.query.limit) || 2000, 5000);
  const customerId = req.user.customerId;

  // Shared column list to avoid repetition across three fallback queries
  const trackColumns = sql`
    t.vehicle_id, t.imei, v.license_plate, v.make, v.model, v.driver_name,
    t.latitude, t.longitude, t.speed_kph, t.fuel_level_liters,
    t.ignition_on, t.recorded_at
  `;
  const validGps = sql`
    t.latitude IS NOT NULL AND t.longitude IS NOT NULL
    AND (t.latitude::numeric != 0 OR t.longitude::numeric != 0)
  `;

  try {
    const key = cacheKey(customerId, 'tracks', String(minutes));
    const cached = await withCache(key, 4, async () => {
      // Tier 1 — live window (user-selected trail duration)
      const recent = await db.execute(sql`
        SELECT ${trackColumns}
        FROM telemetry t
        JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.customer_id = ${customerId}
          AND t.recorded_at > NOW() - (${minutes} || ' minutes')::INTERVAL
          AND ${validGps}
        ORDER BY t.vehicle_id ASC, t.recorded_at ASC
        LIMIT ${limit}
      `);

      let rows = recent.rows;
      let source = 'live';

      // Tier 2 — historical trail (last 30 days) when live window is empty
      if (rows.length === 0) {
        const historical = await db.execute(sql`
          WITH ranked AS (
            SELECT ${trackColumns},
              ROW_NUMBER() OVER (PARTITION BY t.vehicle_id ORDER BY t.recorded_at DESC) AS rn
            FROM telemetry t
            JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.customer_id = ${customerId}
              AND t.recorded_at > NOW() - INTERVAL '30 days'
              AND ${validGps}
          )
          SELECT vehicle_id, imei, license_plate, make, model, driver_name,
                 latitude, longitude, speed_kph, fuel_level_liters, ignition_on, recorded_at
          FROM ranked WHERE rn <= ${limit}
          ORDER BY vehicle_id ASC, recorded_at ASC
        `);
        rows = historical.rows;
        source = rows.length > 0 ? 'historical' : source;
      }

      // Tier 3 — last known position (no time limit) — ensures the car is always on the map
      // even after extended offline periods. Returns one point per vehicle; no trail line
      // renders (path.length < 2) but the car marker always appears at its last position.
      if (rows.length === 0) {
        const lastKnown = await db.execute(sql`
          WITH ranked AS (
            SELECT ${trackColumns},
              ROW_NUMBER() OVER (PARTITION BY t.vehicle_id ORDER BY t.recorded_at DESC) AS rn
            FROM telemetry t
            JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.customer_id = ${customerId}
              AND ${validGps}
          )
          SELECT vehicle_id, imei, license_plate, make, model, driver_name,
                 latitude, longitude, speed_kph, fuel_level_liters, ignition_on, recorded_at
          FROM ranked WHERE rn = 1
          ORDER BY vehicle_id ASC
        `);
        rows = lastKnown.rows;
        source = rows.length > 0 ? 'last_known' : source;
      }

      return { rows, source };
    }); // end withCache

    res.setHeader('X-Track-Source', cached.source);
    res.json(cached.rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Server-side trip segmentation — no point cap, simplified paths.
// A trip ends after 30+ minutes of ignition-off / tracker silence.
router.get('/trips', async (req: Request, res: Response) => {
  const minutes = Math.min(Number(req.query.minutes) || 1440, 43200); // up to 30 days
  const customerId = req.user.customerId;
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

  try {
    const key = cacheKey(customerId, 'trips', String(minutes));
    const cached = await withCache(key, 15, async () => {
      const tripColumns = sql`
        t.vehicle_id,
        v.license_plate,
        v.model,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        t.latitude::double precision AS lat,
        t.longitude::double precision AS lng,
        t.speed_kph,
        t.ignition_on,
        t.recorded_at
      `;
      const tripValidGps = sql`
        t.latitude IS NOT NULL AND t.longitude IS NOT NULL
        AND (t.latitude::numeric != 0 OR t.longitude::numeric != 0)
      `;

      const result = await db.execute(sql`
        SELECT ${tripColumns}
        FROM telemetry t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
        WHERE t.customer_id = ${customerId}
          AND t.recorded_at > NOW() - (${minutes} || ' minutes')::INTERVAL
          AND ${tripValidGps}
        ORDER BY t.vehicle_id ASC, t.recorded_at ASC
      `);

      let rows = result.rows;
      let source = 'live';

      // Same fallback the /tracks trail uses: when the window is empty
      // (vehicle parked for days), show the most recent journeys instead
      // of an empty panel next to a visible historical trail.
      if (rows.length === 0) {
        const historical = await db.execute(sql`
          WITH ranked AS (
            SELECT ${tripColumns},
              ROW_NUMBER() OVER (PARTITION BY t.vehicle_id ORDER BY t.recorded_at DESC) AS rn
            FROM telemetry t
            JOIN vehicles v ON v.id = t.vehicle_id
            LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
            WHERE t.customer_id = ${customerId}
              AND t.recorded_at > NOW() - INTERVAL '30 days'
              AND ${tripValidGps}
          )
          SELECT vehicle_id, license_plate, model, driver_name,
                 lat, lng, speed_kph, ignition_on, recorded_at
          FROM ranked WHERE rn <= 15000
          ORDER BY vehicle_id ASC, recorded_at ASC
        `);
        rows = historical.rows;
        if (rows.length > 0) source = 'historical';
      }

      const byVehicle = new Map<
        string,
        {
          license_plate: string;
          model: string | null;
          driver_name: string | null;
          points: TelemetryTripPoint[];
        }
      >();
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        const vid = String(row.vehicle_id);
        if (!byVehicle.has(vid)) {
          byVehicle.set(vid, {
            license_plate: String(row.license_plate),
            model: row.model != null ? String(row.model) : null,
            driver_name: row.driver_name != null ? String(row.driver_name) : null,
            points: [],
          });
        }
        byVehicle.get(vid)!.points.push({
          lat: Number(row.lat),
          lng: Number(row.lng),
          speedKph: row.speed_kph != null ? Number(row.speed_kph) : null,
          ignitionOn: row.ignition_on == null ? null : Boolean(row.ignition_on),
          recordedAt: new Date(row.recorded_at as string),
        });
      }

      const nowMs = Date.now();
      const vehicleTrips = Array.from(byVehicle.entries()).map(([vehicleId, v]) => {
        const efficiencyKmL = baselineEfficiencyKmL(v.model ?? '');
        // Same methodology as the fuel estimate: driving + engine-idle burn
        const trips = segmentTrips(v.points, nowMs).map((trip) => {
          const fuel = round1(
            trip.distance_km / efficiencyKmL +
              (trip.idle_minutes / 60) * IDLE_BURN_LITERS_PER_HOUR
          );
          return {
            ...trip,
            estimated_fuel_liters: fuel,
            estimated_cost_ngn: Math.round(fuel * pricePerLiter),
          };
        });
        return {
          vehicle_id: vehicleId,
          license_plate: v.license_plate,
          model: v.model,
          driver_name: v.driver_name,
          trips,
          total_distance_km:
            Math.round(trips.reduce((s, t) => s + t.distance_km, 0) * 10) / 10,
          total_fuel_liters: round1(trips.reduce((s, t) => s + t.estimated_fuel_liters, 0)),
          total_cost_ngn: trips.reduce((s, t) => s + t.estimated_cost_ngn, 0),
        };
      });

      return {
        period_minutes: minutes,
        source,
        price_per_liter_ngn: pricePerLiter,
        vehicles: vehicleTrips,
      };
    });

    res.json(cached);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/fleet-efficiency', async (req: Request, res: Response) => {
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

    const alertTheftByVehicle = new Map<string, number>();
    for (const alert of alertRows.rows) {
      const a = alert as Record<string, unknown>;
      if (!a.vehicle_id) continue;
      const prev = alertTheftByVehicle.get(a.vehicle_id as string) || 0;
      const loss =
        a.alert_type === 'fuel_theft' ? Number(a.estimated_loss_ngn) || 0 : 0;
      alertTheftByVehicle.set(a.vehicle_id as string, prev + loss);
    }

    const siphonLossByVehicle = new Map<string, number>(
      siphonRows.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return [r.vehicle_id as string, Number(r.siphon_loss_ngn) || 0];
      })
    );

    const rows = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const distanceKm = Number(r.distance_km) || 0;
      const fuelUsed = Number(r.fuel_used_liters) || 0;
      const expectedKmL = baselineEfficiencyKmL(r.model as string | null | undefined);
      const expectedL100km = baselineEfficiencyL100km(r.model as string | null | undefined);

      const tankDistance = Number(r.tank_distance_km) || Number(r.distance_since_purchase_km) || 0;
      const tankFuel = Number(r.tank_fuel_used_liters) || Number(r.fuel_since_purchase_liters) || 0;
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

      const purchaseCostNgn = Math.round(Number(r.purchase_cost_ngn) || 0);
      const telemetryCostNgn = Math.round(fuelUsed * pricePerLiter);
      const receiptFraudLossNgn = Math.round(Number(r.receipt_fraud_loss_ngn) || 0);
      const alertTheftLossNgn = alertTheftByVehicle.get(r.vehicle_id as string) || 0;
      const siphonLossNgn = siphonLossByVehicle.get(r.vehicle_id as string) || 0;
      const theftLossNgn = receiptFraudLossNgn + alertTheftLossNgn + siphonLossNgn;

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
        vehicle_id: r.vehicle_id,
        license_plate: r.license_plate,
        driver_name: r.driver_name,
        model: r.model,
        tank_capacity_liters: r.tank_capacity_liters,
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
        last_purchase_at: r.last_purchase_at ?? null,
        last_fuel_added_liters:
          r.last_fuel_added_liters != null ? round1(Number(r.last_fuel_added_liters)) : null,
        last_receipt_liters:
          r.last_receipt_liters != null ? round1(Number(r.last_receipt_liters)) : null,
        last_purchase_merchant: r.last_purchase_merchant ?? null,
        distance_since_purchase_km: Math.round(Number(r.distance_since_purchase_km) || 0),
        fuel_since_purchase_liters: round1(Number(r.fuel_since_purchase_liters) || 0),
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
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/daily-activity', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 50);

  try {
    const customerId = req.user.customerId;
    const result = await db.execute(dailyActivitySql({ customerId, days }));

    const allRows = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const distanceKm = Number(r.distance_km) || 0;
      const fuelUsed = Number(r.fuel_used_liters) || 0;
      const idleHours = Number(r.idle_hours) || 0;
      const tripCount = Number(r.trip_count) || 0;
      const expectedKmL = baselineEfficiencyKmL(r.model as string | null | undefined);
      const expectedL100km = baselineEfficiencyL100km(r.model as string | null | undefined);
      const efficiencyL100km = computeL100km(fuelUsed, distanceKm);
      const band = dailyDistanceThreshold(r.model as string | null | undefined);
      const deviationPercent = efficiencyDeviationPercentL100km(
        efficiencyL100km,
        expectedL100km
      );
      const activityDate =
        r.activity_date instanceof Date
          ? r.activity_date.toISOString().slice(0, 10)
          : String(r.activity_date).slice(0, 10);

      const classification = classifyDailyRow({
        model: r.model as string | undefined,
        distanceKm,
        fuelUsed,
        efficiencyL100km,
        expectedEfficiencyL100km: expectedL100km,
        deviationPercent,
        idleHours,
        tripCount,
      });

      return {
        vehicle_id: r.vehicle_id,
        license_plate: r.license_plate,
        driver_name: r.driver_name,
        model: r.model,
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
          vehicleId: r.vehicle_id as string,
          licensePlate: r.license_plate as string,
          driverName: r.driver_name as string | null,
          activityDate,
          model: r.model as string | null,
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
    const rows = allRows.slice(offset, offset + limit).map(({ _flags: _f, ...row }) => row);

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
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/daily-activity/replay', async (req: Request, res: Response) => {
  const customerId = req.user.customerId;
  const vehicleId = String(req.query.vehicle_id || '').trim();
  const date = String(req.query.date || '').trim();
  const flagType = String(req.query.flag_type || 'efficiency').trim();

  if (!vehicleId || !date) {
    res.status(400).json({ error: 'vehicle_id and date are required' });
    return;
  }

  try {
    const replay = await buildDailyActivityReplay({
      customerId,
      vehicleId,
      activityDate: date,
      flagType,
    });
    if (!replay) {
      res.status(404).json({ error: 'No replay data for this day' });
      return;
    }
    res.json(replay);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/fuel-purchases', async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 10, 100);
  const offset = (page - 1) * limit;
  const customerId = req.user.customerId;
  const includeSummary = req.query.include_summary === 'true';

  try {
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM fuel_purchases WHERE customer_id = ${customerId}
    `);
    const total = (countResult.rows[0] as Record<string, unknown>)?.total ?? 0;

    if (total === 0) {
      res.json({
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
      return;
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
      const r = row as Record<string, unknown>;
      const declared = Number(r.liters_declared);
      const actualRaw = r.liters_actual != null ? Number(r.liters_actual) : null;
      const actual =
        r.status === 'pending_receipt' && (actualRaw == null || actualRaw === 0)
          ? 0
          : actualRaw;
      const diff =
        actual != null ? Math.max(0, Math.round((declared - actual) * 10) / 10) : declared;
      const costPerLiter = Number(r.cost_per_liter_ngn) || DEFAULT_FUEL_PRICE_NGN_LITER;

      return {
        id: r.id,
        vehicle_id: r.vehicle_id,
        license_plate: r.license_plate,
        driver_name: r.driver_name,
        timestamp: r.timestamp,
        purchased_at: r.timestamp,
        obd_refuel_detected_at: r.obd_refuel_detected_at,
        ignition_on_at: r.ignition_on_at,
        timeline: buildReceiptTimeline({
          purchasedAt: r.timestamp as Date,
          obdRefuelDetectedAt: r.obd_refuel_detected_at as Date | null,
          ignitionOnAt: r.ignition_on_at as Date | null,
        }),
        event_assessment: assessReceiptEvent({
          purchasedAt: r.timestamp as Date,
          obdRefuelDetectedAt: r.obd_refuel_detected_at as Date | null,
          ignitionOnAt: r.ignition_on_at as Date | null,
          litersDeclared: declared,
          litersActual: actual,
          status: r.status as string,
          merchant: r.merchant as string | null,
          licensePlate: r.license_plate as string,
          costPerLiter,
        }),
        merchant: r.merchant,
        receipt_reference: r.receipt_reference,
        liters_declared: declared,
        liters_actual: actual,
        difference_liters: diff,
        cost_per_liter_ngn: costPerLiter,
        total_cost_ngn: Math.round(declared * costPerLiter),
        odometer_km: r.odometer_km,
        status: r.status,
        source: r.source,
        actual_from: 'obd_sensor',
      };
    });

    let summary: unknown;
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

      const grand = (grandResult.rows[0] ?? {}) as Record<string, unknown>;
      summary = {
        daily_totals: dailyResult.rows.map((row) => {
          const r = row as Record<string, unknown>;
          return {
            activity_date: r.activity_date,
            driver_name: r.driver_name,
            receipt_count: Number(r.receipt_count),
            total_cost_ngn: Number(r.total_cost_ngn),
            total_receipt_liters: Math.round(Number(r.total_receipt_liters) * 10) / 10,
            total_obd_liters: Math.round(Number(r.total_obd_liters) * 10) / 10,
          };
        }),
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
      total_pages: Math.ceil(Number(total) / limit),
      purchases,
      ...(summary ? { summary } : {}),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/fuel-purchases/receipt', async (req: Request, res: Response) => {
  const {
    vehicle_id: vehicleId,
    liters_declared: litersDeclared,
    merchant,
    receipt_reference: receiptReference,
    purchased_at: purchasedAt,
  } = req.body as {
    vehicle_id?: string;
    liters_declared?: number;
    merchant?: string;
    receipt_reference?: string;
    purchased_at?: string;
  };

  if (!vehicleId || !litersDeclared) {
    res.status(400).json({ error: 'vehicle_id and liters_declared are required' });
    return;
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
    if (litersActual != null && diff != null) {
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
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/readings', async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const customerId = req.user.customerId;

  try {
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM telemetry WHERE customer_id = ${customerId}
    `);
    const total = (countResult.rows[0] as Record<string, unknown>)?.total ?? 0;

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
      total_pages: Math.ceil(Number(total) / limit),
      rows: rows.rows,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/efficiency', async (req: Request, res: Response) => {
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
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
