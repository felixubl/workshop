/* The printer.
 *
 * A bingo card is a page with a grid on it, which is about the least a PDF can
 * be asked to do — so this writes the file itself rather than pulling a
 * generator in. That is the same position the PDF Toolkit takes next door, for
 * the same reason: the whole site is checkable client-side code, and a tool
 * that ships a minified megabyte to draw twenty-five rectangles has stopped
 * being checkable.
 *
 * What it costs is the font. Nothing is embedded here — the pages ask for
 * Helvetica, which is one of the fourteen faces every PDF reader has had built
 * in since 1993, so the file stays a few kilobytes a page and opens anywhere.
 * The price of that bargain is the encoding: a base-14 font is addressed one
 * byte at a time through WinAnsi, so the alphabet is Latin-1 and no wider.
 * `toWinAnsi` below folds what it can (é survives, č becomes c) and reports
 * what it cannot, and the tool says so on the page before anyone presses a
 * button. Embedding a subset of a real face is the fix, and it is a font
 * subsetter's worth of work rather than a flag.
 */

;(function (Bingo) {
  "use strict";

  /* ── Metrics ───────────────────────────────────────────────────────────
     Adobe's own AFM widths for Helvetica and Helvetica-Bold, in 1/1000 em,
     indexed by WinAnsi byte from 0x20. They are needed because every piece of
     text on a card is centred in a box it has to be measured against first,
     and the reader's copy of Helvetica is the one doing the drawing — the
     browser's idea of how wide a string is would be a different font's answer.
     A zero is a code WinAnsi leaves undefined; nothing ever encodes to one. */

  const W_REGULAR = [
    278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    222, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
    556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
  ];

  const W_BOLD = [
    278, 333, 474, 556, 556, 889, 722, 278, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    278, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
    556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 889, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
    611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
  ];

  // Cap height, as a fraction of the em. Helvetica's is 0.718, and it is the
  // right number to centre on: a line of type looks centred when its capitals
  // straddle the middle, not when its baseline does.
  const CAP = 0.718;

  /* ── WinAnsi ───────────────────────────────────────────────────────────
     The twenty-seven codes CP1252 puts in the C1 range, which is the only part
     of WinAnsi that is not either ASCII or Latin-1. Typing an em dash or a
     curly quote into the entry list is ordinary enough that losing them would
     be noticed. */
  const C1 = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
    0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
    0x017e: 0x9e, 0x0178: 0x9f,
  };

  // One character in, zero or more WinAnsi bytes out, or null for a character
  // the encoding has no answer for at all.
  //
  // The decomposition step is what saves the near misses. Latin-1 covers the
  // accents of western Europe and stops; NFD splits anything else into a base
  // letter and a combining mark, and the base letter is usually plain ASCII. So
  // č arrives as c + caron, the caron is dropped, and the word stays readable
  // instead of turning into a run of question marks. It is a loss and the tool
  // says so — but "Cesko" is a legible card and "?esko" is not.
  function encodeChar(ch) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) return [code];
    if (code >= 0xa0 && code <= 0xff) return [code];
    if (C1[code] !== undefined) return [C1[code]];

    const decomposed = ch.normalize("NFD");
    if (decomposed !== ch) {
      const out = [];
      for (const part of decomposed) {
        const p = part.codePointAt(0);
        // Combining marks (U+0300–U+036F) are what the decomposition was for;
        // they go, and whatever they were sitting on stays.
        if (p >= 0x0300 && p <= 0x036f) continue;
        const bytes = encodeChar(part);
        if (bytes) out.push(...bytes);
      }
      if (out.length) return out;
    }
    return null;
  }

  // Returns the bytes as a string whose char codes ARE the bytes, which is the
  // form everything downstream wants: widths index by it, and the serializer
  // masks it back to bytes at the end.
  function toWinAnsi(text) {
    let out = "";
    let lost = 0;
    for (const ch of String(text)) {
      // Anything below a space — a stray tab, a lone carriage return — is
      // whitespace to a line breaker and a control code to a PDF. It becomes a
      // space rather than being counted as a loss.
      if (ch < " ") { out += " "; continue; }
      const bytes = encodeChar(ch);
      if (bytes) for (const b of bytes) out += String.fromCharCode(b);
      else lost++;
    }
    return { text: out, lost };
  }

  function widthOf(encoded, size, bold) {
    const table = bold ? W_BOLD : W_REGULAR;
    let units = 0;
    for (let i = 0; i < encoded.length; i++) {
      const w = table[encoded.charCodeAt(i) - 0x20];
      units += w === undefined ? 0 : w;
    }
    return (units / 1000) * size;
  }

  /* ── Setting text in a box ─────────────────────────────────────────────
     Cells hold whatever somebody typed, so the type has to give way rather
     than the box: wrap, and if that is still too tall, come down a step and
     wrap again. */

  function breakWord(word, limit, size, bold) {
    // A single word wider than its cell — a URL, a compound noun, a hashtag.
    // Broken by character, because there is nowhere else to break it.
    const parts = [];
    let piece = "";
    for (const ch of word) {
      if (piece && widthOf(piece + ch, size, bold) > limit) {
        parts.push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    if (piece) parts.push(piece);
    return parts;
  }

  // The places a line is allowed to end. A space is the obvious one and the
  // hyphen is the other: "mid-sentence" has a break in it that a reader
  // already expects, and using it is what lets the phrase stay large instead
  // of shrinking to keep itself on one line. The hyphen stays on the piece it
  // ends, which is the whole point of it.
  function tokenise(encoded) {
    const list = [];
    for (const word of encoded.split(" ").filter(Boolean)) {
      let piece = "";
      const pieces = [];
      for (const ch of word) {
        piece += ch;
        if (ch === "-") { pieces.push(piece); piece = ""; }
      }
      if (piece) pieces.push(piece);
      for (let i = 0; i < pieces.length; i++) {
        list.push({ text: pieces[i], space: i === 0 && list.length > 0 });
      }
    }
    return list;
  }

  // With `hard` off, a token that will not fit its line is a failure and the
  // caller is told so with a null — that is what lets the fitter try a smaller
  // size before it resorts to cutting a word in half. With `hard` on, it cuts.
  function wrap(encoded, limit, size, bold, hard) {
    const lines = [];
    let line = "";
    for (const token of tokenise(encoded)) {
      const candidate = line ? line + (token.space ? " " : "") + token.text : token.text;
      if (widthOf(candidate, size, bold) <= limit) {
        line = candidate;
        continue;
      }
      if (line) { lines.push(line); line = ""; }
      if (widthOf(token.text, size, bold) <= limit) {
        line = token.text;
        continue;
      }
      if (!hard) return null;
      const parts = breakWord(token.text, limit, size, bold);
      lines.push(...parts.slice(0, -1));
      line = parts[parts.length - 1];
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  /* Three passes, in the order a compositor would try them.
   *
   * First: come down in half-point steps looking for the largest size that
   * fits with every word left whole. Most squares are three or four words and
   * this is the only pass that runs.
   *
   * Second: if nothing fit that way above the floor, the square holds a token
   * with no break in it — a URL, a hashtag, a compound somebody ran together —
   * and shrinking to hold it whole would set the whole square at six point to
   * accommodate one word. So the second pass goes back to the top and allows
   * the word to be cut instead. Bigger type with a cut word beats type nobody
   * can read across a table.
   *
   * The floor between the two is 45% of the ceiling, which is roughly where a
   * square stops being scannable next to its neighbours.
   *
   * Third: below the floor, take whatever goes. If even the smallest type
   * overflows, the last line kept ends in an ellipsis — a card with one
   * crowded square is still a card, and a card with type running out over the
   * rule is not.
   */
  function fitBox(encoded, boxW, boxH, opts) {
    const bold = !!opts.bold;
    const max = opts.max || 13;
    const min = opts.min || 5.5;
    const leading = opts.leading || 1.14;
    const floor = Math.max(min, max * 0.45);
    const fits = (lines, size) => lines && lines.length * size * leading <= boxH;

    for (let size = max; size >= floor; size -= 0.5) {
      const lines = wrap(encoded, boxW, size, bold, false);
      if (fits(lines, size)) return { size, lines, leading };
    }
    for (let size = max; size >= floor; size -= 0.5) {
      const lines = wrap(encoded, boxW, size, bold, true);
      if (fits(lines, size)) return { size, lines, leading };
    }
    for (let size = floor - 0.5; size >= min; size -= 0.5) {
      const lines = wrap(encoded, boxW, size, bold, true);
      if (fits(lines, size)) return { size, lines, leading };
    }

    // 0x85 is WinAnsi's ellipsis, and these strings are already bytes rather
    // than characters, so it is written as the byte it will become.
    const ELLIPSIS = "\x85";
    const lines = wrap(encoded, boxW, min, bold, true);
    const room = Math.max(1, Math.floor(boxH / (min * leading)));
    const kept = lines.slice(0, room);
    let last = kept[kept.length - 1];
    while (last && widthOf(last + ELLIPSIS, min, bold) > boxW) last = last.slice(0, -1);
    kept[kept.length - 1] = last + ELLIPSIS;
    return { size: min, lines: kept, leading };
  }

  /* ── The content stream ────────────────────────────────────────────────
     One page's drawing, as PDF operators. Coordinates are points from the
     bottom-left corner, which is upside down from how a page is described, so
     everything below takes a y that means what it says and the caller does the
     subtracting once, at the top. */

  class Content {
    constructor() { this.ops = []; }

    gray(value, stroke) { this.ops.push(fixed(value) + (stroke ? " G" : " g")); }
    lineWidth(w) { this.ops.push(fixed(w) + " w"); }

    rect(x, y, w, h, mode) {
      this.ops.push(`${fixed(x)} ${fixed(y)} ${fixed(w)} ${fixed(h)} re ${mode}`);
    }

    line(x1, y1, x2, y2) {
      this.ops.push(`${fixed(x1)} ${fixed(y1)} m ${fixed(x2)} ${fixed(y2)} l S`);
    }

    // Left-aligned at x, on the baseline y.
    text(encoded, x, y, size, bold) {
      if (!encoded) return;
      this.ops.push(
        `BT /${bold ? "F2" : "F1"} ${fixed(size)} Tf 1 0 0 1 ${fixed(x)} ${fixed(y)} Tm ${literal(encoded)} Tj ET`
      );
    }

    centred(encoded, cx, y, size, bold) {
      this.text(encoded, cx - widthOf(encoded, size, bold) / 2, y, size, bold);
    }

    // A fitted block, centred on a point in both directions. `fit` is what
    // fitBox returned, so the measuring is not done twice.
    block(fit, cx, cy, bold) {
      const { lines, size, leading } = fit;
      const step = size * leading;
      for (let i = 0; i < lines.length; i++) {
        const centre = cy + ((lines.length - 1) / 2 - i) * step;
        this.centred(lines[i], cx, centre - (CAP * size) / 2, size, bold);
      }
    }

    toString() { return this.ops.join("\n"); }
  }

  function fixed(v) {
    if (!isFinite(v)) return "0";
    const s = v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return s === "-0" ? "0" : s;
  }

  // A PDF literal string. The three characters that would end it early are the
  // ones that need the backslash; the high half goes octal so the file stays
  // seven-bit and readable in any editor.
  function literal(encoded) {
    let out = "(";
    for (let i = 0; i < encoded.length; i++) {
      const c = encoded.charCodeAt(i) & 0xff;
      if (c === 0x28 || c === 0x29 || c === 0x5c) out += "\\" + encoded[i];
      else if (c < 0x20 || c > 0x7e) out += "\\" + c.toString(8).padStart(3, "0");
      else out += encoded[i];
    }
    return out + ")";
  }

  /* ── The card ──────────────────────────────────────────────────────────
     Paper sizes in points. A4 is the default because this is an Austrian
     workshop; Letter is there because half the web is not. */

  const PAPER = {
    a4: { width: 595.28, height: 841.89, label: "A4" },
    letter: { width: 612, height: 792, label: "US Letter" },
  };

  const MARGIN = 46;
  const CELL_PAD = 5;
  const GRID_RULE = 0.9;
  const FRAME_RULE = 2;

  function drawCard(card, spec, geometry) {
    const c = new Content();
    const { page, grid, title, subtitle, footer } = geometry;

    c.gray(0, true);
    c.gray(0, false);

    if (title) c.centred(title.text, page.width / 2, title.y, title.size, true);
    if (subtitle) {
      c.gray(0.35, false);
      c.centred(subtitle.text, page.width / 2, subtitle.y, subtitle.size, false);
      c.gray(0, false);
    }

    // The free square first, as a wash under the rules rather than over them:
    // a filled cell drawn afterwards would paint out the lines that bound it.
    const step = grid.side / spec.columns;
    for (let i = 0; i < card.cells.length; i++) {
      if (!card.cells[i].free) continue;
      const col = i % spec.columns;
      const row = Math.floor(i / spec.columns);
      c.gray(0.9, false);
      c.rect(grid.x + col * step, grid.top - (row + 1) * step, step, step, "f");
      c.gray(0, false);
    }

    c.lineWidth(GRID_RULE);
    for (let i = 1; i < spec.columns; i++) {
      c.line(grid.x + i * step, grid.top - grid.side, grid.x + i * step, grid.top);
    }
    for (let i = 1; i < spec.rows; i++) {
      c.line(grid.x, grid.top - i * step, grid.x + grid.side, grid.top - i * step);
    }
    c.lineWidth(FRAME_RULE);
    c.rect(grid.x, grid.top - grid.side, grid.side, grid.side, "S");

    const innerW = step - CELL_PAD * 2;
    const innerH = step - CELL_PAD * 2;
    for (let i = 0; i < card.cells.length; i++) {
      const cell = card.cells[i];
      if (!cell.text) continue;
      const col = i % spec.columns;
      const row = Math.floor(i / spec.columns);
      const cx = grid.x + col * step + step / 2;
      const cy = grid.top - row * step - step / 2;
      const fit = fitBox(cell.text, innerW, innerH, {
        bold: cell.free,
        // Cells get a ceiling proportional to their own size, so a 3×3 card is
        // set large and an 8×8 one does not try to start at the same point and
        // shrink twenty times.
        max: Math.min(20, step / 3.2),
        min: 5,
      });
      c.block(fit, cx, cy, cell.free);
    }

    if (footer) {
      // The right-hand half carries a seed somebody typed, so its length is
      // not this file's to assume. The two ends come down together until they
      // stop reaching for each other.
      const room = page.width - MARGIN * 2 - 14;
      let size = footer.size;
      while (
        size > 5 &&
        widthOf(footer.left, size, false) + widthOf(footer.right, size, false) > room
      ) {
        size -= 0.25;
      }
      c.gray(0.45, false);
      if (footer.left) c.text(footer.left, MARGIN, footer.y, size, false);
      if (footer.right) {
        c.text(
          footer.right,
          page.width - MARGIN - widthOf(footer.right, size, false),
          footer.y,
          size,
          false
        );
      }
      c.gray(0, false);
    }

    return c.toString();
  }

  // A single line, brought down until it fits the width it is given. The
  // heading and the subheading are free text of any length, and a heading that
  // runs off both edges of the paper is the one failure a card cannot absorb —
  // it is the first thing on the page.
  function shrinkToFit(encoded, from, floor, limit, bold) {
    let size = from;
    while (size > floor && widthOf(encoded, size, bold) > limit) size -= 0.5;
    return size;
  }

  // Everything about the page that is the same on every card is measured once.
  // The grid is square and as large as the leftovers allow, which is what makes
  // a 3×3 card and a 6×6 card look like the same product.
  function layout(spec) {
    const page = PAPER[spec.paper] || PAPER.a4;
    const contentW = page.width - MARGIN * 2;

    let top = page.height - MARGIN;
    let title = null;
    let subtitle = null;

    if (spec.title) {
      const size = shrinkToFit(spec.title, 26, 9, contentW, true);
      title = { text: spec.title, size, y: top - size * CAP };
      top -= size * CAP + 14;
    }
    if (spec.subtitle) {
      const size = shrinkToFit(spec.subtitle, 9.5, 6, contentW, false);
      subtitle = { text: spec.subtitle, size, y: top - size * CAP };
      top -= size * CAP + 16;
    } else if (title) {
      top -= 6;
    }

    const footerSize = 8;
    const footerY = MARGIN - footerSize * CAP;
    const bottom = MARGIN + 16;

    // The grid is square, so on portrait paper it is the width that binds and
    // there is height left over. Anchored under the heading, that slack all
    // ends up at the foot and the page reads as unfinished; split evenly, the
    // heading floats away from the card it names. A third above and two thirds
    // below is where a printer puts a plate on a sheet, and it is what the eye
    // reads as centred.
    const side = Math.min(contentW, top - bottom);
    const slack = Math.max(0, top - bottom - side);
    return {
      page,
      title,
      subtitle,
      grid: { x: (page.width - side) / 2, top: top - slack / 3, side },
      footer: { size: footerSize, y: footerY },
    };
  }

  /* ── The file ──────────────────────────────────────────────────────────
     Plain objects, a classic cross-reference table, nothing compressed. It is
     a few kilobytes a page either way, and an uncompressed file is one anybody
     can open in a text editor and check against this source. */

  class Sink {
    constructor() { this.parts = []; this.length = 0; }
    push(s) {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      this.parts.push(b);
      this.length += b.length;
    }
    join() {
      const out = new Uint8Array(this.length);
      let at = 0;
      for (const p of this.parts) { out.set(p, at); at += p.length; }
      return out;
    }
  }

  function pdfDate(date) {
    const p = (n, w) => String(Math.abs(n)).padStart(w || 2, "0");
    const tz = -date.getTimezoneOffset();
    return (
      "D:" + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
      p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds()) +
      (tz >= 0 ? "+" : "-") + p((tz / 60) | 0) + "'" + p(tz % 60) + "'"
    );
  }

  function assemble(streams, page, info) {
    // Object numbers are laid out in advance: catalog, page tree, two fonts,
    // then a page and a content stream for each card.
    const CATALOG = 1;
    const PAGES = 2;
    const FONT_REGULAR = 3;
    const FONT_BOLD = 4;
    const INFO = 5;
    const FIRST_PAGE = 6;

    const objects = [];
    const put = (num, body) => { objects[num] = body; };

    const pageRefs = [];
    for (let i = 0; i < streams.length; i++) {
      const pageNum = FIRST_PAGE + i * 2;
      const streamNum = pageNum + 1;
      pageRefs.push(`${pageNum} 0 R`);
      put(
        pageNum,
        `<< /Type /Page /Parent ${PAGES} 0 R ` +
          `/MediaBox [0 0 ${fixed(page.width)} ${fixed(page.height)}] ` +
          `/Resources << /Font << /F1 ${FONT_REGULAR} 0 R /F2 ${FONT_BOLD} 0 R >> >> ` +
          `/Contents ${streamNum} 0 R >>`
      );
      put(streamNum, `<< /Length ${streams[i].length} >>\nstream\n${streams[i]}\nendstream`);
    }

    put(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
    put(PAGES, `<< /Type /Pages /Count ${streams.length} /Kids [${pageRefs.join(" ")}] >>`);
    put(FONT_REGULAR, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    put(FONT_BOLD, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    put(INFO, info);

    const sink = new Sink();
    sink.push("%PDF-1.7\n");
    // Four bytes above 127, which is how a file says it is binary to anything
    // that still moves files around in text mode.
    sink.push("%\xe2\xe3\xcf\xd3\n");

    const offsets = [];
    const count = objects.length;
    for (let num = 1; num < count; num++) {
      offsets[num] = sink.length;
      sink.push(`${num} 0 obj\n${objects[num]}\nendobj\n`);
    }

    const xref = sink.length;
    sink.push(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let num = 1; num < count; num++) {
      sink.push(String(offsets[num]).padStart(10, "0") + " 00000 n \n");
    }
    sink.push(
      `trailer\n<< /Size ${count} /Root ${CATALOG} 0 R /Info ${INFO} 0 R >>\n` +
        `startxref\n${xref}\n%%EOF\n`
    );
    return sink.join();
  }

  /* ── The one entry point ───────────────────────────────────────────────
     `cards` is [{ number, cells: [{ text, free }] }] with text already plain
     JS strings; everything is encoded here, once, on the way in. */

  function print(spec) {
    const geometry = layout({
      paper: spec.paper,
      title: spec.title ? toWinAnsi(spec.title).text : "",
      subtitle: spec.subtitle ? toWinAnsi(spec.subtitle).text : "",
      columns: spec.columns,
      rows: spec.rows,
    });

    const streams = spec.cards.map((card, index) => {
      const encoded = {
        cells: card.cells.map((cell) => ({
          text: cell.text ? toWinAnsi(cell.text).text : "",
          free: !!cell.free,
        })),
      };
      const footer = Object.assign({}, geometry.footer, {
        left: toWinAnsi(`Card ${index + 1} of ${spec.cards.length}`).text,
        right: spec.footer ? toWinAnsi(spec.footer).text : "",
      });
      return drawCard(encoded, spec, Object.assign({}, geometry, { footer }));
    });

    const now = spec.now || new Date();
    const meta =
      "<< /Title " + literal(toWinAnsi(spec.title || "Bingo cards").text) +
      " /Subject " + literal(toWinAnsi(spec.footer || "").text) +
      " /Creator " + literal(toWinAnsi("Felix' Workshop — Bingo Card Generator").text) +
      " /Producer " + literal(toWinAnsi("workshop.fubl.org/bingo-cards").text) +
      " /CreationDate " + literal(pdfDate(now)) +
      " /ModDate " + literal(pdfDate(now)) + " >>";

    return assemble(streams, geometry.page, meta);
  }

  // What the encoding cannot carry, asked before anything is drawn so the
  // answer arrives while the list can still be edited. The count that matters
  // is not really the characters: it is how many squares lose something, and
  // how many are left with nothing to print at all.
  function check(strings) {
    let lost = 0;
    let affected = 0;
    let blank = 0;
    for (const s of strings) {
      if (!s) continue;
      const result = toWinAnsi(s);
      if (!result.lost) continue;
      lost += result.lost;
      affected++;
      if (!result.text.trim()) blank++;
    }
    return { lost, affected, blank };
  }

  Bingo.pdf = { print, check, PAPER };

})(globalThis.Bingo || (globalThis.Bingo = {}));
