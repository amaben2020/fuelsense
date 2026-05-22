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
  const client = new net.Socket();
  let imeiAccepted = false;
  let intervalId = null;

  const connect = () => {
    client.connect(TCP_SERVER_PORT, TCP_SERVER_HOST, () => {
      console.log(`[${profile.label}] connected (${profile.imei})`);
      const imeiBuffer = Buffer.alloc(2 + profile.imei.length);
      imeiBuffer.writeUInt16BE(profile.imei.length, 0);
      imeiBuffer.write(profile.imei, 2);
      client.write(imeiBuffer);
    });
  };

  client.on('data', (data) => {
    if (!imeiAccepted && data[0] === 0x01) {
      imeiAccepted = true;
      console.log(`[${profile.label}] IMEI accepted`);

      intervalId = setInterval(() => {
        const record = simulator.nextRecord();
        if (!record) {
          clearInterval(intervalId);
          console.log(`[${profile.label}] stopped (offline simulation)`);
          client.end();
          return;
        }

        client.write(encodeCodec8ePacket([record]));
        const fuel =
          record.meta.fuelLevel != null
            ? `${record.meta.fuelLevel.toFixed(1)}L`
            : 'N/A';
        const theftTag = record.meta.theftSimulated ? ' ⚠️ THEFT SIMULATED' : '';
        console.log(
          `[${profile.label}] fuel=${fuel} speed=${record.meta.speedKph}km/h ignition=${record.meta.ignitionOn ? 'ON' : 'OFF'}${theftTag}`
        );
      }, SEND_INTERVAL_MS);
    }
  });

  client.on('error', (err) => {
    console.error(`[${profile.label}] error:`, err.message);
  });

  client.on('close', () => {
    if (intervalId) clearInterval(intervalId);
  });

  connect();
  return client;
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
