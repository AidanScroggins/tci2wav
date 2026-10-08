"""Stereo (stereo=1) wave decoder.

Layout, as proven against the library (see WRITEUP.md section 5):
  - The wave is one joint stream of `2 * frames` sign-magnitude samples (the
    footer confirms it: wd{i}samples == 2 * wd{i}frames).
  - Everything from the tail start on is a chain of V1 blocks,
    [k:8][201 x k-bit samples], and that chain consumes the wave's bit budget
    to within a few trailing pad bits.
  - Sample N of the joint stream is L when N is even and R when N is odd,
    counted over the WHOLE stream including the head. Because a block holds an
    odd 201 samples this parity alternates block by block; deinterleaving by
    global index is what keeps the channels consistent.
  - The first `head` joint samples (0..400 across the library, ~93-100 frames,
    i.e. ~2 ms) come from a non-V1 head path that is not decoded yet. They are
    left silent and reported, never guessed.
"""

import numpy as np

BLOCK_SAMPLES = 201
MAX_K = 24

# The tail start never exceeded 7236 bits over the whole library.
HEAD_SCAN_BITS = 65536
# Loudest observed head was 400 joint samples. 4096 still catches anything
# unusual while rejecting accidental early matches.
HEAD_MAX_SAMPLES = 4096
# Trailing slack between the chain end and wd{i}comp1 was at most 31 bits.
TAIL_TOLERANCE_BITS = 64

_POW8 = np.array([128, 64, 32, 16, 8, 4, 2, 1], dtype=np.uint16)


def bits_of(blob):
    """Bitstream as a 0/1 uint8 array, one entry per bit, MSB-first."""
    return np.unpackbits(np.frombuffer(bytes(blob), dtype=np.uint8), bitorder='big')


def words_of(blob):
    """Blob as a list of big-endian 64-bit words, for cheap bit lookups.

    Padding goes at the END so bit offset 0 stays bit offset 0."""
    raw = bytes(blob)
    if not raw:
        return []
    return np.frombuffer(raw + bytes((-len(raw)) % 8), dtype='>u8').tolist()


def byte_at(words, pos):
    """8-bit value at bit offset `pos` (0 past the end of the stream)."""
    i = pos >> 6
    if i >= len(words):
        return 0
    # 128-bit window so the 8 bits never straddle the shift into the void
    v = words[i] << 64
    if i + 1 < len(words):
        v |= words[i + 1]
    return (v >> (120 - (pos & 63))) & 0xFF


def bit_byte_table(bits, nbits):
    """Width byte at every bit offset below `nbits` (one sliding window)."""
    m = min(bits.size, nbits + 8)
    if m < 8:
        return np.zeros(0, dtype=np.int32)
    win = np.lib.stride_tricks.sliding_window_view(bits[:m], 8)
    return (win.astype(np.uint16) @ _POW8).astype(np.uint8)


# Weights for one 8-bit chunk; uint16 so a chunk never overflows. k can be up
# to 24, so rows are summed 8 bits at a time and shifted into place.
_W8 = np.uint16(1) << np.arange(7, -1, -1, dtype=np.uint16)


def read_block(bits, pos, k, n):
    """Decode n k-bit sign-magnitude samples starting at bit `pos`."""
    row = bits[pos:pos + n * k].reshape(n, k)
    code = np.zeros(n, dtype=np.uint32)
    for g in range((k + 7) // 8):
        j0 = 8 * g
        take = min(8, k - j0)
        part = row[:, j0:j0 + take].astype(np.uint16) @ _W8[8 - take:]
        code |= part.astype(np.uint32) << np.uint32(k - j0 - take)
    m = (code & np.uint32((1 << (k - 1)) - 1)).astype(np.int32)
    s = (code >> np.uint32(k - 1)).astype(np.int32)
    return ((m ^ -s) + s).astype(float)


def walk_tail(words, kvb, start, comp, cap, tol=TAIL_TOLERANCE_BITS):
    """Walk V1 blocks from `start`. Returns (count, end) if the chain reaches
    `comp` within `tol` bits, else None."""
    pos, count = start, 0
    nkvb = len(kvb)
    while pos + 8 <= comp:
        k = kvb[pos] if pos < nkvb else byte_at(words, pos)
        if k < 1 or k > MAX_K:
            break
        pos += 8
        n = BLOCK_SAMPLES
        if pos + n * k > comp:
            n = (comp - pos) // k
        if n <= 0:
            break
        pos += n * k
        count += n
        if count > cap:
            return None
    if pos >= comp - tol:
        return count, pos
    return None


def find_tail(bits, words, comp, total_samples):
    """Locate the tail: the earliest bit offset from which a V1 block chain
    reaches the end of the bit budget while leaving at most HEAD_MAX_SAMPLES
    joint samples unexplained. Every block boundary inside a real tail
    qualifies, so the smallest head wins. Chance matches inside the head do
    exist (its bits are high-entropy audio, and ~9% of byte values look like a
    width byte) but a real chain has to survive millions of bits to the end,
    which they never do across the library.

    Returns dict(tailStart, count, end, head) or None."""
    kv = bit_byte_table(bits, min(HEAD_SCAN_BITS, comp))
    if kv.size == 0:
        return None
    kvb = kv.tobytes()
    ok = (kv >= 1) & (kv <= MAX_K)
    cands = np.nonzero(ok)[0]
    # Most candidates die at their second block, so pre-filter on the width
    # byte that follows the first one. Candidates whose first block could be
    # truncated, or that run past the table, are always kept.
    second = cands + 8 + BLOCK_SAMPLES * kv[cands].astype(np.int64)
    look = np.minimum(np.maximum(second, 0), kv.size - 1)
    keep = (second + 8 > comp) | (second >= kv.size) | ok[look]
    best = None
    for T in cands[keep]:
        w = walk_tail(words, kvb, int(T), comp, total_samples)
        if w is None:
            continue
        head = total_samples - w[0]
        if head < 0 or head > HEAD_MAX_SAMPLES:
            continue
        if best is None or head < best['head']:
            best = {'tailStart': int(T), 'count': w[0], 'end': w[1], 'head': head}
    return best


def decode_joint(bits, words, start, end, count):
    """Joint V1 stream between two bit offsets, exactly `count` samples.

    Blocks are located first (a cheap width walk) and then decoded in runs.
    Consecutive same-width blocks put their samples back to back with no gap,
    so one vectorised pass covers a whole run instead of one call per block."""
    blocks, pos, n = [], start, 0
    while pos + 8 <= end and n < count:
        k = byte_at(words, pos)
        if k < 1 or k > MAX_K:
            break
        pos += 8
        m = min(BLOCK_SAMPLES, count - n, (end - pos) // k)
        if m <= 0:
            break
        blocks.append((pos, k, m))
        n += m
        pos += m * k
    out = np.zeros(count, dtype=float)
    at, i = 0, 0
    while i < len(blocks):
        k = blocks[i][1]
        j = i + 1
        while j < len(blocks) and blocks[j][1] == k:
            j += 1
        run = blocks[i:j]
        m = sum(b[2] for b in run)
        if run[-1][0] + run[-1][2] * k - run[0][0] == m * k:
            out[at:at + m] = read_block(bits, run[0][0], k, m)
        else:                                    # not contiguous: one by one
            for p, kk, mm in run:
                out[at:at + mm] = read_block(bits, p, kk, mm)
                at += mm
            i = j
            continue
        at += m
        i = j
    return out


def decode_stereo(blob, comp, frames):
    """Decode one stereo wave into L and R of exactly `frames` samples each.

    Returns dict(L, R, headSamples, headFrames, tailStart, tailSamples), or
    None when no tail chain explains the wave. Frames covered by the
    undecoded head stay silent at the front; every tail sample lands in exactly
    one channel slot, so nothing is dropped or duplicated."""
    if not comp or frames <= 0:
        return None
    bits, words = bits_of(blob), words_of(blob)
    t = find_tail(bits, words, comp, 2 * frames)
    if t is None:
        return None
    joint = decode_joint(bits, words, t['tailStart'], t['end'], t['count'])
    head = t['head']
    # tail sample i is global joint sample head + i, so even globals are L and
    # the two channels are plain strided slices that land exactly on frames.
    L = np.zeros(frames, dtype=float)
    R = np.zeros(frames, dtype=float)
    h2, count = head // 2, t['count']
    if head % 2 == 0:
        L[h2:h2 + (count + 1) // 2] = joint[0::2]
        R[h2:h2 + count // 2] = joint[1::2]
    else:
        R[h2:h2 + (count + 1) // 2] = joint[0::2]
        L[h2 + 1:h2 + 1 + count // 2] = joint[1::2]
    return {'L': L, 'R': R, 'headSamples': int(head),
            'headFrames': int(-(-head // 2)), 'tailStart': int(t['tailStart']),
            'tailSamples': int(t['count'])}
