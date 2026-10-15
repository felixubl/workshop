/* The PDF Toolkit's engine: a PDF implementation written from scratch, with no
   library parsing, rendering or writing anything.

   Twelve modules and about 6,700 lines, none of which touch the DOM — the
   page's own selftest.js already says it runs under node, and it does, 13 of
   13. The file list and its order are copied from pdf-toolkit/index.html,
   because the modules build one shared namespace and later ones read earlier
   ones as they load.

   pdf-render.js is loaded for its blend-mode table and its colour helpers.
   Rendering a page to pixels needs a canvas and is not something these tools
   do; reading text out of one does not, because the box a glyph occupies is
   arithmetic over the content stream. */

import { load } from '../lib/engine.mjs';

export const PDF = load('pdf-toolkit', [
  'pdf-lex.js',
  'pdf-filters.js',
  'pdf-doc.js',
  'pdf-write.js',
  'pdf-ops.js',
  'pdf-font.js',
  'pdf-fontmap.js',
  'pdf-render.js',
  'pdf-image.js',
  'pdf-marks.js',
  'pdf-redact.js',
  'pdf-meta.js',
], 'PDF');

/* Parse a file into a document. Everything else here takes one of these. */
export function parse(bytes, where) {
  let doc;
  try {
    doc = new PDF.PDFDocument(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    doc.parse();
  } catch (err) {
    throw new Error((where ? where + ' ' : '') + 'could not be read as a PDF: ' + err.message);
  }
  if (!doc.pages || !doc.pages.length) {
    throw new Error((where ? where + ' ' : '') + 'has no pages the parser could find.');
  }
  return doc;
}
