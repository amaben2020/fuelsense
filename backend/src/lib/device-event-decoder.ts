// Decodes Teltonika FMC150 scenario events from AVL records.
//
// A record is treated as a scenario event only when its AVL "Event IO ID"
// field equals the scenario's IO element ID — Teltonika marks eventful
// records that way. The same IO values also ride along inside periodic
// records, and reading them there would double-count every event.
//
// FMC150 GNSS/accelerometer scenario AVL IDs (Codec 8 Extended):
//   253 Green driving type (1 accel, 2 brake, 3 cornering) + 254 value (g×100)
//   255 Overspeeding (speed km/h at trigger)
//   246 Towing detection        247 Crash detection
//   249 Jamming (1 start / 0 end)
//   252 Unplug (1 unplugged / 0 power restored)
//   251 Excessive idling (1 start / 0 end)
//   250 Trip (1 start / 0 stop)
//   175 Auto-geofence, 155-158 geofence zones 1-4 (1 enter / 0 exit)
import { db, deviceEvents, alerts, eq, and, sql } from './db-helpers';
import { getIoValue } from './avl-io';

export type EventSeverity = 'info' | 'warning' | 'critical';

export interface DecodedDeviceEvent {
  eventType: string;
  severity: EventSeverity;
  value: number | null;
  unit: string | null;
  alertMessage: string | null; // non-null → also raise a row in `alerts`
}

const GREEN_DRIVING_TYPES: Record<number, { type: string; label: string }> = {
  1: { type: 'harsh_acceleration', label: 'Harsh acceleration' },
  2: { type: 'harsh_braking', label: 'Harsh braking' },
  3: { type: 'harsh_cornering', label: 'Harsh cornering' },
};

const GEOFENCE_ZONE_IDS: Record<number, string> = {
  155: 'zone 1',
  156: 'zone 2',
  157: 'zone 3',
  158: 'zone 4',
  175: 'auto-geofence',
};

interface DecodeContext {
  io: Record<string | number, unknown> | undefined | null;
  speedKph: number | null;
  licensePlate?: string;
}

export const SCENARIO_EVENT_IO_IDS = [
  239, 246, 247, 249, 250, 251, 252, 253, 255, 175, 155, 156, 157, 158,
];

export function decodeScenarioEvent(
  eventIoId: number,
  ctx: DecodeContext
): DecodedDeviceEvent | null {
  const plate = ctx.licensePlate ?? 'vehicle';
  const state = getIoValue(ctx.io, eventIoId);

  switch (eventIoId) {
    case 239: {
      // The one scenario the tracker does report as an event. Recording it
      // gives the feed a truthful "engine was running from here to here" even
      // when the vehicle never moves and no trip is ever segmented.
      const on = state === 1;
      return {
        eventType: on ? 'ignition_on' : 'ignition_off',
        severity: 'info',
        value: null,
        unit: null,
        alertMessage: null,
      };
    }
    case 253: {
      const kind = GREEN_DRIVING_TYPES[state ?? 0];
      if (!kind) return null;
      const raw = getIoValue(ctx.io, 254);
      const gForce = raw != null ? Math.round(raw) / 100 : null;
      return {
        eventType: kind.type,
        severity: gForce != null && gForce >= 0.5 ? 'warning' : 'info',
        value: gForce,
        unit: 'g',
        alertMessage: null,
      };
    }
    case 255: {
      const speed = state ?? ctx.speedKph;
      return {
        eventType: 'overspeeding',
        severity: 'warning',
        value: speed,
        unit: 'km/h',
        alertMessage:
          speed != null
            ? `Overspeeding on ${plate}: GNSS speed hit ${Math.round(speed)} km/h above the configured limit.`
            : `Overspeeding detected on ${plate}.`,
      };
    }
    case 246: {
      if (state !== 1) return null;
      return {
        eventType: 'towing',
        severity: 'critical',
        value: null,
        unit: null,
        alertMessage: `Possible towing of ${plate}: movement detected with ignition OFF. Check the vehicle now.`,
      };
    }
    case 247: {
      if (!state || state < 1) return null;
      return {
        eventType: 'crash',
        severity: 'critical',
        value: state,
        unit: null,
        alertMessage: `Crash detected on ${plate}: high-G impact registered by the accelerometer.`,
      };
    }
    case 249: {
      const start = state === 1;
      return {
        eventType: start ? 'jamming_start' : 'jamming_end',
        severity: start ? 'critical' : 'info',
        value: null,
        unit: null,
        alertMessage: start
          ? `GNSS/GSM jamming detected on ${plate}: signal interference suggests a jammer near the vehicle.`
          : null,
      };
    }
    case 252: {
      const unplugged = state === 1;
      return {
        eventType: unplugged ? 'power_unplug' : 'power_restored',
        severity: unplugged ? 'critical' : 'info',
        value: null,
        unit: null,
        alertMessage: unplugged
          ? `Tracker on ${plate} lost main power and switched to its internal battery. Possible tamper or disconnect.`
          : null,
      };
    }
    case 251: {
      const start = state === 1;
      return {
        eventType: start ? 'idling_start' : 'idling_end',
        severity: start ? 'warning' : 'info',
        value: null,
        unit: null,
        alertMessage: null,
      };
    }
    case 250: {
      const started = state === 1;
      return {
        eventType: started ? 'trip_start' : 'trip_stop',
        severity: 'info',
        value: null,
        unit: null,
        // Managers want to know the moment a vehicle is taken out — it is the
        // one signal that a journey is beginning and can still be questioned.
        alertMessage: started
          ? `${plate} has started a trip. Ignition on and moving off.`
          : null,
      };
    }
    case 175:
    case 155:
    case 156:
    case 157:
    case 158: {
      const zone = GEOFENCE_ZONE_IDS[eventIoId];
      const entered = state === 1;
      return {
        eventType: entered ? 'geofence_enter' : 'geofence_exit',
        severity: entered ? 'info' : 'warning',
        value: eventIoId === 175 ? null : eventIoId - 154,
        unit: eventIoId === 175 ? null : 'zone',
        alertMessage: entered
          ? null
          : `${plate} left ${zone}. Movement outside the expected area.`,
      };
    }
    default:
      return null;
  }
}

interface EventRowContext {
  imei: string;
  customerId: string;
  vehicleId: string;
  latitude: string | null;
  longitude: string | null;
  speedKph: number | null;
  occurredAt: Date;
  licensePlate?: string;
}

async function hasOpenAlert(
  customerId: string,
  vehicleId: string,
  alertType: string
): Promise<boolean> {
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

// Persists a decoded scenario event and, for security-critical scenarios,
// raises an alert (deduped against unresolved alerts of the same type).
export async function recordDeviceEvent(
  decoded: DecodedDeviceEvent,
  ctx: EventRowContext
): Promise<void> {
  await db.insert(deviceEvents).values({
    imei: ctx.imei,
    customerId: ctx.customerId,
    vehicleId: ctx.vehicleId,
    eventType: decoded.eventType,
    severity: decoded.severity,
    value: decoded.value != null ? decoded.value.toString() : null,
    unit: decoded.unit,
    speedKph: ctx.speedKph,
    latitude: ctx.latitude,
    longitude: ctx.longitude,
    occurredAt: ctx.occurredAt,
  });

  if (!decoded.alertMessage) return;
  if (await hasOpenAlert(ctx.customerId, ctx.vehicleId, decoded.eventType)) return;

  await db.insert(alerts).values({
    imei: ctx.imei,
    customerId: ctx.customerId,
    vehicleId: ctx.vehicleId,
    alertType: decoded.eventType,
    message: decoded.alertMessage,
    latitude: ctx.latitude,
    longitude: ctx.longitude,
  });
}

// End-of-event closers auto-resolve the matching open alert so jamming/unplug
// alerts don't linger after the device reports recovery.
const EVENT_CLOSERS: Record<string, string> = {
  jamming_end: 'jamming_start',
  power_restored: 'power_unplug',
  // "Vehicle is out on a trip" stays open for the journey and closes when it
  // ends — otherwise dedup would suppress every trip start after the first.
  trip_stop: 'trip_start',
};

export async function resolveClosedAlert(
  eventType: string,
  customerId: string,
  vehicleId: string
): Promise<void> {
  const opens = EVENT_CLOSERS[eventType];
  if (!opens) return;
  await db
    .update(alerts)
    .set({ isResolved: true, resolvedAt: sql`NOW()` })
    .where(
      and(
        eq(alerts.customerId, customerId),
        eq(alerts.vehicleId, vehicleId),
        eq(alerts.alertType, opens),
        eq(alerts.isResolved, false)
      )
    );
}
