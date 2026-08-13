// Stream filters: encoded bytes in, decoded bytes out. Every filter here is
// synchronous. The browser provides inflate in DecompressionStream, but only
// as a Promise, and a PDF renderer decodes streams in its innermost loop, so
// an async boundary there would spread through the whole renderer. The inflate
// below is therefore written out.

;(function (PDF) {
  'use strict';

  const { Name, Dict } = PDF;

  const TAB = 9, LF = 10, CR = 13, SP = 32;

  // --- inflate (RFC 1950 / 1951) --------------------------------------------

  const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
                       35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
                        3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
                     257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
                     8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
                      7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  // Decode tables are direct-mapped on the tree's longest code, so a symbol is
  // one array read. They are reused across blocks to keep allocation out of
  // the hot path; inflate never yields, so sharing them is safe.
  const litTable = new Int32Array(1 << 15);
  const distTable = new Int32Array(1 << 15);
  const clenTable = new Int32Array(1 << 7);
  const litLens = new Uint8Array(288);
  const distLens = new Uint8Array(32);
  const clenLens = new Uint8Array(19);

  // Canonical Huffman: fill every table slot whose low bits match a code with
  // (codeLength << 16 | symbol). Returns the longest code length, which is how
  // many bits the decoder must peek.
  function buildTable(lens, n, table) {
    let maxLen = 0;
    for (let i = 0; i < n; i++) if (lens[i] > maxLen) maxLen = lens[i];
    if (maxLen === 0) return 0;
    const size = 1 << maxLen;
    table.fill(0, 0, size);

    const count = new Int32Array(maxLen + 1);
    for (let i = 0; i < n; i++) if (lens[i]) count[lens[i]]++;

    const nextCode = new Int32Array(maxLen + 2);
    let code = 0;
    for (let bits = 1; bits <= maxLen; bits++) {
      code = (code + (count[bits - 1] | 0)) << 1;
      nextCode[bits] = code;
    }

    for (let sym = 0; sym < n; sym++) {
      const len = lens[sym];
      if (!len) continue;
      const c = nextCode[len]++;
      let rev = 0;                                   // codes arrive MSB-first
      for (let b = 0; b < len; b++) rev |= ((c >> (len - 1 - b)) & 1) << b;
      const entry = (len << 16) | sym;
      for (let i = rev; i < size; i += (1 << len)) table[i] = entry;
    }
    return maxLen;
  }

  function isZlibHeader(src, p) {
    if (p + 1 >= src.length) return false;
    const cmf = src[p], flg = src[p + 1];
    return (cmf & 0x0f) === 8 && (((cmf << 8) | flg) % 31) === 0 && !(flg & 0x20);
  }

  // Returns { bytes, ok }. `ok` means at least one block was read without
  // going wrong, which is how the caller tells a stream that legitimately
  // decoded to nothing from one that never decoded at all.
  function inflateCore(src, sizeHint) {
    let pos = 0;
    let blocksDone = 0;

    // A zlib wrapper is two bytes: deflate method, and a check value that makes
    // the pair a multiple of 31. Raw deflate turns up too, so sniff rather than
    // assume. Leading end-of-line bytes are only skipped when doing so reveals
    // a real header: a raw stored block legitimately starts with 0x00, and
    // treating that as whitespace would eat the stream's first byte.
    if (isZlibHeader(src, 0)) {
      pos = 2;
    } else {
      let p = 0;
      while (p < src.length && (src[p] === LF || src[p] === CR || src[p] === SP || src[p] === TAB)) p++;
      if (p > 0 && isZlibHeader(src, p)) pos = p + 2;
    }

    let out = new Uint8Array(Math.max(sizeHint | 0, (src.length - pos) * 4, 1024));
    let outLen = 0;
    let bitbuf = 0, bitcnt = 0;

    function grow(need) {
      if (outLen + need <= out.length) return;
      let cap = out.length;
      while (cap < outLen + need) cap *= 2;
      const bigger = new Uint8Array(cap);
      bigger.set(out.subarray(0, outLen));
      out = bigger;
    }

    // Reading past the end feeds zero bits, which a Huffman tree will happily
    // decode into literals for ever. A few bytes of slack let a final block
    // flush; beyond that, treat the stream as over.
    let overrun = 0;
    let safeLen = -1;                                // output written before the first over-read
    function nextByte() {
      if (pos < src.length) return src[pos++];
      pos++;
      if (overrun === 0) safeLen = outLen;
      if (++overrun > 8) throw new Error('inflate: ran past end of stream');
      return 0;
    }

    function bits(n) {
      while (bitcnt < n) {
        bitbuf |= nextByte() << bitcnt;
        bitcnt += 8;
      }
      const v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n; bitcnt -= n;
      return v;
    }

    function decode(table, maxLen) {
      while (bitcnt < maxLen) {
        bitbuf |= nextByte() << bitcnt;
        bitcnt += 8;
      }
      const e = table[bitbuf & ((1 << maxLen) - 1)];
      const len = e >>> 16;
      if (len === 0) throw new Error('inflate: invalid code');
      bitbuf >>>= len; bitcnt -= len;
      return e & 0xffff;
    }

    // A damaged stream is more useful than an exception: half a content stream
    // still draws most of a page, and half a font still measures text. The
    // loop below breaks on a malformed block and returns the prefix, leaving
    // the caller to detect that nothing was decoded.
    try {
    for (;;) {
      // Past the end with no final block seen: the stream is truncated, and
      // what we decoded so far is still worth keeping.
      if (pos > src.length + 4) break;

      const final = bits(1);
      const type = bits(2);

      if (type === 0) {                              // stored
        bitbuf = 0; bitcnt = 0;
        if (pos + 4 > src.length) break;
        const len = src[pos] | (src[pos + 1] << 8);
        pos += 4;                                    // LEN then its complement
        const avail = Math.min(len, src.length - pos);
        grow(avail);
        out.set(src.subarray(pos, pos + avail), outLen);
        outLen += avail;
        pos += avail;
        if (avail < len) break;
      } else if (type === 1 || type === 2) {
        let litMax, distMax;
        if (type === 1) {                            // fixed trees
          for (let i = 0; i < 144; i++) litLens[i] = 8;
          for (let i = 144; i < 256; i++) litLens[i] = 9;
          for (let i = 256; i < 280; i++) litLens[i] = 7;
          for (let i = 280; i < 288; i++) litLens[i] = 8;
          distLens.fill(5);
          litMax = buildTable(litLens, 288, litTable);
          distMax = buildTable(distLens, 32, distTable);
        } else {                                     // dynamic trees
          const hlit = bits(5) + 257;
          const hdist = bits(5) + 1;
          const hclen = bits(4) + 4;
          clenLens.fill(0);
          for (let i = 0; i < hclen; i++) clenLens[CLEN_ORDER[i]] = bits(3);
          const clenMax = buildTable(clenLens, 19, clenTable);

          const all = new Uint8Array(hlit + hdist);
          for (let i = 0; i < hlit + hdist;) {
            const sym = decode(clenTable, clenMax);
            if (sym < 16) {
              all[i++] = sym;
            } else if (sym === 16) {
              const prev = i > 0 ? all[i - 1] : 0;
              let r = 3 + bits(2);
              while (r-- && i < all.length) all[i++] = prev;
            } else if (sym === 17) {
              let r = 3 + bits(3);
              while (r-- && i < all.length) all[i++] = 0;
            } else {
              let r = 11 + bits(7);
              while (r-- && i < all.length) all[i++] = 0;
            }
          }
          litLens.fill(0); distLens.fill(0);
          litLens.set(all.subarray(0, hlit));
          distLens.set(all.subarray(hlit, hlit + hdist).subarray(0, 32));
          litMax = buildTable(litLens, hlit, litTable);
          distMax = buildTable(distLens, Math.min(hdist, 32), distTable);
        }

        for (;;) {
          const sym = decode(litTable, litMax);
          if (sym < 256) {
            grow(1);
            out[outLen++] = sym;
          } else if (sym === 256) {
            break;
          } else {
            const li = sym - 257;
            if (li >= LENGTH_BASE.length) throw new Error('inflate: bad length code');
            const length = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);
            const dsym = decode(distTable, distMax);
            if (dsym >= DIST_BASE.length) throw new Error('inflate: bad distance code');
            const dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
            if (dist > outLen) throw new Error('inflate: distance past start');
            grow(length);
            let from = outLen - dist;
            for (let i = 0; i < length; i++) out[outLen++] = out[from++];
          }
        }
      } else {
        break;                                       // reserved block type
      }

      blocksDone++;
      if (final) break;
    }
    } catch {
      // Everything decoded after the first byte of zero padding came from bits
      // that were never in the file, so cut back to the last honest output.
      if (safeLen >= 0 && safeLen < outLen) outLen = safeLen;
    }

    return { bytes: out.subarray(0, outLen), ok: blocksDone > 0 };
  }

  function inflate(src, sizeHint) {
    return inflateCore(src, sizeHint).bytes;
  }

  // Streams whose data does not start where the dictionary says are common
  // enough to be worth a second try, but only when the first attempt could not
  // read a single block. A stream that decoded cleanly to nothing is a real
  // answer, and a truncated one already kept its prefix.
  function flateDecode(src, sizeHint) {
    const first = inflateCore(src, sizeHint);
    if (first.ok || src.length < 3) return first.bytes;
    for (let skip = 1; skip <= 2; skip++) {
      const retry = inflateCore(src.subarray(skip), sizeHint);
      if (retry.ok) return retry.bytes;
    }
    return first.bytes;
  }

  // --- predictors -----------------------------------------------------------

  // Both PNG and TIFF predictors turn each row into a delta against the row or
  // pixel before it. Undo that in place.
  function applyPredictor(data, predictor, colors, bpc, columns) {
    if (predictor <= 1) return data;

    const bpp = Math.ceil(colors * bpc / 8);          // bytes per pixel, min 1
    const rowLen = Math.ceil(colors * bpc * columns / 8);

    if (predictor === 2) {                            // TIFF
      if (bpc === 8) {
        const rows = Math.floor(data.length / rowLen);
        for (let r = 0; r < rows; r++) {
          const off = r * rowLen;
          for (let i = bpp; i < rowLen; i++) {
            data[off + i] = (data[off + i] + data[off + i - bpp]) & 0xff;
          }
        }
      }
      return data;
    }

    // PNG: every row is prefixed with a one-byte filter tag.
    const stride = rowLen + 1;
    const rows = Math.floor(data.length / stride);
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);

    for (let r = 0; r < rows; r++) {
      const tag = data[r * stride];
      const src = data.subarray(r * stride + 1, r * stride + 1 + rowLen);
      const row = out.subarray(r * rowLen, (r + 1) * rowLen);
      row.set(src);

      switch (tag) {
        case 0: break;                                // None
        case 1:                                       // Sub
          for (let i = bpp; i < rowLen; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
          break;
        case 2:                                       // Up
          for (let i = 0; i < rowLen; i++) row[i] = (row[i] + prev[i]) & 0xff;
          break;
        case 3:                                       // Average
          for (let i = 0; i < rowLen; i++) {
            const left = i >= bpp ? row[i - bpp] : 0;
            row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
          }
          break;
        case 4:                                       // Paeth
          for (let i = 0; i < rowLen; i++) {
            const a = i >= bpp ? row[i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            row[i] = (row[i] + pred) & 0xff;
          }
          break;
        default: break;                               // unknown tag, take as-is
      }
      prev = row;
    }
    return out;
  }

  // --- the simple filters ---------------------------------------------------

  function lzwDecode(src, earlyChange) {
    const early = earlyChange === 0 ? 0 : 1;
    const dictVals = new Uint8Array(8192);            // last byte of each entry
    const dictPrev = new Int32Array(8192);            // index of the prefix
    const dictLen = new Int32Array(8192);
    for (let i = 0; i < 256; i++) { dictVals[i] = i; dictPrev[i] = -1; dictLen[i] = 1; }

    let nextCode = 258, codeWidth = 9, prev = -1;
    let out = new Uint8Array(Math.max(src.length * 4, 1024));
    let outLen = 0;
    let bitbuf = 0, bitcnt = 0, pos = 0;

    function emit(code) {
      const len = dictLen[code];
      if (outLen + len > out.length) {
        let cap = out.length;
        while (cap < outLen + len) cap *= 2;
        const bigger = new Uint8Array(cap);
        bigger.set(out.subarray(0, outLen));
        out = bigger;
      }
      let w = outLen + len - 1, c = code;
      while (c >= 0) { out[w--] = dictVals[c]; c = dictPrev[c]; }
      outLen += len;
      return len;
    }

    for (;;) {
      while (bitcnt < codeWidth) {
        if (pos >= src.length) { bitcnt = -1; break; }
        bitbuf = (bitbuf << 8) | src[pos++];
        bitcnt += 8;
      }
      if (bitcnt < 0) break;
      const code = (bitbuf >> (bitcnt - codeWidth)) & ((1 << codeWidth) - 1);
      bitcnt -= codeWidth;

      if (code === 256) {                             // clear
        nextCode = 258; codeWidth = 9; prev = -1;
        continue;
      }
      if (code === 257) break;                        // end of data

      if (prev < 0) {
        if (code > 255) break;                        // corrupt
        emit(code);
        prev = code;
        continue;
      }

      let firstByte;
      if (code < nextCode && dictLen[code]) {
        let c = code;
        while (dictPrev[c] >= 0) c = dictPrev[c];
        firstByte = dictVals[c];
        emit(code);
      } else {
        // The KwKwK case: the code is the one we are about to define.
        let c = prev;
        while (dictPrev[c] >= 0) c = dictPrev[c];
        firstByte = dictVals[c];
        emit(prev);
        if (outLen + 1 > out.length) {
          const bigger = new Uint8Array(out.length * 2);
          bigger.set(out.subarray(0, outLen));
          out = bigger;
        }
        out[outLen++] = firstByte;
      }

      if (nextCode < 4096) {
        dictPrev[nextCode] = prev;
        dictVals[nextCode] = firstByte;
        dictLen[nextCode] = dictLen[prev] + 1;
        nextCode++;
      }
      prev = code < nextCode ? code : prev;

      if (nextCode + early >= (1 << codeWidth) && codeWidth < 12) codeWidth++;
    }
    return out.subarray(0, outLen);
  }

  function ascii85Decode(src) {
    // 'z' stands for four zero bytes, so one input character can become four
    // output ones and the usual 4/5 estimate is not an upper bound.
    let out = new Uint8Array(Math.ceil(src.length * 4 / 5) + 8);
    let outLen = 0, tuple = 0, count = 0;
    function room(n) {
      if (outLen + n <= out.length) return;
      let cap = out.length;
      while (cap < outLen + n) cap *= 2;
      const bigger = new Uint8Array(cap);
      bigger.set(out.subarray(0, outLen));
      out = bigger;
    }
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (PDF.isWhite(c)) continue;
      if (c === 0x7e) break;                          // '~' ends the data
      if (c === 0x7a && count === 0) {                // 'z' is four zero bytes
        room(4);
        out[outLen++] = 0; out[outLen++] = 0; out[outLen++] = 0; out[outLen++] = 0;
        continue;
      }
      if (c < 0x21 || c > 0x75) continue;
      tuple = tuple * 85 + (c - 0x21);
      if (++count === 5) {
        room(4);
        out[outLen++] = (tuple >>> 24) & 0xff;
        out[outLen++] = (tuple >>> 16) & 0xff;
        out[outLen++] = (tuple >>> 8) & 0xff;
        out[outLen++] = tuple & 0xff;
        tuple = 0; count = 0;
      }
    }
    if (count > 0) {                                  // partial group pads with 'u'
      for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
      for (let i = 0; i < count - 1; i++) out[outLen++] = (tuple >>> (24 - i * 8)) & 0xff;
    }
    return out.subarray(0, outLen);
  }

  function asciiHexDecode(src) {
    const out = new Uint8Array(Math.ceil(src.length / 2));
    let outLen = 0, digit = -1;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === 0x3e) break;                          // '>' ends the data
      let h = -1;
      if (c >= 0x30 && c <= 0x39) h = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) h = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) h = c - 0x57;
      else continue;
      if (digit < 0) digit = h;
      else { out[outLen++] = (digit << 4) | h; digit = -1; }
    }
    if (digit >= 0) out[outLen++] = digit << 4;
    return out.subarray(0, outLen);
  }

  function runLengthDecode(src) {
    let out = new Uint8Array(src.length * 2 + 16);
    let outLen = 0, i = 0;
    function room(n) {
      if (outLen + n <= out.length) return;
      let cap = out.length;
      while (cap < outLen + n) cap *= 2;
      const bigger = new Uint8Array(cap);
      bigger.set(out.subarray(0, outLen));
      out = bigger;
    }
    while (i < src.length) {
      const n = src[i++];
      if (n === 128) break;
      if (n < 128) {
        const count = n + 1;
        room(count);
        for (let k = 0; k < count && i < src.length; k++) out[outLen++] = src[i++];
      } else {
        const count = 257 - n;
        const b = src[i++];
        room(count);
        for (let k = 0; k < count; k++) out[outLen++] = b;
      }
    }
    return out.subarray(0, outLen);
  }

  // Filters the renderer hands to the browser's image decoder instead.
  const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode',
                                 'CCITTFaxDecode', 'CCF']);

  const FILTER_ALIASES = {
    Fl: 'FlateDecode', LZW: 'LZWDecode', A85: 'ASCII85Decode',
    AHx: 'ASCIIHexDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode',
  };

  function normaliseFilter(n) { return FILTER_ALIASES[n] || n; }

  // Runs a stream's filter chain. `resolve` dereferences indirect objects.
  // Returns { bytes, imageFilter, imageParams }: when the chain ends in an
  // image codec the bytes are still encoded and imageFilter names it.
  function decodeStream(stream, resolve) {
    const r = resolve || ((x) => x);
    const dict = stream.dict;

    let filters = r(dict.get('Filter', 'F'));
    let params = r(dict.get('DecodeParms', 'DP', 'DecodeParams'));
    if (filters === undefined || filters === null) {
      return { bytes: stream.raw, imageFilter: null, imageParams: null };
    }
    if (filters instanceof Name) filters = [filters];
    if (!Array.isArray(filters)) return { bytes: stream.raw, imageFilter: null, imageParams: null };
    if (!Array.isArray(params)) params = [params];

    let bytes = stream.raw;
    for (let i = 0; i < filters.length; i++) {
      const f = r(filters[i]);
      if (!(f instanceof Name)) continue;
      const name = normaliseFilter(f.name);
      const parm = r(params[i]);
      const pd = parm instanceof Dict ? parm : null;

      if (IMAGE_FILTERS.has(name)) {
        return { bytes, imageFilter: name, imageParams: pd };
      }

      switch (name) {
        case 'FlateDecode':
          bytes = flateDecode(bytes);
          break;
        case 'LZWDecode':
          bytes = lzwDecode(bytes, pd ? r(pd.get('EarlyChange')) : 1);
          break;
        case 'ASCII85Decode':
          bytes = ascii85Decode(bytes);
          break;
        case 'ASCIIHexDecode':
          bytes = asciiHexDecode(bytes);
          break;
        case 'RunLengthDecode':
          bytes = runLengthDecode(bytes);
          break;
        case 'Crypt':
          break;                                      // handled by the decryptor
        default:
          break;                                      // unknown filter, pass through
      }

      if (pd) {
        const pred = num(r(pd.get('Predictor')), 1);
        if (pred > 1) {
          bytes = applyPredictor(bytes, pred,
            num(r(pd.get('Colors')), 1),
            num(r(pd.get('BitsPerComponent')), 8),
            num(r(pd.get('Columns')), 1));
        }
      }
    }
    return { bytes, imageFilter: null, imageParams: null };
  }

  function num(v, dflt) { return typeof v === 'number' ? v : dflt; }

  PDF.inflate = inflate;
  PDF.flateDecode = flateDecode;
  PDF.lzwDecode = lzwDecode;
  PDF.ascii85Decode = ascii85Decode;
  PDF.asciiHexDecode = asciiHexDecode;
  PDF.runLengthDecode = runLengthDecode;
  PDF.applyPredictor = applyPredictor;
  PDF.decodeStream = decodeStream;
  PDF.IMAGE_FILTERS = IMAGE_FILTERS;

})(globalThis.PDF || (globalThis.PDF = {}));
