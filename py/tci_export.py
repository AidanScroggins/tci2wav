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

Stereo waves (stereo=1, samples = 2*frames): one joint stream of
2*frames sign-magnitude samples, L/R = even/odd SAMPLES counted over the
whole stream. From the tail start on it is a chain of V1 [k:8][201 x k-bit]
blocks that consumes wd{i}comp1 exactly; the earliest chain that reaches the
end wins. The first ~93-100 frames (head) come from a non-V1 table path that
is not decoded, so those frames are left SILENT and reported rather than
guessed: grade B (see stereo.py).

Velocity: attack-peak (peak over first 5000 samples) ascending. Groups:
adjacent levels with peak ratio < 1.12 share a velocity (round robins).
Documented assumption: validated on ACKick Z3 (matches DAW hit order
within +-2; peak clusters align exactly).

Usage: python3 tci_export.py [--lib DIR] [--out DIR] [filter ...]

--lib points at your Trigger 2 library (env: TCI2WAV_LIB, default
~/Trigger2Library); --out at the write target (env: TCI2WAV_OUT, default
<library>/TCI-Exports). Remaining arguments are filename filters, same as
render_library.py.
"""

import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tci_decode import (apply_voice_rule, decode_wave, export_stereo_wav,
                        export_wav)
from render_library import CATS, LIB, parse_args, parse_v2, solve_wave
from stereo import decode_stereo

# See render_library for the TCI2WAV_LIB / TCI2WAV_OUT convention; both are
# overridable with --lib / --out.
OUT = os.environ.get('TCI2WAV_OUT') or os.path.join(LIB, 'TCI-Exports')
RR_RATIO = 1.12
ATK_N = 5000


def parse_v1(path):
    """Oracle-proven V1 single wave: [01][comp u32][frames u32] then
    [k:8][201 x k-bit] residuals (sign-magnitude, like V2)."""
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
                m = int(ch[1:], 2) if k > 1 else 0
                out.append(-m if ch[0] == '1' and m else m)
        if ok and pos == comp and len(out) == fr - 1:
            return [{'comp': comp, 'frames': fr, 'stereo': '0-x',
                      'v1': np.array(out, float)}]
    return None


def parse_editor(path):
    """Trigger Instrument Editor variant ("COMPRESSED INSTRUMENT" tag):
    128-byte file header, then waves chained by 8-byte gap records
    [05][prev_wave_span_bytes LE] ... [06][0] + params footer to EOF.
    Each wave: [01][comp u32 LE][frames u32 LE][V1 sign-magnitude blocks].
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
                m = int(ch[1:], 2) if k > 1 else 0
                out.append(-m if ch[0] == '1' and m else m)
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


def decode_stereo_wave(wblob, comp, fr):
    """Decode one stereo wave. Returns (L, R, grade, note); grade X when no
    V1 tail chain explains the wave. The undecoded head frames stay silent."""
    r = decode_stereo(wblob, comp, fr)
    if r is None:
        return None, None, 'X', 'no V1 tail chain'
    note = f'stereo tail@bit{r["tailStart"]}/{r["tailSamples"]}sm'
    note += (f' head:{r["headFrames"]}fr silent' if r['headFrames']
             else ' head:none')
    return r['L'], r['R'], 'B', note


def attack_peak(vec):
    v = np.asarray(vec, float)[:ATK_N]
    return float(np.abs(v).max()) if len(v) else 0.0


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
                L, R, g, note = decode_stereo_wave(wv['blob'], wv['comp'],
                                                   wv['frames'])
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
                export_stereo_wav(f'{outdir}/{fn}', *payload)
            else:
                export_wav(f'{outdir}/{fn}', payload)
            mapping.append((fn, i, g, note, int(_pk), kind))
    skipped = [(i, g, n) for _p, i, k, _pl, g, n in items if k == 'skip']
    tag = lambda k: 'st' if k == 'stereo' else 'mono'
    with open(f'{outdir}/MAP.txt', 'w') as f:
        for fn, i, g, note, pk, kind in mapping:
            f.write(f'{fn} <- wave{i:02d} [{g}] {tag(kind)} peak={pk} {note}\n')
        for i, g, n in skipped:
            f.write(f'-- wave{i:02d} [{g}] {n}\n')
    return [(fn, g, '') for fn, _i, g, _n, _p, _k in mapping]


def main(flt):
    global LIB, OUT
    if not os.path.isdir(LIB):
        sys.exit(f'Trigger 2 library not found at {LIB!r}.\n'
                 f'Pass --lib /path/to/library or set TCI2WAV_LIB.')
    jobs = []
    for cat, sub in CATS.items():
        root = os.path.join(LIB, sub)
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
    print(f'{len(jobs)} TCIs queued -> {OUT}', flush=True)
    for cat, inst, path, family, mic in jobs:
        outdir = os.path.join(OUT, cat, inst, mic)
        print(f'--- {family}_{mic} :: {os.path.basename(path)}', flush=True)
        try:
            for fn, g, _n in export_tci(path, outdir, family, mic):
                print(f'    {fn} [{g}]', flush=True)
        except Exception as e:
            print(f'    TCI-LEVEL FAIL: {e}', flush=True)


if __name__ == '__main__':
    _flt, _lib, _out = parse_args(sys.argv[1:], usage=__doc__)
    if _lib:
        LIB = _lib
        OUT = os.path.join(_lib, 'TCI-Exports')
    if _out:
        OUT = _out
    main(_flt)
