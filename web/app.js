/* UI glue: single-file and folder conversion, audition player, ZIP download.

   Preview safety: decoded waves can hit nearly full scale, so the player starts
   at a low level and optionally ramps in over ~25 ms (a hard start on a
   full-scale transient is an unpleasant click). Export is always bit-exact and
   never passes through this gain.

   Batch memory: a whole library is gigabytes of 24-bit PCM, so results are
   streamed into the ZIP one entry at a time and only the most recent
   instruments keep their audio buffers alive for previewing (PREVIEW_KEEP). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const FS = 2 ** 23 - 1;              // 24-bit full scale
  const PREVIEW_KEEP = 6;               // instruments kept auditionable
  const SEP = '\u0000';                // joins instrument key and wave name
  const WARN_BYTES = 2 * 1024 ** 3;     // ~2 GB of input before we warn

  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ── theme ───────────────────────────────────────────────────────────── */
  const THEME_KEY = 'tci2wav-theme';
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    $('thDark').setAttribute('aria-selected', String(t === 'dark'));
    $('thLight').setAttribute('aria-selected', String(t === 'light'));
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode */ }
  }
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
  setTheme(saved || 'dark');
  $('thDark').onclick = () => setTheme('dark');
  $('thLight').onclick = () => setTheme('light');

  /* ── preview player ──────────────────────────────────────────────────── */
  const player = $('player');
  const volSlider = $('vol');
  const fadeBox = $('fadeIn');
  let targetVol = volSlider.valueAsNumber / 100;
  let ramp = null;
  let currentToken = null;      // instrumentKey + SEP + wave name
  let currentKey = null;        // instrumentKey, for dropping stale auditions
  let currentPeak = 0;

  function dbOf(v) { return v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf'; }

  function showVolume() {
    const pct = Math.round(targetVol * 100);
    $('volPct').textContent = pct;
    $('volDb').textContent = pct ? dbOf(targetVol) : '-inf';
    player.volume = targetVol;
  }
  function killRamp() { if (ramp) { cancelAnimationFrame(ramp); ramp = null; } }

  // Ramp up from silence so a full-scale attack transient does not click.
  function rampIn() {
    killRamp();
    if (!fadeBox.checked) { player.volume = targetVol; return; }
    const t0 = performance.now(), ms = 25;
    player.volume = 0;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      player.volume = targetVol * (k * k * (3 - 2 * k));   // smoothstep
      ramp = k < 1 ? requestAnimationFrame(step) : null;
    };
    ramp = requestAnimationFrame(step);
  }

  function loadPreview(key, token, url, label, peak) {
    killRamp();
    const same = currentToken === token;
    currentToken = token;
    currentKey = key;
    currentPeak = peak || 0;
    $('nowPlaying').textContent = label;
    const norm = currentPeak / FS;
    $('peakBar').style.width = Math.min(100, norm * 100).toFixed(1) + '%';
    $('peakDb').textContent = currentPeak
      ? (norm >= 0.98 ? '⚠ ' : '') + dbOf(norm) + ' dBFS' : '—';
    if (same) return;
    player.src = url;
    player.load();
    for (const b of document.querySelectorAll('.playbtn.on')) b.classList.remove('on');
  }

  function stopAll() {
    killRamp();
    player.pause();
    player.currentTime = 0;
    currentToken = null;
    for (const b of document.querySelectorAll('.playbtn.on')) b.classList.remove('on');
  }

  player.addEventListener('play', () => markPlaying(true));
  player.addEventListener('pause', () => markPlaying(false));
  player.addEventListener('ended', () => markPlaying(false));
  function markPlaying(on) {
    for (const b of document.querySelectorAll('.playbtn.on')) b.classList.remove('on');
    if (!on || !currentToken || !currentKey) return;
    const b = document.querySelector(
      `.playbtn[data-key="${attr(currentKey)}"][data-name="${attr(currentToken.slice(currentKey.length + 1))}"]`);
    if (b) b.classList.add('on');
  }
  function attr(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  volSlider.addEventListener('input', () => { targetVol = volSlider.valueAsNumber / 100; showVolume(); });
  $('stopAll').onclick = stopAll;
  showVolume();

  /* ── worker pool ─────────────────────────────────────────────────────── */
  const POOL = 2;
  const workers = [];
  const pending = new Map();
  let seq = 0;
  for (let i = 0; i < POOL; i++) {
    const w = new Worker('worker.js');
    w.onmessage = (e) => {
      const cb = pending.get(e.data.id);
      if (cb) { pending.delete(e.data.id); cb(e.data); }
    };
    w.onerror = (e) => {
      for (const [, cb] of pending) cb({ ok: false, error: e.message || 'worker error' });
      pending.clear();
    };
    workers.push(w);
  }

  let rr = 0;
  function decodeInWorker(file, family, mic) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onerror = () => reject(new Error('could not read ' + file.name));
      rd.onload = () => {
        const id = ++seq;
        pending.set(id, (j) => (j.ok ? resolve(j) : reject(new Error(j.error))));
        workers[rr = (rr + 1) % POOL].postMessage(
          { id, family, mic, buffer: rd.result }, [rd.result]);
      };
      rd.readAsArrayBuffer(file);
    });
  }

  /* ── shared helpers ──────────────────────────────────────────────────── */
  const clean = TCINaming.clean;
  function status(el, msg, kind) {
    el.textContent = msg || '';
    el.className = 'status' + (msg ? ' show' : '') + (kind ? ' ' + kind : '');
  }
  function human(bytes) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }

  /* ── results table + preview registry ────────────────────────────────── */
  // key -> { rows, urls: Map(name -> url) }. Oldest are dropped so a folder
  // run does not accumulate gigabytes of blob URLs.
  const auditions = new Map();

  function registerAuditions(key, files) {
    for (const [k, rec] of auditions) for (const u of rec.urls.values()) URL.revokeObjectURL(u);
    const urls = new Map();
    for (const f of files) if (f.name) urls.set(f.name, URL.createObjectURL(new Blob([f.wav], { type: 'audio/wav' })));
    auditions.set(key, { urls, rows: files });
    while (auditions.size > PREVIEW_KEEP) {
      const oldest = auditions.keys().next().value;
      if (oldest === key) break;
      for (const u of auditions.get(oldest).urls.values()) URL.revokeObjectURL(u);
      auditions.delete(oldest);
      if (currentKey && !auditions.has(currentKey)) { stopAll(); currentKey = null; }
    }
  }

  function waveRows(key, files, host) {
    host.textContent = '';
    for (const f of files) {
      const tr = document.createElement('tr');
      const playable = !!f.name;
      tr.innerHTML =
        `<td>${playable ? `<button class="playbtn" data-key="${esc(key)}" data-name="${esc(f.name)}">▶ play</button>` : ''}</td>` +
        `<td><code>${esc(f.name || '—')}</code></td>` +
        `<td><span class="chip ${f.channels === 2 ? 'st' : ''}">${f.channels === 2 ? 'stereo' : 'mono'}</span></td>` +
        `<td class="num">${esc(f.wave)}</td>` +
        `<td><span class="grade g-${esc(f.grade)}">${esc(f.grade)}</span></td>` +
        `<td class="num">${f.peak == null ? '' : f.peak}</td>` +
        `<td style="color:var(--muted)">${esc(f.note)}</td>`;
      const btn = tr.querySelector('.playbtn');
      if (btn) btn.onclick = () => playFromRegistry(key, btn);
      host.appendChild(tr);
    }
  }

  function playFromRegistry(key, btn) {
    const rec = auditions.get(key);
    if (!rec) return;
    const name = btn.dataset.name;
    const url = rec.urls.get(name);
    const f = rec.rows.find((r) => r.name === name);
    if (!url || !f) return;
    const token = key + SEP + name;
    if (currentToken === token && !player.paused) { stopAll(); return; }
    loadPreview(key, token, url, name, f.peak);
    for (const b of document.querySelectorAll('.playbtn')) b.classList.remove('on');
    btn.classList.add('on');
    player.play().catch(() => { /* autoplay policy */ });
  }

  /* ── single file ─────────────────────────────────────────────────────── */
  function guessSingle() {
    const f = $('file').files[0];
    if (!f) return;
    const info = TCINaming.describe(f.name);
    if (!$('mic').value) $('mic').value = info.mic;
    if (!$('family').value) $('family').value = info.family;
  }
  $('file').addEventListener('change', guessSingle);

  $('goSingle').onclick = async () => {
    const f = $('file').files[0];
    if (!f) { status($('stSingle'), 'Pick a .tci file first.', 'err'); return; }
    guessSingle();
    const family = clean($('family').value, 'Sample');
    const mic = clean($('mic').value.toUpperCase(), 'MIC');
    const btn = $('goSingle');
    btn.disabled = true;
    status($('stSingle'), `Decoding ${f.name}… (${human(f.size)})`);
    try {
      const j = await decodeInWorker(f, family, mic);
      const key = 'single';
      registerAuditions(key, j.files);
      waveRows(key, j.files, $('resRows'));
      $('resWrap').hidden = false;
      $('mapview').textContent = j.map;
      $('mapDetails').open = true;

      const zip = new TCIZip.ZipWriter();
      for (const wf of j.files) {
        if (wf.name) await zip.add(wf.name, new Uint8Array(wf.wav));
      }
      await zip.addText('MAP.txt', j.map);
      const url = URL.createObjectURL(zip.finish());
      const a = $('dlSingle');
      a.href = url;
      a.download = `${family}_${mic}.zip`;
      a.hidden = false;
      status($('stSingle'), `${j.summary} — ${j.files.filter((x) => x.name).length} auditionable`, 'ok');
    } catch (err) {
      status($('stSingle'), 'Error: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };

  /* ── batch folder ────────────────────────────────────────────────────── */
  let batchCancel = false;

  $('folder').addEventListener('change', () => {
    const files = [...$('folder').files].filter((f) => /\.tci$/i.test(f.name));
    const bytes = files.reduce((a, f) => a + f.size, 0);
    $('batchPick').textContent = files.length
      ? `${files.length} .tci · ${human(bytes)}` : 'no .tci files selected';
    status($('stBatch'), files.length
      ? (bytes > WARN_BYTES ? `That is a lot of data (${human(bytes)}). Decoding runs a couple of workers and may take several minutes; the tab stays usable.` : '')
      : 'That folder has no .tci files.', files.length ? (bytes > WARN_BYTES ? '' : 'ok') : 'err');
  });

  $('cancelBatch').onclick = () => { batchCancel = true; };

  $('goBatch').onclick = async () => {
    const all = [...$('folder').files].filter((f) => /\.tci$/i.test(f.name));
    if (!all.length) { status($('stBatch'), 'Pick a folder containing .tci files first.', 'err'); return; }

    batchCancel = false;
    const go = $('goBatch'), cancel = $('cancelBatch'), dl = $('dlBatch');
    go.disabled = true;
    cancel.hidden = false;
    dl.hidden = true;
    $('barBatch').hidden = false;
    $('batchTable').hidden = false;
    $('resWrap').hidden = true;
    $('resRows').textContent = '';
    $('mapview').textContent = '';
    for (const u of [...auditions.values()]) for (const x of u.urls.values()) URL.revokeObjectURL(u);
    auditions.clear();
    stopAll();

    // root = the selected folder itself, so we can mirror its subfolders
    const root = all[0].webkitRelativePath ? all[0].webkitRelativePath.split('/')[0] : '';
    const jobs = all.map((file) => {
      const rel = file.webkitRelativePath || file.name;
      const info = TCINaming.describe(rel);
      return { file, rel, info, dir: TCINaming.targetDir(info, root),
               family: info.family, mic: info.mic };
    });

    const zip = new TCIZip.ZipWriter();
    const mapLines = ['# <folder>/<instrument>/<mic> <- wave, grade, peak, parse note'];
    let done = 0, waves = 0, stereo = 0, failed = 0;
    const seenDirs = new Set();
    const t0 = performance.now();

    const bar = $('barBatch').querySelector('i');
    const rows = $('batchRows');
    rows.textContent = '';
    const trs = jobs.map((j) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><code>${esc(j.file.name)}</code></td>` +
        `<td style="color:var(--muted)">${esc(j.dir ? j.dir + '/' : '')}${esc(j.family)}_${esc(j.mic)}</td>` +
        `<td class="num"></td><td class="num"></td>` +
        `<td style="color:var(--muted)">queued</td>` +
        `<td><button class="playbtn" hidden>▶</button></td>`;
      rows.appendChild(tr);
      return tr;
    });

    status($('stBatch'), `Converting 0/${jobs.length}…`);

    // Two files at a time; the ZIP only ever holds one decoded file at once.
    const queue = jobs.slice();
    let active = 0;
    const runNext = async () => {
      while (queue.length && !batchCancel) {
        active++;
        const job = queue.shift();
        const tr = trs[jobs.indexOf(job)];
        tr.children[4].textContent = 'decoding…';
        try {
          const j = await decodeInWorker(job.file, job.family, job.mic);
          const key = job.dir + '' + job.file.name;
          const dir = (job.dir ? job.dir + '/' : '');
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            await zip.addText((dir || '') + 'README.txt',
              `tci2wav export\nsource: ${job.rel}\n` +
              `family: ${job.family}  mic: ${job.mic}\n${j.summary}\n`);
          }
          for (const wf of j.files) {
            if (!wf.name) continue;
            await zip.add(dir + wf.name, new Uint8Array(wf.wav));
            waves++;
            if (wf.channels === 2) stereo++;
            mapLines.push(`${dir}${wf.name} <- ${wf.wave} [${wf.grade}] ` +
              `${wf.channels === 2 ? 'st' : 'mono'} peak=${wf.peak} ${wf.note}`);
          }
          for (const wf of j.files) if (!wf.name) {
            mapLines.push(`-- ${dir}${wf.wave} [${wf.grade}] ${wf.note}`);
          }
          mapLines.push(`# ${job.rel} :: ${j.summary}`);

          registerAuditions(key, j.files);
          waveRows(key, j.files, $('resRows'));
          $('resWrap').hidden = false;
          $('mapview').textContent = mapLines.join('\n');

          const n = j.files.filter((x) => x.name).length;
          const s2 = j.files.filter((x) => x.channels === 2).length;
          tr.children[2].textContent = n;
          tr.children[3].textContent = s2;
          tr.children[4].textContent = 'done';
          tr.children[4].style.color = 'var(--accent-2)';
          const btn = tr.children[5].querySelector('.playbtn');
          if (n) {
            btn.hidden = false;
            btn.onclick = () => { $('resWrap').hidden = false; playFromRegistry(key, btn); };
            btn.title = 'Audition this instrument';
          }
        } catch (err) {
          failed++;
          tr.children[4].textContent = 'failed: ' + err.message;
          tr.children[4].style.color = 'var(--danger)';
        }
        done++;
        bar.style.width = ((done / jobs.length) * 100).toFixed(1) + '%';
        const secs = (performance.now() - t0) / 1000;
        const eta = done ? (secs / done) * (jobs.length - done) : 0;
        status($('stBatch'),
          `${batchCancel ? 'Cancelled' : 'Converting'} ${done}/${jobs.length} · ` +
          `${waves} WAVs (${stereo} stereo)${failed ? ` · ${failed} failed` : ''}` +
          (done < jobs.length ? ` · ~${eta < 60 ? Math.ceil(eta) + 's' : Math.ceil(eta / 60) + 'm'} left` : ''));
        active--;
      }
    };
    await Promise.all([runNext(), runNext()]);

    if (done < jobs.length) {
      status($('stBatch'), `Cancelled after ${done}/${jobs.length}. Nothing downloaded — remove the cancel to finish the run.`, 'err');
    } else {
      await zip.addText('MAP.txt', mapLines.join('\n') + '\n');
      const url = URL.createObjectURL(zip.finish());
      dl.href = url;
      dl.download = `${root || 'tci2wav'}_batch.zip`;
      dl.hidden = false;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      status($('stBatch'),
        `${jobs.length} TCIs → ${waves} WAVs (${stereo} stereo)` +
        `${failed ? `, ${failed} failed` : ''} · ${human(zip.bytes)} zip · ${secs}s`,
        failed ? '' : 'ok');
    }
    $('barBatch').hidden = true;
    go.disabled = false;
    cancel.hidden = true;
  };
})();