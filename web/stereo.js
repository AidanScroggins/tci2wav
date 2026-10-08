/* Stereo (stereo=1) wave decoder.

   Layout, as proven against the library (see WRITEUP.md section 5):
     - The wave is one joint stream of `2 * frames` sign-magnitude samples
       (the footer confirms it: wd{i}samples == 2 * wd{i}frames).
     - Everything from `tailStart` on is a chain of V1 blocks,
       [k:8][201 x k-bit samples], and that chain consumes the wave's bit
       budget to within a few trailing pad bits.
     - Sample N of the joint stream is L when N is even and R when N is odd,
       counted over the WHOLE stream including the head. Because a block
       holds an odd 201 samples, this parity alternates block by block;
       deinterleaving by global index is what keeps the channels consistent.
     - The first `head` joint samples (0..400 across the library, median 186,
       i.e. ~93-100 frames or ~2 ms) come from a non-V1 head path that is not
       decoded yet. They are left silent and reported, never guessed.

   Works in browsers (plain script) and Node (module.exports). */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TCIStereo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLOCK_SAMPLES = 201;
  const MAX_K = 24;

  // The tail start never exceeded 7236 bits over the whole library; 64 kbit
  // of headroom keeps the scan cheap without risking a miss.
  const HEAD_SCAN_BITS = 65536;
  // Loudest observed head was 400 joint samples. 4096 (~2k frames) still
  // catches anything unusual while rejecting accidental early matches.
  const HEAD_MAX_SAMPLES = 4096;
  // Trailing slack between the chain end and wd{i}comp1 was at most 31 bits.
  const TAIL_TOLERANCE_BITS = 64;

  function asU8(x) {
    return x instanceof Uint8Array ? x : new Uint8Array(x);
  }

  // 8-bit value starting at bit offset `pos` (MSB-first bitstream).
  function byteAt(u8, pos) {
    const j = pos >> 3, s = pos & 7;
    let v = u8[j] << s;
    if (s && j + 1 < u8.length) v |= u8[j + 1] >> (8 - s);
    return v & 0xFF;
  }

  // k-bit sign-magnitude field at bit offset `pos`. k=1 always decodes to 0.
  // s + k <= 31, so a 4-byte window and one unsigned shift are enough.
  function readSM(u8, pos, k) {
    const j = pos >> 3, s = pos & 7;
    const a = j < u8.length ? u8[j] : 0;
    const b = j + 1 < u8.length ? u8[j + 1] : 0;
    const c = j + 2 < u8.length ? u8[j + 2] : 0;
    const d = j + 3 < u8.length ? u8[j + 3] : 0;
    const word = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const code = (word >>> (32 - s - k)) & ((1 << k) - 1);
    const mag = code & ((1 << (k - 1)) - 1);
    return (code & (1 << (k - 1))) && mag ? -mag : mag;
  }

  // Width byte at every bit offset below `nbits`, so scanning the head
  // region does not re-derive bytes per candidate.
  function bitByteTable(u8, nbits) {
    const n = Math.min(nbits, u8.length * 8);
    const t = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = i >> 3, s = i & 7;
      let v = u8[j] << s;
      if (s && j + 1 < u8.length) v |= u8[j + 1] >> (8 - s);
      t[i] = v & 0xFF;
    }
    return t;
  }

  // Walk V1 blocks from `start`, stopping once `count` would exceed `cap`.
  // Returns {count, end} when the chain reaches `comp` (within tolerance),
  // else null.
  function walkTail(u8, kv, start, comp, cap, tol) {
    let pos = start, count = 0;
    const nearEnd = () => (pos >= comp - tol ? { count, end: pos } : null);
    while (pos + 8 <= comp) {
      const k = pos < kv.length ? kv[pos] : byteAt(u8, pos);
      if (k < 1 || k > MAX_K) return nearEnd();
      pos += 8;
      let n = BLOCK_SAMPLES;
      if (pos + n * k > comp) n = Math.floor((comp - pos) / k);
      if (n <= 0) return nearEnd();
      pos += n * k;
      count += n;
      if (count > cap) return null;
    }
    return nearEnd();
  }

  // Locate the tail: the earliest bit offset from which a V1 block chain reaches
  // the end of the bit budget while leaving at most HEAD_MAX_SAMPLES joint
  // samples unexplained. Every block boundary inside a real tail qualifies, so
  // the smallest head wins. Chance matches inside the head do exist (its bits
  // are high-entropy audio, and ~9% of byte values look like a width byte) but
  // a real chain has to survive millions of bits to the end of the wave to
  // qualify, which they never do: 3902/3902 waves decode with the smallest
  // head in range.
  function findTail(u8, comp, totalSamples) {
    const kv = bitByteTable(u8, Math.min(HEAD_SCAN_BITS, comp));
    let best = null;
    for (let T = 0; T + 8 <= kv.length; T++) {
      const k = kv[T];
      if (k < 1 || k > MAX_K) continue;
      const w = walkTail(u8, kv, T, comp, totalSamples, TAIL_TOLERANCE_BITS);
      if (!w) continue;
      const head = totalSamples - w.count;
      if (head < 0 || head > HEAD_MAX_SAMPLES) continue;
      if (!best || head < best.head) best = { tailStart: T, count: w.count, end: w.end, head };
    }
    return best;
  }

  // Joint V1 stream between two bit offsets, exactly `count` samples long.
  function decodeJoint(u8, start, end, count) {
    const out = new Float64Array(count);
    let pos = start, n = 0;
    while (pos + 8 <= end && n < count) {
      const k = byteAt(u8, pos);
      if (k < 1 || k > MAX_K) break;
      pos += 8;
      let m = Math.min(BLOCK_SAMPLES, count - n, Math.floor((end - pos) / k));
      for (let i = 0; i < m; i++, n++) out[n] = readSM(u8, pos + i * k, k);
      pos += m * k;
    }
    return out;
  }

  // Returns {L, R, headSamples, headFrames, tailStart} or null when no tail
  // chain explains the wave. L/R hold exactly `frames` samples each; the
  // unresolved head frames stay silent at the front.
  function decodeStereo(wblob, comp, frames) {
    const u8 = asU8(wblob);
    if (!(comp > 0) || !(frames > 0)) return null;
    const t = findTail(u8, comp, 2 * frames);
    if (!t) return null;
    const joint = decodeJoint(u8, t.tailStart, t.end, t.count);
    const L = new Float64Array(frames);
    const R = new Float64Array(frames);
    // Frame j owns global joint samples 2j (L) and 2j+1 (R); global index g
    // sits at tail index g - head, so anything below `head` is a sample the
    // undecoded head path should have supplied and is left silent.
    for (let j = 0; j < frames; j++) {
      const i = 2 * j - t.head;
      if (i >= 0) L[j] = joint[i];
      if (i + 1 >= 0) R[j] = joint[i + 1];
    }
    return {
      L,
      R,
      headSamples: t.head,
      headFrames: Math.ceil(t.head / 2),
      tailStart: t.tailStart,
      tailSamples: t.count,
    };
  }

  return {
    BLOCK_SAMPLES,
    MAX_K,
    HEAD_SCAN_BITS,
    HEAD_MAX_SAMPLES,
    TAIL_TOLERANCE_BITS,
    byteAt,
    readSM,
    bitByteTable,
    walkTail,
    findTail,
    decodeJoint,
    decodeStereo,
  };
}));