/* Regression tests for the app's UI glue, using a small DOM stub.

   The bug these guard against: preview in batch mode only worked for the most
   recently converted file, because registering a new job revoked every other
   job's blob URLs. That is invisible to the decoder tests, so it needs the
   real app.js running against real Blob/URL objects. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

// The page loads these as plain scripts; app.js picks up TCINaming and TCIZip
// from the global scope, so the harness has to do the same, in order.
const SCRIPTS = ['zip.js', 'naming.js', 'app.js']
  .map((f) => [f, readFileSync(path.join(__dirname, '..', f), 'utf8')]);

/* ── tiny DOM ───────────────────────────────────────────────────────── */
function makeEl(id, tag) {
  const el = {
    id,
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    files: [],
    attrs: {},
    value: '',
    valueAsNumber: NaN,
    hidden: false,
    open: false,
    listeners: {},
    _text: '',
    _html: '',
    className: '',
    classList: {
      s: new Set(),
      add(c) { this.s.add(c); },
      remove(c) { this.s.delete(c); },
      toggle(c, on) { if (on) this.s.add(c); else this.s.delete(c); },
      contains(c) { return this.s.has(c); },
    },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text; },
    // Enough HTML to satisfy the two innerHTML builders in app.js: table rows
    // split into cells, and cells answering querySelector for their controls.
    set innerHTML(v) {
      this._html = String(v);
      this.children = [];
      for (const m of String(v).matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/g)) {
        const cell = makeEl('', /^<t[dh]/.test(m[0]) ? 'td' : 'th');
        cell._html = m[2];
        this.children.push(cell);
      }
    },
    get innerHTML() { return this._html; },
    querySelector(sel) {
      const cls = /^\.([\w-]+)$/.exec(sel);
      const html = this._html || '';
      if (cls) return html.includes(`class="${cls[1]}`) || html.includes(` ${cls[1]}`)
        ? makeEl('', 'div') : null;
      if (/^[a-z]+$/.test(sel)) {
        const kid = this.children.find((c) => c.tagName === sel.toUpperCase());
        if (kid) return kid;
        return html.includes('<' + sel) ? makeEl('', sel) : null;
      }
      return null;
    },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    removeAttribute(k) { delete this.attrs[k]; },
    removeEventListener() {},
    dispatch(t, ev) { for (const fn of this.listeners[t] || []) fn({ target: this, ...(ev || {}) }); },
    closest() { return null; },
    getElementsByTagName() { return []; },
    load() {},
    play() { return Promise.resolve(); },
    pause() {},
    focus() {},
  };
  return el;
}

// Enough of a DOM for app.js to boot and run a conversion end to end.
function makeEnv({ onWorker }) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const e = makeEl(id, id === 'player' ? 'audio' : 'div');
      if (id === 'bar') e.children.push(makeEl('', 'i'));   // <div id="bar"><i></i></div>
      els.set(id, e);
    }
    return els.get(id);
  };
  const doc = {
    documentElement: { dataset: {} },
    getElementById: el,
    createElement: (t) => makeEl('', t),
    addEventListener() {},
    querySelectorAll: () => [],
  };
  class FakeBlob {
    constructor(parts) { this.parts = parts; this.size = 1; }
  }
  const live = new Map();
  let nextUrl = 0;
  const env = {
    console,
    document: doc,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {} },
    TextDecoder,
    TextEncoder,
    Blob: FakeBlob,
    Worker: class {
      constructor() { this.onmessage = null; this.onerror = null; env.worker = this; }
      postMessage(msg, transfer) { onWorker(msg, this); }
    },
    FileReader: class {
      readAsArrayBuffer(file) { this.result = file.buffer; queueMicrotask(() => this.onload()); }
    },
    URL: {
      createObjectURL(blob) { const u = 'blob:' + (nextUrl++); live.set(u, blob); return u; },
      revokeObjectURL(u) { live.delete(u); },
    },
    // captured for assertions
    _live: live,
    _els: els,
  };
  env.window = env;
  env.self = env;
  env.globalThis = env;
  return env;
}

const GLOBALS = ['self', 'window', 'globalThis', 'document', 'Worker', 'FileReader',
  'Blob', 'URL', 'TextEncoder', 'TextDecoder', 'localStorage', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'console'];

function bootApp(env) {
  const run = (src, name, extra) => {
    const names = [...GLOBALS, ...Object.keys(extra || {})];
    const vals = GLOBALS.map((g) => env[g]).concat(Object.values(extra || {}));
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, src + '\n//# sourceURL=' + name);
    fn(...vals);
  };
  // zip.js and naming.js publish themselves as globals on `self`, which in a
  // browser is the real global object. Here `self` is just the sandbox, so
  // their results are handed to app.js as explicit arguments.
  for (const [name, src] of SCRIPTS) {
    if (name === 'app.js') run(src, name, { TCINaming: env.TCINaming, TCIZip: env.TCIZip });
    else run(src, name);
  }
  return env;
}

// A decoded result shaped like worker.js sends it.
function workerReply(msg) {
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
  return {
    id: msg.id,
    ok: true,
    summary: '1 WAVs + MAP.txt (0 skipped, 1 stereo)',
    files: [
      { name: `${msg.family}_${msg.mic}_V01_RR1.wav`, wave: 'wave00', channels: 2,
        grade: 'B', peak: 1234, note: 'stereo test', wav: wav.buffer },
    ],
    map: 'map\n',
  };
}

function fakeFile(name, bytes) {
  return { name, size: bytes, webkitRelativePath: '', buffer: new ArrayBuffer(bytes) };
}

async function convert(env, files) {
  const input = env._els.get('files');
  input.files = files;
  input.dispatch('change');
  await env._els.get('go').onclick();
}

test('batch preview: every converted job keeps playable audio', async () => {
  const env = makeEnv({ onWorker: (msg, w) => queueMicrotask(() => w.onmessage({ data: workerReply(msg) })) });
  bootApp(env);
  await convert(env, [fakeFile('A.tci', 8), fakeFile('B.tci', 8), fakeFile('C.tci', 8)]);

  // One blob URL per converted job, plus one for the download ZIP. The bug
  // this guards against left only the most recently converted job audible, so
  // the count here was 2 (one audition + the zip) instead of 4.
  assert.equal(env._live.size, 4, `expected 4 live blob URLs, got ${env._live.size}`);
});

test('batch preview: re-converting one job does not break the others', async () => {
  let passes = 0;
  const env = makeEnv({
    onWorker: (msg, w) => queueMicrotask(() => { passes++; w.onmessage({ data: workerReply(msg) }); }),
  });
  bootApp(env);
  await convert(env, [fakeFile('A.tci', 8), fakeFile('B.tci', 8)]);
  assert.equal(env._live.size, 3, 'two auditions plus the zip');

  // converting the queue again replaces both entries and the old ZIP blob
  await env._els.get('go').onclick();
  assert.equal(passes, 4);
  assert.equal(env._live.size, 3,
    'replaced auditions and the previous ZIP blob must be released');
});

test('batch preview: audio older than the keep window is released', async () => {
  const env = makeEnv({ onWorker: (msg, w) => queueMicrotask(() => w.onmessage({ data: workerReply(msg) })) });
  bootApp(env);
  // PREVIEW_KEEP is 6, so 8 jobs leaves the first two evicted
  await convert(env, Array.from({ length: 8 }, (_, i) => fakeFile(`F${i}.tci`, 8)));
  assert.equal(env._live.size, 7, 'six most recent auditions plus the ZIP blob');
});