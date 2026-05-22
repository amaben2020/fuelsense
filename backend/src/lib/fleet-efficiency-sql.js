const { sql } = require('drizzle-orm');
const { telemetryDeltasCte } = require('./telemetry-deltas-sql');

function fleetEfficiencyAggSql({ customerId, days, pricePerLiter }) {
  const fuelPrice = pricePerLiter ?? 650;

  return sql`
    WITH ${telemetryDeltasCte({ customerId, days })},
    period_agg AS (
      SELECT
        vehicle_id,
        license_plate,
        model,
        driver_name,
        tank_capacity_liters,
        COALESCE(SUM(dist_delta), 0)::numeric AS distance_km,
        COALESCE(SUM(fuel_delta), 0)::numeric AS fuel_used_liters
      FROM deltas
      GROUP BY vehicle_id, license_plate, model, driver_name, tank_capacity_liters
    ),
    last_refuel AS (
      SELECT DISTINCT ON (o.vehicle_id)
        o.vehicle_id,
        o.recorded_at AS refuel_at
      FROM ordered o
      WHERE o.prev_fuel IS NOT NULL
        AND o.fuel_level_liters - o.prev_fuel >= 5
      ORDER BY o.vehicle_id, o.recorded_at DESC
    ),
    since_refuel AS (
      SELECT
        d.vehicle_id,
        COALESCE(SUM(d.dist_delta), 0)::numeric AS tank_distance_km,
        COALESCE(SUM(d.fuel_delta), 0)::numeric AS tank_fuel_used_liters
      FROM deltas d
      INNER JOIN last_refuel lr ON lr.vehicle_id = d.vehicle_id
      WHERE d.recorded_at >= lr.refuel_at
      GROUP BY d.vehicle_id
    ),
    last_purchase AS (
      SELECT DISTINCT ON (fp.vehicle_id)
        fp.vehicle_id,
        fp.purchased_at AS last_purchase_at,
        fp.liters_actual AS last_fuel_added_liters,
        fp.liters_declared AS last_receipt_liters,
        fp.merchant AS last_purchase_merchant,
        fp.cost_per_liter_ngn AS last_cost_per_liter_ngn
      FROM fuel_purchases fp
      WHERE fp.customer_id = ${customerId}
      ORDER BY fp.vehicle_id, fp.purchased_at DESC
    ),
    since_purchase AS (
      SELECT
        d.vehicle_id,
        COALESCE(SUM(d.dist_delta), 0)::numeric AS distance_since_purchase_km,
        COALESCE(SUM(d.fuel_delta), 0)::numeric AS fuel_since_purchase_liters
      FROM deltas d
      INNER JOIN last_purchase lp ON lp.vehicle_id = d.vehicle_id
      WHERE d.recorded_at > lp.last_purchase_at
      GROUP BY d.vehicle_id
    ),
    period_purchases AS (
      SELECT
        fp.vehicle_id,
        COALESCE(SUM(fp.liters_declared::numeric), 0)::numeric AS purchase_liters_declared,
        COALESCE(
          SUM(fp.liters_declared::numeric * COALESCE(fp.cost_per_liter_ngn, ${fuelPrice})),
          0
        )::numeric AS purchase_cost_ngn,
        COALESCE(
          SUM(
            GREATEST(
              0,
              fp.liters_declared::numeric - COALESCE(fp.liters_actual::numeric, fp.liters_declared::numeric)
            ) * COALESCE(fp.cost_per_liter_ngn, ${fuelPrice})
          ),
          0
        )::numeric AS receipt_fraud_loss_ngn
      FROM fuel_purchases fp
      WHERE fp.customer_id = ${customerId}
        AND fp.purchased_at > NOW() - (${days} || ' days')::INTERVAL
      GROUP BY fp.vehicle_id
    )
    SELECT
      p.vehicle_id,
      p.license_plate,
      p.model,
      p.driver_name,
      p.tank_capacity_liters,
      p.distance_km,
      p.fuel_used_liters,
      sr.tank_distance_km,
      sr.tank_fuel_used_liters,
      lp.last_purchase_at,
      lp.last_fuel_added_liters,
      lp.last_receipt_liters,
      lp.last_purchase_merchant,
      lp.last_cost_per_liter_ngn,
      COALESCE(sp.distance_since_purchase_km, sr.tank_distance_km, 0) AS distance_since_purchase_km,
      COALESCE(sp.fuel_since_purchase_liters, sr.tank_fuel_used_liters, 0) AS fuel_since_purchase_liters,
      COALESCE(pp.purchase_cost_ngn, 0) AS purchase_cost_ngn,
      COALESCE(pp.receipt_fraud_loss_ngn, 0) AS receipt_fraud_loss_ngn,
      COALESCE(pp.purchase_liters_declared, 0) AS purchase_liters_declared
    FROM period_agg p
    LEFT JOIN since_refuel sr ON sr.vehicle_id = p.vehicle_id
    LEFT JOIN last_purchase lp ON lp.vehicle_id = p.vehicle_id
    LEFT JOIN since_purchase sp ON sp.vehicle_id = p.vehicle_id
    LEFT JOIN period_purchases pp ON pp.vehicle_id = p.vehicle_id
    ORDER BY p.license_plate ASC
  `;
}

module.exports = { fleetEfficiencyAggSql };
