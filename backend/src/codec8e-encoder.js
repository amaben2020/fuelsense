const { calculateCrc } = require('@groupe-savoy/teltonika-sdk');

const writeIoGroup = (elements, valueSize) => {
  const parts = [];
  const count = Buffer.alloc(2);
  count.writeUInt16BE(elements.length, 0);
  parts.push(count);

  for (const element of elements) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(element.id, 0);
    parts.push(id);

    if (valueSize === 0) {
      const valueBuffer =
        typeof element.value === 'number'
          ? Buffer.alloc(4)
          : Buffer.from(element.value);
      if (typeof element.value === 'number') {
        valueBuffer.writeUInt32BE(element.value, 0);
      }
      const length = Buffer.from([valueBuffer.length]);
      parts.push(length, valueBuffer);
    } else {
      const value = Buffer.alloc(valueSize);
      if (valueSize === 1) value.writeUInt8(element.value, 0);
      else if (valueSize === 2) value.writeUInt16BE(element.value, 0);
      else if (valueSize === 4) value.writeUInt32BE(element.value, 0);
      else if (valueSize === 8) value.writeBigUInt64BE(BigInt(element.value), 0);
      parts.push(value);
    }
  }

  return Buffer.concat(parts);
};

const encodeIo = (ioElements) => {
  const n1 = ioElements.filter((item) => item.size === 1);
  const n2 = ioElements.filter((item) => item.size === 2);
  const n4 = ioElements.filter((item) => item.size === 4);
  const n8 = ioElements.filter((item) => item.size === 8);
  const nx = ioElements.filter((item) => item.size === 0);

  return Buffer.concat([
    writeIoGroup(n1, 1),
    writeIoGroup(n2, 2),
    writeIoGroup(n4, 4),
    writeIoGroup(n8, 8),
    writeIoGroup(nx, 0),
  ]);
};

const encodeRecord = (record) => {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(record.timestamp), 0);

  const priority = Buffer.from([record.priority ?? 0]);

  const gps = Buffer.alloc(15);
  gps.writeInt32BE(Math.round(record.gps.longitude * 1e7), 0);
  gps.writeInt32BE(Math.round(record.gps.latitude * 1e7), 4);
  gps.writeInt16BE(record.gps.altitude ?? 0, 8);
  gps.writeUInt16BE(record.gps.angle ?? 0, 10);
  gps.writeUInt8(record.gps.satellites ?? 8, 12);
  gps.writeUInt16BE(Math.round(record.gps.speed ?? 0), 13);

  const event = Buffer.alloc(2);
  event.writeUInt16BE(record.eventId ?? 0, 0);

  const ioElements = record.ioElements ?? [];
  const totalIo = Buffer.alloc(2);
  totalIo.writeUInt16BE(ioElements.length, 0);

  return Buffer.concat([
    timestamp,
    priority,
    gps,
    event,
    totalIo,
    encodeIo(ioElements),
  ]);
};

const encodeCodec8ePacket = (records) => {
  const avlData = Buffer.concat(records.map(encodeRecord));
  const codecId = Buffer.from([0x8e]);
  const numberOfData1 = Buffer.from([records.length]);
  const numberOfData2 = Buffer.from([records.length]);
  const dataField = Buffer.concat([
    codecId,
    numberOfData1,
    avlData,
    numberOfData2,
  ]);

  const size = Buffer.alloc(4);
  size.writeUInt32BE(dataField.length, 0);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(calculateCrc(dataField), 0);

  return Buffer.concat([Buffer.from([0, 0, 0, 0]), size, dataField, crc]);
};

module.exports = { encodeCodec8ePacket };
