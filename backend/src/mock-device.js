require('dotenv').config();

const net = require('net');
const { encodeCodec8ePacket } = require('./codec8e-encoder');

const MOCK_IMEI = process.env.MOCK_IMEI || '356307042441013';
const TCP_SERVER_PORT = Number(process.env.TCP_PORT || 5027);
const TCP_SERVER_HOST = process.env.TCP_SERVER_HOST || 'localhost';
const SEND_INTERVAL_MS = Number(process.env.MOCK_INTERVAL_MS || 10000);

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

  const latitude = 6.5244 + Math.random() * 0.01;
  const longitude = 3.3792 + Math.random() * 0.01;
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
  runMockDevice();
}

module.exports = { runMockDevice, generateMockData };
