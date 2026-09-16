"""Core Trigger 2 V2 TCI wave decoder.

Bitstream facts (proven by exact correlation against ground truth renders):
- Every integer sample (raw head, residual) is SIGN-MAGNITUDE, not two's
  complement. Matches the voice decoder asm: negl/cmov sign handling.
- Tails are V1-style blocks: [k:8][N x k-bit samples], N = 201, k = 1..24,
  continuous MSB-first bitstream, no padding between blocks.
- Heads are either N raw 24-bit big-endian sign-magnitude samples, or
  8-bit width-byte headed attack blocks [side bits][byte][C x k-bit].

Voice rule: decode consumes all bits; the voice plays the first `frames`
samples (truncate over-long decodes, zero-pad short ones).
"""

import math
import re
import struct
import zlib


def sm24(b0, b1, b2):
    """24-bit big-endian sign-magnitude triple -> int."""
    v = (b0 << 16) | (b1 << 8) | b2
    return -(v & 0x7FFFFF) if v & 0x800000 else v


def smbits(code):
    """k-bit sign-magnitude code word (str of '0'/'1') -> int. k=1 decodes to 0."""
    k = len(code)
    mag = int(code[1:], 2) if k > 1 else 0
    return -mag if code[0] == '1' else mag


def parse_tci(path):
    """Split a V2 .tci into per-wave blobs + footer attrs.

    Container: magic64 + audio_len(u32) + 0 + fmt(24) + blob + footer.
    Footer: 8-byte header + zlib stream; decompressed = b'VC2!' + XML.
    Blob splits per wave: ceil(wd{i}comp1 / 8) bytes each, in order.
    Returns {'waves': [{'comp','frames','blob'}], 'attrs': {...}}.
    """
    d = open(path, 'rb').read()
    audio_len, _rsv, _fmt = struct.unpack('<III', d[64:76])
    blob = d[76:76 + audio_len]
    foot = d[76 + audio_len:]
    dec = zlib.decompress(foot[8:])
    assert dec[:4] == b'VC2!', dec[:4]
    xml = dec[8:].decode()
    m = re.search(r'<trigger_instrument([^>]+)>', xml)
    attrs = dict(re.findall(r'(\S+)="([^"]*)"', m.group(1)))
    n = int(attrs['data_count'])
    waves = []
    off = 0
    for i in range(n):
        comp = int(attrs[f'wd{i}comp1'])
        fr = int(attrs[f'wd{i}frames'])
        nb = math.ceil(comp / 8)
        waves.append({'comp': comp, 'frames': fr, 'blob': blob[off:off + nb]})
        off += nb
    return {'waves': waves, 'attrs': attrs}


def decode_blocks(bits, pos):
    """Decode V1 201-count blocks from bit position pos. Returns (samples, endpos)."""
    out = []
    L = len(bits)
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
        for i in range(n):
            out.append(smbits(bits[pos:pos + k]))
            pos += k
    return out, pos


def bits_of(blob):
    return ''.join(f'{b:08b}' for b in blob)


def decode_wave(wblob, frames, spec):
    """Decode one wave. spec is one of:
      ('raw', nraw)               N raw 24-bit BE sign-magnitude samples, then V1 tail.
      ('blk', S, k, C, T)         S side bits, width byte at S, C k-bit samples,
                                  V1 tail from bit T. (S+8+C*k must equal T.)
      ('blocks', [(k,C),...], T)  multi-block head from bit 0, V1 tail from T.
      ('tail8', [T0])             Z side bytes (default T0=8), V1 tail from T0
                                  (no attack block; transient at tail start).
    Returns list of ints (full decode; caller applies the voice rule).
    """
    w = bytes(wblob)
    kind = spec[0]
    if kind == 'tail8':
        T0 = spec[1] if len(spec) > 1 else 8
        tail, _ = decode_blocks(bits_of(w), T0)
        return tail
    w = bytes(wblob)
    kind = spec[0]
    if kind == 'raw':
        nraw = spec[1]
        raw = [sm24(w[i], w[i + 1], w[i + 2]) for i in range(0, 3 * nraw, 3)]
        tail, _ = decode_blocks(bits_of(w[3 * nraw:]), 0)
        return raw + tail
    bits = bits_of(w)
    if kind == 'blk':
        _, S, k, C, T = spec
        assert S + 8 + C * k == T, (S, k, C, T)
        atk = [smbits(bits[S + 8 + i * k:S + 8 + (i + 1) * k]) for i in range(C)]
        tail, _ = decode_blocks(bits, T)
        return atk + tail
    if kind == 'blocks':
        _, blks, T = spec
        p = 0
        out = []
        for (k, C) in blks:
            p += 8  # width byte (value recorded in STRUCTS, informational here)
            for i in range(C):
                out.append(smbits(bits[p:p + k]))
                p += k
        assert p == T, (p, T)
        tail, _ = decode_blocks(bits, T)
        return out + tail
    raise ValueError(spec)


def apply_voice_rule(vec, frames):
    """Voice plays exactly `frames` samples: truncate or zero-pad."""
    import numpy as np
    v = np.asarray(vec, dtype=float)
    if len(v) > frames:
        v = v[:frames]
    elif len(v) < frames:
        v = np.concatenate([v, np.zeros(frames - len(v))])
    return v


def export_wav(path, vec):
    """Write mono 24-bit 44.1k WAV from int samples."""
    import wave
    import numpy as np
    iv = np.clip(np.asarray(vec, dtype=float), -2 ** 23, 2 ** 23 - 1).astype(np.int32)
    u = iv & ((1 << 24) - 1)
    pcm = np.zeros((len(iv), 3), dtype=np.uint8)
    pcm[:, 0] = u & 255
    pcm[:, 1] = (u >> 8) & 255
    pcm[:, 2] = (u >> 16) & 255
    with wave.open(path, 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(3)
        f.setframerate(44100)
        f.writeframes(pcm.tobytes())
