"""Structural solver toolkit for unknown TCI waves (no ground truth needed).

Workflow for a new wave (see WRITEUP.md for the full method):
  1. bits = bits_of(blob); Ts = run_scan(...) -> candidate tail starts T.
  2. For each T: tl = tail_count(bits, T); need = frames - tl.
  3. single_fits(bits, T, need) -> exact (S, k, C) head fits.
  4. Rank ambiguous fits with sibling_ncc() against a known attack
     (same drum, already cracked), or render candidates and listen.
  5. identity_peel() maps the identity-byte block chains (finds where the
     special head prefix ends and the regular tail begins).

Needs numpy.
"""

import numpy as np

from tci_decode import bits_of, smbits


def run_scan(bits, lo=0, hi=60000, min_run=10, count=201):
    """Find bit offsets that start long `count`-sample V1 chains.

    Returns [(run_blocks, pos)] sorted longest-first. WARNING: the longest
    run is NOT always the true tail start -- a misframed first block can
    extend a run backward over head data (proven: kick w2/w7, snare w16).
    Always confirm by full-decode length + correlation/listening.
    """
    out = []
    L = len(bits)
    for pos in range(lo, min(hi, L - 8)):
        if not 1 <= int(bits[pos:pos + 8], 2) <= 24:
            continue
        run, p = 0, pos
        while p + 8 <= L:
            k = int(bits[p:p + 8], 2)
            if not 1 <= k <= 24:
                break
            if p + 8 + count * k > L:
                run += 0.5
                break
            p += 8 + count * k
            run += 1
            if run > 600:
                break
        if run >= min_run:
            out.append((run, pos))
    out.sort(reverse=True)
    return out


def tail_count(bits, T, count=201):
    """Decode V1 blocks from bit T. Returns (nsamples, endpos)."""
    pos, cnt, L = T, 0, len(bits)
    while pos + 8 <= L:
        k = int(bits[pos:pos + 8], 2)
        if not 1 <= k <= 24:
            break
        pos += 8
        n = count
        if pos + n * k > L:
            n = (L - pos) // k
        if n <= 0:
            break
        pos += n * k
        cnt += n
    return cnt, pos


def decode_span(bits, pos, k, C):
    """Decode C k-bit sign-magnitude samples from bit pos."""
    return np.array([smbits(bits[pos + i * k:pos + (i + 1) * k])
                     for i in range(C)], dtype=float)


def single_fits(bits, T, need, c_lo=8, c_window=(-4, 44), s_max=None):
    """Exact single-block head fits: S + 8 + C*k == T with C near `need`.

    Returns [(C, k, S, byte)] where byte = width byte at S. Several fits
    commonly match (sub-segment ambiguity); disambiguate with sibling_ncc,
    exact total length, or listening -- see WRITEUP.md (kick w10 lesson:
    the length-exact fit is NOT always the true one).
    """
    sols = []
    for C in range(max(c_lo, need + c_window[0]), need + c_window[1] + 1):
        for k in range(1, 25):
            S = T - 8 - C * k
            if S < 0 or (s_max is not None and S > s_max):
                continue
            sols.append((C, k, S, int(bits[S:S + 8], 2)))
    return sols


def sibling_ncc(seg, ref):
    """Normalized correlation of candidate attack vs known attack (shape-only,
    amplitude-invariant -- works across velocity layers of the same drum)."""
    L = min(len(seg), len(ref))
    a = np.asarray(seg[:L], float)
    b = np.asarray(ref[:L], float)
    a1, b1 = a - a.mean(), b - b.mean()
    d = np.linalg.norm(a1) * np.linalg.norm(b1)
    return float(a1 @ b1 / d) if d > 1e-9 else -2.0


def rank_fits(bits, T, need, ref_attack, **kw):
    """single_fits + sibling rank. Returns [(ncc, C, k, S, byte)] best-first."""
    ranked = []
    for (C, k, S, b) in single_fits(bits, T, need, **kw):
        seg = decode_span(bits, S + 8, k, C)
        if len(seg) >= 64:
            ranked.append((round(sibling_ncc(seg, ref_attack), 4), C, k, S, b))
    ranked.sort(reverse=True)
    return ranked


def identity_peel(bits, T):
    """Walk backward from T over [byte==k] 201-count identity blocks.

    Returns (chain, remainder_start) where chain = [(k, pos)] oldest-first.
    Identity chains run through BOTH head and tail (the decoder's tail is
    mostly identity bytes), so the peel maps structure but does NOT by
    itself locate the head/tail boundary -- combine with length fits.
    """
    pos, chain = T, []
    while pos >= 8:
        for k in range(1, 25):
            prev = pos - 8 - 201 * k
            if prev >= 0 and int(bits[prev:prev + 8], 2) == k:
                chain.append((k, prev))
                pos = prev
                break
        else:
            break
    chain.reverse()
    return chain, pos
