/* UI glue: a queue of .tci jobs, converted into one ZIP, with an audition player.

   One code path covers both cases. Adding a single file produces a queue of
   one, so "one instrument" and "a whole library" differ only in how many rows
   the Jobs table has. Family and MIC are guesses derived from the path, and
   are editable per job because the guess is wrong for plenty of real folders.

   Preview safety: decoded waves can hit nearly full scale, so the player
   starts at a low level and ramps in over ~25 ms. A hard start on a
   full-scale transient is an unpleasant click. Export never passes through
   this gain and stays bit-exact.

   Batch memory: a library is gigabytes of 24-bit PCM, so entries are streamed
   into the ZIP one at a time and only the most recent jobs keep their audio
   buffers alive for previewing (PREVIEW_KEEP). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const FS = 2 ** 23 - 1;              // 24-bit full scale
  const PREVIEW_KEEP = 6;
  const SEP = '\u0000';   // not legal in a filename, so it cannot clash
  const WARN_BYTES = 2 * 1024 ** 3;

  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const attr = (s) => String(s).replace(/["\\]/g, '\\$&');
  const dbOf = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
  const human = (b) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  };

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
  let currentToken = null;      // jobId + SEP + wave name
  let currentJob = null;
  let currentPeak = 0;

  function showVolume() {
    const pct = Math.round(targetVol * 100);
    $('volPct').textContent = pct;
    $('volDb').textContent = pct ? dbOf(targetVol) : '-inf';
    player.volume = targetVol;
  }
  function killRamp() { if (ramp) { cancelAnimationFrame(ramp); ramp = null; } }

  function rampIn() {
    killRamp();
    if (!fadeBox.checked) { player.volume = targetVol; return; }
    const t0 = performance.now();
    player.volume = 0;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 25);
      player.volume = targetVol * k * k * (3 - 2 * k);   // smoothstep
      ramp = k < 1 ? requestAnimationFrame(step) : null;
    };
    ramp = requestAnimationFrame(step);
  }

  function markPlaying(on) {
    for (const b of document.querySelectorAll('.playbtn.on')) b.classList.remove('on');
    if (!on || !currentToken) return;
    const b = document.querySelector(
      `.playbtn[data-key="${attr(currentJob)}"][data-name="${attr(currentToken.slice(currentJob.length + 1))}"]`);
    if (b) b.classList.add('on');
  }

  function loadPreview(jobId, token, url, label, peak) {
    killRamp();
    const same = currentToken === token;
    currentToken = token;
    currentJob = jobId;
    currentPeak = peak || 0;
    $('nowPlaying').textContent = label;
    const norm = currentPeak / FS;
    $('peakBar').style.width = Math.min(100, norm * 100).toFixed(1) + '%';
    $('peakDb').textContent = currentPeak ? (norm >= 0.98 ? '! ' : '') + dbOf(norm) + ' dBFS' : 'n/a';
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
  function decodeOne(file, family, mic) {
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

  function status(el, msg, kind) {
    el.textContent = msg || '';
    el.className = 'status' + (msg ? ' show' : '') + (kind ? ' ' + kind : '');
  }

  /* ── job queue ───────────────────────────────────────────────────────── */
  let jobs = [];
  let root = '';                 // folder the user picked, stripped from paths
  let nextId = 1;
  let batchCancel = false;
  let selected = null;           // job id shown in the results table
  let zipUrl = null;             // blob URL of the current download

  // A job is {id, file, rel, sourceDir, family, mic, state, ui, result}
  function makeJob(file, fromFolder) {
    const rel = (fromFolder && file.webkitRelativePath) ? file.webkitRelativePath : file.name;
    const info = TCINaming.describe(rel);
    return {
      id: String(nextId++),
      file,
      rel,
      root,                     // remembered, so a later selection cannot move it
      sourceDir: info.dir,
      family: info.family,
      mic: info.mic,
      state: 'queued',
      ui: null,
      result: null,
    };
  }

  // Output directory for a job. Files with no folder of their own land flat in
  // the ZIP root, which keeps a single-file download tidy.
  function outDir(job) {
    const info = TCINaming.describe(job.rel);
    info.family = job.family;
    info.mic = job.mic;
    if (!job.sourceDir) return '';
    return TCINaming.targetDir(info, job.root);
  }

  function addFiles(list, fromFolder) {
    const files = [...list].filter((f) => /\.tci$/i.test(f.name));
    if (!files.length) { status($('st'), 'No .tci files in that selection.', 'err'); return; }
    root = fromFolder && files[0].webkitRelativePath
      ? files[0].webkitRelativePath.split('/')[0] : '';
    jobs = jobs.concat(files.map((f) => makeJob(f, fromFolder)));
    renderJobs();
    const bytes = files.reduce((a, f) => a + f.size, 0);
    $('pickChip').textContent = `${jobs.length} .tci · ${human(bytes)}`;
    $('clear').hidden = false;
    status($('st'), bytes > WARN_BYTES
      ? `${human(bytes)} selected. A full run takes a while; the page stays usable.`
      : 'Ready. Convert to run.', bytes > WARN_BYTES ? '' : 'ok');
  }

  $('files').addEventListener('change', (e) => { addFiles(e.target.files, false); });
  $('folder').addEventListener('change', (e) => { addFiles(e.target.files, true); });

  $('clear').onclick = () => {
    stopAll();
    for (const rec of auditions.values()) for (const u of rec.urls.values()) URL.revokeObjectURL(u);
    auditions.clear();
    jobs = [];
    selected = null;
    renderJobs();
    $('pickChip').textContent = '';
    $('clear').hidden = true;
    $('jobWrap').hidden = true;
    $('resWrap').hidden = true;
    $('resRows').textContent = '';
    $('mapview').textContent = '';
    $('dl').hidden = true;
    if (zipUrl) { URL.revokeObjectURL(zipUrl); zipUrl = null; }
    $('checkAll').checked = false;
    status($('st'), '');
  };

  $('rederive').onclick = () => {
    for (const j of jobs) {
      const info = TCINaming.describe(j.rel);
      j.family = info.family;
      j.mic = info.mic;
      if (j.ui) { j.ui.family.value = j.family; j.ui.mic.value = j.mic; }
    }
    markDuplicates();
    status($('st'), 'Names re-derived from paths.', 'ok');
  };

  $('checkAll').onchange = (e) => {
    for (const j of jobs) if (j.ui) { j.ui.check.checked = e.target.checked; syncRemoveBtn(); }
  };
  function syncRemoveBtn() {
    $('removeSel').hidden = !jobs.some((j) => j.ui && j.ui.check.checked);
  }
  $('removeSel').onclick = () => {
    const dropped = jobs.filter((j) => j.ui && j.ui.check.checked);
    for (const j of dropped) j.ui.tr.remove();
    jobs = jobs.filter((j) => !dropped.includes(j));
    $('checkAll').checked = false;
    syncRemoveBtn();
    $('pickChip').textContent = jobs.length ? `${jobs.length} .tci` : '';
    $('clear').hidden = !jobs.length;
    if (!jobs.length) $('jobWrap').hidden = true;
  };

  // Two jobs writing the same output path would overwrite each other in the
  // ZIP, which is silent and confusing, so flag it.
  function markDuplicates() {
    const seen = new Map();
    for (const j of jobs) {
      const key = outDir(j) + '|' + j.family + '|' + j.mic;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    for (const j of jobs) {
      const key = outDir(j) + '|' + j.family + '|' + j.mic;
      const dup = seen.get(key) > 1;
      if (j.ui) j.ui.tr.classList.toggle('dup', dup);
      if (j.ui) j.ui.warn.textContent = dup ? 'duplicate output path' : '';
    }
  }

  function renderJobs() {
    const tbody = $('jobRows');
    if (!jobs.length) { $('jobWrap').hidden = true; return; }
    $('jobWrap').hidden = false;
    const keep = new Set(jobs.map((j) => j.id));
    for (const tr of [...tbody.children]) {
      if (!keep.has(tr.dataset.job)) tr.remove();
    }
    for (const j of jobs) {
      if (j.ui) { updateJobRow(j); continue; }
      const tr = document.createElement('tr');
      tr.dataset.job = j.id;
      tr.innerHTML =
        `<td><input type="checkbox" aria-label="Select ${esc(j.file.name)}"></td>` +
        `<td><code>${esc(j.file.name)}</code><br><span class="outpath">${esc(j.rel)}</span></td>` +
        `<td><input type="text" class="tblin" aria-label="Sample family"></td>` +
        `<td><input type="text" class="tblin" aria-label="MIC type"></td>` +
        `<td><span class="outpath"></span><br><span class="warn"></span></td>` +
        `<td class="num"></td><td class="num"></td>` +
        `<td style="color:var(--muted)">queued</td>` +
        `<td><button class="minibtn playbtn" hidden title="Show and audition">▶</button></td>`;
      tbody.appendChild(tr);
      const cells = tr.children;
      const family = cells[2].querySelector('input');
      const mic = cells[3].querySelector('input');
      const check = cells[0].querySelector('input');
      const play = cells[8].querySelector('button');
      family.value = j.family;
      mic.value = j.mic;
      // The path reacts while typing; the box itself is only tidied on blur so
      // the caret is not fought mid-keystroke.
      family.addEventListener('input', () => {
        j.family = TCINaming.clean(family.value, 'Sample');
        updateJobRow(j);
        markDuplicates();
      });
      mic.addEventListener('input', () => {
        j.mic = TCINaming.clean(mic.value, 'MIC').toUpperCase();
        updateJobRow(j);
        markDuplicates();
      });
      family.addEventListener('change', () => { family.value = j.family; });
      mic.addEventListener('change', () => { mic.value = j.mic; });
      check.addEventListener('change', syncRemoveBtn);
      play.onclick = () => showJob(j, true);
      tr.addEventListener('click', (e) => {
        if (e.target.closest('input,button')) return;
        selectRow(j);
      });
      j.ui = {
        tr, family, mic, check, play,
        out: cells[4].querySelector('.outpath'),
        warn: cells[4].querySelector('.warn'),
        waves: cells[5], stereo: cells[6], state: cells[7],
      };
    }
    for (const j of jobs) updateJobRow(j);
    markDuplicates();
    syncRemoveBtn();
  }

  function updateJobRow(j) {
    if (!j.ui) return;
    const d = outDir(j);
    j.ui.out.textContent = d ? d + '/' : '(zip root)';
    j.ui.waves.textContent = j.result ? j.result.count : '';
    j.ui.stereo.textContent = j.result ? j.result.stereo : '';
    j.ui.state.textContent = j.state;
    j.ui.state.style.color = j.state === 'done' ? 'var(--accent-2)'
      : j.state === 'failed' ? 'var(--danger)' : 'var(--muted)';
    j.ui.play.hidden = !j.result;
    const playable = !!j.result && auditions.has(j.id);
    j.ui.play.disabled = !playable;
    j.ui.play.title = !j.result ? 'Show and audition'
      : playable ? 'Show and audition'
        : 'Audio was released to save memory. Convert this file again to audition it.';
  }

  function selectRow(j) {
    selected = j.id;
    for (const x of jobs) if (x.ui) x.ui.tr.classList.toggle('sel', x === j);
  }

  /* ── auditions ───────────────────────────────────────────────────────── */
  const auditions = new Map();

  // Each converted job keeps its own blob URLs so any of them can be auditioned
  // afterwards. Only the entry being replaced is revoked here; older jobs are
  // dropped by the PREVIEW_KEEP window below, otherwise a folder run would hold
  // every decoded instrument in memory.
  function registerAuditions(jobId, files) {
    const prev = auditions.get(jobId);
    if (prev) for (const u of prev.urls.values()) URL.revokeObjectURL(u);
    const urls = new Map();
    for (const f of files) {
      if (f.name) urls.set(f.name, URL.createObjectURL(new Blob([f.wav], { type: 'audio/wav' })));
    }
    auditions.delete(jobId);
    auditions.set(jobId, { urls, rows: files });   // re-insert keeps Map order = recency
    while (auditions.size > PREVIEW_KEEP) {
      const oldest = auditions.keys().next().value;
      if (oldest === jobId) break;
      const rec = auditions.get(oldest);
      for (const u of rec.urls.values()) URL.revokeObjectURL(u);
      auditions.delete(oldest);
      if (currentJob === oldest) { stopAll(); currentJob = null; }
    }
    for (const j of jobs) updateJobRow(j);
  }

  function showJob(j, playFirst) {
    if (!j.result) return;
    selectRow(j);
    const haveAudio = auditions.has(j.id);
    const host = $('resRows');
    host.textContent = '';
    for (const f of j.result.files) {
      const tr = document.createElement('tr');
      const playable = !!f.name;
      tr.innerHTML =
        `<td>${playable ? `<button class="playbtn"${haveAudio ? '' : ' disabled title="Audio was released; convert this file again"'} data-key="${attr(j.id)}" data-name="${attr(f.name)}">▶ play</button>` : ''}</td>` +
        `<td><code>${esc(f.name || 'skipped')}</code></td>` +
        `<td><span class="chip ${f.channels === 2 ? 'st' : ''}">${f.channels === 2 ? 'stereo' : 'mono'}</span></td>` +
        `<td class="num">${esc(f.wave)}</td>` +
        `<td><span class="grade g-${esc(f.grade)}">${esc(f.grade)}</span></td>` +
        `<td class="num">${f.peak == null ? '' : f.peak}</td>` +
        `<td style="color:var(--muted)">${esc(f.note)}</td>`;
      const btn = tr.querySelector('.playbtn');
      if (btn) btn.onclick = () => playWave(j.id, btn);
      host.appendChild(tr);
    }
    $('resWrap').hidden = false;
    $('mapview').textContent = j.result.map;
    $('mapDetails').open = true;
    const first = host.querySelector('.playbtn');
    if (playFirst && first) first.click();
  }

  function playWave(jobId, btn) {
    const rec = auditions.get(jobId);
    if (!rec) return;
    const name = btn.dataset.name;
    const url = rec.urls.get(name);
    const f = rec.rows.find((r) => r.name === name);
    if (!url || !f) return;
    const token = jobId + SEP + name;
    if (currentToken === token && !player.paused) { stopAll(); return; }
    loadPreview(jobId, token, url, name, f.peak);
    for (const b of document.querySelectorAll('.playbtn')) b.classList.remove('on');
    btn.classList.add('on');
    player.play().catch(() => { /* autoplay policy */ });
    rampIn();
  }

  /* ── convert ─────────────────────────────────────────────────────────── */
  $('cancel').onclick = () => { batchCancel = true; };

  $('go').onclick = async () => {
    if (!jobs.length) { status($('st'), 'Add a .tci file or folder first.', 'err'); return; }
    batchCancel = false;
    const go = $('go'), cancel = $('cancel'), dl = $('dl');
    go.disabled = true;
    cancel.hidden = false;
    dl.hidden = true;
    $('bar').hidden = false;
    $('resWrap').hidden = true;
    $('resRows').textContent = '';
    $('mapview').textContent = '';
    stopAll();

    if (zipUrl) { URL.revokeObjectURL(zipUrl); zipUrl = null; }   // free the last ZIP
    const zip = new TCIZip.ZipWriter();
    const map = [];
    const seenDirs = new Set();
    let done = 0, waves = 0, stereo = 0, failed = 0;
    const t0 = performance.now();
    const bar = $('bar').querySelector('i');

    for (const j of jobs) {
      j.state = 'queued';
      j.result = null;
      updateJobRow(j);
    }

    const queue = jobs.slice();
    const runNext = async () => {
      while (queue.length && !batchCancel) {
        const job = queue.shift();
        job.state = 'decoding';
        updateJobRow(job);
        try {
          const r = await decodeOne(job.file, job.family, job.mic);
          const dir = outDir(job);
          const relDir = dir ? dir + '/' : '';
          if (!seenDirs.has(relDir)) {
            seenDirs.add(relDir);
            await zip.addText(relDir + 'README.txt',
              `tci2wav export\nsource: ${job.rel}\nfamily: ${job.family}  mic: ${job.mic}\n` +
              `# ${r.summary}\n`);
          }
          const count = r.files.filter((f) => f.name).length;
          const st = r.files.filter((f) => f.channels === 2 && f.name).length;
          map.push(`# ${job.rel} :: ${r.summary}`);
          for (const f of r.files) {
            if (!f.name) { map.push(`-- ${relDir}${f.wave} [${f.grade}] ${f.note}`); continue; }
            await zip.add(relDir + f.name, new Uint8Array(f.wav));
            waves++;
            if (f.channels === 2) stereo++;
            map.push(`${relDir}${f.name} <- ${f.wave} [${f.grade}] ` +
              `${f.channels === 2 ? 'st' : 'mono'} peak=${f.peak} ${f.note}`);
          }
          registerAuditions(job.id, r.files);
          job.result = { files: r.files, map: map.join('\n') + '\n', count, stereo: st };
          job.state = 'done';
          if (!selected) showJob(job, false);
        } catch (err) {
          failed++;
          job.state = 'failed: ' + err.message;
        }
        updateJobRow(job);
        markDuplicates();
        done++;
        bar.style.width = ((done / jobs.length) * 100).toFixed(1) + '%';
        const secs = (performance.now() - t0) / 1000;
        const eta = done ? (secs / done) * (jobs.length - done) : 0;
        status($('st'),
          `${batchCancel ? 'Cancelled' : 'Converting'} ${done}/${jobs.length} · ${waves} WAVs` +
          `${stereo ? ` · ${stereo} stereo` : ''}${failed ? ` · ${failed} failed` : ''}` +
          (done < jobs.length
            ? ` · ${eta < 60 ? Math.ceil(eta) + 's' : Math.ceil(eta / 60) + 'm'} left`
            : ''));
      }
    };
    await Promise.all([runNext(), runNext()]);

    if (done < jobs.length) {
      status($('st'), `Cancelled after ${done}/${jobs.length}. Nothing downloaded.`, 'err');
    } else {
      await zip.addText('MAP.txt', map.join('\n') + '\n');
      zipUrl = URL.createObjectURL(zip.finish());
      dl.href = zipUrl;
      dl.download = jobs.length === 1
        ? `${jobs[0].family}_${jobs[0].mic}.zip`
        : `${root || 'tci2wav'}_batch.zip`;
      dl.hidden = false;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      status($('st'),
        `${jobs.length} file${jobs.length > 1 ? 's' : ''} → ${waves} WAVs` +
        `${stereo ? ` (${stereo} stereo)` : ''}${failed ? `, ${failed} failed` : ''} · ` +
        `${human(zip.bytes)} · ${secs}s`, failed ? '' : 'ok');
    }
    $('bar').hidden = true;
    go.disabled = false;
    cancel.hidden = true;
  };
})();