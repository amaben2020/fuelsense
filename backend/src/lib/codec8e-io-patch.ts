// Corrects Codec 8E variable-length (NX) I/O parsing in @groupe-savoy/teltonika-sdk.
//
// The SDK reads the NX element's length field as ONE byte:
//
//     const length = data.readUInt8(offset);
//     offset += 1;
//
// Codec 8E specifies TWO bytes. Reading one corrupts the running offset, and
// the next element's ID read then runs past the end of the packet:
//
//     RangeError [ERR_OUT_OF_RANGE]: The value of "offset" is out of range.
//     It must be >= 0 and <= 1084. Received 1085
//
// The SDK surfaces that as an error event, so the entire packet — every record
// in it — is discarded. On 2026-08-09 this silently dropped ~2 hours of live
// driving the moment a variable-length element (387, ISO6709 Coordinates) was
// enabled in the Configurator. Nothing in the UI could tell the difference
// between "the vehicle did not move" and "every packet failed to parse", which
// is the dangerous part.
//
// Patching the prototype rather than forking the SDK: the bug is one branch of
// one method, and a fork would have to be re-merged on every upgrade. Remove
// this once upstream fixes the NX length.
import { writeFileSync } from 'node:fs';
import { TeltonikaCodec8eAVLPacket, TeltonikaCodec8eParser } from '@groupe-savoy/teltonika-sdk';
import { decodeCodec8eData } from './codec8e-decoder';

interface IoGroupLayout {
  countLength?: number;
  idLength?: number;
}

interface IoGroupResult {
  io: Record<number, Buffer>;
  offset: number;
}

/** Guards every read so a malformed packet throws a clear error, not a RangeError. */
function readUInt(data: Buffer, offset: number, length: number): number {
  if (offset + length > data.length) {
    throw new RangeError(
      `Codec8E I/O read past end: need ${length}B at ${offset}, buffer is ${data.length}B`
    );
  }
  switch (length) {
    case 1:
      return data.readUInt8(offset);
    case 2:
      return data.readUInt16BE(offset);
    case 4:
      return data.readUInt32BE(offset);
    default:
      throw new Error(`Unsupported integer length: ${length}`);
  }
}

/**
 * Dumps the packet that failed to parse, once per process.
 *
 * Diagnosing an offset bug without the bytes is guesswork — two plausible
 * theories both predicted a one-byte overrun and neither was testable against
 * a live device. Enabled with CAPTURE_BAD_PACKETS=1 so it never writes in
 * normal operation.
 */
let captured = false;
function captureFailingPacket(data: Buffer, reason: string): void {
  if (captured || process.env.CAPTURE_BAD_PACKETS !== '1') return;
  captured = true;
  try {
    const path = `/tmp/fuelsense-bad-packet-${Date.now()}.hex`;
    writeFileSync(path, `${reason}\nlength=${data.length}\n${data.toString('hex')}\n`);
    console.error(`[codec8e-patch] wrote failing packet to ${path}`);
  } catch (err) {
    console.error('[codec8e-patch] capture failed:', (err as Error).message);
  }
}

export function patchCodec8eIoParsing(): void {
  const proto = TeltonikaCodec8eAVLPacket?.prototype as
    | { parseIoGroup?: unknown; __fuelsenseNxPatched?: boolean }
    | undefined;

  if (!proto || typeof proto.parseIoGroup !== 'function') {
    console.warn('[codec8e-patch] parseIoGroup not found — SDK shape changed, not patching');
    return;
  }
  if (proto.__fuelsenseNxPatched) return;

  proto.parseIoGroup = function parseIoGroup(
    data: Buffer,
    offset: number,
    n: number,
    layout: IoGroupLayout = {}
  ): IoGroupResult {
    const { countLength = 2, idLength = 2 } = layout;
    const io: Record<number, Buffer> = {};

    let count: number;
    try {
      count = readUInt(data, offset, countLength);
    } catch (err) {
      captureFailingPacket(data, `count read: ${(err as Error).message}`);
      throw err;
    }
    offset += countLength;

    for (let i = 0; i < count; i++) {
      let id: number;
      try {
        id = readUInt(data, offset, idLength);
      } catch (err) {
        captureFailingPacket(
          data,
          `id read at element ${i + 1}/${count} of n=${n} group: ${(err as Error).message}`
        );
        throw err;
      }
      offset += idLength;

      let value: Buffer;
      if (n > 0) {
        if (offset + n > data.length) {
          throw new RangeError(
            `Codec8E I/O value past end: id=${id} need ${n}B at ${offset}, buffer is ${data.length}B`
          );
        }
        value = data.subarray(offset, offset + n);
        offset += n;
      } else {
        // The fix: Codec 8E variable-length elements carry a 2-byte length.
        const length = readUInt(data, offset, 2);
        offset += 2;
        if (offset + length > data.length) {
          throw new RangeError(
            `Codec8E NX value past end: id=${id} len=${length} at ${offset}, buffer is ${data.length}B`
          );
        }
        value = data.subarray(offset, offset + length);
        offset += length;
      }

      io[id] = value;
    }

    return { io, offset };
  };

  proto.__fuelsenseNxPatched = true;
  console.log('[codec8e-patch] Codec 8E variable-length I/O parsing patched (2-byte NX length)');
}


/**
 * Corrects TCP reassembly for Codec 8E.
 *
 * The SDK decides a packet is complete with strict equality:
 *
 *     declaredLength === data.length - 12
 *
 * A TCP segment that overshoots — two packets coalesced, or a retransmit
 * landing mid-stream — can never satisfy that, so the device buffer grows
 * without bound and no packet is ever parsed. A short read is equally fatal in
 * the other direction: parsing starts on a truncated record section and the
 * I/O walk runs off the end of the buffer.
 *
 * `>=` is the correct test: the packet is complete once at least the declared
 * bytes have arrived. Anything beyond belongs to the next packet.
 */
export function patchCodec8eReassembly(): void {
  const proto = TeltonikaCodec8eParser?.prototype as
    | { isCompletPacket?: unknown; __fuelsenseReassemblyPatched?: boolean }
    | undefined;

  if (!proto || typeof proto.isCompletPacket !== 'function') {
    console.warn('[codec8e-patch] isCompletPacket not found — not patching reassembly');
    return;
  }
  if (proto.__fuelsenseReassemblyPatched) return;

  proto.isCompletPacket = function isCompletPacket(data: Buffer): boolean {
    // 4 preamble + 4 length + 4 CRC = 12 bytes of envelope.
    if (!Buffer.isBuffer(data) || data.length < 12) return false;
    let declared: number;
    try {
      declared = data.readUInt32BE(4);
    } catch {
      return false;
    }
    const available = data.length - 12;

    if (process.env.LOG_PACKET_ASSEMBLY === '1') {
      console.log(
        `[codec8e-patch] assembly: declared=${declared} available=${available} ` +
          `total=${data.length} complete=${available >= declared}`
      );
    }

    return available >= declared;
  };

  proto.__fuelsenseReassemblyPatched = true;
  console.log('[codec8e-patch] Codec 8E TCP reassembly patched (>= instead of ===)');
}


/**
 * Replaces the SDK's Codec 8E record parsing with our own decoder.
 *
 * The SDK mis-slices records whenever a packet carries a variable-length (NX)
 * element: parseIoGroup is handed a buffer that already begins inside the
 * previous record's value, so element counts get read out of ASCII text. That
 * boundary error cannot be fixed from inside the group parser, which is why
 * patching the NX length and the reassembly test both failed.
 *
 * Our decoder is validated against a real 1086-byte FMC150 packet — 6 records,
 * 179 bytes each, every declared totalIo matching the decoded count.
 *
 * The SDK still owns framing, CRC and the acknowledgement it writes back to the
 * device; only record decoding is replaced. The returned shape matches what the
 * rest of tcp-server already reads: timestamp, gps, io (raw Buffers) and event.
 */
export function patchCodec8eRecordParsing(): void {
  const proto = TeltonikaCodec8eAVLPacket?.prototype as
    | { parseRecords?: unknown; __fuelsenseRecordsPatched?: boolean }
    | undefined;

  if (!proto || typeof proto.parseRecords !== 'function') {
    console.warn('[codec8e-patch] parseRecords not found — record parsing NOT replaced');
    return;
  }
  if (proto.__fuelsenseRecordsPatched) return;

  proto.parseRecords = function parseRecords(this: { data?: Buffer }, ...args: unknown[]) {
    // The SDK calls this with the AVL data section in varying positions
    // depending on version; take the first Buffer argument, else this.data.
    const data =
      (args.find((a) => Buffer.isBuffer(a)) as Buffer | undefined) ?? this.data;
    if (!Buffer.isBuffer(data)) {
      throw new Error('Codec8E: no data buffer available to parse');
    }

    // The SDK calls this with the WHOLE frame:
    //   preamble(4) | dataFieldLength(4) | codec(1) count(1) records… count(1) | crc(4)
    // Blindly prepending a codec byte here read the record count out of the
    // preamble, yielding 0 records — the packet was ACKed and silently dropped.
    let section: Buffer;
    if (data.length >= 12 && data.readUInt32BE(0) === 0) {
      const declared = data.readUInt32BE(4);
      section = data.subarray(8, 8 + declared);
    } else if (data[0] === 0x8e) {
      section = data;
    } else {
      section = Buffer.concat([Buffer.from([0x8e]), data]);
    }

    return decodeCodec8eData(section).map((r) => ({
      timestamp: r.recordedAt.getTime(),
      priority: r.priority,
      gps: {
        latitude: r.gps.latitude,
        longitude: r.gps.longitude,
        altitude: r.gps.altitude,
        angle: r.gps.angle,
        satellites: r.gps.satellites,
        speed: r.gps.speedKph,
      },
      event: r.eventId,
      io: r.io,
    }));
  };

  proto.__fuelsenseRecordsPatched = true;
  console.log('[codec8e-patch] Codec 8E record parsing replaced with FuelSense decoder');
}
