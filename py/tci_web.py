"""TCI web exporter: upload a mono .tci (V1 or V2), download velocity-named WAVs.

Runs on stdlib only (+ numpy, already required by the toolkit):
    python3 tci_web.py [port]      # default 8765 -> http://localhost:8765

- POST /api/export  multipart: file=<.tci>, family, mic (optional;
  guessed from filename like "ACKick Z3.tci")
  -> JSON {ok, files:[{name, wave, grade, peak, note}], map, download}
- GET  /api/download?token=...     -> zip of WAVs + MAP.txt
- GET  /                           -> upload UI

Mono waves are decoded with render_library.solve_wave (raw200 / multi
identity-blocks / single fits / tailN). Stereo waves are SKIPPED
(their heads use an unsolved table path) and listed as such.
Naming: FAMILY_MIC_V##_RR#.wav (attack-peak velocity rank, round robins
grouped at peak ratio < 1.12). See WRITEUP.md.
"""

import io
import json
import os
import re
import sys
import tempfile
import threading
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tci_decode import apply_voice_rule, decode_wave, export_wav  # noqa: E402
from tci_export import (RR_RATIO, ATK_N, attack_peak, export_stereo,  # noqa: E402
                        parse_v1, parse_v2)
from render_library import solve_wave  # noqa: E402

STORE = {}
STORE_LOCK = threading.Lock()

UI = """<!doctype html><html><head><meta charset="utf-8">
<title>TCI Exporter</title>
<style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#222}
h1{font-size:24px} .card{border:1px solid #ddd;border-radius:10px;padding:20px;margin:16px 0}
label{display:block;margin:10px 0 4px;font-weight:600}
input[type=text]{width:100%;padding:8px;font-size:15px}
button{padding:10px 22px;font-size:15px;margin-top:14px;cursor:pointer}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:12px}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
th{background:#f5f5f5} .grade{display:inline-block;min-width:22px;text-align:center;
font-weight:700;border-radius:4px;padding:1px 6px}
.A{background:#d9f2dd}.B{background:#fff3c4}.C{background:#ffe0cc}.X{background:#f3c1c1}
#status{margin-top:12px;color:#555} #dl{margin-top:12px;display:none}
code{background:#f4f4f4;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>TCI Exporter <small style="font-weight:400;color:#666">mono V1/V2 &rarr; velocity WAVs</small></h1>
<div class="card">
<label>TCI file (.tci)</label>
<input type="file" id="file" accept=".tci">
<label>Sample family (e.g. ACKick)</label>
<input type="text" id="family" placeholder="guessed from filename">
<label>Mic type (e.g. Z3)</label>
<input type="text" id="mic" placeholder="guessed from filename">
<br><button onclick="go()">Export</button>
<div id="status"></div>
<div id="dl"><a id="dllink" href="#"><button>Download ZIP</button></a></div>
<div id="res"></div>
</div>
<div class="card" style="font-size:13px;color:#555">
Naming: <code>FAMILY_MIC_V##_RR#.wav</code> (V = velocity by attack-peak,
RR = round robin). Grades: <span class="grade A">A</span> exact+smooth
<span class="grade B">B</span> close <span class="grade C">C</span> verify by ear
<span class="grade X">X</span> skipped (stereo heads use an unsolved table path).
</div>
<script>
function guess(){
  const f=document.getElementById('file').files[0]; if(!f) return;
  const base=f.name.replace(/\\.tci$/i,'');
  const parts=base.split(/\\s+/);
  if(parts.length>1 && !document.getElementById('mic').value)
    document.getElementById('mic').value=parts[parts.length-1].toUpperCase();
  if(!document.getElementById('family').value)
    document.getElementById('family').value=parts.slice(0,-1).join('').replace(/\\s+/g,'')||base.replace(/\\s+/g,'');
}
document.getElementById('file').addEventListener('change',guess);
async function go(){
  const f=document.getElementById('file').files[0];
  if(!f){document.getElementById('status').textContent='Pick a .tci file first.';return;}
  guess();
  document.getElementById('status').textContent='Decoding… (large files take ~1 min)';
  document.getElementById('res').innerHTML=''; document.getElementById('dl').style.display='none';
  const fd=new FormData();
  fd.append('file',f); fd.append('family',document.getElementById('family').value);
  fd.append('mic',document.getElementById('mic').value);
  const r=await fetch('/api/export',{method:'POST',body:fd});
  const j=await r.json();
  if(!j.ok){document.getElementById('status').textContent='Error: '+j.error;return;}
  document.getElementById('status').textContent=j.summary;
  document.getElementById('dllink').href='/api/download?token='+j.token;
  document.getElementById('dl').style.display='block';
  let h='<table><tr><th>File</th><th>Wave</th><th>Grade</th><th>Peak</th><th>Parse</th></tr>';
  for(const w of j.files)
    h+=`<tr><td><code>${w.name||'—'}</code></td><td>${w.wave}</td><td><span class="grade ${w.grade}">${w.grade}</span></td><td>${w.peak||''}</td><td>${w.note}</td></tr>`;
  document.getElementById('res').innerHTML=h+'</table><p style="color:#666;font-size:13px">Full parse notes ship as MAP.txt inside the ZIP.</p>';
}
</script></body></html>
"""


def parse_multipart(body, content_type):
    """Minimal multipart/form-data parser (stdlib only).
    Returns ({field: str}, {field: (filename, bytes)})."""
    m = re.search(r'boundary=([^;]+)', content_type or '')
    if not m:
        raise ValueError('not multipart')
    bd = b'--' + m.group(1).strip().strip('"').encode()
    fields, files = {}, {}
    for part in body.split(bd):
        if not part or part in (b'--', b'--\r\n'):
            continue
        if b'\r\n\r\n' not in part:
            continue
        head, payload = part.split(b'\r\n\r\n', 1)
        if payload.endswith(b'\r\n'):
            payload = payload[:-2]
        h = head.decode('latin-1')
        nm = re.search(r'name="([^"]+)"', h)
        fn = re.search(r'filename="([^"]*)"', h)
        if not nm:
            continue
        if fn and fn.group(1):
            files[nm.group(1)] = (fn.group(1), payload)
        else:
            fields[nm.group(1)] = payload.decode('utf-8', 'replace')
    return fields, files


def decode_upload(data, family, mic):
    waves = parse_v2_bytes(data)
    if waves is None:
        waves = parse_v1_bytes(data)
        if waves is None:
            return None, 'unrecognized file (not V1 or V2 TCI)'
    items = []
    for i, wv in enumerate(waves):
        try:
            if str(wv['stereo']).startswith('1'):
                items.append((0, i, 'skip', None, 'X',
                              'stereo skipped (heads use unsolved table path)'))
                continue
            if 'v1' in wv:
                v = apply_voice_rule(wv['v1'], wv['frames'])
                items.append((attack_peak(v), i, 'mono', v, 'A', 'V1 single'))
                continue
            spec, g, note = solve_wave(wv['blob'], wv['frames'])
            if spec is None:
                items.append((0, i, 'skip', None, g, note))
                continue
            v = apply_voice_rule(decode_wave(wv['blob'], wv['frames'], spec),
                                 wv['frames'])
            items.append((attack_peak(v), i, 'mono', v, g, note))
        except Exception as e:  # never fail the batch
            items.append((0, i, 'skip', None, 'X', f'crash: {e}'))
    ranked = sorted([it for it in items if it[2] != 'skip'], key=lambda x: x[0])
    groups, cur = [], []
    for it in ranked:
        if cur and it[0] / max(max(x[0] for x in cur), 1e-9) >= RR_RATIO:
            groups.append(cur)
            cur = []
        cur.append(it)
    if cur:
        groups.append(cur)
    tmp = tempfile.mkdtemp(prefix='tci_')
    files = []
    for vi, grp in enumerate(groups, 1):
        for ri, it in enumerate(sorted(grp, key=lambda x: x[0]), 1):
            _pk, i, kind, payload, g, note = it
            fn = f'{family}_{mic}_V{vi:02d}_RR{ri}.wav'
            export_wav(f'{tmp}/{fn}', payload)
            files.append({'name': fn, 'wave': f'wave{i:02d}', 'grade': g,
                          'peak': int(np.abs(np.asarray(payload, float)).max()),
                          'note': note})
    skipped = [{'name': None, 'wave': f'wave{i:02d}', 'grade': g, 'peak': None,
                'note': n} for _p, i, k, _pl, g, n in items if k == 'skip']
    lines = [f"{f['name']} <- {f['wave']} [{f['grade']}] peak={f['peak']} {f['note']}"
             for f in files]
    lines += [f"-- {s['wave']} [{s['grade']}] {s['note']}" for s in skipped]
    with open(f'{tmp}/MAP.txt', 'w') as fh:
        fh.write('\n'.join(lines) + '\n')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for fn in os.listdir(tmp):
            z.write(f'{tmp}/{fn}', fn)
    return {'zip': buf.getvalue(), 'files': files + skipped,
            'summary': f'{len(files)} WAVs + MAP.txt ({len(skipped)} skipped)',
            'map': '\n'.join(lines)}, None


def parse_v2_bytes(data):
    import math
    import struct
    import zlib
    import re
    try:
        audio_len, _, _ = struct.unpack('<III', data[64:76])
        blob = data[76:76 + audio_len]
        dec = zlib.decompress(data[76 + audio_len:][8:])
    except Exception:
        return None
    if dec[:4] != b'VC2!':
        return None
    try:
        xml = dec[8:].decode()
    except UnicodeDecodeError:
        xml = dec[8:].decode('latin-1')
    m = re.search(r'<trigger_instrument([^>]+)>', xml)
    if not m:
        return None
    attrs = dict(re.findall(r'(\S+)="([^"]*)"', m.group(1)))
    waves, off = [], 0
    try:
        for i in range(int(attrs['data_count'])):
            comp = int(attrs[f'wd{i}comp1'])
            fr = int(attrs[f'wd{i}frames'])
            nb = math.ceil(comp / 8)
            waves.append({'comp': comp, 'frames': fr,
                          'stereo': attrs.get(f'wd{i}stereo', '?'),
                          'blob': blob[off:off + nb]})
            off += nb
    except (KeyError, ValueError):
        return None
    return waves


def parse_v1_bytes(data):
    import struct
    if not data or data[0] != 0x01:
        return None
    for endian in ('>', '<'):
        try:
            comp, fr = struct.unpack(endian + 'II', data[1:9])
        except Exception:
            continue
        if not 0 < comp <= 8 * (len(data) - 9):
            continue
        if not 0 < fr < 10 ** 7:
            continue
        bits = ''.join(f'{b:08b}' for b in data[9:])[:comp]
        pos, out, ok = 0, [], True
        while len(out) < fr - 1:
            if pos + 8 > len(bits):
                ok = False
                break
            k = int(bits[pos:pos + 8], 2)
            if not 1 <= k <= 24:
                ok = False
                break
            pos += 8
            n = min(201, fr - 1 - len(out))
            if pos + n * k > len(bits):
                ok = False
                break
            for i in range(n):
                ch = bits[pos:pos + k]
                pos += k
                v = int(ch, 2)
                out.append(v - (1 << k) if ch[0] == '1' else v)
        if ok and pos == comp and len(out) == fr - 1:
            return [{'comp': comp, 'frames': fr, 'stereo': '0-x',
                      'v1': np.array(out, float)}]
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = 'TCIExport/1.0'

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='text/html'):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/':
            return self._send(200, UI)
        if u.path == '/api/download':
            tok = parse_qs(u.query).get('token', [None])[0]
            with STORE_LOCK:
                ent = STORE.pop(tok, None) if tok else None
            if ent is None:
                return self._send(404, 'expired or bad token', 'text/plain')
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Disposition',
                             f'attachment; filename="{ent["name"]}.zip"')
            self.send_header('Content-Length', str(len(ent['zip'])))
            self.end_headers()
            return self.wfile.write(ent['zip'])
        return self._send(404, 'nope', 'text/plain')

    def do_POST(self):
        if urlparse(self.path).path != '/api/export':
            return self._send(404, 'nope', 'text/plain')
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            fields, files = parse_multipart(body,
                                            self.headers.get('Content-Type'))
        except Exception as e:
            return self._send(400, json.dumps({'ok': False, 'error': str(e)}),
                              'application/json')
        if 'file' not in files:
            return self._send(400, json.dumps({'ok': False,
                                               'error': 'no file field'}),
                              'application/json')
        fname_in, data = files['file']
        if len(data) > 200 * 1024 * 1024:
            return self._send(400, json.dumps({'ok': False,
                                               'error': 'file too big'}),
                              'application/json')
        fname = os.path.basename(fname_in or 'upload.tci')
        base = re.sub(r'\.tci$', '', fname, flags=re.I)
        parts = base.split()
        family = (fields.get('family') or '').strip()
        mic = (fields.get('mic') or '').strip().upper()
        if not mic and len(parts) > 1:
            mic = parts[-1].upper()
        if not family:
            family = ''.join(parts[:-1]).replace(' ', '') if len(parts) > 1 \
                else base.replace(' ', '')
        family = re.sub(r'[^A-Za-z0-9]+', '', family) or 'Sample'
        mic = re.sub(r'[^A-Za-z0-9]+', '', mic) or 'MIC'
        res, err = decode_upload(data, family, mic)
        if err:
            return self._send(200, json.dumps({'ok': False, 'error': err}),
                              'application/json')
        tok = uuid.uuid4().hex
        with STORE_LOCK:
            STORE[tok] = {'zip': res['zip'], 'name': f'{family}_{mic}'}
        return self._send(200, json.dumps({
            'ok': True, 'token': tok, 'files': res['files'],
            'summary': res['summary'], 'map': res['map']}), 'application/json')


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'TCI exporter at http://localhost:{port}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
