"""Render + verify waves from a TCI using proven struct specs.

Usage:
  python3 render_tci.py kick   # ACKick Z3: render 12 waves, verify vs layers
  python3 render_tci.py snare  # SlateSnare Z3: render 20 waves (structural drafts)

Edit PATHS below for your machine. Needs numpy.
Decoder lives in tci_decode.py (same folder).
"""

import os
import sys

import numpy as np

from tci_decode import (apply_voice_rule, decode_wave, export_wav, parse_tci)

KICK_TCI = '/Users/aidan/Downloads/TCI Crack - v2 (ACKick Z3)/ACKick Z3.tci'
KICK_REF = '/Users/aidan/Documents/Trigger2Library/ACKickZ3_layers.wav'
SNARE_TCI = '/Users/aidan/Documents/Trigger2Library/Trigger2 Snares/SlatesSnare/SlateSnare Z3.tci'
OUT = '/Users/aidan/Documents/Trigger2Library/V2_DECODED_SM'

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


def render_kick(verify=True):
    tci = parse_tci(KICK_TCI)
    ref = read_mono24(KICK_REF) if verify else None
    os.makedirs(OUT, exist_ok=True)
    for i, wv in enumerate(tci['waves']):
        vec = apply_voice_rule(decode_wave(wv['blob'], wv['frames'], KICK_STRUCTS[i]),
                               wv['frames'])
        fn = f'{OUT}/ACKickZ3_wave{i:02d}_{wv["frames"]}fr_sm.wav'
        export_wav(fn, vec)
        msg = f'w{i}: n={len(vec)} peak={int(np.abs(vec).max())}'
        if verify:
            o = KICK_ONSETS[KICK_HITS[i]]
            c, lag = fft_corr(vec * 2 ** -12, ref[o:o + 60000])
            msg += f' corr={c:.5f} lag={lag}'
        print(msg, flush=True)


def render_snare():
    tci = parse_tci(SNARE_TCI)
    outdir = f'{OUT}/SlateSnareZ3'
    os.makedirs(outdir, exist_ok=True)
    for i, wv in enumerate(tci['waves']):
        vec = apply_voice_rule(decode_wave(wv['blob'], wv['frames'], SNARE_STRUCTS[i]),
                               wv['frames'])
        fn = f'{outdir}/SlateSnareZ3_wave{i:02d}_{wv["frames"]}fr.wav'
        export_wav(fn, vec)
        print(f'w{i}: n={len(vec)} peak={int(np.abs(vec).max())}', flush=True)


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'kick'
    if which == 'kick':
        render_kick(verify=True)
    elif which == 'kick-noverify':
        render_kick(verify=False)
    elif which == 'snare':
        render_snare()
    else:
        sys.exit('usage: render_tci.py [kick|kick-noverify|snare]')
