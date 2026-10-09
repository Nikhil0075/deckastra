/**
 * A minimal, deterministic ZIP writer.
 *
 * A `.pptx` is a ZIP of XML parts, so an export needs one. This is hand-written
 * rather than a dependency for a reason that is not "avoid dependencies": doc 04
 * §32.3 asks for a **byte-stable artifact** for a given `(versionId, adapter,
 * options)`, and every general-purpose zip library writes the current time into
 * each entry. Two exports of an unchanged deck would differ in bytes, which
 * defeats caching and makes an export impossible to diff.
 *
 * So the timestamp is fixed, the entry order is the order given, and `deflateRaw`
 * is called at a fixed level. `zlib` is in Node's standard library, so this costs
 * nothing at install time either.
 */

import { deflateRawSync } from "node:zlib";

/**
 * The DOS timestamp every entry carries: 1980-01-01 00:00:00, the epoch of the
 * ZIP format itself and the conventional value for reproducible archives.
 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/** Fixed, so the same input compresses to the same bytes on every machine. */
const DEFLATE_LEVEL = 6;

export interface ZipEntry {
  path: string;
  data: Uint8Array | string;
  stored?: boolean;
  maxRatio?: number;
}

interface Prepared {
  path: Uint8Array;
  crc: number;
  compressed: Uint8Array;
  uncompressedSize: number;
  offset: number;
  /** 0 = stored, 8 = deflate. */
  method: number;
  flags: number;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared: Prepared[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const deflated = deflateRawSync(raw, { level: DEFLATE_LEVEL });

    // Stored when deflate makes it bigger, which happens for tiny parts. Not an
    // optimisation — a "compressed" entry larger than its input is the kind of
    // thing that makes a reader suspect the file.
    const useDeflate = !entry.stored && deflated.length < raw.length && raw.length / Math.max(1, deflated.length) <= (entry.maxRatio ?? Infinity);
    const compressed = useDeflate ? new Uint8Array(deflated) : raw;

    const record: Prepared = {
      path: encoder.encode(entry.path),
      crc: crc32(raw),
      compressed,
      uncompressedSize: raw.length,
      offset,
      method: useDeflate ? 8 : 0,
      flags: /[^\x00-\x7f]/.test(entry.path) ? 0x800 : 0,
    };

    const header = localHeader(record);
    chunks.push(header, compressed);
    offset += header.length + compressed.length;
    prepared.push(record);
  }

  const centralStart = offset;
  for (const record of prepared) {
    const entry = centralHeader(record);
    chunks.push(entry);
    offset += entry.length;
  }

  chunks.push(endOfCentralDirectory(prepared.length, offset - centralStart, centralStart));
  return concat(chunks);
}

function localHeader(record: Prepared): Uint8Array {
  const buffer = new Uint8Array(30 + record.path.length);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, 0x04034b50, true); // signature
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, record.flags, true);
  view.setUint16(8, record.method, true);
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, record.crc, true);
  view.setUint32(18, record.compressed.length, true);
  view.setUint32(22, record.uncompressedSize, true);
  view.setUint16(26, record.path.length, true);
  view.setUint16(28, 0, true); // extra length

  buffer.set(record.path, 30);
  return buffer;
}

function centralHeader(record: Prepared): Uint8Array {
  const buffer = new Uint8Array(46 + record.path.length);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true); // version made by
  view.setUint16(6, 20, true); // version needed
  view.setUint16(8, record.flags, true);
  view.setUint16(10, record.method, true);
  view.setUint16(12, DOS_TIME, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, record.crc, true);
  view.setUint32(20, record.compressed.length, true);
  view.setUint32(24, record.uncompressedSize, true);
  view.setUint16(28, record.path.length, true);
  view.setUint16(30, 0, true); // extra
  view.setUint16(32, 0, true); // comment
  view.setUint16(34, 0, true); // disk number
  view.setUint16(36, 0, true); // internal attributes
  view.setUint32(38, 0, true); // external attributes
  view.setUint32(42, record.offset, true);

  buffer.set(record.path, 46);
  return buffer;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const buffer = new Uint8Array(22);
  const view = new DataView(buffer.buffer);

  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, 0, true); // comment length

  return buffer;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// -------------------------------------------------------------------- crc32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
