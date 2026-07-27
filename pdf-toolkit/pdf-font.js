// Fonts: character codes in, glyph outlines out.
//
// A PDF does not draw text, it draws glyphs. Turning `(Hello) Tj` into shapes
// means answering three questions per byte: which glyph does this code select,
// how far does the pen move afterwards, and what does that glyph look like.
// The first two come out of the font dictionary, the third out of the embedded
// font program — a TrueType or CFF file sitting in a stream.
//
// Outlines are parsed straight into SVG path syntax, which Path2D takes
// directly. The alternative, handing the font bytes to FontFace and drawing
// with fillText, would mean rebuilding each font's character map to work
// around subsetting, and would make the whole engine asynchronous.

;(function (PDF) {
  'use strict';

  const { Name, Ref, Dict, PDFStream } = PDF;

  // --- byte readers ---------------------------------------------------------

  class Reader {
    constructor(data, pos) { this.d = data; this.p = pos || 0; }
    u8() { return this.d[this.p++]; }
    i8() { const v = this.d[this.p++]; return v > 127 ? v - 256 : v; }
    u16() { const v = (this.d[this.p] << 8) | this.d[this.p + 1]; this.p += 2; return v; }
    i16() { const v = this.u16(); return v > 32767 ? v - 65536 : v; }
    u32() {
      const v = ((this.d[this.p] << 24) | (this.d[this.p + 1] << 16) |
                 (this.d[this.p + 2] << 8) | this.d[this.p + 3]) >>> 0;
      this.p += 4; return v;
    }
    tag() {
      let s = '';
      for (let i = 0; i < 4; i++) s += String.fromCharCode(this.d[this.p++]);
      return s;
    }
    get ok() { return this.p < this.d.length; }
  }

  // Accumulates an SVG path. Numbers are rounded to whole font units, which is
  // below a rendered pixel at any sane size and keeps the strings short.
  class PathBuilder {
    constructor() { this.parts = []; this.open = false; }
    moveTo(x, y) {
      if (this.open) this.parts.push('Z');
      this.parts.push('M' + r(x) + ' ' + r(y));
      this.open = true;
    }
    lineTo(x, y) { this.parts.push('L' + r(x) + ' ' + r(y)); }
    quadTo(cx, cy, x, y) {
      this.parts.push('Q' + r(cx) + ' ' + r(cy) + ' ' + r(x) + ' ' + r(y));
    }
    curveTo(c1x, c1y, c2x, c2y, x, y) {
      this.parts.push('C' + r(c1x) + ' ' + r(c1y) + ' ' + r(c2x) + ' ' + r(c2y) +
                      ' ' + r(x) + ' ' + r(y));
    }
    close() { if (this.open) { this.parts.push('Z'); this.open = false; } }
    toString() {
      if (this.open) { this.parts.push('Z'); this.open = false; }
      return this.parts.join('');
    }
  }

  function r(v) { return Math.round(v * 100) / 100; }

  // --- TrueType -------------------------------------------------------------

  class TrueTypeFont {
    constructor(data) {
      this.data = data;
      this.tables = {};
      this.unitsPerEm = 1000;
      this.numGlyphs = 0;
      this.locaOffsets = null;
      this.cmap = null;
      this.cff = null;                 // OpenType/CFF keeps outlines in a CFF table
      this.parse();
    }

    parse() {
      const rd = new Reader(this.data, 0);
      let version = rd.u32();
      if (version === 0x74746366) {    // 'ttcf': a collection, take the first face
        rd.u32();                      // version
        rd.u32();                      // numFonts
        rd.p = rd.u32();
        version = rd.u32();
      }
      const numTables = rd.u16();
      rd.p += 6;
      for (let i = 0; i < numTables && i < 512; i++) {
        const tag = rd.tag();
        rd.u32();
        const offset = rd.u32();
        const length = rd.u32();
        if (offset < this.data.length) {
          this.tables[tag] = this.data.subarray(offset, Math.min(offset + length, this.data.length));
        }
      }

      if (this.tables['head']) {
        const h = new Reader(this.tables['head'], 18);
        this.unitsPerEm = h.u16() || 1000;
        h.p = 50;
        this.indexToLocFormat = h.i16();
      }
      if (this.tables['maxp']) this.numGlyphs = new Reader(this.tables['maxp'], 4).u16();

      // An OpenType font with CFF outlines carries them in a 'CFF ' table.
      if (this.tables['CFF ']) {
        try { this.cff = new CFFFont(this.tables['CFF ']); } catch { this.cff = null; }
      }

      this.parseLoca();
      this.parseCmap();
      this.parseHmtx();
    }

    parseLoca() {
      const loca = this.tables['loca'];
      if (!loca || !this.tables['glyf']) return;
      const n = this.numGlyphs + 1;
      const out = new Uint32Array(n);
      const rd = new Reader(loca, 0);
      if (this.indexToLocFormat === 0) {
        for (let i = 0; i < n && rd.p + 1 < loca.length; i++) out[i] = rd.u16() * 2;
      } else {
        for (let i = 0; i < n && rd.p + 3 < loca.length; i++) out[i] = rd.u32();
      }
      this.locaOffsets = out;
    }

    parseHmtx() {
      this.advances = null;
      const hhea = this.tables['hhea'], hmtx = this.tables['hmtx'];
      if (!hhea || !hmtx) return;
      const numH = new Reader(hhea, 34).u16();
      if (!numH) return;
      const out = new Uint16Array(this.numGlyphs || numH);
      const rd = new Reader(hmtx, 0);
      let last = 0;
      for (let i = 0; i < out.length; i++) {
        if (i < numH && rd.p + 1 < hmtx.length) { last = rd.u16(); rd.p += 2; }
        out[i] = last;
      }
      this.advances = out;
    }

    // Keeps two maps: one from Unicode (3,1 / 3,10 / 0,x) and one from raw
    // bytes (3,0 symbolic / 1,0 Macintosh), because a symbolic PDF font
    // addresses its own glyphs by code, not by character.
    parseCmap() {
      const cmap = this.tables['cmap'];
      if (!cmap) return;
      const rd = new Reader(cmap, 2);
      const n = rd.u16();
      let unicodeOff = -1, symbolOff = -1, macOff = -1;
      for (let i = 0; i < n; i++) {
        const platform = rd.u16(), encoding = rd.u16(), offset = rd.u32();
        if (platform === 3 && (encoding === 1 || encoding === 10)) unicodeOff = offset;
        else if (platform === 3 && encoding === 0) symbolOff = offset;
        else if (platform === 0) { if (unicodeOff < 0) unicodeOff = offset; }
        else if (platform === 1 && encoding === 0) macOff = offset;
      }
      this.cmap = unicodeOff >= 0 ? this.readCmapSubtable(cmap, unicodeOff) : null;
      this.symbolCmap = symbolOff >= 0 ? this.readCmapSubtable(cmap, symbolOff) : null;
      this.macCmap = macOff >= 0 ? this.readCmapSubtable(cmap, macOff) : null;
    }

    readCmapSubtable(cmap, offset) {
      if (offset >= cmap.length) return null;
      const rd = new Reader(cmap, offset);
      const format = rd.u16();
      const map = new Map();
      if (format === 0) {
        rd.u16(); rd.u16();
        for (let i = 0; i < 256; i++) map.set(i, rd.u8());
      } else if (format === 4) {
        const length = rd.u16();
        rd.u16();
        const segX2 = rd.u16();
        const segs = segX2 >> 1;
        rd.p += 6;
        const ends = [], starts = [], deltas = [], rangeOffsets = [], rangeAt = [];
        for (let i = 0; i < segs; i++) ends.push(rd.u16());
        rd.u16();
        for (let i = 0; i < segs; i++) starts.push(rd.u16());
        for (let i = 0; i < segs; i++) deltas.push(rd.i16());
        for (let i = 0; i < segs; i++) { rangeAt.push(rd.p); rangeOffsets.push(rd.u16()); }
        for (let i = 0; i < segs; i++) {
          const start = starts[i], end = ends[i];
          if (start > end || end === 0xffff && start === 0xffff) continue;
          for (let c = start; c <= end && c <= 0xffff; c++) {
            let g;
            if (rangeOffsets[i] === 0) {
              g = (c + deltas[i]) & 0xffff;
            } else {
              const gi = rangeAt[i] + rangeOffsets[i] + (c - start) * 2;
              if (gi + 1 >= cmap.length) continue;
              g = (cmap[gi] << 8) | cmap[gi + 1];
              if (g !== 0) g = (g + deltas[i]) & 0xffff;
            }
            if (g) map.set(c, g);
          }
        }
      } else if (format === 6) {
        rd.u16(); rd.u16();
        const first = rd.u16(), count = rd.u16();
        for (let i = 0; i < count; i++) map.set(first + i, rd.u16());
      } else if (format === 12) {
        rd.u16(); rd.u32(); rd.u32();
        const groups = rd.u32();
        for (let i = 0; i < groups && i < 200000; i++) {
          const start = rd.u32(), end = rd.u32(), gid = rd.u32();
          for (let c = start; c <= end && c - start < 65536; c++) map.set(c, gid + (c - start));
        }
      }
      return map.size ? map : null;
    }

    glyphPath(gid, depth) {
      if (this.cff) return this.cff.glyphPath(gid, depth);
      if (!this.locaOffsets || !this.tables['glyf']) return '';
      if (gid < 0 || gid + 1 >= this.locaOffsets.length) return '';
      const start = this.locaOffsets[gid], end = this.locaOffsets[gid + 1];
      if (end <= start || start >= this.tables['glyf'].length) return '';

      const glyf = this.tables['glyf'].subarray(start, Math.min(end, this.tables['glyf'].length));
      const rd = new Reader(glyf, 0);
      const contours = rd.i16();
      rd.p += 8;                        // bounding box

      const path = new PathBuilder();
      if (contours >= 0) this.simpleGlyph(rd, contours, path);
      else this.compositeGlyph(rd, path, depth || 0);
      return path.toString();
    }

    simpleGlyph(rd, contours, path) {
      const endPts = [];
      for (let i = 0; i < contours; i++) endPts.push(rd.u16());
      const numPts = contours ? endPts[contours - 1] + 1 : 0;
      if (numPts <= 0 || numPts > 10000) return;

      const insLen = rd.u16();
      rd.p += insLen;

      const flags = new Uint8Array(numPts);
      for (let i = 0; i < numPts;) {
        const f = rd.u8();
        flags[i++] = f;
        if (f & 8) {                    // repeat
          let count = rd.u8();
          while (count-- > 0 && i < numPts) flags[i++] = f;
        }
      }

      const xs = new Int16Array(numPts), ys = new Int16Array(numPts);
      let v = 0;
      for (let i = 0; i < numPts; i++) {
        const f = flags[i];
        if (f & 2) { const d = rd.u8(); v += (f & 16) ? d : -d; }
        else if (!(f & 16)) v += rd.i16();
        xs[i] = v;
      }
      v = 0;
      for (let i = 0; i < numPts; i++) {
        const f = flags[i];
        if (f & 4) { const d = rd.u8(); v += (f & 32) ? d : -d; }
        else if (!(f & 32)) v += rd.i16();
        ys[i] = v;
      }

      // TrueType contours are quadratic, and consecutive off-curve points
      // imply an on-curve point halfway between them.
      let startPt = 0;
      for (let c = 0; c < contours; c++) {
        const endPt = endPts[c];
        if (endPt < startPt) { startPt = endPt + 1; continue; }
        const count = endPt - startPt + 1;
        const on = (i) => (flags[startPt + ((i % count) + count) % count] & 1) !== 0;
        const px = (i) => xs[startPt + ((i % count) + count) % count];
        const py = (i) => ys[startPt + ((i % count) + count) % count];

        let first = 0;
        while (first < count && !on(first)) first++;

        let sx, sy;
        if (first === count) {          // no on-curve point at all
          sx = (px(0) + px(1)) / 2;
          sy = (py(0) + py(1)) / 2;
          first = 0;
        } else {
          sx = px(first); sy = py(first);
        }
        path.moveTo(sx, sy);

        let i = first + 1;
        let cx = null, cy = null;
        for (let k = 0; k < count; k++, i++) {
          const x = px(i), y = py(i);
          if (on(i)) {
            if (cx === null) path.lineTo(x, y);
            else { path.quadTo(cx, cy, x, y); cx = null; }
          } else {
            if (cx !== null) path.quadTo(cx, cy, (cx + x) / 2, (cy + y) / 2);
            cx = x; cy = y;
          }
        }
        if (cx !== null) path.quadTo(cx, cy, sx, sy);
        path.close();
        startPt = endPt + 1;
      }
    }

    compositeGlyph(rd, path, depth) {
      if (depth > 5) return;
      for (let guard = 0; guard < 16; guard++) {
        const flags = rd.u16();
        const gid = rd.u16();
        let dx, dy;
        if (flags & 1) { dx = rd.i16(); dy = rd.i16(); }
        else { dx = rd.i8(); dy = rd.i8(); }

        let a = 1, b = 0, c = 0, d = 1;
        if (flags & 8) { a = d = f2dot14(rd.i16()); }
        else if (flags & 0x40) { a = f2dot14(rd.i16()); d = f2dot14(rd.i16()); }
        else if (flags & 0x80) {
          a = f2dot14(rd.i16()); b = f2dot14(rd.i16());
          c = f2dot14(rd.i16()); d = f2dot14(rd.i16());
        }
        if (!(flags & 2)) { dx = 0; dy = 0; }   // point matching, not supported

        const sub = this.glyphPath(gid, depth + 1);
        if (sub) path.parts.push(transformPath(sub, [a, b, c, d, dx, dy]));

        if (!(flags & 0x20)) break;             // no MORE_COMPONENTS
      }
    }
  }

  function f2dot14(v) { return v / 16384; }

  // Applies a matrix to an already-built path string. Composite glyphs are the
  // only caller, so this stays simple rather than fast.
  function transformPath(d, m) {
    const [a, b, c, dd, e, f] = m;
    return d.replace(/([MLQCZ])([^MLQCZ]*)/g, (_, op, args) => {
      if (op === 'Z') return 'Z';
      const nums = args.trim().split(/[\s,]+/).filter((s) => s !== '').map(Number);
      const out = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const x = nums[i], y = nums[i + 1];
        out.push(r(a * x + c * y + e), r(b * x + dd * y + f));
      }
      return op + out.join(' ');
    });
  }

  // --- CFF ------------------------------------------------------------------

  function readIndex(data, pos, isCFF2) {
    const rd = new Reader(data, pos);
    const count = rd.u16();
    if (count === 0) return { items: [], end: pos + 2 };
    const offSize = rd.u8();
    const offsets = [];
    for (let i = 0; i <= count; i++) {
      let v = 0;
      for (let k = 0; k < offSize; k++) v = (v << 8) | rd.u8();
      offsets.push(v);
    }
    const base = rd.p - 1;
    const items = [];
    for (let i = 0; i < count; i++) {
      const s = base + offsets[i], e = base + offsets[i + 1];
      items.push(data.subarray(Math.min(s, data.length), Math.min(e, data.length)));
    }
    return { items, end: base + offsets[count] };
  }

  function parseDict(data) {
    const dict = new Map();
    const operands = [];
    let p = 0;
    while (p < data.length) {
      let b = data[p];
      if (b <= 21) {
        let op = b;
        p++;
        if (b === 12) { op = 1200 + data[p]; p++; }
        dict.set(op, operands.slice());
        operands.length = 0;
      } else if (b === 28) {
        operands.push(((data[p + 1] << 24) >> 16) | data[p + 2]);
        p += 3;
      } else if (b === 29) {
        operands.push((data[p + 1] << 24) | (data[p + 2] << 16) | (data[p + 3] << 8) | data[p + 4]);
        p += 5;
      } else if (b === 30) {            // real number, nibble encoded
        let s = '';
        p++;
        loop: while (p < data.length) {
          const byte = data[p++];
          for (const nib of [byte >> 4, byte & 15]) {
            if (nib <= 9) s += nib;
            else if (nib === 10) s += '.';
            else if (nib === 11) s += 'E';
            else if (nib === 12) s += 'E-';
            else if (nib === 14) s += '-';
            else if (nib === 15) break loop;
          }
        }
        operands.push(parseFloat(s) || 0);
      } else if (b >= 32 && b <= 246) {
        operands.push(b - 139); p++;
      } else if (b >= 247 && b <= 250) {
        operands.push((b - 247) * 256 + data[p + 1] + 108); p += 2;
      } else if (b >= 251 && b <= 254) {
        operands.push(-(b - 251) * 256 - data[p + 1] - 108); p += 2;
      } else {
        p++;
      }
    }
    return dict;
  }

  function subrBias(n) { return n < 1240 ? 107 : n < 33900 ? 1131 : 32768; }

  // CFF names glyphs by SID. Anything below 391 is one of these predefined
  // strings; anything above indexes the font's own string table. Without this
  // a glyph can only be found by its position in the charstring index, which
  // is the order the subsetter happened to write it in — so 'comma' lands on
  // whatever glyph sits at index 44, and text comes out subtly wrong.
  const STANDARD_STRINGS = ('.notdef space exclam quotedbl numbersign dollar percent ampersand ' +
    'quoteright parenleft parenright asterisk plus comma hyphen period slash zero one two three ' +
    'four five six seven eight nine colon semicolon less equal greater question at A B C D E F G ' +
    'H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum ' +
    'underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar ' +
    'braceright asciitilde exclamdown cent sterling fraction yen florin section currency ' +
    'quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl endash dagger ' +
    'daggerdbl periodcentered paragraph bullet quotesinglbase quotedblbase quotedblright ' +
    'guillemotright ellipsis perthousand questiondown grave acute circumflex tilde macron breve ' +
    'dotaccent dieresis ring cedilla hungarumlaut ogonek caron emdash AE ordfeminine Lslash ' +
    'Oslash OE ordmasculine ae dotlessi lslash oslash oe germandbls onesuperior logicalnot mu ' +
    'trademark Eth onehalf plusminus Thorn onequarter divide brokenbar degree thorn ' +
    'threequarters twosuperior registered minus eth multiply threesuperior copyright Aacute ' +
    'Acircumflex Adieresis Agrave Aring Atilde Ccedilla Eacute Ecircumflex Edieresis Egrave ' +
    'Iacute Icircumflex Idieresis Igrave Ntilde Oacute Ocircumflex Odieresis Ograve Otilde ' +
    'Scaron Uacute Ucircumflex Udieresis Ugrave Yacute Ydieresis Zcaron aacute acircumflex ' +
    'adieresis agrave aring atilde ccedilla eacute ecircumflex edieresis egrave iacute ' +
    'icircumflex idieresis igrave ntilde oacute ocircumflex odieresis ograve otilde scaron ' +
    'uacute ucircumflex udieresis ugrave yacute ydieresis zcaron').split(' ');

  // StandardEncoding codes 32..126 are exactly standard strings 1..95, which
  // saves carrying a second table for the range that matters most.
  function standardEncodingName(code) {
    if (code >= 32 && code <= 126) return STANDARD_STRINGS[code - 31];
    return null;
  }

  class CFFFont {
    constructor(data) {
      this.data = data;
      this.charStrings = [];
      this.globalSubrs = [];
      this.localSubrs = [];
      this.fontMatrix = [0.001, 0, 0, 0.001, 0, 0];
      this.isCID = false;
      this.fdSelect = null;
      this.fdPrivate = [];
      this.charsetGids = null;
      this.parse();
    }

    parse() {
      const data = this.data;
      const hdrSize = data[2];
      let p = hdrSize;
      const nameIndex = readIndex(data, p); p = nameIndex.end;
      const topIndex = readIndex(data, p); p = topIndex.end;
      const stringIndex = readIndex(data, p); p = stringIndex.end;
      const gsubrIndex = readIndex(data, p);
      this.globalSubrs = gsubrIndex.items;
      this.strings = stringIndex.items;

      const top = parseDict(topIndex.items[0] || new Uint8Array(0));
      this.top = top;

      if (top.has(1207)) {
        const m = top.get(1207);
        if (m.length >= 6) this.fontMatrix = m.slice(0, 6);
      }
      this.isCID = top.has(1230);

      const csOff = top.get(17);
      if (csOff && csOff[0] < data.length) {
        this.charStrings = readIndex(data, csOff[0]).items;
      }

      const priv = top.get(18);
      if (priv && priv.length >= 2) {
        this.readPrivate(priv[1], priv[0], (subrs, dict) => {
          this.localSubrs = subrs;
          this.defaultWidthX = dict.get(20) ? dict.get(20)[0] : 0;
          this.nominalWidthX = dict.get(21) ? dict.get(21)[0] : 0;
        });
      }

      if (this.isCID) this.parseCID();
      this.parseCharset();
    }

    readPrivate(offset, size, done) {
      if (!(offset >= 0) || offset >= this.data.length) { done([], new Map()); return; }
      const dict = parseDict(this.data.subarray(offset, Math.min(offset + size, this.data.length)));
      let subrs = [];
      const s = dict.get(19);
      if (s && offset + s[0] < this.data.length) {
        subrs = readIndex(this.data, offset + s[0]).items;
      }
      done(subrs, dict);
    }

    // A CID-keyed CFF splits its private data per glyph group, so each glyph
    // has to look up which one applies to it.
    parseCID() {
      const fdaOff = this.top.get(1236);
      if (fdaOff && fdaOff[0] < this.data.length) {
        const fda = readIndex(this.data, fdaOff[0]).items;
        for (const fd of fda) {
          const d = parseDict(fd);
          const priv = d.get(18);
          let entry = { subrs: [], defaultWidthX: 0, nominalWidthX: 0 };
          if (priv && priv.length >= 2) {
            this.readPrivate(priv[1], priv[0], (subrs, pd) => {
              entry = {
                subrs,
                defaultWidthX: pd.get(20) ? pd.get(20)[0] : 0,
                nominalWidthX: pd.get(21) ? pd.get(21)[0] : 0,
              };
            });
          }
          this.fdPrivate.push(entry);
        }
      }
      const fdsOff = this.top.get(1237);
      if (fdsOff && fdsOff[0] < this.data.length) {
        const rd = new Reader(this.data, fdsOff[0]);
        const format = rd.u8();
        const sel = new Uint8Array(this.charStrings.length);
        if (format === 0) {
          for (let i = 0; i < sel.length; i++) sel[i] = rd.u8();
        } else if (format === 3) {
          const ranges = rd.u16();
          let first = rd.u16();
          for (let i = 0; i < ranges; i++) {
            const fd = rd.u8();
            const next = rd.u16();
            for (let g = first; g < next && g < sel.length; g++) sel[g] = fd;
            first = next;
          }
        }
        this.fdSelect = sel;
      }
    }

    sidToName(sid) {
      if (sid < STANDARD_STRINGS.length) return STANDARD_STRINGS[sid];
      const custom = this.strings[sid - 391];
      if (!custom) return null;
      let s = '';
      for (let i = 0; i < custom.length; i++) s += String.fromCharCode(custom[i]);
      return s;
    }

    // For a non-CID font the charset maps glyph index to a name, which is the
    // only reliable way to answer "which glyph is 'comma'".
    parseNameCharset() {
      const n = this.charStrings.length;
      this.nameToGid = new Map();
      const off = this.top.get(15);

      // Charset 0 is ISOAdobe: glyph i is standard string i.
      if (!off || off[0] === 0) {
        for (let g = 0; g < n && g < STANDARD_STRINGS.length; g++) {
          this.nameToGid.set(STANDARD_STRINGS[g], g);
        }
        return;
      }
      if (off[0] === 1 || off[0] === 2) return;      // Expert sets, rarely used

      const rd = new Reader(this.data, off[0]);
      const format = rd.u8();
      this.nameToGid.set('.notdef', 0);
      let gid = 1;
      const add = (sid, g) => {
        const name = this.sidToName(sid);
        if (name && !this.nameToGid.has(name)) this.nameToGid.set(name, g);
      };
      if (format === 0) {
        while (gid < n && rd.p + 1 < this.data.length) add(rd.u16(), gid++);
      } else if (format === 1 || format === 2) {
        while (gid < n && rd.p + 2 < this.data.length) {
          const first = rd.u16();
          const left = format === 1 ? rd.u8() : rd.u16();
          for (let i = 0; i <= left && gid < n; i++) add(first + i, gid++);
        }
      }
    }

    // The font's own encoding, used when the PDF supplies none.
    parseEncoding() {
      this.codeToGid = null;
      const off = this.top.get(16);
      if (!off || off[0] === 0 || off[0] === 1) return;   // predefined
      if (off[0] >= this.data.length) return;

      const rd = new Reader(this.data, off[0]);
      const format = rd.u8();
      const map = new Map();
      if ((format & 0x7f) === 0) {
        const count = rd.u8();
        for (let i = 1; i <= count && rd.ok; i++) map.set(rd.u8(), i);
      } else if ((format & 0x7f) === 1) {
        const ranges = rd.u8();
        let gid = 1;
        for (let i = 0; i < ranges && rd.ok; i++) {
          const first = rd.u8(), left = rd.u8();
          for (let k = 0; k <= left; k++) map.set(first + k, gid++);
        }
      }
      if (format & 0x80) {                            // supplements
        const sups = rd.u8();
        for (let i = 0; i < sups && rd.ok; i++) {
          const code = rd.u8(), sid = rd.u16();
          const name = this.sidToName(sid);
          if (name && this.nameToGid && this.nameToGid.has(name)) {
            map.set(code, this.nameToGid.get(name));
          }
        }
      }
      this.codeToGid = map.size ? map : null;
    }

    gidForName(name) {
      if (!this.nameToGid || !name) return -1;
      const g = this.nameToGid.get(name);
      return g === undefined ? -1 : g;
    }

    // For a CID font the charset maps glyph index to CID, and we need the
    // reverse to find a glyph from a CID.
    parseCharset() {
      if (!this.isCID) { this.parseNameCharset(); this.parseEncoding(); return; }
      const off = this.top.get(15);
      const n = this.charStrings.length;
      const cidToGid = new Map();
      if (!off || off[0] <= 2) {        // predefined charsets are identity here
        for (let g = 0; g < n; g++) cidToGid.set(g, g);
        this.cidToGid = cidToGid;
        return;
      }
      const rd = new Reader(this.data, off[0]);
      const format = rd.u8();
      cidToGid.set(0, 0);
      let gid = 1;
      if (format === 0) {
        while (gid < n && rd.p + 1 < this.data.length) cidToGid.set(rd.u16(), gid++);
      } else if (format === 1 || format === 2) {
        while (gid < n && rd.p + 2 < this.data.length) {
          const first = rd.u16();
          const left = format === 1 ? rd.u8() : rd.u16();
          for (let i = 0; i <= left && gid < n; i++) cidToGid.set(first + i, gid++);
        }
      }
      this.cidToGid = cidToGid;
    }

    gidForCID(cid) {
      if (!this.isCID) return cid;
      if (this.cidToGid && this.cidToGid.has(cid)) return this.cidToGid.get(cid);
      return cid < this.charStrings.length ? cid : 0;
    }

    // Type 2 charstrings: a stack machine whose operators emit path segments.
    glyphPath(gid) {
      if (gid < 0 || gid >= this.charStrings.length) return '';
      const path = new PathBuilder();

      let localSubrs = this.localSubrs;
      let nominalWidthX = this.nominalWidthX || 0;
      if (this.fdSelect && this.fdPrivate.length) {
        const fd = this.fdPrivate[this.fdSelect[gid]] || this.fdPrivate[0];
        if (fd) { localSubrs = fd.subrs; nominalWidthX = fd.nominalWidthX; }
      }
      const gBias = subrBias(this.globalSubrs.length);
      const lBias = subrBias(localSubrs.length);

      let x = 0, y = 0, stems = 0, haveWidth = false, open = false;
      const stack = [];
      const trans = [];
      let depth = 0;

      const moveTo = (nx, ny) => { if (open) path.close(); path.moveTo(nx, ny); open = true; };

      const run = (code) => {
        if (++depth > 10) return;
        let p = 0;
        while (p < code.length) {
          const v = code[p++];
          if (v >= 32 || v === 28) {
            // operand
            if (v === 28) { stack.push(((code[p] << 24) >> 16) | code[p + 1]); p += 2; }
            else if (v < 247) stack.push(v - 139);
            else if (v < 251) { stack.push((v - 247) * 256 + code[p++] + 108); }
            else if (v < 255) { stack.push(-(v - 251) * 256 - code[p++] - 108); }
            else {
              stack.push(((code[p] << 24) | (code[p + 1] << 16) |
                          (code[p + 2] << 8) | code[p + 3]) / 65536);
              p += 4;
            }
            if (stack.length > 48) stack.shift();
            continue;
          }

          switch (v) {
            case 1: case 3: case 18: case 23:      // stems
              if (!haveWidth && stack.length % 2) haveWidth = true;
              stems += stack.length >> 1;
              stack.length = 0;
              break;
            case 19: case 20:                       // hintmask
              if (!haveWidth && stack.length % 2) haveWidth = true;
              stems += stack.length >> 1;
              stack.length = 0;
              p += (stems + 7) >> 3;
              break;
            case 21:                                // rmoveto
              if (stack.length > 2 && !haveWidth) stack.shift();
              haveWidth = true;
              x += stack[0] || 0; y += stack[1] || 0;
              moveTo(x, y);
              stack.length = 0;
              break;
            case 22:                                // hmoveto
              if (stack.length > 1 && !haveWidth) stack.shift();
              haveWidth = true;
              x += stack[0] || 0;
              moveTo(x, y);
              stack.length = 0;
              break;
            case 4:                                 // vmoveto
              if (stack.length > 1 && !haveWidth) stack.shift();
              haveWidth = true;
              y += stack[0] || 0;
              moveTo(x, y);
              stack.length = 0;
              break;
            case 5:                                 // rlineto
              for (let i = 0; i + 1 < stack.length; i += 2) {
                x += stack[i]; y += stack[i + 1];
                path.lineTo(x, y);
              }
              stack.length = 0;
              break;
            case 6: case 7: {                       // hlineto / vlineto
              let horiz = v === 6;
              for (let i = 0; i < stack.length; i++) {
                if (horiz) x += stack[i]; else y += stack[i];
                path.lineTo(x, y);
                horiz = !horiz;
              }
              stack.length = 0;
              break;
            }
            case 8:                                 // rrcurveto
              for (let i = 0; i + 5 < stack.length; i += 6) curve(stack, i);
              stack.length = 0;
              break;
            case 24:                                // rcurveline
              {
                let i = 0;
                for (; i + 5 < stack.length - 2; i += 6) curve(stack, i);
                x += stack[i] || 0; y += stack[i + 1] || 0;
                path.lineTo(x, y);
              }
              stack.length = 0;
              break;
            case 25:                                // rlinecurve
              {
                let i = 0;
                for (; i + 1 < stack.length - 6; i += 2) {
                  x += stack[i]; y += stack[i + 1];
                  path.lineTo(x, y);
                }
                curve(stack, i);
              }
              stack.length = 0;
              break;
            case 26: case 27: {                     // vvcurveto / hhcurveto
              let i = 0;
              let d = 0;
              if (stack.length % 4) d = stack[i++];
              for (; i + 3 < stack.length; i += 4) {
                let c1x, c1y, c2x, c2y;
                if (v === 26) {
                  c1x = x + d; c1y = y + stack[i];
                  c2x = c1x + stack[i + 1]; c2y = c1y + stack[i + 2];
                  x = c2x; y = c2y + stack[i + 3];
                } else {
                  c1x = x + stack[i]; c1y = y + d;
                  c2x = c1x + stack[i + 1]; c2y = c1y + stack[i + 2];
                  x = c2x + stack[i + 3]; y = c2y;
                }
                path.curveTo(c1x, c1y, c2x, c2y, x, y);
                d = 0;
              }
              stack.length = 0;
              break;
            }
            case 30: case 31: {                     // vhcurveto / hvcurveto
              let horiz = v === 31;
              let i = 0;
              while (i + 3 < stack.length) {
                const last = i + 8 > stack.length;
                let c1x, c1y, c2x, c2y;
                if (horiz) {
                  c1x = x + stack[i]; c1y = y;
                  c2x = c1x + stack[i + 1]; c2y = c1y + stack[i + 2];
                  y = c2y + stack[i + 3];
                  x = last && i + 4 < stack.length ? c2x + stack[i + 4] : c2x;
                } else {
                  c1x = x; c1y = y + stack[i];
                  c2x = c1x + stack[i + 1]; c2y = c1y + stack[i + 2];
                  x = c2x + stack[i + 3];
                  y = last && i + 4 < stack.length ? c2y + stack[i + 4] : c2y;
                }
                path.curveTo(c1x, c1y, c2x, c2y, x, y);
                horiz = !horiz;
                i += 4;
              }
              stack.length = 0;
              break;
            }
            case 10: {                              // callsubr
              const idx = (stack.pop() | 0) + lBias;
              const sub = localSubrs[idx];
              if (sub) run(sub);
              break;
            }
            case 29: {                              // callgsubr
              const idx = (stack.pop() | 0) + gBias;
              const sub = this.globalSubrs[idx];
              if (sub) run(sub);
              break;
            }
            case 11: depth--; return;               // return
            case 14:                                // endchar
              if (stack.length >= 4) this.seac(path, stack);
              if (open) { path.close(); open = false; }
              stack.length = 0;
              depth--;
              return;
            case 12: {
              const v2 = code[p++];
              switch (v2) {
                case 35:                            // flex
                  for (let i = 0; i + 5 < 12; i += 6) curve(stack, i);
                  stack.length = 0;
                  break;
                case 34: {                          // hflex
                  const y0 = y;
                  let c1x = x + stack[0], c1y = y;
                  let c2x = c1x + stack[1], c2y = y + stack[2];
                  x = c2x + stack[3]; y = c2y;
                  path.curveTo(c1x, c1y, c2x, c2y, x, y);
                  c1x = x + stack[4]; c1y = y;
                  c2x = c1x + stack[5]; c2y = y0;
                  x = c2x + stack[6]; y = y0;
                  path.curveTo(c1x, c1y, c2x, c2y, x, y);
                  stack.length = 0;
                  break;
                }
                case 36: {                          // hflex1
                  const y0 = y;
                  let c1x = x + stack[0], c1y = y + stack[1];
                  let c2x = c1x + stack[2], c2y = c1y + stack[3];
                  x = c2x + stack[4]; y = c2y;
                  path.curveTo(c1x, c1y, c2x, c2y, x, y);
                  c1x = x + stack[5]; c1y = y;
                  c2x = c1x + stack[6]; c2y = c1y + stack[7];
                  x = c2x + stack[8]; y = y0;
                  path.curveTo(c1x, c1y, c2x, c2y, x, y);
                  stack.length = 0;
                  break;
                }
                case 37: {                          // flex1
                  const sx = x, sy = y;
                  let dx = 0, dy = 0;
                  for (let i = 0; i < 10; i += 2) { dx += stack[i]; dy += stack[i + 1]; }
                  let c1x = x + stack[0], c1y = y + stack[1];
                  let c2x = c1x + stack[2], c2y = c1y + stack[3];
                  x = c2x + stack[4]; y = c2y + stack[5];
                  path.curveTo(c1x, c1y, c2x, c2y, x, y);
                  c1x = x + stack[6]; c1y = y + stack[7];
                  c2x = c1x + stack[8]; c2y = c1y + stack[9];
                  x = sx + dx; y = sy + dy;
                  path.curveTo(c1x, c1y, c2x, c2y, x, y);
                  stack.length = 0;
                  break;
                }
                default:
                  stack.length = 0;
              }
              break;
            }
            default:
              stack.length = 0;
          }
        }
        depth--;
      };

      const curve = (s, i) => {
        const c1x = x + s[i], c1y = y + s[i + 1];
        const c2x = c1x + s[i + 2], c2y = c1y + s[i + 3];
        x = c2x + s[i + 4]; y = c2y + s[i + 5];
        path.curveTo(c1x, c1y, c2x, c2y, x, y);
      };

      try { run(this.charStrings[gid]); } catch { /* damaged charstring */ }
      return path.toString();
    }

    // An accented character built from two other glyphs.
    seac(path, stack) {
      const achar = stack.pop(), bchar = stack.pop();
      const ady = stack.pop(), adx = stack.pop();
      const bGid = STANDARD_ENCODING_GID(this, bchar);
      const aGid = STANDARD_ENCODING_GID(this, achar);
      if (bGid >= 0) path.parts.push(this.glyphPath(bGid));
      if (aGid >= 0) path.parts.push(transformPath(this.glyphPath(aGid), [1, 0, 0, 1, adx, ady]));
    }
  }

  // seac refers to glyphs by StandardEncoding code. Without a full charset
  // name table the best available answer is the code itself.
  function STANDARD_ENCODING_GID(font, code) {
    return code >= 0 && code < font.charStrings.length ? code : -1;
  }

  // --- Type 1 ---------------------------------------------------------------

  // Type 1 fonts keep their outlines behind two layers of encryption and their
  // encoding inside the program rather than in the PDF. That encoding is the
  // reason this parser has to exist: a TeX document's math font puts comma at
  // code 59 and minus at code 0, so guessing ASCII produces text that is
  // subtly, confidently wrong.
  function eexecDecrypt(data, key, skip) {
    let r = key;
    const c1 = 52845, c2 = 22719;
    const out = new Uint8Array(Math.max(0, data.length - skip));
    let o = 0;
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      const plain = c ^ (r >> 8);
      r = ((c + r) * c1 + c2) & 0xffff;
      if (i >= skip) out[o++] = plain & 0xff;
    }
    return out.subarray(0, o);
  }

  function isHexByte(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  }

  class Type1Font {
    constructor(data) {
      this.charstrings = [];
      this.nameToGid = new Map();
      this.subrs = [];
      this.builtinEncoding = new Map();
      this.fontMatrix = [0.001, 0, 0, 0.001, 0, 0];
      this.lenIV = 4;
      try { this.parse(data); } catch { /* leave what was recovered */ }
    }

    parse(data) {
      // A PFB file wraps the parts in 6-byte segment headers.
      if (data[0] === 0x80) {
        const parts = [];
        let p = 0;
        while (p + 6 <= data.length && data[p] === 0x80 && data[p + 1] !== 3) {
          const len = data[p + 2] | (data[p + 3] << 8) | (data[p + 4] << 16) | (data[p + 5] << 24);
          parts.push(data.subarray(p + 6, p + 6 + len));
          p += 6 + len;
        }
        let total = 0;
        for (const s of parts) total += s.length;
        const joined = new Uint8Array(total);
        let at = 0;
        for (const s of parts) { joined.set(s, at); at += s.length; }
        data = joined;
      }

      const text = PDF.bytesToLatin1(data);
      const eexecAt = text.indexOf('eexec');
      const clear = eexecAt >= 0 ? text.slice(0, eexecAt) : text;

      this.parseFontMatrix(clear);
      this.parseEncoding(clear);
      if (eexecAt < 0) return;

      let p = eexecAt + 5;
      while (p < data.length && (data[p] === 13 || data[p] === 10 || data[p] === 32 || data[p] === 9)) p++;

      // The encrypted portion may be stored as hexadecimal.
      let encrypted = data.subarray(p);
      let hex = true;
      for (let i = 0; i < 4 && i < encrypted.length; i++) {
        if (!isHexByte(encrypted[i])) { hex = false; break; }
      }
      if (hex) {
        const bytes = new Uint8Array(encrypted.length >> 1);
        let o = 0, digit = -1;
        for (let i = 0; i < encrypted.length; i++) {
          const c = encrypted[i];
          let v = -1;
          if (c >= 48 && c <= 57) v = c - 48;
          else if (c >= 65 && c <= 70) v = c - 55;
          else if (c >= 97 && c <= 102) v = c - 87;
          else continue;
          if (digit < 0) digit = v;
          else { bytes[o++] = (digit << 4) | v; digit = -1; }
        }
        encrypted = bytes.subarray(0, o);
      }

      const priv = eexecDecrypt(encrypted, 55665, 4);
      this.parsePrivate(priv);
    }

    parseFontMatrix(clear) {
      const m = clear.match(/\/FontMatrix\s*\[([^\]]*)\]/);
      if (!m) return;
      const nums = m[1].trim().split(/\s+/).map(Number).filter((v) => isFinite(v));
      if (nums.length >= 6) this.fontMatrix = nums.slice(0, 6);
    }

    // `dup <code> /<name> put` entries, or a reference to StandardEncoding.
    parseEncoding(clear) {
      const at = clear.indexOf('/Encoding');
      if (at < 0) return;
      const section = clear.slice(at, at + 65536);
      if (/^\s*\/Encoding\s+StandardEncoding/.test(section)) {
        this.usesStandardEncoding = true;
        return;
      }
      const re = /dup\s+(\d+)\s*\/([^\s/]+)\s+put/g;
      let m;
      while ((m = re.exec(section))) {
        this.builtinEncoding.set(parseInt(m[1], 10), m[2]);
      }
    }

    parsePrivate(priv) {
      const text = PDF.bytesToLatin1(priv);

      const lenIVm = text.match(/\/lenIV\s+(\d+)/);
      if (lenIVm) this.lenIV = parseInt(lenIVm[1], 10);

      // Both Subrs and CharStrings store their bytes after a length and a
      // token whose name varies by font (RD, -|, ND, |-), so match loosely.
      const subrsAt = text.indexOf('/Subrs');
      if (subrsAt >= 0) {
        const re = /dup\s+(\d+)\s+(\d+)\s+(RD|-\|)[ ]/g;
        re.lastIndex = subrsAt;
        let m;
        while ((m = re.exec(text))) {
          const idx = parseInt(m[1], 10), len = parseInt(m[2], 10);
          const start = m.index + m[0].length;
          if (len < 0 || start + len > priv.length || idx > 65535) break;
          this.subrs[idx] = eexecDecrypt(priv.subarray(start, start + len), 4330, this.lenIV);
          re.lastIndex = start + len;
          if (text.startsWith('/CharStrings', re.lastIndex)) break;
        }
      }

      const csAt = text.indexOf('/CharStrings');
      if (csAt < 0) return;
      const re = /\/([^\s/{}()[\]<>]+)\s+(\d+)\s+(RD|-\|)[ ]/g;
      re.lastIndex = csAt;
      let m;
      while ((m = re.exec(text))) {
        const name = m[1], len = parseInt(m[2], 10);
        const start = m.index + m[0].length;
        if (len < 0 || start + len > priv.length) break;
        const code = eexecDecrypt(priv.subarray(start, start + len), 4330, this.lenIV);
        if (!this.nameToGid.has(name)) {
          this.nameToGid.set(name, this.charstrings.length);
          this.charstrings.push(code);
        }
        re.lastIndex = start + len;
      }
    }

    gidForName(name) {
      const g = this.nameToGid.get(name);
      return g === undefined ? -1 : g;
    }

    // Type 1 charstrings: the same idea as Type 2 but an older, smaller
    // instruction set, with hints and flex smuggled through `callothersubr`.
    glyphPath(gid) {
      if (gid < 0 || gid >= this.charstrings.length) return '';
      const path = new PathBuilder();
      let x = 0, y = 0, open = false;
      const stack = [];
      const psStack = [];
      let flexPts = null;
      let depth = 0;
      let sbx = 0;

      const moveTo = (nx, ny) => {
        if (flexPts) { flexPts.push(nx, ny); return; }
        if (open) path.close();
        path.moveTo(nx, ny);
        open = true;
      };

      const run = (code) => {
        if (!code || ++depth > 10) { depth--; return false; }
        let p = 0;
        while (p < code.length) {
          const v = code[p++];
          if (v >= 32) {
            if (v <= 246) stack.push(v - 139);
            else if (v <= 250) stack.push((v - 247) * 256 + code[p++] + 108);
            else if (v <= 254) stack.push(-(v - 251) * 256 - code[p++] - 108);
            else {
              stack.push((code[p] << 24) | (code[p + 1] << 16) | (code[p + 2] << 8) | code[p + 3]);
              p += 4;
            }
            continue;
          }
          switch (v) {
            case 13:                                  // hsbw: sidebearing, width
              sbx = stack[0] || 0;
              x = sbx; y = 0;
              stack.length = 0;
              break;
            case 9: if (open) { path.close(); open = false; } stack.length = 0; break;
            case 1: case 3: stack.length = 0; break;   // hints
            case 21: x += stack[0] || 0; y += stack[1] || 0; moveTo(x, y); stack.length = 0; break;
            case 22: x += stack[0] || 0; moveTo(x, y); stack.length = 0; break;
            case 4:  y += stack[0] || 0; moveTo(x, y); stack.length = 0; break;
            case 5: x += stack[0] || 0; y += stack[1] || 0; path.lineTo(x, y); stack.length = 0; break;
            case 6: x += stack[0] || 0; path.lineTo(x, y); stack.length = 0; break;
            case 7: y += stack[0] || 0; path.lineTo(x, y); stack.length = 0; break;
            case 8: {
              const c1x = x + (stack[0] || 0), c1y = y + (stack[1] || 0);
              const c2x = c1x + (stack[2] || 0), c2y = c1y + (stack[3] || 0);
              x = c2x + (stack[4] || 0); y = c2y + (stack[5] || 0);
              path.curveTo(c1x, c1y, c2x, c2y, x, y);
              stack.length = 0;
              break;
            }
            case 30: {                                 // vhcurveto
              const c1x = x, c1y = y + (stack[0] || 0);
              const c2x = c1x + (stack[1] || 0), c2y = c1y + (stack[2] || 0);
              x = c2x + (stack[3] || 0); y = c2y;
              path.curveTo(c1x, c1y, c2x, c2y, x, y);
              stack.length = 0;
              break;
            }
            case 31: {                                 // hvcurveto
              const c1x = x + (stack[0] || 0), c1y = y;
              const c2x = c1x + (stack[1] || 0), c2y = c1y + (stack[2] || 0);
              x = c2x; y = c2y + (stack[3] || 0);
              path.curveTo(c1x, c1y, c2x, c2y, x, y);
              stack.length = 0;
              break;
            }
            case 10: {
              const idx = stack.pop() | 0;
              if (run(this.subrs[idx]) === true) { depth--; return true; }
              break;
            }
            case 11: depth--; return false;
            case 14: if (open) { path.close(); open = false; } depth--; return true;
            case 12: {
              const v2 = code[p++];
              if (v2 === 12) {                         // div
                const b = stack.pop(), a = stack.pop();
                stack.push(b ? a / b : 0);
              } else if (v2 === 16) {                  // callothersubr
                const which = stack.pop() | 0;
                const count = stack.pop() | 0;
                const args = [];
                for (let i = 0; i < count; i++) args.unshift(stack.pop());
                if (which === 1) {
                  flexPts = [];
                } else if (which === 0) {
                  // Seven collected points: a reference point then two curves.
                  if (flexPts && flexPts.length >= 14) {
                    path.curveTo(flexPts[2], flexPts[3], flexPts[4], flexPts[5], flexPts[6], flexPts[7]);
                    path.curveTo(flexPts[8], flexPts[9], flexPts[10], flexPts[11], flexPts[12], flexPts[13]);
                    x = flexPts[12]; y = flexPts[13];
                  }
                  flexPts = null;
                  psStack.length = 0;
                  psStack.push(y, x);
                } else if (which === 3) {
                  psStack.length = 0;
                  psStack.push(3);
                } else {
                  psStack.length = 0;
                  for (let i = args.length - 1; i >= 0; i--) psStack.push(args[i]);
                }
              } else if (v2 === 17) {                  // pop
                stack.push(psStack.length ? psStack.pop() : 0);
              } else if (v2 === 6) {                   // seac
                const achar = stack[4] | 0, bchar = stack[3] | 0;
                const ady = stack[2] || 0, adx = stack[1] || 0;
                const bName = standardEncodingName(bchar), aName = standardEncodingName(achar);
                const bGid = bName ? this.gidForName(bName) : -1;
                const aGid = aName ? this.gidForName(aName) : -1;
                if (bGid >= 0) path.parts.push(this.glyphPath(bGid));
                if (aGid >= 0) {
                  path.parts.push(transformPath(this.glyphPath(aGid), [1, 0, 0, 1, sbx - 0 + adx, ady]));
                }
                stack.length = 0;
                depth--;
                return true;
              } else if (v2 === 7) {                   // sbw
                sbx = stack[0] || 0;
                x = sbx; y = stack[1] || 0;
                stack.length = 0;
              } else if (v2 === 33) {                  // setcurrentpoint
                x = stack[0] || 0; y = stack[1] || 0;
                stack.length = 0;
              } else {
                stack.length = 0;
              }
              break;
            }
            default:
              stack.length = 0;
          }
        }
        depth--;
        return false;
      };

      try { run(this.charstrings[gid]); } catch { /* damaged charstring */ }
      return path.toString();
    }
  }

  PDF.TrueTypeFont = TrueTypeFont;
  PDF.CFFFont = CFFFont;
  PDF.Type1Font = Type1Font;
  PDF.STANDARD_STRINGS = STANDARD_STRINGS;
  PDF.standardEncodingName = standardEncodingName;
  PDF.PathBuilder = PathBuilder;
  PDF.transformPath = transformPath;

})(globalThis.PDF || (globalThis.PDF = {}));
