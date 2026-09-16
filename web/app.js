/* UI glue: file input, Worker decode, ZIP download, MAP view. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const worker = new Worker('worker.js');
  const pending = {};
  let seq = 0;
  let lastZip = null;

  worker.onmessage = (e) => {
    const cb = pending[e.data.id];
    if (cb) { delete pending[e.data.id]; cb(e.data); }
  };

  function guess() {
    const f = $('file').files[0];
    if (!f) return;
    const base = f.name.replace(/\.tci$/i, '');
    const parts = base.split(/\s+/);
    if (parts.length > 1 && !$('mic').value) $('mic').value = parts[parts.length - 1].toUpperCase();
    if (!$('family').value) {
      $('family').value = (parts.length > 1 ? parts.slice(0, -1).join('') : base).replace(/\s+/g, '');
    }
  }
  $('file').addEventListener('change', guess);

  function clean(s, fb) {
    s = (s || '').trim().replace(/[^A-Za-z0-9]+/g, '');
    return s || fb;
  }

  window.go = function () {
    const f = $('file').files[0];
    if (!f) { $('status').textContent = 'Pick a .tci file first.'; return; }
    guess();
    const family = clean($('family').value, 'Sample');
    const mic = clean($('mic').value.toUpperCase(), 'MIC');
    $('status').textContent = 'Decoding… (large files take ~1 min, tab stays responsive)';
    $('res').innerHTML = '';
    $('dl').style.display = 'none';
    $('mapview').textContent = '';
    lastZip = null;
    const rd = new FileReader();
    rd.onload = () => {
      const id = ++seq;
      pending[id] = (j) => {
        if (!j.ok) { $('status').textContent = 'Error: ' + j.error; return; }
        $('status').textContent = j.summary;
        const data = {};
        for (const wf of j.files) {
          if (wf.name) data[wf.name] = new Uint8Array(wf.wav);
        }
        data['MAP.txt'] = new TextEncoder().encode(j.map);
        lastZip = TCIExport.zipStore(data);
        const blob = new Blob([lastZip], { type: 'application/zip' });
        $('dllink').href = URL.createObjectURL(blob);
        $('dllink').download = `${family}_${mic}.zip`;
        $('dl').style.display = 'block';
        let h = '<table><tr><th>File</th><th>Wave</th><th>Grade</th><th>Peak</th><th>Parse</th></tr>';
        for (const wf of j.files) {
          h += `<tr><td><code>${wf.name || '—'}</code></td><td>${wf.wave}</td>` +
               `<td><span class="grade ${wf.grade}">${wf.grade}</span></td>` +
               `<td>${wf.peak == null ? '' : wf.peak}</td><td>${escapeHtml(wf.note)}</td></tr>`;
        }
        $('res').innerHTML = h + '</table>';
        $('mapview').textContent = j.map;
      };
      worker.postMessage({ id, family, mic, buffer: rd.result }, [rd.result]);
    };
    rd.readAsArrayBuffer(f);
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
})();
