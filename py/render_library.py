"""Batch-render library TCIs with structural auto-parse (no ground truth needed).

Output tree: <OUT>/<Category>/<Instrument>/<MIC>/wave<i>_<frames>fr_<grade>.wav
  Category: Kicks | Snares | Toms | Deluxe
  Instrument: folder name (e.g. ACKick). MIC: Z3 | Z1 | NRG | SSDR | ...
Grades: A (exact + smooth), B (exact fit), C (approx), X (unsolved/skipped).
A REPORT.txt lands in each instrument folder.

Auto-parse per wave (see WRITEUP.md for why each rule exists):
  1. raw200: first 200 BE24 sign-mag samples smooth + raw200+tail length fit.
  2. multi: identity-byte 201-count chains from bit 0 (>=2 blocks) + tail.
  3. single: exact S+8+C*k==T head fit at a run-scan tail start T, with
     C + taillen == frames (+-2 exact, else +-44 draft), ranked by attack
     smoothness (mad / 2^(k-1)); misframes score ~0.5+, true audio ~<0.15.
  4. else X.

Usage: python3 render_library.py [ famille-filter ... ]
  e.g. python3 render_library.py ACKick        (one instrument)
       python3 render_library.py Kicks         (whole category)
       python3 render_library.py               (all 420 TCIs; slow, run overnight)
"""

import math
import os
import re
import struct
import sys
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tci_decode import (apply_voice_rule, bits_of, decode_blocks, decode_wave,
                        export_wav, sm24)

LIB = '/Users/aidan/Documents/Trigger2Library'
OUT = f'{LIB}/TCI-Exports'
CATS = {'Kicks': 'Trigger2 Kicks', 'Snares': 'Trigger2 Snares',
        'Toms': 'Trigger2 Toms', 'Deluxe': 'Trigger2 Deluxe'}

KMAP = {145: 23, 149: 23, 29: 23, 62: 23, 75: 23, 142: 20, 22: 21,
        140: 21, 129: 20, 191: 20, 20: 20, 24: 24}


def parse_v2(path):
    d = open(path, 'rb').read()
    audio_len, _, _ = struct.unpack('<III', d[64:76])
    blob = d[76:76 + audio_len]
    try:
        dec = zlib.decompress(d[76 + audio_len:][8:])
    except Exception:
        return None
    if dec[:4] != b'VC2!':
        return None
    try:
        xml = dec[8:].decode()
    except UnicodeDecodeError:
        xml = dec[8:].decode('latin-1')  # some footers carry non-UTF8 bytes
    m = re.search(r'<trigger_instrument([^>]+)>', xml)
    attrs = dict(re.findall(r'(\S+)="([^"]*)"', m.group(1)))
    waves, off = [], 0
    for i in range(int(attrs['data_count'])):
        comp = int(attrs[f'wd{i}comp1'])
        fr = int(attrs[f'wd{i}frames'])
        nb = math.ceil(comp / 8)
        waves.append({'comp': comp, 'frames': fr,
                      'stereo': attrs.get(f'wd{i}stereo', '?'),
                      'blob': blob[off:off + nb]})
        off += nb
    return waves


def tail_count(bits, T):
    pos, cnt, L = T, 0, len(bits)
    while pos + 8 <= L:
        k = int(bits[pos:pos + 8], 2)
        if not 1 <= k <= 24:
            break
        pos += 8
        n = 201
        if pos + n * k > L:
            n = (L - pos) // k
        if n <= 0:
            break
        pos += n * k
        cnt += n
    return cnt, pos


def run_scan(bits, hi=30000, min_run=50):
    out, L = [], len(bits)
    for pos in range(0, min(hi, L - 8)):
        if not 1 <= int(bits[pos:pos + 8], 2) <= 24:
            continue
        run, p = 0, pos
        while p + 8 <= L:
            k = int(bits[p:p + 8], 2)
            if not 1 <= k <= 24:
                break
            if p + 8 + 201 * k > L:
                run += 0.5
                break
            p += 8 + 201 * k
            run += 1
            if run > 600:
                break
        if run >= min_run:
            out.append((run, pos))
    out.sort(reverse=True)
    return out


def dec_span(bits, pos, k, C):
    out = []
    for i in range(C):
        ch = bits[pos + i * k:pos + (i + 1) * k]
        mag = int(ch[1:], 2) if k > 1 else 0
        out.append(-mag if ch[0] == '1' else mag)
    return np.array(out, float)


def smooth_score(seg, k):
    """mad relative to bit depth; audio <0.15, misframed noise ~0.5+."""
    if len(seg) < 8:
        return 9.0
    return float(np.mean(np.abs(np.diff(seg)))) / (2.0 ** (k - 1))


def tail_end_ok(endp, L, tol=64):
    """Tail must consume the bitstream (voice truncates/pads the rest);
    small trailers (pad bits) are normal."""
    return endp >= L - tol


def solve_wave(wblob, fr):
    """Returns (spec, grade, note). spec feeds tci_decode.decode_wave."""
    w = bytes(wblob)
    # 1. raw200 test
    raw = np.array([sm24(w[i], w[i + 1], w[i + 2]) for i in range(0, 600, 3)],
                   dtype=float)
    rmad = float(np.mean(np.abs(np.diff(raw)))) / 2.0 ** 23
    bits = bits_of(w)
    if rmad < 0.25:
        tail, endp = decode_blocks(bits, 4800)
        over = 200 + len(tail) - fr
        # Overshoot is fine (voice truncates to `frames`); only reject short.
        if over >= -2 and tail_end_ok(endp, len(bits)):
            return ('raw', 200), 'A', f'raw200 mad={rmad:.3f} over={over}'
    # 2. multi identity-chain from 0 (test every prefix >= 2 blocks)
    p, blks = 0, []
    while p + 8 <= len(bits) and len(blks) < 12:
        k = int(bits[p:p + 8], 2)
        if not 1 <= k <= 24:
            break
        if p + 8 + 201 * k > len(bits):
            break
        blks.append((k, 201, p))
        p += 8 + 201 * k
    for n in range(min(len(blks), 12), 1, -1):
        pre, Tp = blks[:n], blks[n - 1][2] + 8 + 201 * blks[n - 1][0]
        tl, endp = tail_count(bits, Tp)
        over = sum(c for _, c, _ in pre) + tl - fr
        if -2 <= over <= 44 and tail_end_ok(endp, len(bits)):
            return ('blocks', [(k, c) for k, c, _ in pre], Tp), 'A', \
                f'{n}x identity blocks over={over}'
    # 3. single-block fits at run-scan Ts. Rank: audio-plausible smoothness
    # first (misframes score ~0.4+), then known width byte, then smallest
    # side S. Length-exactness alone misleads (giant-C over-extensions and
    # the kick-w10 short-fit trap both hit exact lengths).
    cands, k1cands = [], []
    for _run, T in run_scan(bits):
        tl, endp = tail_count(bits, T)
        if not tail_end_ok(endp, len(bits)):
            continue
        for C in range(max(8, fr - tl - 8), fr - tl + 45):
            for k in range(1, 25):
                S = T - 8 - C * k
                if S < 0 or S > 6000:
                    continue
                seg = dec_span(bits, S + 8, k, C)
                sc = smooth_score(seg, k)
                if sc >= 0.15:
                    continue
                b = int(bits[S:S + 8], 2)
                bonus = (b == k) or (KMAP.get(b) == k)
                # k==1 blocks are vacuous (always zeros): last resort only,
                # and never on byte bonus (0x01 bytes are common in side data)
                (k1cands if k == 1 else cands).append(
                    ((b == k) or (KMAP.get(b) == k), S, abs(C + tl - fr),
                     C, k, S, T, b, sc) if k > 1 else (S, abs(C + tl - fr), C, T, b, sc))
    best = None
    if not cands and k1cands:
        k1cands.sort()
        _S, _ov, C, T, b, sc = k1cands[0]
        over = C + tail_count(bits, T)[0] - fr
        best = (('blk', T - 8 - C, 1, C, T), 'C',
                f'C={C} k=1 S={T - 8 - C} T={T} byte={b} over={over} sm={sc:.2f} (silence?)')
    if cands:
        cands.sort(key=lambda x: (not x[0], x[1], x[2]))
        _nb, S, over, C, k, _S, T, b, sc = cands[0]
        over = C + tail_count(bits, T)[0] - fr
        grade = 'A' if over == 0 and sc < 0.08 else ('B' if abs(over) <= 2 else 'C')
        best = (('blk', S, k, C, T), grade,
                f'C={C} k={k} S={S} T={T} byte={b} over={over} sm={sc:.2f}')
    # tailN family: leading zero bytes (side), V1 tail from bit 8*N, no
    # attack block (transient lives at the tail start). Short pads ok.
    # Preferred over k==1 "silence" fits (vacuous: zeros always score 0.0).
    tailn = None
    Z = 0
    while Z < 4 and w[Z] == 0:
        Z += 1
    if Z:
        T0 = 8 * Z
        tl, endp = tail_count(bits, T0)
        over = tl - fr
        if -8 <= over <= 44 and tail_end_ok(endp, len(bits)):
            kk = int(bits[T0:T0 + 8], 2)
            if 1 <= kk <= 24:
                sc = smooth_score(dec_span(bits, T0, kk, 201), kk)
                if sc < 0.15:
                    tailn = (('tail8', T0), 'B', f'tail-from-{T0} zeros={Z} over={over}')
    if best is not None and best[0][0] == 'blk' and best[0][2] == 1 and tailn is not None:
        return tailn
    if best is not None:
        return best
    if tailn is not None:
        return tailn
    return None, 'X', 'unsolved'


def mic_of(fname):
    tok = os.path.splitext(fname)[0].split()[-1].upper()
    return tok


def render_tci(path, outdir):
    waves = parse_v2(path)
    if waves is None:
        return [('?', 'X', 'not V2')]
    os.makedirs(outdir, exist_ok=True)
    report = []
    for i, wv in enumerate(waves):
        if str(wv['stereo']) != '0':
            report.append((i, 'X', f'stereo={wv["stereo"]} skipped'))
            continue
        try:
            spec, grade, note = solve_wave(wv['blob'], wv['frames'])
        except Exception as e:  # never break the batch
            report.append((i, 'X', f'solver crash: {e}'))
            continue
        if spec is None:
            report.append((i, 'X', note))
            continue
        vec = apply_voice_rule(decode_wave(wv['blob'], wv['frames'], spec),
                               wv['frames'])
        fn = f'{outdir}/wave{i:02d}_{wv["frames"]}fr_{grade}.wav'
        export_wav(fn, vec)
        report.append((i, grade, f'{note} peak={int(np.abs(vec).max())}'))
    with open(f'{outdir}/REPORT.txt', 'w') as f:
        for i, g, n in report:
            f.write(f'wave{i:02d} [{g}] {n}\n')
    return report


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
                jobs.append((cat, inst, f'{idir}/{fn}'))
    print(f'{len(jobs)} TCIs queued', flush=True)
    for cat, inst, path in jobs:
        outdir = f'{OUT}/{cat}/{inst}/{mic_of(os.path.basename(path))}'
        print(f'--- {cat}/{inst} :: {os.path.basename(path)}', flush=True)
        try:
            rep = render_tci(path, outdir)
        except Exception as e:  # never break the batch
            print(f'    TCI-LEVEL FAIL: {e}', flush=True)
            continue
        for i, g, n in rep:
            print(f'    wave{i:02d} [{g}] {n}', flush=True)


if __name__ == '__main__':
    main([a for a in sys.argv[1:]])
