// The PDF side of a font: which glyph a byte selects, and how wide it is.
//
// The outline parsers in pdf-font.js answer "what does glyph 47 look like".
// This file answers the harder question of which glyph a given byte in a
// content stream actually means, which depends on the font's subtype, its
// encoding, whether it is a subset, whether it declared itself symbolic, and
// which character maps the embedded font program happens to carry.
//
// Widths never come from the font program. The PDF's own /Widths array is
// authoritative, because the file was laid out against those numbers, and
// using anything else makes text drift away from where it was written.

;(function (PDF) {
  'use strict';

  const { Name, Dict, PDFStream, TrueTypeFont, CFFFont } = PDF;

  // Codes 32..126 are the same in every Latin encoding, so only the parts that
  // differ are spelled out. Everything else falls back to the character itself.
  const STD_LOW = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';

  // WinAnsi is Windows code page 1252: Latin-1 with printable characters in
  // the 0x80..0x9f range that Latin-1 leaves as controls.
  const WINANSI_HIGH = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
    0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
    0x9e: 0x017e, 0x9f: 0x0178,
  };

  // Glyph names that appear constantly in /Differences arrays. A full Adobe
  // glyph list would be several thousand entries; these plus the uniXXXX and
  // single-letter forms cover what real documents use.
  const GLYPH_NAMES = {
    space: 32, exclam: 33, quotedbl: 34, numbersign: 35, dollar: 36, percent: 37,
    ampersand: 38, quotesingle: 39, quoteright: 0x2019, quoteleft: 0x2018,
    parenleft: 40, parenright: 41, asterisk: 42, plus: 43, comma: 44, hyphen: 45,
    period: 46, slash: 47, zero: 48, one: 49, two: 50, three: 51, four: 52,
    five: 53, six: 54, seven: 55, eight: 56, nine: 57, colon: 58, semicolon: 59,
    less: 60, equal: 61, greater: 62, question: 63, at: 64, bracketleft: 91,
    backslash: 92, bracketright: 93, asciicircum: 94, underscore: 95, grave: 96,
    braceleft: 123, bar: 124, braceright: 125, asciitilde: 126,
    quotedblleft: 0x201c, quotedblright: 0x201d, quotedblbase: 0x201e,
    quotesinglbase: 0x201a, endash: 0x2013, emdash: 0x2014, bullet: 0x2022,
    dagger: 0x2020, daggerdbl: 0x2021, ellipsis: 0x2026, perthousand: 0x2030,
    guilsinglleft: 0x2039, guilsinglright: 0x203a, guillemotleft: 0xab,
    guillemotright: 0xbb, fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03,
    ffl: 0xfb04, florin: 0x192, trademark: 0x2122, Euro: 0x20ac,
    exclamdown: 0xa1, cent: 0xa2, sterling: 0xa3, currency: 0xa4, yen: 0xa5,
    brokenbar: 0xa6, section: 0xa7, dieresis: 0xa8, copyright: 0xa9,
    ordfeminine: 0xaa, logicalnot: 0xac, registered: 0xae, macron: 0xaf,
    degree: 0xb0, plusminus: 0xb1, acute: 0xb4, mu: 0xb5, paragraph: 0xb6,
    periodcentered: 0xb7, cedilla: 0xb8, ordmasculine: 0xba, onequarter: 0xbc,
    onehalf: 0xbd, threequarters: 0xbe, questiondown: 0xbf, germandbls: 0xdf,
    ae: 0xe6, oe: 0x153, AE: 0xc6, OE: 0x152, oslash: 0xf8, Oslash: 0xd8,
    eth: 0xf0, thorn: 0xfe, Eth: 0xd0, Thorn: 0xde, divide: 0xf7, multiply: 0xd7,
    circumflex: 0x2c6, tilde: 0x2dc, breve: 0x2d8, dotaccent: 0x2d9,
    ring: 0x2da, ogonek: 0x2db, hungarumlaut: 0x2dd, caron: 0x2c7,
  };

  const ACCENTS = {
    acute: 0x301, grave: 0x300, dieresis: 0x308, circumflex: 0x302,
    tilde: 0x303, caron: 0x30c, ring: 0x30a, cedilla: 0x327, macron: 0x304,
    breve: 0x306, ogonek: 0x328, hungarumlaut: 0x30b, dotaccent: 0x307,
  };

  // Composed forms for the "letter + accent name" pattern (aacute, Odieresis).
  const COMPOSED = {
    'a301': 0xe1, 'e301': 0xe9, 'i301': 0xed, 'o301': 0xf3, 'u301': 0xfa, 'y301': 0xfd,
    'A301': 0xc1, 'E301': 0xc9, 'I301': 0xcd, 'O301': 0xd3, 'U301': 0xda, 'Y301': 0xdd,
    'a300': 0xe0, 'e300': 0xe8, 'i300': 0xec, 'o300': 0xf2, 'u300': 0xf9,
    'A300': 0xc0, 'E300': 0xc8, 'I300': 0xcc, 'O300': 0xd2, 'U300': 0xd9,
    'a308': 0xe4, 'e308': 0xeb, 'i308': 0xef, 'o308': 0xf6, 'u308': 0xfc, 'y308': 0xff,
    'A308': 0xc4, 'E308': 0xcb, 'I308': 0xcf, 'O308': 0xd6, 'U308': 0xdc,
    'a302': 0xe2, 'e302': 0xea, 'i302': 0xee, 'o302': 0xf4, 'u302': 0xfb,
    'A302': 0xc2, 'E302': 0xca, 'I302': 0xce, 'O302': 0xd4, 'U302': 0xdb,
    'a303': 0xe3, 'n303': 0xf1, 'o303': 0xf5, 'A303': 0xc3, 'N303': 0xd1, 'O303': 0xd5,
    'a30a': 0xe5, 'A30a': 0xc5, 'c327': 0xe7, 'C327': 0xc7,
    's30c': 0x161, 'S30c': 0x160, 'z30c': 0x17e, 'Z30c': 0x17d, 'c30c': 0x10d, 'C30c': 0x10c,
  };

  // Turns a PostScript glyph name into a Unicode code point.
  function glyphNameToUnicode(name) {
    if (!name) return -1;
    if (Object.prototype.hasOwnProperty.call(GLYPH_NAMES, name)) return GLYPH_NAMES[name];
    if (name.length === 1) return name.charCodeAt(0);

    let m = name.match(/^uni([0-9A-Fa-f]{4})/);
    if (m) return parseInt(m[1], 16);
    m = name.match(/^u([0-9A-Fa-f]{4,6})$/);
    if (m) return parseInt(m[1], 16);
    // Subset fonts frequently name glyphs gNN, cidNN, GNN or index-style.
    m = name.match(/^(?:g|G|cid|c|glyph|index)(\d+)$/);
    if (m) return -1 - parseInt(m[1], 10);   // negative marks "this is a glyph id"

    for (const [accent, combining] of Object.entries(ACCENTS)) {
      if (name.length > accent.length && name.endsWith(accent)) {
        const base = name.slice(0, name.length - accent.length);
        if (base.length === 1) {
          const key = base + combining.toString(16);
          if (COMPOSED[key] !== undefined) return COMPOSED[key];
          return base.charCodeAt(0);
        }
      }
    }
    const dot = name.indexOf('.');            // 'a.sc', 'one.oldstyle'
    if (dot > 0) return glyphNameToUnicode(name.slice(0, dot));
    return -1;
  }

  function baseEncodingUnicode(code, encodingName) {
    if (code >= 32 && code <= 126) return STD_LOW.charCodeAt(code - 32);
    if (encodingName === 'WinAnsiEncoding') {
      if (WINANSI_HIGH[code] !== undefined) return WINANSI_HIGH[code];
      if (code >= 0xa0) return code;
      return -1;
    }
    if (code >= 0xa0) return code;            // Latin-1 for the rest
    return -1;
  }

  class PDFFont {
    constructor(doc, dict) {
      this.doc = doc;
      this.dict = dict;
      this.glyphCache = new Map();
      this.program = null;                    // TrueTypeFont or CFFFont
      this.kind = 'none';
      this.fontMatrix = [0.001, 0, 0, 0.001, 0, 0];
      this.type3 = null;
      this.defaultWidth = 500;
      this.widths = null;
      this.cidWidths = null;
      this.twoByte = false;
      this.symbolic = false;
      this.substitute = null;

      try { this.build(); } catch { /* leave the font usable but empty */ }
    }

    build() {
      const doc = this.doc, dict = this.dict;
      const subtype = doc.get(dict, 'Subtype');
      this.subtype = subtype instanceof Name ? subtype.name : '';

      if (this.subtype === 'Type0') { this.buildType0(); return; }
      if (this.subtype === 'Type3') { this.buildType3(); return; }
      this.buildSimple();
    }

    // --- descriptors and embedded programs ---------------------------------

    loadProgram(descriptor) {
      const doc = this.doc;
      if (!(descriptor instanceof Dict)) return;

      const flags = doc.get(descriptor, 'Flags');
      this.symbolic = typeof flags === 'number' && (flags & 4) !== 0 && (flags & 32) === 0;
      const mw = doc.get(descriptor, 'MissingWidth');
      if (typeof mw === 'number') this.defaultWidth = mw;

      const tryLoad = (key) => {
        const s = doc.resolve(descriptor.get(key));
        if (!(s instanceof PDFStream)) return null;
        const ref = descriptor.get(key);
        try { return doc.decodeStreamBytes(s, ref && ref.num); } catch { return null; }
      };

      let bytes = tryLoad('FontFile2');
      if (bytes && bytes.length > 12) {
        try {
          this.program = new TrueTypeFont(bytes);
          this.kind = 'truetype';
          this.unitsPerEm = this.program.unitsPerEm || 1000;
          this.fontMatrix = [1 / this.unitsPerEm, 0, 0, 1 / this.unitsPerEm, 0, 0];
          if (this.program.cff) { this.cff = this.program.cff; }
          return;
        } catch { this.program = null; }
      }

      bytes = tryLoad('FontFile3');
      if (bytes && bytes.length > 4) {
        try {
          // Subtype OpenType means a whole OTF; otherwise it is bare CFF.
          if (bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) {
            const otf = new TrueTypeFont(bytes);
            this.program = otf.cff || otf;
            this.kind = otf.cff ? 'cff' : 'truetype';
            this.unitsPerEm = otf.unitsPerEm || 1000;
          } else {
            this.program = new CFFFont(bytes);
            this.kind = 'cff';
          }
          if (this.kind === 'cff') {
            this.fontMatrix = this.program.fontMatrix || [0.001, 0, 0, 0.001, 0, 0];
          } else {
            this.fontMatrix = [1 / this.unitsPerEm, 0, 0, 1 / this.unitsPerEm, 0, 0];
          }
          return;
        } catch { this.program = null; }
      }

      bytes = tryLoad('FontFile');
      if (bytes && bytes.length > 8) {
        try {
          const t1 = new PDF.Type1Font(bytes);
          if (t1.charstrings.length) {
            this.program = t1;
            this.kind = 'type1';
            this.fontMatrix = t1.fontMatrix || [0.001, 0, 0, 0.001, 0, 0];
            return;
          }
        } catch { this.program = null; }
      }
    }

    // Picks a system face that resembles the missing one, so a document with
    // no embedded fonts still reads correctly rather than not at all.
    pickSubstitute(baseFont, descriptor) {
      const name = (baseFont || '').toLowerCase();
      const flags = descriptor ? this.doc.get(descriptor, 'Flags') : 0;
      const serifFlag = typeof flags === 'number' && (flags & 2) !== 0;
      const fixed = typeof flags === 'number' && (flags & 1) !== 0;

      const bold = /bold|black|heavy|semibold/.test(name) ||
        (descriptor && this.doc.get(descriptor, 'StemV') > 120);
      const italic = /italic|oblique/.test(name) ||
        (typeof flags === 'number' && (flags & 64) !== 0 && /italic|oblique/.test(name));

      let family = 'sans-serif';
      if (fixed || /courier|mono/.test(name)) family = 'monospace';
      else if (/times|serif|roman|georgia|book|garamond|minion/.test(name) || serifFlag) family = 'serif';
      if (/symbol/.test(name)) family = 'serif';

      this.substitute = {
        family,
        weight: bold ? '700' : '400',
        style: italic ? 'italic' : 'normal',
      };
    }

    // --- simple fonts (one byte per glyph) ---------------------------------

    buildSimple() {
      const doc = this.doc, dict = this.dict;
      const descriptor = doc.get(dict, 'FontDescriptor');
      const baseFont = doc.get(dict, 'BaseFont');
      this.baseFont = baseFont instanceof Name ? baseFont.name : '';

      this.loadProgram(descriptor);
      if (!this.program) this.pickSubstitute(this.baseFont, descriptor);

      // Encoding: a base encoding name, plus a /Differences array that renames
      // individual codes.
      this.encodingName = this.symbolic ? '' : 'StandardEncoding';
      this.differences = null;
      const enc = doc.get(dict, 'Encoding');
      if (enc instanceof Name) {
        this.encodingName = enc.name;
      } else if (enc instanceof Dict) {
        const base = doc.get(enc, 'BaseEncoding');
        if (base instanceof Name) this.encodingName = base.name;
        const diff = doc.get(enc, 'Differences');
        if (Array.isArray(diff)) {
          const map = new Map();
          let code = 0;
          for (const item of diff) {
            const v = doc.resolve(item);
            if (typeof v === 'number') code = v | 0;
            else if (v instanceof Name) map.set(code++, v.name);
          }
          this.differences = map;
        }
      }

      const first = doc.get(dict, 'FirstChar');
      const widths = doc.get(dict, 'Widths');
      if (Array.isArray(widths) && typeof first === 'number') {
        this.firstChar = first;
        this.widths = widths.map((w) => {
          const v = doc.resolve(w);
          return typeof v === 'number' ? v : 0;
        });
      }
      if (!this.widths) this.applyStandardWidths();
    }

    // The 14 standard fonts carry no /Widths, so the numbers have to come from
    // somewhere. Rather than embed four metric tables, measure the substitute
    // face once and reuse it; positioning stays consistent even if it is not
    // metrically identical to Adobe's originals.
    applyStandardWidths() {
      this.needsMeasuredWidths = true;
      const name = (this.baseFont || '').toLowerCase();
      this.defaultWidth = /courier|mono/.test(name) ? 600 : 500;
    }

    // --- composite (CID) fonts ---------------------------------------------

    buildType0() {
      const doc = this.doc, dict = this.dict;
      const baseFont = doc.get(dict, 'BaseFont');
      this.baseFont = baseFont instanceof Name ? baseFont.name : '';
      this.twoByte = true;

      const enc = doc.get(dict, 'Encoding');
      this.cmapName = enc instanceof Name ? enc.name : 'Identity-H';
      this.vertical = /-V$/.test(this.cmapName);
      if (enc instanceof PDFStream) {
        this.embeddedCMap = parseCMapRanges(doc, enc, dict.get('Encoding'));
      }

      const descFonts = doc.get(dict, 'DescendantFonts');
      const desc = Array.isArray(descFonts) ? doc.resolve(descFonts[0]) : null;
      if (!(desc instanceof Dict)) return;
      this.descendant = desc;

      const descriptor = doc.get(desc, 'FontDescriptor');
      this.loadProgram(descriptor);
      if (!this.program) this.pickSubstitute(this.baseFont, descriptor);

      const dw = doc.get(desc, 'DW');
      this.defaultWidth = typeof dw === 'number' ? dw : 1000;
      this.cidWidths = parseWArray(doc, doc.get(desc, 'W'));

      // CIDToGIDMap is either /Identity or a stream of two-byte glyph indices.
      const c2g = doc.get(desc, 'CIDToGIDMap');
      if (c2g instanceof PDFStream) {
        const ref = desc.get('CIDToGIDMap');
        try {
          const bytes = doc.decodeStreamBytes(c2g, ref && ref.num);
          this.cidToGid = bytes;
        } catch { this.cidToGid = null; }
      }
    }

    // --- Type 3 (glyphs are content streams) -------------------------------

    buildType3() {
      const doc = this.doc, dict = this.dict;
      this.kind = 'type3';
      const fm = doc.get(dict, 'FontMatrix');
      if (Array.isArray(fm) && fm.length >= 6) {
        this.fontMatrix = fm.map((v) => (typeof doc.resolve(v) === 'number' ? doc.resolve(v) : 0));
      }
      this.charProcs = doc.get(dict, 'CharProcs');
      this.type3Resources = doc.get(dict, 'Resources');

      const enc = doc.get(dict, 'Encoding');
      this.differences = new Map();
      if (enc instanceof Dict) {
        const diff = doc.get(enc, 'Differences');
        if (Array.isArray(diff)) {
          let code = 0;
          for (const item of diff) {
            const v = doc.resolve(item);
            if (typeof v === 'number') code = v | 0;
            else if (v instanceof Name) this.differences.set(code++, v.name);
          }
        }
      }
      const first = doc.get(dict, 'FirstChar');
      const widths = doc.get(dict, 'Widths');
      if (Array.isArray(widths) && typeof first === 'number') {
        this.firstChar = first;
        this.widths = widths.map((w) => {
          const v = doc.resolve(w);
          return typeof v === 'number' ? v : 0;
        });
      }
      this.defaultWidth = 0;
    }

    // --- decoding a string into positioned glyphs --------------------------

    // Splits a PDF string into character codes. Simple fonts are one byte per
    // code; Type0 fonts are two, unless an embedded CMap says otherwise.
    decode(str) {
      const out = [];
      if (this.twoByte) {
        for (let i = 0; i + 1 < str.length; i += 2) {
          out.push(((str.charCodeAt(i) & 0xff) << 8) | (str.charCodeAt(i + 1) & 0xff));
        }
        if (str.length % 2) out.push((str.charCodeAt(str.length - 1) & 0xff) << 8);
      } else {
        for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
      }
      return out;
    }

    codeToCID(code) {
      if (this.embeddedCMap) {
        const cid = this.embeddedCMap.get(code);
        if (cid !== undefined) return cid;
      }
      return code;                            // Identity-H and friends
    }

    // Width in glyph-space thousandths, the unit /Widths is written in.
    widthOf(code) {
      if (this.twoByte) {
        const cid = this.codeToCID(code);
        if (this.cidWidths) {
          const w = this.cidWidths.get(cid);
          if (w !== undefined) return w;
        }
        return this.defaultWidth;
      }
      if (this.widths && this.firstChar !== undefined) {
        const i = code - this.firstChar;
        if (i >= 0 && i < this.widths.length) {
          const w = this.widths[i];
          // A zero width is real for combining marks but usually means "not in
          // this subset", so only trust it when the glyph exists.
          if (w || this.widths.length) return w;
        }
      }
      return this.defaultWidth;
    }

    // The name a code stands for: the PDF's /Differences first, then the
    // font program's own encoding, then the base encoding. The middle step is
    // what makes a TeX math font come out right, since its layout is declared
    // nowhere but inside the font.
    glyphNameFor(code) {
      if (this.differences && this.differences.has(code)) return this.differences.get(code);
      const prog = this.program;
      if (prog && prog.builtinEncoding && prog.builtinEncoding.has(code)) {
        return prog.builtinEncoding.get(code);
      }
      if (!this.symbolic || this.encodingName) return PDF.standardEncodingName(code);
      return null;
    }

    // The whole point of this file: code in, glyph id out.
    gidFor(code) {
      if (this.glyphCache.has(code)) return this.glyphCache.get(code);
      const gid = this.computeGid(code);
      this.glyphCache.set(code, gid);
      return gid;
    }

    computeGid(code) {
      const prog = this.program;
      if (!prog) return -1;

      if (this.twoByte) {
        const cid = this.codeToCID(code);
        if (this.cidToGid && cid * 2 + 1 < this.cidToGid.length) {
          return (this.cidToGid[cid * 2] << 8) | this.cidToGid[cid * 2 + 1];
        }
        if (prog instanceof CFFFont) return prog.gidForCID(cid);
        return cid;
      }

      const name = this.glyphNameFor(code);

      if (this.kind === 'type1') {
        if (name) {
          const g = prog.gidForName(name);
          if (g >= 0) return g;
          // A name the font does not have may still be reachable as its
          // Unicode equivalent under a different spelling.
          const u = glyphNameToUnicode(name);
          if (u < -1) return -1 - u;
        }
        const std = PDF.standardEncodingName(code);
        if (std) {
          const g = prog.gidForName(std);
          if (g >= 0) return g;
        }
        return -1;
      }

      if (prog instanceof CFFFont) {
        // A named glyph that looks like gNN or cidNN is a direct index.
        if (name) {
          const u = glyphNameToUnicode(name);
          if (u < -1) return -1 - u;
          const byName = prog.gidForName(name);
          if (byName >= 0) return byName;
        }
        // No /Differences entry: the code means whatever the base encoding
        // says it means, and the charset says where that glyph lives.
        if (!this.symbolic || this.encodingName) {
          const stdName = PDF.standardEncodingName(code);
          if (stdName) {
            const byStd = prog.gidForName(stdName);
            if (byStd >= 0) return byStd;
          }
        }
        // Failing that, the font's own built-in encoding.
        if (prog.codeToGid && prog.codeToGid.has(code)) return prog.codeToGid.get(code);
        return code < prog.charStrings.length ? code : 0;
      }

      // TrueType. A symbolic font addresses its own glyphs through the (3,0)
      // subtable, where codes are conventionally offset into 0xF000.
      if (this.symbolic || !this.encodingName) {
        if (prog.symbolCmap) {
          const g = prog.symbolCmap.get(0xf000 | code) || prog.symbolCmap.get(code);
          if (g) return g;
        }
        if (prog.macCmap) {
          const g = prog.macCmap.get(code);
          if (g) return g;
        }
      }

      let unicode = -1;
      if (name) {
        const u = glyphNameToUnicode(name);
        if (u < -1) return -1 - u;             // gNN style
        unicode = u;
      }
      if (unicode < 0) unicode = baseEncodingUnicode(code, this.encodingName);

      if (unicode >= 0 && prog.cmap) {
        const g = prog.cmap.get(unicode);
        if (g) return g;
      }
      if (prog.symbolCmap) {
        const g = prog.symbolCmap.get(0xf000 | code) || prog.symbolCmap.get(code);
        if (g) return g;
      }
      if (prog.macCmap) {
        const g = prog.macCmap.get(code);
        if (g) return g;
      }
      // No character map at all: subset fonts often use the code directly.
      if (!prog.cmap && !prog.symbolCmap && !prog.macCmap) return code;
      return 0;
    }

    // The glyph outline as an SVG path string, in glyph space.
    pathFor(code) {
      const key = 'p' + code;
      if (this.glyphCache.has(key)) return this.glyphCache.get(key);
      let d = '';
      const gid = this.gidFor(code);
      if (gid >= 0 && this.program) {
        try { d = this.program.glyphPath(gid, 0) || ''; } catch { d = ''; }
      }
      this.glyphCache.set(key, d);
      return d;
    }

    // What this code means as text, for copy-out and for the substitute face.
    unicodeFor(code) {
      if (this.toUnicode) {
        const u = this.toUnicode.get(code);
        if (u !== undefined) return u;
      }
      const name = this.glyphNameFor(code);
      if (name) {
        const u = glyphNameToUnicode(name);
        if (u >= 0) return String.fromCharCode(u);
      }
      if (this.twoByte) return '';
      const u = baseEncodingUnicode(code, this.encodingName);
      return u >= 0 ? String.fromCharCode(u) : '';
    }
  }

  // /W is [ cid [w w w] cidFirst cidLast w ... ]
  function parseWArray(doc, w) {
    if (!Array.isArray(w)) return null;
    const map = new Map();
    let i = 0;
    while (i < w.length) {
      const a = doc.resolve(w[i++]);
      if (typeof a !== 'number') break;
      const b = doc.resolve(w[i++]);
      if (Array.isArray(b)) {
        b.forEach((v, k) => {
          const n = doc.resolve(v);
          if (typeof n === 'number') map.set(a + k, n);
        });
      } else if (typeof b === 'number') {
        const width = doc.resolve(w[i++]);
        if (typeof width !== 'number') break;
        const count = Math.min(b - a, 65535);
        for (let c = 0; c <= count; c++) map.set(a + c, width);
      } else break;
    }
    return map;
  }

  // Reads cidrange/cidchar sections out of an embedded CMap stream.
  function parseCMapRanges(doc, stream, ref) {
    const map = new Map();
    let bytes;
    try { bytes = doc.decodeStreamBytes(stream, ref && ref.num); } catch { return map; }
    const parser = new PDF.Parser(bytes, 0, null);
    const stack = [];
    for (let guard = 0; guard < 400000; guard++) {
      const v = parser.parseObject();
      if (v === PDF.EOF) break;
      if (v && v.type === 'kw') {
        if (v.val === 'endcidrange') {
          for (let i = 0; i + 2 < stack.length; i += 3) {
            const lo = strToInt(stack[i]), hi = strToInt(stack[i + 1]), cid = stack[i + 2];
            if (lo < 0 || hi < 0 || typeof cid !== 'number') continue;
            for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, cid + (c - lo));
          }
          stack.length = 0;
        } else if (v.val === 'endcidchar') {
          for (let i = 0; i + 1 < stack.length; i += 2) {
            const c = strToInt(stack[i]);
            if (c >= 0 && typeof stack[i + 1] === 'number') map.set(c, stack[i + 1]);
          }
          stack.length = 0;
        } else if (v.val.startsWith('begin')) {
          stack.length = 0;
        }
        continue;
      }
      stack.push(v);
      if (stack.length > 3000) stack.splice(0, 1500);
    }
    return map;
  }

  function strToInt(s) {
    if (typeof s !== 'string') return -1;
    let v = 0;
    for (let i = 0; i < s.length; i++) v = (v << 8) | (s.charCodeAt(i) & 0xff);
    return v;
  }

  PDF.PDFFont = PDFFont;
  PDF.glyphNameToUnicode = glyphNameToUnicode;

})(globalThis.PDF || (globalThis.PDF = {}));
