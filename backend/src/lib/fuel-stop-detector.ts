// Spotting that a vehicle refuelled, on hardware that cannot see fuel.
//
// The FMC150 as fitted has no tank-level sensor, so a fill is invisible in the
// telemetry itself. What is visible is the behaviour around one: the vehicle
// pulls onto a forecourt, the engine goes off, it sits for a few minutes, then
// it leaves. Matched against Google's filling-station data that is strong
// evidence a fill happened — enough to verify a driver's receipt, and enough
// to notice a fill that was never logged at all.
//
// Timestamps, not frame counts: parked with the ignition off the device drops
// to its stop cadence and can go a long time between frames.
import { db, sql, deviceEvents } from './db-helpers';
import { nearbyFuelStation } from './place-lookup';

/** Below this the vehicle is standing still (GNSS noise floor). */
const STOP_SPEED_KPH = 2;

/** A fill takes a few minutes. Shorter stops are traffic, not fuel. */
const MIN_STOP_MINUTES = Number(process.env.FUEL_STOP_MIN_MINUTES || 3);

/** Longer than this and it is parked for the night, not buying fuel. */
const MAX_STOP_MINUTES = Number(process.env.FUEL_STOP_MAX_MINUTES || 45);

export interface StopReading {
  ignitionOn: boolean;
  speedKph: number | null;
  latitude: string | null;
  longitude: string | null;
  recordedAt: Date;
}

export interface StopState {
  since: Date;
  latitude: string | null;
  longitude: string | null;
}

export interface CompletedStop {
  startedAt: Date;
  endedAt: Date;
  minutes: number;
  latitude: string | null;
  longitude: string | null;
}

const isStopped = (r: StopReading): boolean => !r.ignitionOn || (r.speedKph ?? 0) < STOP_SPEED_KPH;

/**
 * Pure state machine: one reading in, the next state and a completed stop if
 * the vehicle just moved off. Kept side-effect free so the timing rules are
 * testable without a database or Google.
 */
export function stepStop(
  state: StopState | null,
  reading: StopReading
): { state: StopState | null; completed: CompletedStop | null } {
  if (isStopped(reading)) {
    if (state) return { state, completed: null };
    return {
      state: {
        since: reading.recordedAt,
        // The position where it came to rest, not wherever the last frame of
        // the stop happened to land.
        latitude: reading.latitude,
        longitude: reading.longitude,
      },
      completed: null,
    };
  }

  if (!state) return { state: null, completed: null };

  const minutes = (reading.recordedAt.getTime() - state.since.getTime()) / 60000;
  return {
    state: null,
    completed: {
      startedAt: state.since,
      endedAt: reading.recordedAt,
      minutes: Math.round(minutes * 10) / 10,
      latitude: state.latitude,
      longitude: state.longitude,
    },
  };
}

/** A stop of plausible length for a fill, with a position to check. */
export function isFuelStopCandidate(stop: CompletedStop): boolean {
  return (
    stop.minutes >= MIN_STOP_MINUTES &&
    stop.minutes <= MAX_STOP_MINUTES &&
    stop.latitude != null &&
    stop.longitude != null
  );
}

const stateByImei = new Map<string, StopState>();

export function resetFuelStopState(): void {
  stateByImei.clear();
}

export interface FuelStopContext {
  imei: string;
  customerId: string;
  vehicleId: string;
}

/**
 * Feed every telemetry record here. Writes a `fuel_stop` device event when a
 * completed stop turns out to have been on a forecourt.
 *
 * Returns the station name when one was recorded, so the caller can log it.
 * The unlogged-fill alert is not raised here — the driver may still be walking
 * back to the cab with the receipt. That check runs later, in the sweep.
 */
export async function handleFuelStopForRecord(
  ctx: FuelStopContext,
  reading: StopReading
): Promise<string | null> {
  const { state, completed } = stepStop(stateByImei.get(ctx.imei) ?? null, reading);

  if (state) stateByImei.set(ctx.imei, state);
  else stateByImei.delete(ctx.imei);

  if (!completed || !isFuelStopCandidate(completed)) return null;

  const station = await nearbyFuelStation(
    Number(completed.latitude),
    Number(completed.longitude)
  );
  if (!station) return null;

  // One event per stop. A device that reconnects and replays frames must not
  // produce a second fuel stop for the same minutes on the same forecourt.
  const existing = await db.execute(sql`
    SELECT 1 FROM device_events
    WHERE vehicle_id = ${ctx.vehicleId}
      AND event_type = 'fuel_stop'
      AND occurred_at BETWEEN ${completed.startedAt}::timestamp - INTERVAL '10 minutes'
        AND ${completed.startedAt}::timestamp + INTERVAL '10 minutes'
    LIMIT 1
  `);
  if (existing.rows.length > 0) return null;

  await db.insert(deviceEvents).values({
    imei: ctx.imei,
    customerId: ctx.customerId,
    vehicleId: ctx.vehicleId,
    eventType: 'fuel_stop',
    severity: 'info',
    value: completed.minutes.toString(),
    unit: 'min',
    latitude: completed.latitude,
    longitude: completed.longitude,
    speedKph: 0,
    occurredAt: completed.startedAt,
  });

  return station.name;
}
