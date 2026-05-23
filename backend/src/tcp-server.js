const {
  TeltonikaTCPServer,
  TeltonikaDataCodec,
  TeltonikaGPRSCodec,
} = require('@groupe-savoy/teltonika-sdk');
const { db, devices, telemetry, alerts, vehicles, eq, and, desc } = require('./lib/db-helpers');
const { detectAnomalies } = require('./lib/anomaly-detector');
const { DEFAULT_FUEL_PRICE_NGN_LITER } = require('./lib/fuel-metrics');
const { recordSiphonEvent } = require('./lib/siphon-recorder');

const tcpServer = new TeltonikaTCPServer({
  codecs: {
    data: TeltonikaDataCodec.Codec8e,
    gprs: TeltonikaGPRSCodec.Codec12,
  },
  timeout: 30000,
});

const readIoNumber = (buffer) => {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.length === 1) return buffer.readUInt8(0);
  if (buffer.length === 2) return buffer.readUInt16BE(0);
  if (buffer.length === 4) return buffer.readUInt32BE(0);
  if (buffer.length === 8) return Number(buffer.readBigUInt64BE(0));
  return null;
};

const getIoValue = (io, avlId) => {
  if (!io) return null;
  const value = io[avlId];
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return readIoNumber(value);
  if (typeof value === 'object' && value.value != null) return value.value;
  return value;
};

const lookupDevice = async (imei) => {
  const [record] = await db
    .select({
      customer_id: devices.customerId,
      vehicle_id: devices.vehicleId,
    })
    .from(devices)
    .where(and(eq(devices.imei, imei), eq(devices.isActive, true)));

  return record || null;
};

tcpServer.on('init', async (device) => {
  const record = await lookupDevice(device.imei);

  if (!record) {
    console.log(`Unknown device ${device.imei} - rejecting connection`);
    device.close();
    return;
  }

  device.customerId = record.customer_id;
  device.vehicleId = record.vehicle_id;

  await db
    .update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.imei, device.imei));

  console.log(
    `Device ${device.imei} connected for customer ${device.customerId}`
  );
});

const saveTelemetry = async (device, record) => {
  if (!device.customerId) {
    console.log(`Ignoring data from unregistered device ${device.imei}`);
    return;
  }

  const fuelRaw = getIoValue(record.io, 390);
  const fuelLevelLiters =
    fuelRaw != null ? Number((fuelRaw / 100).toFixed(2)) : null;
  const odometerMeters = getIoValue(record.io, 112);
  const ignitionOn = getIoValue(record.io, 239) === 1;
  const recordedAt = record.timestamp ? new Date(record.timestamp) : new Date();

  const telemetryRow = {
    imei: device.imei,
    customerId: device.customerId,
    vehicleId: device.vehicleId,
    fuelLevelLiters: fuelLevelLiters?.toString() ?? null,
    odometerKm: odometerMeters != null ? Math.round(odometerMeters / 1000) : null,
    latitude: record.gps?.latitude?.toString() ?? null,
    longitude: record.gps?.longitude?.toString() ?? null,
    speedKph: record.gps?.speed != null ? Math.round(record.gps.speed) : null,
    ignitionOn,
    recordedAt,
  };

  console.log(`Data from device ${device.imei}:`, JSON.stringify({
    ...telemetryRow,
    customer_id: telemetryRow.customerId,
    vehicle_id: telemetryRow.vehicleId,
  }, null, 2));

  if (telemetryRow.fuelLevelLiters == null && telemetryRow.odometerKm == null) {
    return;
  }

  await db.insert(telemetry).values(telemetryRow);

  await db
    .update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.imei, device.imei));

  const [vehicleRow] = await db
    .select({ license_plate: vehicles.licensePlate })
    .from(vehicles)
    .where(eq(vehicles.id, device.vehicleId))
    .limit(1);

  await detectAnomalies(device, telemetryRow, {
    licensePlate: vehicleRow?.license_plate,
  });

  if (!ignitionOn && fuelLevelLiters != null) {
    const [lastIgnitionOn] = await db
      .select({ fuel_level_liters: telemetry.fuelLevelLiters })
      .from(telemetry)
      .where(
        and(
          eq(telemetry.imei, device.imei),
          eq(telemetry.customerId, device.customerId),
          eq(telemetry.ignitionOn, true)
        )
      )
      .orderBy(desc(telemetry.recordedAt))
      .limit(1);

    const previousFuel = lastIgnitionOn?.fuel_level_liters
      ? Number(lastIgnitionOn.fuel_level_liters)
      : null;

    if (previousFuel != null && previousFuel - fuelLevelLiters > 5) {
      const drop = previousFuel - fuelLevelLiters;
      const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);
      const estimatedLossNgn = Math.round(drop * pricePerLiter);
      const lat = telemetryRow.latitude;
      const lng = telemetryRow.longitude;
      const locationHint =
        lat && lng
          ? ` near ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
          : '';

      const [existingAlert] = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(
          and(
            eq(alerts.vehicleId, device.vehicleId),
            eq(alerts.customerId, device.customerId),
            eq(alerts.alertType, 'fuel_theft'),
            eq(alerts.isResolved, false)
          )
        )
        .limit(1);

      if (!existingAlert) {
        const [alertRow] = await db
          .insert(alerts)
          .values({
            imei: device.imei,
            customerId: device.customerId,
            vehicleId: device.vehicleId,
            alertType: 'fuel_theft',
            message: `Fuel theft detected${locationHint}! Level dropped ${drop.toFixed(1)}L while parked (${previousFuel.toFixed(1)}L → ${fuelLevelLiters.toFixed(1)}L). Estimated loss ${estimatedLossNgn.toLocaleString('en-NG')} NGN.`,
            fuelLevelLiters: fuelLevelLiters.toString(),
            fuelDropLiters: drop.toFixed(2),
            estimatedLossNgn,
            latitude: lat,
            longitude: lng,
          })
          .returning({ id: alerts.id });

        await recordSiphonEvent({
          customerId: device.customerId,
          vehicleId: device.vehicleId,
          alertId: alertRow.id,
          occurredAt: recordedAt,
          litersStolen: drop,
          estimatedLossNgn,
          fuelLevelBefore: previousFuel,
          fuelLevelAfter: fuelLevelLiters,
          engineStateBefore: true,
          engineStateAfter: false,
          latitude: lat,
          longitude: lng,
          locationName: lat && lng ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : null,
        });

        console.log(
          `⚠️  FUEL THEFT ALERT for ${device.imei}: -${drop.toFixed(1)}L${locationHint}`
        );
      }
    }
  }
};

tcpServer.on('data', async (device, packet) => {
  try {
    for (const record of packet.records) {
      await saveTelemetry(device, record);
    }
  } catch (error) {
    console.error(`Failed to save telemetry for ${device.imei}:`, error.message);
  }
});

tcpServer.on('timeout', (device) => {
  console.log(`Device ${device.imei} timed out`);
});

tcpServer.on('error', (device, error) => {
  console.error(`Error from device ${device?.imei || 'unknown'}:`, error?.message);
});

const startTcpServer = async () => {
  const port = Number(process.env.TCP_PORT || 5027);
  await tcpServer.listen(port, '0.0.0.0');
  console.log(`Teltonika TCP Server listening on port ${port}`);
};

module.exports = { startTcpServer, tcpServer };
