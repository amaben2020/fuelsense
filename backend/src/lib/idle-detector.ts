// Derives idling from the ignition and speed the tracker already sends.
//
// The Excessive Idling scenario (AVL 251) is not enabled on our trackers, so
// no idling event ever arrives from the device. But an engine that is running
// while the vehicle sits still is fully described by what we do receive:
// ignition ON with GNSS speed at zero. This module turns that into the same
// `idling_start` / `idling_end` events the decoder would have produced from
// AVL 251, so the driving-behaviour feed is correct without reconfiguring
// hardware in the field.
//
// Duration is measured from record TIMESTAMPS, never from how many records
// arrived. That matters: parked with the engine running, the FMC150 drops to
// its "on stop" cadence and can go an hour between frames. Timestamp maths
// still reports that hour correctly; counting frames would report nothing.
import { recordDeviceEvent } from './device-event-decoder';
import { db, alerts } from './db-helpers';
import { idleFuelBurnLiters, DEFAULT_FUEL_PRICE_NGN_LITER } from './fuel-metrics';
import { latestReceiptPrice } from './fuel-price';

// Below this the vehicle is not travelling — GNSS reports a few km/h of
// Doppler noise while stationary. Matches the idle definition already used by
// trip segmentation and the daily-activity rollup.
const IDLE_SPEED_KPH = 2;

// How long the engine must run stationary before it counts. Short enough to
// catch a driver warming the car up, long enough that a pause at a junction
// with the ignition on is not reported as idling.
const IDLE_MIN_MS = Number(process.env.IDLE_MIN_SECONDS || 120) * 1000;

// Idling past this is money burning with nothing moving, so the manager is
// told while it is still happening rather than at the end of the day.
const IDLE_ALERT_MINUTES = Number(process.env.IDLE_ALERT_MINUTES || 5);

export interface IdleReading {
  ignitionOn: boolean;
  speedKph: number | null;
  recordedAt: Date;
}

export interface IdleState {
  idleSince: Date;
  /** True once `idling_start` has been written for this stretch. */
  startEmitted: boolean;
  /** True once the long-idle alert has been raised for this stretch. */
  alerted?: boolean;
}

export interface IdleEmission {
  eventType: 'idling_start' | 'idling_end';
  occurredAt: Date;
  /** Minutes idled — carried on the end event only. */
  minutes: number | null;
}

const isStationaryRunning = (r: IdleReading): boolean =>
  r.ignitionOn && (r.speedKph ?? 0) < IDLE_SPEED_KPH;

/**
 * Pure state machine — one telemetry reading in, the next state and any
 * events to write out. Kept side-effect free so the timing rules can be
 * tested without a database or a device.
 */
export function stepIdle(
  state: IdleState | null,
  reading: IdleReading
): { state: IdleState | null; emissions: IdleEmission[] } {
  if (isStationaryRunning(reading)) {
    if (!state) {
      return {
        state: { idleSince: reading.recordedAt, startEmitted: false },
        emissions: [],
      };
    }

    const elapsed = reading.recordedAt.getTime() - state.idleSince.getTime();
    if (!state.startEmitted && elapsed >= IDLE_MIN_MS) {
      return {
        state: { ...state, startEmitted: true },
        // Backdated to when the engine actually started sitting, not to the
        // frame that happened to cross the threshold.
        emissions: [{ eventType: 'idling_start', occurredAt: state.idleSince, minutes: null }],
      };
    }
    return { state, emissions: [] };
  }

  // Engine off, or the vehicle has started moving — either way the stretch is
  // over. This reading's timestamp is the moment it ended.
  if (!state) return { state: null, emissions: [] };

  const elapsedMs = reading.recordedAt.getTime() - state.idleSince.getTime();
  if (!state.startEmitted && elapsedMs < IDLE_MIN_MS) {
    return { state: null, emissions: [] };
  }

  const emissions: IdleEmission[] = [];
  // A qualifying stretch that ended before any frame crossed the threshold
  // still gets both events, backdated. Without this, an idle that the device
  // reported only at its start and its end would vanish entirely.
  if (!state.startEmitted) {
    emissions.push({ eventType: 'idling_start', occurredAt: state.idleSince, minutes: null });
  }
  emissions.push({
    eventType: 'idling_end',
    occurredAt: reading.recordedAt,
    minutes: Math.round((elapsedMs / 60000) * 10) / 10,
  });

  return { state: null, emissions };
}

const stateByImei = new Map<string, IdleState>();

export function resetIdleDetectorState(): void {
  stateByImei.clear();
}

export interface IdleContext {
  imei: string;
  customerId: string;
  vehicleId: string;
  latitude: string | null;
  longitude: string | null;
  ignitionOn: boolean;
  speedKph: number | null;
  recordedAt: Date;
  licensePlate?: string | null;
}

/**
 * One alert per idle stretch that runs past the threshold.
 *
 * Deliberately not deduped against still-open alerts the way scenario events
 * are: each stretch is a separate cost the manager is entitled to see, and
 * suppressing the second one because the first was never dismissed would hide
 * exactly the repeat behaviour worth acting on.
 */
async function raiseIdleAlert(ctx: IdleContext, minutes: number): Promise<void> {
  const liters = idleFuelBurnLiters(minutes / 60);
  const price = await latestReceiptPrice(ctx.customerId).catch(() => null);
  // Priced off the last receipt a driver actually paid, so the naira figure
  // tracks the pump rather than an assumed rate.
  const ngnPerLiter = price?.ngnPerLiter ?? DEFAULT_FUEL_PRICE_NGN_LITER;
  const cost = Math.round(liters * ngnPerLiter);
  const plate = ctx.licensePlate ?? 'vehicle';

  await db.insert(alerts).values({
    imei: ctx.imei,
    customerId: ctx.customerId,
    vehicleId: ctx.vehicleId,
    alertType: 'excessive_idle',
    message: `${plate} idled ${Math.round(minutes)} min with the engine running and the vehicle stationary — about ${liters.toFixed(1)}L burned (₦${cost.toLocaleString('en-NG')} at ₦${Math.round(ngnPerLiter)}/L).`,
    fuelDropLiters: liters.toFixed(2),
    estimatedLossNgn: cost,
    latitude: ctx.latitude,
    longitude: ctx.longitude,
  });
}

/**
 * Feed every telemetry record here. Returns the events written, if any.
 *
 * In-memory state is deliberate and matches the trip notifier: a restart
 * mid-idle forgets the stretch in progress and the next stationary record
 * starts a fresh one. Under-reporting a restart is preferable to persisting
 * cursor state for a signal this cheap to recompute.
 */
export async function handleIdleForRecord(ctx: IdleContext): Promise<IdleEmission[]> {
  const prior = stateByImei.get(ctx.imei) ?? null;
  const { state, emissions } = stepIdle(prior, {
    ignitionOn: ctx.ignitionOn,
    speedKph: ctx.speedKph,
    recordedAt: ctx.recordedAt,
  });

  if (state) {
    // Alert while the engine is still running, not in hindsight: parked with
    // the ignition on, the FMC150 slows to its stop cadence, so the crossing
    // is detected on whichever frame arrives after the threshold passes.
    const minutes = (ctx.recordedAt.getTime() - state.idleSince.getTime()) / 60000;
    if (!state.alerted && minutes >= IDLE_ALERT_MINUTES) {
      await raiseIdleAlert(ctx, minutes);
      state.alerted = true;
    }
    stateByImei.set(ctx.imei, state);
  } else {
    // A stretch that began and ended between two frames never had a chance to
    // cross the threshold live — its true length is only known now.
    const ended = emissions.find((e) => e.eventType === 'idling_end');
    if (!prior?.alerted && ended?.minutes != null && ended.minutes >= IDLE_ALERT_MINUTES) {
      await raiseIdleAlert(ctx, ended.minutes);
    }
    stateByImei.delete(ctx.imei);
  }

  for (const emission of emissions) {
    await recordDeviceEvent(
      {
        eventType: emission.eventType,
        severity: 'info',
        value: emission.minutes,
        unit: emission.minutes != null ? 'min' : null,
        // Idling is a running cost, not a security incident — it belongs in
        // the behaviour feed, not in the alert list.
        alertMessage: null,
      },
      {
        imei: ctx.imei,
        customerId: ctx.customerId,
        vehicleId: ctx.vehicleId,
        latitude: ctx.latitude,
        longitude: ctx.longitude,
        speedKph: 0,
        occurredAt: emission.occurredAt,
      }
    );
  }

  return emissions;
}
