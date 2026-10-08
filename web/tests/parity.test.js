/* Self-contained correctness tests (no Slate files needed).
   Run: node --test tests/   (CI runs this on every push) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../decode.js');
const S = require('../solve.js');
const ST = require('../stereo.js');
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
test('stereo tail chains: V1 blocks counted as joint samples', () => {
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

// --- stereo ---------------------------------------------------------------
// A stereo wave is `2 * frames` joint samples. Everything from the tail start
// on is a V1 block chain; the head is a non-V1 path we do not decode, so those
// joint samples must come back silent and be counted.

// append one [k:8][n x k-bit] block; |v| must stay under 2^(k-1)
const block = (bits, k, vals) => {
  let s = bits + k8(k);
  for (const v of vals) {
    assert.ok(Math.abs(v) < Math.pow(2, k - 1), `sample ${v} does not fit in ${k} bits`);
    s += (v < 0 ? '1' : '0') + Math.abs(v).toString(2).padStart(k - 1, '0');
  }
  return s;
};

// values that stay inside k bits and vary smoothly
const smooth = (n, base, step) =>
  Array.from({ length: n }, (_, i) => ((base + i * step) % 100) + 1);

// A non-V1 head of `headBits` pseudo-random bits (plenty of byte values that
// look like width bytes) followed by a V1 tail of `joint` samples. The tail is
// deliberately long, like a real wave: a chance match inside the head would
// have to survive millions of bits to reach the end, which is why picking the
// smallest head is safe on real files.
function buildStereoBlob(headSamples, headBits, joint, k, base, step) {
  let junk = '';
  let seed = 0x2f6e2b1;
  while (junk.length < headBits) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    junk += (seed >>> 12).toString(2).padStart(19, '0');
  }
  const j = smooth(joint, base, step);
  let bits = junk.slice(0, headBits);
  for (let off = 0; off < joint; off += 201) bits = block(bits, k, j.slice(off, off + 201));
  const nb = Math.ceil(bits.length / 8);
  assert.ok(headSamples > 0 && headSamples < 4096);
  return { blob: bitsToBytes(bits.padEnd(nb * 8, '0')), comp: bits.length, j };
}

const K = 9, JOINT = 2400; // 12 tail blocks

test('decodeStereo: even head deinterleaves and pads the gap', () => {
  const HEAD = 200;
  const { blob, comp, j } = buildStereoBlob(HEAD, 3000, JOINT, K, 3, 1);
  const frames = (HEAD + JOINT) / 2;
  const r = ST.decodeStereo(blob, comp, frames);
  assert.ok(r, 'stereo wave should decode');
  assert.equal(r.headSamples, HEAD);
  assert.equal(r.headFrames, HEAD / 2);
  assert.equal(r.tailSamples, JOINT);
  assert.equal(r.tailStart, 3000);
  assert.equal(r.L.length, frames);
  assert.equal(r.R.length, frames);
  // the unresolved head frames are silent
  for (let i = 0; i < HEAD / 2; i++) assert.equal(r.L[i] + r.R[i], 0);
  // frame HEAD/2 owns global joint samples HEAD and HEAD+1
  assert.equal(r.L[HEAD / 2], j[0]);
  assert.equal(r.R[HEAD / 2], j[1]);
  assert.equal(r.L[frames - 1], j[JOINT - 2]);
  assert.equal(r.R[frames - 1], j[JOINT - 1]);
});

test('decodeStereo: odd head leaves a half-silent frame, channels stay L/R', () => {
  const HEAD = 201, JOINT_ODD = 2401; // both odd so 2 * frames stays integral
  const { blob, comp, j } = buildStereoBlob(HEAD, 3000, JOINT_ODD, K, 5, 1);
  const frames = (HEAD + JOINT_ODD) / 2;
  const r = ST.decodeStereo(blob, comp, frames);
  assert.ok(r);
  assert.equal(r.headSamples, HEAD);
  assert.equal(r.headFrames, (HEAD + 1) / 2);
  // global index HEAD is odd -> it is R of frame (HEAD-1)/2, so L is still head
  const half = (HEAD - 1) / 2;
  assert.equal(r.L[half], 0);
  assert.equal(r.R[half], j[0]);
  assert.equal(r.L[half + 1], j[1]);
  assert.equal(r.R[half + 1], j[2]);
  assert.equal(r.R[frames - 1], j[JOINT_ODD - 1]);
});

test('decodeStereo: every tail sample is used exactly once', () => {
  const HEAD = 4;
  const { blob, comp, j } = buildStereoBlob(HEAD, 2500, JOINT, K, 7, 3);
  const frames = (HEAD + JOINT) / 2;
  const r = ST.decodeStereo(blob, comp, frames);
  assert.ok(r);
  assert.equal(r.tailSamples, JOINT);
  const seen = [];
  for (let f = 0; f < frames; f++) {
    if (r.L[f]) seen.push(r.L[f]);
    if (r.R[f]) seen.push(r.R[f]);
  }
  assert.deepEqual(seen, j);
});

test('decodeStereo: head chance matches do not beat the real tail', () => {
  // the junk head contains byte values that look like width bytes; none of
  // them can chain to the end of a wave-length tail
  for (const headBits of [1200, 2500, 4000]) {
    const { blob, comp } = buildStereoBlob(190, headBits, JOINT, K, 11, 1);
    const r = ST.decodeStereo(blob, comp, (190 + JOINT) / 2);
    assert.ok(r, `headBits=${headBits}`);
    assert.equal(r.tailStart, headBits);
    assert.equal(r.headSamples, 190);
  }
});

test('decodeStereo: rejects a blob with no tail chain', () => {
  const dead = new Uint8Array(512); // all zeros: width byte 0 is never valid
  assert.equal(ST.decodeStereo(dead, dead.length * 8, 100), null);
  assert.equal(ST.decodeStereo(new Uint8Array(0), 0, 100), null);
});

// minimal V2 container wrapping one wave
function synthV2Wave(blob, comp, frames, stereo) {
  const zlib = require('node:zlib');
  const head = new Uint8Array(76);
  new DataView(head.buffer).setUint32(64, blob.length, true);
  const xml = `<trigger_instrument data_count="1" wd0comp1="${comp}" ` +
    `wd0frames="${frames}" wd0stereo="${stereo}" ` +
    `wd0samples="${stereo ? 2 * frames : frames}" wd0vol="1"/>`;
  const z = zlib.deflateSync(new TextEncoder().encode('VC2!\0\0\0\0' + xml));
  const foot = new Uint8Array(8 + z.length);
  foot.set(z, 8);
  const out = new Uint8Array(76 + blob.length + foot.length);
  out.set(head, 0); out.set(blob, 76); out.set(foot, 76 + blob.length);
  return out;
}

test('exportWaves: stereo WAV is 2ch 24-bit with the head gap reported', async () => {
  const HEAD = 186;
  const { blob, comp } = buildStereoBlob(HEAD, 2600, JOINT, 12, 21, 3);
  const frames = (HEAD + JOINT) / 2;
  const waves = await D.parseV2(synthV2Wave(blob, comp, frames, 1));
  assert.ok(waves && waves.length === 1);
  assert.equal(waves[0].stereo, '1');

  const r = E.exportWaves(waves, 'TestTom', 'NRG');
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].channels, 2);
  assert.equal(r.files[0].grade, 'B');
  assert.match(r.files[0].name, /^TestTom_NRG_V\d+_RR\d+\.wav$/);
  assert.match(r.files[0].note, /head:93fr silent/);
  assert.match(r.mapText, /\[B\] st peak=/);

  const wav = r.files[0].wav;
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(dv.getUint16(22, true), 2);       // channels
  assert.equal(dv.getUint16(34, true), 24);      // bits per sample
  assert.equal(dv.getUint32(40, true), frames * 6);
  assert.equal(wav.length, 44 + frames * 6);
});

test('exportWaves: mono and stereo waves report their own channel count', async () => {
  const monoBits = block('', 10, smooth(201, 1, 1));
  const mono = await D.parseV2(synthV2Wave(bitsToBytes(monoBits), monoBits.length, 202, 0));
  const st = buildStereoBlob(4, 2000, 402, 10, 2, 1);
  const stereo = await D.parseV2(synthV2Wave(st.blob, st.comp, 203, 1));

  const monoOut = E.exportWaves(mono, 'X', 'Z1');
  const stOut = E.exportWaves(stereo, 'X', 'NRG');
  assert.equal(monoOut.files[0].channels, 1);
  assert.equal(new DataView(monoOut.files[0].wav.buffer).getUint16(22, true), 1);
  assert.equal(monoOut.files[0].wav.length, 44 + 202 * 3);
  assert.equal(stOut.files[0].channels, 2);
  assert.equal(new DataView(stOut.files[0].wav.buffer).getUint16(22, true), 2);
  assert.equal(stOut.files[0].wav.length, 44 + 203 * 6);
});
