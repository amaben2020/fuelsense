// Codec 8E record decoder.
//
// Written because @groupe-savoy/teltonika-sdk mis-slices records once a packet
// contains a variable-length (NX) element: it hands parseIoGroup a buffer that
// already begins part-way through the previous record's value, so the I/O walk
// reads ASCII text as element counts and runs off the end. Patching the group
// parser cannot fix a wrong record boundary, which is why three attempts at it
// failed.
//
// Validated against a real 1086-byte FMC150 packet: 6 records, 179 bytes each,
// every record's declared totalIo matching the decoded element count, ending
// exactly on the 5-byte trailer.
//
// Layout per Teltonika Codec 8E:
//   timestamp   8   ms since epoch
//   priority    1
//   longitude   4   signed, 1e-7 deg
//   latitude    4   signed, 1e-7 deg
//   altitude    2
//   angle       2
//   satellites  1
//   speed       2
//   eventId     2   (Codec 8 uses 1 — this is the 8E difference)
//   totalIo     2
//   then groups N1, N2, N4, N8, NX:
//     count 2, then count × [ id 2, value ]
//     where NX values are [ length 2, bytes ]

export interface Codec8eGps {
  latitude: number | null;
  longitude: number | null;
  altitude: number;
  angle: number;
  satellites: number;
  speedKph: number;
}

export interface Codec8eRecord {
  recordedAt: Date;
  priority: number;
  gps: Codec8eGps;
  eventId: number;
  /** AVL id → raw bytes, exactly as they arrived. */
  io: Record<number, Buffer>;
}

class Reader {
  constructor(
    private readonly b: Buffer,
    public offset: number
  ) {}

  private need(n: number, what: string): void {
    if (this.offset + n > this.b.length) {
      throw new RangeError(
        `Codec8E ${what}: need ${n}B at ${this.offset}, buffer is ${this.b.length}B`
      );
    }
  }

  u8(what = 'u8'): number {
    this.need(1, what);
    return this.b.readUInt8(this.offset++);
  }

  u16(what = 'u16'): number {
    this.need(2, what);
    const v = this.b.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  i32(what = 'i32'): number {
    this.need(4, what);
    const v = this.b.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(what = 'u64'): bigint {
    this.need(8, what);
    const v = this.b.readBigUInt64BE(this.offset);
    this.offset += 8;
    return v;
  }

  bytes(n: number, what = 'bytes'): Buffer {
    this.need(n, what);
    const v = this.b.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
}

/** Group value sizes, in the order Codec 8E emits them. 0 marks variable-length. */
const IO_GROUP_SIZES = [1, 2, 4, 8, 0] as const;

function decodeRecord(r: Reader): Codec8eRecord {
  const timestampMs = r.u64('timestamp');
  const priority = r.u8('priority');

  const longitude = r.i32('longitude');
  const latitude = r.i32('latitude');
  const altitude = r.u16('altitude');
  const angle = r.u16('angle');
  const satellites = r.u8('satellites');
  const speedKph = r.u16('speed');

  const eventId = r.u16('eventId');
  const totalIo = r.u16('totalIo');

  const io: Record<number, Buffer> = {};
  for (const size of IO_GROUP_SIZES) {
    const count = r.u16('group count');
    for (let i = 0; i < count; i++) {
      const id = r.u16('element id');
      io[id] = size > 0 ? r.bytes(size, `element ${id}`) : r.bytes(r.u16(`length of ${id}`), `element ${id}`);
    }
  }

  // The device states how many elements it packed. A mismatch means the walk
  // drifted, and every subsequent record would be garbage — fail loudly here
  // rather than persist plausible-looking nonsense.
  const decoded = Object.keys(io).length;
  if (decoded !== totalIo) {
    throw new Error(
      `Codec8E element count mismatch: record declares ${totalIo}, decoded ${decoded}`
    );
  }

  return {
    recordedAt: new Date(Number(timestampMs)),
    priority,
    gps: {
      // 0/0 is the device's "no fix" sentinel, not the Gulf of Guinea.
      latitude: latitude === 0 && longitude === 0 ? null : latitude / 1e7,
      longitude: latitude === 0 && longitude === 0 ? null : longitude / 1e7,
      altitude,
      angle,
      satellites,
      speedKph,
    },
    eventId,
    io,
  };
}

/**
 * Decodes the AVL data section: `[codec id][record count][records…][record count]`.
 *
 * `data` must start at the codec id — i.e. the packet with its 4-byte preamble
 * and 4-byte length stripped, and without the trailing CRC.
 */
export function decodeCodec8eData(data: Buffer): Codec8eRecord[] {
  const r = new Reader(data, 0);

  const codecId = r.u8('codec id');
  if (codecId !== 0x8e) {
    throw new Error(`Not Codec 8E: codec id 0x${codecId.toString(16)}`);
  }

  const count = r.u8('record count');
  const records: Codec8eRecord[] = [];
  for (let i = 0; i < count; i++) {
    records.push(decodeRecord(r));
  }

  const trailing = r.u8('trailing count');
  if (trailing !== count) {
    throw new Error(`Codec8E record count mismatch: header ${count}, trailer ${trailing}`);
  }

  return records;
}

/**
 * Decodes a whole TCP frame: `[preamble 4][length 4][data…][crc 4]`.
 *
 * Returns null when fewer than the declared bytes have arrived, so a caller
 * reassembling a stream can wait for the rest rather than parse a fragment.
 */
export function decodeCodec8ePacket(packet: Buffer): Codec8eRecord[] | null {
  if (packet.length < 12) return null;
  const declared = packet.readUInt32BE(4);
  if (packet.length < declared + 12) return null;
  return decodeCodec8eData(packet.subarray(8, 8 + declared));
}
