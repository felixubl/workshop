// Marks: the two things you can lay over a page here.
//
// A highlight is a pastel field painted with a multiply blend, which is what a
// real highlighter does — the pen is a filter, not a coat of paint, so ink
// under it stays black and paper under it takes the colour. A blackout is the
// opposite claim: opaque ink, and the page's own ink taken out from under it
// (pdf-redact.js), because a black rectangle over readable text is the oldest
// way there is to publish a secret.
//
// A mark is stored in the page's own coordinates rather than in pixels. It
// therefore does not move when the page is turned, does not have to be redone
// when the window changes size, and is written into the content stream as the
// numbers it already is.

;(function (PDF) {
  'use strict';

  const { Dict, PDFStream } = PDF;

  // Six pens. Every one is pale enough that black text read through it stays
  // black, and far enough from its neighbours to be named down a telephone.
  // These are ink in the saved file rather than chrome, so they are the tool's
  // own colours and not the site's plates.
  const TONES = [
    { id: 'butter', label: 'butter', rgb: [0.99, 0.90, 0.45] },
    { id: 'mint',   label: 'mint',   rgb: [0.68, 0.93, 0.76] },
    { id: 'sky',    label: 'sky',    rgb: [0.66, 0.86, 0.99] },
    { id: 'rose',   label: 'rose',   rgb: [1.00, 0.74, 0.82] },
    { id: 'lilac',  label: 'lilac',  rgb: [0.82, 0.77, 0.99] },
    { id: 'peach',  label: 'peach',  rgb: [1.00, 0.80, 0.60] },
  ];

  const byId = new Map(TONES.map((t) => [t.id, t]));

  function tone(id) { return byId.get(id) || TONES[0]; }

  function toneCSS(id) {
    const c = tone(id).rgb;
    return 'rgb(' + c.map((v) => Math.round(v * 255)).join(',') + ')';
  }

  // --- where a mark sits ------------------------------------------------------

  // renderPageToCanvas draws the crop box with the page's own /Rotate applied,
  // so the canvas is not the page's coordinate system: the origin has moved,
  // y runs the other way, and a quarter turn may have swapped the axes. This
  // frame carries the four numbers that reconcile the two, and the pair below
  // walk a point across in either direction.
  function frameOf(page, scale) {
    const box = page.cropBox;
    const r = page.rotate;
    const w = box[2] - box[0], h = box[3] - box[1];
    const swap = r === 90 || r === 270;
    return {
      x0: box[0], y0: box[1], w, h, r, s: scale,
      width: (swap ? h : w) * scale,
      height: (swap ? w : h) * scale,
    };
  }

  function toCanvas(f, x, y) {
    const u = x - f.x0, v = y - f.y0;
    switch (f.r) {
      case 90:  return [v * f.s, u * f.s];
      case 180: return [(f.w - u) * f.s, v * f.s];
      case 270: return [(f.h - v) * f.s, (f.w - u) * f.s];
      default:  return [u * f.s, (f.h - v) * f.s];
    }
  }

  function toPage(f, cx, cy) {
    const a = cx / f.s, b = cy / f.s;
    switch (f.r) {
      case 90:  return [f.x0 + b, f.y0 + a];
      case 180: return [f.x0 + f.w - a, f.y0 + b];
      case 270: return [f.x0 + f.w - b, f.y0 + f.h - a];
      default:  return [f.x0 + a, f.y0 + f.h - b];
    }
  }

  // The box a mark covers on that canvas, in CSS pixels from its top left.
  function boxOf(f, mark) {
    const a = toCanvas(f, mark.x, mark.y);
    const b = toCanvas(f, mark.x + mark.w, mark.y + mark.h);
    return {
      left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]),
      width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]),
    };
  }

  // A drag across the canvas, as a mark. Clamped to the crop box: a mark that
  // ran off the paper would be written into the file and shown by nobody.
  function markFromDrag(f, kind, toneId, x1, y1, x2, y2) {
    const a = toPage(f, x1, y1);
    const b = toPage(f, x2, y2);
    const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
    const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const x = Math.max(lo[0], f.x0), y = Math.max(lo[1], f.y0);
    const w = Math.min(hi[0], f.x0 + f.w) - x;
    const h = Math.min(hi[1], f.y0 + f.h) - y;
    if (!(w > 0.5) || !(h > 0.5)) return null;
    const mark = { kind: kind === 'censor' ? 'censor' : 'highlight', x, y, w, h };
    if (mark.kind === 'highlight') mark.tone = tone(toneId).id;
    return mark;
  }

  function markAt(f, marks, cx, cy) {
    // Last drawn is topmost, and the topmost is the one being pointed at.
    for (let i = marks.length - 1; i >= 0; i--) {
      const b = boxOf(f, marks[i]);
      if (cx >= b.left && cx <= b.left + b.width && cy >= b.top && cy <= b.top + b.height) return i;
    }
    return -1;
  }

  function count(marks) {
    let censor = 0, highlight = 0;
    for (const m of marks || []) {
      if (m.kind === 'censor') censor++;
      else highlight++;
    }
    return { censor, highlight, total: censor + highlight };
  }

  // --- drawing them ------------------------------------------------------------

  // On a canvas, for the previews. Multiply is doing the same job here as the
  // blend mode does in the saved file, so a thumbnail and the file agree.
  function paintMarks(ctx, page, scale, marks) {
    if (!marks || !marks.length) return;
    const f = frameOf(page, scale);
    ctx.save();
    for (const m of marks) {
      if (m.kind === 'censor') continue;
      const b = boxOf(f, m);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = toneCSS(m.tone);
      ctx.fillRect(b.left, b.top, b.width, b.height);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    for (const m of marks) {
      if (m.kind !== 'censor') continue;
      const b = boxOf(f, m);
      ctx.fillRect(b.left, b.top, b.width, b.height);
    }
    ctx.restore();
  }

  // In a content stream, for the file. Highlights are laid down first and
  // blackouts after, so that a blackout over a highlight is black.
  //
  // The whole run sits inside q/Q, and the blend mode is switched from an
  // ExtGState resource the caller has to have added under `gsName`.
  function markOps(marks, gsName) {
    const highlights = (marks || []).filter((m) => m.kind !== 'censor');
    const blackouts = (marks || []).filter((m) => m.kind === 'censor');
    const num = PDF.writeNumber;
    const rect = (m) => num(m.x) + ' ' + num(m.y) + ' ' + num(m.w) + ' ' + num(m.h) + ' re f\n';
    let out = '';

    if (highlights.length) {
      out += 'q\n/' + gsName + ' gs\n';
      let last = null;
      for (const m of highlights) {
        const c = tone(m.tone).rgb;
        const fill = num(c[0]) + ' ' + num(c[1]) + ' ' + num(c[2]) + ' rg\n';
        if (fill !== last) { out += fill; last = fill; }
        out += rect(m);
      }
      out += 'Q\n';
    }
    if (blackouts.length) {
      out += 'q\n0 g\n';
      for (const m of blackouts) out += rect(m);
      out += 'Q\n';
    }
    return out;
  }

  // The graphics state a highlight is painted in. /Multiply is the whole point
  // of it; the two alphas are stated rather than assumed because the page's
  // own state is not this stream's to trust.
  function highlightGState() {
    return new Dict()
      .set('Type', PDF.Name.get('ExtGState'))
      .set('BM', PDF.Name.get('Multiply'))
      .set('ca', 1)
      .set('CA', 1);
  }

  // A content stream, from operators written out or from bytes already built.
  // Nothing here is ever compressed: the file stays greppable, which is how
  // anyone checks what a tool did to it.
  function contentStream(source) {
    const bytes = typeof source === 'string' ? PDF.latin1ToBytes(source) : source;
    return new PDFStream(new Dict().set('Length', bytes.length), bytes);
  }

  PDF.marks = {
    TONES, tone, toneCSS, frameOf, toCanvas, toPage, boxOf,
    markFromDrag, markAt, count, paintMarks, markOps, highlightGState, contentStream,
  };

})(globalThis.PDF || (globalThis.PDF = {}));
