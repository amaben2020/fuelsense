// Fill-to-fill calibration.
//
// A vehicle's real fuel economy is the one thing GPS cannot measure: we know
// how far it went, never how much it drank. Two consecutive fill-ups with
// odometer readings give it directly — litres bought divided by distance
// covered — and that measured rate replaces the class preset for good.
//
// Everything here is in kilometres. Odometers in this fleet read km, so there
// is no conversion at the boundary; miles are a display concern only.
import {
  db,
  fuelPurchases,
  vehicles,
  telemetry,
  eq,
  and,
  desc,
  sql,
} from './db-helpers';
import { CALIBRATION_MIN_PURCHASES, presetForVehicleType, round1, round2 } from './fuel-metrics';
import { applyReceiptBurnFactor } from './virtual-tank';

/** Odometer vs GPS may legitimately differ (tunnels, tracker gaps, wheel size). */
export const DISTANCE_MISMATCH_TOLERANCE = Number(
  process.env.DISTANCE_MISMATCH_TOLERANCE || 0.15
);
/** Beyond this between fills the pairing is almost certainly wrong. */
export const MAX_PLAUSIBLE_FILL_GAP_KM = Number(process.env.MAX_FILL_GAP_KM || 5000);
/** How many recent intervals feed the rolling average. */
export const CALIBRATION_WINDOW = Number(process.env.CALIBRATION_WINDOW || 5);
/** Litres beyond the predicted amount before a purchase is questioned. */
export const UNUSUAL_PURCHASE_TOLERANCE = Number(
  process.env.UNUSUAL_PURCHASE_TOLERANCE || 0.35
);

export interface ReconcileResult {
  odometer_delta_km: number | null;
  gps_distance_km: number | null;
  real_consumption_l_per_100km: number | null;
  distance_mismatch: boolean;
  implausible_odometer: boolean;
  unusual_purchase: boolean;
  flag_reason: string | null;
  /** Rate now in force for the vehicle, and where it came from. */
  vehicle_rate_l_per_100km: number | null;
  rate_source: 'preset' | 'calibrated' | 'manual';
}

/**
 * Burn correction measured against litres someone actually paid for.
 *
 * Between two fills, the accumulator claims some number of litres burned and
 * the receipts say how many were bought. On a vehicle that is filled to the
 * same point each time those two are the same quantity, so their ratio is a
 * direct measurement of how far the device's estimate is out. That beats the
 * device's own AVL 13 cross-check, which only compares one firmware guess
 * against another.
 *
 * Returns null until there are enough intervals to be worth trusting.
 */
export async function deriveBurnFactorFromReceipts(
  vehicleId: string
): Promise<{ factor: number; intervals: number } | null> {
  const purchases = await db
    .select({ at: fuelPurchases.purchasedAt, liters: fuelPurchases.litersActual })
    .from(fuelPurchases)
    .where(and(eq(fuelPurchases.vehicleId, vehicleId), sql`${fuelPurchases.litersActual} > 0`))
    .orderBy(desc(fuelPurchases.purchasedAt))
    .limit(CALIBRATION_WINDOW + 1);

  if (purchases.length < CALIBRATION_MIN_PURCHASES + 1) return null;

  // Oldest first, so each interval runs from one fill to the next.
  const ordered = [...purchases].reverse();
  const ratios: number[] = [];

  for (let i = 1; i < ordered.length; i++) {
    const from = ordered[i - 1].at;
    const to = ordered[i].at;
    const litersBought = Number(ordered[i].liters);
    if (!from || !to || !(litersBought > 0)) continue;

    // Accumulator litres over the same window. The element resets on a power
    // cycle, so only forward steps are summed; a reset contributes nothing
    // rather than a spurious negative.
    const [row] = (
      await db.execute(sql`
        WITH ordered AS (
          SELECT
            fuel_used_gps_ml,
            LAG(fuel_used_gps_ml) OVER (ORDER BY recorded_at) AS prev_ml
          FROM telemetry
          WHERE vehicle_id = ${vehicleId}::uuid
            AND fuel_used_gps_ml IS NOT NULL
            AND recorded_at > ${from.toISOString()}::timestamp
            AND recorded_at <= ${to.toISOString()}::timestamp
        )
        SELECT COALESCE(
          SUM(CASE WHEN fuel_used_gps_ml >= prev_ml THEN fuel_used_gps_ml - prev_ml ELSE 0 END),
          0
        )::numeric / 1000.0 AS accumulator_liters
        FROM ordered
        WHERE prev_ml IS NOT NULL
      `)
    ).rows as Array<{ accumulator_liters: string }>;

    const accumulatorLiters = Number(row?.accumulator_liters ?? 0);
    // Too little movement between fills to say anything useful.
    if (accumulatorLiters < 1) continue;

    ratios.push(litersBought / accumulatorLiters);
  }

  if (ratios.length < CALIBRATION_MIN_PURCHASES) return null;

  // Median, so one short-filled tank cannot drag the correction.
  ratios.sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  const factor =
    ratios.length % 2 === 0 ? (ratios[middle - 1] + ratios[middle]) / 2 : ratios[middle];

  return { factor: round2(Math.min(4, Math.max(0.5, factor))), intervals: ratios.length };
}

/** GPS distance the vehicle covered between two instants. */
async function gpsDistanceBetween(
  vehicleId: string,
  fromAt: Date,
  toAt: Date
): Promise<number | null> {
  const result = await db.execute(sql`
    WITH ordered AS (
      SELECT
        latitude::double precision AS lat,
        longitude::double precision AS lng,
        speed_kph,
        recorded_at,
        LAG(latitude::double precision) OVER w AS prev_lat,
        LAG(longitude::double precision) OVER w AS prev_lng,
        LAG(recorded_at) OVER w AS prev_at
      FROM telemetry
      WHERE vehicle_id = ${vehicleId}
        AND latitude IS NOT NULL AND longitude IS NOT NULL
        AND recorded_at > ${fromAt.toISOString()}::timestamp
        AND recorded_at <= ${toAt.toISOString()}::timestamp
      WINDOW w AS (ORDER BY recorded_at)
    )
    SELECT COALESCE(SUM(hop), 0)::double precision AS distance_km
    FROM (
      SELECT 6371 * 2 * ASIN(SQRT(
        POWER(SIN(RADIANS(lat - prev_lat) / 2), 2)
        + COS(RADIANS(prev_lat)) * COS(RADIANS(lat))
          * POWER(SIN(RADIANS(lng - prev_lng) / 2), 2)
      )) AS hop
      FROM ordered
      WHERE prev_lat IS NOT NULL
        -- same jitter rejection the trip segmenter uses: ignore sub-10 m
        -- wander reported while stationary
        AND COALESCE(speed_kph, 0) >= 2
    ) hops
    WHERE hop < 50
  `);

  const row = result.rows[0] as { distance_km?: number } | undefined;
  return row?.distance_km != null ? round1(Number(row.distance_km)) : null;
}

/**
 * Recomputes the vehicle's rate from its recent measured intervals. Only
 * switches away from the class preset once enough real fills exist.
 */
async function recalculateVehicleRate(
  vehicleId: string
): Promise<{ rate: number | null; source: 'preset' | 'calibrated' | 'manual' }> {
  // A rate the manager typed off the vehicle's own dashboard outranks anything
  // derived here. Without this guard the next reconciliation would reset it to
  // the class preset — the manual figure would survive until the driver logged
  // one more receipt, which is worse than not offering the input at all.
  const [current] = await db
    .select({ rateSource: vehicles.rateSource, rate: vehicles.consumptionRateL100km })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId))
    .limit(1);

  if (current?.rateSource === 'manual') {
    return { rate: current.rate != null ? Number(current.rate) : null, source: 'manual' };
  }

  const rows = await db
    .select({ rate: fuelPurchases.realConsumptionL100km })
    .from(fuelPurchases)
    .where(
      and(
        eq(fuelPurchases.vehicleId, vehicleId),
        sql`${fuelPurchases.realConsumptionL100km} IS NOT NULL`,
        // A flagged interval is untrustworthy input, so it never moves the rate.
        eq(fuelPurchases.implausibleOdometer, false)
      )
    )
    .orderBy(desc(fuelPurchases.purchasedAt))
    .limit(CALIBRATION_WINDOW);

  const measured = rows
    .map((r) => Number(r.rate))
    .filter((n) => Number.isFinite(n) && n > 0);

  const [vehicle] = await db
    .select({ vehicleType: vehicles.vehicleType })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId))
    .limit(1);

  if (measured.length < CALIBRATION_MIN_PURCHASES) {
    const preset = presetForVehicleType(vehicle?.vehicleType);
    await db
      .update(vehicles)
      .set({
        consumptionRateL100km: preset.consumptionL100km.toFixed(2),
        idleBurnRateLph: preset.idleBurnLph.toFixed(2),
        rateSource: 'preset',
        updatedAt: sql`NOW()`,
      })
      .where(eq(vehicles.id, vehicleId));
    return { rate: preset.consumptionL100km, source: 'preset' };
  }

  const rolling = round2(measured.reduce((a, b) => a + b, 0) / measured.length);
  await db
    .update(vehicles)
    .set({
      consumptionRateL100km: rolling.toFixed(2),
      rateSource: 'calibrated',
      updatedAt: sql`NOW()`,
    })
    .where(eq(vehicles.id, vehicleId));

  return { rate: rolling, source: 'calibrated' };
}

/**
 * Reconciles a newly logged purchase against the previous one for the same
 * vehicle, then refreshes that vehicle's rate. Safe to re-run for a purchase.
 */
export async function reconcileFuelPurchase(purchaseId: string): Promise<ReconcileResult> {
  const [current] = await db
    .select()
    .from(fuelPurchases)
    .where(eq(fuelPurchases.id, purchaseId))
    .limit(1);

  const blank: ReconcileResult = {
    odometer_delta_km: null,
    gps_distance_km: null,
    real_consumption_l_per_100km: null,
    distance_mismatch: false,
    implausible_odometer: false,
    unusual_purchase: false,
    flag_reason: null,
    vehicle_rate_l_per_100km: null,
    rate_source: 'preset',
  };

  if (!current) return blank;

  // The immediately preceding fill for this vehicle that carried an odometer.
  const [previous] = await db
    .select({
      odometerKm: fuelPurchases.odometerKm,
      purchasedAt: fuelPurchases.purchasedAt,
    })
    .from(fuelPurchases)
    .where(
      and(
        eq(fuelPurchases.vehicleId, current.vehicleId),
        sql`${fuelPurchases.odometerKm} IS NOT NULL`,
        // Exclude this row by id as well as by time: two fills logged in the
        // same second would otherwise let the row match itself and produce a
        // zero delta that looks like a stuck odometer.
        sql`${fuelPurchases.id} <> ${purchaseId}`,
        sql`${fuelPurchases.purchasedAt} <= ${new Date(current.purchasedAt).toISOString()}::timestamp`
      )
    )
    .orderBy(desc(fuelPurchases.purchasedAt))
    .limit(1);

  const liters = Number(current.litersActual ?? current.litersDeclared ?? 0);
  const reasons: string[] = [];
  let odometerDelta: number | null = null;
  let realRate: number | null = null;
  let implausible = false;
  let mismatch = false;
  let unusual = false;

  if (current.odometerKm != null && previous?.odometerKm != null) {
    odometerDelta = Number(current.odometerKm) - Number(previous.odometerKm);

    if (odometerDelta <= 0) {
      implausible = true;
      reasons.push(
        `Odometer did not advance since the last fill (${previous.odometerKm} → ${current.odometerKm} km).`
      );
    } else if (odometerDelta > MAX_PLAUSIBLE_FILL_GAP_KM) {
      implausible = true;
      reasons.push(
        `Odometer jumped ${odometerDelta.toLocaleString()} km between fills, beyond the ${MAX_PLAUSIBLE_FILL_GAP_KM.toLocaleString()} km limit.`
      );
    } else if (liters > 0) {
      realRate = round2((liters / odometerDelta) * 100);
    }
  }

  // GPS cross-check: does the tracker agree the vehicle went that far?
  let gpsDistance: number | null = null;
  if (previous?.purchasedAt) {
    gpsDistance = await gpsDistanceBetween(
      current.vehicleId,
      new Date(previous.purchasedAt),
      new Date(current.purchasedAt)
    );

    if (!implausible && odometerDelta != null && gpsDistance != null && gpsDistance > 0) {
      const divergence = Math.abs(odometerDelta - gpsDistance) / odometerDelta;
      if (divergence > DISTANCE_MISMATCH_TOLERANCE) {
        mismatch = true;
        reasons.push(
          `Odometer says ${odometerDelta} km but GPS recorded ${gpsDistance} km (${Math.round(divergence * 100)}% apart).`
        );
      }
    }
  }

  // Does the fuel bought match what the distance can account for? Compared
  // against the rate already in force, so a calibrated vehicle judges itself.
  const [vehicle] = await db
    .select({
      rate: vehicles.consumptionRateL100km,
      vehicleType: vehicles.vehicleType,
      tank: vehicles.tankCapacityLiters,
    })
    .from(vehicles)
    .where(eq(vehicles.id, current.vehicleId))
    .limit(1);

  const rateInForce =
    vehicle?.rate != null
      ? Number(vehicle.rate)
      : presetForVehicleType(vehicle?.vehicleType).consumptionL100km;

  if (!implausible && odometerDelta != null && odometerDelta > 0 && liters > 0) {
    const expected = (odometerDelta * rateInForce) / 100;
    // A tank cannot take more than it holds, whatever the distance suggests.
    const capacityCeiling = vehicle?.tank != null ? Number(vehicle.tank) : null;
    if (expected > 0 && liters > expected * (1 + UNUSUAL_PURCHASE_TOLERANCE)) {
      unusual = true;
      reasons.push(
        `Bought ${liters.toFixed(1)} L for ${odometerDelta} km; expected about ${expected.toFixed(1)} L at ${rateInForce.toFixed(1)} L/100km.`
      );
    } else if (capacityCeiling != null && liters > capacityCeiling * 1.05) {
      unusual = true;
      reasons.push(
        `Bought ${liters.toFixed(1)} L into a ${capacityCeiling} L tank.`
      );
    }
  }

  await db
    .update(fuelPurchases)
    .set({
      odometerDeltaKm: odometerDelta,
      gpsDistanceKm: gpsDistance != null ? gpsDistance.toFixed(1) : null,
      realConsumptionL100km: realRate != null ? realRate.toFixed(2) : null,
      distanceMismatch: mismatch,
      implausibleOdometer: implausible,
      unusualPurchase: unusual,
      flagReason: reasons.length ? reasons.join(' ') : null,
    })
    .where(eq(fuelPurchases.id, purchaseId));

  const { rate, source } = await recalculateVehicleRate(current.vehicleId);

  // Each new fill is another measurement of how far the device's accumulator
  // is out, so the tank's correction is refreshed here rather than waiting for
  // the next telemetry ping to infer one from the device's own estimates.
  const receiptFactor = await deriveBurnFactorFromReceipts(current.vehicleId!).catch((err) => {
    console.error('[calibration] receipt burn factor failed:', err);
    return null;
  });
  if (receiptFactor) {
    await applyReceiptBurnFactor(
      current.vehicleId!,
      receiptFactor.factor,
      receiptFactor.intervals
    ).catch((err) => console.error('[calibration] burn factor write failed:', err));
  }

  return {
    odometer_delta_km: odometerDelta,
    gps_distance_km: gpsDistance,
    real_consumption_l_per_100km: realRate,
    distance_mismatch: mismatch,
    implausible_odometer: implausible,
    unusual_purchase: unusual,
    flag_reason: reasons.length ? reasons.join(' ') : null,
    vehicle_rate_l_per_100km: rate,
    rate_source: source,
  };
}

/** Rate history for a vehicle — powers the trend view. */
export async function consumptionTrend(vehicleId: string, limit = 12) {
  const rows = await db
    .select({
      purchased_at: fuelPurchases.purchasedAt,
      liters: fuelPurchases.litersDeclared,
      odometer_km: fuelPurchases.odometerKm,
      odometer_delta_km: fuelPurchases.odometerDeltaKm,
      gps_distance_km: fuelPurchases.gpsDistanceKm,
      rate: fuelPurchases.realConsumptionL100km,
      distance_mismatch: fuelPurchases.distanceMismatch,
      implausible_odometer: fuelPurchases.implausibleOdometer,
      unusual_purchase: fuelPurchases.unusualPurchase,
    })
    .from(fuelPurchases)
    .where(eq(fuelPurchases.vehicleId, vehicleId))
    .orderBy(desc(fuelPurchases.purchasedAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    liters: r.liters != null ? Number(r.liters) : null,
    gps_distance_km: r.gps_distance_km != null ? Number(r.gps_distance_km) : null,
    real_consumption_l_per_100km: r.rate != null ? Number(r.rate) : null,
  }));
}

export { telemetry };
