import { deflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer.
 *
 * A capture bundle is a handful of files a human unzips with whatever their OS
 * ships, so the only features that matter are deflate and correct central
 * directory offsets. Pulling in archiver or adm-zip for that would double the
 * dependency count of the whole package.
 *
 * Deliberately not supported: zip64 (entries and archives must stay under 4 GB),
 * encryption, directory entries. Bundles are capped well below the 4 GB line by
 * the row limits in the capture op.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * MS-DOS date/time, which is what the ZIP header carries. Two-second
 * granularity and a 1980 epoch are the format's, not ours.
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  /** Path inside the archive. Forward slashes, no leading slash. */
  name: string;
  data: Buffer | string;
}

interface StagedEntry {
  nameBuf: Buffer;
  compressed: Buffer;
  crc: number;
  rawSize: number;
  method: number;
  offset: number;
}

/** Build a ZIP archive in memory. */
export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const staged: StagedEntry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const deflated = deflateRawSync(raw);
    // Deflate can inflate already-compressed input (a PNG body, say). Storing
    // it uncompressed is both smaller and cheaper to read back.
    const useDeflate = deflated.length < raw.length;
    const compressed = useDeflate ? deflated : raw;

    const nameBuf = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x800, 6); // UTF-8 filename flag
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    const crc = crc32(raw);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    staged.push({
      nameBuf,
      compressed,
      crc,
      rawSize: raw.length,
      method: useDeflate ? 8 : 0,
      offset,
    });
    chunks.push(header, nameBuf, compressed);
    offset += header.length + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  for (const entry of staged) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(entry.method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.compressed.length, 20);
    record.writeUInt32LE(entry.rawSize, 24);
    record.writeUInt16LE(entry.nameBuf.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk number
    record.writeUInt16LE(0, 36); // internal attrs
    record.writeUInt32LE(0, 38); // external attrs
    record.writeUInt32LE(entry.offset, 42);
    chunks.push(record, entry.nameBuf);
    offset += record.length + entry.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(staged.length, 8);
  eocd.writeUInt16LE(staged.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}
