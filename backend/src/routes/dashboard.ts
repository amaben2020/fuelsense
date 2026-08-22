import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, alerts, eq, and, sql } from '../lib/db-helpers';
import { fleetEfficiencyAggSql } from '../lib/fleet-efficiency-sql';
import {
  FLEET_TZ,
  distanceDeltasCte,
  localDate,
  windowStart,
} from '../lib/telemetry-deltas-sql';
import {
  benchmarkPriceHistory,
  latestReceiptPrice,
  effectivePriceAt,
} from '../lib/fuel-price';
import { countsTowardHealth } from '../lib/alert-taxonomy';
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
import { logAndRespond } from '../lib/errors';

const router = express.Router();

router.use(authenticateCustomer);

router.get('/summary', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);

  try {
    const customerId = req.user.customerId;
    // The same litre was being priced three different ways across the app: the
    // benchmark here, the newest receipt on /telemetry/trips, and this env var
    // on the summary — which never consulted the database at all, so the
    // overview quoted a hardcoded 1300/L while the manager's declared price was
    // 1310. One resolver now decides, in the documented order (benchmark for
    // the moment, then newest receipt), and the env value is only the last
    // resort when a fleet has declared no price and logged no receipt.
    const effective = await effectivePriceAt(customerId, new Date());
    const pricePerLiter =
      effective?.ngnPerLiter ??
      Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);
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
    // fleetEfficiencyAggSql already values every litre at the price in force
    // the day it was burned, so a price change cannot restate what an earlier
    // week cost. This used to throw that away and multiply the period's total
    // litres by today's price, which silently back-dated the current price over
    // the whole window — across the 10 Aug (1300) → 11 Aug (1275) → 18 Aug
    // (1310) changes, every figure was wrong.
    const totalFuelCostNgn = Math.round(
      vehicleRows.reduce(
        (sum, row) => sum + (Number((row as Record<string, unknown>).telemetry_cost_ngn) || 0),
        0
      )
    );

    // The honest headline price for a window that spans several: what the fuel
    // actually cost, divided by how much of it there was. A plain mean of the
    // declared prices would weight a day with 2 litres the same as a day with
    // 40. Falls back to the point-in-time price when nothing was burned.
    const avgPricePerLiterNgn =
      totalFuelUsedLiters > 0
        ? Math.round(totalFuelCostNgn / totalFuelUsedLiters)
        : pricePerLiter;

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
    // Everything open, versus only what says something about how the fleet is
    // driven and fuelled. The health score needs the second number: counting a
    // filed receipt or a zone crossing against fleet health made a working
    // single-vehicle fleet read as "critical".
    const concerningAlerts = alertRows.filter((a) =>
      countsTowardHealth(a.alert_type ?? '')
    ).length;
    const theftAlerts = alertRows.filter((a) => a.alert_type === 'fuel_theft');
    const theftLossNgn = theftAlerts.reduce(
      (sum, a) => sum + (Number(a.estimated_loss_ngn) || 0),
      0
    );

      return {
        period_days: days,
        currency: 'NGN',
        /** The price in force right now — what a new litre would cost. */
        price_per_liter_ngn: pricePerLiter,
        /**
         * What the fuel in this window actually averaged, weighted by volume.
         * Differs from the above whenever the price moved during the period,
         * and is the number to quote against a cost total.
         */
        avg_price_per_liter_ngn: avgPricePerLiterNgn,
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
        concerning_alerts: concerningAlerts,
        theft_alerts: theftAlerts.length,
        estimated_theft_loss_ngn: theftLossNgn,
      };
    });

    res.json(cached);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

/**
 * Daily alert load for the last 7 local calendar days, for the Fleet health
 * sparkline. Reconstructed from `alerts.created_at`/`resolved_at` rather than
 * a running counter, so a day's figure reflects what was actually open at the
 * end of that day, not today's count applied backwards.
 *
 * Deliberately alerts-only: the efficiency component of the score comes from
 * `fleetEfficiencyAggSql`, which aggregates over a trailing window rather
 * than a specific calendar date, so it has no honest per-day value to plot.
 * The frontend holds it constant across the trend and says so in the card's
 * footnote rather than implying a daily figure that doesn't exist.
 */
router.get('/health-trend', async (req: Request, res: Response) => {
  try {
    const customerId = req.user.customerId;
    const key = cacheKey(customerId, 'health-trend', '7');

    const cached = await withCache(key, 60, async () => {
      const result = await db.execute(sql`
        WITH days AS (
          SELECT gs::date AS day
          FROM generate_series(
            DATE(NOW() AT TIME ZONE ${FLEET_TZ}) - INTERVAL '6 days',
            DATE(NOW() AT TIME ZONE ${FLEET_TZ}),
            INTERVAL '1 day'
          ) AS gs
        ),
        bounds AS (
          SELECT
            day,
            -- The instant this local day ends, i.e. midnight opening the next
            -- one. The ::timestamp cast is load-bearing: AT TIME ZONE applied
            -- to a bare date casts it to timestamptz and converts the other
            -- way, landing two hours late and filing boundary-hour alerts
            -- under the wrong day. Casting to a naive timestamp first makes
            -- AT TIME ZONE read it as Lagos wall-clock, which is what is meant.
            ((day + 1)::timestamp AT TIME ZONE ${FLEET_TZ}) AS day_end
          FROM days
        )
        SELECT
          to_char(b.day, 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (
            WHERE a.alert_type <> 'fuel_theft'
              AND a.created_at < b.day_end
              AND (a.resolved_at IS NULL OR a.resolved_at >= b.day_end)
          ) AS concerning_alerts,
          COUNT(*) FILTER (
            WHERE a.alert_type = 'fuel_theft'
              AND a.created_at < b.day_end
              AND (a.resolved_at IS NULL OR a.resolved_at >= b.day_end)
          ) AS theft_alerts
        FROM bounds b
        LEFT JOIN alerts a ON a.customer_id = ${customerId}
        GROUP BY b.day
        ORDER BY b.day
      `);

      return result.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          // Already 'YYYY-MM-DD' from to_char. Deliberately not routed through
          // a JS Date: the driver hands `date` columns back as strings here,
          // but plain `pg` hands back a Date at local midnight, and
          // `.toISOString()` on that reports the previous day anywhere east of
          // UTC. Formatting in SQL keeps the calendar date the query meant.
          date: String(r.day),
          concerning_alerts: Number(r.concerning_alerts) || 0,
          theft_alerts: Number(r.theft_alerts) || 0,
        };
      });
    });

    res.json({ days: cached });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

// Fuel estimate from distance ÷ baseline efficiency — no fuel-level sensor required.
// Which vehicles are actually carrying the work. Ranked on the same distance
// deltas the efficiency report uses, so utilisation and cost never disagree.
router.get('/utilisation', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const customerId = req.user.customerId;

  try {
    const key = cacheKey(customerId, 'utilisation', String(days));
    const rows = await withCache(key, 60, async () => {
      const result = await db.execute(sql`
        WITH ${distanceDeltasCte({ customerId, days })}
        SELECT
          vehicle_id,
          license_plate,
          model,
          driver_name,
          ROUND(COALESCE(SUM(dist_delta), 0)::numeric, 1) AS distance_km,
          ROUND((COALESCE(SUM(idle_delta_s), 0) / 3600.0)::numeric, 1) AS idle_hours,
          -- Distinct calendar days with real movement: a vehicle doing 200 km
          -- across 20 days is worked harder than one doing it in a single run.
          -- Local days, so an evening run either side of UTC midnight counts once.
          COUNT(DISTINCT CASE WHEN dist_delta > 0 THEN ${localDate} END) AS active_days,
          MAX(recorded_at) AS last_active_at
        FROM deltas
        GROUP BY vehicle_id, license_plate, model, driver_name
        ORDER BY distance_km DESC
      `);
      return result.rows;
    });

    const list = rows as Array<Record<string, unknown>>;
    const totalKm = list.reduce((s, r) => s + Number(r.distance_km ?? 0), 0);

    res.json({
      days,
      total_distance_km: round1(totalKm),
      vehicles: list.map((r) => ({
        ...r,
        distance_km: Number(r.distance_km ?? 0),
        idle_hours: Number(r.idle_hours ?? 0),
        active_days: Number(r.active_days ?? 0),
        // Share of total fleet distance — the honest way to say "most used"
        // when vehicles have been on the platform for different lengths of time.
        share_percent: totalKm > 0 ? round1((Number(r.distance_km ?? 0) / totalKm) * 100) : 0,
      })),
      most_used: list[0]
        ? {
            vehicle_id: list[0].vehicle_id,
            license_plate: list[0].license_plate,
            driver_name: list[0].driver_name,
            distance_km: Number(list[0].distance_km ?? 0),
            active_days: Number(list[0].active_days ?? 0),
          }
        : null,
    });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.get('/estimated-consumption', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);

  try {
    const customerId = req.user.customerId;
    const key = cacheKey(customerId, 'estimated-consumption', String(days));

    const cached = await withCache(key, 30, async () => {
      // Price history is read once and resolved per day in memory. Each day's
      // fuel is valued at the rate that applied on that day, so a week
      // spanning a price change is not retroactively repriced at today's
      // figure — which is what a flat ₦1,300 constant did to every row.
      const [priceHistory, receiptPrice] = await Promise.all([
        benchmarkPriceHistory(customerId),
        latestReceiptPrice(customerId),
      ]);

      /** The rate in force on a local calendar date, or null if never set. */
      const priceOn = (isoDate: string): number | null => {
        const at = new Date(`${isoDate}T23:59:59+01:00`).getTime();
        const period = priceHistory.find((p) => p.effectiveFrom.getTime() <= at);
        if (period) return period.ngnPerLiter;
        return receiptPrice?.ngnPerLiter ?? null;
      };
      // Everything (day groups, per-vehicle rows, grand totals) is derived from
      // the same rounded daily rows so every level of the table sums exactly.
      const dailyResult = await db.execute(sql`
        WITH ${distanceDeltasCte({ customerId, days })}
        SELECT
          -- Local date, not UTC. Lagos runs an hour ahead, so casting
          -- recorded_at straight to a date filed the first hour of every local
          -- day under the previous one, and the group heading then disagreed
          -- with the tab above it.
          ${localDate} AS activity_date,
          d.vehicle_id,
          d.license_plate,
          d.model,
          d.driver_name,
          -- The rates the manager actually entered for this vehicle. Falling
          -- back to a model-average meant this panel quoted 7.0 km/L for a
          -- RAV4 configured at 15 mpg (6.4 km/L), so the estimate here and the
          -- virtual tank disagreed about the same vehicle on the same day.
          v.consumption_rate_l_per_100km,
          v.idle_burn_rate_l_per_hour,
          COALESCE(SUM(dist_delta), 0)::numeric AS distance_km,
          COALESCE(SUM(idle_delta_s), 0)::numeric AS idle_seconds
        FROM deltas d
        JOIN vehicles v ON v.id = d.vehicle_id
        -- Grouping by the "activity_date" output alias rather than repeating
        -- the localDate helper here: each interpolation of that helper binds
        -- its own copy of the timezone constant as a separate parameter, so
        -- the SELECT and GROUP BY copies reached Postgres as two textually
        -- different (if equally-valued) parameters — "column d.recorded_at
        -- must appear in the GROUP BY clause", on every request. The alias
        -- sidesteps the duplicate parameter entirely.
        GROUP BY
          activity_date, d.vehicle_id, d.license_plate, d.model, d.driver_name,
          v.consumption_rate_l_per_100km, v.idle_burn_rate_l_per_hour
        ORDER BY activity_date DESC, d.license_plate ASC
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

        // Configured rate first, model average only as a fallback for a
        // vehicle nobody has calibrated yet.
        const l100 = row.consumption_rate_l_per_100km != null
          ? Number(row.consumption_rate_l_per_100km)
          : null;
        const efficiencyKmL =
          l100 && l100 > 0 ? 100 / l100 : baselineEfficiencyKmL(String(row.model ?? ''));
        const idleLph = row.idle_burn_rate_l_per_hour != null
          ? Number(row.idle_burn_rate_l_per_hour)
          : IDLE_BURN_LITERS_PER_HOUR;

        const date = String(row.activity_date).slice(0, 10);
        const dayPrice = priceOn(date);

        const distanceKm = round1(rawKm);
        const movingLiters = round1(fuelUsedForDistanceKm(distanceKm, efficiencyKmL));
        const idleLiters = round1(idleHours * idleLph);
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
          // Null, not a guess, when the fleet has never recorded a price.
          estimated_cost_ngn: dayPrice != null ? Math.round(liters * dayPrice) : 0,
        };

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
          -- A receipt without a unit price contributes only what was actually
          -- recorded; it is not topped up to a fleet-wide rate, because the
          -- point of this figure is money that provably changed hands.
          COALESCE(SUM(COALESCE(
            total_amount_ngn,
            liters_declared::numeric * cost_per_liter_ngn
          )), 0) AS cost_ngn
        FROM fuel_purchases
        WHERE customer_id = ${customerId}
          AND purchased_at >= ${windowStart(days)}
      `);
      const purchaseRow = (purchaseResult.rows[0] ?? {}) as Record<string, unknown>;

      // The current rate, for the caption — each row above is already valued
      // at the rate that applied on its own day, so this is a label, not the
      // multiplier used. Null when the fleet has never recorded a price.
      const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: FLEET_TZ });
      const currentPrice = priceOn(todayIso);

      return {
        period_days: days,
        price_per_liter_ngn: currentPrice,
        price_source: priceHistory.length ? 'benchmark' : receiptPrice ? 'receipt' : null,
        basis: 'distance_over_configured_rate_plus_idle_burn',
        // Rates now come from each vehicle's own settings; this stays only as
        // the fallback applied to a vehicle nobody has calibrated.
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
    logAndRespond(res, 'estimated-consumption', error);
  }
});

export default router;
