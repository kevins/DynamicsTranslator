// Minimal ZIP reader/writer for .xlsx workbooks and solution packages.
// Uses the browser's native DecompressionStream/CompressionStream ('deflate-raw').

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}
/** An entry of a package read by openZip: its contents are unpacked by read(). */
export interface ZipFile {
  name: string;
  read(): Promise<Uint8Array>;
}

const streamBytes = async (data: Uint8Array, t: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(t)).arrayBuffer());

/** Inflates raw deflate data that must come to exactly `size` bytes (null when it doesn't); never holds more. */
async function inflate(raw: Uint8Array, size: number): Promise<Uint8Array | null> {
  const out = new Uint8Array(size);
  const r = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>).getReader();
  for (let n = 0; ; ) {
    const { done, value } = await r.read();
    if (done) return n === size ? out : null;
    if (n + value.length > size) {
      r.cancel().catch(() => {});
      return null;
    }
    out.set(value, n);
    n += value.length;
  }
}

/**
 * Lists a ZIP package's entries from its central directory (local headers may have zero sizes). Nothing is unpacked
 * until an entry is read, and only to the size the directory declares, which with the CRC-32 must match: a damaged
 * file is refused, never read as other text. `limit` caps the bytes all reads together may unpack, since a file of
 * a few kilobytes can unpack to gigabytes.
 */
export function openZip(bytes: Uint8Array, limit = Infinity): ZipFile[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('The file is not a valid ZIP package.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipFile[] = [];
  let used = 0;
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The ZIP directory is damaged.');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    out.push({
      name,
      async read() {
        if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression (${method}) in ${name}.`);
        if ((used += size) > limit)
          throw new Error(`The file is too large to open here: it unpacks to more than ${Math.round(limit / 2 ** 20)} MB. Split it into smaller files and import them one at a time.`);
        let data: Uint8Array | null = null;
        if (lho + 30 <= bytes.length && dv.getUint32(lho, true) === 0x04034b50) {
          const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
          const raw = start + csize <= bytes.length ? bytes.subarray(start, start + csize) : null;
          // A deflate stream that is cut short or holds invalid codes makes the stream fail.
          if (raw) data = method === 0 ? (csize === size ? raw.slice() : null) : await inflate(raw, size).catch(() => null);
        }
        if (!data || crc32(data) !== crc) throw new Error(`The file is damaged (${name} is not intact). Save or export it again, then use the new file.`);
        return data;
      },
    });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** Reads every entry (see openZip). */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const f of openZip(bytes)) out.push({ name: f.name, data: await f.read() });
  return out;
}

let crcTable: Uint32Array | null = null;
export function crc32(d: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP file. Entries are deflated unless `store` is true. */
export async function zip(entries: ZipEntry[], store = false): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const comp = store ? e.data : await streamBytes(e.data, new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
    const method = store ? 0 : 8;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of all) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

export const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);
