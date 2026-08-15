// The writer: objects back to bytes, and objects copied between documents.
// Copying is the harder half. A page points at its resources, which point at
// fonts, which point at font files, and somewhere up the tree it points back
// at its parent, which points at every other page. So the copy is a deep
// traversal with a memo, and /Parent is cut on page tree nodes to stop the
// whole source document being pulled across.

;(function (PDF) {
  'use strict';

  const { Name, Ref, Dict, PDFStream } = PDF;

  // Names may only contain a narrow set of characters literally; everything
  // else is written #xx. The delimiters matter most, since a stray '(' in a
  // name would start a string.
  function writeName(n) {
    let out = '/';
    for (let i = 0; i < n.length; i++) {
      const c = n.charCodeAt(i);
      if (c < 0x21 || c > 0x7e || c === 0x23 || PDF.isDelim(c)) {
        out += '#' + c.toString(16).padStart(2, '0');
      } else {
        out += n[i];
      }
    }
    return out;
  }

  function writeString(s) {
    // Literal strings stay readable, which matters when someone opens the file
    // in a text editor to see what a tool did to it.
    let out = '(';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i) & 0xff;
      if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + s[i];
      else if (c === 0x0a) out += '\\n';
      else if (c === 0x0d) out += '\\r';
      else if (c === 0x09) out += '\\t';
      else if (c < 0x20 || c > 0x7e) out += '\\' + c.toString(8).padStart(3, '0');
      else out += String.fromCharCode(c);
    }
    return out + ')';
  }

  function writeNumber(v) {
    if (!isFinite(v)) return '0';
    if (Number.isInteger(v)) return String(v);
    // PDF has no exponent notation, so fixed point it is.
    let s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    return s;
  }

  // Collects output as an array of chunks so nothing is copied twice.
  class ByteSink {
    constructor() { this.chunks = []; this.length = 0; }
    text(s) {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      this.chunks.push(b);
      this.length += b.length;
    }
    bytes(b) { this.chunks.push(b); this.length += b.length; }
    join() {
      const out = new Uint8Array(this.length);
      let at = 0;
      for (const c of this.chunks) { out.set(c, at); at += c.length; }
      return out;
    }
  }

  // Two unrelated things use the key /Parent, and only one is a link worth
  // cutting. On a page tree node it walks up into the source tree and back
  // down through /Kids, dragging every other page across; that is the link
  // this file cuts. On an annotation or a form field, /Parent points within
  // the page or the field tree and must be followed.
  const PAGE_NODE_TYPES = new Set(['Page', 'Pages']);

  function isPageNode(dict) {
    const type = dict.get('Type');
    return type instanceof Name && PAGE_NODE_TYPES.has(type.name);
  }

  class PDFBuilder {
    constructor(options) {
      const opts = options || {};
      this.objects = [null];          // 1-based; index 0 is the free head
      this.version = opts.version || '1.7';
      this.memo = new Map();          // source doc -> (source key -> new Ref)
    }

    // Reserves an object number without deciding its value yet, which is what
    // circular structures (a page pointing at its parent) need.
    reserve() {
      this.objects.push(undefined);
      return new Ref(this.objects.length - 1, 0);
    }

    assign(ref, value) {
      this.objects[ref.num] = value;
      return ref;
    }

    add(value) {
      this.objects.push(value);
      return new Ref(this.objects.length - 1, 0);
    }

    // What a reference points at in this builder. Copying returns references,
    // so anything that has to look inside what it just copied — a page's
    // resources, on the way to adding one entry to them — comes back here.
    value(v) {
      return v instanceof Ref ? this.objects[v.num] : v;
    }

    memoFor(doc) {
      let m = this.memo.get(doc);
      if (!m) { m = new Map(); this.memo.set(doc, m); }
      return m;
    }

    // Deep-copies a value from `doc` into this builder. `skip` names keys that
    // must not be followed; that is how /Parent is prevented from pulling in
    // the source document's whole page tree.
    copy(doc, value, skip, depth) {
      const d = depth || 0;
      if (d > 96) return null;        // pathological nesting

      if (value instanceof Ref) {
        const memo = this.memoFor(doc);
        const key = value.num;
        if (memo.has(key)) return memo.get(key);

        const ref = this.reserve();
        memo.set(key, ref);           // set before recursing, so cycles resolve
        let resolved;
        try { resolved = doc.getObject(value.num, value.gen); }
        catch { resolved = null; }
        this.assign(ref, this.copy(doc, resolved, skip, d + 1));
        return ref;
      }

      if (Array.isArray(value)) {
        return value.map((v) => this.copy(doc, v, skip, d + 1));
      }

      if (value instanceof PDFStream) {
        // The encoded bytes are carried across untouched: re-encoding would
        // cost time and lose nothing, and for an image it would lose quality.
        const dict = this.copyDict(doc, value.dict, skip, d);
        const raw = doc.decryptedRaw ? doc.decryptedRaw(value) : value.raw;
        dict.set('Length', raw.length);
        const out = new PDFStream(dict, raw);
        return out;
      }

      if (value instanceof Dict) {
        return this.copyDict(doc, value, skip, d);
      }

      return value;                   // number, string, Name, boolean, null
    }

    // `skip` is spent on the dictionary handed in and on any page tree node
    // below it, and nowhere else. See isPageNode above for why the same key
    // must be cut in one place and followed in the other. Depth 0 is included
    // on its own account because a page dictionary missing its /Type is still
    // the page being copied.
    copyDict(doc, dict, skip, depth) {
      const out = new Dict();
      const cut = !!skip && (depth === 0 || isPageNode(dict));
      for (const [k, v] of dict.entries()) {
        if (cut && skip.has(k)) continue;
        out.set(k, this.copy(doc, v, skip, depth + 1));
      }
      return out;
    }

    serializeValue(v, sink) {
      if (v === null || v === undefined) { sink.text('null'); return; }
      if (typeof v === 'number') { sink.text(writeNumber(v)); return; }
      if (typeof v === 'boolean') { sink.text(v ? 'true' : 'false'); return; }
      if (typeof v === 'string') { sink.text(writeString(v)); return; }
      if (v instanceof Name) { sink.text(writeName(v.name)); return; }
      if (v instanceof Ref) { sink.text(v.num + ' ' + v.gen + ' R'); return; }
      if (Array.isArray(v)) {
        sink.text('[');
        for (let i = 0; i < v.length; i++) {
          if (i) sink.text(' ');
          this.serializeValue(v[i], sink);
        }
        sink.text(']');
        return;
      }
      if (v instanceof PDFStream) {
        this.serializeValue(v.dict, sink);
        sink.text('\nstream\n');
        sink.bytes(v.raw);
        sink.text('\nendstream');
        return;
      }
      if (v instanceof Dict) {
        sink.text('<<');
        let first = true;
        for (const [k, val] of v.entries()) {
          if (val === undefined) continue;
          sink.text((first ? '' : ' ') + writeName(k) + ' ');
          first = false;
          this.serializeValue(val, sink);
        }
        sink.text('>>');
        return;
      }
      sink.text('null');
    }

    // A plain, uncompressed file with a classic cross-reference table. Every
    // reader since 1993 can open it and it stays greppable, which is worth
    // more here than the space an object-stream build would save.
    build(trailerExtras) {
      const sink = new ByteSink();
      sink.text('%PDF-' + this.version + '\n');
      // Four bytes above 127 mark the file as binary for anything that still
      // transfers files in text mode.
      sink.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

      const offsets = new Array(this.objects.length).fill(0);
      for (let num = 1; num < this.objects.length; num++) {
        const v = this.objects[num];
        if (v === undefined) continue;             // reserved but never filled
        offsets[num] = sink.length;
        sink.text(num + ' 0 obj\n');
        this.serializeValue(v, sink);
        sink.text('\nendobj\n');
      }

      const xrefAt = sink.length;
      const size = this.objects.length;
      sink.text('xref\n0 ' + size + '\n');
      sink.text('0000000000 65535 f \n');
      for (let num = 1; num < size; num++) {
        if (this.objects[num] === undefined) {
          sink.text('0000000000 65535 f \n');
        } else {
          sink.text(String(offsets[num]).padStart(10, '0') + ' 00000 n \n');
        }
      }

      const trailer = new Dict();
      trailer.set('Size', size);
      for (const [k, v] of Object.entries(trailerExtras || {})) {
        if (v !== undefined && v !== null) trailer.set(k, v);
      }
      sink.text('trailer\n');
      this.serializeValue(trailer, sink);
      sink.text('\nstartxref\n' + xrefAt + '\n%%EOF\n');

      return sink.join();
    }
  }

  // A file identifier is two byte strings; the first is meant to be stable for
  // a document's lifetime and the second to change on every save.
  function makeFileId() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let s = '';
    for (let i = 0; i < 16; i++) s += String.fromCharCode(bytes[i]);
    return [s, s];
  }

  // A PDF date is D:YYYYMMDDHHmmSSOHH'mm'.
  function pdfDate(d) {
    const date = d || new Date();
    const p = (n, w) => String(Math.abs(n)).padStart(w || 2, '0');
    const tz = -date.getTimezoneOffset();
    const sign = tz >= 0 ? '+' : '-';
    return 'D:' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
           p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds()) +
           sign + p(tz / 60 | 0) + "'" + p(tz % 60) + "'";
  }

  PDF.PDFBuilder = PDFBuilder;
  PDF.ByteSink = ByteSink;
  PDF.writeName = writeName;
  PDF.writeString = writeString;
  PDF.writeNumber = writeNumber;
  PDF.makeFileId = makeFileId;
  PDF.pdfDate = pdfDate;

})(globalThis.PDF || (globalThis.PDF = {}));
