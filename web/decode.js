/* TCI decode primitives: V1/V2 containers, sign-magnitude bitstream,
   specs (raw/blk/blocks/tail8), voice rule. Port of py/tci_decode.py.
   Works in browsers (plain script) and Node (module.exports). */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TCIDecode = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';


  function sm24(b0, b1, b2) {
    const v = (b0 << 16) | (b1 << 8) | b2;
    return (v & 0x800000) ? -(v & 0x7FFFFF) : v;
  }

  // k-bit sign-magnitude field at bit pos (MSB-first). Returns [value, nextPos].
  function readSM(u8, pos, k) {
    let mag = 0;
    const sign = bitAt(u8, pos) ? -1 : 1;
    for (let i = 1; i < k; i++) mag = (mag << 1) | bitAt(u8, pos + i);
    return [sign < 0 && mag !== 0 ? -mag : (sign < 0 ? -0 : mag), pos + k];
  }

  function bitAt(u8, pos) {
    return (u8[pos >> 3] >> (7 - (pos & 7))) & 1;
  }

  function byteAt(u8, pos) {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | bitAt(u8, pos + i);
    return v;
  }

  function bitsOf(u8) {
    return { u8, len: u8.length * 8 };
  }

  function latin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function parseAttrs(xml) {
    const m = /<trigger_instrument([^>]+)>/.exec(xml);
    if (!m) return null;
    const attrs = {};
    const re = /(\S+)="([^"]*)"/g;
    let g;
    while ((g = re.exec(m[1])) !== null) attrs[g[1]] = g[2];
    return attrs;
  }

  // Inflate a zlib stream with the platform decoder (no third-party code).
  // Engine conventions differ ('deflate' = zlib-wrapped in Chrome/Deno,
  // raw in spec/Firefox), so try wrapped first, then stripped raw.
  async function runDS(fmt, input) {
    const ds = new DecompressionStream(fmt);
    return new Uint8Array(await new Response(
      new Blob([input]).stream().pipeThrough(ds)).arrayBuffer());
  }

  async function inflateZlib(u8) {
    const data = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    try {
      return await runDS('deflate', data);
    } catch (e) {
      const raw = (data.length > 6 && data[0] === 0x78)
        ? data.slice(2, data.length - 4) : data;
      return await runDS('deflate-raw', raw);
    }
  }

  async function parseV2(u8) {
    try {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const audioLen = dv.getUint32(64, true);
      const blob = u8.subarray(76, 76 + audioLen);
      const foot = u8.subarray(76 + audioLen);
      const dec = await inflateZlib(foot.subarray(8));
      if (!(dec[0] === 0x56 && dec[1] === 0x43 && dec[2] === 0x32 && dec[3] === 0x21)) return null;
      let xml;
      try {
        xml = new TextDecoder('utf-8', { fatal: true }).decode(dec.subarray(8));
      } catch (e) {
        xml = latin1(dec.subarray(8));
      }
      const attrs = parseAttrs(xml);
      if (!attrs || !attrs.data_count) return null;
      const waves = [];
      let off = 0;
      const n = parseInt(attrs.data_count, 10);
      for (let i = 0; i < n; i++) {
        const comp = parseInt(attrs['wd' + i + 'comp1'], 10);
        const fr = parseInt(attrs['wd' + i + 'frames'], 10);
        if (!isFinite(comp) || !isFinite(fr)) return null;
        const nb = Math.ceil(comp / 8);
        waves.push({ comp, frames: fr, stereo: attrs['wd' + i + 'stereo'] || '?',
                     blob: blob.subarray(off, off + nb) });
        off += nb;
      }
      return waves;
    } catch (e) {
      return null;
    }
  }

  // Trigger Instrument Editor variant ("COMPRESSED INSTRUMENT" tag):
  // 128-byte file header, then waves chained by 8-byte gap records
  // [05][prev_wave_span_bytes LE] ... [06][0] + params footer to EOF.
  // Each wave: [01][comp u32 LE][frames u32 LE][V1 blocks, two's complement].
  function parseEditor(u8) {
    if (u8.length < 128) return null;
    if (!(u8[0] === 0x54 && u8[1] === 0x52 && u8[2] === 0x49 && u8[3] === 0x47 &&
          u8[4] === 0x47 && u8[5] === 0x45 && u8[6] === 0x52 && u8[7] === 0x20)) return null;
    let tag = '';
    for (let i = 8; i < 64 && u8[i]; i++) tag += String.fromCharCode(u8[i]);
    if (tag.indexOf('COMPRESSED') !== 0) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const bit = (base, p) => (u8[base + (p >> 3)] >> (7 - (p & 7))) & 1;
    const waves = [];
    let pos = 128;
    for (let w = 0; w < 256; w++) {
      if (pos + 9 > u8.length || u8[pos] !== 0x01) break;
      const comp = dv.getUint32(pos + 1, true);
      const fr = dv.getUint32(pos + 5, true);
      if (!(comp > 0 && fr > 1 && fr < 1e7)) break;
      const base = pos + 9;
      const blen = Math.ceil(comp / 8);
      if (base + blen > u8.length) break;
      let p = 0;
      const out = [];
      let ok = true;
      while (out.length < fr - 1) {
        if (p + 8 > comp) { ok = false; break; }
        let k = 0;
        for (let i = 0; i < 8; i++) k = (k << 1) | bit(base, p + i);
        if (!(k >= 1 && k <= 24)) { ok = false; break; }
        p += 8;
        const n = Math.min(201, fr - 1 - out.length);
        if (p + n * k > comp) { ok = false; break; }
        for (let i = 0; i < n; i++) {
          let v = 0;
          for (let j = 0; j < k; j++) v = (v << 1) | bit(base, p + j);
          p += k;
          out.push(bit(base, p - k) ? v - (1 << k) : v);
        }
      }
      if (!ok || p !== comp || out.length !== fr - 1) break;
      const span = 9 + blen;
      waves.push({ comp, frames: fr, stereo: '0-ed', v1: Float64Array.from(out) });
      pos += span;
      if (pos + 8 > u8.length) break;
      const gt = u8[pos];
      if (gt === 0x06) break; // footer: params table to EOF
      if (gt !== 0x05) break;
      pos += 8;
    }
    return waves.length ? waves : null;
  }
  // Oracle-proven V1 single wave: [01][comp u32][frames u32] then
  // [k:8][201 x k-bit] two's-complement residuals. Tries BE then LE.
  function parseV1(u8) {
    if (!u8.length || u8[0] !== 0x01) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (const le of [false, true]) {
      let comp, fr;
      try {
        comp = dv.getUint32(1, le);
        fr = dv.getUint32(5, le);
      } catch (e) { continue; }
      if (!(comp > 0 && comp <= 8 * (u8.length - 9))) continue;
      if (!(fr > 0 && fr < 1e7)) continue;
      const body = u8.subarray(9);
      const blen = comp;
      let pos = 0;
      const out = [];
      let ok = true;
      const bit = (p) => (body[p >> 3] >> (7 - (p & 7))) & 1;
      while (out.length < fr - 1) {
        if (pos + 8 > blen) { ok = false; break; }
        let k = 0;
        for (let i = 0; i < 8; i++) k = (k << 1) | bit(pos + i);
        if (!(k >= 1 && k <= 24)) { ok = false; break; }
        pos += 8;
        const n = Math.min(201, fr - 1 - out.length);
        if (pos + n * k > blen) { ok = false; break; }
        for (let i = 0; i < n; i++) {
          let v = 0;
          for (let j = 0; j < k; j++) v = (v << 1) | bit(pos + j);
          pos += k;
          out.push(bit(pos - k) ? v - (1 << k) : v);
        }
      }
      if (ok && pos === comp && out.length === fr - 1) {
        return [{ comp, frames: fr, stereo: '0-x', v1: Float64Array.from(out) }];
      }
    }
    return null;
  }

  // V1 201-count blocks from bit pos. Returns {samples:Array, endpos}.
  function decodeBlocks(u8, bitlen, pos) {
    const out = [];
    while (pos + 8 <= bitlen) {
      const k = byteAt(u8, pos);
      if (!(k >= 1 && k <= 24)) break;
      pos += 8;
      let n = 201;
      if (pos + n * k > bitlen) n = Math.floor((bitlen - pos) / k);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) {
        const r = readSM(u8, pos, k);
        pos = r[1];
        out.push(r[0] === 0 ? 0 : r[0]); // normalize -0
      }
    }
    return { samples: out, endpos: pos };
  }

  // spec: ['raw',n] | ['blk',S,k,C,T] | ['blocks',[[k,C]..],T] | ['tail8',T0?]
  function decodeWave(wblob, frames, spec) {
    const w = wblob instanceof Uint8Array ? wblob : new Uint8Array(wblob);
    const kind = spec[0];
    if (kind === 'raw') {
      const nraw = spec[1];
      const raw = [];
      for (let i = 0; i < 3 * nraw; i += 3) raw.push(sm24(w[i], w[i + 1], w[i + 2]));
      const t2 = decodeBlocks(w.subarray(3 * nraw), (w.length - 3 * nraw) * 8, 0);
      return raw.concat(t2.samples);
    }
    if (kind === 'tail8') {
      const T0 = spec.length > 1 ? spec[1] : 8;
      return decodeBlocks(w, w.length * 8, T0).samples;
    }
    if (kind === 'blk') {
      const S = spec[1], k = spec[2], C = spec[3], T = spec[4];
      const atk = [];
      for (let i = 0; i < C; i++) {
        const r = readSM(w, S + 8 + i * k, k);
        atk.push(r[0] === 0 ? 0 : r[0]);
      }
      return atk.concat(decodeBlocks(w, w.length * 8, T).samples);
    }
    if (kind === 'blocks') {
      const blks = spec[1], T = spec[2];
      let p = 0;
      const out = [];
      for (const [k, C] of blks) {
        p += 8;
        for (let i = 0; i < C; i++) {
          const r = readSM(w, p, k);
          p = r[1];
          out.push(r[0] === 0 ? 0 : r[0]);
        }
      }
      return out.concat(decodeBlocks(w, w.length * 8, T).samples);
    }
    throw new Error('bad spec');
  }

  function applyVoiceRule(vec, frames) {
    const out = new Float64Array(frames);
    const n = Math.min(vec.length, frames);
    for (let i = 0; i < n; i++) out[i] = vec[i];
    return out;
  }

  return { sm24, readSM, bitAt, byteAt, bitsOf, parseV2, parseV1, parseEditor,
           decodeBlocks, decodeWave, applyVoiceRule };
}));
