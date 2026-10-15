/* The tracker's sound chip: chiptune-tracker/apu.js and song.js, as the page
   loads them. Neither touches the DOM or the Web Audio API, so both run here
   unchanged — which is why the WAV this server writes is the WAV the page
   would have exported, and why the test suite can assert that sample for
   sample rather than approximately. */

import { load } from '../lib/engine.mjs';

/* apu.js first: song.js reads FRAME_HZ and NOTE_MAX off it as it loads. */
load('chiptune-tracker', ['apu.js', 'song.js'], 'APU');

export const APU = globalThis.APU;
export const Song = globalThis.Song;
