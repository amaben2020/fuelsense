require('dotenv').config();

const net = require('net');
const { encodeCodec8ePacket } = require('./codec8e-encoder');
const { lastKnownPosition } = require('./lib/last-known-position');
const { resolveOrigin, envOrigin } = require('./lib/sim-origin');

const MOCK_IMEI = process.env.MOCK_IMEI || '356307042441013';
const TCP_SERVER_PORT = Number(process.env.TCP_PORT || 5027);
const TCP_SERVER_HOST = process.env.TCP_SERVER_HOST || 'localhost';
const SEND_INTERVAL_MS = Number(process.env.MOCK_INTERVAL_MS || 10000);

// Resolved once at startup from the device's last real telemetry fix (see
// lib/sim-origin.ts for the precedence rules). Previously this file hardcoded a
// Lagos coordinate, so the map asserted a location the device had never
// reported.
let simOrigin = null;

const generateMockData = (index) => {
  const now = Date.now();
  const baseFuel = 45 - Math.sin(index * 0.02) * 5;
  const isIgnitionOn = Math.random() > 0.2;

  let fuelLevel = baseFuel;
  if (index % 50 === 0 && index > 0) {
    fuelLevel += 30;
  }

  let theftSimulated = false;
  if (index === 75 && !isIgnitionOn) {
    fuelLevel -= 15;
    theftSimulated = true;
  }

  // Jitter around the RESOLVED origin, never a baked-in city. ~0.01 deg is
  // roughly a kilometre of plausible wander around the last known fix.
  const latitude = simOrigin.lat + Math.random() * 0.01;
  const longitude = simOrigin.lng + Math.random() * 0.01;
  const speed = isIgnitionOn ? Math.random() * 80 : 0;

  const ioElements = [
    { id: 239, size: 1, value: isIgnitionOn ? 1 : 0 },
    { id: 112, size: 4, value: 45230 + Math.floor(index * 0.1) },
  ];

  if (isIgnitionOn || theftSimulated) {
    ioElements.push({
      id: 390,
      size: 4,
      value: Math.round(fuelLevel * 100),
    });
  }

  return {
    timestamp: now,
    priority: 0,
    gps: {
      latitude,
      longitude,
      altitude: 100,
      angle: Math.floor(Math.random() * 360),
      satellites: Math.floor(Math.random() * 12) + 6,
      speed,
    },
    ioElements,
    meta: {
      fuelLevel,
      isIgnitionOn,
      theftSimulated,
    },
  };
};

// Resolves this device's starting point BEFORE any packet is sent. Refuses to
// run rather than invent a location: emitting a fabricated fix is what put a
// vehicle in Lagos that had never been there.
const resolveSimOrigin = async () => {
  let lastKnown = null;
  try {
    lastKnown = await lastKnownPosition(MOCK_IMEI);
  } catch (err) {
    console.warn(`Could not read last known position for ${MOCK_IMEI}: ${err.message}`);
  }
  const { origin, source } = resolveOrigin({ lastKnown, envOrigin: envOrigin() });
  if (!origin) {
    throw new Error(
      `No origin for ${MOCK_IMEI}: it has no telemetry with a GPS fix, and SIM_ORIGIN_LAT/SIM_ORIGIN_LNG are unset. ` +
        'Set those to choose where the simulation starts.',
    );
  }
  console.log(
    `Simulation origin for ${MOCK_IMEI}: ${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)} (from ${source})`,
  );
  return origin;
};

const runMockDevice = () => {
  const client = new net.Socket();
  let imeiAccepted = false;
  let dataIndex = 0;
  let intervalId = null;

  client.connect(TCP_SERVER_PORT, TCP_SERVER_HOST, () => {
    console.log(`Mock device connected to ${TCP_SERVER_HOST}:${TCP_SERVER_PORT}`);

    const imeiBuffer = Buffer.alloc(2 + MOCK_IMEI.length);
    imeiBuffer.writeUInt16BE(MOCK_IMEI.length, 0);
    imeiBuffer.write(MOCK_IMEI, 2);
    client.write(imeiBuffer);
    console.log(`Sent IMEI: ${MOCK_IMEI}`);
  });

  client.on('data', (data) => {
    if (!imeiAccepted) {
      if (data[0] === 0x01) {
        console.log('Server accepted IMEI');
        imeiAccepted = true;

        intervalId = setInterval(() => {
          const mockRecord = generateMockData(dataIndex);
          const packet = encodeCodec8ePacket([mockRecord]);
          client.write(packet);

          const fuelDisplay =
            mockRecord.meta.fuelLevel != null
              ? `${mockRecord.meta.fuelLevel.toFixed(1)}L`
              : 'N/A';
          console.log(
            `Mock data ${dataIndex}: Fuel=${fuelDisplay}, Ignition=${mockRecord.meta.isIgnitionOn ? 'ON' : 'OFF'}`
          );
          dataIndex += 1;
        }, SEND_INTERVAL_MS);
      }
      return;
    }

    console.log(`Server acknowledgment: ${data.toString('hex')}`);
  });

  client.on('error', (err) => {
    console.error('Mock device error:', err.message);
  });

  client.on('close', () => {
    if (intervalId) clearInterval(intervalId);
    console.log('Mock device disconnected');
  });
};

if (require.main === module) {
  resolveSimOrigin()
    .then((origin) => {
      simOrigin = origin;
      runMockDevice();
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { runMockDevice, generateMockData, resolveSimOrigin };
