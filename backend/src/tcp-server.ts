import {
  TeltonikaTCPServer,
  TeltonikaDataCodec,
  TeltonikaGPRSCodec,
  type TeltonikaDevice as SdkDevice,
} from '@groupe-savoy/teltonika-sdk';
import type { Socket } from 'net';
import { db, devices, telemetry, deviceFrames, vehicles, eq, and, sql } from './lib/db-helpers';
import { detectAnomalies } from './lib/anomaly-detector';
import { invalidate } from './lib/redis';
import { getIoValue, serializeIo } from './lib/avl-io';
import { decodeScenarioEvent, recordDeviceEvent, resolveClosedAlert } from './lib/device-event-decoder';
import { handleIgnitionForTripStart, closeTripStartAlert } from './lib/trip-notifier';
import { handleIdleForRecord } from './lib/idle-detector';
import { handleGeofenceForRecord } from './lib/geofence-monitor';
import {
  patchCodec8eIoParsing,
  patchCodec8eReassembly,
  patchCodec8eRecordParsing,
} from './lib/codec8e-io-patch';
import { handleFuelStopForRecord } from './lib/fuel-stop-detector';
import {
  recordFrame,
  tcpDevicesConnected,
  tcpHandshakesTotal,
  tcpParseFailuresTotal,
  tcpSocketTimeoutsTotal,
} from './lib/metrics';
import {
  FUEL_USED_GPS_AVL_ID,
  FUEL_RATE_GPS_AVL_ID,
  FUEL_RATE_GPS_DIVISOR,
  processFuelGpsReading,
} from './lib/virtual-tank';

const REAL_DEVICE_IMEI = process.env.REAL_DEVICE_IMEI || '862129084847783';

interface TeltonikaDevice {
  imei: string;
  customerId?: string;
  vehicleId?: string;
  close(): void;
}

interface TeltonikaGps {
  latitude?: number | null;
  longitude?: number | null;
  speed?: number | null;
  satellites?: number | null;
}

// Below this many satellites, Teltonika's GPS fix is unreliable (multipath/urban
// canyon drift) and produces the zigzag "false heatmap" near buildings.
const MIN_GPS_SATELLITES = 3;

interface TeltonikaRecord {
  timestamp?: number | Date;
  event?: number;
  gps?: TeltonikaGps;
  io?: Record<string | number, unknown>;
}

interface TeltonikaPacket {
  records: TeltonikaRecord[];
}

/**
 * Idle timeout on every device socket.
 *
 * Without one, a tracker whose mobile network silently drops the NAT mapping
 * leaves a half-open connection: the socket stays ESTABLISHED on this side
 * forever, the device believes it is still connected and never redials, and
 * nothing arrives. That is exactly what happened on 2026-08-20 — the last fix
 * landed at 12:28, the server correctly raised device_offline at 12:59, and
 * the socket was still ESTABLISHED with zero bytes six hours later.
 *
 * Fifteen minutes is comfortably longer than the device's own reporting
 * interval when parked, so a stationary vehicle is never disconnected for
 * being quiet — only one that has genuinely gone away. The SDK destroys the
 * socket on timeout, which forces the tracker to open a fresh connection.
 */
const DEVICE_SOCKET_TIMEOUT_MS = Number(
  process.env.TCP_SOCKET_TIMEOUT_MS || 15 * 60 * 1000
);

const tcpServer = new TeltonikaTCPServer({
  timeout: DEVICE_SOCKET_TIMEOUT_MS,
  codecs: {
    data: TeltonikaDataCodec.Codec8e,
    gprs: TeltonikaGPRSCodec.Codec12,
  },
});

const isRealDevice = (imei: string): boolean => imei === REAL_DEVICE_IMEI;

const logReal = (imei: string, ...args: unknown[]): void => {
  if (isRealDevice(imei)) console.log('[REAL DEVICE]', ...args);
};

const lookupDevice = async (imei: string): Promise<{ customer_id: string; vehicle_id: string } | null> => {
  const [record] = await db
    .select({
      customer_id: devices.customerId,
      vehicle_id: devices.vehicleId,
    })
    .from(devices)
    .where(and(eq(devices.imei, imei), eq(devices.isActive, true)));

  return (record as { customer_id: string; vehicle_id: string } | undefined) ?? null;
};

/**
 * IMEIs with an open socket, held as a set rather than a counter that is
 * incremented and decremented. A tracker that reconnects before the old
 * socket's `close` lands would otherwise leave the gauge one too high,
 * permanently — and a gauge that only ever drifts up is worse than none.
 */
const connected = new Set<string>();

tcpServer.on('init', async (device: TeltonikaDevice) => {
  try {
    console.log(`Device ${device.imei} handshake received`);
    logReal(device.imei, `handshake IMEI=${device.imei}`);

    const record = await lookupDevice(device.imei);

    if (!record) {
      console.log(`Unknown device ${device.imei} - rejecting connection`);
      console.log(
        `  → Register with: npm run seed-real-device  (or add IMEI to devices table)`
      );
      // Deliberately unlabelled by IMEI: a rejected handshake is by definition
      // an IMEI this server does not know, so labelling it would let anything
      // that can reach port 5027 mint unbounded time series.
      tcpHandshakesTotal.inc({ outcome: 'rejected' });
      device.close();
      return;
    }

    device.customerId = record.customer_id;
    device.vehicleId = record.vehicle_id;

    await db
      .update(devices)
      .set({ lastSeenAt: new Date() })
      .where(eq(devices.imei, device.imei));

    tcpHandshakesTotal.inc({ outcome: 'accepted' });
    connected.add(device.imei);
    tcpDevicesConnected.set(connected.size);

    console.log(`Device ${device.imei} connected for customer ${device.customerId}`);
    logReal(
      device.imei,
      `accepted customer=${device.customerId} vehicle=${device.vehicleId}`
    );
  } catch (error) {
    tcpHandshakesTotal.inc({ outcome: 'error' });
    console.error(`Error in init event for device ${device.imei}:`, error);
    device.close();
  }
});

// Typed against the SDK's own device rather than the narrow local interface the
// older handlers use, so this listener adds no new type error to the build.
tcpServer.on('close', (device: SdkDevice<Socket>) => {
  // A socket that closes before the handshake completed never had an IMEI, so
  // it was never added to the set either.
  if (!device.imei) return;
  connected.delete(device.imei);
  tcpDevicesConnected.set(connected.size);
});

const saveTelemetry = async (device: TeltonikaDevice, record: TeltonikaRecord): Promise<void> => {
  try {
    if (!device?.customerId) {
      let recordLookup: Awaited<ReturnType<typeof lookupDevice>> = null;
      for (let i = 0; i < 3; i++) {
        recordLookup = await lookupDevice(device.imei);
        if (recordLookup) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (recordLookup) {
        device.customerId = recordLookup.customer_id;
        device.vehicleId = recordLookup.vehicle_id;
      } else {
        console.log(`Ignoring data from unregistered device ${device.imei}`);
        return;
      }
    }

    const TANK_CAPACITY_LITERS = Number(process.env.REAL_DEVICE_TANK_LITERS || 60);

    // Mileage sources in priority order:
    //   389 — OBD OEM total mileage (km, FMx003 reads the dashboard odometer)
    //   16  — total odometer (metres, GPS-based, standard Teltonika element)
    //   112 — legacy mock odometer (metres)
    const obdMileageKm = getIoValue(record.io, 389);
    const odometerMeters = getIoValue(record.io, 16) ?? getIoValue(record.io, 112);
    const ignitionOn = getIoValue(record.io, 239) === 1;
    const recordedAt = record.timestamp ? new Date(record.timestamp as number) : new Date();

    const rawLat = record.gps?.latitude;
    const rawLng = record.gps?.longitude;
    const satellites = record.gps?.satellites;
    const hasGpsFix = satellites == null || satellites >= MIN_GPS_SATELLITES;
    const validGps =
      hasGpsFix && rawLat != null && rawLng != null && (rawLat !== 0 || rawLng !== 0);

    // GPS speed comes from Doppler shift and can report a few km/h of noise while
    // parked. The engine being off is a stronger signal than a weak GPS reading,
    // so treat ignition-off as authoritative and zero out speed in that case.
    const rawSpeedKph = record.gps?.speed != null ? Math.round(record.gps.speed) : null;
    const speedKph = !ignitionOn ? 0 : rawSpeedKph;

    const [vehicleRow] = await db
      .select({
        license_plate: vehicles.licensePlate,
        // Carried for geofence alert phrasing — "LIVE-FMC150 (Benneth) left
        // the depot" is actionable in a way a bare plate is not.
        driver_name: sql<string | null>`(
          SELECT d.full_name FROM drivers d WHERE d.id = ${vehicles.driverId}
        )`,
      })
      .from(vehicles)
      .where(eq(vehicles.id, device.vehicleId!))
      .limit(1);

    // Fuel sources in priority order:
    //   390/270/30 — OEM/CAN fuel level (litres × 100, matches our mock encoder)
    //   48/89      — OBD fuel level as % of tank (standard OBD element on FMx003)
    //   12         — Fuel Used GPS accumulator (ml) feeding the virtual tank model,
    //                for vehicles that expose no fuel level over CAN/OBD
    const fuelCanRaw =
      getIoValue(record.io, 390) ?? getIoValue(record.io, 270) ?? getIoValue(record.io, 30);
    const fuelObdPct = getIoValue(record.io, 48) ?? getIoValue(record.io, 89);
    const fuelUsedGpsMl = getIoValue(record.io, FUEL_USED_GPS_AVL_ID);
    const fuelRateGpsRaw = getIoValue(record.io, FUEL_RATE_GPS_AVL_ID);
    const fuelRateLph =
      fuelRateGpsRaw != null ? Number((fuelRateGpsRaw / FUEL_RATE_GPS_DIVISOR).toFixed(2)) : null;

    let fuelLevelLiters =
      fuelCanRaw != null
        ? Number((fuelCanRaw / 100).toFixed(2))
        : fuelObdPct != null
          ? Number(((fuelObdPct / 100) * TANK_CAPACITY_LITERS).toFixed(2))
          : null;
    let fuelSource = fuelCanRaw != null ? 'CAN' : fuelObdPct != null ? 'OBD%' : 'none';
    // Only the virtual tank models burn per hop. A CAN or OBD vehicle has a
    // real level and consumption is still read from that, so this stays null.
    let burnMl: number | null = null;

    if (fuelLevelLiters == null && fuelUsedGpsMl != null) {
      try {
        const virtual = await processFuelGpsReading(
          device.imei,
          device.vehicleId!,
          device.customerId!,
          {
            fuelUsedMl: fuelUsedGpsMl,
            fuelRateLph,
            ignitionOn,
            speedKph,
            recordedAt,
            // The distance half of the burn model. Metres, because rounding to
            // whole kilometres loses most of a delivery round.
            odometerM:
              odometerMeters != null
                ? Math.round(odometerMeters)
                : obdMileageKm != null
                  ? Math.round(obdMileageKm * 1000)
                  : null,
          },
          {
            latitude: validGps ? rawLat!.toString() : null,
            longitude: validGps ? rawLng!.toString() : null,
            licensePlate: vehicleRow?.license_plate ?? undefined,
          }
        );
        fuelLevelLiters = Number(virtual.levelLiters.toFixed(2));
        fuelSource = 'virtual';
        burnMl = virtual.burnMl;
        if (virtual.accumulatorReset) {
          logReal(device.imei, `fuel accumulator reset detected (power cycle), delta=${virtual.deltaMl}ml`);
        }
      } catch (err) {
        console.error(`[virtual_tank] failed for ${device.imei}:`, err);
      }
    }

    const telemetryRow = {
      imei: device.imei,
      customerId: device.customerId!,
      vehicleId: device.vehicleId!,
      fuelLevelLiters: fuelLevelLiters?.toString() ?? null,
      burnMl,
      fuelSource,
      fuelUsedGpsMl,
      fuelRateLph: fuelRateLph?.toString() ?? null,
      odometerKm:
        obdMileageKm != null
          ? Math.round(obdMileageKm)
          : odometerMeters != null
            ? Math.round(odometerMeters / 1000)
            : null,
      // Metre resolution, so a short trip is not rounded out of existence.
      odometerM:
        odometerMeters != null
          ? Math.round(odometerMeters)
          : obdMileageKm != null
            ? Math.round(obdMileageKm * 1000)
            : null,
      latitude: validGps ? rawLat!.toString() : null,
      longitude: validGps ? rawLng!.toString() : null,
      speedKph,
      ignitionOn,
      recordedAt,
    };

    if (isRealDevice(device.imei)) {
      console.log('[REAL DEVICE] packet', {
        time: recordedAt.toISOString(),
        gps: record.gps,
        fuelSource,
        fuelLevelLiters,
        fuelCanRaw,
        fuelObdPct,
        fuelUsedGpsMl,
        fuelRateLph,
        obdMileageKm,
        odometerMeters,
        ignitionOn,
        speedKph: telemetryRow.speedKph,
        ioIds: Object.keys(record.io || {}),
      });
    }

    const [savedRow] = await db.insert(telemetry).values(telemetryRow).returning({ id: telemetry.id });
    // Counted here, after the row is committed — not on packet arrival. The
    // question this metric answers is "is telemetry being recorded", and a
    // frame that arrived but failed to persist is not a recorded frame.
    recordFrame(device.imei);
    // fire-and-forget — don't let cache failure block telemetry
    invalidate(device.customerId!, 'tracks', 'fleet', 'summary').catch(() => {});

    // Store raw frame for every registered device so parse issues can be diagnosed.
    db.insert(deviceFrames).values({
      imei: device.imei,
      telemetryId: savedRow?.id ?? null,
      eventId: record.event ?? null,
      gpsSatellites: satellites != null ? satellites : null,
      gpsValid: validGps,
      gpsRaw: record.gps ? { ...record.gps } : null,
      ioRaw: serializeIo(record.io),
    }).catch((err) => console.error('[device_frames] insert failed:', err));

    if (isRealDevice(device.imei)) {
      console.log('[REAL DEVICE] telemetry row saved', {
        imei: device.imei,
        fuel: fuelLevelLiters,
        lat: telemetryRow.latitude,
        lng: telemetryRow.longitude,
      });
    }

    if (record.event === 239 && ignitionOn) {
      logReal(device.imei, `ignition ON @ ${telemetryRow.latitude},${telemetryRow.longitude}`);
    }
    if (record.event === 239 && !ignitionOn) {
      logReal(device.imei, 'ignition OFF');
    }

    try {
      const started = await handleIgnitionForTripStart(ignitionOn, {
        imei: device.imei,
        customerId: device.customerId!,
        vehicleId: device.vehicleId!,
        latitude: telemetryRow.latitude,
        longitude: telemetryRow.longitude,
        occurredAt: recordedAt,
        licensePlate: vehicleRow?.license_plate ?? undefined,
      });
      if (started) logReal(device.imei, 'trip start notified');
      if (!ignitionOn) await closeTripStartAlert(device.customerId!, device.vehicleId!);
    } catch (err) {
      console.error(`[trip_notifier] failed for ${device.imei}:`, err);
    }

    try {
      const crossings = await handleGeofenceForRecord({
        imei: device.imei,
        customerId: device.customerId!,
        vehicleId: device.vehicleId!,
        latitude: telemetryRow.latitude != null ? Number(telemetryRow.latitude) : null,
        longitude: telemetryRow.longitude != null ? Number(telemetryRow.longitude) : null,
        recordedAt,
        licensePlate: vehicleRow?.license_plate ?? undefined,
        driverName: vehicleRow?.driver_name ?? null,
      });
      for (const c of crossings) {
        logReal(device.imei, `geofence ${c.direction} ${c.zoneName}`);
      }
    } catch (err) {
      console.error(`[geofence] failed for ${device.imei}:`, err);
    }

    try {
      const idle = await handleIdleForRecord({
        imei: device.imei,
        customerId: device.customerId!,
        vehicleId: device.vehicleId!,
        latitude: telemetryRow.latitude,
        longitude: telemetryRow.longitude,
        ignitionOn,
        speedKph: telemetryRow.speedKph,
        recordedAt,
        licensePlate: vehicleRow?.license_plate ?? undefined,
      });
      for (const emission of idle) {
        logReal(
          device.imei,
          emission.minutes != null
            ? `${emission.eventType} (${emission.minutes} min)`
            : emission.eventType
        );
      }
    } catch (err) {
      console.error(`[idle_detector] failed for ${device.imei}:`, err);
    }

    try {
      const station = await handleFuelStopForRecord(
        {
          imei: device.imei,
          customerId: device.customerId!,
          vehicleId: device.vehicleId!,
        },
        {
          ignitionOn,
          speedKph: telemetryRow.speedKph,
          latitude: telemetryRow.latitude,
          longitude: telemetryRow.longitude,
          recordedAt,
        }
      );
      if (station) logReal(device.imei, `fuel stop at ${station}`);
    } catch (err) {
      console.error(`[fuel_stop_detector] failed for ${device.imei}:`, err);
    }

    await db
      .update(devices)
      .set({ lastSeenAt: new Date() })
      .where(eq(devices.imei, device.imei));

    // FMC150 scenario events (green driving, overspeed, towing, crash, jamming,
    // unplug, idling, trip, geofence) arrive as eventful records where the AVL
    // event field names the triggering IO element.
    if (record.event) {
      try {
        const decoded = decodeScenarioEvent(record.event, {
          io: record.io,
          speedKph: telemetryRow.speedKph,
          licensePlate: vehicleRow?.license_plate ?? undefined,
        });
        if (decoded) {
          await recordDeviceEvent(decoded, {
            imei: device.imei,
            customerId: device.customerId!,
            vehicleId: device.vehicleId!,
            latitude: telemetryRow.latitude,
            longitude: telemetryRow.longitude,
            speedKph: telemetryRow.speedKph,
            occurredAt: recordedAt,
          });
          await resolveClosedAlert(decoded.eventType, device.customerId!, device.vehicleId!);
          logReal(device.imei, `scenario event ${decoded.eventType}`, decoded.value ?? '');
        }
      } catch (err) {
        console.error(`[device_events] failed for ${device.imei}:`, err);
      }
    }

    await detectAnomalies(
      { imei: device.imei, customerId: device.customerId!, vehicleId: device.vehicleId! },
      { ...telemetryRow, fuelLevelLiters },
      { licensePlate: vehicleRow?.license_plate ?? undefined }
    );
  } catch (error) {
    console.error(`TELEMETRY SAVE FAILED for ${device.imei}:`, error);
    if (isRealDevice(device.imei)) {
      console.error('[REAL DEVICE] insert error — check DATABASE_URL and devices/vehicles FK');
    }
  }
};

tcpServer.on('data', async (device: TeltonikaDevice, packet: TeltonikaPacket) => {
  try {
    for (const record of packet.records) {
      await saveTelemetry(device, record);
    }
  } catch (error) {
    console.error(`Failed to process packet for ${device.imei}:`, error);
  }
});

tcpServer.on('timeout', (device: TeltonikaDevice) => {
  tcpSocketTimeoutsTotal.inc({ imei: device.imei });
  // Logged loudly: this is the event that distinguishes "vehicle parked and
  // quiet" from "connection died and the tracker has not noticed".
  console.log(
    `Device ${device.imei} sent nothing for ${Math.round(
      DEVICE_SOCKET_TIMEOUT_MS / 60000
    )} min — dropping the socket so it reconnects`
  );
});

// A parse failure discards every record in the packet. That looked identical
// to "the vehicle did not move" for two hours on 2026-08-09, so it is counted
// and surfaced loudly rather than logged once and forgotten.
const parseFailures = new Map<string, { count: number; firstAt: Date; lastError: string }>();

export function getParseFailures(): Record<
  string,
  { count: number; firstAt: string; lastError: string }
> {
  return Object.fromEntries(
    [...parseFailures.entries()].map(([imei, v]) => [
      imei,
      { count: v.count, firstAt: v.firstAt.toISOString(), lastError: v.lastError },
    ])
  );
}

tcpServer.on('error', (device: TeltonikaDevice | null, error: Error) => {
  const imei = device?.imei || 'unknown';
  console.error(`Error from device ${imei}:`, error);

  const isParseError =
    error instanceof RangeError || /offset|out of range|Codec8E/i.test(error.message);
  if (!isParseError) return;

  const entry = parseFailures.get(imei) ?? {
    count: 0,
    firstAt: new Date(),
    lastError: error.message,
  };
  entry.count += 1;
  entry.lastError = error.message;
  parseFailures.set(imei, entry);
  tcpParseFailuresTotal.inc({ imei });

  // Every packet from this device is being thrown away — say so in terms that
  // do not require reading a stack trace to understand.
  console.error(
    `[DATA LOSS] ${imei}: ${entry.count} packet(s) discarded since ` +
      `${entry.firstAt.toISOString()} — telemetry is NOT being recorded for this device. ` +
      `Cause: ${error.message}`
  );
});

export const startTcpServer = async (): Promise<void> => {
  // Must run before any packet is parsed.
  patchCodec8eIoParsing();
  patchCodec8eReassembly();
  patchCodec8eRecordParsing();
  const port = Number(process.env.TCP_PORT || 5027);
  await tcpServer.listen(port, '0.0.0.0');
  console.log(`Teltonika TCP Server listening on port ${port}`);
  console.log(`Tracking real device IMEI: ${REAL_DEVICE_IMEI}`);
};

export { tcpServer };
