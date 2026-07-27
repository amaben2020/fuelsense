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
import { db, vehicles, alerts, deviceEvents, eq, and, sql } from './db-helpers';
import { virtualTanks } from '../db/schema';

export const FUEL_USED_GPS_AVL_ID = 12;
export const FUEL_RATE_GPS_AVL_ID = 13;
// Configurator shows "l/h*100" — raw AVL value 287 means 2.87 l/h
export const FUEL_RATE_GPS_DIVISOR = 100;

const DEFAULT_CAPACITY_LITERS = 60;
// A burn-rate reading is only a plausible idle sample inside this band
const IDLE_RATE_MIN_LPH = 0.2;
const IDLE_RATE_MAX_LPH = 8;
const IDLE_EMA_ALPHA = 0.1;
// Sustained idle burn above this multiple of the learned idle rate (or the
// absolute floor) for IDLE_WASTE_MIN_MINUTES raises an operational-waste alert
const IDLE_WASTE_RATE_FLOOR_LPH = 1.2;
const IDLE_WASTE_RATE_FACTOR = 1.5;
const IDLE_WASTE_MIN_MINUTES = 10;
const LOW_FUEL_PERCENT = 15;

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
  confidence: number;
}

interface FuelGpsReading {
  fuelUsedMl: number;
  fuelRateLph: number | null;
  ignitionOn: boolean;
  speedKph: number | null;
  recordedAt: Date;
}

interface IdleBurnTracker {
  startedAt: number;
  wasteMl: number;
  lastAt: number;
  alerted: boolean;
}

const idleBurnByImei = new Map<string, IdleBurnTracker>();

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

  // Delta since last ping. The accumulator only grows while the engine runs;
  // a smaller value than last time means the device power-cycled and restarted
  // from 0 — everything it counted since boot is unseen burn.
  let deltaMl = 0;
  let accumulatorReset = false;
  if (state.lastFuelUsedMl != null) {
    if (reading.fuelUsedMl >= state.lastFuelUsedMl) {
      deltaMl = reading.fuelUsedMl - state.lastFuelUsedMl;
    } else {
      accumulatorReset = true;
      deltaMl = reading.fuelUsedMl;
    }
  }

  const levelMl = Math.max(0, state.levelMl - deltaMl);
  const consumedSinceCalibrationMl = state.consumedSinceCalibrationMl + deltaMl;

  // Learn the vehicle's true idle burn from stationary rate samples
  let learnedIdleLph = state.learnedIdleLph;
  const stationary = reading.ignitionOn && (reading.speedKph ?? 0) < 2;
  const rate = reading.fuelRateLph;
  if (stationary && rate != null && rate >= IDLE_RATE_MIN_LPH && rate <= IDLE_RATE_MAX_LPH) {
    learnedIdleLph =
      learnedIdleLph == null
        ? rate
        : learnedIdleLph + IDLE_EMA_ALPHA * (rate - learnedIdleLph);
  }

  const nextState: VirtualTankState = {
    ...state,
    levelMl,
    consumedSinceCalibrationMl,
    learnedIdleLph,
  };
  const confidence = computeConfidence(nextState, reading.recordedAt);

  await db
    .update(virtualTanks)
    .set({
      levelMl,
      lastFuelUsedMl: reading.fuelUsedMl,
      lastReadingAt: reading.recordedAt,
      consumedSinceCalibrationMl,
      learnedIdleLph: learnedIdleLph != null ? learnedIdleLph.toFixed(3) : null,
      confidence,
      updatedAt: sql`NOW()`,
    })
    .where(eq(virtualTanks.vehicleId, vehicleId));

  await trackIdleWaste(imei, nextState, reading, ctx);

  const levelLiters = levelMl / 1000;
  const capacityMl = state.capacityLiters * 1000;
  if (
    capacityMl > 0 &&
    levelMl / capacityMl <= LOW_FUEL_PERCENT / 100 &&
    !(await hasOpenAlert(customerId, vehicleId, 'low_fuel'))
  ) {
    await db.insert(alerts).values({
      imei,
      customerId,
      vehicleId,
      alertType: 'low_fuel',
      message: `Low fuel on ${ctx.licensePlate ?? 'vehicle'}: virtual tank at ${((levelMl / capacityMl) * 100).toFixed(0)}% (~${levelLiters.toFixed(1)}L). Plan a refuel.`,
      fuelLevelLiters: levelLiters.toFixed(2),
      latitude: ctx.latitude,
      longitude: ctx.longitude,
    });
  }

  return { levelLiters, confidence, deltaMl, accumulatorReset };
}

// Manager action: anchor the model to a known level. liters == null → full tank.
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
      calibratedAt: sql`NOW()`,
      calibrationSource: source,
      consumedSinceCalibrationMl: 0,
      confidence: 100,
      updatedAt: sql`NOW()`,
    })
    .where(eq(virtualTanks.vehicleId, vehicleId))
    .returning();

  return rowToState(row);
}

// Refuel credit from a submitted/verified fuel receipt. Clamped to capacity;
// a declared amount that would overflow the tank is itself a fraud signal the
// receipt-reconciliation flow surfaces separately.
export async function creditRefuel(
  vehicleId: string,
  customerId: string,
  liters: number
): Promise<VirtualTankState | null> {
  if (!(liters > 0)) return null;
  const state = await getVirtualTank(vehicleId);
  if (!state) return null;

  const levelMl = Math.min(
    Math.round(state.capacityLiters * 1000),
    state.levelMl + Math.round(liters * 1000)
  );

  const [row] = await db
    .update(virtualTanks)
    .set({ levelMl, updatedAt: sql`NOW()` })
    .where(and(eq(virtualTanks.vehicleId, vehicleId), eq(virtualTanks.customerId, customerId)))
    .returning();

  return row ? rowToState(row) : null;
}
