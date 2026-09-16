/* Web Worker: decode off the main thread. */
importScripts('decode.js', 'solve.js', 'export.js');

onmessage = async function (e) {
  const { id, family, mic, buffer } = e.data;
  try {
    const u8 = new Uint8Array(buffer);
    let waves = await TCIDecode.parseV2(u8);
    if (!waves) waves = TCIDecode.parseV1(u8);
    if (!waves) waves = TCIDecode.parseEditor(u8);
    if (!waves) {
      postMessage({ id, ok: false, error: 'unrecognized file (not V1, V2, or Editor TCI)' });
      return;
    }
    const r = TCIExport.exportWaves(waves, family, mic);
    const files = r.files.map(f => ({
      name: f.name, wave: f.wave, grade: f.grade, peak: f.peak, note: f.note,
      wav: f.wav.buffer
    }));
    const skipped = r.skipped.map(s => ({
      name: null, wave: s.wave, grade: s.grade, peak: null, note: s.note
    }));
    const xfer = files.map(f => f.wav);
    postMessage({ id, ok: true, files: files.concat(skipped), map: r.mapText,
                  summary: `${files.length} WAVs + MAP.txt (${r.skipped.length} skipped)` }, xfer);
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
