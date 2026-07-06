import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, alerts, eq, and, sql } from '../lib/db-helpers';
import { fleetEfficiencyAggSql } from '../lib/fleet-efficiency-sql';
import { distanceDeltasCte } from '../lib/telemetry-deltas-sql';
import {
  round1,
  round2,
  computeL100km,
  baselineEfficiencyKmL,
  fuelUsedForDistanceKm,
  kmLToMpg,
  DEFAULT_FUEL_PRICE_NGN_LITER,
  IDLE_BURN_LITERS_PER_HOUR,
} from '../lib/fuel-metrics';
import { withCache, cacheKey } from '../lib/redis';

const router = express.Router();

router.use(authenticateCustomer);

router.get('/summary', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

  try {
    const customerId = req.user.customerId;
    const key = cacheKey(customerId, 'summary', String(days));

    const cached = await withCache(key, 15, async () => {

    const fleetResult = await db.execute(sql`
      SELECT
        COUNT(DISTINCT v.id) AS total_vehicles,
        COUNT(DISTINCT v.id) FILTER (
          WHERE d.last_seen_at > NOW() - INTERVAL '15 minutes'
        ) AS online_vehicles,
        COALESCE(SUM(latest.fuel_level_liters::numeric), 0) AS total_fuel_liters,
        COUNT(latest.fuel_level_liters) FILTER (
          WHERE latest.fuel_level_liters::numeric < 20
        ) AS low_fuel_vehicles
      FROM vehicles v
      LEFT JOIN devices d ON d.vehicle_id = v.id AND d.customer_id = v.customer_id
      LEFT JOIN LATERAL (
        SELECT fuel_level_liters
        FROM telemetry t
        WHERE t.vehicle_id = v.id AND t.customer_id = v.customer_id
        ORDER BY t.recorded_at DESC
        LIMIT 1
      ) latest ON true
      WHERE v.customer_id = ${customerId}
    `);

    const efficiencyResult = await db.execute(
      fleetEfficiencyAggSql({ customerId, days, pricePerLiter })
    );

    const vehicleRows = efficiencyResult.rows || [];
    const totalDistanceKm = vehicleRows.reduce(
      (sum, row) => sum + (Number((row as Record<string, unknown>).distance_km) || 0),
      0
    );
    const totalFuelUsedLiters = vehicleRows.reduce(
      (sum, row) => sum + (Number((row as Record<string, unknown>).fuel_used_liters) || 0),
      0
    );
    const avgEfficiencyKmL =
      totalDistanceKm > 0 && totalFuelUsedLiters >= 0.5
        ? totalDistanceKm / totalFuelUsedLiters
        : null;
    const avgEfficiencyL100km = computeL100km(totalFuelUsedLiters, totalDistanceKm);
    const totalFuelCostNgn = Math.round(totalFuelUsedLiters * pricePerLiter);

    const alertRows = await db
      .select({
        alert_type: alerts.alertType,
        estimated_loss_ngn: alerts.estimatedLossNgn,
      })
      .from(alerts)
      .where(
        and(eq(alerts.customerId, customerId), eq(alerts.isResolved, false))
      );

    const fleet = (fleetResult.rows[0] ?? {}) as Record<string, unknown>;

    const activeAlerts = alertRows.length;
    const theftAlerts = alertRows.filter((a) => a.alert_type === 'fuel_theft');
    const theftLossNgn = theftAlerts.reduce(
      (sum, a) => sum + (Number(a.estimated_loss_ngn) || 0),
      0
    );

      return {
        period_days: days,
        currency: 'NGN',
        price_per_liter_ngn: pricePerLiter,
        total_vehicles: Number(fleet.total_vehicles) || 0,
        online_vehicles: Number(fleet.online_vehicles) || 0,
        total_fuel_liters: Math.round(Number(fleet.total_fuel_liters) * 10) / 10,
        low_fuel_vehicles: Number(fleet.low_fuel_vehicles) || 0,
        total_distance_km: Math.round(totalDistanceKm),
        total_fuel_used_liters: round1(totalFuelUsedLiters),
        avg_efficiency_km_l:
          avgEfficiencyKmL != null ? round2(avgEfficiencyKmL) : null,
        avg_efficiency_l_100km: avgEfficiencyL100km,
        total_fuel_cost_ngn: totalFuelCostNgn,
        active_alerts: activeAlerts,
        theft_alerts: theftAlerts.length,
        estimated_theft_loss_ngn: theftLossNgn,
      };
    });

    res.json(cached);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Fuel estimate from distance ÷ baseline efficiency — no fuel-level sensor required.
router.get('/estimated-consumption', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

  try {
    const customerId = req.user.customerId;
    const key = cacheKey(customerId, 'estimated-consumption', String(days));

    const cached = await withCache(key, 30, async () => {
      // Everything (day groups, per-vehicle rows, grand totals) is derived from
      // the same rounded daily rows so every level of the table sums exactly.
      const dailyResult = await db.execute(sql`
        WITH ${distanceDeltasCte({ customerId, days })}
        SELECT
          recorded_at::date AS activity_date,
          vehicle_id,
          license_plate,
          model,
          driver_name,
          COALESCE(SUM(dist_delta), 0)::numeric AS distance_km,
          COALESCE(SUM(idle_delta_s), 0)::numeric AS idle_seconds
        FROM deltas
        GROUP BY recorded_at::date, vehicle_id, license_plate, model, driver_name
        ORDER BY activity_date DESC, license_plate ASC
      `);

      interface EstimateRow {
        vehicle_id: unknown;
        license_plate: unknown;
        model: unknown;
        driver_name: unknown;
        distance_km: number;
        efficiency_km_l: number;
        efficiency_mpg: number | null;
        idle_hours: number;
        moving_fuel_liters: number;
        idle_fuel_liters: number;
        estimated_fuel_liters: number;
        estimated_cost_ngn: number;
      }
      interface Totals {
        distance_km: number;
        estimated_fuel_liters: number;
        estimated_cost_ngn: number;
      }
      const addTo = (t: Totals, r: EstimateRow) => {
        t.distance_km = round1(t.distance_km + r.distance_km);
        t.estimated_fuel_liters = round1(t.estimated_fuel_liters + r.estimated_fuel_liters);
        t.estimated_cost_ngn += r.estimated_cost_ngn;
      };

      const dayMap = new Map<string, { date: string; vehicles: EstimateRow[]; totals: Totals }>();
      const vehicleMap = new Map<string, EstimateRow>();
      const totals: Totals = { distance_km: 0, estimated_fuel_liters: 0, estimated_cost_ngn: 0 };

      for (const r of dailyResult.rows || []) {
        const row = r as Record<string, unknown>;
        const rawKm = Number(row.distance_km) || 0;
        const idleHours = (Number(row.idle_seconds) || 0) / 3600;
        // skip days with neither movement nor meaningful engine-on time
        // (parked-day GPS jitter) so groups and totals agree
        if (rawKm < 0.05 && idleHours < 0.05) continue;

        const efficiencyKmL = baselineEfficiencyKmL(String(row.model ?? ''));
        const distanceKm = round1(rawKm);
        const movingLiters = round1(fuelUsedForDistanceKm(distanceKm, efficiencyKmL));
        const idleLiters = round1(idleHours * IDLE_BURN_LITERS_PER_HOUR);
        const liters = round1(movingLiters + idleLiters);
        const dayRow: EstimateRow = {
          vehicle_id: row.vehicle_id,
          license_plate: row.license_plate,
          model: row.model,
          driver_name: row.driver_name,
          distance_km: distanceKm,
          efficiency_km_l: round2(efficiencyKmL),
          efficiency_mpg: kmLToMpg(efficiencyKmL),
          idle_hours: round1(idleHours),
          moving_fuel_liters: movingLiters,
          idle_fuel_liters: idleLiters,
          estimated_fuel_liters: liters,
          estimated_cost_ngn: Math.round(liters * pricePerLiter),
        };

        const date = String(row.activity_date).slice(0, 10);
        if (!dayMap.has(date)) {
          dayMap.set(date, {
            date,
            vehicles: [],
            totals: { distance_km: 0, estimated_fuel_liters: 0, estimated_cost_ngn: 0 },
          });
        }
        const day = dayMap.get(date)!;
        day.vehicles.push(dayRow);
        addTo(day.totals, dayRow);
        addTo(totals, dayRow);

        const vid = String(row.vehicle_id);
        if (!vehicleMap.has(vid)) {
          vehicleMap.set(vid, {
            ...dayRow,
            distance_km: 0,
            idle_hours: 0,
            moving_fuel_liters: 0,
            idle_fuel_liters: 0,
            estimated_fuel_liters: 0,
            estimated_cost_ngn: 0,
          });
        }
        const period = vehicleMap.get(vid)!;
        period.distance_km = round1(period.distance_km + dayRow.distance_km);
        period.idle_hours = round1(period.idle_hours + dayRow.idle_hours);
        period.moving_fuel_liters = round1(period.moving_fuel_liters + dayRow.moving_fuel_liters);
        period.idle_fuel_liters = round1(period.idle_fuel_liters + dayRow.idle_fuel_liters);
        period.estimated_fuel_liters = round1(
          period.estimated_fuel_liters + dayRow.estimated_fuel_liters
        );
        period.estimated_cost_ngn += dayRow.estimated_cost_ngn;
      }

      const vehicles = Array.from(vehicleMap.values()).sort((a, b) =>
        String(a.license_plate).localeCompare(String(b.license_plate))
      );

      // Fuel bought in the same window — shown beside the estimate so
      // "I bought ₦X" has context (bought ≠ burned; the rest is in the tank).
      const purchaseResult = await db.execute(sql`
        SELECT
          COUNT(*) AS purchase_count,
          COALESCE(SUM(liters_declared::numeric), 0) AS liters,
          COALESCE(
            SUM(liters_declared::numeric * COALESCE(cost_per_liter_ngn, ${pricePerLiter})),
            0
          ) AS cost_ngn
        FROM fuel_purchases
        WHERE customer_id = ${customerId}
          AND purchased_at > NOW() - (${days} || ' days')::INTERVAL
      `);
      const purchaseRow = (purchaseResult.rows[0] ?? {}) as Record<string, unknown>;

      return {
        period_days: days,
        price_per_liter_ngn: pricePerLiter,
        basis: 'distance_over_baseline_plus_idle_burn',
        idle_burn_liters_per_hour: IDLE_BURN_LITERS_PER_HOUR,
        vehicles,
        daily: Array.from(dayMap.values()),
        totals,
        purchases: {
          count: Number(purchaseRow.purchase_count) || 0,
          liters: round1(Number(purchaseRow.liters) || 0),
          cost_ngn: Math.round(Number(purchaseRow.cost_ngn) || 0),
        },
      };
    });

    res.json(cached);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
