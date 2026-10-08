/* Streaming ZIP writer for the browser app.
 *
 * tci2wav decodes a whole instrument folder at a time, so a single
 * "everything in memory" ZIP array is not an option: 400+ TCIs turn into
 * gigabytes of 24-bit PCM. This writer appends one entry at a time to a list
 * of Blob parts, so only the entry being added is resident. Entries are
 * deflated with CompressionStream('deflate-raw') when available and stored
 * uncompressed otherwise (drum PCM does not compress much anyway).
 *
 * Browser + Node (module.exports).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TCIZip = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  }

  let canDeflate = typeof CompressionStream !== 'undefined';
  async function deflateRaw(u8) {
    if (!canDeflate) return null;
    try {
      const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    } catch (e) {
      canDeflate = false;          // one failure is enough, stop trying
      return null;
    }
  }

  class ZipWriter {
    constructor() {
      this.parts = [];
      this.entries = [];
      this.offset = 0;
      this.raw = 0;                 // uncompressed bytes, for the progress bar
      this.done = false;
      const d = new Date();
      this.time = dosTime(d);
      this.date = dosDate(d);
    }

    // name may contain '/' and non-ASCII; entry order is insertion order.
    async add(name, data) {
      if (this.done) throw new Error('zip already finished');
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      const nb = new TextEncoder().encode(name);
      const crc = crc32(u8);
      // Deflate is only worth it if it actually shrinks the entry: 24-bit PCM
      // barely compresses and short text files can grow.
      const packed = await deflateRaw(u8);
      const useDeflate = !!packed && packed.length < u8.length;
      const method = useDeflate ? 8 : 0;
      const body = useDeflate ? packed : u8;

      const h = new Uint8Array(30 + nb.length);
      const dv = new DataView(h.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);                       // version needed
      dv.setUint16(6, 0x0800, true);                   // UTF-8 names
      dv.setUint16(8, method, true);
      dv.setUint16(10, this.time, true);
      dv.setUint16(12, this.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, body.length, true);
      dv.setUint32(22, u8.length, true);
      dv.setUint16(26, nb.length, true);
      h.set(nb, 30);

      this.parts.push(h, body);
      this.entries.push({ nb, crc, method, csize: body.length,
                        usize: u8.length, off: this.offset });
      this.offset += h.length + body.length;
      this.raw += u8.length;
    }

    // Appends a text file (MAP.txt and friends).
    addText(name, text) {
      return this.add(name, new TextEncoder().encode(text));
    }

    finish() {
      if (this.done) return this.blob();
      const central = [];
      for (const e of this.entries) {
        const c = new Uint8Array(46 + e.nb.length);
        const dv = new DataView(c.buffer);
        // central directory header: the field offsets below are fixed by the
        // spec and differ from the local header (method sits at 10, not 8)
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);            // version made by
        dv.setUint16(6, 20, true);            // version needed
        dv.setUint16(8, 0x0800, true);        // UTF-8 names
        dv.setUint16(10, e.method, true);
        dv.setUint16(12, this.time, true);
        dv.setUint16(14, this.date, true);
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.csize, true);
        dv.setUint32(24, e.usize, true);
        dv.setUint16(28, e.nb.length, true);
        dv.setUint32(42, e.off, true);
        c.set(e.nb, 46);
        central.push(c);
      }
      const cenSize = central.reduce((a, c) => a + c.length, 0);
      const eocd = new Uint8Array(22);
      const dv = new DataView(eocd.buffer);
      dv.setUint32(0, 0x06054b50, true);
      dv.setUint16(8, this.entries.length, true);
      dv.setUint16(10, this.entries.length, true);
      dv.setUint32(12, cenSize, true);
      dv.setUint32(16, this.offset, true);
      this.parts = this.parts.concat(central, [eocd]);
      this.done = true;
      return this.blob();
    }

    blob() {
      return new Blob(this.parts, { type: 'application/zip' });
    }

    get bytes() { return this.offset; }
    get count() { return this.entries.length; }
  }

  return { ZipWriter, crc32 };
}));