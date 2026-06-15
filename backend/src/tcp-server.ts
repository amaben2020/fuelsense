import {
  TeltonikaTCPServer,
  TeltonikaDataCodec,
  TeltonikaGPRSCodec,
} from '@groupe-savoy/teltonika-sdk';
import { db, devices, telemetry, vehicles, eq, and } from './lib/db-helpers';
import { detectAnomalies } from './lib/anomaly-detector';

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
}

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

const readIoNumber = (buffer: Buffer | null | undefined): number | null => {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.length === 1) return buffer.readUInt8(0);
  if (buffer.length === 2) return buffer.readUInt16BE(0);
  if (buffer.length === 4) return buffer.readUInt32BE(0);
  if (buffer.length === 8) return Number(buffer.readBigUInt64BE(0));
  return null;
};

const getIoValue = (io: Record<string | number, unknown> | undefined | null, avlId: number | string): number | null => {
  if (!io) return null;
  const value = io[avlId];
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return readIoNumber(value);
  if (typeof value === 'object' && (value as Record<string, unknown>).value != null) {
    return Number((value as Record<string, unknown>).value);
  }
  return Number(value);
};

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

    const fuelCanRaw =
      getIoValue(record.io, 390) ?? getIoValue(record.io, 270) ?? getIoValue(record.io, 30);
    const fuelObdPct = getIoValue(record.io, 89);

    const fuelLevelLiters =
      fuelCanRaw != null
        ? Number((fuelCanRaw / 100).toFixed(2))
        : fuelObdPct != null
          ? Number(((fuelObdPct / 100) * TANK_CAPACITY_LITERS).toFixed(2))
          : null;

    const fuelSource = fuelCanRaw != null ? 'CAN' : fuelObdPct != null ? 'OBD' : 'none';
    const odometerMeters = getIoValue(record.io, 112);
    const ignitionOn = getIoValue(record.io, 239) === 1;
    const recordedAt = record.timestamp ? new Date(record.timestamp as number) : new Date();

    const telemetryRow = {
      imei: device.imei,
      customerId: device.customerId!,
      vehicleId: device.vehicleId!,
      fuelLevelLiters: fuelLevelLiters?.toString() ?? null,
      odometerKm: odometerMeters != null ? Math.round(odometerMeters / 1000) : null,
      latitude: record.gps?.latitude?.toString() ?? null,
      longitude: record.gps?.longitude?.toString() ?? null,
      speedKph: record.gps?.speed != null ? Math.round(record.gps.speed) : null,
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
        ignitionOn,
        speedKph: telemetryRow.speedKph,
        ioIds: Object.keys(record.io || {}),
      });
    }

    await db.insert(telemetry).values(telemetryRow);

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

    await db
      .update(devices)
      .set({ lastSeenAt: new Date() })
      .where(eq(devices.imei, device.imei));

    const [vehicleRow] = await db
      .select({ license_plate: vehicles.licensePlate })
      .from(vehicles)
      .where(eq(vehicles.id, device.vehicleId!))
      .limit(1);

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
