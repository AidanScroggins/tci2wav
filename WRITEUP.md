# Cracking Trigger 2 V2 TCI files

How the Trigger 2 `.tci` sample format was reverse-engineered, and how to
decode any V2 wave with the scripts in this folder. Everything here was
proven by exact correlation (1.0) against ground-truth Ableton renders, or
confirmed by ear where no ground truth exists.

Scripts: `tci_decode.py` (decoder library), `render_tci.py` (render +
verify with proven parse tables), `solve_wave.py` (structural solver for
unknown waves). Needs Python 3 + numpy. No plugin, no AU host, no PACE
tools required — decoding is fully offline.

## 1. Container format (V2)

```
magic64 + audio_len(u32 LE) + 0(u32) + fmt(24, u32) + blob + footer
```

- `audio_len` is at file offset 64 (`struct '<III'` over `d[64:76]`).
- `blob` = concatenated per-wave bitstreams, in wave order. Wave `i`
  owns `ceil(wd{i}comp1 / 8)` bytes.
- `footer` = 8-byte header + zlib stream. Decompressed = `VC2!` + XML
  (`<trigger_instrument ...>` single element with all attributes).
- Footer per-wave keys: `wd{i}comp1` (used bit length), `wd{i}frames`
  (voice play length), `wd{i}stereo`, `wd{i}vol`, `wd{i}samples`.
- `data{i}_offset1` are provenance tags, NOT keys: two different
  instruments with byte-identical blobs have different seeds. Key
  searches, TEA/PACE/UPC decryption, LCG/XOR/ECB, LSB-first reads and
  Huffman decoding of the blob were all tried and ruled out — the
  bitstream is in the clear.

V1 (separate, older format) framing was cracked first on purpose-built
oracle TCIs and holds exactly: `[ver=01][compbits u32][frames u32]` then
`[k:8][201 x k-bit samples]`, continuous MSB-first, `frames-1` samples
total, exact `compbits`. Proven on 8 oracles (dc_pos/neg, counter,
ramp441, ramp_oracle, 120hz, block8, diag8).

## 1b. Trigger Instrument Editor variant

Files written by Slate's Trigger Instrument Editor share the `TRIGGER `
magic but are a different container: tag `COMPRESSED INSTRUMENT` at
offset 8, header u32s `[1, 8, 4, ...]` at 64, no zlib/`VC2!` footer.
Layout: 128-byte file header (magic + name + two u32 rows, incl. 44100),
then waves chained by 8-byte gap records `[05][prev_wave_span_bytes LE]`
terminated by `[06][0]` + a small u32/float params table to EOF. Each
wave is plain V1 (`[01][comp LE][frames LE]`, sign-magnitude
residuals — an early two's-complement reading was overturned by a real
drum recording, which two's complement decodes as full-scale
distortion) and must consume `comp` bits with `frames-1` samples exactly
— proven bit-exact on a user-built 4-wave file (88,200/44,100/88,200/
44,100 frames). The app detects V2 → V1 → Editor in order; Editor waves
export grade A like V1 singles.

## 2. The two things that matter

**Sign-magnitude everywhere.** Every integer sample — raw head samples
and every residual bit — is sign-magnitude, never two's complement.
Raw: `-(v & 0x7FFFFF)` if `v & 0x800000`. Residuals: first bit is sign,
rest is magnitude (`k=1` always decodes to 0). This matches the voice
decoder disassembly (`negl`/`cmov` sign handling in the inner loop).
Two's-complement decoding gives attack correlation ~0.68 and full-scale
spikes; sign-magnitude gives ~0.99+ with spikes gone.

**Tails are V1 blocks.** After the head, the stream is `[k:8][201 x
k-bit]` blocks, `k = 1..24`, MSB-first, no padding. Decode must consume
the stream to end-of-bits.

**Voice rule.** Decode consumes ALL bits; the voice plays exactly the
first `frames` samples — truncate over-long decodes, zero-pad short
ones (verified: kick w10 decodes 25 samples past `frames`; snare w17
decodes 1 short).

## 3. Head families (all three occur)

1. **Raw head** — `N` 24-bit big-endian sign-magnitude samples, then V1
   tail. Kick w0/w1/w3 and snare w00–04 use `N = 200` (600 bytes, tail
   starts at bit 4800).
2. **Single attack block** — `S` side bits, one width byte, `C`
   k-bit samples, tail from bit `T` (`S + 8 + C*k == T`). Kick: mostly
   `C = 198/199`, `k = 20/21/23`, `S = 14/28/36/39`. Snare: `C ≈
   197/200/201`, `k = 20–24`, `S = 0–193`.
3. **Multi-block head** — snare w17–19: six consecutive
   `[byte=20][201 x 20-bit]` blocks (1206 samples), tail from 24168.
4. **tailN head** — Z leading zero bytes, then V1 tail (no attack block;
   transient at the tail start). Short pads ok. Preferred over k==1
   "silence" fits (vacuous: zeros always score 0.0); k==1 singles are
   last-resort only and never win on byte bonus. Tail must still consume
   to end-of-bits (tolerance 64 bits of trailing pad).

The width byte does NOT always equal `k`: kick attack bytes include
145/149/29/62/75 (all → k=23), 142/129 (→ k=20), 22/140 (→ k=21). Tail
bytes are identity (`byte == k`), as are snare w17–19's head bytes
(`20 → k=20`). Byte 0 maps to several widths (24/21/22) depending on
wave — the full byte→(k, count) table (3 tables in the binary, see §6)
is still unextracted, which is why new heads need solving (§4) instead
of table lookup.

## 4. Method for an unknown wave

1. **Run-scan.** Find bit offsets starting long 201-count V1 chains
   (`solve_wave.run_scan`). Each is a candidate tail start `T`.
2. **Count the tail** (`tail_count`) to end-of-bits. `need = frames −
   tail` ≈ head samples (≈200 for attacks, ≈1200 for snare w17-type).
3. **Fit the head.** Exact fits `S + 8 + C*k == T` with `C` near `need`
   (`single_fits`). Several fits usually match (sub-segment ambiguity).
4. **Disambiguate.** In order of reliability:
   - ground-truth correlation (decode → FFT-normalized correlation vs a
     DAW render; true parse gives 1.0 at lag 0);
   - **sibling oracle** (`sibling_ncc`): correlate the candidate attack
     against a known attack from the same drum — amplitude-invariant,
     works across velocities (snare w16 scored 0.98);
   - exact total length (`C + tail == frames`, but beware: the
     length-exact fit is NOT always true — kick w10's true parse
     overshoots by 25 and truncates);
   - attack smoothness (mean abs diff ~10k = audio, ~500k = misframed
     noise) + listening.
5. **Traps.**
   - *Longest run ≠ true tail.* A misframed first block can extend a
     run backward over head data (kick w2's 19-bit block spans exactly
     to bit 4599; kick w7's 2-bit block decoded as a wall of noise;
     snare w16's 9-bit block). Always confirm by full-decode length +
     correlation/ears.
   - *Identity peel* (`identity_peel`) maps `[byte==k]` block chains
     but runs through head AND tail — it finds structure, not the
     boundary. Combine with length fits.

## 5. Stereo (NRG/SSDR/OH): tails CRACKED, heads still open

- Footer gives the joint-stream layout away: `wd{i}samples = 2 * frames`
  (e.g. 164430 for 82215 frames), so a stereo wave is ONE stream of
  `2 * frames` sign-magnitude samples, not two separate wave bodies.
- Sample `N` of that joint stream is L when `N` is even and R when `N` is odd,
  counted over the WHOLE stream. Block-interleave and sequential-halves both
  score ~0.1 (noise); global-index parity is the one that is smooth. Because
  a V1 block holds an odd 201 samples the parity alternates block by block, so
  deinterleaving must use the global index, not the position inside a block.
- From the tail start on, the joint stream is a chain of plain V1 blocks
  `[k:8][201 x k-bit]`, and the chain consumes `wd{i}comp1` to within 31
  trailing pad bits. `k = 1..24` (`k = 1` always decodes to 0).
- Tail location is therefore a boundary problem, not a search for structure:
  scan bit offsets for a width byte in `1..24`, walk blocks, and accept the
  chain that ends within 64 bits of `comp`. Every block boundary inside a real
  tail qualifies, so the SMALLEST head wins.
  - Chance matches inside the head are real (its bits are high-entropy audio
    and ~9% of byte values look like a width byte), but a chain has to survive
    millions of bits to reach the end, which they never do. Measured over the
    whole library: **3902/3902 stereo waves decode, 0 unsolved, 0 clipped**,
    heads `0..400` joint samples (median 186, i.e. ~93-100 frames ≈ 2 ms),
    tail start `0..7236` bits, median 5 ms per wave in JS.
  - A smoothness filter on the first blocks was tried and rejected: it looked
    principled but rejected genuine noisy snares, pushing heads to p99 2204 /
    max 3215. The plain min-head rule is both simpler and correct here.
- Heads (0..400 joint samples, `0.6..2.3 ms`) use a non-V1 table/caller path
  and are still NOT decoded. Exhausted statically: raw battery, V1 1/2/3-block
  and multi±side grids (k ≤ 32), XOR/nibble/bitrev, content table searches,
  sibling and cross-wave alignment, smoothness oracles. All exact-fit V1 head
  parses decode as noise.
- Shipped behaviour: export the exact tail, leave the unresolved head frames
  silent, and say so. Grade `B` with `head:93fr silent` in `MAP.txt`. Nothing
  is guessed and no stereo wave is skipped.
- Reversal notes: real mask/sign tables extracted from the fat binary
  (`table1` file `0x5C10D0`, `table2` `0x5C1160`, `table3` `0x5C11F0`;
  vaddr = file − `0x4000`): `table1[b]`/`table2[b]` confirm k = byte
  (magnitude mask + sign bit) for bytes 0–32, so the V1 tail parse is
  bit-exact per the voice's own tables. Voice decoder `0x29e2a0`,
  setup `0x28e389` (blob byte 0 → tables, bitpos = 8), per-block params
  carried in voice-struct fields (`0x18c` width, `0x238` bitpos,
  `0x258/0x25c/0x260` mask/sign/t3); loop1 uses caller params, loop2
  reads width bytes + tables. Head blocks (width bytes > 32) bypass the
  tables via caller-provided (k, count) — that caller mapping is the
  remaining gap (needs lldb logging once headless AU triggering works,
  or a caller-dataflow dive).

## 6. Web app

- Dark by default, light on request, remembered in `localStorage`.
- **Preview.** Every exported wave is auditionable from the results table (and
  from the batch queue's per-file button). Preview only ever touches
  `<audio>.volume`, so exports stay bit-exact. Defaults to 35% (-9.1 dBFS)
  because decoded drum transients routinely hit full scale, and ramps in over
  25 ms so a full-scale attack does not click. The panel shows each sample's
  peak in dBFS and flags anything at or above -0.2 dBFS.
- **Batch.** `<input webkitdirectory>` takes a library folder; each `.tci` is
  decoded in a small worker pool and streamed into one ZIP as
  `<Category>/<Instrument>/<MIC>/`, matching the Python CLI. Progress, ETA,
  per-file status and a cancel button; failed files are reported, never fatal.
  `zip.js` appends one entry at a time (deflate when it shrinks, store
  otherwise) so a multi-gigabyte run never materialises the whole archive, and
  only the six most recent instruments keep their audio buffers alive for
  previewing.

## 7. Verification

- `web/stereo.js` and `py/stereo.py` are two independent implementations of
  the decoder. They agree **byte for byte** on the L/R sample data, and the
  web app and the Python CLI agree byte for byte on exported WAVs and
  `MAP.txt` (44/44 files across stereo and mono instruments).
- Full library: 3902 stereo waves, all decoded, 0 clipped samples.
- `web/zip.js` archives were parsed back with python `zipfile`: CRCs match,
  deflate and store entries both inflate, folders and UTF-8 names round-trip.
- JS: `node --test web/tests` (parity harness; hashes only, no audio in repo).
  Python: `python3 py/tci_export.py --lib /path/to/library "ACKick"` for a
  single-instrument check.
