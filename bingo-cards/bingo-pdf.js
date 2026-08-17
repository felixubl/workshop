/* PDF writer for bingo cards. A card is a page with a grid on it, so this
   writes the file directly rather than pulling in a generator. Same position
   as the PDF Toolkit next door: the site is checkable client-side code, and
   shipping a large library to draw twenty-five rectangles would defeat that. */

;(function (Bingo) {
  "use strict";

  /* Metrics. Adobe's AFM widths for Helvetica and Helvetica-Bold, in 1/1000
     em, indexed by WinAnsi byte from 0x20. Needed because every string on a
     card is centred in a box and must be measured against the font that will
     draw it, which is the reader's Helvetica rather than the browser's. */

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

  /* WinAnsi. The twenty-seven codes CP1252 places in the C1 range, the only
     part of WinAnsi that is neither ASCII nor Latin-1. Em dashes and curly
     quotes are common enough in an entry list that losing them would be
     noticed. */
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

  /* Setting text in a box. Cells hold arbitrary input, so the type gives way
     rather than the box: wrap, and if still too tall, reduce a step and wrap
     again. */

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

  /* Three passes. First, reduce in half-point steps to find the largest size
     that fits with every word whole; most squares are three or four words and
     only this pass runs. Second, if nothing fits above the floor, the square
     holds an unbreakable token, so break it across lines. Third, if it still
     does not fit, truncate with an ellipsis. */
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

  /* The content stream: one page's drawing as PDF operators. Coordinates are
     points from the bottom-left corner, so the caller converts once at the top
     and everything below takes a y that means what it says. */

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

    // An image XObject, placed by the transform that maps the unit square onto
    // the box it is to fill. That is the whole of image placement in PDF: the
    // picture is always drawn into 0,0–1,1 and the matrix decides where that
    // lands and how big it is.
    image(name, x, y, w, h) {
      this.ops.push(
        `q ${fixed(w)} 0 0 ${fixed(h)} ${fixed(x)} ${fixed(y)} cm /${name} Do Q`
      );
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

  /* Pictures. A card can carry one: a club badge, a sponsor's logo, a QR code
     pointing at the caller's list. The browser already decodes PNG, JPEG, WebP,
     GIF and SVG, so this takes the samples back off a canvas rather than
     parsing five container formats to reach the same pixels.

     They go in as they came out, deflated. Lossless is not fussiness here — it
     is what a QR code needs to still scan and what a logo's edges need to stay
     edges. A photograph would be smaller as JPEG, and a photograph is not what
     a bingo card is asking for. */

  // 720 px is 300 dpi across the largest box a card ever gives a picture: the
  // free square of a 3×3 on A4, a shade over two inches. Beyond that it is
  // weight the printer throws away again.
  const IMAGE_MAX = 720;

  // CompressionStream writes a zlib wrapper, which is exactly what /FlateDecode
  // reads. Where it is missing the samples go in raw — a fatter file, and still
  // a correct one, which is the right way round for a fallback.
  async function pack(bytes) {
    if (typeof CompressionStream !== "function") return { data: bytes, filter: "" };
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
    return { data: zipped, filter: " /Filter /FlateDecode" };
  }

  // Rejects if the file is not something the browser can decode. The caller is
  // holding a file somebody picked, so that is a real outcome rather than a
  // programming error.
  function decode(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("not an image this browser can read"));
      img.src = url;
    });
  }

  async function readImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await decode(url);

      // A vector file has no pixels of its own and the browser's guess at its
      // box is arbitrary, so it is rasterised up to the size the page will use.
      // A bitmap is only ever scaled down: enlarging one invents detail. The
      // fallback of 512 is for a drawing that declares no size at all.
      const own = { w: img.naturalWidth || 512, h: img.naturalHeight || 512 };
      const fit = IMAGE_MAX / Math.max(own.w, own.h);
      const scale = file.type === "image/svg+xml" ? fit : Math.min(1, fit);
      const width = Math.max(1, Math.round(own.w * scale));
      const height = Math.max(1, Math.round(own.h * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const samples = ctx.getImageData(0, 0, width, height).data;

      // RGB in the image, alpha in a soft mask beside it, which is how PDF
      // holds transparency: two pictures of the same size, one of them grey.
      // The mask is only built once a pixel actually asks for it, so an opaque
      // logo carries no second stream.
      const rgb = new Uint8Array(width * height * 3);
      let alpha = null;
      for (let i = 0, p = 0; i < samples.length; i += 4, p += 3) {
        rgb[p] = samples[i];
        rgb[p + 1] = samples[i + 1];
        rgb[p + 2] = samples[i + 2];
        if (samples[i + 3] === 255) continue;
        if (!alpha) alpha = new Uint8Array(width * height).fill(255);
        alpha[i >> 2] = samples[i + 3];
      }

      return {
        width,
        height,
        colour: await pack(rgb),
        mask: alpha ? await pack(alpha) : null,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* The card. Paper sizes in points. A4 is the default; Letter is available. */

  const PAPER = {
    a4: { width: 595.28, height: 841.89, label: "A4" },
    letter: { width: 612, height: 792, label: "US Letter" },
  };

  const MARGIN = 46;
  const CELL_PAD = 5;
  const GRID_RULE = 0.9;
  const FRAME_RULE = 2;

  // The box a corner picture is fitted into, in points: 64 is a shade over
  // 22 mm, which is a printed QR code that a phone reads without being coaxed
  // and a logo that reads as a mark rather than as a second heading.
  const MARK_BOX = 64;

  // The name every page's resource dictionary gives the picture. There is only
  // ever one.
  const MARK_NAME = "Im0";

  // Aspect kept, longest side to the box. Corner and free square differ only in
  // how big the box is.
  function fitMark(image, box) {
    const scale = Math.min(box / image.width, box / image.height);
    return { w: image.width * scale, h: image.height * scale };
  }

  function drawCard(card, spec, geometry) {
    const c = new Content();
    const { page, grid, title, subtitle, footer, mark, freeMark } = geometry;

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
      const left = grid.x + col * step;
      const foot = grid.top - (row + 1) * step;
      c.gray(0.9, false);
      c.rect(left, foot, step, step, "f");
      c.gray(0, false);

      // A picture in the free square sits on the wash and under the rules: it
      // is inset far enough never to reach them, and this way round the frame
      // would win if it ever did.
      if (freeMark) {
        const box = fitMark(freeMark, step - (CELL_PAD + 2) * 2);
        c.image(
          MARK_NAME,
          left + (step - box.w) / 2,
          foot + (step - box.h) / 2,
          box.w,
          box.h
        );
      }
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
      // The picture is what the free square says now, so its label stands down
      // rather than printing behind it.
      if (cell.free && freeMark) continue;
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

    if (mark) c.image(MARK_NAME, mark.x, mark.y, mark.w, mark.h);

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

    // A corner picture is measured before anything else, because the heading
    // has to know whether the top of the page is already spoken for and the
    // grid whether the foot is. "tl", "tr", "bl", "br"; anywhere else on the
    // card is not a corner and is handled where it lands.
    const corner = spec.corner ? fitMark(spec.corner.image, MARK_BOX) : null;
    const atTop = !!corner && spec.corner.where[0] === "t";

    // A heading between two corner marks gets the middle of the measure. Below
    // two fifths of it the type would be shrinking to make room for a logo,
    // which is the wrong way round — by then it is small enough not to reach
    // the corners anyway, so it stops giving way.
    const headW = atTop
      ? Math.max(contentW * 0.4, contentW - (corner.w + 14) * 2)
      : contentW;

    let top = page.height - MARGIN;
    let title = null;
    let subtitle = null;

    if (spec.title) {
      const size = shrinkToFit(spec.title, 26, 9, headW, true);
      title = { text: spec.title, size, y: top - size * CAP };
      top -= size * CAP + 14;
    }
    if (spec.subtitle) {
      const size = shrinkToFit(spec.subtitle, 9.5, 6, headW, false);
      subtitle = { text: spec.subtitle, size, y: top - size * CAP };
      top -= size * CAP + 16;
    } else if (title) {
      top -= 6;
    }
    // A short heading, or none, leaves the mark hanging below the band it sits
    // in. The grid starts under whichever of the two reaches lower.
    if (atTop) top = Math.min(top, page.height - MARGIN - corner.h - 14);

    const footerSize = 8;
    const footerY = MARGIN - footerSize * CAP;
    // A mark at the foot hangs off the bottom edge of the grid, so the grid
    // gives up the height rather than growing down over it.
    const bottom = MARGIN + 16 + (corner && !atTop ? corner.h + 12 : 0);

    // The grid is square, so on portrait paper it is the width that binds and
    // there is height left over. Anchored under the heading, that slack all
    // ends up at the foot and the page reads as unfinished; split evenly, the
    // heading floats away from the card it names. A third above and two thirds
    // below is where a printer puts a plate on a sheet, and it is what the eye
    // reads as centred.
    const side = Math.min(contentW, top - bottom);
    const slack = Math.max(0, top - bottom - side);
    const grid = { x: (page.width - side) / 2, top: top - slack / 3, side };

    // Marks line up with the frame rather than with the paper's margin. On
    // portrait stock the two are the same edge; when the grid is height-bound
    // they are not, and a logo standing off the frame it belongs to is the
    // thing a reader notices.
    let mark = null;
    if (corner) {
      mark = {
        w: corner.w,
        h: corner.h,
        x: spec.corner.where[1] === "l" ? grid.x : grid.x + side - corner.w,
        y: atTop ? page.height - MARGIN - corner.h : grid.top - side - 12 - corner.h,
      };
    }

    return { page, title, subtitle, grid, mark, footer: { size: footerSize, y: footerY } };
  }

  /* The file. Plain objects, a classic cross-reference table, nothing
     compressed. It costs a few kilobytes a page and keeps the output readable
     in a text editor. */

  class Sink {
    constructor() { this.parts = []; this.length = 0; }
    push(s) {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      this.parts.push(b);
      this.length += b.length;
    }
    // Image samples arrive as bytes and have no business becoming a string on
    // the way. Everything else in the file is text, which is why this is the
    // exception rather than the rule.
    bytes(b) {
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

  function assemble(streams, page, info, image) {
    // Object numbers are laid out in advance: catalog, page tree, two fonts,
    // the picture and its mask where there is one, then a page and a content
    // stream for each card.
    const CATALOG = 1;
    const PAGES = 2;
    const FONT_REGULAR = 3;
    const FONT_BOLD = 4;
    const INFO = 5;

    let next = 6;
    const IMAGE = image ? next++ : 0;
    const SMASK = image && image.mask ? next++ : 0;
    const FIRST_PAGE = next;

    const objects = [];
    // A body is a string, or a list of strings and byte runs where a stream
    // carries samples rather than operators.
    const put = (num, body) => { objects[num] = body; };

    if (image) {
      const sampled = (num, data, filter, extra) =>
        put(num, [
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
            `${extra}/BitsPerComponent 8${filter} /Length ${data.length} >>\nstream\n`,
          data,
          "\nendstream",
        ]);
      sampled(
        IMAGE,
        image.colour.data,
        image.colour.filter,
        `/ColorSpace /DeviceRGB ${SMASK ? `/SMask ${SMASK} 0 R ` : ""}`
      );
      if (SMASK) sampled(SMASK, image.mask.data, image.mask.filter, "/ColorSpace /DeviceGray ");
    }

    const xobject = IMAGE ? ` /XObject << /${MARK_NAME} ${IMAGE} 0 R >>` : "";
    const pageRefs = [];
    for (let i = 0; i < streams.length; i++) {
      const pageNum = FIRST_PAGE + i * 2;
      const streamNum = pageNum + 1;
      pageRefs.push(`${pageNum} 0 R`);
      put(
        pageNum,
        `<< /Type /Page /Parent ${PAGES} 0 R ` +
          `/MediaBox [0 0 ${fixed(page.width)} ${fixed(page.height)}] ` +
          `/Resources << /Font << /F1 ${FONT_REGULAR} 0 R /F2 ${FONT_BOLD} 0 R >>${xobject} >> ` +
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
      sink.push(`${num} 0 obj\n`);
      for (const part of [].concat(objects[num])) {
        if (typeof part === "string") sink.push(part);
        else sink.bytes(part);
      }
      sink.push("\nendobj\n");
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

  /* The single entry point. `cards` is [{ number, cells: [{ text, free }] }]
     with plain JS strings; encoding happens here, once, on the way in. */

  function print(spec) {
    // One picture, in one of two jobs: filling the free square, or standing in
    // a corner of the page. The free square is a cell and is drawn with the
    // cells; a corner is page furniture and has to be measured with the page.
    const image = spec.image || null;
    const freeMark = image && spec.where === "free" ? image : null;
    const corner = image && !freeMark ? { image, where: spec.where } : null;

    const geometry = layout({
      paper: spec.paper,
      title: spec.title ? toWinAnsi(spec.title).text : "",
      subtitle: spec.subtitle ? toWinAnsi(spec.subtitle).text : "",
      columns: spec.columns,
      rows: spec.rows,
      corner,
    });
    geometry.freeMark = freeMark;

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

    // Where the cards were made is said twice — once at the foot of the page,
    // once in the file's properties — and a switch that dropped only the
    // printed half would be a half-truth. Both go together.
    const now = spec.now || new Date();
    const meta =
      "<< /Title " + literal(toWinAnsi(spec.title || "Bingo cards").text) +
      " /Subject " + literal(toWinAnsi(spec.footer || "").text) +
      (spec.credit === false
        ? ""
        : " /Creator " + literal(toWinAnsi("Felix' Workshop — Bingo Card Generator").text) +
          " /Producer " + literal(toWinAnsi("workshop.fubl.org/bingo-cards").text)) +
      " /CreationDate " + literal(pdfDate(now)) +
      " /ModDate " + literal(pdfDate(now)) + " >>";

    return assemble(streams, geometry.page, meta, image);
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

  Bingo.pdf = { print, check, readImage, PAPER };

})(globalThis.Bingo || (globalThis.Bingo = {}));
