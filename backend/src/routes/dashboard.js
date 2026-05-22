const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const { db, alerts, eq, and, sql } = require('../lib/db-helpers');
const { fleetEfficiencyAggSql } = require('../lib/fleet-efficiency-sql');
const { round1, round2, DEFAULT_FUEL_PRICE_NGN_LITER } = require('../lib/fuel-metrics');

const router = express.Router();

router.use(authenticateCustomer);

router.get('/summary', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

  try {
    const customerId = req.user.customerId;

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
      (sum, row) => sum + (Number(row.distance_km) || 0),
      0
    );
    const totalFuelUsedLiters = vehicleRows.reduce(
      (sum, row) => sum + (Number(row.fuel_used_liters) || 0),
      0
    );
    const avgEfficiencyKmL =
      totalDistanceKm > 0 && totalFuelUsedLiters >= 0.5
        ? totalDistanceKm / totalFuelUsedLiters
        : null;
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

    const fleet = fleetResult.rows[0] || {};

    const activeAlerts = alertRows.length;
    const theftAlerts = alertRows.filter((a) => a.alert_type === 'fuel_theft');
    const theftLossNgn = theftAlerts.reduce(
      (sum, a) => sum + (Number(a.estimated_loss_ngn) || 0),
      0
    );

    res.json({
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
      total_fuel_cost_ngn: totalFuelCostNgn,
      active_alerts: activeAlerts,
      theft_alerts: theftAlerts.length,
      estimated_theft_loss_ngn: theftLossNgn,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
