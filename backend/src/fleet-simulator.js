require('dotenv').config();

const net = require('net');
const { encodeCodec8ePacket } = require('./codec8e-encoder');
const { VehicleSimulator, DEFAULT_FLEET_PROFILES } = require('./lib/simulator');

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

      if (profile.imei === '862129084847783' || profile.imei === 862129084847783) {

         console.log(`[${profile.label}] connected (${profile.imei})`);
      const imeiBuffer = Buffer.alloc(2 + profile.imei.length);
      imeiBuffer.writeUInt16BE(profile.imei.length, 0);
      imeiBuffer.write(profile.imei, 2);
      client.write(imeiBuffer);
       }
     
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

const runFleetSimulator = (profiles = DEFAULT_FLEET_PROFILES) => {
  console.log(
    `Starting fleet simulator: ${profiles.length} vehicles → ${TCP_SERVER_HOST}:${TCP_SERVER_PORT} every ${SEND_INTERVAL_MS}ms`
  );

  profiles.forEach((profile, index) => {
    setTimeout(() => startVirtualDevice(profile), index * STAGGER_MS);
  });
};

if (require.main === module) {
  runFleetSimulator();
}

module.exports = { runFleetSimulator, startVirtualDevice };
