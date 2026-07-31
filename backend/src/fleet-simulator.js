require('dotenv').config();

const net = require('net');
const { encodeCodec8ePacket } = require('./codec8e-encoder');
const { VehicleSimulator, DEFAULT_FLEET_PROFILES } = require('./lib/simulator');
const { lastKnownPosition } = require('./lib/last-known-position');
const { resolveOrigin, envOrigin } = require('./lib/sim-origin');

const TCP_SERVER_PORT = Number(process.env.TCP_PORT || 5027);
const TCP_SERVER_HOST = process.env.TCP_SERVER_HOST || 'localhost';
const SEND_INTERVAL_MS = Number(process.env.MOCK_INTERVAL_MS || 4000);
const STAGGER_MS = Number(process.env.MOCK_STAGGER_MS || 800);

const startVirtualDevice = (profile) => {
  const simulator = new VehicleSimulator(profile);
  let client = null;
  let imeiAccepted = false;
  let intervalId = null;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    client = new net.Socket();

    client.connect(TCP_SERVER_PORT, TCP_SERVER_HOST, () => {
      console.log(`[${profile.label}] connected (${profile.imei})`);
      const imeiBuffer = Buffer.alloc(2 + profile.imei.length);
      imeiBuffer.writeUInt16BE(profile.imei.length, 0);
      imeiBuffer.write(profile.imei, 2);
      client.write(imeiBuffer);
    });

    client.on('data', (data) => {
      if (!imeiAccepted && data[0] === 0x01) {
        imeiAccepted = true;
        console.log(`[${profile.label}] IMEI accepted — Uber-style route active`);

        intervalId = setInterval(() => {
          const record = simulator.nextRecord();
          if (!record) {
            clearInterval(intervalId);
            console.log(`[${profile.label}] stopped`);
            client.end();
            return;
          }

          client.write(encodeCodec8ePacket([record]));
          const meta = record.meta;
          const theftTag = meta.theftSimulated ? ' ⚠️ THEFT' : '';
          console.log(
            `[${profile.label}] ${meta.odometerKm}km · ${meta.fuelLevel?.toFixed(1)}L · ${meta.speedKph}km/h${theftTag}`
          );
        }, SEND_INTERVAL_MS);
      }
    });

    client.on('error', (err) => {
      console.error(`[${profile.label}] error:`, err.message);
    });

    client.on('close', () => {
      if (intervalId) clearInterval(intervalId);
      imeiAccepted = false;
      if (!stopped && !profile.noReconnect) {
        setTimeout(connect, 5000);
      }
    });
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (intervalId) clearInterval(intervalId);
      client?.destroy();
    },
  };
};

/**
 * Gives every profile the origin its device last actually reported. Vehicles
 * with no telemetry fall back to SIM_ORIGIN_LAT/LNG, then to any explicit
 * startLat/startLng on the profile; a vehicle that resolves to nothing is
 * SKIPPED rather than dropped onto a made-up coordinate.
 */
const withResolvedOrigins = async (profiles) => {
  const resolved = [];
  for (const profile of profiles) {
    let lastKnown = null;
    try {
      lastKnown = await lastKnownPosition(profile.imei);
    } catch (err) {
      console.warn(`[${profile.label}] last-known lookup failed: ${err.message}`);
    }
    const profileStart =
      profile.startLat !== undefined && profile.startLng !== undefined
        ? { lat: profile.startLat, lng: profile.startLng }
        : null;
    const { origin, source } = resolveOrigin({ lastKnown, envOrigin: envOrigin(), profileStart });
    if (!origin) {
      console.warn(
        `[${profile.label}] skipped: no telemetry fix, no SIM_ORIGIN_LAT/LNG, no profile start.`,
      );
      continue;
    }
    console.log(
      `[${profile.label}] origin ${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)} (from ${source})`,
    );
    resolved.push({ ...profile, origin });
  }
  return resolved;
};

const runFleetSimulator = (profiles = DEFAULT_FLEET_PROFILES) => {
  console.log(
    `Starting fleet simulator: ${profiles.length} vehicles → ${TCP_SERVER_HOST}:${TCP_SERVER_PORT} every ${SEND_INTERVAL_MS}ms`
  );

  profiles.forEach((profile, index) => {
    setTimeout(() => startVirtualDevice(profile), index * STAGGER_MS);
  });
};

if (require.main === module) {
  withResolvedOrigins(DEFAULT_FLEET_PROFILES)
    .then((profiles) => {
      if (profiles.length === 0) {
        console.error('No vehicles could be started — set SIM_ORIGIN_LAT/SIM_ORIGIN_LNG.');
        process.exit(1);
      }
      runFleetSimulator(profiles);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { runFleetSimulator, startVirtualDevice, withResolvedOrigins };
