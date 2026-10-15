/* The page's sound chip, loaded into Node.

   chiptune-tracker/apu.js and song.js touch neither the DOM nor the Web Audio
   API, and both close over `typeof window !== "undefined" ? window : globalThis`,
   so they load here unmodified. That is the whole reason this server can exist
   cheaply: it is not a second implementation of the 2A03 that has to be kept in
   step with the first one, it is the first one. A song composed through these
   tools and a song typed into the page go through the same arithmetic, and the
   WAV written here is the WAV the page would have exported.

   Same arrangement as tools/abecedarian-corpus.mjs, which runs the Abecedarian
   page's engine over thirteen dictionaries rather than a copy of it. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const TRACKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Order matters: song.js reads APU off the same root object at load time, for
   FRAME_HZ and NOTE_MAX. Requiring it first gets a song module whose tempo
   arithmetic is NaN and whose note clamp is undefined. */
require(path.join(TRACKER_DIR, 'apu.js'));
require(path.join(TRACKER_DIR, 'song.js'));

export const APU = globalThis.APU;
export const Song = globalThis.Song;

if (!APU || !Song) {
  throw new Error('could not load the tracker engine from ' + TRACKER_DIR);
}
