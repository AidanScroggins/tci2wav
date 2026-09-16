"""Unified Trigger 2 TCI exporter: V1 + V2, mono + stereo.

Naming: SAMPLEFAMILY_MIC_V##_RR#.wav  (V = velocity level ascending by
attack-peak, RR = round robin within equal-level groups).
  e.g. ACKick_Z3_V01_RR1.wav  (lowest velocity, first round robin)

Output tree: <OUT>/<Category>/<Instrument>/<MIC>/<names>.wav + MAP.txt
(velocity map: file <- wave index, peak, grade).

Detection per file: V2 (zlib footer + VC2! XML) else V1 ([01][comp][frames] single wave) else Editor (COMPRESSED INSTRUMENT tag, gap-chained V1 waves) else skipped.

Mono waves: structural auto-parse from render_library.solve_wave
(see WRITEUP.md): raw200 test, multi identity-chain prefixes,
single-block fits ranked by smoothness then known width byte then
smallest side. Grades A/B/C/X.

Stereo waves (stereo=1, samples = 2*frames): V1 201-block tail from the
earliest long run, L/R = even/odd SAMPLES of the joint stream
(ear-verified on SSDR; block-split and halves score ~0.1). Heads
(~165 samples) use a non-V1 table path: a single-block structural
attempt is made and smoothness-checked; unsolved waves are SKIPPED
(grade X) rather than shipped headless.

Velocity: attack-peak (peak over first 5000 samples) ascending. Groups:
adjacent levels with peak ratio < 1.12 share a velocity (round robins).
Documented assumption: validated on ACKick Z3 (matches DAW hit order
within +-2; peak clusters align exactly).

Usage: python3 tci_export.py [filter ...]   (same filters as render_library.py)
"""

import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tci_decode import apply_voice_rule, decode_wave, export_wav
from solve_wave import decode_span, run_scan, tail_count
from render_library import CATS, KMAP, LIB, parse_v2, smooth_score, solve_wave

OUT = f'{LIB}/TCI-Exports'
RR_RATIO = 1.12
ATK_N = 5000


def parse_v1(path):
    """Oracle-proven V1 single wave: [01][comp u32][frames u32] then
    [k:8][201 x k-bit] residuals (two's complement sign-extended)."""
    d = open(path, 'rb').read()
    if not d or d[0] != 0x01:
        return None
    for endian in ('>', '<'):
        try:
            comp, fr = struct.unpack(endian + 'II', d[1:9])
        except Exception:
            continue
        if not 0 < comp <= 8 * (len(d) - 9):
            continue
        if not 0 < fr < 10 ** 7:
            continue
        from tci_decode import bits_of
        bits = bits_of(d[9:])[:comp]
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


def parse_editor(path):
    """Trigger Instrument Editor variant ("COMPRESSED INSTRUMENT" tag):
    128-byte file header, then waves chained by 8-byte gap records
    [05][prev_wave_span_bytes LE] ... [06][0] + params footer to EOF.
    Each wave: [01][comp u32 LE][frames u32 LE][V1 two's-complement blocks].
    Proven bit-exact on a user-built 4-wave file (all waves consume comp
    exactly with frames-1 samples)."""
    from tci_decode import bits_of
    d = open(path, 'rb').read()
    if len(d) < 128 or d[:8] != b'TRIGGER ':
        return None
    if not d[8:64].startswith(b'COMPRESSED'):
        return None
    waves = []
    pos = 128
    for _ in range(256):
        if pos + 9 > len(d) or d[pos] != 0x01:
            break
        comp, fr = struct.unpack('<II', d[pos + 1:pos + 9])
        if not 0 < comp and 1 < fr < 10 ** 7:
            break
        base = pos + 9
        nbytes = (comp + 7) // 8
        if base + nbytes > len(d):
            break
        bstr = ''.join(f'{b:08b}' for b in d[base:base + nbytes])[:comp]
        p, out, ok = 0, [], True
        while len(out) < fr - 1:
            if p + 8 > comp:
                ok = False
                break
            k = int(bstr[p:p + 8], 2)
            if not 1 <= k <= 24:
                ok = False
                break
            p += 8
            n = min(201, fr - 1 - len(out))
            if p + n * k > comp:
                ok = False
                break
            for i in range(n):
                ch = bstr[p:p + k]
                p += k
                v = int(ch, 2)
                out.append(v - (1 << k) if ch[0] == '1' else v)
        if not ok or p != comp or len(out) != fr - 1:
            break
        waves.append({'comp': comp, 'frames': fr, 'stereo': '0-ed',
                      'v1': np.array(out, float)})
        pos += 9 + nbytes
        if pos + 8 > len(d):
            break
        if d[pos] == 0x06:
            break
        if d[pos] != 0x05:
            break
        pos += 8
    return waves or None


def solve_stereo(wblob, fr):
    """Sample-interleaved stereo joint stream. Returns
    (L, R, grade, note); heads attempted structurally, X if unsolved."""
    from tci_decode import bits_of
    bits = bits_of(bytes(wblob))
    Ts = sorted(set(p for _, p in run_scan(bits, hi=200000, min_run=50)))
    if not Ts:
        return None, None, 'X', 'no tail run'
    total = 2 * fr
    best = None
    for T in Ts[:6]:
        tl, endp = tail_count(bits, T)
        if endp < len(bits) - 16:
            continue
        for C in range(max(64, total - tl - 2), total - tl + 45):
            for k in range(15, 25):
                S = T - 8 - C * k
                if S < 0 or S > 3000:
                    continue
                sc = smooth_score(decode_span(bits, S + 8, k, C), k)
                if sc >= 0.15:
                    continue
                b = int(bits[S:S + 8], 2)
                key = ((b == k) or (KMAP.get(b) == k), S)
                if best is None or (not key[0], key[1]) < (not best[0], best[1]):
                    best = (key[0], S, C, k, T, b, sc)
    if best is None:
        return None, None, 'X', 'head unsolved (table path)'
    _bon, S, C, k, T, b, sc = best
    joint = decode_span(bits, S + 8, k, C)
    pos = T
    rest = []
    L = len(bits)
    while pos + 8 <= L:
        kk = int(bits[pos:pos + 8], 2)
        if not 1 <= kk <= 24:
            break
        pos += 8
        for i in range(201):
            if pos + kk > L:
                break
            ch = bits[pos:pos + kk]
            pos += kk
            v = int(ch[1:], 2) if kk > 1 else 0
            rest.append(-v if ch[0] == '1' else v)
    full = np.concatenate([joint, np.array(rest, float)])
    n = min(len(full) // 2, fr)
    # Never above C: no ground truth exists for stereo heads; even smooth
    # fits may be k=19-style ghosts. Ears decide.
    grade = 'C'
    return full[0:2 * n:2], full[1:2 * n:2], grade, \
        f'stereo C={C} k={k} S={S} T={T} byte={b} sm={sc:.2f}'


def attack_peak(vec):
    v = np.asarray(vec, float)[:ATK_N]
    return float(np.abs(v).max()) if len(v) else 0.0


def export_stereo(path, L, R):
    import wave
    n = min(len(L), len(R))
    iv = np.clip(np.asarray(L[:n], float), -2 ** 23, 2 ** 23 - 1).astype(np.int32)
    iu = (iv & ((1 << 24) - 1)).astype(np.int32)
    jv = np.clip(np.asarray(R[:n], float), -2 ** 23, 2 ** 23 - 1).astype(np.int32)
    ju = (jv & ((1 << 24) - 1)).astype(np.int32)
    pcm = np.zeros((n, 6), dtype=np.uint8)
    pcm[:, 0] = iu & 255
    pcm[:, 1] = (iu >> 8) & 255
    pcm[:, 2] = (iu >> 16) & 255
    pcm[:, 3] = ju & 255
    pcm[:, 4] = (ju >> 8) & 255
    pcm[:, 5] = (ju >> 16) & 255
    with wave.open(path, 'wb') as f:
        f.setnchannels(2)
        f.setsampwidth(3)
        f.setframerate(44100)
        f.writeframes(pcm.tobytes())


def export_tci(path, outdir, family, mic):
    waves = parse_v2(path)
    if waves is None:
        waves = parse_v1(path)
    if waves is None:
        waves = parse_editor(path)
        if waves is None:
            return [('?', 'X', 'unrecognized format')]
    os.makedirs(outdir, exist_ok=True)
    items = []  # (attack_peak, wave_index, kind, payload, grade, note)
    for i, wv in enumerate(waves):
        try:
            if str(wv['stereo']).startswith('1'):
                L, R, g, note = solve_stereo(wv['blob'], wv['frames'])
                if L is None:
                    items.append((0, i, 'skip', None, g, note))
                    continue
                n = min(len(L), len(R), wv['frames'])
                pk = max(attack_peak(L[:n]), attack_peak(R[:n]))
                items.append((pk, i, 'stereo', (L[:n], R[:n]), g, note))
            elif 'v1' in wv:
                v = apply_voice_rule(wv['v1'], wv['frames'])
                items.append((attack_peak(v), i, 'mono', v, 'A', 'V1 single'))
            else:
                spec, g, note = solve_wave(wv['blob'], wv['frames'])
                if spec is None:
                    items.append((0, i, 'skip', None, g, note))
                    continue
                v = apply_voice_rule(decode_wave(wv['blob'], wv['frames'], spec),
                                     wv['frames'])
                items.append((attack_peak(v), i, 'mono', v, g, note))
        except Exception as e:  # never break the batch
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
    mapping = []
    for vi, grp in enumerate(groups, 1):
        for ri, it in enumerate(sorted(grp, key=lambda x: x[0]), 1):
            _pk, i, kind, payload, g, note = it
            fn = f'{family}_{mic}_V{vi:02d}_RR{ri}.wav'
            if kind == 'stereo':
                export_stereo(f'{outdir}/{fn}', *payload)
            else:
                export_wav(f'{outdir}/{fn}', payload)
            mapping.append((fn, i, g, note, int(_pk)))
    skipped = [(i, g, n) for _p, i, k, _pl, g, n in items if k == 'skip']
    with open(f'{outdir}/MAP.txt', 'w') as f:
        for fn, i, g, note, pk in mapping:
            f.write(f'{fn} <- wave{i:02d} [{g}] peak={pk} {note}\n')
        for i, g, n in skipped:
            f.write(f'-- wave{i:02d} [{g}] {n}\n')
    return [(fn, g, '') for fn, _i, g, _n, _p in mapping]


def main(flt):
    jobs = []
    for cat, sub in CATS.items():
        root = f'{LIB}/{sub}'
        if not os.path.isdir(root):
            continue
        for inst in sorted(os.listdir(root)):
            idir = f'{root}/{inst}'
            if not os.path.isdir(idir):
                continue
            for fn in sorted(os.listdir(idir)):
                if not fn.lower().endswith('.tci'):
                    continue
                if flt and not any(f.lower() in (inst + ' ' + fn).lower() for f in flt):
                    continue
                mic = os.path.splitext(fn)[0].split()[-1].upper()
                family = inst.replace(' ', '')
                jobs.append((cat, inst, f'{idir}/{fn}', family, mic))
    print(f'{len(jobs)} TCIs queued', flush=True)
    for cat, inst, path, family, mic in jobs:
        outdir = f'{OUT}/{cat}/{inst}/{mic}'
        print(f'--- {family}_{mic} :: {os.path.basename(path)}', flush=True)
        try:
            for fn, g, _n in export_tci(path, outdir, family, mic):
                print(f'    {fn} [{g}]', flush=True)
        except Exception as e:
            print(f'    TCI-LEVEL FAIL: {e}', flush=True)


if __name__ == '__main__':
    main([a for a in sys.argv[1:]])
