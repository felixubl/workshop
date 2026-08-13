// Page operations. Merging, splitting, extracting, deleting, reordering and
// rotating are one operation: each produces an ordered list of "take page P
// from document D, rotated by R degrees". Everything below builds such a list
// and passes it to assemble().

;(function (PDF) {
  'use strict';

  const { Name, Ref, Dict, PDFStream, PDFBuilder } = PDF;

  // Never followed when copying a page: /Parent belongs to the source page
  // tree, and following it would drag every other page in that file across.
  const PAGE_SKIP = new Set(['Parent']);

  const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

  function normaliseAngle(deg) {
    let r = Math.round((deg || 0) / 90) * 90 % 360;
    if (r < 0) r += 360;
    return r;
  }

  // entries: [{ doc, pageIndex, rotate }]  rotate is an absolute angle unless
  // `rotateIsDelta` is set, in which case it is added to the page's own.
  function assemble(entries, options) {
    const opts = options || {};
    const builder = new PDFBuilder({ version: opts.version || '1.7' });

    const catalogRef = builder.reserve();
    const pagesRef = builder.reserve();
    const kids = [];

    for (const entry of entries) {
      const doc = entry.doc;
      const page = doc.pages[entry.pageIndex];
      if (!page) continue;

      const pageRef = builder.reserve();
      // Seeding the memo before copying means anything in the source that
      // points back at this page (an annotation's /P, a link destination)
      // lands on the new page rather than copying a second one.
      if (page.ref) builder.memoFor(doc).set(page.ref.num, pageRef);

      const dict = builder.copyDict(doc, page.dict, PAGE_SKIP, 0);

      // Attributes the page inherited now have to be written onto it, because
      // its new parent knows nothing about the old tree.
      for (const key of INHERITABLE) {
        if (dict.has(key)) continue;
        const source = page.dict.has(key) ? page.dict.get(key) : page.inherited[key];
        if (source === undefined) continue;
        dict.set(key, builder.copy(doc, source, PAGE_SKIP, 0));
      }

      dict.set('Type', Name.get('Page'));
      dict.set('Parent', pagesRef);

      const base = page.rotate;
      const applied = entry.rotate === undefined || entry.rotate === null
        ? base
        : normaliseAngle(opts.rotateIsDelta ? base + entry.rotate : entry.rotate);
      if (applied === 0) dict.delete('Rotate');
      else dict.set('Rotate', applied);

      // A page with no /MediaBox is legal only while it can inherit one.
      if (!dict.has('MediaBox')) dict.set('MediaBox', page.mediaBox.slice());

      builder.assign(pageRef, dict);
      kids.push(pageRef);
    }

    const pages = new Dict()
      .set('Type', Name.get('Pages'))
      .set('Kids', kids)
      .set('Count', kids.length);
    builder.assign(pagesRef, pages);

    const catalog = new Dict()
      .set('Type', Name.get('Catalog'))
      .set('Pages', pagesRef);

    const form = carryAcroForm(builder, entries, opts);
    if (form) catalog.set('AcroForm', form);

    builder.assign(catalogRef, catalog);

    const infoRef = buildInfo(builder, entries, opts);
    const id = PDF.makeFileId();

    return builder.build({ Root: catalogRef, Info: infoRef, ID: id });
  }

  // Interactive form fields live in the catalog, not on the page, so a page
  // taken out of a form document arrives with its widgets but no form. Carry
  // the form across, keeping only the fields whose objects actually came with
  // the pages that were kept.
  function carryAcroForm(builder, entries, opts) {
    if (opts.dropForms) return null;
    const seen = new Set();
    for (const entry of entries) {
      const doc = entry.doc;
      if (seen.has(doc)) continue;
      seen.add(doc);

      const cat = doc.catalog;
      const src = cat ? doc.get(cat, 'AcroForm') : null;
      if (!(src instanceof Dict)) continue;

      const memo = builder.memoFor(doc);
      const fields = doc.resolve(src.get('Fields'));
      const kept = [];
      if (Array.isArray(fields)) {
        for (const f of fields) {
          // Only fields already pulled in by a copied page are meaningful;
          // the rest belong to pages that were dropped.
          if (f instanceof Ref && memo.has(f.num)) kept.push(memo.get(f.num));
        }
      }
      if (!kept.length) continue;

      const out = new Dict();
      for (const key of ['DR', 'DA', 'Q', 'NeedAppearances', 'SigFlags']) {
        if (src.has(key)) out.set(key, builder.copy(doc, src.get(key), PAGE_SKIP, 0));
      }
      out.set('Fields', kept);
      return out;
    }
    return null;
  }

  function buildInfo(builder, entries, opts) {
    const info = new Dict();
    const source = entries.length ? entries[0].doc.info : null;
    if (source && !opts.stripMetadata) {
      for (const key of ['Title', 'Author', 'Subject', 'Keywords']) {
        const v = source.get(key);
        if (typeof v === 'string') info.set(key, v);
      }
      const creator = source.get('Creator');
      if (typeof creator === 'string') info.set('Creator', creator);
    }
    if (opts.info) {
      for (const [k, v] of Object.entries(opts.info)) {
        if (typeof v === 'string' && v.length) info.set(k, v);
        else if (v === null) info.delete(k);
      }
    }
    info.set('Producer', opts.producer || "Felix' Workshop PDF Toolkit");
    info.set('ModDate', PDF.pdfDate());
    if (!info.has('CreationDate')) {
      const created = source ? source.get('CreationDate') : null;
      info.set('CreationDate', typeof created === 'string' ? created : PDF.pdfDate());
    }
    return builder.add(info);
  }

  // --- the operations, all of them shaped as a list of entries --------------

  function allPages(doc, rotate) {
    const out = [];
    for (let i = 0; i < doc.pageCount; i++) out.push({ doc, pageIndex: i, rotate });
    return out;
  }

  function merge(docs, options) {
    const entries = [];
    for (const doc of docs) entries.push(...allPages(doc));
    return assemble(entries, options);
  }

  function extract(doc, indices, options) {
    const entries = indices
      .filter((i) => i >= 0 && i < doc.pageCount)
      .map((i) => ({ doc, pageIndex: i }));
    return assemble(entries, options);
  }

  function remove(doc, indices, options) {
    const drop = new Set(indices);
    const keep = [];
    for (let i = 0; i < doc.pageCount; i++) if (!drop.has(i)) keep.push(i);
    return extract(doc, keep, options);
  }

  // ranges: [[startIndex, endIndexInclusive], ...]
  function split(doc, ranges, options) {
    return ranges.map(([from, to]) => {
      const idx = [];
      for (let i = from; i <= to; i++) idx.push(i);
      return extract(doc, idx, options);
    });
  }

  // Splits into fixed-size chunks; `every` of 1 gives one file per page.
  function splitEvery(doc, every, options) {
    const step = Math.max(1, every | 0);
    const ranges = [];
    for (let i = 0; i < doc.pageCount; i += step) {
      ranges.push([i, Math.min(i + step - 1, doc.pageCount - 1)]);
    }
    return split(doc, ranges, options);
  }

  function rotate(doc, indices, degrees, options) {
    const turn = new Set(indices);
    const entries = [];
    for (let i = 0; i < doc.pageCount; i++) {
      entries.push({ doc, pageIndex: i, rotate: turn.has(i) ? degrees : undefined });
    }
    return assemble(entries, Object.assign({ rotateIsDelta: true }, options));
  }

  function reorder(doc, order, options) {
    return extract(doc, order, options);
  }

  // --- page range parsing ---------------------------------------------------

  // Accepts "1-3, 5, 8-" and "last", "even", "odd". Returns zero-based
  // indices, in the order written, without duplicates.
  function parseRanges(text, pageCount) {
    const out = [];
    const seen = new Set();
    const push = (i) => {
      if (i >= 0 && i < pageCount && !seen.has(i)) { seen.add(i); out.push(i); }
    };
    const source = String(text || '').toLowerCase();

    for (let part of source.split(/[,;]/)) {
      part = part.trim();
      if (!part) continue;

      if (part === 'all') { for (let i = 0; i < pageCount; i++) push(i); continue; }
      if (part === 'even') { for (let i = 1; i < pageCount; i += 2) push(i); continue; }
      if (part === 'odd') { for (let i = 0; i < pageCount; i += 2) push(i); continue; }
      if (part === 'last') { push(pageCount - 1); continue; }

      const m = part.match(/^(\d+|first|last)?\s*(?:-|–|to|–)\s*(\d+|last)?$/);
      if (m) {
        const word = (w, dflt) => {
          if (w === undefined || w === '') return dflt;
          if (w === 'first') return 0;
          if (w === 'last') return pageCount - 1;
          return parseInt(w, 10) - 1;
        };
        let from = word(m[1], 0);
        let to = word(m[2], pageCount - 1);
        if (from > to) { const t = from; from = to; to = t; }
        for (let i = from; i <= to; i++) push(i);
        continue;
      }

      const n = parseInt(part, 10);
      if (Number.isFinite(n)) push(n - 1);
    }
    return out;
  }

  PDF.ops = {
    assemble, merge, extract, remove, split, splitEvery, rotate, reorder,
    allPages, parseRanges, normaliseAngle,
  };

})(globalThis.PDF || (globalThis.PDF = {}));
