/* Reading the text off a page, and finding where on the page it sits.

   The toolkit has no text extraction: the page it serves has no search box and
   never needed one. An agent does. Asked to take a name out of a PDF it cannot
   look at the thing, so "redact this rectangle" is useless to it — it needs
   "redact this name", which means something has to turn the name into the
   rectangle the name occupies.

   That rectangle has to be the one the redactor would compute. Nothing in a
   content stream says where a glyph lands; it follows from everything before
   it, through the transformation matrix, two text matrices and the text state.
   So a second interpreter written here would be a second opinion about where a
   character sits, and the two would disagree on exactly the material a second
   opinion is hard to come by on — rotated text, Type 3 fonts, nested forms.
   The failure would be silent and the wrong way round: the search says it
   found the name, the redactor covers a box the name is not in, the name stays
   in the file, and the tool reports success.

   So there is no second interpreter. pdf-redact.js grew a one-line hook that
   reports each character and its box, and a read is that same walk with no
   rectangles to cover anything. The search and the redaction cannot disagree
   because they are the same arithmetic.

   What is written here is only the part the redactor has no opinion about:
   which glyphs form a line, and where the spaces go. A content stream does not
   say. */

import { PDF } from './engine.mjs';

/* A glyph's box comes back as four corners, because text can be rotated. The
   upright box around them is what lines and searches are built on, which is
   also how the redactor measures coverage. */
function upright(box) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of box) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/* True when the four corners form an axis-aligned rectangle. Rotated text can
   be read and searched, but the box around a run of it covers more than the
   run, so a redaction driven from one is reported as needing a look. */
function axisAligned(box) {
  const xs = new Set(box.map((p) => Math.round(p[0] * 100)));
  const ys = new Set(box.map((p) => Math.round(p[1] * 100)));
  return xs.size <= 2 && ys.size <= 2;
}

export function glyphsOf(doc, page) {
  const glyphs = [];
  const redactor = new PDF.redact.Redactor(doc, [], null);
  redactor.onGlyph = (ch, box) => {
    if (!ch) return;
    const u = upright(box);
    /* A zero-area box is a glyph scaled to nothing — present in the stream,
       invisible on the page, and not something a reader would ask about. */
    if (!(u.x1 > u.x0) || !(u.y1 > u.y0)) return;
    glyphs.push({ ch, ...u, em: (u.y1 - u.y0) / 1.1, upright: axisAligned(box) });
  };
  redactor.page(page);
  return { glyphs, unsure: redactor.unsure };
}

/* Group glyphs into lines, then order each line left to right.

   Grouped on the vertical middle of the box rather than the baseline, because
   a superscript and the text it hangs off share a line and not a baseline. The
   tolerance is a share of the character height, so it scales with the type. */
export function linesOf(glyphs, options) {
  const tolerance = (options && options.lineTolerance) || 0.5;
  const spaceAt = (options && options.spaceGap) || 0.25;

  const rows = [];
  for (const g of glyphs) {
    const middle = (g.y0 + g.y1) / 2;
    let row = null;
    for (const candidate of rows) {
      if (Math.abs(candidate.middle - middle) <= tolerance * Math.min(candidate.em, g.em)) {
        row = candidate;
        break;
      }
    }
    if (!row) {
      row = { middle, em: g.em, items: [] };
      rows.push(row);
    }
    row.items.push(g);
    /* Keep the running middle honest as a line fills out, and the smallest em
       on it, so a line of mixed sizes groups on the tighter tolerance. */
    row.middle = (row.middle * (row.items.length - 1) + middle) / row.items.length;
    row.em = Math.min(row.em, g.em);
  }

  /* Reading order: down the page, then across. PDF space has y upwards. */
  rows.sort((a, b) => b.middle - a.middle);

  return rows.map((row, index) => {
    const items = row.items.slice().sort((a, b) => a.x0 - b.x0);

    /* A content stream has no space character — a space is a gap. Anything
       wider than a quarter of an em reads as one, which is the usual threshold
       and wrong only for type set unusually tight or loose. */
    let text = '';
    const map = [];   // one entry per character: its glyph, or null for a gap
    let previous = null;
    for (const g of items) {
      if (previous && g.x0 - previous.x1 > spaceAt * Math.max(previous.em, g.em)) {
        text += ' ';
        map.push(null);
      }
      text += g.ch;
      for (let i = 0; i < g.ch.length; i++) map.push(g);
      previous = g;
    }

    const u = items.reduce((acc, g) => ({
      x0: Math.min(acc.x0, g.x0), y0: Math.min(acc.y0, g.y0),
      x1: Math.max(acc.x1, g.x1), y1: Math.max(acc.y1, g.y1),
    }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

    return {
      index, text, map, items,
      x0: u.x0, y0: u.y0, x1: u.x1, y1: u.y1,
      upright: items.every((g) => g.upright),
    };
  });
}

export function readPage(doc, page, options) {
  const { glyphs, unsure } = glyphsOf(doc, page);
  const lines = linesOf(glyphs, options);
  return { lines, glyphCount: glyphs.length, unsure, text: lines.map((l) => l.text).join('\n') };
}

export function readAll(doc, options) {
  return doc.pages.map((page, index) => ({ page: index, ...readPage(doc, page, options) }));
}

/* ── Finding something ─────────────────────────────────────────────────────── */

function boxOfRange(line, start, end) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let upright = true;
  let glyphs = 0;
  for (let i = start; i < end; i++) {
    const g = line.map[i];
    if (!g) continue;       // a gap, which has no ink and no box
    glyphs++;
    if (g.x0 < x0) x0 = g.x0;
    if (g.y0 < y0) y0 = g.y0;
    if (g.x1 > x1) x1 = g.x1;
    if (g.y1 > y1) y1 = g.y1;
    if (!g.upright) upright = false;
  }
  if (!glyphs) return null;
  return { x0, y0, x1, y1, upright, glyphs };
}

/* Search one page's lines.

   Per line, not across the whole page: a match is only useful here if it comes
   with a box, and text that wrapped onto a second line occupies two boxes in
   two places. A caller that needs a wrapped phrase gets told it was not found
   rather than given one rectangle spanning both — the tools report what they
   searched and what they matched, so a miss is visible rather than assumed. */
export function findInLines(lines, needles, options) {
  const caseSensitive = !!(options && options.caseSensitive);
  const regex = !!(options && options.regex);
  const found = [];

  for (const needle of needles) {
    let pattern;
    try {
      pattern = regex
        ? new RegExp(needle, caseSensitive ? 'g' : 'gi')
        : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw new Error('"' + needle + '" is not a valid regular expression: ' + err.message);
    }

    for (const line of lines) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line.text))) {
        if (match[0] === '') { pattern.lastIndex++; continue; }
        const box = boxOfRange(line, match.index, match.index + match[0].length);
        if (box) found.push({ needle, text: match[0], line: line.index, ...box });
      }
    }
  }
  return found;
}

/* The marks the redactor takes. Exactly the glyph boxes and no margin: each
   matched character is then wholly covered, while a neighbour that merely
   touches the box keeps its ink — the redactor drops a glyph once a third of
   it is covered, so padding "to be safe" is how a character nobody asked
   about disappears. */
export function marksFor(matches) {
  return matches.map((m) => ({
    kind: 'censor',
    x: m.x0, y: m.y0, w: m.x1 - m.x0, h: m.y1 - m.y0,
  }));
}
