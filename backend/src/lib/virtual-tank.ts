// Virtual fuel tank engine for vehicles with no CAN/OBD fuel reading.
//
// The FMC150 firmware computes two GPS-derived fuel elements we ingest:
//   AVL 12 "Fuel Used GPS" — cumulative ml burned (resets on power cycle)
//   AVL 13 "Fuel Rate GPS" — instantaneous burn, sent as l/h ×100
//
// The tank is modelled as: level -= Δ(Fuel Used GPS) between pings, credited
// by verified fuel receipts, and re-anchored when a manager calibrates it
// ("driver just filled up"). Confidence decays with consumption and time
// since the last calibration because GPS-derived burn drifts from reality.
import { db, vehicles, alerts, deviceEvents, telemetry, eq, and, sql } from './db-helpers';
import { virtualTanks } from '../db/schema';
import type { FuelMarkerSource } from './fuel-metrics';
import { speedBucketMultiplier } from './fuel-metrics';
import { alertEmail, sendMail } from './mailer';
import { resolveAlertRecipient } from './alert-mail';

export const FUEL_USED_GPS_AVL_ID = 12;
export const FUEL_RATE_GPS_AVL_ID = 13;
// Configurator shows "l/h*100" — raw AVL value 287 means 2.87 l/h
export const FUEL_RATE_GPS_DIVISOR = 100;

const DEFAULT_CAPACITY_LITERS = 60;
// A genuine power-cycle restarts the accumulator at zero, so a reset reading is
// a tiny fraction of the last one. Anything above this fraction is device-side
// jitter (the firmware recalculates and can tick down a few ml) — counting such
// a dip as a reset would bill the whole accumulator as freshly burned fuel.
const ACCUMULATOR_RESET_MAX_FRACTION = 0.1;
// A burn-rate reading is only a plausible idle sample inside this band
const IDLE_RATE_MIN_LPH = 0.2;
const IDLE_RATE_MAX_LPH = 8;
const IDLE_EMA_ALPHA = 0.1;
// Sustained idle burn above this multiple of the learned idle rate (or the
// absolute floor) for IDLE_WASTE_MIN_MINUTES raises an operational-waste alert
const IDLE_WASTE_RATE_FLOOR_LPH = 1.2;
const IDLE_WASTE_RATE_FACTOR = 1.5;
const IDLE_WASTE_MIN_MINUTES = 5;

/**
 * Litres still in the tank when a real vehicle's low-fuel light comes on —
 * not zero. Manufacturers hold back roughly 10-12 L near empty so the
 * electric fuel pump, which sits in the tank and depends on the fuel around
 * it for cooling, never runs dry and overheats. A driver reading their own
 * dashboard already treats this as "empty"; the model should raise the alarm
 * at the same point, not 15% of nameplate capacity later.
 *
 * A flat litre figure rather than a percentage, because the reserve is sized
 * to the pump, not the tank — a bigger tank does not need a bigger reserve.
 */
export const RESERVE_LITERS_DEFAULT = 11;

// The FMC150's two fuel elements are both firmware estimates, and on some
// vehicles they disagree badly: AVL 12 has been observed accumulating at ~1.0
// l/h on a 2.5L SUV while AVL 13 reported 2.27 l/h for the same idle. Left
// uncorrected the tank drains too slowly, low-fuel warnings arrive late, and
// cost per kilometre reads at a fraction of what the fleet actually spends.
//
// The rate element is the better reference: it is a direct estimate, while the
// accumulator compounds its error over every ping. Where the two disagree
// consistently, the ratio between them corrects the accumulator.
const BURN_FACTOR_MIN = 0.5;
const BURN_FACTOR_MAX = 4;
// Enough stationary samples that the ratio reflects a pattern, not one ping.
const BURN_FACTOR_MIN_SAMPLES = 10;
// Below this the two elements effectively agree, so leave the device alone.
const BURN_FACTOR_DEADBAND = 0.15;

/**
 * A factor measured against litres a driver actually paid for outranks one
 * inferred from the device's own two estimates. Once receipts have calibrated
 * a vehicle, the cross-check stops overriding them.
 */
export const RECEIPT_BURN_FACTOR_SOURCE = 'receipt_tank_to_tank';

// How far the tank model may be wrong before a refuel is worth questioning.
// A driver cannot put more into a tank than its empty space, so litres beyond
// the modelled headroom mean the vehicle held less than the model believed.
// The allowance covers partial fills, splashing and rounding on the pump.
const REFUEL_GAP_TOLERANCE_FRACTION = 0.08;
const REFUEL_GAP_TOLERANCE_MIN_LITERS = 2;

export interface VirtualTankState {
  vehicleId: string;
  customerId: string;
  capacityLiters: number;
  levelMl: number;
  lastFuelUsedMl: number | null;
  lastReadingAt: Date | null;
  calibratedAt: Date | null;
  calibrationSource: string | null;
  consumedSinceCalibrationMl: number;
  learnedIdleLph: number | null;
  accumulatorIdleLph: number | null;
  burnFactor: number;
  burnFactorSource: string | null;
  burnFactorSamples: number;
  anchorLevelMl: number | null;
  anchorAccumulatorMl: number | null;
  accumulatorOffsetMl: number;
  modelledBurnMl: number;
  anchorModelledMl: number | null;
  lastOdometerM: number | null;
  confidence: number;
}

/**
 * Running total the accumulator has reached, across every power cycle.
 *
 * AVL 12 restarts at zero whenever the device loses power, so the raw reading
 * alone understates lifetime burn. Anything counted before a reset is banked
 * into the offset, which is what makes an absolute anchor safe to use: the
 * naive `current - start` goes negative after a reset and the tank appears to
 * refill itself.
 */
export function accumulatorTotalMl(readingMl: number, offsetMl: number): number {
  return readingMl + offsetMl;
}

/** True when the accumulator has restarted rather than merely ticked back. */
export function isAccumulatorReset(readingMl: number, lastReadingMl: number | null): boolean {
  if (lastReadingMl == null) return false;
  return readingMl <= lastReadingMl * ACCUMULATOR_RESET_MAX_FRACTION;
}

/**
 * Level from the anchor, not from a running subtraction.
 *
 * Everything burned since the tank was last anchored is the distance the
 * accumulator has travelled since then, corrected by k. Computing it this way
 * means a telemetry gap costs nothing: the accumulator kept counting while the
 * tracker was offline, and the next packet to arrive carries the whole total.
 */
export function levelFromAnchor(
  anchorLevelMl: number,
  anchorAccumulatorMl: number,
  totalAccumulatorMl: number,
  burnFactor: number,
  capacityMl: number
): number {
  const travelled = Math.max(0, totalAccumulatorMl - anchorAccumulatorMl);
  const consumed = Math.round(travelled * burnFactor);
  return Math.max(0, Math.min(capacityMl, anchorLevelMl - consumed));
}

/**
 * Correction for the accumulator, derived from how far its own implied idle
 * rate sits from the rate the device reports for the same moments. Returns 1
 * whenever the evidence is thin or the two elements already agree — a wrong
 * correction is worse than none.
 */
export function deriveBurnFactor(
  learnedIdleLph: number | null,
  accumulatorIdleLph: number | null,
  samples: number,
  /** Anything already measured from receipts is left alone. */
  existingSource?: string | null,
  existingFactor?: number
): { factor: number; source: string | null } {
  if (existingSource === RECEIPT_BURN_FACTOR_SOURCE && existingFactor) {
    return { factor: existingFactor, source: existingSource };
  }

  if (
    learnedIdleLph == null ||
    accumulatorIdleLph == null ||
    accumulatorIdleLph <= 0 ||
    samples < BURN_FACTOR_MIN_SAMPLES
  ) {
    return { factor: 1, source: null };
  }

  const ratio = learnedIdleLph / accumulatorIdleLph;
  if (Math.abs(ratio - 1) <= BURN_FACTOR_DEADBAND) return { factor: 1, source: null };

  return {
    factor: Math.min(BURN_FACTOR_MAX, Math.max(BURN_FACTOR_MIN, ratio)),
    source: 'device_rate_cross_check',
  };
}

interface FuelGpsReading {
  fuelUsedMl: number;
  fuelRateLph: number | null;
  ignitionOn: boolean;
  speedKph: number | null;
  recordedAt: Date;
  /** Total odometer in metres — the distance half of the burn model. */
  odometerM: number | null;
}

/**
 * Fuel burned over one hop, modelled from what the tracker measures reliably.
 *
 * Not from AVL 12. On this fleet the accumulator counted 13 ml across 3.55 km
 * of driving while AVL 13 sat at a constant 2.47 l/h whether moving, idling or
 * parked — neither element describes the vehicle, because the Configurator's
 * fuel parameters were never set. The odometer, by contrast, validates against
 * the dashboard to 0.03%.
 *
 * So: litres per km from the vehicle's own consumption rate, plus idle burn for
 * engine-on time that covered no ground. Both rates come from the vehicle row —
 * the manager's dashboard figure when they have entered one, otherwise the
 * class preset.
 *
 * **Each hop is charged at the rate for the speed it was driven at.** A flat
 * rate said a kilometre crawling through Lagos traffic cost exactly what a
 * kilometre of steady 60 km/h cruising cost, which no vehicle has ever managed:
 * real economy follows a U-curve, worst in stop-start and again at motorway
 * speed, best in the middle. The multipliers live in `SPEED_BUCKETS` and are
 * applied on top of the base rate rather than baked into it, so the vehicle's
 * stored rate stays comparable across vehicles and a calibration measured over
 * mixed driving is still meaningful.
 *
 * The speed used is the hop's own average — distance over elapsed time — not
 * the instantaneous `speedKph` on the closing reading, which is a snapshot of
 * one moment and would put a whole minute of crawling into the highway band
 * because the vehicle happened to be accelerating as the packet was sent.
 *
 * This is an estimate and must never be presented as a measurement. It is
 * defensible arithmetic over good inputs, which is more than the device's own
 * fuel elements currently offer.
 */
export function modelHopBurnMl(params: {
  distanceKm: number;
  seconds: number;
  ignitionOn: boolean;
  speedKph: number | null;
  consumptionL100km: number;
  idleBurnLph: number;
}): number {
  const { distanceKm, seconds, ignitionOn, speedKph, consumptionL100km, idleBurnLph } = params;

  // Average speed over the hop. Falls back to the reported instantaneous speed
  // when the elapsed time is unusable, and `speedBucketMultiplier` returns 1
  // for a null — an unknown speed earns no adjustment rather than a guess.
  const avgSpeedKph =
    distanceKm > 0 && seconds > 0 ? (distanceKm / seconds) * 3600 : speedKph;

  const driving =
    distanceKm > 0
      ? (distanceKm * consumptionL100km * speedBucketMultiplier(avgSpeedKph)) / 100
      : 0;

  // Idle only counts when the engine is running and the vehicle is not moving.
  // A hop that covered ground is charged for the distance, not for its seconds:
  // charging both would double-bill the same fuel.
  //
  // The gap is capped because a long one is silence, not observed idling. When
  // the tracker returned on 2026-08-11 after 13.7 hours off air, its first
  // packet carried ignition-on at a standstill and the uncapped gap modelled
  // **16.4 litres** of idling in a single hop — a tankful invented out of a
  // reporting outage. Same 600 s ceiling the delta CTEs use for idle time, so
  // the tank and the reports agree on what an unobserved gap is worth.
  const idleSeconds = Math.min(Math.max(0, seconds), MAX_IDLE_HOP_SECONDS);
  const idling =
    ignitionOn && distanceKm <= 0 && (speedKph ?? 0) < 2
      ? (idleSeconds / 3600) * idleBurnLph
      : 0;

  return Math.max(0, Math.round((driving + idling) * 1000));
}

interface IdleBurnTracker {
  startedAt: number;
  wasteMl: number;
  lastAt: number;
  alerted: boolean;
}

const idleBurnByImei = new Map<string, IdleBurnTracker>();

/**
 * Part-built idle window per device, for the burn-factor cross-check.
 *
 * The check compares what AVL 13 says is burning against what AVL 12 actually
 * accumulated, and needs a stretch long enough for the accumulator to move —
 * a 2-second hop rounds to noise. That was enforced by requiring a single
 * ≥30 s gap between consecutive readings, which on this fleet almost never
 * happens: the FMC150 reports every 5-8 seconds with the engine on, so nearly
 * every idle sample was discarded for arriving too promptly. After two days of
 * real driving the correction had five samples of the ten it needs, and the
 * uncorrected accumulator went on under-reporting burn by ~2.6x.
 *
 * Consecutive stationary readings are accumulated here instead until 30 s of
 * engine time has passed, then taken as one sample. Same evidence, same
 * threshold — it simply stops throwing data away because the device is
 * talkative. In-memory by design: a restart loses at most one partial window.
 */
interface IdleCrossCheckWindow {
  ml: number;
  seconds: number;
  /** Rate samples over the window, averaged so one noisy frame cannot define it. */
  rateSum: number;
  rateCount: number;
}

const idleCrossCheckByImei = new Map<string, IdleCrossCheckWindow>();

/** Minimum engine-on time a burn-factor sample must span. */
const IDLE_CROSS_CHECK_WINDOW_SECONDS = 30;

/** A stationary run is broken by this much silence; a stale window is dropped. */
const IDLE_CROSS_CHECK_MAX_GAP_SECONDS = 600;

/** Above this, an odometer jump is a bad frame rather than distance travelled. */
const MAX_PLAUSIBLE_SPEED_KPH = 160;

/**
 * Longest stretch a single hop may be charged idle burn for.
 *
 * Matches the 600 s cap the distance and idle CTEs apply. Beyond it the gap is
 * a tracker that stopped reporting, and billing it as idling invents fuel.
 */
const MAX_IDLE_HOP_SECONDS = 600;

/** Fallbacks when a vehicle has no rate of its own recorded yet. */
const FALLBACK_CONSUMPTION_L100KM = 14.3;
const FALLBACK_IDLE_BURN_LPH = 1.2;

/**
 * The consumption and idle rates the burn model runs on.
 *
 * Read per reading rather than cached: a manager who corrects the figure in
 * Calibration expects the tank to start using it, not to wait for a restart.
 * The vehicle row already carries whichever rate is in force — the dashboard
 * figure they entered, a fill-to-fill calibration, or the class preset.
 */
async function vehicleBurnRates(
  vehicleId: string
): Promise<{ consumptionL100km: number; idleBurnLph: number }> {
  const [row] = await db
    .select({
      consumption: vehicles.consumptionRateL100km,
      idle: vehicles.idleBurnRateLph,
    })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId))
    .limit(1);

  const consumption = row?.consumption != null ? Number(row.consumption) : NaN;
  const idle = row?.idle != null ? Number(row.idle) : NaN;

  return {
    consumptionL100km:
      Number.isFinite(consumption) && consumption > 0 ? consumption : FALLBACK_CONSUMPTION_L100KM,
    idleBurnLph: Number.isFinite(idle) && idle > 0 ? idle : FALLBACK_IDLE_BURN_LPH,
  };
}

const rowToState = (row: typeof virtualTanks.$inferSelect): VirtualTankState => ({
  vehicleId: row.vehicleId,
  customerId: row.customerId,
  capacityLiters: Number(row.capacityLiters),
  levelMl: Number(row.levelMl),
  lastFuelUsedMl: row.lastFuelUsedMl != null ? Number(row.lastFuelUsedMl) : null,
  lastReadingAt: row.lastReadingAt,
  calibratedAt: row.calibratedAt,
  calibrationSource: row.calibrationSource,
  consumedSinceCalibrationMl: Number(row.consumedSinceCalibrationMl ?? 0),
  learnedIdleLph: row.learnedIdleLph != null ? Number(row.learnedIdleLph) : null,
  accumulatorIdleLph: row.accumulatorIdleLph != null ? Number(row.accumulatorIdleLph) : null,
  burnFactor: row.burnFactor != null ? Number(row.burnFactor) : 1,
  burnFactorSource: row.burnFactorSource,
  burnFactorSamples: row.burnFactorSamples ?? 0,
  anchorLevelMl: row.anchorLevelMl != null ? Number(row.anchorLevelMl) : null,
  anchorAccumulatorMl:
    row.anchorAccumulatorMl != null ? Number(row.anchorAccumulatorMl) : null,
  accumulatorOffsetMl: Number(row.accumulatorOffsetMl ?? 0),
  modelledBurnMl: Number(row.modelledBurnMl ?? 0),
  anchorModelledMl: row.anchorModelledMl != null ? Number(row.anchorModelledMl) : null,
  lastOdometerM: row.lastOdometerM != null ? Number(row.lastOdometerM) : null,
  confidence: row.confidence,
});

export async function getVirtualTank(vehicleId: string): Promise<VirtualTankState | null> {
  const [row] = await db
    .select()
    .from(virtualTanks)
    .where(eq(virtualTanks.vehicleId, vehicleId))
    .limit(1);
  return row ? rowToState(row) : null;
}

// Uncalibrated tanks start at half capacity with low confidence — the UI
// prompts the manager to calibrate before trusting the level.
async function initTank(vehicleId: string, customerId: string): Promise<VirtualTankState> {
  const [vehicle] = await db
    .select({ tankCapacityLiters: vehicles.tankCapacityLiters })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId))
    .limit(1);

  const capacity = vehicle?.tankCapacityLiters || DEFAULT_CAPACITY_LITERS;
  const [row] = await db
    .insert(virtualTanks)
    .values({
      vehicleId,
      customerId,
      capacityLiters: capacity.toString(),
      levelMl: Math.round(capacity * 500),
      confidence: 30,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return rowToState(row);
  return (await getVirtualTank(vehicleId)) as VirtualTankState;
}

// Confidence: 100 at calibration, decaying with drift exposure — consumption
// (GPS burn error compounds per litre) and elapsed days. Floor 20 so the UI
// still shows a number; never calibrated caps at 40.
function computeConfidence(state: VirtualTankState, now: Date): number {
  if (!state.calibratedAt) return Math.min(40, state.confidence);
  const consumedPct =
    state.capacityLiters > 0
      ? (state.consumedSinceCalibrationMl / 1000 / state.capacityLiters) * 100
      : 0;
  const days = (now.getTime() - state.calibratedAt.getTime()) / 86_400_000;
  return Math.max(20, Math.round(100 - consumedPct * 0.3 - days * 1.5));
}

async function hasOpenAlert(customerId: string, vehicleId: string, alertType: string): Promise<boolean> {
  const [row] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.customerId, customerId),
        eq(alerts.vehicleId, vehicleId),
        eq(alerts.alertType, alertType),
        eq(alerts.isResolved, false)
      )
    )
    .limit(1);
  return !!row;
}

// Rule: Fuel Rate GPS active while the vehicle is stationary = engine burning
// fuel going nowhere. Sustained past IDLE_WASTE_MIN_MINUTES → operational
// waste event + alert with the measured litres.
async function trackIdleWaste(
  imei: string,
  state: VirtualTankState,
  reading: FuelGpsReading,
  ctx: { latitude: string | null; longitude: string | null; licensePlate?: string }
): Promise<void> {
  const stationary = reading.ignitionOn && (reading.speedKph ?? 0) < 2;
  const rate = reading.fuelRateLph;
  const threshold = Math.max(
    IDLE_WASTE_RATE_FLOOR_LPH,
    (state.learnedIdleLph ?? 0) * IDLE_WASTE_RATE_FACTOR
  );

  if (!stationary || rate == null || rate <= 0) {
    idleBurnByImei.delete(imei);
    return;
  }

  const now = reading.recordedAt.getTime();
  const tracker = idleBurnByImei.get(imei);
  if (!tracker) {
    idleBurnByImei.set(imei, { startedAt: now, wasteMl: 0, lastAt: now, alerted: false });
    return;
  }

  const elapsedH = Math.max(0, (now - tracker.lastAt) / 3_600_000);
  tracker.wasteMl += rate * 1000 * elapsedH;
  tracker.lastAt = now;

  const idleMinutes = (now - tracker.startedAt) / 60_000;
  if (tracker.alerted || idleMinutes < IDLE_WASTE_MIN_MINUTES || rate < threshold) return;

  tracker.alerted = true;
  const wasteLiters = tracker.wasteMl / 1000;
  const plate = ctx.licensePlate ?? 'vehicle';

  await db.insert(deviceEvents).values({
    imei,
    customerId: state.customerId,
    vehicleId: state.vehicleId,
    eventType: 'idle_fuel_waste',
    severity: 'warning',
    value: rate.toFixed(2),
    unit: 'l/h',
    speedKph: reading.speedKph,
    latitude: ctx.latitude,
    longitude: ctx.longitude,
    occurredAt: reading.recordedAt,
  });

  if (!(await hasOpenAlert(state.customerId, state.vehicleId, 'idle_fuel_waste'))) {
    await db.insert(alerts).values({
      imei,
      customerId: state.customerId,
      vehicleId: state.vehicleId,
      alertType: 'idle_fuel_waste',
      message: `Operational waste on ${plate}: burning ${rate.toFixed(1)} L/h while stationary for ${Math.round(idleMinutes)} min (~${wasteLiters.toFixed(1)}L wasted). Typical idle for this vehicle is ${(state.learnedIdleLph ?? IDLE_WASTE_RATE_FLOOR_LPH).toFixed(1)} L/h.`,
      fuelDropLiters: wasteLiters.toFixed(2),
      latitude: ctx.latitude,
      longitude: ctx.longitude,
    });
  }
}

export interface FuelGpsResult {
  levelLiters: number;
  confidence: number;
  deltaMl: number;
  accumulatorReset: boolean;
  /**
   * Fuel this hop burned, in millilitres, straight from the model.
   *
   * Stored per telemetry row so consumption can be **summed** rather than
   * reconstructed by differencing `fuel_level_liters`. That column is rounded
   * to 2 dp and, because the device batches records and we order by its own
   * timestamps, the series is not monotonic: on 2026-08-11 it wobbled by
   * 0.08-0.12 L, and summing only the down-steps while discarding the up-steps
   * inflated a real 10.2 L burn to 11.3 L — surfacing as "1.0 L the tracker
   * cannot account for". A per-hop figure is order-independent and exact.
   */
  burnMl: number;
}

// Main ingestion hook — called from the TCP server for every AVL record that
// carries Fuel Used GPS. Returns the modelled level so the caller can store
// it as telemetry.fuel_level_liters (source 'virtual').
export async function processFuelGpsReading(
  imei: string,
  vehicleId: string,
  customerId: string,
  reading: FuelGpsReading,
  ctx: { latitude: string | null; longitude: string | null; licensePlate?: string }
): Promise<FuelGpsResult> {
  const state = (await getVirtualTank(vehicleId)) ?? (await initTank(vehicleId, customerId));

  // Delta since last ping. The accumulator only grows while the engine runs.
  // Three cases when it doesn't: a real power-cycle (restarts near zero, so
  // everything it has counted since boot is unseen burn), firmware jitter (a
  // few ml backwards — re-baseline but consume nothing), and an implausible
  // jump (clamped below, since no hop can burn more than a tankful).
  let deltaMl = 0;
  let accumulatorReset = false;
  if (state.lastFuelUsedMl != null) {
    if (reading.fuelUsedMl >= state.lastFuelUsedMl) {
      deltaMl = reading.fuelUsedMl - state.lastFuelUsedMl;
    } else if (reading.fuelUsedMl <= state.lastFuelUsedMl * ACCUMULATOR_RESET_MAX_FRACTION) {
      accumulatorReset = true;
      deltaMl = reading.fuelUsedMl;
    }
  }

  const capacityMlLimit = Math.round(state.capacityLiters * 1000);
  if (capacityMlLimit > 0 && deltaMl > capacityMlLimit) {
    console.warn(
      `[virtual_tank] ${imei}: implausible burn ${deltaMl}ml > tank ${capacityMlLimit}ml — clamped`
    );
    deltaMl = capacityMlLimit;
  }

  // Learn the vehicle's true idle burn from stationary rate samples
  let learnedIdleLph = state.learnedIdleLph;
  let accumulatorIdleLph = state.accumulatorIdleLph;
  let burnFactorSamples = state.burnFactorSamples;
  const stationary = reading.ignitionOn && (reading.speedKph ?? 0) < 2;
  const rate = reading.fuelRateLph;
  const gapSeconds =
    state.lastReadingAt != null
      ? (reading.recordedAt.getTime() - state.lastReadingAt.getTime()) / 1000
      : 0;

  if (stationary && rate != null && rate >= IDLE_RATE_MIN_LPH && rate <= IDLE_RATE_MAX_LPH) {
    learnedIdleLph =
      learnedIdleLph == null
        ? rate
        : learnedIdleLph + IDLE_EMA_ALPHA * (rate - learnedIdleLph);

    // What the accumulator itself claims was burned over the same stretch.
    // Accumulated across consecutive stationary readings until the window is
    // long enough to carry a meaningful delta — see `idleCrossCheckByImei`.
    if (!accumulatorReset && gapSeconds > 0 && gapSeconds <= IDLE_CROSS_CHECK_MAX_GAP_SECONDS) {
      const window = idleCrossCheckByImei.get(imei) ?? {
        ml: 0,
        seconds: 0,
        rateSum: 0,
        rateCount: 0,
      };
      window.ml += deltaMl;
      window.seconds += gapSeconds;
      window.rateSum += rate;
      window.rateCount += 1;

      if (window.seconds >= IDLE_CROSS_CHECK_WINDOW_SECONDS) {
        const impliedLph = (window.ml / 1000 / window.seconds) * 3600;
        if (impliedLph >= IDLE_RATE_MIN_LPH && impliedLph <= IDLE_RATE_MAX_LPH) {
          accumulatorIdleLph =
            accumulatorIdleLph == null
              ? impliedLph
              : accumulatorIdleLph + IDLE_EMA_ALPHA * (impliedLph - accumulatorIdleLph);
          burnFactorSamples += 1;
        }
        idleCrossCheckByImei.delete(imei);
      } else {
        idleCrossCheckByImei.set(imei, window);
      }
    } else if (accumulatorReset || gapSeconds > IDLE_CROSS_CHECK_MAX_GAP_SECONDS) {
      // A power cycle or a long silence means the part-built window no longer
      // describes one continuous stretch of idling.
      idleCrossCheckByImei.delete(imei);
    }
  } else {
    // Moving or engine off — the stationary run is over.
    idleCrossCheckByImei.delete(imei);
  }

  const { factor: burnFactor, source: burnFactorSource } = deriveBurnFactor(
    learnedIdleLph,
    accumulatorIdleLph,
    burnFactorSamples,
    state.burnFactorSource,
    state.burnFactor
  );

  // Retained for diagnostics only — the AVL 12 figure is still recorded and
  // still shown in the signals table, but it no longer moves the tank.
  const correctedDeltaMl = Math.round(deltaMl * burnFactor);

  const accumulatorOffsetMl = accumulatorReset
    ? state.accumulatorOffsetMl + (state.lastFuelUsedMl ?? 0)
    : state.accumulatorOffsetMl;

  // ---- Modelled burn: distance and idle time, not the device's fuel elements.
  const rates = await vehicleBurnRates(vehicleId);

  // Odometer is cumulative and monotonic. A backwards step means the device was
  // replaced or reset, so re-baseline rather than book negative distance; a
  // forward jump beyond what the gap could cover is a bad frame and is ignored.
  let hopKm = 0;
  if (state.lastOdometerM != null && reading.odometerM != null) {
    const deltaM = reading.odometerM - state.lastOdometerM;
    const maxKm = Math.max(1, (Math.max(0, gapSeconds) / 3600) * MAX_PLAUSIBLE_SPEED_KPH);
    if (deltaM > 0 && deltaM / 1000 <= maxKm) hopKm = deltaM / 1000;
  }

  const hopBurnMl = modelHopBurnMl({
    distanceKm: hopKm,
    seconds: gapSeconds,
    ignitionOn: reading.ignitionOn,
    speedKph: reading.speedKph,
    consumptionL100km: rates.consumptionL100km,
    idleBurnLph: rates.idleBurnLph,
  });

  const modelledBurnMl = state.modelledBurnMl + hopBurnMl;

  // Anchor on first sight, or after a calibration that left none behind.
  const anchorAccumulatorMl = state.anchorAccumulatorMl ?? accumulatorTotalMl(
    reading.fuelUsedMl,
    accumulatorOffsetMl
  );
  const anchorModelledMl = state.anchorModelledMl ?? modelledBurnMl;
  const anchorLevelMl = state.anchorLevelMl ?? state.levelMl;

  // Same anchored model as before — absolute travel since the anchor, so fuel
  // burned while the tracker was offline is still counted once it reports
  // again, and one bad write cannot drift the tank permanently. Only the
  // counter feeding it has changed. Factor is 1: the model needs no correction
  // because it is not derived from the miscalibrated accumulator.
  const levelMl = levelFromAnchor(
    anchorLevelMl,
    anchorModelledMl,
    modelledBurnMl,
    1,
    capacityMlLimit
  );
  const consumedSinceCalibrationMl = Math.max(0, anchorLevelMl - levelMl);

  const nextState: VirtualTankState = {
    ...state,
    levelMl,
    consumedSinceCalibrationMl,
    learnedIdleLph,
    accumulatorIdleLph,
    burnFactor,
    burnFactorSource,
    modelledBurnMl,
    anchorModelledMl,
    lastOdometerM: reading.odometerM ?? state.lastOdometerM,
  };
  const confidence = computeConfidence(nextState, reading.recordedAt);

  await db
    .update(virtualTanks)
    .set({
      levelMl,
      lastFuelUsedMl: reading.fuelUsedMl,
      lastReadingAt: reading.recordedAt,
      consumedSinceCalibrationMl,
      anchorLevelMl,
      anchorAccumulatorMl,
      accumulatorOffsetMl,
      modelledBurnMl,
      anchorModelledMl,
      lastOdometerM: reading.odometerM ?? state.lastOdometerM,
      learnedIdleLph: learnedIdleLph != null ? learnedIdleLph.toFixed(3) : null,
      accumulatorIdleLph: accumulatorIdleLph != null ? accumulatorIdleLph.toFixed(3) : null,
      burnFactor: burnFactor.toFixed(3),
      burnFactorSource,
      burnFactorSamples,
      confidence,
      updatedAt: sql`NOW()`,
    })
    .where(eq(virtualTanks.vehicleId, vehicleId));

  await trackIdleWaste(imei, nextState, reading, ctx);

  const levelLiters = levelMl / 1000;
  const capacityMl = state.capacityLiters * 1000;
  if (
    capacityMl > 0 &&
    levelLiters <= RESERVE_LITERS_DEFAULT &&
    !(await hasOpenAlert(customerId, vehicleId, 'low_fuel'))
  ) {
    const percent = (levelMl / capacityMl) * 100;
    await db.insert(alerts).values({
      imei,
      customerId,
      vehicleId,
      alertType: 'low_fuel',
      message: `${ctx.licensePlate ?? 'Vehicle'} is running on its reserve — about ${levelLiters.toFixed(1)}L left, the same point a real dashboard's low-fuel light would already be on. Refuel soon.`,
      fuelLevelLiters: levelLiters.toFixed(2),
      latitude: ctx.latitude,
      longitude: ctx.longitude,
    });

    // Not awaited: ingestion must never wait on SMTP, and a failed
    // notification must not cost us the telemetry record that triggered it.
    void emailLowFuel({
      customerId,
      licensePlate: ctx.licensePlate ?? 'Vehicle',
      levelLiters,
      capacityLiters: state.capacityLiters,
      percent,
      confidence,
      latitude: ctx.latitude,
      longitude: ctx.longitude,
    }).catch((err) => console.error('[virtual_tank] low fuel email failed:', err));
  }

  return { levelLiters, confidence, deltaMl, accumulatorReset, burnMl: hopBurnMl };
}

/** Emails the low-fuel warning, when this customer has opted in to it. */
async function emailLowFuel(ctx: {
  customerId: string;
  licensePlate: string;
  levelLiters: number;
  capacityLiters: number;
  percent: number;
  confidence: number;
  latitude: string | null;
  longitude: string | null;
}): Promise<void> {
  const to = await resolveAlertRecipient(ctx.customerId, 'low_fuel');
  if (!to) return;

  // The level is modelled from GPS fuel use, not read from a sender, so the
  // mail states the confidence rather than presenting it as a measurement.
  const { text, html } = alertEmail({
    title: `${ctx.licensePlate} is low on fuel`,
    lines: [
      ['Vehicle', ctx.licensePlate],
      ['Estimated level', `${ctx.levelLiters.toFixed(1)} L of ${ctx.capacityLiters} L`],
      ['Tank', `${ctx.percent.toFixed(0)}%`],
      ['Model confidence', `${ctx.confidence}%`],
      ['Basis', 'Calculated from GPS fuel use since the last calibration, not a tank sensor'],
    ],
    linkUrl:
      ctx.latitude && ctx.longitude
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${ctx.latitude},${ctx.longitude}`)}`
        : null,
    linkLabel: 'Where the vehicle is now',
    footer: 'FuelSense · turn these off in Settings → Notifications',
  });

  await sendMail({ to, subject: `${ctx.licensePlate}: fuel low (~${ctx.levelLiters.toFixed(1)}L)`, text, html });
}

// Manager action: anchor the model to a known level. liters == null → full tank.
/**
 * Write a changed tank level into the telemetry series at the moment it changes.
 *
 * Every fuel curve on the dashboard is drawn from telemetry, and the next frame
 * carrying the new level only arrives when the vehicle next reports — which can
 * be the following day. Until then the vehicle panel reads the updated tank
 * while the map card reads the stale row, and the two disagree by the size of
 * the step.
 *
 * Carries no position, speed or ignition: this is a fuel-level marker and trip
 * maths must not see it as movement. It does carry the vehicle's last known
 * odometer, because the distance CTEs read the previous odometer with LAG over
 * every row — a NULL there breaks the chain and silently drops one hop of
 * travel. Repeating the last reading records the marker as exactly zero
 * movement, which is what it is.
 */
async function insertFuelLevelMarker(
  vehicleId: string,
  customerId: string,
  levelLiters: number,
  source: FuelMarkerSource
): Promise<void> {
  const [last] = await db
    .select({ odometerKm: telemetry.odometerKm, odometerM: telemetry.odometerM })
    .from(telemetry)
    .where(and(eq(telemetry.vehicleId, vehicleId), eq(telemetry.customerId, customerId)))
    .orderBy(sql`recorded_at DESC`)
    .limit(1);

  await db.insert(telemetry).values({
    customerId,
    vehicleId,
    recordedAt: new Date(),
    fuelLevelLiters: levelLiters.toFixed(2),
    fuelSource: source,
    odometerKm: last?.odometerKm ?? null,
    odometerM: last?.odometerM ?? null,
  });
}

export async function calibrateTank(
  vehicleId: string,
  customerId: string,
  liters: number | null,
  source = 'manual'
): Promise<VirtualTankState> {
  const state = (await getVirtualTank(vehicleId)) ?? (await initTank(vehicleId, customerId));

  const [vehicle] = await db
    .select({ tankCapacityLiters: vehicles.tankCapacityLiters })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId))
    .limit(1);
  const capacity = vehicle?.tankCapacityLiters || state.capacityLiters || DEFAULT_CAPACITY_LITERS;

  const targetLiters = liters == null ? capacity : Math.min(Math.max(liters, 0), capacity);
  const levelMl = Math.round(targetLiters * 1000);

  const [row] = await db
    .update(virtualTanks)
    .set({
      capacityLiters: capacity.toString(),
      levelMl,
      // "The tank holds exactly this much now" — anything burned before this
      // moment is already priced in. Dropping the accumulator pointer makes the
      // next device reading re-baseline, so a stale pointer can never be billed
      // as a phantom catch-up delta.
      lastFuelUsedMl: null,
      // The modelled counter keeps running — it is a lifetime total — but the
      // anchor moves to here, so everything burned before this calibration is
      // already priced into the level the manager just declared.
      anchorModelledMl: sql`modelled_burn_ml`,
      // The anchor has to go with it. `applyFuelGpsReading` recomputes the
      // level from (anchorLevel − travelled × k) and only falls back to the
      // calibrated level when no anchor is stored, so leaving a stale anchor
      // here meant the very next frame recomputed the old level and silently
      // threw the calibration away.
      anchorLevelMl: null,
      anchorAccumulatorMl: null,
      calibratedAt: sql`NOW()`,
      calibrationSource: source,
      consumedSinceCalibrationMl: 0,
      confidence: 100,
      updatedAt: sql`NOW()`,
    })
    .where(eq(virtualTanks.vehicleId, vehicleId))
    .returning();

  // Mark the step in the series. Without this the calibration only reaches
  // telemetry via the next device frame, which carries the new level on an
  // ordinary `virtual` row — indistinguishable from burn, and counted as such.
  await insertFuelLevelMarker(vehicleId, customerId, targetLiters, 'calibration');

  return rowToState(row);
}

// Refuel credit from a submitted/verified fuel receipt. Clamped to capacity;
// a declared amount that would overflow the tank is itself a fraud signal the
// receipt-reconciliation flow surfaces separately.
/**
 * How far the tank model was out, judged by a fill it could not physically
 * have accepted.
 *
 * The tank is the source of truth for how much fuel a vehicle has, so a refuel
 * is the moment that truth gets audited: a driver cannot pour 45 litres into a
 * tank the model says has 30 litres of space. The excess is the amount the
 * model over-estimated, which is the same figure as fuel that left the vehicle
 * without being accounted for.
 *
 * Deliberately not called theft. Without a fuel-level sensor this is an
 * inference from paid-for litres against modelled burn, and it has honest
 * innocent explanations: a wrong consumption profile, an uncalibrated
 * accumulator, or a tank that was never as full as assumed.
 */
export function refuelDiscrepancyLiters(
  capacityLiters: number,
  levelLiters: number,
  addedLiters: number
): number {
  const headroom = Math.max(0, capacityLiters - levelLiters);
  const tolerance = Math.max(
    REFUEL_GAP_TOLERANCE_MIN_LITERS,
    capacityLiters * REFUEL_GAP_TOLERANCE_FRACTION
  );
  const excess = addedLiters - headroom;
  return excess > tolerance ? Number(excess.toFixed(2)) : 0;
}

export interface RefuelResult {
  state: VirtualTankState | null;
  /** Litres the model believed were in the tank but could not have been. */
  discrepancyLiters: number;
}

/**
 * Stores a correction measured from receipts, which then outranks the device
 * cross-check for good. Kept here so the tank owns every write to its own row.
 */
export async function applyReceiptBurnFactor(
  vehicleId: string,
  factor: number,
  intervals: number
): Promise<void> {
  await db
    .update(virtualTanks)
    .set({
      burnFactor: factor.toFixed(3),
      burnFactorSource: RECEIPT_BURN_FACTOR_SOURCE,
      burnFactorSamples: intervals,
      updatedAt: sql`NOW()`,
    })
    .where(eq(virtualTanks.vehicleId, vehicleId));
}

export async function creditRefuel(
  vehicleId: string,
  customerId: string,
  liters: number,
  options: { pricePerLiter?: number | null; licensePlate?: string } = {}
): Promise<RefuelResult> {
  if (!(liters > 0)) return { state: null, discrepancyLiters: 0 };
  const state = await getVirtualTank(vehicleId);
  if (!state) return { state: null, discrepancyLiters: 0 };

  const capacityMl = Math.round(state.capacityLiters * 1000);
  const discrepancyLiters = refuelDiscrepancyLiters(
    state.capacityLiters,
    state.levelMl / 1000,
    liters
  );

  // The fill is the better evidence, so the model is corrected to it rather
  // than the other way round: a tank that just took `liters` was holding
  // capacity minus that amount, whatever the model had been carrying.
  const levelMl =
    discrepancyLiters > 0
      ? capacityMl
      : Math.min(capacityMl, state.levelMl + Math.round(liters * 1000));

  const [row] = await db
    .update(virtualTanks)
    .set({
      levelMl,
      // Re-anchor: everything the accumulator counts from here is measured
      // against this fill, not against a calibration weeks ago.
      anchorLevelMl: levelMl,
      anchorAccumulatorMl: accumulatorTotalMl(
        state.lastFuelUsedMl ?? 0,
        state.accumulatorOffsetMl
      ),
      anchorModelledMl: sql`modelled_burn_ml`,
      consumedSinceCalibrationMl: 0,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(virtualTanks.vehicleId, vehicleId), eq(virtualTanks.customerId, customerId)))
    .returning();

  if (discrepancyLiters > 0) {
    await recordDiscrepancy(vehicleId, customerId, state, discrepancyLiters, options);
  }

  // Show the fill happening, on the same marker path as a calibration.
  await insertFuelLevelMarker(vehicleId, customerId, levelMl / 1000, 'receipt');

  return { state: row ? rowToState(row) : null, discrepancyLiters };
}

async function recordDiscrepancy(
  vehicleId: string,
  customerId: string,
  state: VirtualTankState,
  discrepancyLiters: number,
  options: { pricePerLiter?: number | null; licensePlate?: string }
): Promise<void> {
  const plate = options.licensePlate ?? 'Vehicle';
  const value =
    options.pricePerLiter && options.pricePerLiter > 0
      ? Math.round(discrepancyLiters * options.pricePerLiter)
      : null;

  await db.insert(deviceEvents).values({
    customerId,
    vehicleId,
    eventType: 'fuel_discrepancy',
    severity: 'warning',
    value: discrepancyLiters.toString(),
    unit: 'L',
    occurredAt: new Date(),
  });

  if (await hasOpenAlert(customerId, vehicleId, 'fuel_discrepancy')) return;

  const worth = value != null ? ` (about ₦${value.toLocaleString('en-NG')})` : '';
  await db.insert(alerts).values({
    customerId,
    vehicleId,
    alertType: 'fuel_discrepancy',
    message:
      `${plate} took on more fuel than its tank had room for by ${discrepancyLiters.toFixed(1)} L` +
      `${worth}. The vehicle was running emptier than the model showed, so either its ` +
      `consumption profile needs calibrating or fuel left the vehicle unaccounted for. ` +
      `Check the recent receipts before drawing a conclusion.`,
  });
}
