// Page operations. Merging, splitting, extracting, deleting, reordering and
// rotating are one operation: each produces an ordered list of "take page P
// from document D, rotated by R degrees, marked like so". Everything below
// builds such a list and passes it to assemble().

;(function (PDF) {
  'use strict';

  const { Name, Ref, Dict, PDFStream, PDFBuilder } = PDF;

  // Never followed when copying a page: /Parent belongs to the source page
  // tree, and following it would drag every other page in that file across.
  const PAGE_SKIP = new Set(['Parent']);

  // Author and timestamp on a comment. Dropped by taking the keys out of the
  // copy rather than out of the copied object: an object nothing points at is
  // still written into the file, so anything meant to go has to go before it
  // is copied at all.
  const ANNOT_WHO = ['T', 'M', 'CreationDate'];

  const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

  function normaliseAngle(deg) {
    let r = Math.round((deg || 0) / 90) * 90 % 360;
    if (r < 0) r += 360;
    return r;
  }

  // entries: [{ doc, pageIndex, rotate, marks }]  rotate is an absolute angle
  // unless `rotateIsDelta` is set, in which case it is added to the page's own.
  function assemble(entries, options) {
    const opts = options || {};
    const builder = new PDFBuilder({ version: opts.version || '1.7' });

    const catalogRef = builder.reserve();
    const pagesRef = builder.reserve();
    const kids = [];
    // Filled in as the pages are built, for the caller to say what it did.
    const report = opts.report || {};
    report.censored = report.censored || 0;
    report.highlighted = report.highlighted || 0;
    report.unsure = report.unsure || 0;

    for (const entry of entries) {
      const doc = entry.doc;
      const page = doc.pages[entry.pageIndex];
      if (!page) continue;

      const marks = Array.isArray(entry.marks) ? entry.marks : [];
      const blackouts = PDF.redact.rectsFromMarks(marks);

      const pageRef = builder.reserve();
      // Seeding the memo before copying means anything in the source that
      // points back at this page (an annotation's /P, a link destination)
      // lands on the new page rather than copying a second one.
      if (page.ref) builder.memoFor(doc).set(page.ref.num, pageRef);

      // Anything that must not reach the saved file is cut here rather than
      // deleted afterwards, for the reason given at ANNOT_WHO above.
      const skip = new Set(PAGE_SKIP);
      if (opts.dropPageMeta) { skip.add('Metadata'); skip.add('PieceInfo'); }
      const annots = doc.resolve(page.dict.get('Annots'));
      const sifting = Array.isArray(annots) && (blackouts.length || opts.dropAnnotAuthors);
      if (sifting) skip.add('Annots');
      // And the page's own instructions, when a blackout is going to rewrite
      // them. Copying them first and pointing /Contents at the rewrite
      // afterwards leaves the original stream in the file with nothing
      // referring to it — which hides the text from a reader and from nobody
      // else, since `strings` still finds it. It is the same rule as ANNOT_WHO
      // and it costs nothing here: the rewrite in applyMarks reads the SOURCE
      // page, never the copy, so there is no reason to have copied it.
      if (blackouts.length) skip.add('Contents');

      const dict = builder.copyDict(doc, page.dict, skip, 0);
      if (sifting) {
        const kept = copyAnnots(builder, doc, annots, blackouts, opts.dropAnnotAuthors);
        if (kept.length) dict.set('Annots', kept);
      }

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

      if (marks.length) applyMarks(builder, doc, page, dict, marks, blackouts, report);

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

  // --- marks ----------------------------------------------------------------

  // Writes a page's marks into the page. Two routes, and which one is taken is
  // the difference between the two pens.
  //
  // A highlight is drawn over the page and changes nothing underneath, so the
  // content the document already had is left exactly as it was and the paint
  // is appended as one more stream. A blackout has to remove what it covers,
  // so the content is rewritten (pdf-redact.js) and the paint goes on the end
  // of the rewrite. Either way the appended paint starts from a clean state:
  // the page's own instructions are bracketed so that whatever they left open
  // is closed before the marks are drawn.
  function applyMarks(builder, doc, page, dict, marks, blackouts, report) {
    const marker = PDF.marks;
    const additions = new Map();
    let ops = '';
    let gsName = null;

    if (marks.some((m) => m.kind !== 'censor')) {
      gsName = freshName(builder.value(dict.get('Resources')), 'ExtGState', 'GsHl');
      additions.set(gsName, marker.highlightGState());
    }
    ops = marker.markOps(marks, gsName);

    if (blackouts.length) {
      const plan = PDF.redact.page(doc, page, blackouts, builder);
      const tail = PDF.latin1ToBytes(ops);
      const body = new Uint8Array(plan.bytes.length + tail.length);
      body.set(plan.bytes, 0);
      body.set(tail, plan.bytes.length);
      dict.set('Contents', builder.add(marker.contentStream(body)));
      if (plan.adds.size) {
        dict.set('Resources', PDF.redact.withAdditions(
          builder, dict.get('Resources'), 'XObject', plan.adds));
      }
      report.censored += blackouts.length;
      report.unsure += plan.unsure;
    } else {
      const had = builder.value(dict.get('Contents'));
      const list = Array.isArray(had) ? had.slice()
                 : (dict.get('Contents') === undefined ? [] : [dict.get('Contents')]);
      list.unshift(builder.add(marker.contentStream('q\n')));
      list.push(builder.add(marker.contentStream('Q\n' + ops)));
      dict.set('Contents', list);
    }

    report.highlighted += PDF.marks.count(marks).highlight;

    if (additions.size) {
      dict.set('Resources', PDF.redact.withAdditions(
        builder, dict.get('Resources'), 'ExtGState', additions));
    }
  }

  // A name no entry in that category already uses.
  function freshName(resources, category, stem) {
    const cat = resources instanceof Dict ? resources.get(category) : null;
    const dict = cat instanceof Dict ? cat : null;
    let n = 0;
    for (;;) {
      const name = stem + (++n);
      if (!dict || !dict.has(name)) return name;
    }
  }

  // The page's annotations, minus the ones a blackout covers, and minus the
  // author and timestamp on the rest when that was asked for. A covered
  // annotation is never copied at all: a comment nothing points at would still
  // be in the file, and readable.
  function copyAnnots(builder, doc, annots, blackouts, dropWho) {
    const memo = builder.memoFor(doc);
    const kept = [];

    for (const ref of annots) {
      const annot = doc.resolve(ref);
      if (!(annot instanceof Dict)) continue;
      if (blackouts.length && annotCovered(doc, annot, blackouts)) continue;
      if (!dropWho) { kept.push(builder.copy(doc, ref, PAGE_SKIP, 1)); continue; }

      // Copied a key at a time so the ones being dropped are never followed.
      const out = new Dict();
      const target = ref instanceof Ref ? builder.reserve() : null;
      if (target) memo.set(ref.num, target);
      for (const [k, v] of annot.entries()) {
        if (ANNOT_WHO.includes(k)) continue;
        out.set(k, builder.copy(doc, v, PAGE_SKIP, 1));
      }
      kept.push(target ? builder.assign(target, out) : out);
    }
    return kept;
  }

  // The same rule the ink under a blackout is held to: more than a third of it
  // covered and it goes.
  function annotCovered(doc, annot, rects) {
    const r = doc.resolve(annot.get('Rect'));
    if (!Array.isArray(r) || r.length < 4) return false;
    const v = r.slice(0, 4).map((x) => doc.resolve(x));
    if (!v.every((x) => typeof x === 'number' && isFinite(x))) return false;
    const x0 = Math.min(v[0], v[2]), x1 = Math.max(v[0], v[2]);
    const y0 = Math.min(v[1], v[3]), y1 = Math.max(v[1], v[3]);
    const area = (x1 - x0) * (y1 - y0);
    let hit = 0;
    for (const rect of rects) {
      const ox = Math.min(x1, rect.x1) - Math.max(x0, rect.x0);
      const oy = Math.min(y1, rect.y1) - Math.max(y0, rect.y0);
      if (ox > 0 && oy > 0) hit += ox * oy;
    }
    if (!(area > 0)) return hit > 0 || rects.some((rect) => x0 >= rect.x0 && x1 <= rect.x1 && y0 >= rect.y0 && y1 <= rect.y1);
    return hit / area >= 0.35;
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

  // The saved file's information dictionary. Left to itself it carries the
  // first document's descriptive fields across and stamps the file as this
  // tool's. `opts.info` is the metadata panel talking: a value for every field
  // it offered to keep, a null for every one it was told to remove. A document
  // with nothing left gets no dictionary at all rather than an empty one.
  function buildInfo(builder, entries, opts) {
    const info = new Dict();
    const source = entries.length ? entries[0].doc.info : null;
    const removed = new Set();

    if (source && !opts.stripMetadata) {
      for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator']) {
        const v = source.get(key);
        if (typeof v === 'string') info.set(key, v);
      }
    }
    if (opts.info) {
      for (const [k, v] of Object.entries(opts.info)) {
        if (v === null) { info.delete(k); removed.add(k); }
        else if (typeof v === 'string' && v.length) info.set(k, v);
      }
    }
    if (!removed.has('Producer')) info.set('Producer', opts.producer || "Felix' Workshop PDF Toolkit");
    if (!removed.has('ModDate')) info.set('ModDate', PDF.pdfDate());
    if (!info.has('CreationDate') && !removed.has('CreationDate')) {
      const created = source ? source.get('CreationDate') : null;
      info.set('CreationDate', typeof created === 'string' ? created : PDF.pdfDate());
    }
    return info.size ? builder.add(info) : undefined;
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
