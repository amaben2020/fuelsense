import {
  TeltonikaTCPServer,
  TeltonikaDataCodec,
  TeltonikaGPRSCodec,
} from '@groupe-savoy/teltonika-sdk';
import { db, devices, telemetry, deviceFrames, vehicles, eq, and } from './lib/db-helpers';
import { detectAnomalies } from './lib/anomaly-detector';
import { invalidate } from './lib/redis';
import { getIoValue, serializeIo } from './lib/avl-io';
import { decodeScenarioEvent, recordDeviceEvent, resolveClosedAlert } from './lib/device-event-decoder';
import { handleIgnitionForTripStart, closeTripStartAlert } from './lib/trip-notifier';
import { handleIdleForRecord } from './lib/idle-detector';
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

const tcpServer = new TeltonikaTCPServer({
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
      device.close();
      return;
    }

    device.customerId = record.customer_id;
    device.vehicleId = record.vehicle_id;

    await db
      .update(devices)
      .set({ lastSeenAt: new Date() })
      .where(eq(devices.imei, device.imei));

    console.log(`Device ${device.imei} connected for customer ${device.customerId}`);
    logReal(
      device.imei,
      `accepted customer=${device.customerId} vehicle=${device.vehicleId}`
    );
  } catch (error) {
    console.error(`Error in init event for device ${device.imei}:`, error);
    device.close();
  }
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
      .select({ license_plate: vehicles.licensePlate })
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
          },
          {
            latitude: validGps ? rawLat!.toString() : null,
            longitude: validGps ? rawLng!.toString() : null,
            licensePlate: vehicleRow?.license_plate ?? undefined,
          }
        );
        fuelLevelLiters = Number(virtual.levelLiters.toFixed(2));
        fuelSource = 'virtual';
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
      fuelSource,
      fuelUsedGpsMl,
      fuelRateLph: fuelRateLph?.toString() ?? null,
      odometerKm:
        obdMileageKm != null
          ? Math.round(obdMileageKm)
          : odometerMeters != null
            ? Math.round(odometerMeters / 1000)
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
      const idle = await handleIdleForRecord({
        imei: device.imei,
        customerId: device.customerId!,
        vehicleId: device.vehicleId!,
        latitude: telemetryRow.latitude,
        longitude: telemetryRow.longitude,
        ignitionOn,
        speedKph: telemetryRow.speedKph,
        recordedAt,
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
  console.log(`Device ${device.imei} timed out`);
});

tcpServer.on('error', (device: TeltonikaDevice | null, error: Error) => {
  console.error(`Error from device ${device?.imei || 'unknown'}:`, error);
});

export const startTcpServer = async (): Promise<void> => {
  const port = Number(process.env.TCP_PORT || 5027);
  await tcpServer.listen(port, '0.0.0.0');
  console.log(`Teltonika TCP Server listening on port ${port}`);
  console.log(`Tracking real device IMEI: ${REAL_DEVICE_IMEI}`);
};

export { tcpServer };
