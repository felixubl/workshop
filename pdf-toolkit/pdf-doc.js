// The document layer: a file of objects becomes a document with pages.
//
// Finding an object in a PDF means walking backwards. The last line points at
// a cross-reference section, that section points at objects and at the section
// before it, and so on to the start of the file. There are two incompatible
// formats for those sections (a text table, and a compressed stream), files
// that use both at once, and files whose offsets are simply wrong — which is
// why every path here ends in the same fallback: read the whole file and look
// for object headers directly.

;(function (PDF) {
  'use strict';

  const { Name, Ref, Dict, PDFStream, IndirectObject, Parser, EOF } = PDF;

  const FREE = 0, NORMAL = 1, COMPRESSED = 2;

  class PDFDocument {
    constructor(bytes) {
      this.bytes = bytes;
      this.xref = new Map();          // object number -> entry
      this.trailer = new Dict();
      this.cache = new Map();         // object number -> parsed value
      this.objStmCache = new Map();
      this.loading = new Set();       // cycle guard for indirect /Length
      this.recovered = false;
      this.warnings = [];
      this.encrypted = false;
      this.decryptor = null;          // set by the crypt layer when present
      this._pages = null;
    }

    static load(bytes) {
      const doc = new PDFDocument(bytes);
      doc.parse();
      return doc;
    }

    warn(msg) {
      if (this.warnings.length < 50 && !this.warnings.includes(msg)) this.warnings.push(msg);
    }

    // --- cross-reference parsing --------------------------------------------

    parse() {
      let ok = false;
      try {
        const start = this.findStartXref();
        if (start >= 0) ok = this.readXRefChain(start);
      } catch (e) {
        this.warn('cross-reference table unreadable: ' + e.message);
      }

      // A file whose xref is fine but whose /Root is not is just as broken.
      if (ok && !(this.resolve(this.trailer.get('Root')) instanceof Dict)) ok = false;

      if (!ok) {
        this.warn('rebuilt the cross-reference table by scanning the file');
        this.recover();
      }

      const enc = this.trailer.get('Encrypt');
      if (enc !== undefined && enc !== null) {
        this.encrypted = true;
        if (PDF.setupDecryption) PDF.setupDecryption(this);
      }
    }

    findStartXref() {
      const bytes = this.bytes;
      const tail = Math.max(0, bytes.length - 2048);
      const needle = 'startxref';
      for (let p = bytes.length - needle.length; p >= tail; p--) {
        let hit = true;
        for (let i = 0; i < needle.length; i++) {
          if (bytes[p + i] !== needle.charCodeAt(i)) { hit = false; break; }
        }
        if (!hit) continue;
        const parser = new Parser(bytes, p + needle.length, null);
        const v = parser.parseObject();
        if (typeof v === 'number' && v >= 0 && v < bytes.length) return v;
        return -1;
      }
      return -1;
    }

    // Follows /Prev back through the file. Earlier sections must not overwrite
    // later ones, so entries are only taken the first time an object number is
    // seen; the newest section is read first.
    readXRefChain(start) {
      const seen = new Set();
      let offset = start;
      let any = false;

      while (offset >= 0 && offset < this.bytes.length && !seen.has(offset)) {
        seen.add(offset);
        let trailer = null;
        try {
          trailer = this.readXRefSection(offset);
        } catch (e) {
          this.warn('cross-reference section at ' + offset + ' unreadable');
          break;
        }
        if (!trailer) break;
        any = true;

        for (const [k, v] of trailer.entries()) {
          if (!this.trailer.has(k)) this.trailer.set(k, v);
        }

        // Hybrid files keep a second, stream-shaped section for readers that
        // understand it. Its entries are newer than /Prev's but older than the
        // table we just read.
        const hybrid = trailer.get('XRefStm');
        if (typeof hybrid === 'number' && !seen.has(hybrid)) {
          seen.add(hybrid);
          try { this.readXRefSection(hybrid); } catch { this.warn('hybrid section unreadable'); }
        }

        const prev = trailer.get('Prev');
        offset = typeof prev === 'number' ? prev : -1;
      }
      return any && this.xref.size > 0;
    }

    readXRefSection(offset) {
      const parser = new Parser(this.bytes, offset, null);
      const tok = parser.peek(0);

      if (tok.type === 'kw' && tok.val === 'xref') {
        parser.next();
        return this.readXRefTable(parser);
      }
      // Otherwise it should be `N G obj << /Type /XRef ... >> stream`.
      const obj = parser.parseObject();
      const value = obj instanceof IndirectObject ? obj.value : obj;
      if (value instanceof PDFStream) return this.readXRefStream(value);
      return null;
    }

    readXRefTable(parser) {
      for (;;) {
        const tok = parser.peek(0);
        if (tok.type === 'kw' && tok.val === 'trailer') {
          parser.next();
          const t = parser.parseObject();
          return t instanceof Dict ? t : new Dict();
        }
        if (tok.type !== 'num') return new Dict();    // no trailer keyword

        const first = parser.parseObject();
        const count = parser.parseObject();
        if (typeof first !== 'number' || typeof count !== 'number') return new Dict();

        for (let i = 0; i < count; i++) {
          const a = parser.parseObject();
          const b = parser.parseObject();
          const kind = parser.next();
          if (typeof a !== 'number' || typeof b !== 'number') return new Dict();
          const num = first + i;
          const free = kind.type === 'kw' && kind.val === 'f';
          if (!this.xref.has(num)) {
            this.xref.set(num, free
              ? { type: FREE }
              : { type: NORMAL, offset: a, gen: b });
          }
        }
      }
    }

    readXRefStream(stream) {
      const dict = stream.dict;
      const data = this.decodeStreamBytes(stream);
      const w = this.resolve(dict.get('W'));
      if (!Array.isArray(w)) return dict;
      const widths = w.map((x) => this.resolve(x) | 0);

      const size = this.resolve(dict.get('Size'));
      let index = this.resolve(dict.get('Index'));
      if (!Array.isArray(index)) index = [0, typeof size === 'number' ? size : 0];

      const rowLen = widths.reduce((a, b) => a + b, 0);
      if (rowLen <= 0) return dict;

      let p = 0;
      for (let s = 0; s + 1 < index.length; s += 2) {
        const first = this.resolve(index[s]) | 0;
        const count = this.resolve(index[s + 1]) | 0;
        for (let i = 0; i < count; i++) {
          if (p + rowLen > data.length) break;
          const f = [];
          for (let k = 0; k < widths.length; k++) {
            let v = 0;
            for (let b = 0; b < widths[k]; b++) v = v * 256 + data[p++];
            f.push(v);
          }
          // A zero-width first column means type 1 by definition.
          const type = widths[0] === 0 ? NORMAL : f[0];
          const num = first + i;
          if (this.xref.has(num)) continue;
          if (type === NORMAL) {
            this.xref.set(num, { type: NORMAL, offset: f[1], gen: widths[2] ? f[2] : 0 });
          } else if (type === COMPRESSED) {
            this.xref.set(num, { type: COMPRESSED, streamNum: f[1], idx: f[2] });
          } else {
            this.xref.set(num, { type: FREE });
          }
        }
      }
      return dict;
    }

    // --- recovery -------------------------------------------------------------

    // Reads the file front to back looking for `N G obj`. Later definitions win,
    // which matches how an incrementally updated file is meant to be read.
    recover() {
      const bytes = this.bytes;
      this.recovered = true;
      this.xref.clear();
      this.cache.clear();
      this.objStmCache.clear();

      const O = 0x6f, B = 0x62, J = 0x6a;
      const objStreams = [];

      for (let p = 0; p + 2 < bytes.length; p++) {
        if (bytes[p] !== O || bytes[p + 1] !== B || bytes[p + 2] !== J) continue;
        if (PDF.isRegular(bytes[p + 3])) continue;

        // Walk back over `gen` and `num`.
        let q = p - 1;
        while (q >= 0 && PDF.isWhite(bytes[q])) q--;
        const genEnd = q + 1;
        while (q >= 0 && PDF.isDigit(bytes[q])) q--;
        const genStart = q + 1;
        if (genStart === genEnd) continue;
        while (q >= 0 && PDF.isWhite(bytes[q])) q--;
        const numEnd = q + 1;
        while (q >= 0 && PDF.isDigit(bytes[q])) q--;
        const numStart = q + 1;
        if (numStart === numEnd) continue;
        if (q >= 0 && PDF.isRegular(bytes[q])) continue;

        let num = 0;
        for (let i = numStart; i < numEnd; i++) num = num * 10 + (bytes[i] - 0x30);
        let gen = 0;
        for (let i = genStart; i < genEnd; i++) gen = gen * 10 + (bytes[i] - 0x30);
        if (num <= 0 || num > 8388607) continue;

        this.xref.set(num, { type: NORMAL, offset: numStart, gen });
      }

      // Objects living inside object streams are invisible to that scan, so
      // every ObjStm found has to be opened and its contents registered.
      for (const [num, entry] of Array.from(this.xref)) {
        if (entry.type !== NORMAL) continue;
        let obj;
        try { obj = this.parseObjectAt(entry.offset, num); } catch { continue; }
        if (!(obj instanceof PDFStream)) continue;
        const type = obj.dict.get('Type');
        if (type instanceof Name && type.name === 'ObjStm') objStreams.push(num);
      }
      for (const stmNum of objStreams) {
        try {
          const contents = this.loadObjStm(stmNum);
          contents.nums.forEach((objNum, idx) => {
            if (!this.xref.has(objNum) || this.xref.get(objNum).type === FREE) {
              this.xref.set(objNum, { type: COMPRESSED, streamNum: stmNum, idx });
            }
          });
        } catch { /* unreadable object stream */ }
      }

      if (!(this.resolve(this.trailer.get('Root')) instanceof Dict)) {
        this.findTrailerByScan();
      }
    }

    // Prefers a real trailer dictionary, then falls back to any object that
    // calls itself a catalog.
    findTrailerByScan() {
      const bytes = this.bytes;
      const needle = 'trailer';
      for (let p = bytes.length - needle.length; p >= 0; p--) {
        let hit = true;
        for (let i = 0; i < needle.length; i++) {
          if (bytes[p + i] !== needle.charCodeAt(i)) { hit = false; break; }
        }
        if (!hit) continue;
        try {
          const t = new Parser(bytes, p + needle.length, null).parseObject();
          if (t instanceof Dict && this.resolve(t.get('Root')) instanceof Dict) {
            for (const [k, v] of t.entries()) if (!this.trailer.has(k)) this.trailer.set(k, v);
            return;
          }
        } catch { /* keep looking */ }
      }

      for (const num of this.xref.keys()) {
        let obj;
        try { obj = this.getObject(num); } catch { continue; }
        if (!(obj instanceof Dict)) continue;
        const type = obj.get('Type');
        if (type instanceof Name && type.name === 'Catalog' && obj.has('Pages')) {
          this.trailer.set('Root', new Ref(num, 0));
          return;
        }
      }

      // No catalog at all: synthesise one from every page object in the file,
      // which is the difference between showing something and showing nothing.
      const pageRefs = [];
      for (const num of Array.from(this.xref.keys()).sort((a, b) => a - b)) {
        let obj;
        try { obj = this.getObject(num); } catch { continue; }
        if (!(obj instanceof Dict)) continue;
        const type = obj.get('Type');
        if (type instanceof Name && type.name === 'Page') pageRefs.push(new Ref(num, 0));
      }
      if (pageRefs.length) {
        this.warn('no document catalog: rebuilt one from ' + pageRefs.length + ' loose page objects');
        const pages = new Dict().set('Type', Name.get('Pages'))
          .set('Kids', pageRefs).set('Count', pageRefs.length);
        const catalog = new Dict().set('Type', Name.get('Catalog'));
        this.syntheticPages = pages;
        catalog.set('Pages', pages);
        this.trailer.set('Root', catalog);
      }
    }

    // --- object access ---------------------------------------------------------

    resolve(obj, depth) {
      let d = depth || 0;
      while (obj instanceof Ref) {
        if (++d > 50) return null;                   // reference cycle
        obj = this.getObject(obj.num, obj.gen);
      }
      return obj;
    }

    // Convenience: look a key up in a dictionary and dereference the result.
    get(dict, ...keys) {
      if (!(dict instanceof Dict)) return undefined;
      return this.resolve(dict.get(...keys));
    }

    getObject(num, gen) {
      if (this.cache.has(num)) return this.cache.get(num);
      const entry = this.xref.get(num);
      if (!entry || entry.type === FREE) return null;
      if (this.loading.has(num)) return null;        // cycle through /Length

      this.loading.add(num);
      let value = null;
      try {
        if (entry.type === NORMAL) {
          value = this.parseObjectAt(entry.offset, num);
          // An offset that points at the wrong object means the table is
          // stale; a full rescan is the only reliable repair.
          if (value === undefined) {
            if (!this.recovered) {
              this.loading.delete(num);
              this.warn('cross-reference offsets are stale: rescanned the file');
              this.recover();
              return this.getObject(num, gen);
            }
            value = null;
          }
        } else if (entry.type === COMPRESSED) {
          value = this.getFromObjStm(entry.streamNum, entry.idx, num);
        }
      } catch (e) {
        this.warn('object ' + num + ' unreadable');
        value = null;
      } finally {
        this.loading.delete(num);
      }

      if (this.decryptor && value !== null) {
        value = this.decryptor.decryptObject(value, num, gen === undefined ? 0 : gen);
      }
      this.cache.set(num, value);
      return value;
    }

    // Returns undefined (not null) when the header does not match, so the
    // caller can tell "wrong offset" from "genuinely null".
    parseObjectAt(offset, expectNum) {
      if (!(offset >= 0) || offset >= this.bytes.length) return undefined;
      const parser = new Parser(this.bytes, offset, (ref) => this.resolve(ref));
      const obj = parser.parseObject();
      if (!(obj instanceof IndirectObject)) return undefined;
      if (expectNum !== undefined && obj.num !== expectNum) return undefined;
      return obj.value;
    }

    loadObjStm(streamNum) {
      if (this.objStmCache.has(streamNum)) return this.objStmCache.get(streamNum);

      const entry = this.xref.get(streamNum);
      let stream = null;
      if (entry && entry.type === NORMAL) {
        const v = this.parseObjectAt(entry.offset, streamNum);
        if (v instanceof PDFStream) stream = v;
      }
      if (!stream) {
        const v = this.getObject(streamNum);
        if (v instanceof PDFStream) stream = v;
      }
      if (!stream) {
        const empty = { nums: [], offsets: [], data: new Uint8Array(0), first: 0 };
        this.objStmCache.set(streamNum, empty);
        return empty;
      }

      const data = this.decodeStreamBytes(stream, streamNum);
      const n = this.get(stream.dict, 'N') | 0;
      const first = this.get(stream.dict, 'First') | 0;

      const header = new Parser(data, 0, null);
      const nums = [], offsets = [];
      for (let i = 0; i < n; i++) {
        const a = header.parseObject();
        const b = header.parseObject();
        if (typeof a !== 'number' || typeof b !== 'number') break;
        nums.push(a);
        offsets.push(b);
      }

      const info = { nums, offsets, data, first };
      this.objStmCache.set(streamNum, info);
      return info;
    }

    getFromObjStm(streamNum, idx, wantNum) {
      const info = this.loadObjStm(streamNum);
      let i = idx;
      // Trust the object number over the index; some writers disagree.
      if (info.nums[i] !== wantNum) {
        const found = info.nums.indexOf(wantNum);
        if (found < 0) return null;
        i = found;
      }
      if (i < 0 || i >= info.offsets.length) return null;
      const start = info.first + info.offsets[i];
      if (start >= info.data.length) return null;
      const parser = new Parser(info.data, start, (ref) => this.resolve(ref));
      const v = parser.parseObject();
      return v === EOF ? null : v;
    }

    // --- streams ---------------------------------------------------------------

    // Decoded stream bytes, cached on the stream itself. `objNum` is only
    // needed while loading an object stream, whose own bytes are decrypted
    // before the objects inside it exist.
    decodeStreamBytes(stream, objNum) {
      if (stream.cache) return stream.cache;
      let raw = stream.raw;
      if (this.decryptor && objNum !== undefined) {
        raw = this.decryptor.decryptStreamBytes(raw, objNum, 0, stream.dict);
      }
      const probe = raw === stream.raw ? stream : new PDFStream(stream.dict, raw);
      const out = PDF.decodeStream(probe, (x) => this.resolve(x));
      stream.imageFilter = out.imageFilter;
      stream.imageParams = out.imageParams;
      stream.cache = out.bytes;
      return out.bytes;
    }

    // --- the page tree ---------------------------------------------------------

    get catalog() {
      const root = this.resolve(this.trailer.get('Root'));
      return root instanceof Dict ? root : null;
    }

    // Walks /Kids depth first, carrying the four attributes a page inherits
    // from its ancestors. Guards against a node listing itself.
    get pages() {
      if (this._pages) return this._pages;
      const out = [];
      const cat = this.catalog;
      const rootPages = cat ? this.get(cat, 'Pages') : this.syntheticPages;

      const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
      const seen = new Set();

      const walk = (node, ref, inherited, depth) => {
        if (!(node instanceof Dict) || depth > 64 || out.length > 20000) return;
        const key = ref instanceof Ref ? ref.key : null;
        if (key) {
          if (seen.has(key)) return;
          seen.add(key);
        }

        const next = Object.assign({}, inherited);
        for (const k of INHERITED) {
          if (node.has(k)) next[k] = node.get(k);
        }

        const kids = this.get(node, 'Kids');
        const type = node.get('Type');
        const isPages = Array.isArray(kids) &&
          (!(type instanceof Name) || type.name !== 'Page');

        if (isPages) {
          for (const kidRef of kids) {
            const kid = this.resolve(kidRef);
            walk(kid, kidRef, next, depth + 1);
          }
        } else {
          out.push(new PDFPage(this, node, ref, next, out.length));
        }
      };

      walk(rootPages instanceof Dict ? rootPages : null,
           cat ? cat.get('Pages') : null, {}, 0);

      if (out.length === 0) this.warn('no pages found');
      this._pages = out;
      return out;
    }

    get pageCount() { return this.pages.length; }

    get info() {
      const d = this.resolve(this.trailer.get('Info'));
      return d instanceof Dict ? d : null;
    }

    get version() {
      const head = this.bytes.subarray(0, 32);
      let s = '';
      for (let i = 0; i < head.length; i++) s += String.fromCharCode(head[i]);
      const m = s.match(/%PDF-(\d+\.\d+)/);
      let v = m ? m[1] : '';
      const cat = this.catalog;
      const declared = cat ? cat.get('Version') : null;
      if (declared instanceof Name && declared.name > v) v = declared.name;
      return v;
    }
  }

  // One page, with its inherited attributes already worked out.
  class PDFPage {
    constructor(doc, dict, ref, inherited, index) {
      this.doc = doc;
      this.dict = dict;
      this.ref = ref instanceof Ref ? ref : null;
      this.inherited = inherited;
      this.index = index;
    }

    attr(key) {
      if (this.dict.has(key)) return this.doc.resolve(this.dict.get(key));
      if (key in this.inherited) return this.doc.resolve(this.inherited[key]);
      return undefined;
    }

    get resources() {
      const r = this.attr('Resources');
      return r instanceof Dict ? r : new Dict();
    }

    // A box is four numbers; anything else is not usable, and US Letter is a
    // better guess than nothing.
    box(key) {
      const b = this.attr(key);
      if (!Array.isArray(b) || b.length < 4) return null;
      const v = b.slice(0, 4).map((x) => this.doc.resolve(x));
      if (!v.every((x) => typeof x === 'number' && isFinite(x))) return null;
      return [Math.min(v[0], v[2]), Math.min(v[1], v[3]),
              Math.max(v[0], v[2]), Math.max(v[1], v[3])];
    }

    get mediaBox() { return this.box('MediaBox') || [0, 0, 612, 792]; }

    // The crop box is what a viewer shows, and it must sit inside the media box.
    get cropBox() {
      const crop = this.box('CropBox');
      const media = this.mediaBox;
      if (!crop) return media;
      const x0 = Math.max(crop[0], media[0]), y0 = Math.max(crop[1], media[1]);
      const x1 = Math.min(crop[2], media[2]), y1 = Math.min(crop[3], media[3]);
      if (x1 - x0 < 1 || y1 - y0 < 1) return media;
      return [x0, y0, x1, y1];
    }

    get rotate() {
      let r = this.attr('Rotate');
      if (typeof r !== 'number' || !isFinite(r)) return 0;
      r = Math.round(r / 90) * 90 % 360;
      return r < 0 ? r + 360 : r;
    }

    // Size as displayed, with rotation applied.
    get size() {
      const b = this.cropBox;
      const w = b[2] - b[0], h = b[3] - b[1];
      const r = this.rotate;
      return (r === 90 || r === 270) ? { width: h, height: w } : { width: w, height: h };
    }

    // /Contents is one stream or an array of them, and the array is meant to be
    // read as a single stream with whitespace between the parts.
    get contentBytes() {
      const c = this.attr('Contents');
      const parts = [];
      const add = (s) => {
        const stream = this.doc.resolve(s);
        if (!(stream instanceof PDFStream)) return;
        const num = s instanceof Ref ? s.num : undefined;
        try { parts.push(this.doc.decodeStreamBytes(stream, num)); } catch { /* skip */ }
      };
      if (Array.isArray(c)) c.forEach(add);
      else if (c !== undefined) add(this.dict.get('Contents'));

      if (parts.length === 0) return new Uint8Array(0);
      if (parts.length === 1) return parts[0];
      let total = 0;
      for (const p of parts) total += p.length + 1;
      const out = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
        out[at++] = 0x0a;
      }
      return out;
    }

    get annotations() {
      const a = this.attr('Annots');
      if (!Array.isArray(a)) return [];
      return a.map((r) => this.doc.resolve(r)).filter((d) => d instanceof Dict);
    }
  }

  PDF.PDFDocument = PDFDocument;
  PDF.PDFPage = PDFPage;
  PDF.XRefType = { FREE, NORMAL, COMPRESSED };

})(globalThis.PDF || (globalThis.PDF = {}));
