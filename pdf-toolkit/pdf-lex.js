// The PDF object layer: bytes in, COS objects out. A PDF file contains eight
// object types (null, boolean, number, string, name, array, dictionary,
// stream) plus indirect references. This file turns bytes into those and
// nothing more: it knows syntax, not pages, xref tables or encryption.

;(function (PDF) {
  'use strict';

  const NUL = 0, TAB = 9, LF = 10, FF = 12, CR = 13, SP = 32;

  function isWhite(c) {
    return c === SP || c === LF || c === CR || c === TAB || c === NUL || c === FF;
  }

  function isDelim(c) {
    return c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b ||
           c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
  }

  function isRegular(c) {
    return c !== undefined && !isWhite(c) && !isDelim(c);
  }

  function isDigit(c) { return c >= 0x30 && c <= 0x39; }

  function hexVal(c) {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x41 && c <= 0x46) return c - 0x37;
    if (c >= 0x61 && c <= 0x66) return c - 0x57;
    return -1;
  }

  // Names are interned so that `dict.get('Type') === Name.get('Page')` style
  // identity checks hold, and so the writer can compare without allocating.
  const nameCache = new Map();

  class Name {
    constructor(n) { this.name = n; }
    static get(n) {
      let v = nameCache.get(n);
      if (v === undefined) { v = new Name(n); nameCache.set(n, v); }
      return v;
    }
    toString() { return '/' + this.name; }
  }

  class Ref {
    constructor(num, gen) { this.num = num; this.gen = gen; }
    get key() { return this.num + 'R' + this.gen; }
    toString() { return this.num + ' ' + this.gen + ' R'; }
  }

  class Dict {
    constructor(entries) {
      this.map = new Map(entries);
    }
    // Takes several keys so abbreviated inline-image dictionaries can be read
    // with the same call as their spelled-out equivalents: get('Width', 'W').
    get(...keys) {
      for (const k of keys) {
        const v = this.map.get(k);
        if (v !== undefined) return v;
      }
      return undefined;
    }
    set(k, v) { this.map.set(k, v); return this; }
    has(...keys) { return keys.some((k) => this.map.has(k)); }
    delete(k) { this.map.delete(k); }
    keys() { return this.map.keys(); }
    entries() { return this.map.entries(); }
    get size() { return this.map.size; }
    clone() { return new Dict(this.map); }
  }

  class PDFStream {
    constructor(dict, raw) {
      this.dict = dict;
      this.raw = raw;        // still encoded, exactly as it sat in the file
      this.cache = null;     // decoded bytes, filled in by the filter layer
    }
  }

  // A parsed `n g obj` header, only ever produced when parsing at a known
  // object offset. The document layer unwraps it.
  class IndirectObject {
    constructor(num, gen, value) { this.num = num; this.gen = gen; this.value = value; }
  }

  const EOF = Symbol('EOF');

  const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];

  // Token types: 'num', 'str', 'name', 'kw', and the punctuation marks
  // '[', ']', '<<', '>>', '{', '}'.
  class Lexer {
    constructor(buf, pos) {
      this.buf = buf;
      this.pos = pos || 0;
    }

    skipWhite() {
      const buf = this.buf, n = buf.length;
      while (this.pos < n) {
        const c = buf[this.pos];
        if (c === 0x25) {              // % comment runs to end of line
          while (this.pos < n && buf[this.pos] !== LF && buf[this.pos] !== CR) this.pos++;
        } else if (isWhite(c)) {
          this.pos++;
        } else {
          break;
        }
      }
    }

    getToken() {
      this.skipWhite();
      const buf = this.buf, n = buf.length;
      if (this.pos >= n) return { type: EOF };
      const start = this.pos;
      const c = buf[this.pos];

      if (c === 0x2f) return this.readName();
      if (c === 0x28) return this.readLiteralString();
      if (c === 0x3c) {
        if (buf[this.pos + 1] === 0x3c) { this.pos += 2; return { type: '<<', pos: start }; }
        return this.readHexString();
      }
      if (c === 0x3e) {
        if (buf[this.pos + 1] === 0x3e) { this.pos += 2; return { type: '>>', pos: start }; }
        this.pos++;                    // stray '>', skip it
        return this.getToken();
      }
      if (c === 0x5b) { this.pos++; return { type: '[', pos: start }; }
      if (c === 0x5d) { this.pos++; return { type: ']', pos: start }; }
      if (c === 0x7b) { this.pos++; return { type: '{', pos: start }; }
      if (c === 0x7d) { this.pos++; return { type: '}', pos: start }; }
      if (c === 0x29) { this.pos++; return this.getToken(); }   // unbalanced ')'

      if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) return this.readNumber();

      return this.readKeyword();
    }

    // Real files carry numbers the grammar does not allow: `--5`, `6.-2`,
    // `-.002`, `34.5-` and bare `.`. Anything that cannot be read as a number
    // becomes 0 rather than derailing the parse.
    readNumber() {
      const buf = this.buf, n = buf.length;
      const start = this.pos;
      let s = '';
      while (this.pos < n && isRegular(buf[this.pos])) {
        s += String.fromCharCode(buf[this.pos]);
        this.pos++;
      }
      let v = parseFloat(s);
      if (!isFinite(v)) {
        const m = s.match(/-?\d*\.?\d+/);
        v = m ? parseFloat(m[0]) : 0;
        if (!isFinite(v)) v = 0;
      }
      return { type: 'num', val: v, pos: start };
    }

    readName() {
      const buf = this.buf, n = buf.length;
      const start = this.pos;
      this.pos++;                       // the '/'
      let s = '';
      while (this.pos < n && isRegular(buf[this.pos])) {
        let ch = buf[this.pos];
        if (ch === 0x23 && this.pos + 2 < n) {
          const h1 = hexVal(buf[this.pos + 1]), h2 = hexVal(buf[this.pos + 2]);
          if (h1 >= 0 && h2 >= 0) {
            s += String.fromCharCode((h1 << 4) | h2);
            this.pos += 3;
            continue;
          }
        }
        s += String.fromCharCode(ch);
        this.pos++;
      }
      return { type: 'name', val: Name.get(s), pos: start };
    }

    readLiteralString() {
      const buf = this.buf, n = buf.length;
      const start = this.pos;
      this.pos++;                       // the '('
      let depth = 1, s = '';
      while (this.pos < n) {
        let c = buf[this.pos++];
        if (c === 0x5c) {               // backslash escape
          if (this.pos >= n) break;
          const e = buf[this.pos++];
          switch (e) {
            case 0x6e: s += '\n'; break;
            case 0x72: s += '\r'; break;
            case 0x74: s += '\t'; break;
            case 0x62: s += '\b'; break;
            case 0x66: s += '\f'; break;
            case 0x28: s += '('; break;
            case 0x29: s += ')'; break;
            case 0x5c: s += '\\'; break;
            case CR:                    // line continuation
              if (buf[this.pos] === LF) this.pos++;
              break;
            case LF: break;
            default:
              if (e >= 0x30 && e <= 0x37) {
                let oct = e - 0x30;
                for (let i = 0; i < 2; i++) {
                  const d = buf[this.pos];
                  if (d >= 0x30 && d <= 0x37) { oct = (oct << 3) | (d - 0x30); this.pos++; }
                  else break;
                }
                s += String.fromCharCode(oct & 0xff);
              } else {
                s += String.fromCharCode(e);
              }
          }
        } else if (c === 0x28) {
          depth++; s += '(';
        } else if (c === 0x29) {
          depth--;
          if (depth === 0) break;
          s += ')';
        } else {
          s += String.fromCharCode(c);
        }
      }
      return { type: 'str', val: s, pos: start };
    }

    readHexString() {
      const buf = this.buf, n = buf.length;
      const start = this.pos;
      this.pos++;                       // the '<'
      let s = '', digit = -1;
      while (this.pos < n) {
        const c = buf[this.pos++];
        if (c === 0x3e) break;
        const h = hexVal(c);
        if (h < 0) continue;            // whitespace and junk are skipped
        if (digit < 0) digit = h;
        else { s += String.fromCharCode((digit << 4) | h); digit = -1; }
      }
      if (digit >= 0) s += String.fromCharCode(digit << 4);   // odd digit pads with 0
      return { type: 'str', val: s, pos: start };
    }

    readKeyword() {
      const buf = this.buf, n = buf.length;
      const start = this.pos;
      let s = '';
      while (this.pos < n && isRegular(buf[this.pos])) {
        s += String.fromCharCode(buf[this.pos]);
        this.pos++;
      }
      if (s === '') { this.pos++; return this.getToken(); }   // unreachable in theory
      return { type: 'kw', val: s, pos: start };
    }
  }

  // Builds objects out of the token stream. `resolve` is optional and only
  // needed to look up an indirect /Length on a stream; without it the parser
  // falls back to scanning for `endstream`, which is what damaged files need
  // anyway.
  class Parser {
    constructor(buf, pos, resolve) {
      this.lexer = new Lexer(buf, pos);
      this.buf = buf;
      this.resolve = resolve || null;
      this.stack = [];                  // pushed-back tokens, most recent last
    }

    get pos() { return this.stack.length ? this.stack[0].pos : this.lexer.pos; }
    set pos(p) { this.stack.length = 0; this.lexer.pos = p; }

    next() { return this.stack.length ? this.stack.shift() : this.lexer.getToken(); }
    push(tok) { this.stack.unshift(tok); }

    peek(i) {
      while (this.stack.length <= (i || 0)) this.stack.push(this.lexer.getToken());
      return this.stack[i || 0];
    }

    // Reads one object. Returns EOF at end of input. Keywords that are not
    // objects (`obj`, `R`, `stream`, content-stream operators) come back as
    // {type:'kw'} tokens so callers can decide what they mean.
    parseObject() {
      const tok = this.next();
      switch (tok.type) {
        case EOF: return EOF;
        case 'num': {
          // `n g R` and `n g obj` are the only two three-token forms.
          if (Number.isInteger(tok.val) && tok.val >= 0) {
            const t1 = this.peek(0), t2 = this.peek(1);
            if (t1.type === 'num' && Number.isInteger(t1.val) && t2.type === 'kw') {
              if (t2.val === 'R') {
                this.next(); this.next();
                return new Ref(tok.val, t1.val);
              }
              if (t2.val === 'obj') {
                this.next(); this.next();
                return new IndirectObject(tok.val, t1.val, this.parseObject());
              }
            }
          }
          return tok.val;
        }
        case 'str': return tok.val;
        case 'name': return tok.val;
        case '[': {
          const arr = [];
          for (;;) {
            const t = this.peek(0);
            if (t.type === ']') { this.next(); break; }
            if (t.type === EOF) break;
            // A stray '>>' or 'endobj' inside an array means the array was
            // never closed; give it back to the caller rather than eating it.
            if (t.type === '>>' || (t.type === 'kw' && t.val === 'endobj')) break;
            const v = this.parseObject();
            if (v === EOF) break;
            arr.push(v);
          }
          return arr;
        }
        case '<<': {
          const dict = new Dict();
          for (;;) {
            const t = this.next();
            if (t.type === '>>' || t.type === EOF) break;
            if (t.type === 'kw' && (t.val === 'endobj' || t.val === 'stream')) { this.push(t); break; }
            if (t.type !== 'name') continue;          // key must be a name; skip junk
            const val = this.parseObject();
            if (val === EOF) break;
            if (val instanceof IndirectObject) break; // ran off into the next object
            dict.set(t.val.name, val);
          }
          const after = this.peek(0);
          if (after.type === 'kw' && after.val === 'stream') {
            this.next();
            return this.readStream(dict, after.pos);
          }
          return dict;
        }
        case ']': case '>>': case '{': case '}':
          return this.parseObject();                 // stray punctuation, skip
        case 'kw':
          if (tok.val === 'true') return true;
          if (tok.val === 'false') return false;
          if (tok.val === 'null') return null;
          return tok;                                // operator or structural keyword
      }
      return null;
    }

    // `stream` is followed by CRLF or LF (never bare CR, though files do it
    // anyway), then /Length bytes, then `endstream`.
    readStream(dict, kwPos) {
      const buf = this.buf, n = buf.length;
      let p = kwPos + 6;                             // past the word 'stream'
      if (buf[p] === CR) p++;
      if (buf[p] === LF) p++;
      const start = p;

      let len = dict.get('Length');
      if (len instanceof Ref && this.resolve) len = this.resolve(len);
      if (typeof len !== 'number' || len < 0 || start + len > n) len = -1;

      let end = -1;
      if (len >= 0) {
        // Trust /Length only if `endstream` really is where it claims.
        const probe = this.skipWhiteAt(start + len);
        if (this.matchAt(probe, 'endstream')) end = start + len;
      }
      if (end < 0) {
        end = this.findEndstream(start);
        if (end < 0) end = n;
      }

      const raw = buf.subarray(start, end);
      dict.set('Length', end - start);
      this.pos = end;
      // Step over the trailing `endstream` so the caller resumes cleanly.
      const t = this.peek(0);
      if (t.type === 'kw' && t.val === 'endstream') this.next();
      return new PDFStream(dict, raw);
    }

    skipWhiteAt(p) {
      const buf = this.buf, n = buf.length;
      while (p < n && isWhite(buf[p])) p++;
      return p;
    }

    matchAt(p, word) {
      const buf = this.buf;
      if (p + word.length > buf.length) return false;
      for (let i = 0; i < word.length; i++) {
        if (buf[p + i] !== word.charCodeAt(i)) return false;
      }
      return true;
    }

    // Scans for the next `endstream`, backing off the end-of-line that
    // precedes it so the stream's own last bytes are not swallowed.
    findEndstream(start) {
      const buf = this.buf, n = buf.length, last = n - ENDSTREAM.length;
      for (let p = start; p <= last; p++) {
        if (buf[p] !== ENDSTREAM[0]) continue;
        let hit = true;
        for (let i = 1; i < ENDSTREAM.length; i++) {
          if (buf[p + i] !== ENDSTREAM[i]) { hit = false; break; }
        }
        if (!hit) continue;
        let e = p;
        if (e > start && buf[e - 1] === LF) e--;
        if (e > start && buf[e - 1] === CR) e--;
        return e;
      }
      return -1;
    }
  }

  // --- small helpers shared by the layers above -----------------------------

  function bytesToLatin1(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
  }

  function latin1ToBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  // PDF text strings are either UTF-16BE with a BOM, or PDFDocEncoding, which
  // agrees with latin1 across the range that matters here.
  function decodeTextString(s) {
    if (s.length >= 2 && s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
      let out = '';
      for (let i = 2; i + 1 < s.length; i += 2) {
        out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
      }
      return out;
    }
    if (s.length >= 3 && s.charCodeAt(0) === 0xef && s.charCodeAt(1) === 0xbb &&
        s.charCodeAt(2) === 0xbf) {
      try { return new TextDecoder('utf-8').decode(latin1ToBytes(s.slice(3))); }
      catch { return s.slice(3); }
    }
    return s;
  }

  PDF.Name = Name;
  PDF.Ref = Ref;
  PDF.Dict = Dict;
  PDF.PDFStream = PDFStream;
  PDF.IndirectObject = IndirectObject;
  PDF.Lexer = Lexer;
  PDF.Parser = Parser;
  PDF.EOF = EOF;
  PDF.isWhite = isWhite;
  PDF.isDelim = isDelim;
  PDF.isRegular = isRegular;
  PDF.isDigit = isDigit;
  PDF.bytesToLatin1 = bytesToLatin1;
  PDF.latin1ToBytes = latin1ToBytes;
  PDF.decodeTextString = decodeTextString;

})(globalThis.PDF || (globalThis.PDF = {}));
