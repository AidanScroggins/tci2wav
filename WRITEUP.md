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

## 5. Proven results

ACKick Z3 (12 waves), verified vs `ACKickZ3_layers.wav` (18 hits):

| wave | parse | corr | hit |
| ---- | ----- | ---- | --- |
| w0/w1/w3 | raw200 + tail | 1.0 / ~0.99 attack | 15/12/14 |
| w2 | S14 k23 C199 T4599 | 0.999 | 13 |
| w4/w5 | S14 k23 C199 T4599 | 1.0 | 9/6 |
| w6 | S14 k23 C199 T4599 | 0.9993 | 7 |
| w7 | S14 k23 C199 T4599 | 1.0 | 8 |
| w8 | S28 k20 C198 T3996 | 1.0 | 4 |
| w9/w11 | S39 k21 C198 T4205 | 1.0 | 0/2 |
| w10 | S36 k20 C198 T4004 (truncate to frames) | 1.0 | 1 |

Reference details: voice gain ≈ 0.496, 1-sample pipeline lag (compare
lag-corrected); attack transients decode hotter than the voice plays
them (voice envelopes), hence attack-only corr ~0.99 while full-wave is
1.0. w2/w6 sit 1 sample off (0.999) — inaudible onset nuance.

SlateSnare Z3 (20 waves): no ground-truth render exists, so structural
+ ear-verified. w00–04 raw200 (length-exact); w17–19 six k=20 blocks
(identity bytes, length-exact, smooth hot attacks); w05–11/13/14/16
single attack blocks (sibling 0.74–0.98); w12/w15 picked from two
candidates by smoothness. All 20 exports confirmed by ear. Exact specs
in `render_tci.py` (`SNARE_STRUCTS`).

## 6. Disassembly notes (for finishing the table job)

Unpacked binary (`Trigger_2.component`, PACE-packed on disk; analysis
done on a memory dump): wave voice decoder at `0x29e2a0`, setup at
`0x28e389` (reads blob byte 0 + 3 tables near `0x5BD0D0`, bitpos starts
at 8). Inner loop reads one width byte per block, maps it through 3
tables (mask, sign bit, count?) — the three `lea rip+...` at
`0x29e413/28/3e` target `0x5BD0D0/160/1F0`, tables spaced `0x90`. A
lengths run (227 symbols) sits at file offset `0x8A1C00` (= vaddr −
`0x2E4C30` mapping). Extracting table3 (block counts) would make all
head parsing deterministic. Wave structs (`44100` + `0xC900` +
`1.0f`) are findable in heap dumps. AU-side work (headless state
restore, param IDs, TriggerHost MIDI triggering) was explored and is
deliberately excluded from this folder — offline decoding made it
unnecessary.

## 7. Files here / elsewhere

- This folder: `tci_decode.py`, `render_tci.py`, `solve_wave.py`,
  `render_library.py` (family batch exporter, waveXX+grade names +
  REPORTs), `tci_export.py` (unified V1/V2/mono/stereo exporter:
  `FAMILY_MIC_V##_RR#.wav` + MAP.txt; velocity by attack-peak rank,
  round robins grouped at peak ratio < 1.12; stereo heads capped at
  grade C, unsolved stereo skipped as X), `tci_web.py` (this toolkit as
  a local web app: upload mono V1/V2 `.tci` in the browser, download a
  zip of velocity-named WAVs + MAP.txt; stereo waves listed as skipped),
  this writeup.
- Decoded WAVs: `Trigger2Library/V2_DECODED_SM/` (kick `*_sm.wav`,
  snare in `SlateSnareZ3/`).
- Ground truth: `Trigger2Library/ACKickZ3_layers.wav`,
  `ACKickSSDR_layers.wav`, and `Reference for ACKickZ3_wave00…wav`.
- Inputs: `TCI Crack - v2 (ACKick Z3)/ACKick Z3.tci`,
  `Trigger2Library/Trigger2 Snares/SlatesSnare/SlateSnare Z3.tci`.
- V1 oracle TCIs (`dc_pos`, `counter`, `ramp441`, …) in
  `Trigger2Library/`.
- Open: snare byte-0→width table, table3 extraction (§6), zero-crossing
  click check on the first ~6 ms (user-flagged direction), remaining
  velocities beyond these two instruments.

## 8. Stereo (NRG/SSDR/OH) status

- Layout CRACKED by ear: tails are V1 201-blocks with L/R
  SAMPLE-interleaved inside every block (even samples = one channel,
  odd = the other). Block-interleave and sequential-halves score ~0.1.
- Footer gives it away: `wd{i}samples = 2 * frames` (e.g. 164430).
- `render_library.py` still skips `stereo=1` waves: heads (~165 samples)
  use a non-V1 table/caller path. Exhausted statically: raw battery,
  V1 1/2/3-block and multi±side grids (k ≤ 32), XOR/nibble/bitrev,
  content table searches, sibling and cross-wave alignment, smoothness
  oracles. All exact-fit V1 head parses decode as noise.
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
