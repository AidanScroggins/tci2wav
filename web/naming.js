/* Folder-path -> (family, mic, output directory) rules.

   Kept separate from the UI so both the single-file and the batch path derive
   names the same way, and so the rules can be tested directly.

   A Trigger 2 library is laid out as
       <Category>/<Instrument>/<Instrument> <MIC>.tci
   e.g. "Trigger2 Kicks/ACKick/ACKick NRG.tci" -> family ACKick, mic NRG, and the
   WAVs land in "Trigger2 Kicks/ACKick/NRG/". Falling back to the filename when
   there is no parent folder keeps single files and loose downloads working. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TCINaming = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Strip anything that would be awkward in a filename or a ZIP entry.
  function clean(s, fallback) {
    const t = String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '');
    return t || fallback;
  }

  // relPath may be a full relative path or a bare filename.
  // Returns {dir, family, mic, base, file}.
  function describe(relPath) {
    const parts = String(relPath || '').split('/').filter(Boolean);
    const file = parts.pop() || '';
    const base = file.replace(/\.tci$/i, '');
    const toks = base.split(/\s+/).filter(Boolean);
    const mic = toks.length > 1 ? clean(toks[toks.length - 1].toUpperCase(), 'MIC') : '';
    // Prefer the containing folder as the family: it is the stable name, and
    // filenames vary ("ACKick NRG.tci" vs "ACKick_SSDR.tci" vs "ACKick Z3.tci").
    const fromDir = parts.length ? clean(parts[parts.length - 1], '') : '';
    const fromName = toks.length > 1 ? clean(toks.slice(0, -1).join(''), '') : clean(base, '');
    return {
      file,
      base,
      dir: parts.join('/'),
      family: clean(fromDir || fromName, 'Sample'),
      mic: clean(mic, 'MIC'),
    };
  }

  // Where a converted wave should live inside the batch ZIP: the source tree
  // (minus the folder the user selected) plus a MIC folder, which is the same
  // shape the Python CLI writes: <Category>/<Instrument>/<MIC>/.
  function targetDir(info, root) {
    let dir = info.dir;
    if (root) {
      const r = String(root).split('/').filter(Boolean);
      const d = dir.split('/').filter(Boolean);
      if (r.length && d.length && r.every((seg, i) => d[i] === seg)) dir = d.slice(r.length).join('/');
    }
    return dir ? dir + '/' + info.mic : info.mic;
  }

  return { clean, describe, targetDir };
}));