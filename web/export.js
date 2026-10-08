/* Velocity grouping, V/RR naming, WAV + MAP output, stereo decoding.
   Port of the export half of py/tci_export.py. Browser + Node. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./decode.js'), require('./solve.js'),
                             require('./stereo.js'));
  } else {
    root.TCIExport = factory(root.TCIDecode, root.TCISolve, root.TCIStereo);
  }
}(typeof self !== 'undefined' ? self : this, function (D, S, ST) {
  'use strict';

  const RR_RATIO = 1.12;
  const ATK_N = 5000;

  function attackPeak(vec) {
    const n = Math.min(vec.length, ATK_N);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(vec[i]);
      if (a > m) m = a;
    }
    return m;
  }

  // Stereo waves decode exactly from their V1 tail; the ~2 ms attack head uses
  // a path that is not cracked, so those frames stay silent and the gap is
  // reported rather than guessed. `comp` is the footer's used-bit count.
  function decodeStereoWave(blob, comp, frames) {
    const r = ST.decodeStereo(blob, comp, frames);
    if (!r) return null;
    return {
      L: r.L,
      R: r.R,
      peak: Math.max(attackPeak(r.L), attackPeak(r.R)),
      grade: 'B',
      note: `stereo tail@bit${r.tailStart}/${r.tailSamples}sm`
        + (r.headFrames ? ` head:${r.headFrames}fr silent` : ' head:none'),
      headFrames: r.headFrames,
    };
  }

  function pack24LE(v) {
    const iv = Math.max(-8388608, Math.min(8388607, Math.round(v))) & 0xFFFFFF;
    return [iv & 255, (iv >> 8) & 255, (iv >> 16) & 255];
  }

  function wavHeader(nCh, nFrames) {
    const h = new Uint8Array(44);
    const dv = new DataView(h.buffer);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) h[o + i] = s.charCodeAt(i); };
    ws(0, 'RIFF');
    dv.setUint32(4, 36 + nFrames * nCh * 3, true);
    ws(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, nCh, true);
    dv.setUint32(24, 44100, true);
    dv.setUint32(28, 44100 * nCh * 3, true);
    dv.setUint16(32, nCh * 3, true);
    dv.setUint16(34, 24, true);
    ws(36, 'data');
    dv.setUint32(40, nFrames * nCh * 3, true);
    return h;
  }

  function exportMonoWav(vec) {
    const n = vec.length;
    const out = new Uint8Array(44 + n * 3);
    out.set(wavHeader(1, n), 0);
    for (let i = 0; i < n; i++) {
      const [a, b, c] = pack24LE(vec[i]);
      out[44 + 3 * i] = a; out[44 + 3 * i + 1] = b; out[44 + 3 * i + 2] = c;
    }
    return out;
  }

  function exportStereoWav(L, R) {
    const n = Math.min(L.length, R.length);
    const out = new Uint8Array(44 + n * 6);
    out.set(wavHeader(2, n), 0);
    for (let i = 0; i < n; i++) {
      const [a, b, c] = pack24LE(L[i]);
      const [d, e, f] = pack24LE(R[i]);
      out.set([a, b, c, d, e, f], 44 + 6 * i);
    }
    return out;
  }

  // waves: [{comp,frames,stereo,blob,v1?}]. Returns {files, skipped, mapText}.
  // files: [{name, wave, channels, grade, peak, note, wav:Uint8Array}]
  function exportWaves(waves, family, mic) {
    const items = [];
    waves.forEach((wv, i) => {
      const wave = `wave${String(i).padStart(2, '0')}`;
      try {
        if (String(wv.stereo).startsWith('1')) {
          const r = decodeStereoWave(wv.blob, wv.comp, wv.frames);
          if (!r) {
            items.push({ pk: 0, i, wave, kind: 'skip', payload: null, channels: 2,
                         grade: 'X', note: 'no V1 tail chain reaches end-of-bits' });
            return;
          }
          items.push({ pk: r.peak, i, wave, kind: 'stereo', payload: [r.L, r.R],
                       channels: 2, grade: r.grade, note: r.note });
          return;
        }
        if (wv.v1) {
          const v = D.applyVoiceRule(wv.v1, wv.frames);
          items.push({ pk: attackPeak(v), i, wave, kind: 'mono', payload: v,
                       channels: 1, grade: 'A', note: 'V1 single' });
          return;
        }
        const r = S.solveWave(wv.blob, wv.frames);
        if (!r.spec) {
          items.push({ pk: 0, i, wave, kind: 'skip', payload: null, channels: 1,
                       grade: r.grade, note: r.note });
          return;
        }
        const v = D.applyVoiceRule(D.decodeWave(wv.blob, wv.frames, r.spec), wv.frames);
        items.push({ pk: attackPeak(v), i, wave, kind: 'mono', payload: v,
                     channels: 1, grade: r.grade, note: r.note });
      } catch (e) {
        items.push({ pk: 0, i, wave, kind: 'skip', payload: null, channels: 1,
                     grade: 'X', note: 'crash: ' + e.message });
      }
    });
    const ranked = items.filter(it => it.kind !== 'skip').sort((a, b) => a.pk - b.pk);
    const groups = [];
    let cur = [];
    for (const it of ranked) {
      const mx = cur.reduce((m, x) => Math.max(m, x.pk), 0);
      if (cur.length && it.pk / Math.max(mx, 1e-9) >= RR_RATIO) {
        groups.push(cur);
        cur = [];
      }
      cur.push(it);
    }
    if (cur.length) groups.push(cur);
    const files = [];
    groups.forEach((grp, vi) => {
      grp.sort((a, b) => a.pk - b.pk).forEach((it, ri) => {
        const fn = `${family}_${mic}_V${String(vi + 1).padStart(2, '0')}_RR${ri + 1}.wav`;
        const wav = it.kind === 'stereo'
          ? exportStereoWav(it.payload[0], it.payload[1])
          : exportMonoWav(it.payload);
        files.push({ name: fn, wave: it.wave, channels: it.channels,
                     grade: it.grade, peak: peakOf(it), note: it.note, wav });
      });
    });
    const skipped = items.filter(it => it.kind === 'skip')
      .map(it => ({ name: null, wave: it.wave, channels: it.channels,
                    grade: it.grade, peak: null, note: it.note }));
    const tag = (c) => (c === 2 ? 'st' : 'mono');
    const lines = files.map(f => `${f.name} <- ${f.wave} [${f.grade}] ${tag(f.channels)} peak=${f.peak} ${f.note}`)
      .concat(skipped.map(s => `-- ${s.wave} [${s.grade}] ${tag(s.channels)} ${s.note}`));
    return { files, skipped, mapText: lines.join('\n') + '\n' };
  }

  function peakOf(it) {
    let m = 0;
    const seqs = it.kind === 'stereo' ? it.payload : [it.payload];
    for (const v of seqs) for (let i = 0; i < v.length; i++) {
      const a = Math.abs(v[i]);
      if (a > m) m = a;
    }
    return Math.round(m);
  }

  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Minimal ZIP writer (stored, no compression): {name: Uint8Array} -> Uint8Array.
  function zipStore(files) {
    const enc = new TextEncoder();
    const names = Object.keys(files);
    let size = 0;
    const metas = names.map((name) => {
      const nb = enc.encode(name);
      size += 30 + nb.length + files[name].length + 46 + nb.length;
      return { name, nb };
    });
    size += 22;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let p = 0, central = 0;
    const cen = [];
    metas.forEach(({ name, nb }) => {
      const data = files[name];
      const crc = crc32(data);
      cen.push([p, name, nb, data.length, crc]);
      dv.setUint32(p, 0x04034b50, true);
      dv.setUint16(p + 8, 0, true);
      dv.setUint32(p + 14, crc, true);
      dv.setUint32(p + 18, data.length, true);
      dv.setUint32(p + 22, data.length, true);
      dv.setUint16(p + 26, nb.length, true);
      out.set(nb, p + 30);
      out.set(data, p + 30 + nb.length);
      p += 30 + nb.length + data.length;
    });
    central = p;
    let cc = 0;
    for (const [off, name, nb, len, crc] of cen) {
      dv.setUint32(p, 0x02014b50, true);
      dv.setUint32(p + 16, crc, true);
      dv.setUint32(p + 42, off, true);
      dv.setUint32(p + 24, len, true);
      dv.setUint32(p + 20, len, true);
      dv.setUint16(p + 28, nb.length, true);
      out.set(nb, p + 46);
      p += 46 + nb.length;
      cc++;
    }
    dv.setUint32(p, 0x06054b50, true);
    dv.setUint16(p + 8, cc, true);
    dv.setUint16(p + 10, cc, true);
    dv.setUint32(p + 12, p - central, true);
    dv.setUint32(p + 16, central, true);
    return out;
  }

  return { RR_RATIO, ATK_N, attackPeak, decodeStereoWave, exportMonoWav,
           exportStereoWav, exportWaves, zipStore };
}));
