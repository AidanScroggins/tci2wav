# tci2wav

## Note from the author
This app is 100% vibe-coded. I am not a programmer, just an audio enthusiast looking for a solution to my problem. Please feel free to suggest improvements, pull requests, or fork this. This project is a clean room style reverse engineering job made possible using the OpenCode Agent and Muse Spark 1.3.

Decode Steven Slate Trigger 2 `.tci` sample files — V1 and V2, mono and
stereo — in your browser or on the command line, and export
velocity-named WAVs. Batch mode takes a whole library folder.

**Live app:** `https://AidanScroggins.github.io/tci2wav/` (static site, works
offline; your files never leave your machine)

## Naming

`SAMPLEFAMILY_MIC_V##_RR#.wav` — e.g. `ACKick_Z3_V01_RR1.wav`
(lowest velocity, first round robin). V = velocity level ascending by
attack-peak, RR = round robin within equal-level groups (peak ratio < 1.12).
Every export ships a `MAP.txt` mapping each file back to its wave index,
parse, and grade.

Grades: `A` exact+smooth, `B` close, `C` verify by ear, `X` skipped.

Stereo waves (`NRG`/`SSDR`/`OH`) are exported as 2-channel WAVs: the tail is
decoded exactly and the ~2 ms attack head comes from a table path that is not
decoded yet, so those frames are left silent and flagged `B` in `MAP.txt`
(`head:93fr silent`) rather than guessed or skipped. See `WRITEUP.md` for the
full reverse-engineering notes.

## Layout

- `web/` — the browser app (GitHub Pages root): upload one `.tci` or a whole
  folder, audition every converted wave with a safe volume control, and
  download velocity-named WAVs + MAP.txt. Pure client-side JavaScript, no
  server, no uploads.
  - `decode.js` / `solve.js` / `stereo.js` — container parsing, mono solver,
    stereo decoder
  - `zip.js` — streaming ZIP writer (deflate when it helps) so a folder run
    never holds the whole export in memory
  - `naming.js` — folder path → family / mic / output directory rules
  - `export.js` / `worker.js` / `app.js` — WAV + MAP output, off-thread decode,
    UI
- `py/` — the reference Python toolkit (needs numpy): core decoder,
  structural mono solver, stereo tail decoder, batch + unified exporters, and
  the original local web app.
- `WRITEUP.md` — container format, sign-magnitude bitstream, head
  families, solver method, verification results, open problems.

## Local CLI quickstart

```sh
pip install numpy
export TCI2WAV_LIB=/path/to/Trigger2Library   # or pass --lib
python3 py/tci_export.py --lib /path/to/library "ACKick Z3"   # V/RR-named WAVs + MAP.txt
python3 py/tci_web.py                  # original local server version
node --test web/tests                  # JS parity harness (hashes, no audio in repo)
```

No file paths are baked into the repo. `TCI2WAV_LIB` points at your Trigger 2
library (default `~/Trigger2Library`) and `TCI2WAV_OUT` at the write target
(default `<library>/TCI-Exports`); both tools also take `--lib DIR` and
`--out DIR`. The browser app needs neither — it decodes entirely client-side.

## IP note

This repo contains only original decoder code and docs — no Slate `.tci`
files and no decoded audio. Bring your own Trigger 2 library.
