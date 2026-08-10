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
