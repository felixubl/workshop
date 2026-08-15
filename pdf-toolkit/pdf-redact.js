// Taking the ink out from under a blackout.
//
// Painting a black rectangle over a name hides it from a reader and from
// nobody else: the characters are still in the file, and the first text
// extractor to come along hands them back. So a blackout here is two things.
// The rectangle is painted (pdf-marks.js), and the page's instructions are
// rewritten with everything under it removed: the glyphs, any image that sits
// wholly inside it, and any drawing that does.
//
// The rewrite is a second pass over the content stream, keeping the state the
// renderer keeps — the transformation matrix, the two text matrices, the text
// state — because nothing in a content stream says where a glyph lands; that
// follows from everything before it. Runs of operators the pass does not
// change are copied through byte for byte, which is what keeps an inline
// image's binary intact, a number from being rounded on its way through, and
// the diff between a page and its redacted twin down to what actually went.
//
// A glyph goes when the blackouts cover more than a third of the box it
// occupies. A grazed character stays and is painted over, which is why the
// tool says to cover a little more than you need.

;(function (PDF) {
  'use strict';

  const { Name, Ref, Dict, PDFStream, Parser, EOF, ByteSink } = PDF;

  const ASCENT = 0.88, DESCENT = -0.22;   // a character's box, in ems
  const COVER = 0.35;                     // how much of it has to be covered
  const MAX_OPS = 2000000;
  const MAX_DEPTH = 8;

  function rectsFromMarks(marks) {
    return (marks || [])
      .filter((m) => m.kind === 'censor' && m.w > 0 && m.h > 0)
      .map((m) => ({ x0: m.x, y0: m.y, x1: m.x + m.w, y1: m.y + m.h }));
  }

  class Redactor {
    constructor(doc, rects, builder) {
      this.doc = doc;
      this.rects = rects;
      this.builder = builder;
      this.fonts = new Map();
      this.ops = 0;
      this.unsure = 0;        // runs that could not be read, so may still hold text
      this.names = 0;
    }

    // --- what the blackouts cover ------------------------------------------

    // The share of a box the blackouts take. Rotated text is measured by the
    // upright box around it, which errs towards removing a character rather
    // than leaving one.
    coverage(points) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of points) {
        if (p[0] < bx0) bx0 = p[0];
        if (p[0] > bx1) bx1 = p[0];
        if (p[1] < by0) by0 = p[1];
        if (p[1] > by1) by1 = p[1];
      }
      if (!isFinite(bx0)) return 0;
      const area = (bx1 - bx0) * (by1 - by0);
      let hit = 0;
      for (const r of this.rects) {
        const ox = Math.min(bx1, r.x1) - Math.max(bx0, r.x0);
        const oy = Math.min(by1, r.y1) - Math.max(by0, r.y0);
        if (ox > 0 && oy > 0) hit += ox * oy;
      }
      // A box with no area — a space, a zero-width mark — is decided by
      // whether it stands inside a blackout at all.
      if (!(area > 0)) {
        return this.rects.some((r) => bx0 >= r.x0 && bx1 <= r.x1 && by0 >= r.y0 && by1 <= r.y1) ? 1 : 0;
      }
      return Math.min(1, hit / area);
    }

    // Wholly inside one blackout, with room to spare. Used for the things that
    // are removed outright rather than by share: an image, a drawn path.
    inside(points, margin) {
      const pad = margin || 0;
      for (const r of this.rects) {
        let all = true;
        for (const p of points) {
          if (p[0] < r.x0 + pad || p[0] > r.x1 - pad || p[1] < r.y0 + pad || p[1] > r.y1 - pad) {
            all = false;
            break;
          }
        }
        if (all) return true;
      }
      return false;
    }

    touches(points) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of points) {
        if (p[0] < bx0) bx0 = p[0];
        if (p[0] > bx1) bx1 = p[0];
        if (p[1] < by0) by0 = p[1];
        if (p[1] > by1) by1 = p[1];
      }
      return this.rects.some((r) => bx1 > r.x0 && bx0 < r.x1 && by1 > r.y0 && by0 < r.y1);
    }

    // --- fonts ---------------------------------------------------------------

    fontFor(nameObj, resources) {
      if (!(nameObj instanceof Name)) return null;
      const fonts = this.doc.get(resources, 'Font');
      if (!(fonts instanceof Dict)) return null;
      const ref = fonts.get(nameObj.name);
      const dict = this.doc.resolve(ref);
      if (!(dict instanceof Dict)) return null;
      const key = ref instanceof Ref ? 'r' + ref.num : dict;
      if (this.fonts.has(key)) return this.fonts.get(key);
      let font = null;
      try { font = new PDF.PDFFont(this.doc, dict); } catch { font = null; }
      this.fonts.set(key, font);
      return font;
    }

    // --- the page ------------------------------------------------------------

    // The rewritten content for one page, plus whatever had to be added to its
    // resources. `adds` maps a fresh XObject name to a new object: a form that
    // needed redacting is written out as its own copy rather than in place,
    // because the same form may be drawn elsewhere on the page and outside a
    // blackout there.
    page(page) {
      const out = this.walk(page.contentBytes, page.resources, [1, 0, 0, 1, 0, 0], 0, true);
      return { bytes: out.bytes, adds: out.adds, unsure: this.unsure };
    }

    // --- the interpreter -----------------------------------------------------

    walk(bytes, resources, ctm, depth, balance) {
      const doc = this.doc;
      const mul = PDF.mat.mul, applyM = PDF.mat.apply;
      const sink = new ByteSink();
      const adds = new Map();
      const forms = new Map();          // one rewritten copy per call site
      let changed = false;
      let copied = 0;

      const flushTo = (end) => {
        if (end > copied) sink.bytes(bytes.subarray(copied, end));
        copied = end;
      };
      // Replaces the bytes of one operator and its operands with something
      // else; everything else in the stream is never touched. The newline is
      // not decoration: the range being replaced runs to the start of the next
      // operand, so the whitespace that separated them goes with it.
      const swap = (start, end, text) => {
        flushTo(start);
        sink.text(text + '\n');
        copied = end;
        changed = true;
      };

      const parser = new Parser(bytes, 0, null);
      const operands = [];
      const stack = [];
      let gs = {
        ctm: ctm.slice(), font: null, size: 0, tc: 0, tw: 0, th: 1, rise: 0,
        leading: 0, lineWidth: 1,
      };
      let tm = null, tlm = null;
      let path = null;
      let open = 0;                     // q's this stream has left open
      let textOpen = false;
      let runStart = parser.pos;

      if (balance) sink.text('q\n');

      const num = (i) => {
        const v = operands[i];
        return typeof v === 'number' && isFinite(v) ? v : 0;
      };
      const pt = (x, y) => applyM(gs.ctm, x, y);
      const addPath = (...points) => {
        if (!path) path = [];
        for (const p of points) path.push(p);
      };

      // A run of shown text, rebuilt without the characters the blackouts
      // cover. What goes is replaced by the exact space it took, written as a
      // TJ adjustment, so every character that stays is left where it was.
      const showText = (items, prefix) => {
        const font = gs.font;
        if (!tm) { tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); }
        if (!font || !(gs.size > 0)) {
          this.unsure++;
          return null;
        }
        const out = [];
        let buf = '';
        let dropped = false;

        const pushNum = (n) => {
          if (buf) { out.push(buf); buf = ''; }
          if (out.length && typeof out[out.length - 1] === 'number') out[out.length - 1] += n;
          else out.push(n);
        };

        for (const item of items) {
          if (typeof item === 'number') {
            pushNum(item);
            tm = mul([1, 0, 0, 1, -item / 1000 * gs.size * gs.th, 0], tm);
            continue;
          }
          if (typeof item !== 'string') continue;
          // A Type 3 font measures its glyphs in its own units rather than in
          // thousandths, so its widths are brought onto the same scale as
          // everything else before they are used.
          const unit = font.kind === 'type3' && font.fontMatrix ? font.fontMatrix[0] * 1000 : 1;

          for (const code of font.decode(item)) {
            const w0 = font.widthOf(code) * unit;
            const width = w0 / 1000 * gs.size;
            const spaced = code === 32 && !font.twoByte;
            const extra = gs.tc + (spaced ? gs.tw : 0);
            const trm = mul(mul([gs.size * gs.th, 0, 0, gs.size, 0, gs.rise], tm), gs.ctm);
            const box = [
              PDF.mat.apply(trm, 0, DESCENT), PDF.mat.apply(trm, w0 / 1000, DESCENT),
              PDF.mat.apply(trm, w0 / 1000, ASCENT), PDF.mat.apply(trm, 0, ASCENT),
            ];

            if (this.coverage(box) >= COVER) {
              dropped = true;
              // The advance this character would have made, in the thousandths
              // of an em a TJ number is written in. Horizontal scaling applies
              // to the character and to the adjustment alike, so it cancels.
              pushNum(-(w0 + extra * 1000 / gs.size));
            } else if (font.twoByte) {
              buf += String.fromCharCode((code >> 8) & 0xff, code & 0xff);
            } else {
              buf += String.fromCharCode(code & 0xff);
            }
            tm = mul([1, 0, 0, 1, (width + extra) * gs.th, 0], tm);
          }
        }
        if (!dropped) return null;
        if (buf) out.push(buf);

        let text = prefix + '[';
        for (const v of out) {
          text += typeof v === 'number' ? ' ' + PDF.writeNumber(v) : ' ' + PDF.writeString(v);
        }
        return text + ' ] TJ';
      };

      // An image or a form, drawn through the unit square the current matrix
      // maps onto the page.
      const doXObject = () => {
        const nameObj = operands[0];
        if (!(nameObj instanceof Name)) return null;
        const xobjs = doc.get(resources, 'XObject');
        if (!(xobjs instanceof Dict)) return null;
        const ref = xobjs.get(nameObj.name);
        const xo = doc.resolve(ref);
        if (!(xo instanceof PDFStream)) return null;
        const subtype = doc.get(xo.dict, 'Subtype');
        const kind = subtype instanceof Name ? subtype.name : '';

        if (kind === 'Image') {
          const square = [pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 1)];
          return this.inside(square) ? '' : null;
        }
        if (kind !== 'Form' || depth >= MAX_DEPTH) return null;

        let inner = gs.ctm;
        const matrix = doc.get(xo.dict, 'Matrix');
        if (Array.isArray(matrix) && matrix.length >= 6) {
          const m = matrix.map((v) => {
            const r = doc.resolve(v);
            return typeof r === 'number' && isFinite(r) ? r : 0;
          });
          inner = mul(m, gs.ctm);
        }

        const bbox = doc.get(xo.dict, 'BBox');
        if (Array.isArray(bbox) && bbox.length >= 4) {
          const b = bbox.map((v) => {
            const r = doc.resolve(v);
            return typeof r === 'number' && isFinite(r) ? r : 0;
          });
          const corners = [
            PDF.mat.apply(inner, b[0], b[1]), PDF.mat.apply(inner, b[2], b[1]),
            PDF.mat.apply(inner, b[2], b[3]), PDF.mat.apply(inner, b[0], b[3]),
          ];
          if (!this.touches(corners)) return null;
        }

        const key = (ref instanceof Ref ? ref.num : nameObj.name) + '@' +
                    inner.map((v) => Math.round(v * 1000) / 1000).join(',');
        if (forms.has(key)) {
          const had = forms.get(key);
          return had ? '/' + had + ' Do' : null;
        }

        let formBytes;
        try { formBytes = doc.decodeStreamBytes(xo, ref instanceof Ref ? ref.num : undefined); }
        catch { return null; }
        const formRes = doc.get(xo.dict, 'Resources');
        const sub = this.walk(formBytes, formRes instanceof Dict ? formRes : resources,
                              inner, depth + 1, false);
        if (!sub.changed) { forms.set(key, null); return null; }

        // A form with no resources of its own reads this stream's, so anything
        // its rewrite needs is added here rather than to the copy.
        if (!(formRes instanceof Dict)) {
          for (const [k, v] of sub.adds) adds.set(k, v);
          sub.adds.clear();
        }

        const fresh = this.uniqueName(xobjs, 'Fx');
        adds.set(fresh, this.rewriteForm(xo, sub));
        forms.set(key, fresh);
        return '/' + fresh + ' Do';
      };

      for (;;) {
        if (++this.ops > MAX_OPS) { this.unsure++; break; }
        let obj;
        try { obj = parser.parseObject(); } catch { break; }
        if (obj === EOF) break;

        if (!(obj && obj.type === 'kw')) {
          operands.push(obj);
          if (operands.length > 64) operands.shift();
          continue;
        }

        const op = obj.val;
        let out = null;
        try {
          switch (op) {
            case 'q':
              stack.push(Object.assign({}, gs));
              gs.ctm = gs.ctm.slice();
              open++;
              break;
            case 'Q':
              if (stack.length) { gs = stack.pop(); open--; }
              // A Q with no q of its own would pop the state this stream was
              // called in. At the top level that is the wrapper below, so the
              // stray one is dropped instead.
              else if (balance) out = '';
              break;
            case 'cm':
              if (operands.length >= 6) {
                gs.ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], gs.ctm);
              }
              break;
            case 'w': gs.lineWidth = Math.abs(num(0)); break;

            case 'm': addPath(pt(num(0), num(1))); break;
            case 'l': addPath(pt(num(0), num(1))); break;
            case 'c': addPath(pt(num(0), num(1)), pt(num(2), num(3)), pt(num(4), num(5))); break;
            case 'v': case 'y': addPath(pt(num(0), num(1)), pt(num(2), num(3))); break;
            case 'h': break;
            case 're': {
              const x = num(0), y = num(1), w = num(2), h = num(3);
              addPath(pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h));
              break;
            }

            case 'S': case 's': case 'f': case 'F': case 'f*':
            case 'B': case 'B*': case 'b': case 'b*': {
              // A path drawn wholly inside a blackout is painted with nothing.
              // The path itself is left in the stream, because it may also be
              // the clip the operators after it rely on.
              if (this.rects.length && path && path.length) {
                const strokes = op !== 'f' && op !== 'F' && op !== 'f*';
                const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
                const margin = strokes ? gs.lineWidth * scale / 2 : 0;
                if (this.inside(path, margin)) out = 'n';
              }
              path = null;
              break;
            }
            case 'n': path = null; break;

            case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); textOpen = true; break;
            case 'ET': tm = null; tlm = null; textOpen = false; break;
            case 'Tc': gs.tc = num(0); break;
            case 'Tw': gs.tw = num(0); break;
            case 'Tz': gs.th = num(0) / 100; break;
            case 'TL': gs.leading = num(0); break;
            case 'Ts': gs.rise = num(0); break;
            case 'Tf':
              gs.font = this.fontFor(operands[0], resources);
              gs.size = num(1);
              break;
            case 'Td':
              tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm || [1, 0, 0, 1, 0, 0]);
              tm = tlm.slice();
              break;
            case 'TD':
              gs.leading = -num(1);
              tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm || [1, 0, 0, 1, 0, 0]);
              tm = tlm.slice();
              break;
            case 'Tm':
              if (operands.length >= 6) {
                tlm = [num(0), num(1), num(2), num(3), num(4), num(5)];
                tm = tlm.slice();
              }
              break;
            case 'T*':
              tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm || [1, 0, 0, 1, 0, 0]);
              tm = tlm.slice();
              break;

            case 'Tj':
              if (typeof operands[0] === 'string') out = showText([operands[0]], '');
              break;
            case 'TJ':
              if (Array.isArray(operands[0])) out = showText(operands[0], '');
              break;
            case "'":
              tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm || [1, 0, 0, 1, 0, 0]);
              tm = tlm.slice();
              if (typeof operands[0] === 'string') out = showText([operands[0]], 'T* ');
              break;
            case '"':
              gs.tw = num(0);
              gs.tc = num(1);
              tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm || [1, 0, 0, 1, 0, 0]);
              tm = tlm.slice();
              if (typeof operands[2] === 'string') {
                out = showText([operands[2]],
                  PDF.writeNumber(gs.tw) + ' Tw ' + PDF.writeNumber(gs.tc) + ' Tc T* ');
              }
              break;

            case 'Do': out = doXObject(); break;
            case 'BI': out = this.inlineImage(parser, gs, pt); break;
            default: break;
          }
        } catch { out = null; }

        const opEnd = parser.pos;
        if (out !== null) swap(runStart, opEnd, out);
        operands.length = 0;
        runStart = opEnd;
      }

      flushTo(bytes.length);

      // Closed off, so that whatever is appended after this — the marks
      // themselves — starts from the state the page started in.
      if (balance) {
        if (textOpen) sink.text('\nET');
        sink.text('\n' + 'Q\n'.repeat(Math.max(0, open) + 1));
      }

      return { bytes: sink.join(), adds, changed };
    }

    // BI ... ID <bytes> EI. The dictionary is read for its own sake, the data
    // is stepped over, and the whole thing goes if it stands inside a blackout.
    //
    // Where the data starts is taken from the ID keyword's own position rather
    // than from the lexer's: reading a number looks two tokens ahead, so by the
    // time ID is handed over the lexer may already have tokenised the image.
    inlineImage(parser, gs, pt) {
      const dict = new Dict();
      let id = null;
      for (;;) {
        const k = parser.parseObject();
        if (k === EOF) return null;
        if (k && k.type === 'kw' && k.val === 'ID') { id = k; break; }
        const v = parser.parseObject();
        if (v === EOF) return null;
        if (k instanceof Name) dict.set(k.name, v);
      }
      const bytes = parser.buf;
      let p = id.pos + 2;
      if (PDF.isWhite(bytes[p])) p++;
      let end = -1;
      for (let i = p; i + 1 < bytes.length; i++) {
        if (bytes[i] === 0x45 && bytes[i + 1] === 0x49 &&
            (i + 2 >= bytes.length || !PDF.isRegular(bytes[i + 2])) &&
            (i === 0 || PDF.isWhite(bytes[i - 1]))) {
          end = i;
          break;
        }
      }
      if (end < 0) end = bytes.length;
      parser.pos = Math.min(end + 2, bytes.length);

      const square = [pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 1)];
      return this.inside(square) ? '' : null;
    }

    // The rewritten copy of a form, as its own object. Its dictionary is the
    // original's, minus the filters — these bytes are the decoded ones — and
    // with whatever its own contents had to add to its resources.
    rewriteForm(xo, sub) {
      const b = this.builder;
      const dict = b.copyDict(this.doc, xo.dict, null, 1);
      if (sub.adds.size) dict.set('Resources', withAdditions(b, dict.get('Resources'), 'XObject', sub.adds));
      dict.delete('Filter');
      dict.delete('DecodeParms');
      dict.set('Length', sub.bytes.length);
      return b.add(new PDFStream(dict, sub.bytes));
    }

    uniqueName(dict, stem) {
      for (;;) {
        const name = stem + (++this.names);
        if (!(dict instanceof Dict) || !dict.has(name)) return name;
      }
    }
  }

  // Adds entries to one category of a resource dictionary without touching the
  // dictionary the source document had: a copied /Resources is shared by every
  // page that shared it before, and one page's blackout is not the others'.
  function withAdditions(builder, resources, category, entries) {
    const base = builder.value(resources);
    const out = base instanceof Dict ? base.clone() : new Dict();
    const had = builder.value(out.get(category));
    const cat = had instanceof Dict ? had.clone() : new Dict();
    for (const [k, v] of entries) cat.set(k, v);
    out.set(category, cat);
    return out;
  }

  PDF.redact = {
    Redactor, rectsFromMarks, withAdditions,
    // The whole job for one page: content with the covered ink gone, plus the
    // resources that content now needs.
    page(doc, page, rects, builder) {
      return new Redactor(doc, rects, builder).page(page);
    },
  };

})(globalThis.PDF || (globalThis.PDF = {}));
