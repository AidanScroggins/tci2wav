# tci2wav

## Note from the author
This app is 100% vibe-coded. I am not a programmer, just an audio enthusiast looking for a solution to my problem. Please feel free to suggest improvements, pull requests, or fork this. This project is a clean room style reverse engineering job made possible using the OpenCode Agent and Muse Spark 1.3.

Decode Steven Slate Trigger 2 `.tci` sample files — V1 and V2, mono and
stereo — in your browser or on the command line, and export
velocity-named WAVs.

**Live app:** `https://AidanScroggins.github.io/tci2wav/` (static site, works
offline; your files never leave your machine)

## Naming

`SAMPLEFAMILY_MIC_V##_RR#.wav` — e.g. `ACKick_Z3_V01_RR1.wav`
(lowest velocity, first round robin). V = velocity level ascending by
attack-peak, RR = round robin within equal-level groups (peak ratio < 1.12).
Every export ships a `MAP.txt` mapping each file back to its wave index,
parse, and grade.

Grades: `A` exact+smooth, `B` close, `C` verify by ear, `X` skipped.
Stereo heads use an unsolved table path and are listed as skipped, never
shipped headless. See `WRITEUP.md` for the full reverse-engineering notes.

## Layout

- `web/` — the browser app (GitHub Pages root): upload a mono V1/V2
  `.tci`, download a ZIP of velocity-named WAVs + MAP.txt. Pure
  client-side JavaScript, no server, no uploads.
- `py/` — the reference Python toolkit (needs numpy): core decoder,
  structural solver, batch + unified exporters, and the original
  local web app.
- `WRITEUP.md` — container format, sign-magnitude bitstream, head
  families, solver method, verification results, open problems.

## Local CLI quickstart

```sh
pip install numpy
python3 py/tci_export.py "ACKick Z3"   # V/RR-named WAVs + MAP.txt per mic folder
python3 py/tci_web.py                  # original local server version
node --test web/tests                  # JS parity harness (hashes, no audio in repo)
```

## IP note

This repo contains only original decoder code and docs — no Slate `.tci`
files and no decoded audio. Bring your own Trigger 2 library.
