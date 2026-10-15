/* The workshop's own engines, loaded into Node.

   Nearly every tool on this site is already built in two halves: the
   arithmetic in modules of its own, and a `script.js` that is the only thing
   touching the DOM. The chiptune tracker keeps its chip in apu.js, the PDF
   toolkit keeps a whole PDF implementation across twelve files, Sound Spectrum
   keeps its transform in fourier.js, and three of them ship a selftest.js that
   already says it runs under node. None of that was done for this server — it
   is how the tools were written — and it is the reason this one can be thin.

   So nothing here reimplements anything. Each tool's engine is required as it
   stands, in the order its own index.html loads it in, and the server drives
   the same code the page drives. A song rendered here is the page's render; a
   blackout applied here removes the same bytes the page removes. There is no
   second implementation to drift.

   The modules export onto `globalThis` through an IIFE, which is what makes
   this work at all: no bundler, no shims, no edits. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* The repository root: two levels up from mcp/lib/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* Load a tool's scripts, in order.

   Order is not a detail. song.js reads APU off the shared root at load time for
   FRAME_HZ and NOTE_MAX, so loading it first yields a module whose tempo
   arithmetic is NaN; the PDF files have a similar chain through twelve of them.
   The lists below are copied from each tool's own index.html for that reason,
   and `verify` names something the namespace must have once it is all in, so a
   wrong order fails here rather than somewhere subtle later. */
export function load(dir, files, verify) {
  for (const file of files) {
    try {
      require(path.join(ROOT, dir, file));
    } catch (err) {
      throw new Error('could not load ' + dir + '/' + file + ' from ' + ROOT + ': ' + err.message);
    }
  }
  if (verify && !globalThis[verify]) {
    throw new Error('loaded ' + dir + ' but found no ' + verify + ' — the file list is wrong or incomplete');
  }
  return verify ? globalThis[verify] : undefined;
}
