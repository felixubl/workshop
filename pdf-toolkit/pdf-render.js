// The renderer: a page's content stream, executed against a canvas.
//
// A content stream is a stack machine in postfix notation. `1 0 0 1 72 720 cm`
// pushes five numbers and then applies them as a matrix. Everything below is
// that loop, plus the state it has to keep: a graphics stack, a text object's
// two matrices, colour spaces that can be arbitrarily indirect, and resources
// that nest through form XObjects.
//
// Rendering is split in two. Images have to be decoded asynchronously (a JPEG
// is best handed to the browser's own decoder), so a preparation pass walks
// the resources and resolves every image to something drawable before the
// interpreter runs. The interpreter itself is then wholly synchronous, which
// is what makes nested forms and Type 3 glyphs tractable.

;(function (PDF) {
  'use strict';

  const { Name, Ref, Dict, PDFStream, Parser, EOF, PDFFont } = PDF;

  // --- matrices (a b c d e f), row-major as PDF writes them ------------------

  function mul(m, n) {
    return [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
    ];
  }

  function applyM(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  class GState {
    constructor() {
      this.ctm = [1, 0, 0, 1, 0, 0];
      this.strokeColor = '#000';
      this.fillColor = '#000';
      this.fillCS = { kind: 'DeviceGray', n: 1 };
      this.strokeCS = { kind: 'DeviceGray', n: 1 };
      this.lineWidth = 1;
      this.lineCap = 'butt';
      this.lineJoin = 'miter';
      this.miterLimit = 10;
      this.dash = null;
      this.dashPhase = 0;
      this.fillAlpha = 1;
      this.strokeAlpha = 1;
      this.font = null;
      this.fontSize = 0;
      this.charSpacing = 0;
      this.wordSpacing = 0;
      this.hscale = 1;
      this.leading = 0;
      this.rise = 0;
      this.renderMode = 0;
      this.fillPattern = null;
    }
    clone() { return Object.assign(new GState(), this); }
  }

  // --- colour ----------------------------------------------------------------

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

  function rgbString(r, g, b) {
    return 'rgb(' + clamp255(r * 255) + ',' + clamp255(g * 255) + ',' + clamp255(b * 255) + ')';
  }

  function cmykToRgb(c, m, y, k) {
    return [(1 - Math.min(1, c + k)), (1 - Math.min(1, m + k)), (1 - Math.min(1, y + k))];
  }

  class Renderer {
    constructor(doc, ctx, options) {
      this.doc = doc;
      this.ctx = ctx;
      this.opts = options || {};
      this.images = this.opts.images || new Map();
      this.fontCache = this.opts.fontCache || new Map();
      this.ops = 0;
      this.maxOps = this.opts.maxOps || 900000;
      this.depth = 0;
      this.textClipPath = null;
    }

    // --- entry point --------------------------------------------------------

    renderPage(page, baseMatrix) {
      const ctx = this.ctx;
      this.gs = new GState();
      this.gs.ctm = baseMatrix;
      this.stack = [];

      ctx.save();
      ctx.beginPath();
      try {
        this.execute(page.contentBytes, page.resources);
      } catch (e) {
        if (!(e && e.message === 'render-budget')) throw e;
      }
      ctx.restore();
    }

    // --- the interpreter ----------------------------------------------------

    execute(bytes, resources) {
      if (this.depth > 12) return;
      this.depth++;
      const parser = new Parser(bytes, 0, null);
      const stack = [];

      for (;;) {
        if (++this.ops > this.maxOps) { this.depth--; throw new Error('render-budget'); }
        let obj;
        try { obj = parser.parseObject(); } catch { break; }
        if (obj === EOF) break;

        if (obj && obj.type === 'kw') {
          try {
            if (obj.val === 'BI') {
              this.inlineImage(parser, resources);
            } else {
              this.operator(obj.val, stack, resources, parser);
            }
          } catch (e) {
            if (e && e.message === 'render-budget') { this.depth--; throw e; }
            // A single bad operator must not stop the page.
          }
          stack.length = 0;
        } else {
          stack.push(obj);
          if (stack.length > 64) stack.shift();
        }
      }
      this.depth--;
    }

    num(v, dflt) { return typeof v === 'number' && isFinite(v) ? v : (dflt || 0); }

    operator(op, s, res, parser) {
      const ctx = this.ctx, gs = this.gs;
      const n = (i) => this.num(s[i]);

      switch (op) {
        // --- graphics state
        case 'q':
          this.stack.push(gs.clone());
          ctx.save();
          break;
        case 'Q':
          if (this.stack.length) { this.gs = this.stack.pop(); ctx.restore(); }
          break;
        case 'cm':
          if (s.length >= 6) gs.ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm);
          break;
        case 'w': gs.lineWidth = Math.abs(n(0)); break;
        case 'J': gs.lineCap = ['butt', 'round', 'square'][n(0)] || 'butt'; break;
        case 'j': gs.lineJoin = ['miter', 'round', 'bevel'][n(0)] || 'miter'; break;
        case 'M': gs.miterLimit = n(0); break;
        case 'd':
          if (Array.isArray(s[0])) {
            const arr = s[0].map((v) => Math.abs(this.num(v))).filter((v) => isFinite(v));
            gs.dash = arr.length && arr.some((v) => v > 0) ? arr : null;
            gs.dashPhase = this.num(s[1]);
          }
          break;
        case 'gs': this.extGState(s[0], res); break;

        // --- path construction
        case 'm': this.path = this.path || []; this.path.push(['m', n(0), n(1)]); break;
        case 'l': if (this.path) this.path.push(['l', n(0), n(1)]); break;
        case 'c': if (this.path) this.path.push(['c', n(0), n(1), n(2), n(3), n(4), n(5)]); break;
        case 'v': if (this.path) this.path.push(['v', n(0), n(1), n(2), n(3)]); break;
        case 'y': if (this.path) this.path.push(['y', n(0), n(1), n(2), n(3)]); break;
        case 'h': if (this.path) this.path.push(['h']); break;
        case 're':
          this.path = this.path || [];
          this.path.push(['re', n(0), n(1), n(2), n(3)]);
          break;

        // --- path painting
        case 'S': this.paint(false, true, null); break;
        case 's': this.closeCurrent(); this.paint(false, true, null); break;
        case 'f': case 'F': this.paint(true, false, 'nonzero'); break;
        case 'f*': this.paint(true, false, 'evenodd'); break;
        case 'B': this.paint(true, true, 'nonzero'); break;
        case 'B*': this.paint(true, true, 'evenodd'); break;
        case 'b': this.closeCurrent(); this.paint(true, true, 'nonzero'); break;
        case 'b*': this.closeCurrent(); this.paint(true, true, 'evenodd'); break;
        case 'n': this.paint(false, false, null); break;
        case 'W': this.pendingClip = 'nonzero'; break;
        case 'W*': this.pendingClip = 'evenodd'; break;

        // --- colour
        case 'CS': gs.strokeCS = this.colorSpace(s[0], res); gs.strokeColor = this.initialColor(gs.strokeCS); break;
        case 'cs': gs.fillCS = this.colorSpace(s[0], res); gs.fillColor = this.initialColor(gs.fillCS); gs.fillPattern = null; break;
        case 'SC': case 'SCN': gs.strokeColor = this.componentsToCSS(gs.strokeCS, s, res, false); break;
        case 'sc': case 'scn': gs.fillColor = this.componentsToCSS(gs.fillCS, s, res, true); break;
        case 'G': gs.strokeCS = { kind: 'DeviceGray', n: 1 }; gs.strokeColor = rgbString(n(0), n(0), n(0)); break;
        case 'g': gs.fillCS = { kind: 'DeviceGray', n: 1 }; gs.fillColor = rgbString(n(0), n(0), n(0)); gs.fillPattern = null; break;
        case 'RG': gs.strokeCS = { kind: 'DeviceRGB', n: 3 }; gs.strokeColor = rgbString(n(0), n(1), n(2)); break;
        case 'rg': gs.fillCS = { kind: 'DeviceRGB', n: 3 }; gs.fillColor = rgbString(n(0), n(1), n(2)); gs.fillPattern = null; break;
        case 'K': {
          gs.strokeCS = { kind: 'DeviceCMYK', n: 4 };
          const c = cmykToRgb(n(0), n(1), n(2), n(3));
          gs.strokeColor = rgbString(c[0], c[1], c[2]);
          break;
        }
        case 'k': {
          gs.fillCS = { kind: 'DeviceCMYK', n: 4 };
          const c = cmykToRgb(n(0), n(1), n(2), n(3));
          gs.fillColor = rgbString(c[0], c[1], c[2]);
          gs.fillPattern = null;
          break;
        }

        // --- text
        case 'BT':
          this.tm = [1, 0, 0, 1, 0, 0];
          this.tlm = [1, 0, 0, 1, 0, 0];
          break;
        case 'ET':
          this.flushTextClip();
          this.tm = null;
          break;
        case 'Tc': gs.charSpacing = n(0); break;
        case 'Tw': gs.wordSpacing = n(0); break;
        case 'Tz': gs.hscale = n(0) / 100; break;
        case 'TL': gs.leading = n(0); break;
        case 'Ts': gs.rise = n(0); break;
        case 'Tr': gs.renderMode = n(0) | 0; break;
        case 'Tf':
          gs.fontSize = n(1);
          gs.font = this.lookupFont(s[0], res);
          break;
        case 'Td':
          this.tlm = mul([1, 0, 0, 1, n(0), n(1)], this.tlm || [1, 0, 0, 1, 0, 0]);
          this.tm = this.tlm.slice();
          break;
        case 'TD':
          gs.leading = -n(1);
          this.tlm = mul([1, 0, 0, 1, n(0), n(1)], this.tlm || [1, 0, 0, 1, 0, 0]);
          this.tm = this.tlm.slice();
          break;
        case 'Tm':
          if (s.length >= 6) {
            this.tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
            this.tm = this.tlm.slice();
          }
          break;
        case 'T*':
          this.tlm = mul([1, 0, 0, 1, 0, -gs.leading], this.tlm || [1, 0, 0, 1, 0, 0]);
          this.tm = this.tlm.slice();
          break;
        case 'Tj':
          if (typeof s[0] === 'string') this.showText(s[0], res);
          break;
        case "'":
          this.tlm = mul([1, 0, 0, 1, 0, -gs.leading], this.tlm || [1, 0, 0, 1, 0, 0]);
          this.tm = this.tlm.slice();
          if (typeof s[0] === 'string') this.showText(s[0], res);
          break;
        case '"':
          gs.wordSpacing = n(0);
          gs.charSpacing = n(1);
          this.tlm = mul([1, 0, 0, 1, 0, -gs.leading], this.tlm || [1, 0, 0, 1, 0, 0]);
          this.tm = this.tlm.slice();
          if (typeof s[2] === 'string') this.showText(s[2], res);
          break;
        case 'TJ':
          if (Array.isArray(s[0])) {
            for (const item of s[0]) {
              if (typeof item === 'string') this.showText(item, res);
              else if (typeof item === 'number') this.adjustText(item);
            }
          }
          break;

        // --- XObjects and shading
        case 'Do': this.doXObject(s[0], res); break;
        case 'sh': this.doShading(s[0], res); break;

        // Type 3 glyph metrics, and marked content: nothing to draw.
        case 'd0': case 'd1': case 'BMC': case 'BDC': case 'EMC':
        case 'MP': case 'DP': case 'BX': case 'EX': case 'ri': case 'i':
          break;
        default:
          break;
      }
    }

    // --- paths ---------------------------------------------------------------

    closeCurrent() { if (this.path) this.path.push(['h']); }

    // Builds the accumulated path in device space. Coordinates are transformed
    // here rather than by setting a canvas transform, so that line width stays
    // in user space while the geometry does not have to be re-derived.
    buildPath(matrix) {
      const ctx = this.ctx;
      ctx.beginPath();
      let sx = 0, sy = 0, cx = 0, cy = 0;
      for (const seg of this.path || []) {
        switch (seg[0]) {
          case 'm': {
            const p = applyM(matrix, seg[1], seg[2]);
            ctx.moveTo(p[0], p[1]);
            sx = cx = seg[1]; sy = cy = seg[2];
            break;
          }
          case 'l': {
            const p = applyM(matrix, seg[1], seg[2]);
            ctx.lineTo(p[0], p[1]);
            cx = seg[1]; cy = seg[2];
            break;
          }
          case 'c': {
            const a = applyM(matrix, seg[1], seg[2]);
            const b = applyM(matrix, seg[3], seg[4]);
            const c = applyM(matrix, seg[5], seg[6]);
            ctx.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
            cx = seg[5]; cy = seg[6];
            break;
          }
          case 'v': {
            const a = applyM(matrix, cx, cy);
            const b = applyM(matrix, seg[1], seg[2]);
            const c = applyM(matrix, seg[3], seg[4]);
            ctx.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
            cx = seg[3]; cy = seg[4];
            break;
          }
          case 'y': {
            const a = applyM(matrix, seg[1], seg[2]);
            const c = applyM(matrix, seg[3], seg[4]);
            ctx.bezierCurveTo(a[0], a[1], c[0], c[1], c[0], c[1]);
            cx = seg[3]; cy = seg[4];
            break;
          }
          case 'h':
            ctx.closePath();
            cx = sx; cy = sy;
            break;
          case 're': {
            const [, x, y, w, h] = seg;
            const p0 = applyM(matrix, x, y);
            const p1 = applyM(matrix, x + w, y);
            const p2 = applyM(matrix, x + w, y + h);
            const p3 = applyM(matrix, x, y + h);
            ctx.moveTo(p0[0], p0[1]);
            ctx.lineTo(p1[0], p1[1]);
            ctx.lineTo(p2[0], p2[1]);
            ctx.lineTo(p3[0], p3[1]);
            ctx.closePath();
            sx = cx = x; sy = cy = y;
            break;
          }
        }
      }
    }

    paint(fill, stroke, rule) {
      const ctx = this.ctx, gs = this.gs;
      if (!this.path || !this.path.length) {
        if (this.pendingClip) this.pendingClip = null;
        this.path = null;
        return;
      }
      this.buildPath(gs.ctm);

      if (fill) {
        ctx.globalAlpha = gs.fillAlpha;
        ctx.fillStyle = gs.fillPattern || gs.fillColor;
        ctx.fill(rule || 'nonzero');
      }
      if (stroke) {
        ctx.globalAlpha = gs.strokeAlpha;
        ctx.strokeStyle = gs.strokeColor;
        // Line width is in user space, so scale it by the transform. A zero
        // width means "thinnest line the device can draw", not "invisible".
        const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
        ctx.lineWidth = Math.max(gs.lineWidth * scale, 0.6);
        ctx.lineCap = gs.lineCap;
        ctx.lineJoin = gs.lineJoin;
        ctx.miterLimit = Math.max(1, gs.miterLimit);
        if (gs.dash) {
          ctx.setLineDash(gs.dash.map((v) => v * scale));
          ctx.lineDashOffset = gs.dashPhase * scale;
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
      }
      if (this.pendingClip) {
        ctx.clip(this.pendingClip);
        this.pendingClip = null;
      }
      ctx.globalAlpha = 1;
      this.path = null;
    }

    // --- resources -----------------------------------------------------------

    resourceDict(res, category) {
      const d = this.doc.get(res, category);
      return d instanceof Dict ? d : null;
    }

    extGState(nameObj, res) {
      if (!(nameObj instanceof Name)) return;
      const egs = this.resourceDict(res, 'ExtGState');
      const g = egs ? this.doc.get(egs, nameObj.name) : null;
      if (!(g instanceof Dict)) return;
      const doc = this.doc, gs = this.gs;

      const ca = doc.get(g, 'ca');
      if (typeof ca === 'number') gs.fillAlpha = Math.max(0, Math.min(1, ca));
      const CA = doc.get(g, 'CA');
      if (typeof CA === 'number') gs.strokeAlpha = Math.max(0, Math.min(1, CA));
      const lw = doc.get(g, 'LW');
      if (typeof lw === 'number') gs.lineWidth = Math.abs(lw);
      const lc = doc.get(g, 'LC');
      if (typeof lc === 'number') gs.lineCap = ['butt', 'round', 'square'][lc] || 'butt';
      const lj = doc.get(g, 'LJ');
      if (typeof lj === 'number') gs.lineJoin = ['miter', 'round', 'bevel'][lj] || 'miter';
      const font = doc.get(g, 'Font');
      if (Array.isArray(font) && font.length >= 2) {
        const fd = doc.resolve(font[0]);
        if (fd instanceof Dict) {
          gs.font = this.fontFor(font[0], fd);
          gs.fontSize = this.num(doc.resolve(font[1]));
        }
      }
      const d = doc.get(g, 'D');
      if (Array.isArray(d) && Array.isArray(doc.resolve(d[0]))) {
        const arr = doc.resolve(d[0]).map((v) => Math.abs(this.num(doc.resolve(v))));
        gs.dash = arr.length && arr.some((v) => v > 0) ? arr : null;
        gs.dashPhase = this.num(doc.resolve(d[1]));
      }
    }

    // --- colour spaces -------------------------------------------------------

    colorSpace(nameObj, res) {
      const doc = this.doc;
      let cs = nameObj;
      if (cs instanceof Name) {
        const simple = this.simpleColorSpace(cs.name);
        if (simple) return simple;
        const dict = this.resourceDict(res, 'ColorSpace');
        const looked = dict ? doc.get(dict, cs.name) : null;
        if (looked !== undefined && looked !== null) cs = looked;
        else return { kind: 'DeviceGray', n: 1 };
      }
      return this.parseColorSpace(cs, res, 0);
    }

    simpleColorSpace(name) {
      if (name === 'DeviceGray' || name === 'G' || name === 'CalGray') return { kind: 'DeviceGray', n: 1 };
      if (name === 'DeviceRGB' || name === 'RGB' || name === 'CalRGB') return { kind: 'DeviceRGB', n: 3 };
      if (name === 'DeviceCMYK' || name === 'CMYK') return { kind: 'DeviceCMYK', n: 4 };
      if (name === 'Pattern') return { kind: 'Pattern', n: 1 };
      return null;
    }

    parseColorSpace(cs, res, depth) {
      const doc = this.doc;
      cs = doc.resolve(cs);
      if (depth > 8) return { kind: 'DeviceGray', n: 1 };
      if (cs instanceof Name) {
        const simple = this.simpleColorSpace(cs.name);
        return simple || { kind: 'DeviceGray', n: 1 };
      }
      if (!Array.isArray(cs) || !cs.length) return { kind: 'DeviceGray', n: 1 };

      const head = doc.resolve(cs[0]);
      const kind = head instanceof Name ? head.name : '';

      switch (kind) {
        case 'ICCBased': {
          const stream = doc.resolve(cs[1]);
          const comps = stream instanceof PDFStream ? doc.get(stream.dict, 'N') : 3;
          if (comps === 1) return { kind: 'DeviceGray', n: 1 };
          if (comps === 4) return { kind: 'DeviceCMYK', n: 4 };
          return { kind: 'DeviceRGB', n: 3 };
        }
        case 'Indexed': case 'I': {
          const base = this.parseColorSpace(cs[1], res, depth + 1);
          const lookupRaw = doc.resolve(cs[3]);
          let table = null;
          if (typeof lookupRaw === 'string') table = PDF.latin1ToBytes(lookupRaw);
          else if (lookupRaw instanceof PDFStream) {
            const ref = cs[3];
            try { table = doc.decodeStreamBytes(lookupRaw, ref && ref.num); } catch { table = null; }
          }
          return { kind: 'Indexed', n: 1, base, table, hival: this.num(doc.resolve(cs[2])) };
        }
        case 'Separation': case 'DeviceN': {
          const alt = this.parseColorSpace(cs[2], res, depth + 1);
          const names = doc.resolve(cs[1]);
          const count = kind === 'Separation' ? 1 : (Array.isArray(names) ? names.length : 1);
          return { kind: 'Separation', n: count, alt, fn: doc.resolve(cs[3]) };
        }
        case 'CalRGB': return { kind: 'DeviceRGB', n: 3 };
        case 'CalGray': return { kind: 'DeviceGray', n: 1 };
        case 'Lab': return { kind: 'Lab', n: 3 };
        case 'Pattern': return { kind: 'Pattern', n: 1, under: cs[1] ? this.parseColorSpace(cs[1], res, depth + 1) : null };
        case 'DeviceGray': return { kind: 'DeviceGray', n: 1 };
        case 'DeviceRGB': return { kind: 'DeviceRGB', n: 3 };
        case 'DeviceCMYK': return { kind: 'DeviceCMYK', n: 4 };
        default: return { kind: 'DeviceRGB', n: 3 };
      }
    }

    initialColor(cs) { return cs.kind === 'DeviceCMYK' ? rgbString(0, 0, 0) : '#000'; }

    // Turns a component list into a CSS colour. Separation and DeviceN would
    // need their tint transform function evaluated; approximating the tint as
    // ink coverage is close enough for a preview and never wildly wrong.
    componentsToCSS(cs, s, res, isFill) {
      const nums = s.filter((v) => typeof v === 'number');

      if (cs.kind === 'Pattern') {
        const patName = s[s.length - 1];
        if (isFill) this.gs.fillPattern = this.patternStyle(patName, res);
        return this.gs.fillPattern ? '#808080' : '#808080';
      }
      if (isFill) this.gs.fillPattern = null;

      return this.toCSS(cs, nums);
    }

    toCSS(cs, nums) {
      switch (cs.kind) {
        case 'DeviceGray':
          return rgbString(nums[0] || 0, nums[0] || 0, nums[0] || 0);
        case 'DeviceRGB':
          return rgbString(nums[0] || 0, nums[1] || 0, nums[2] || 0);
        case 'DeviceCMYK': {
          const c = cmykToRgb(nums[0] || 0, nums[1] || 0, nums[2] || 0, nums[3] || 0);
          return rgbString(c[0], c[1], c[2]);
        }
        case 'Lab': {
          const L = nums[0] || 0;
          const v = Math.max(0, Math.min(1, L / 100));
          return rgbString(v, v, v);
        }
        case 'Indexed': {
          const i = Math.max(0, (nums[0] || 0) | 0);
          const base = cs.base || { kind: 'DeviceRGB', n: 3 };
          const bn = base.n || 3;
          if (!cs.table) return '#000';
          const comps = [];
          for (let k = 0; k < bn; k++) comps.push((cs.table[i * bn + k] || 0) / 255);
          return this.toCSS(base, comps);
        }
        case 'Separation': {
          // Tint 0 is no ink, tint 1 is full ink.
          const tint = Math.max(0, Math.min(1, nums[0] === undefined ? 1 : nums[0]));
          if (cs.alt && cs.alt.kind === 'DeviceCMYK') {
            const c = cmykToRgb(0, 0, 0, tint);
            return rgbString(c[0], c[1], c[2]);
          }
          return rgbString(1 - tint, 1 - tint, 1 - tint);
        }
        default:
          return '#000';
      }
    }

    patternStyle(nameObj, res) {
      if (!(nameObj instanceof Name)) return null;
      const pats = this.resourceDict(res, 'Pattern');
      const pat = pats ? this.doc.get(pats, nameObj.name) : null;
      const dict = pat instanceof PDFStream ? pat.dict : pat;
      if (!(dict instanceof Dict)) return null;
      // A shading pattern gets its average colour; a tiling pattern gets grey.
      const shading = this.doc.get(dict, 'Shading');
      if (shading) {
        const grad = this.shadingStyle(shading, this.gs.ctm);
        if (grad) return grad;
      }
      return null;
    }

    // --- shadings -------------------------------------------------------------

    doShading(nameObj, res) {
      if (!(nameObj instanceof Name)) return;
      const shs = this.resourceDict(res, 'Shading');
      const sh = shs ? this.doc.get(shs, nameObj.name) : null;
      if (!sh) return;
      const style = this.shadingStyle(sh, this.gs.ctm);
      if (!style) return;
      const ctx = this.ctx;
      ctx.globalAlpha = this.gs.fillAlpha;
      ctx.fillStyle = style;
      // `sh` paints the current clip region.
      ctx.fillRect(0, 0, this.opts.width || 10000, this.opts.height || 10000);
      ctx.globalAlpha = 1;
    }

    // Axial and radial shadings map onto canvas gradients directly. Function
    // based and mesh shadings do not, and fall back to their average colour.
    shadingStyle(shObj, ctm) {
      const doc = this.doc;
      const sh = doc.resolve(shObj);
      const dict = sh instanceof PDFStream ? sh.dict : sh;
      if (!(dict instanceof Dict)) return null;

      const type = doc.get(dict, 'ShadingType');
      const cs = this.parseColorSpace(dict.get('ColorSpace'), null, 0);
      const fn = doc.get(dict, 'Function');
      const stops = this.sampleFunction(fn, cs);
      if (!stops.length) return null;

      const coords = doc.get(dict, 'Coords');
      const ctx = this.ctx;

      try {
        if (type === 2 && Array.isArray(coords) && coords.length >= 4) {
          const p0 = applyM(ctm, this.num(doc.resolve(coords[0])), this.num(doc.resolve(coords[1])));
          const p1 = applyM(ctm, this.num(doc.resolve(coords[2])), this.num(doc.resolve(coords[3])));
          const g = ctx.createLinearGradient(p0[0], p0[1], p1[0], p1[1]);
          stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1 || 1), c));
          return g;
        }
        if (type === 3 && Array.isArray(coords) && coords.length >= 6) {
          const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
          const c0 = applyM(ctm, this.num(doc.resolve(coords[0])), this.num(doc.resolve(coords[1])));
          const r0 = Math.abs(this.num(doc.resolve(coords[2]))) * scale;
          const c1 = applyM(ctm, this.num(doc.resolve(coords[3])), this.num(doc.resolve(coords[4])));
          const r1 = Math.abs(this.num(doc.resolve(coords[5]))) * scale;
          const g = ctx.createRadialGradient(c0[0], c0[1], r0, c1[0], c1[1], r1);
          stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1 || 1), c));
          return g;
        }
      } catch { /* degenerate gradient geometry */ }

      return stops[Math.floor(stops.length / 2)];
    }

    // Evaluates a PDF function at a few points across its domain. Sampled
    // (type 0) and PostScript (type 4) functions are approximated by their
    // endpoints, which is enough to keep a gradient's direction and range.
    sampleFunction(fn, cs) {
      const doc = this.doc;
      const out = [];
      const STEPS = 16;
      const fns = Array.isArray(fn) ? fn.map((f) => doc.resolve(f)) : [doc.resolve(fn)];

      const evalOne = (f, t) => {
        const d = f instanceof PDFStream ? f.dict : f;
        if (!(d instanceof Dict)) return null;
        const type = doc.get(d, 'FunctionType');
        if (type === 2) {
          const c0 = (doc.get(d, 'C0') || [0]).map((v) => this.num(doc.resolve(v)));
          const c1 = (doc.get(d, 'C1') || [1]).map((v) => this.num(doc.resolve(v)));
          const nExp = this.num(doc.get(d, 'N'), 1) || 1;
          const k = Math.pow(t, nExp);
          const len = Math.max(c0.length, c1.length);
          const comps = [];
          for (let i = 0; i < len; i++) {
            const a = c0[i] === undefined ? 0 : c0[i];
            const b = c1[i] === undefined ? 1 : c1[i];
            comps.push(a + k * (b - a));
          }
          return comps;
        }
        if (type === 3) {
          const subs = doc.get(d, 'Functions');
          const bounds = (doc.get(d, 'Bounds') || []).map((v) => this.num(doc.resolve(v)));
          const domain = (doc.get(d, 'Domain') || [0, 1]).map((v) => this.num(doc.resolve(v)));
          if (!Array.isArray(subs) || !subs.length) return null;
          let i = 0;
          while (i < bounds.length && t >= bounds[i]) i++;
          const lo = i === 0 ? domain[0] : bounds[i - 1];
          const hi = i === bounds.length ? domain[1] : bounds[i];
          const local = hi > lo ? (t - lo) / (hi - lo) : 0;
          return evalOne(doc.resolve(subs[Math.min(i, subs.length - 1)]), local);
        }
        if (type === 0) {
          // Sampled: read the first and last sample and interpolate.
          const range = (doc.get(d, 'Range') || []).map((v) => this.num(doc.resolve(v)));
          const nOut = range.length >> 1;
          if (!nOut) return null;
          const comps = [];
          for (let i = 0; i < nOut; i++) {
            const lo = range[i * 2], hi = range[i * 2 + 1];
            comps.push(lo + t * (hi - lo));
          }
          return comps;
        }
        return null;
      };

      for (let i = 0; i < STEPS; i++) {
        const t = i / (STEPS - 1);
        let comps = null;
        if (fns.length > 1) {
          comps = [];
          for (const f of fns) {
            const v = evalOne(f, t);
            comps.push(v && v.length ? v[0] : 0);
          }
        } else {
          comps = evalOne(fns[0], t);
        }
        if (!comps) return out;
        out.push(this.toCSS(cs, comps));
      }
      return out;
    }

    // --- fonts ----------------------------------------------------------------

    lookupFont(nameObj, res) {
      if (!(nameObj instanceof Name)) return this.gs.font;
      const fonts = this.resourceDict(res, 'Font');
      if (!fonts) return this.gs.font;
      const ref = fonts.get(nameObj.name);
      const fd = this.doc.resolve(ref);
      if (!(fd instanceof Dict)) return this.gs.font;
      return this.fontFor(ref, fd);
    }

    fontFor(ref, dict) {
      const key = ref instanceof Ref ? 'r' + ref.num : dict;
      if (this.fontCache.has(key)) return this.fontCache.get(key);
      const font = new PDFFont(this.doc, dict);
      this.fontCache.set(key, font);
      return font;
    }

    adjustText(amount) {
      const gs = this.gs;
      if (!this.tm) return;
      const tx = -amount / 1000 * gs.fontSize * gs.hscale;
      this.tm = mul([1, 0, 0, 1, tx, 0], this.tm);
    }

    showText(str, res) {
      const gs = this.gs, ctx = this.ctx;
      const font = gs.font;
      if (!this.tm) this.tm = [1, 0, 0, 1, 0, 0];
      if (!font) return;

      const invisible = gs.renderMode === 3 || gs.renderMode === 7;
      const codes = font.decode(str);

      for (const code of codes) {
        const width = font.widthOf(code) / 1000 * gs.fontSize;

        if (!invisible) {
          // Text space -> user space -> device space, all at once.
          const trm = mul(mul([gs.fontSize * gs.hscale, 0, 0, gs.fontSize, 0, gs.rise], this.tm), gs.ctm);
          this.drawGlyph(font, code, trm, res);
        }

        let advance = width + gs.charSpacing;
        // Word spacing applies to the single byte 32, never to a two byte code.
        if (code === 32 && !font.twoByte) advance += gs.wordSpacing;
        this.tm = mul([1, 0, 0, 1, advance * gs.hscale, 0], this.tm);
      }
    }

    drawGlyph(font, code, trm, res) {
      const ctx = this.ctx, gs = this.gs;
      const stroke = gs.renderMode === 1 || gs.renderMode === 5;
      const both = gs.renderMode === 2 || gs.renderMode === 6;
      const clip = gs.renderMode >= 4;

      if (font.kind === 'type3') { this.drawType3Glyph(font, code, trm, res); return; }

      const d = font.pathFor(code);
      if (d) {
        const fm = font.fontMatrix;
        const m = mul([fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]], trm);
        let path;
        try { path = new Path2D(d); } catch { return; }

        ctx.save();
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.globalAlpha = stroke ? gs.strokeAlpha : gs.fillAlpha;
        if (stroke || both) {
          ctx.strokeStyle = gs.strokeColor;
          const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
          ctx.lineWidth = gs.lineWidth / scale;
          ctx.stroke(path);
        }
        if (!stroke) {
          ctx.fillStyle = gs.fillPattern || gs.fillColor;
          ctx.fill(path, 'nonzero');
        }
        ctx.restore();
        ctx.globalAlpha = 1;
        return;
      }

      // No outline available: draw with a substitute face, scaled so the glyph
      // occupies exactly the advance the document expects. Without that
      // correction the substitute's own metrics would push the line out of
      // shape and columns would stop lining up.
      const text = font.unicodeFor(code);
      if (!text || text === ' ') return;
      const sub = font.substitute || { family: 'sans-serif', weight: '400', style: 'normal' };
      const expected = font.widthOf(code) / 1000;

      ctx.save();
      ctx.transform(trm[0], trm[1], trm[2], trm[3], trm[4], trm[5]);
      ctx.scale(1, -1);                       // text space has y up, canvas down
      ctx.font = sub.style + ' ' + sub.weight + ' 1px ' + sub.family;
      let actual = 0;
      try { actual = ctx.measureText(text).width; } catch { actual = 0; }
      if (expected > 0 && actual > 0) {
        const k = expected / actual;
        if (k > 0.2 && k < 5) ctx.scale(k, 1);
      }
      ctx.globalAlpha = stroke ? gs.strokeAlpha : gs.fillAlpha;
      ctx.fillStyle = gs.fillColor;
      try { ctx.fillText(text, 0, 0); } catch { /* unrenderable */ }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // A Type 3 glyph is a little content stream of its own.
    drawType3Glyph(font, code, trm, res) {
      const name = font.glyphNameFor(code);
      if (!name || !(font.charProcs instanceof Dict)) return;
      const procRef = font.charProcs.get(name);
      const proc = this.doc.resolve(procRef);
      if (!(proc instanceof PDFStream)) return;

      let bytes;
      try { bytes = this.doc.decodeStreamBytes(proc, procRef && procRef.num); } catch { return; }

      const fm = font.fontMatrix;
      const saved = this.gs;
      const savedPath = this.path;
      const savedTm = this.tm, savedTlm = this.tlm;

      this.gs = saved.clone();
      this.gs.ctm = mul([fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]], trm);
      this.path = null;
      this.ctx.save();
      try {
        this.execute(bytes, font.type3Resources instanceof Dict ? font.type3Resources : res);
      } catch (e) {
        if (e && e.message === 'render-budget') { this.ctx.restore(); this.gs = saved; throw e; }
      }
      this.ctx.restore();
      this.gs = saved;
      this.path = savedPath;
      this.tm = savedTm; this.tlm = savedTlm;
    }

    flushTextClip() { /* text clipping modes are treated as plain fills */ }

    // --- XObjects --------------------------------------------------------------

    doXObject(nameObj, res) {
      if (!(nameObj instanceof Name)) return;
      const xobjs = this.resourceDict(res, 'XObject');
      if (!xobjs) return;
      const ref = xobjs.get(nameObj.name);
      const xo = this.doc.resolve(ref);
      if (!(xo instanceof PDFStream)) return;

      const subtype = this.doc.get(xo.dict, 'Subtype');
      const kind = subtype instanceof Name ? subtype.name : '';

      if (kind === 'Image') {
        this.drawImage(ref, xo);
      } else if (kind === 'Form') {
        this.drawForm(ref, xo, res);
      }
    }

    drawForm(ref, xo, parentRes) {
      const doc = this.doc;
      const saved = this.gs;
      const savedPath = this.path;
      this.gs = saved.clone();

      const matrix = doc.get(xo.dict, 'Matrix');
      if (Array.isArray(matrix) && matrix.length >= 6) {
        const m = matrix.map((v) => this.num(doc.resolve(v)));
        this.gs.ctm = mul(m, this.gs.ctm);
      }

      this.ctx.save();
      const bbox = doc.get(xo.dict, 'BBox');
      if (Array.isArray(bbox) && bbox.length >= 4) {
        const b = bbox.map((v) => this.num(doc.resolve(v)));
        this.path = [['re', Math.min(b[0], b[2]), Math.min(b[1], b[3]),
                      Math.abs(b[2] - b[0]), Math.abs(b[3] - b[1])]];
        this.buildPath(this.gs.ctm);
        this.ctx.clip();
        this.path = null;
      }

      const formRes = doc.get(xo.dict, 'Resources');
      let bytes;
      try { bytes = doc.decodeStreamBytes(xo, ref && ref.num); } catch { bytes = null; }
      if (bytes) {
        try {
          this.execute(bytes, formRes instanceof Dict ? formRes : parentRes);
        } catch (e) {
          this.ctx.restore();
          this.gs = saved;
          this.path = savedPath;
          throw e;
        }
      }

      this.ctx.restore();
      this.gs = saved;
      this.path = savedPath;
    }

    // Images are drawn into the unit square, which the CTM maps to wherever
    // the page wants them. The y flip is because image space runs downward.
    drawImage(ref, xo) {
      const key = ref instanceof Ref ? 'i' + ref.num : xo;
      const drawable = this.images.get(key);
      if (!drawable) return;
      const gs = this.gs;
      const ctx = this.ctx;
      const m = mul([1 / drawable.width, 0, 0, -1 / drawable.height, 0, 1], gs.ctm);

      ctx.save();
      ctx.globalAlpha = gs.fillAlpha;
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      // Smoothing off would show the nearest-neighbour blockiness of a
      // downscaled scan; on, a thumbnail of a 3000px scan looks like the page.
      ctx.imageSmoothingEnabled = true;
      try {
        if (drawable.isMask) {
          // A stencil mask paints the fill colour through its opaque pixels.
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(drawable.canvas, 0, 0);
        } else {
          ctx.drawImage(drawable.canvas, 0, 0);
        }
      } catch { /* not drawable */ }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    inlineImage(parser, res) {
      // BI <dict entries> ID <bytes> EI
      const dict = new Dict();
      for (;;) {
        const k = parser.parseObject();
        if (k === EOF) return;
        if (k && k.type === 'kw' && k.val === 'ID') break;
        const v = parser.parseObject();
        if (v === EOF) return;
        if (k instanceof Name) dict.set(k.name, v);
      }
      // Data starts after one whitespace byte and runs to `EI`.
      const bytes = parser.buf;
      let p = parser.lexer.pos;
      if (PDF.isWhite(bytes[p])) p++;
      const start = p;
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

      const key = this.inlineKey(start, end);
      const drawable = this.images.get(key);
      if (drawable) {
        const saved = this.images.get('__inline__');
        this.images.set('__tmp__', drawable);
        const gs = this.gs, ctx = this.ctx;
        const m = mul([1 / drawable.width, 0, 0, -1 / drawable.height, 0, 1], gs.ctm);
        ctx.save();
        ctx.globalAlpha = gs.fillAlpha;
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        try { ctx.drawImage(drawable.canvas, 0, 0); } catch { /* skip */ }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    inlineKey(start, end) { return 'inline:' + start + ':' + end; }
  }

  PDF.Renderer = Renderer;
  PDF.mat = { mul, apply: applyM };
  PDF.rgbString = rgbString;
  PDF.cmykToRgb = cmykToRgb;

})(globalThis.PDF || (globalThis.PDF = {}));
