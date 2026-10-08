"""Render + verify waves from a TCI using known-good struct specs.

The specs below were solved offline and are pinned here so a decoder change
can be re-checked bit-exactly against them. Verification (the kick mode)
correlates each rendered wave against a ground-truth layered render that you
supply; without it you only get the rendered WAVs.

Usage:
  python3 render_tci.py kick <ACKick Z3.tci> <ACKickZ3_layers.wav> [outdir]
  python3 render_tci.py kick-noverify <ACKick Z3.tci> [outdir]
  python3 render_tci.py snare <SlateSnare Z3.tci> [outdir]

No paths are hardcoded: pass the .tci files (and the reference WAV for
verification) on the command line. Needs numpy.
Decoder lives in tci_decode.py (same folder).
"""

import os
import sys

import numpy as np

from tci_decode import (apply_voice_rule, decode_wave, export_wav, parse_tci)

# Wave hit onsets in ACKickZ3_layers.wav (mono 24-bit), in order, samples.
KICK_ONSETS = [3, 132303, 264603, 396903, 529203, 661503, 793802, 926101,
               1058402, 1190702, 1323001, 1455302, 1587601, 1719901, 1852202,
               1984501, 2116801, 2249101]
# Which reference hit each kick wave matched (corr-verified).
KICK_HITS = {0: 15, 1: 12, 2: 13, 3: 14, 4: 9, 5: 6,
             6: 7, 7: 8, 8: 4, 9: 0, 10: 1, 11: 2}

# Proven ACKick Z3 structs. ('raw', nraw) or ('blk', S, k, C, T).
# S = side bits, width byte at bit S, C k-bit attack samples, tail from bit T.
# Width bytes recorded as found (informational; decoder does not need them):
# w4:145 w5:149 w6:29 w7:75 w2:62 (all -> k=23); w8:142 w10:129 (->k=20);
# w9:22 w11:140 (->k=21).
KICK_STRUCTS = {
    0: ('raw', 200), 1: ('raw', 200), 3: ('raw', 200),
    2: ('blk', 14, 23, 199, 4599),
    4: ('blk', 14, 23, 199, 4599),
    5: ('blk', 14, 23, 199, 4599),
    6: ('blk', 14, 23, 199, 4599),
    7: ('blk', 14, 23, 199, 4599),
    8: ('blk', 28, 20, 198, 3996),
    9: ('blk', 39, 21, 198, 4205),
    10: ('blk', 36, 20, 198, 4004),
    11: ('blk', 39, 21, 198, 4205),
}

# SlateSnare Z3 structs. w00-04 raw; w17-19 six identity k=20 blocks;
# rest single attack blocks. Solved structurally + confirmed by ear
# (no ground-truth render exists). w12/w15 were picked from two candidates
# by attack smoothness; byte 0 maps to several widths (table unresolved).
SNARE_STRUCTS = {i: ('raw', 200) for i in range(5)}
SNARE_STRUCTS.update({
    5: ('blk', 0, 24, 200, 4808),
    6: ('blk', 8, 24, 200, 4816),
    7: ('blk', 8, 24, 200, 4816),
    8: ('blk', 80, 24, 197, 4816),
    9: ('blk', 76, 23, 197, 4615),
    10: ('blk', 84, 23, 197, 4623),
    11: ('blk', 84, 23, 197, 4623),
    12: ('blk', 13, 21, 200, 4221),
    13: ('blk', 80, 22, 197, 4422),
    14: ('blk', 80, 22, 197, 4422),
    15: ('blk', 14, 22, 200, 4422),
    16: ('blk', 12, 20, 200, 4020),
    17: ('blocks', [(20, 201)] * 6, 24168),
    18: ('blocks', [(20, 201)] * 6, 24168),
    19: ('blocks', [(20, 201)] * 6, 24168),
})


def read_mono24(path):
    import wave
    with wave.open(path, 'rb') as f:
        raw = f.readframes(f.getnframes())
    a = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
    ss = a[:, 0] + (a[:, 1] << 8) + (a[:, 2] << 16)
    return np.where(ss >= (1 << 23), ss - (1 << 24), ss).astype(float)


def fft_corr(vec, ref):
    """Best normalized correlation of vec inside ref. Returns (corr, lag)."""
    w = np.asarray(vec, float)
    L = 1
    while L < len(ref) + len(w):
        L *= 2
    F = np.fft.rfft(ref, L) * np.conj(np.fft.rfft(w, L))
    cc = np.fft.irfft(F, L)[:len(ref) - len(w) + 1]
    e = np.cumsum(np.concatenate([[0.0], ref * ref]))
    den = np.sqrt(np.maximum(e[len(w):] - e[:len(cc)], 1e-20)) * np.linalg.norm(w)
    nc = cc / den
    bi = int(np.argmax(nc))
    return float(nc[bi]), bi


def render_kick(tci_path, outdir, ref_path=None):
    tci = parse_tci(tci_path)
    ref = read_mono24(ref_path) if ref_path else None
    os.makedirs(outdir, exist_ok=True)
    tag = os.path.splitext(os.path.basename(tci_path))[0].replace(' ', '')
    for i, wv in enumerate(tci['waves']):
        vec = apply_voice_rule(decode_wave(wv['blob'], wv['frames'], KICK_STRUCTS[i]),
                               wv['frames'])
        fn = f'{outdir}/{tag}_wave{i:02d}_{wv["frames"]}fr_sm.wav'
        export_wav(fn, vec)
        msg = f'w{i}: n={len(vec)} peak={int(np.abs(vec).max())}'
        if ref is not None:
            o = KICK_ONSETS[KICK_HITS[i]]
            c, lag = fft_corr(vec * 2 ** -12, ref[o:o + 60000])
            msg += f' corr={c:.5f} lag={lag}'
        print(msg, flush=True)


def render_snare(tci_path, outdir):
    tci = parse_tci(tci_path)
    os.makedirs(outdir, exist_ok=True)
    tag = os.path.splitext(os.path.basename(tci_path))[0].replace(' ', '')
    for i, wv in enumerate(tci['waves']):
        vec = apply_voice_rule(decode_wave(wv['blob'], wv['frames'], SNARE_STRUCTS[i]),
                               wv['frames'])
        fn = f'{outdir}/{tag}_wave{i:02d}_{wv["frames"]}fr.wav'
        export_wav(fn, vec)
        print(f'w{i}: n={len(vec)} peak={int(np.abs(vec).max())}', flush=True)


USAGE = ('usage: render_tci.py kick <tci> <reference.wav> [outdir]\n'
         '       render_tci.py kick-noverify <tci> [outdir]\n'
         '       render_tci.py snare <tci> [outdir]')

if __name__ == '__main__':
    argv = sys.argv[1:]
    if not argv or argv[0] in ('-h', '--help'):
        sys.exit(__doc__ + '\n' + USAGE)
    which, args = argv[0], argv[1:]
    if which == 'kick':
        if len(args) < 2:
            sys.exit('kick mode needs <tci> and <reference.wav>\n' + USAGE)
        out = args[2] if len(args) > 2 else os.path.join(os.getcwd(), 'render_tci_out')
        render_kick(args[0], out, args[1])
    elif which == 'kick-noverify':
        if not args:
            sys.exit('kick-noverify needs <tci>\n' + USAGE)
        out = args[1] if len(args) > 1 else os.path.join(os.getcwd(), 'render_tci_out')
        render_kick(args[0], out)
    elif which == 'snare':
        if not args:
            sys.exit('snare needs <tci>\n' + USAGE)
        out = args[1] if len(args) > 1 else os.path.join(os.getcwd(), 'render_tci_out')
        render_snare(args[0], out)
    else:
        sys.exit(USAGE)
