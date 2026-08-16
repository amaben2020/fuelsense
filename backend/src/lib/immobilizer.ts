// Remote engine-start cutoff over the FMC150's wired digital output.
//
// Wiring the DOUT relay into the starter or fuel-pump circuit is a hardware
// step done at install time — this module only sends the command a wired
// relay listens for. On a device with no relay wired, the command is a no-op
// the vehicle never feels; there is no way to detect that from software, so
// the UI must say so rather than imply every fleet has this ready to go.
//
// Cutting power while a vehicle is moving is a real safety hazard, not a
// hypothetical one — user-confirmed gate: hard-block unless the vehicle's own
// telemetry shows it has been stopped, continuously, for a sustained window.
// There is no override path. A stolen vehicle being actively driven away is
// the one case a manager might want to override this for, and that is
// deliberately not offered — the risk of cutting power to a vehicle that
// merely looks stationary from a stale GPS fix is worse than letting a theft
// in progress run its course to the next real stop.
import { db, sql, alerts, devices, vehicles, eq, and } from './db-helpers';
import { tcpServer } from '../tcp-server';

/** Hardcoded for now — flip to a real subscription check once this ships
 *  past beta. Kept as a single constant so the gate lives in one place. */
export const IMMOBILIZER_ENABLED = true;

/** How long the vehicle must have been continuously stopped (ignition off,
 *  speed 0) before a command is allowed. */
const REQUIRED_STOPPED_MINUTES = 2;
/** Matches the device-offline watchdog's own window — a command sent to a
 *  device we have not heard from recently is a command sent blind. */
const DEVICE_FRESHNESS_MINUTES = 30;

/** Teltonika's digital-output GPRS command. DOUT1 is the output convention
 *  this fleet's installs wire to the immobilizer relay. */
const CMD_ENGAGE = 'setdigout 1';
const CMD_RELEASE = 'setdigout 0';

export interface ImmobilizerStatus {
  immobilized: boolean;
  immobilizedAt: string | null;
  /** Whether an immobilize command could be sent right now. */
  canImmobilize: boolean;
  /** Why it can't, when it can't — always populated when canImmobilize is false. */
  blockedReason: string | null;
  deviceOnline: boolean;
}

async function safetyCheck(
  vehicleId: string,
  customerId: string
): Promise<{ ok: boolean; reason: string | null; deviceOnline: boolean }> {
  const [device] = await db
    .select({ lastSeenAt: devices.lastSeenAt, imei: devices.imei })
    .from(devices)
    .where(and(eq(devices.vehicleId, vehicleId), eq(devices.customerId, customerId)));

  if (!device?.imei) {
    return { ok: false, reason: 'No tracker registered on this vehicle.', deviceOnline: false };
  }

  const deviceOnline =
    !!device.lastSeenAt &&
    Date.now() - new Date(device.lastSeenAt).getTime() < DEVICE_FRESHNESS_MINUTES * 60_000;

  if (!deviceOnline) {
    return {
      ok: false,
      reason: 'Tracker has not reported recently — cannot confirm the vehicle is stopped.',
      deviceOnline: false,
    };
  }

  const result = await db.execute(sql`
    SELECT MAX(recorded_at) AS last_moving_at
    FROM telemetry
    WHERE vehicle_id = ${vehicleId} AND customer_id = ${customerId}
      AND (ignition_on = true OR COALESCE(speed_kph, 0) > 0)
      AND recorded_at > NOW() - INTERVAL '1 hour'
  `);
  const lastMovingAt = (result.rows[0] as { last_moving_at: string | null } | undefined)
    ?.last_moving_at;

  if (lastMovingAt) {
    const stoppedForMs = Date.now() - new Date(lastMovingAt).getTime();
    if (stoppedForMs < REQUIRED_STOPPED_MINUTES * 60_000) {
      return {
        ok: false,
        reason: `Vehicle must be stopped, engine off, for ${REQUIRED_STOPPED_MINUTES} continuous minutes before it can be immobilized.`,
        deviceOnline: true,
      };
    }
  }

  return { ok: true, reason: null, deviceOnline: true };
}

export async function getImmobilizerStatus(
  vehicleId: string,
  customerId: string
): Promise<ImmobilizerStatus> {
  const [device] = await db
    .select({ immobilized: devices.immobilized, immobilizedAt: devices.immobilizedAt })
    .from(devices)
    .where(and(eq(devices.vehicleId, vehicleId), eq(devices.customerId, customerId)));

  const check = await safetyCheck(vehicleId, customerId);

  return {
    immobilized: !!device?.immobilized,
    immobilizedAt: device?.immobilizedAt ? new Date(device.immobilizedAt).toISOString() : null,
    canImmobilize: check.ok && !device?.immobilized,
    blockedReason: device?.immobilized ? null : check.reason,
    deviceOnline: check.deviceOnline,
  };
}

export interface ImmobilizerActionResult {
  ok: boolean;
  error?: string;
  status?: ImmobilizerStatus;
}

async function setImmobilized(
  vehicleId: string,
  customerId: string,
  engage: boolean,
  actorLabel: string
): Promise<ImmobilizerActionResult> {
  if (!IMMOBILIZER_ENABLED) {
    return { ok: false, error: 'Immobilizer is not enabled on this account.' };
  }

  const [device] = await db
    .select({ imei: devices.imei })
    .from(devices)
    .where(and(eq(devices.vehicleId, vehicleId), eq(devices.customerId, customerId)));

  if (!device?.imei) {
    return { ok: false, error: 'No tracker registered on this vehicle.' };
  }

  if (engage) {
    const check = await safetyCheck(vehicleId, customerId);
    if (!check.ok) {
      return { ok: false, error: check.reason ?? 'Vehicle is not safely stoppable right now.' };
    }
  }

  const live = tcpServer.getDevice(device.imei);
  if (!live) {
    return {
      ok: false,
      error: 'Tracker is not currently connected — the command has nowhere to go.',
    };
  }

  live.sendCommand(engage ? CMD_ENGAGE : CMD_RELEASE);

  await db
    .update(devices)
    .set({
      immobilized: engage,
      immobilizedAt: engage ? sql`NOW()` : null,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(devices.vehicleId, vehicleId), eq(devices.customerId, customerId)));

  const [vehicle] = await db
    .select({ licensePlate: vehicles.licensePlate })
    .from(vehicles)
    .where(eq(vehicles.id, vehicleId));

  // Every immobilize/release is an audit event, not just a state flip — a
  // manager reviewing this months later should see who did it and when.
  await db.insert(alerts).values({
    imei: device.imei,
    customerId,
    vehicleId,
    alertType: engage ? 'immobilizer_engaged' : 'immobilizer_released',
    message: engage
      ? `${vehicle?.licensePlate ?? 'Vehicle'} was remotely immobilized by ${actorLabel}. The engine will not start until it is released.`
      : `${vehicle?.licensePlate ?? 'Vehicle'} was released by ${actorLabel} and can start normally.`,
  });

  const status = await getImmobilizerStatus(vehicleId, customerId);
  return { ok: true, status };
}

export const engageImmobilizer = (vehicleId: string, customerId: string, actorLabel: string) =>
  setImmobilized(vehicleId, customerId, true, actorLabel);

export const releaseImmobilizer = (vehicleId: string, customerId: string, actorLabel: string) =>
  setImmobilized(vehicleId, customerId, false, actorLabel);
