// Shared helpers for reading Teltonika AVL IO elements off SDK records and
// the serialized {hex, dec} form stored in device_frames.io_raw.

export const readIoNumber = (buffer: Buffer | null | undefined): number | null => {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.length === 1) return buffer.readUInt8(0);
  if (buffer.length === 2) return buffer.readUInt16BE(0);
  if (buffer.length === 4) return buffer.readUInt32BE(0);
  if (buffer.length === 8) return Number(buffer.readBigUInt64BE(0));
  return null;
};

export const getIoValue = (
  io: Record<string | number, unknown> | undefined | null,
  avlId: number | string
): number | null => {
  if (!io) return null;
  const value = io[avlId];
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return readIoNumber(value);
  if (typeof value === 'object' && (value as Record<string, unknown>).value != null) {
    return Number((value as Record<string, unknown>).value);
  }
  return Number(value);
};

// Serialises an AVL IO map to a plain object safe for JSONB storage.
// Buffer values (multi-byte AVL elements) are stored as {hex, dec} so you
// can see both the raw bytes and the interpreted integer in one glance.
export const serializeIo = (
  io: Record<string | number, unknown> | undefined | null
): Record<string, unknown> | null => {
  if (!io) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(io)) {
    if (Buffer.isBuffer(value)) {
      out[key] = { hex: value.toString('hex'), dec: readIoNumber(value) };
    } else if (value != null && typeof value === 'object' && 'value' in (value as object)) {
      out[key] = (value as Record<string, unknown>).value;
    } else {
      out[key] = value;
    }
  }
  return out;
};

// Reads a numeric IO value back out of the serialized io_raw JSONB shape
// ({hex, dec} objects or plain numbers).
export const getSerializedIoValue = (
  ioRaw: Record<string, unknown> | null | undefined,
  avlId: number
): number | null => {
  if (!ioRaw) return null;
  const value = ioRaw[String(avlId)];
  if (value == null) return null;
  if (typeof value === 'object') {
    const dec = (value as Record<string, unknown>).dec;
    return dec != null ? Number(dec) : null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};
