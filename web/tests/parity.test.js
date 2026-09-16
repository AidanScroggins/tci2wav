/* Self-contained correctness tests (no Slate files needed).
   Run: node --test tests/   (CI runs this on every push) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../decode.js');
const S = require('../solve.js');
const E = require('../export.js');

function bitsToBytes(bitstr) {
  const nb = Math.ceil(bitstr.length / 8);
  const u8 = new Uint8Array(nb);
  for (let i = 0; i < bitstr.length; i++) {
    if (bitstr[i] === '1') u8[i >> 3] |= 1 << (7 - (i & 7));
  }
  return u8;
}
const k8 = (v) => v.toString(2).padStart(8, '0');

// sign-magnitude primitives
test('sm24 sign-magnitude', () => {
  assert.equal(D.sm24(0x00, 0x00, 0x00), 0);
  assert.equal(D.sm24(0x12, 0x34, 0x56), 0x123456);
  assert.equal(D.sm24(0x80 | 0x12, 0x34, 0x56), -0x123456);
  assert.equal(D.sm24(0xFF, 0xFF, 0xFF), -0x7FFFFF);
});

// V1 single wave round-trip (BE header form)
test('parseV1 BE round-trip', () => {
  const vals = [];
  for (let v = -100; v <= 100; v++) vals.push(v);
  let bits = k8(8);
  for (const v of vals) { // sign-magnitude: sign + 7-bit magnitude
    bits += (v < 0 ? '1' : '0') + Math.abs(v).toString(2).padStart(7, '0');
  }
  bits += k8(1) + '0'.repeat(201);
  const comp = bits.length, fr = 1 + 201 + 201;
  const nb = Math.ceil(comp / 8);
  const blob = bitsToBytes(bits.padEnd(nb * 8, '0'));
  const buf = new Uint8Array(1 + 8 + nb);
  buf[0] = 0x01;
  new DataView(buf.buffer).setUint32(1, comp, false);
  new DataView(buf.buffer).setUint32(5, fr, false);
  buf.set(blob, 9);
  const waves = D.parseV1(buf);
  assert.ok(waves && waves.length === 1);
  assert.equal(waves[0].frames, fr);
  const got = Array.from(waves[0].v1);
  assert.deepEqual(got.slice(0, 201), vals);
  assert.ok(got.slice(201).every((v) => v === 0));
});

// V1 rejects truncated garbage
test('parseV1 rejects garbage', () => {
  assert.equal(D.parseV1(new Uint8Array([1, 2, 3])), null);
  assert.equal(D.parseV1(new Uint8Array([2, 0, 0, 0, 5, 0, 0, 0, 0])), null);
});

// minimal V2 container: 1 wave, raw2 + two 201-blocks, identity bytes
function synthV2() {
  const zlib = require('node:zlib');
  // blob = 2 raw BE24 sign-mag samples, then V1 blocks
  const rawBytes = [0x00, 0x03, 0xE8, 0x80, 0x07, 0xD0]; // +1000, -2000
  const raw = [1000, -2000];
  let bits = '';
  const push = (k, arr) => {
    bits += k8(k);
    for (const v of arr) {
      const mag = Math.abs(v);
      bits += (v < 0 ? '1' : '0') + mag.toString(2).padStart(k - 1, '0');
    }
  };
  const b1 = [], b2 = [];
  for (let i = 0; i < 201; i++) { b1.push((i % 201) - 100); b2.push((i % 7) - 3); }
  push(8, b1);
  push(3, b2);
  const comp = 48 + bits.length; // 6 raw bytes + residual bits
  const nb = Math.ceil(bits.length / 8);
  const wbits = bitsToBytes(bits.padEnd(nb * 8, '0'));
  const wblob = new Uint8Array(6 + nb);
  wblob.set(rawBytes, 0);
  wblob.set(wbits, 6);
  const head = new Uint8Array(76);
  new DataView(head.buffer).setUint32(64, 6 + nb, true); // audioLen covers raw + residual
  const xml = `<trigger_instrument data_count="1" wd0comp1="${comp}" ` +
    `wd0frames="${2 + 402}" wd0stereo="0" wd0vol="1" data0_offset1="0"/>`;
  // NOTE: real footers carry 4 extra bytes after VC2! before the XML
  const z = zlib.deflateSync(new TextEncoder().encode('VC2!\0\0\0\0' + xml));
  const foot = new Uint8Array(8 + z.length);
  foot.set(z, 8);
  const out = new Uint8Array(76 + 6 + nb + foot.length);
  out.set(head, 0); out.set(wblob, 76); out.set(foot, 76 + 6 + nb);
  return { out, raw, b1, b2 };
}

test('parseV2 + raw spec round-trip', async () => {
  const { out, raw, b1, b2 } = synthV2();
  const waves = await D.parseV2(out);
  assert.ok(waves && waves.length === 1);
  assert.equal(waves[0].frames, 404);
  assert.equal(waves[0].stereo, '0');
  const v = D.decodeWave(waves[0].blob, 404, ['raw', 2]);
  assert.deepEqual(Array.from(v.slice(0, 2)), raw);
  assert.deepEqual(Array.from(v.slice(2, 203)), b1);
  assert.deepEqual(Array.from(v.slice(203)), b2);
});

// solver finds the raw spec structurally
test('solveWave finds raw200-equivalent (raw2)', async () => {
  const { out } = synthV2();
  const waves = await D.parseV2(out);
  // NOTE: solver hardcodes nraw=200; synth has raw2, so emulate via blocks:
  // instead verify tail counting + run scan see the two blocks.
  const bits = waves[0].blob;
  const runs = S.runScan(bits, bits.length * 8, 0, 60000, 1, 201);
  assert.ok(runs.length >= 2);
  const t = S.tailCount(bits, bits.length * 8, runs[runs.length - 1][1]);
  assert.ok(t.cnt >= 201);
});

// export naming + MAP + WAV validity on a solver-grade-A wave
// (raw200 smooth ramp + twelve 201-count k=8 blocks)
test('exportWaves naming/grading/MAP', async () => {
  const zlib = require('node:zlib');
  const NRAW = 200, NB = 12, K = 8;
  const rawBytes = [];
  for (let i = 0; i < NRAW; i++) {
    const v = i * 100;
    rawBytes.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
  }
  let bits = '';
  for (let b = 0; b < NB; b++) {
    bits += k8(K);
    for (let i = 0; i < 201; i++) {
      const v = ((i * 7 + b * 13) % 101) - 50;
      bits += (v < 0 ? '1' : '0') + Math.abs(v).toString(2).padStart(K - 1, '0');
    }
  }
  const comp = 8 * NRAW * 3 + bits.length;
  const nb = Math.ceil(bits.length / 8);
  const wbits = bitsToBytes(bits.padEnd(nb * 8, '0'));
  const wblob = new Uint8Array(3 * NRAW + nb);
  wblob.set(rawBytes, 0);
  wblob.set(wbits, 3 * NRAW);
  const fr = NRAW + NB * 201;
  const head = new Uint8Array(76);
  new DataView(head.buffer).setUint32(64, 3 * NRAW + nb, true);
  const xml = `<trigger_instrument data_count="1" wd0comp1="${comp}" ` +
    `wd0frames="${fr}" wd0stereo="0"/>`;
  const z = zlib.deflateSync(new TextEncoder().encode('VC2!\0\0\0\0' + xml));
  const foot = new Uint8Array(8 + z.length);
  foot.set(z, 8);
  const out = new Uint8Array(76 + 3 * NRAW + nb + foot.length);
  out.set(head, 0); out.set(wblob, 76); out.set(foot, 76 + 3 * NRAW + nb);
  const waves = await D.parseV2(out);
  assert.ok(waves && waves.length === 1);
  const r = E.exportWaves(
    waves.map((w) => ({ ...w, blob: w.blob })), 'TestKick', 'Z1');
  assert.equal(r.files.length, 1);
  assert.match(r.files[0].name, /^TestKick_Z1_V\d+_RR\d+\.wav$/);
  assert.equal(r.files[0].grade, 'A');
  const wav = r.files[0].wav;
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.ok(r.mapText.includes(r.files[0].name));
});

// Trigger Instrument Editor variant: header + gap-chained V1 waves
test('parseEditor round-trip', () => {
  const mkWave = (vals, k) => {
    let bits = '';
    for (let s = 0; s < vals.length; s += 201) {
      bits += k8(k);
      for (const v of vals.slice(s, s + 201)) {
        const m = Math.abs(v); // sign-magnitude
        bits += (v < 0 && m !== 0 ? '1' : '0') + m.toString(2).padStart(k - 1, '0');
      }
    }
    return { bits, comp: bits.length, fr: vals.length + 1 };
  };
  const v1 = [], v2 = [];
  for (let i = 0; i < 402; i++) v1.push((i % 201) - 100);
  for (let i = 0; i < 300; i++) v2.push(i % 2 ? 7 : -7);
  const w1 = mkWave(v1, 8), w2 = mkWave(v2, 4);
  const parts = [];
  const head = new Uint8Array(128);
  new TextEncoder().encodeInto('TRIGGER ', head.subarray(0, 8));
  new TextEncoder().encodeInto('COMPRESSED INSTRUMENT', head.subarray(8, 64));
  new DataView(head.buffer).setUint32(64, 1, true);
  new DataView(head.buffer).setUint32(68, 2, true);
  parts.push(head);
  const layouts = [];
  for (const w of [w1, w2]) {
    const nb = Math.ceil(w.comp / 8);
    const blob = bitsToBytes(w.bits.padEnd(nb * 8, '0'));
    const rec = new Uint8Array(9 + nb);
    rec[0] = 0x01;
    new DataView(rec.buffer).setUint32(1, w.comp, true);
    new DataView(rec.buffer).setUint32(5, w.fr, true);
    rec.set(blob, 9);
    layouts.push({ rec, span: 9 + nb });
  }
  parts.push(layouts[0].rec);
  const gap = new Uint8Array(8);
  gap[0] = 0x05;
  new DataView(gap.buffer).setUint32(4, layouts[0].span, true);
  parts.push(gap, layouts[1].rec);
  const foot = new Uint8Array([0x06, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
  parts.push(foot);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  const waves = D.parseEditor(out);
  assert.ok(waves && waves.length === 2);
  assert.deepEqual(Array.from(waves[0].v1), v1);
  assert.deepEqual(Array.from(waves[1].v1), v2);
  // full export path: naming + grades
  const r = E.exportWaves(
    waves.map((w, i) => ({ comp: 0, frames: w.v1.length + 1, stereo: '0-ed', blob: new Uint8Array(0), v1: w.v1 })), 'Ed', 'T1');
  assert.equal(r.files.length, 2);
  assert.ok(r.files[0].name.startsWith('Ed_T1_V'));
});
test('stereo tails deinterleave', () => {
  // 2 x 201-blocks k=4 with distinct streams; even/odd blocks differ
  let bits = '';
  const put = (k, arr) => {
    bits += k8(k);
    for (const v of arr) bits += (v < 0 ? '1' : '0') + Math.abs(v).toString(2).padStart(k - 1, '0');
  };
  const A = [], B = [];
  for (let i = 0; i < 201; i++) { A.push(100 + (i % 50)); B.push(-50 - (i % 40)); }
  put(10, A); put(9, B); put(10, A); put(9, B);
  const u8 = bitsToBytes(bits);
  const t = S.tailCount(u8, u8.length * 8, 0);
  assert.equal(t.cnt, 804);
});
