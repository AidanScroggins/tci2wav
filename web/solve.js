/* Structural solver for unknown waves. Port of py/solve_wave.py +
   render_library.solve_wave. Works in browsers and Node. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./decode.js'));
  } else {
    root.TCISolve = factory(root.TCIDecode);
  }
}(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  const KMAP = { 145: 23, 149: 23, 29: 23, 62: 23, 75: 23, 142: 20, 22: 21,
                 140: 21, 129: 20, 191: 20, 20: 20, 24: 24 };

  function runScan(u8, bitlen, lo, hi, minRun, count) {
    lo = lo || 0; hi = hi || 60000; minRun = minRun || 10; count = count || 201;
    const out = [];
    const end = Math.min(hi, bitlen - 8);
    for (let pos = lo; pos < end; pos++) {
      const k0 = D.byteAt(u8, pos);
      if (!(k0 >= 1 && k0 <= 24)) continue;
      let run = 0, p = pos;
      while (p + 8 <= bitlen) {
        const k = D.byteAt(u8, p);
        if (!(k >= 1 && k <= 24)) break;
        if (p + 8 + count * k > bitlen) { run += 0.5; break; }
        p += 8 + count * k;
        run += 1;
        if (run > 600) break;
      }
      if (run >= minRun) out.push([run, pos]);
    }
    out.sort((a, b) => b[0] - a[0]);
    return out;
  }

  function tailCount(u8, bitlen, T, count) {
    count = count || 201;
    let pos = T, cnt = 0;
    while (pos + 8 <= bitlen) {
      const k = D.byteAt(u8, pos);
      if (!(k >= 1 && k <= 24)) break;
      pos += 8;
      let n = count;
      if (pos + n * k > bitlen) n = Math.floor((bitlen - pos) / k);
      if (n <= 0) break;
      pos += n * k;
      cnt += n;
    }
    return { cnt, endpos: pos };
  }

  function decodeSpan(u8, pos, k, C) {
    const out = new Float64Array(C);
    for (let i = 0; i < C; i++) {
      const r = D.readSM(u8, pos, k);
      pos = r[1];
      out[i] = r[0] === 0 ? 0 : r[0];
    }
    return out;
  }

  function smoothScore(seg, k) {
    if (seg.length < 8) return 9.0;
    let s = 0;
    for (let i = 1; i < seg.length; i++) s += Math.abs(seg[i] - seg[i - 1]);
    return (s / (seg.length - 1)) / Math.pow(2, k - 1);
  }

  function tailEndOk(endp, L, tol) {
    return endp >= L - (tol === undefined ? 64 : tol);
  }

  // Returns {spec, grade, note} or {spec:null,...}. Mirrors solve_wave().
  function solveWave(wblob, fr) {
    const w = wblob instanceof Uint8Array ? wblob : new Uint8Array(wblob);
    const bitlen = w.length * 8;
    const raw = new Float64Array(200);
    for (let i = 0; i < 200; i++) raw[i] = D.sm24(w[3 * i], w[3 * i + 1], w[3 * i + 2]);
    let rmad = 0;
    for (let i = 1; i < 200; i++) rmad += Math.abs(raw[i] - raw[i - 1]);
    rmad = (rmad / 199) / Math.pow(2, 23);
    if (rmad < 0.25) {
      const t = D.decodeBlocks(w.subarray(600), (w.length - 600) * 8, 0);
      const over = 200 + t.samples.length - fr;
      if (over >= -2 && tailEndOk(4800 + t.endpos, bitlen)) {
        return { spec: ['raw', 200], grade: 'A',
                 note: `raw200 mad=${rmad.toFixed(3)} over=${over}` };
      }
    }
    // multi identity-chain prefixes from bit 0
    let p = 0;
    const blks = [];
    while (p + 8 <= bitlen && blks.length < 12) {
      const k = D.byteAt(w, p);
      if (!(k >= 1 && k <= 24) || p + 8 + 201 * k > bitlen) break;
      blks.push([k, 201, p]);
      p += 8 + 201 * k;
    }
    for (let n = Math.min(blks.length, 12); n >= 2; n--) {
      const pre = blks.slice(0, n);
      const Tp = pre[n - 1][2] + 8 + 201 * pre[n - 1][0];
      const t = tailCount(w, bitlen, Tp);
      let sum = 0;
      for (const b of pre) sum += b[1];
      const over = sum + t.cnt - fr;
      if (over >= -2 && over <= 44 && tailEndOk(t.endpos, bitlen)) {
        return { spec: ['blocks', pre.map(b => [b[0], b[1]]), Tp], grade: 'A',
                 note: `${n}x identity blocks over=${over}` };
      }
    }
    // single-block fits
    const cands = [], k1cands = [];
    for (const [, T] of runScan(w, bitlen, 0, 60000, 10, 201)) {
      const t = tailCount(w, bitlen, T);
      if (!tailEndOk(t.endpos, bitlen)) continue;
      const lo = Math.max(8, fr - t.cnt - 8);
      for (let C = lo; C <= fr - t.cnt + 44; C++) {
        for (let k = 1; k <= 24; k++) {
          const S = T - 8 - C * k;
          if (S < 0 || S > 6000) continue;
          const sc = smoothScore(decodeSpan(w, S + 8, k, C), k);
          if (sc >= 0.15) continue;
          const b = D.byteAt(w, S);
          if (k === 1) {
            k1cands.push([S, Math.abs(C + t.cnt - fr), C, T, b, sc]);
          } else {
            const bonus = (b === k) || (KMAP[b] === k);
            cands.push([bonus, S, Math.abs(C + t.cnt - fr), C, k, T, b, sc]);
          }
        }
      }
    }
    let best = null;
    if (cands.length) {
      cands.sort((a, b2) => ((!a[0]) - (!b2[0])) || (a[1] - b2[1]) || (a[2] - b2[2]));
      const [, S, , C, k, T, b, sc] = cands[0];
      const over = C + tailCount(w, bitlen, T).cnt - fr;
      const grade = (over === 0 && sc < 0.08) ? 'A' : (Math.abs(over) <= 2 ? 'B' : 'C');
      best = { spec: ['blk', S, k, C, T], grade,
               note: `C=${C} k=${k} S=${S} T=${T} byte=${b} over=${over} sm=${sc.toFixed(2)}` };
    } else if (k1cands.length) {
      k1cands.sort((a, b2) => (a[0] - b2[0]) || (a[1] - b2[1]));
      const [, , C, T, b, sc] = k1cands[0];
      const over = C + tailCount(w, bitlen, T).cnt - fr;
      best = { spec: ['blk', T - 8 - C, 1, C, T], grade: 'C',
               note: `C=${C} k=1 S=${T - 8 - C} T=${T} byte=${b} over=${over} sm=${sc.toFixed(2)} (silence?)` };
    }
    // tailN: leading zero bytes + V1 tail. Preferred over k==1 silence.
    let tailn = null;
    let Z = 0;
    while (Z < 4 && w[Z] === 0) Z++;
    if (Z) {
      const T0 = 8 * Z;
      const t = tailCount(w, bitlen, T0);
      const over = t.cnt - fr;
      if (over >= -8 && over <= 44 && tailEndOk(t.endpos, bitlen)) {
        const kk = D.byteAt(w, T0);
        if (kk >= 1 && kk <= 24) {
          const sc = smoothScore(decodeSpan(w, T0, kk, 201), kk);
          if (sc < 0.15) {
            tailn = { spec: ['tail8', T0], grade: 'B',
                      note: `tail-from-${T0} zeros=${Z} over=${over}` };
          }
        }
      }
    }
    if (best && best.spec[0] === 'blk' && best.spec[2] === 1 && tailn) return tailn;
    if (best) return best;
    if (tailn) return tailn;
    return { spec: null, grade: 'X', note: 'unsolved' };
  }

  return { KMAP, runScan, tailCount, decodeSpan, smoothScore, solveWave };
}));
