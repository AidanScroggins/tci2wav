/* Maintainer-only bit-exact parity vs the Python pipeline.
   Needs Slate files (NOT in repo): set env before running:
     TCI_KICK=/path/to/ACKick\ Z3.tci TCI_SNARE=/path/to/SlateSnare\ Z3.tci
     node --test tests/parity-local.mjs
   Without env vars the file passes silently (CI skips). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../decode.js');
const E = require('../export.js');
const GOLD = JSON.parse(readFileSync(new URL('./goldens.json', import.meta.url)));

const KICK_STRUCTS = {
  0: ['raw', 200], 1: ['raw', 200], 3: ['raw', 200],
  2: ['blk', 14, 23, 199, 4599], 4: ['blk', 14, 23, 199, 4599],
  5: ['blk', 14, 23, 199, 4599], 6: ['blk', 14, 23, 199, 4599],
  7: ['blk', 14, 23, 199, 4599], 8: ['blk', 28, 20, 198, 3996],
  9: ['blk', 39, 21, 198, 4205], 10: ['blk', 36, 20, 198, 4004],
  11: ['blk', 39, 21, 198, 4205],
};
const SNARE_STRUCTS = { 0: ['raw', 200], 1: ['raw', 200], 2: ['raw', 200],
  3: ['raw', 200], 4: ['raw', 200],
  5: ['blk', 0, 24, 200, 4808], 17: ['blocks', Array(6).fill([20, 201]), 24168] };

const KICK = process.env.TCI_KICK;
const SNARE = process.env.TCI_SNARE;

test('kick bit-exact parity (proven specs)', { skip: !KICK || !existsSync(KICK) }, async () => {
  const waves = await D.parseV2(new Uint8Array(readFileSync(KICK)));
  assert.equal(waves.length, 12);
  for (let i = 0; i < 12; i++) {
    const v = D.applyVoiceRule(D.decodeWave(waves[i].blob, waves[i].frames, KICK_STRUCTS[i]), waves[i].frames);
    const wav = E.exportMonoWav(v);
    const h = createHash('sha256').update(wav).digest('hex');
    assert.equal(h, GOLD[`kick_w${String(i).padStart(2, '0')}`], `wave ${i}`);
  }
});

test('snare spot parity', { skip: !SNARE || !existsSync(SNARE) }, async () => {
  const waves = await D.parseV2(new Uint8Array(readFileSync(SNARE)));
  for (const i of [0, 5, 17]) {
    const v = D.applyVoiceRule(D.decodeWave(waves[i].blob, waves[i].frames, SNARE_STRUCTS[i]), waves[i].frames);
    const h = createHash('sha256').update(E.exportMonoWav(v)).digest('hex');
    assert.equal(h, GOLD[`snare_w${String(i).padStart(2, '0')}`], `wave ${i}`);
  }
});
