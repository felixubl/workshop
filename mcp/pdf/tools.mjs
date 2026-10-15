/* The PDF toolkit's five tools.

   The engine is a PDF implementation written from scratch — no library parses,
   renders or writes anything — and the one claim in it that a reader cannot
   check by looking is the one worth giving an agent: a blackout here takes the
   words out of the file rather than painting over them. Painting over them is
   what most tools do, it is what every leaked-redaction story is about, and on
   screen the two are the same black bar.

   Which makes verification part of the tool rather than an afterthought. A
   redaction here reports whether the words left the extracted text, whether
   they left the raw bytes, and which runs the rewriter could not read — and it
   names the needles it found nothing for, because "redacted 0 occurrences" and
   "redacted them all" are the same success message otherwise, and only one of
   them is true. */

import fs from 'node:fs';
import path from 'node:path';

import { PDF, parse } from './engine.mjs';
import { readPage, readAll, findInLines, marksFor } from './text.mjs';
import { writeOut, readIn, sizeOf, openHint, FORMAT_PARAM } from '../lib/files.mjs';

const INFO_KEYS = Object.keys(PDF.metadata.INFO_FIELDS);

const PAGES_PARAM = {
  type: 'string',
  description: 'Which pages, 1-based, in the order written: "1-3,5,8-" and the words "all", "first", ' +
    '"last", "even", "odd". Default is every page.',
};

function openFile(where, what) {
  const { file, bytes } = readIn(where, what || 'PDF');
  return { file, doc: parse(bytes, file), bytes };
}

function pickPages(doc, spec) {
  if (spec === undefined || spec === null || spec === '' || String(spec).trim() === '') {
    return doc.pages.map((_, i) => i);
  }
  const indices = PDF.ops.parseRanges(String(spec), doc.pageCount);
  if (!indices.length) {
    throw new Error('The page range ' + JSON.stringify(spec) + ' selects nothing in a ' +
      doc.pageCount + '-page file. Pages are 1-based: "1-3,5" or "all".');
  }
  return indices;
}

function pageSize(page) {
  const box = page.mediaBox || [0, 0, 612, 792];
  const w = Math.abs(box[2] - box[0]);
  const h = Math.abs(box[3] - box[1]);
  return { w, h, mm: (w * 25.4 / 72).toFixed(0) + '×' + (h * 25.4 / 72).toFixed(0) + ' mm' };
}

function fontsOn(doc, page) {
  const names = [];
  try {
    const fonts = doc.get(page.resources, 'Font');
    if (fonts && fonts.keys) {
      for (const key of fonts.keys()) {
        const dict = doc.resolve(fonts.get(key));
        const base = dict && dict.get ? dict.get('BaseFont') : null;
        names.push(base && base.name ? base.name : String(key));
      }
    }
  } catch { /* a resource dictionary that will not read is reported elsewhere */ }
  return [...new Set(names)];
}

function metadataRows(doc) {
  try {
    return PDF.metadata.read(doc) || [];
  } catch {
    return [];
  }
}

function riskOrder(risk) {
  return risk === PDF.metadata.HIGH ? 0 : risk === PDF.metadata.MED ? 1 : 2;
}

/* ── Verification ──────────────────────────────────────────────────────────── */

/* Did the words actually go?

   Two readings, because neither alone is enough. Re-extracting the text is the
   one that matters — it is what a text extractor, a search index or the next
   person to open the file will see. Searching the raw bytes is a second
   opinion in the spirit of `strings`, and it can say "gone" about a word that
   is merely encoded, which is why it is reported beside the first rather than
   instead of it. */
function verify(bytes, needles, options) {
  const doc = parse(bytes, 'the file just written');
  const pages = readAll(doc);
  const text = pages.map((p) => p.text).join('\n');
  const raw = PDF.bytesToLatin1(bytes);

  return {
    unsure: pages.reduce((n, p) => n + p.unsure, 0),
    needles: needles.map((needle) => {
      let inText;
      if (options && options.regex) {
        let re = null;
        try { re = new RegExp(needle, options.caseSensitive ? '' : 'i'); } catch { re = null; }
        inText = re ? re.test(text) : false;
      } else if (options && options.caseSensitive) {
        inText = text.includes(needle);
      } else {
        inText = text.toLowerCase().includes(needle.toLowerCase());
      }
      return { needle, inText, inBytes: raw.includes(needle) };
    }),
  };
}

/* ── The tools ─────────────────────────────────────────────────────────────── */

export const tools = [
  {
    name: 'pdf_inspect_file',
    description:
      'What is in a PDF: how many pages and what size they are, how much text each one carries, the fonts ' +
      'they use, and every metadata field the file discloses about whoever made it — title, author, the ' +
      'program and version, the timestamps — each rated for what it gives away. Read-only; nothing is ' +
      'written. Start here before reading, redacting or rearranging.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The PDF to inspect.' },
        response_format: FORMAT_PARAM,
      },
      required: ['path'],
    },
    run: (args) => {
      const { file, doc, bytes } = openFile(args.path);
      const meta = metadataRows(doc).filter((row) => !row.blank);

      const pages = doc.pages.map((page, i) => {
        const size = pageSize(page);
        let glyphs = 0;
        let unsure = 0;
        try {
          const read = readPage(doc, page);
          glyphs = read.glyphCount;
          unsure = read.unsure;
        } catch { glyphs = -1; }
        return {
          page: i + 1,
          width: size.w, height: size.h, size: size.mm,
          rotate: page.rotate || 0,
          glyphs, unsure,
          fonts: fontsOn(doc, page),
        };
      });

      const result = {
        file, bytes: bytes.length, version: doc.version || null,
        pageCount: doc.pageCount, pages, metadata: meta,
      };
      if (args.response_format === 'json') return { text: JSON.stringify(result, null, 2) };

      const out = ['**' + path.basename(file) + '** — ' + sizeOf(file) + ', ' +
        doc.pageCount + (doc.pageCount === 1 ? ' page' : ' pages') +
        (doc.version ? ', PDF ' + doc.version : '') + '.', '', '## Pages'];
      for (const p of pages) {
        out.push('- **' + p.page + '** — ' + p.size + ' (' + p.width.toFixed(0) + '×' +
          p.height.toFixed(0) + ' pt)' + (p.rotate ? ', rotated ' + p.rotate + '°' : '') + ', ' +
          (p.glyphs < 0 ? 'text could not be read'
            : p.glyphs === 0 ? 'no text (an image-only page, or a scan)'
            : p.glyphs + ' characters') +
          (p.fonts.length ? ', ' + p.fonts.join(', ') : ''));
        if (p.unsure) {
          out.push('    - ' + p.unsure + ' run(s) on this page could not be read, so they may hold text ' +
            'this tool cannot see or remove.');
        }
      }

      if (!meta.length) {
        out.push('', '## Metadata', 'None — the file discloses nothing about who made it.');
      } else {
        const sorted = meta.slice().sort((a, b) => riskOrder(a.risk) - riskOrder(b.risk));
        out.push('', '## Metadata', 'Cut any of these with `pdf_edit_metadata`.');
        for (const row of sorted) {
          const mark = row.risk === PDF.metadata.HIGH ? '**discloses a lot**'
            : row.risk === PDF.metadata.MED ? 'discloses something' : 'harmless';
          out.push('- `' + row.key.replace(/^\//, '') + '` (' + row.label + '): ' +
            JSON.stringify(String(row.value).slice(0, 120)) + ' — ' + mark +
            (row.note ? ', ' + row.note.toLowerCase() : '') +
            (row.removable ? '' : ' — cannot be removed'));
        }
      }
      return { text: out.join('\n') };
    },
  },

  {
    name: 'pdf_read_text',
    description:
      'Read the text off a PDF, line by line, with the position of each line on the page if asked. Positions ' +
      'are in PDF points with the origin at the bottom left. Use this to see what a file says before ' +
      'redacting it, and to check the result afterwards. A page that comes back with no text is an image or ' +
      'a scan: there is nothing in the file to read or to remove.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The PDF to read.' },
        pages: PAGES_PARAM,
        positions: { type: 'boolean', default: false, description: 'Include each line\'s box. Only needed for working out a rectangle by hand — pdf_redact_text finds its own boxes from the text.' },
        response_format: FORMAT_PARAM,
      },
      required: ['path'],
    },
    run: (args) => {
      const { file, doc } = openFile(args.path);
      const wanted = pickPages(doc, args.pages);

      const read = wanted.map((i) => ({ page: i + 1, ...readPage(doc, doc.pages[i]) }));

      if (args.response_format === 'json') {
        return { text: JSON.stringify({
          file,
          pages: read.map((p) => ({
            page: p.page, unsure: p.unsure,
            lines: p.lines.map((l) => (args.positions
              ? { text: l.text, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, upright: l.upright }
              : l.text)),
          })),
        }, null, 2) };
      }

      const out = ['**' + path.basename(file) + '**, ' +
        (wanted.length === doc.pageCount ? 'all ' + doc.pageCount + ' pages' : wanted.length + ' of ' + doc.pageCount + ' pages') + '.'];
      for (const p of read) {
        out.push('', '## Page ' + p.page + (p.lines.length ? '' : ' — no text'));
        if (p.unsure) {
          out.push('_' + p.unsure + ' run(s) here could not be read; they may hold text not shown._');
        }
        if (!p.lines.length) {
          out.push('Nothing to read: an image-only page or a scan. There is no text in the file to remove.');
          continue;
        }
        for (const l of p.lines) {
          out.push(args.positions
            ? '- `' + [l.x0, l.y0, l.x1, l.y1].map((n) => n.toFixed(1)).join(' ') + '` ' + l.text
            : l.text);
        }
      }
      return { text: out.join('\n') };
    },
  },

  {
    name: 'pdf_redact_text',
    description:
      'Remove words from a PDF so they leave the file, and write the result to a new one. This is not a black ' +
      'rectangle drawn over them: the page\'s own instructions are rewritten with everything under the ' +
      'blackout taken out — the glyphs, any image lying wholly inside it, any drawing that does — so a text ' +
      'extractor afterwards has nothing to hand back. Give it the words to remove and it finds where they ' +
      'are itself. It then checks its own work, reporting whether each one left the extracted text and the ' +
      'raw bytes, and naming any it could not find in the first place. The original file is never modified.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The PDF to read. It is not modified.' },
        out: { type: 'string', description: 'Where to write the redacted copy. ".pdf" is added if missing.' },
        text: {
          type: 'array', items: { type: 'string' },
          description: 'The words or phrases to remove, matched per line of the page. Case-insensitive ' +
            'unless caseSensitive is set. A phrase that wraps onto a second line will not match — it is in ' +
            'two places on the page — and is reported as not found rather than guessed at.',
        },
        regex: { type: 'boolean', default: false, description: 'Treat each entry in "text" as a JavaScript regular expression, for things like dates, card numbers or any email address.' },
        caseSensitive: { type: 'boolean', default: false },
        rects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              page: { type: 'integer', description: '1-based.' },
              x: { type: 'number' }, y: { type: 'number' },
              w: { type: 'number' }, h: { type: 'number' },
            },
            required: ['page', 'x', 'y', 'w', 'h'],
          },
          description: 'Instead of or as well as "text": explicit rectangles in PDF points, origin bottom ' +
            'left. Use for a wrapped phrase, an image or a signature. A glyph is removed once about a third ' +
            'of it is covered, so cover a little more than you need.',
        },
        pages: PAGES_PARAM,
        response_format: FORMAT_PARAM,
      },
      required: ['path', 'out'],
    },
    run: (args) => {
      const needles = Array.isArray(args.text) ? args.text.filter((s) => typeof s === 'string' && s.length) : [];
      const rects = Array.isArray(args.rects) ? args.rects : [];
      if (!needles.length && !rects.length) {
        throw new Error('Nothing to remove. Pass "text" (words to find and remove) or "rects" ' +
          '(explicit rectangles). pdf_read_text shows what the file says.');
      }

      const { file, doc } = openFile(args.path);
      const wanted = pickPages(doc, args.pages);
      const options = { regex: args.regex, caseSensitive: args.caseSensitive };

      /* Marks per page: whatever the text search found, plus whatever was
         given by hand. */
      const perPage = new Map(wanted.map((i) => [i, []]));
      const matches = [];

      for (const i of wanted) {
        const read = readPage(doc, doc.pages[i]);
        const hits = needles.length ? findInLines(read.lines, needles, options) : [];
        for (const hit of hits) matches.push({ page: i + 1, ...hit });
        perPage.get(i).push(...marksFor(hits));
      }

      for (const r of rects) {
        const index = Number(r.page) - 1;
        if (!perPage.has(index)) {
          throw new Error('A rectangle names page ' + r.page + ', which is not in the pages being ' +
            'redacted (' + wanted.map((i) => i + 1).join(',') + ').');
        }
        if (!(r.w > 0) || !(r.h > 0)) {
          throw new Error('A rectangle on page ' + r.page + ' has no area (w ' + r.w + ', h ' + r.h + ').');
        }
        perPage.get(index).push({ kind: 'censor', x: r.x, y: r.y, w: r.w, h: r.h });
      }

      const total = [...perPage.values()].reduce((n, m) => n + m.length, 0);
      const missing = needles.filter((n) => !matches.some((m) => m.needle === n));

      if (!total) {
        return {
          isError: true,
          text: 'Nothing was removed and nothing was written: none of ' +
            needles.map((n) => JSON.stringify(n)).join(', ') + ' was found on ' +
            (wanted.length === doc.pageCount ? 'any page' : 'the pages searched') + ' of ' + file +
            '.\n\nRead the file with pdf_read_text first — the words may be spelled differently, ' +
            'split across lines, or not in the file at all (an image-only page or a scan has no text ' +
            'to remove, and this tool cannot take anything out of a picture).',
        };
      }

      /* Every page the output should carry, redacted or not: a redaction must
         not also be a page deletion. */
      const report = {};
      const entries = doc.pages.map((page, i) => ({
        doc, pageIndex: i, rotate: page.rotate,
        marks: perPage.get(i) || [],
      }));
      const bytes = PDF.ops.assemble(entries, { report });
      const written = writeOut(args.out, Buffer.from(bytes), '.pdf');

      const check = verify(bytes, needles, options);
      const stillThere = check.needles.filter((n) => n.inText);
      const encoded = check.needles.filter((n) => !n.inText && n.inBytes);
      const rotated = matches.filter((m) => !m.upright);

      if (args.response_format === 'json') {
        return { text: JSON.stringify({
          source: file, out: written, removed: report.censored, matches, missing,
          verification: check, unreadableRuns: report.unsure,
        }, null, 2) };
      }

      const out = [
        'Wrote **' + written + '** — ' + sizeOf(written) + ', ' + doc.pageCount +
          (doc.pageCount === 1 ? ' page' : ' pages') + ', ' + report.censored +
          ' blackout' + (report.censored === 1 ? '' : 's') + '. The original is untouched.',
        'Open it with `' + openHint(written) + '`.',
        '',
        '## What went',
      ];
      const byNeedle = new Map();
      for (const m of matches) {
        if (!byNeedle.has(m.needle)) byNeedle.set(m.needle, []);
        byNeedle.get(m.needle).push(m);
      }
      for (const [needle, hits] of byNeedle) {
        out.push('- ' + JSON.stringify(needle) + ' — ' + hits.length +
          (hits.length === 1 ? ' occurrence' : ' occurrences') + ' on page' +
          (new Set(hits.map((h) => h.page)).size === 1 ? ' ' : 's ') +
          [...new Set(hits.map((h) => h.page))].join(', ') + '.');
      }
      if (rects.length) out.push('- ' + rects.length + ' rectangle(s) given by hand.');

      out.push('', '## Checked');
      if (!needles.length) {
        out.push('- No words were searched for, so there is nothing to verify by text. Read the result ' +
          'with pdf_read_text to see what the rectangles took.');
      } else if (!stillThere.length) {
        out.push('- Every word searched for is gone from the text of the written file.');
        if (encoded.length) {
          out.push('- ' + encoded.map((n) => JSON.stringify(n.needle)).join(', ') +
            ' still appear(s) in the raw bytes while being absent from the text. That is usually a font ' +
            'name, a metadata field or an annotation rather than page content — check pdf_inspect_file, ' +
            'and cut metadata with pdf_edit_metadata.');
        } else {
          out.push('- And gone from the raw bytes, the way `strings` would read them.');
        }
      } else {
        out.push('- **' + stillThere.map((n) => JSON.stringify(n.needle)).join(', ') +
          ' is still in the text of the written file.** Some occurrences were outside the pages searched, ' +
          'or wrapped across lines. Read it with pdf_read_text and redact the rest, by rectangle if need be.');
      }

      if (missing.length) {
        out.push('', '## Not found at all',
          '- ' + missing.map((n) => JSON.stringify(n)).join(', ') +
          ' matched nothing, so nothing was removed for ' + (missing.length === 1 ? 'it' : 'them') + '.');
      }
      if (report.unsure) {
        out.push('', '## Could not be read',
          '- ' + report.unsure + ' run(s) of page instructions could not be interpreted, so anything ' +
          'they draw was left alone and may still hold text. Check the result before sending it.');
      }
      if (rotated.length) {
        out.push('', '## Worth a look',
          '- ' + rotated.length + ' match(es) are on rotated text. The blackout is the upright box around ' +
          'the run, which covers more of the page than the words do, so check nothing next to them went too.');
      }
      return { text: out.join('\n') };
    },
  },

  {
    name: 'pdf_edit_metadata',
    description:
      'Cut or change the metadata a PDF carries about whoever made it — title, author, subject, keywords, the ' +
      'program and version that wrote it, the timestamps — and write the result to a new file. The XMP packet ' +
      'beside the document, which repeats the same names in XML and is the half nobody sees, does not survive ' +
      'the rewrite either. Use pdf_inspect_file first to see what is there and what each field discloses. ' +
      'The original file is never modified.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The PDF to read. It is not modified.' },
        out: { type: 'string', description: 'Where to write the result. ".pdf" is added if missing.' },
        cut: {
          type: 'array', items: { type: 'string' },
          description: 'Field names to remove: ' + INFO_KEYS.join(', ') + '. Or the single entry "all" ' +
            'for every one of them.',
        },
        set: {
          type: 'object',
          description: 'Field names to set to a given value, e.g. { "Title": "Report", "Author": "" }. ' +
            'Applied after "cut".',
        },
        dropPageMeta: { type: 'boolean', default: true, description: 'Also drop per-page metadata and the application-private PieceInfo blocks.' },
        dropAnnotAuthors: { type: 'boolean', default: true, description: 'Also drop the author names recorded on comments and annotations.' },
        response_format: FORMAT_PARAM,
      },
      required: ['path', 'out'],
    },
    run: (args) => {
      const { file, doc } = openFile(args.path);
      const before = metadataRows(doc).filter((r) => !r.blank);

      const asked = Array.isArray(args.cut) ? args.cut : [];
      const cut = asked.length === 1 && String(asked[0]).toLowerCase() === 'all'
        ? INFO_KEYS.slice()
        : asked.map(String);

      const unknown = cut.filter((k) => !INFO_KEYS.includes(k));
      if (unknown.length) {
        throw new Error('No metadata field called ' + unknown.map((k) => JSON.stringify(k)).join(', ') +
          '. The fields are: ' + INFO_KEYS.join(', ') + '. Or pass ["all"].');
      }

      const set = args.set && typeof args.set === 'object' ? args.set : {};
      const unknownSet = Object.keys(set).filter((k) => !INFO_KEYS.includes(k));
      if (unknownSet.length) {
        throw new Error('Cannot set ' + unknownSet.map((k) => JSON.stringify(k)).join(', ') +
          '; the fields are: ' + INFO_KEYS.join(', ') + '.');
      }
      if (!cut.length && !Object.keys(set).length) {
        throw new Error('Nothing to do: pass "cut" (field names, or ["all"]) or "set". ' +
          'pdf_inspect_file lists what this file carries.');
      }

      /* One entry per field, as the engine expects: null cuts, a string sets.
         An empty object is "no instruction" rather than "cut everything",
         which is why the fields are listed out. */
      const info = {};
      for (const key of cut) info[key] = null;
      for (const [key, value] of Object.entries(set)) {
        info[key] = value === null || value === '' ? null : String(value);
      }

      const report = {};
      const bytes = PDF.ops.assemble(
        doc.pages.map((page, i) => ({ doc, pageIndex: i, rotate: page.rotate, marks: [] })),
        {
          report, info,
          dropPageMeta: args.dropPageMeta !== false,
          dropAnnotAuthors: args.dropAnnotAuthors !== false,
        });
      const written = writeOut(args.out, Buffer.from(bytes), '.pdf');
      const after = metadataRows(parse(bytes, 'the file just written')).filter((r) => !r.blank);

      /* Whether the old values are still findable in the bytes, which is the
         question somebody cutting metadata is actually asking. */
      const raw = PDF.bytesToLatin1(bytes);
      const lingering = before
        .filter((row) => cut.includes(row.key.replace(/^\//, '')) || row.key.replace(/^\//, '') in set)
        .filter((row) => row.value && String(row.value).length > 2 && raw.includes(String(row.value)));

      if (args.response_format === 'json') {
        return { text: JSON.stringify({ source: file, out: written, before, after, lingering }, null, 2) };
      }

      const name = (row) => row.key.replace(/^\//, '');
      const kept = after.map(name);
      const out = [
        'Wrote **' + written + '** — ' + sizeOf(written) + '. The original is untouched.',
        '',
        '## Before', ...before.map((r) => '- `' + name(r) + '`: ' + JSON.stringify(String(r.value).slice(0, 100))),
        '',
        '## After',
      ];
      out.push(...(after.length
        ? after.map((r) => '- `' + name(r) + '`: ' + JSON.stringify(String(r.value).slice(0, 100)))
        : ['Nothing — the file no longer says who made it.']));

      const gone = before.map(name).filter((n) => !kept.includes(n));
      if (gone.length) out.push('', 'Gone: ' + gone.map((n) => '`' + n + '`').join(', ') + '.');
      if (kept.includes('Producer') || kept.includes('ModDate')) {
        out.push('', 'Note that a rewritten file is stamped by whatever wrote it, so `Producer` and ' +
          '`ModDate` come back unless they are in "cut" — they are above because they were cut and reset, ' +
          'or not cut at all.');
      }
      if (lingering.length) {
        out.push('', '## Still in the bytes',
          ...lingering.map((r) => '- ' + JSON.stringify(String(r.value).slice(0, 60)) + ' (was `' +
            name(r) + '`) still appears in the file, so it survives somewhere else — an annotation, an ' +
            'embedded file, or the page text itself. Check with pdf_read_text.'));
      }
      return { text: out.join('\n') };
    },
  },

  {
    name: 'pdf_rearrange_pages',
    description:
      'Merge, split, extract, reorder, delete and rotate the pages of one or more PDFs into a new file. Pages ' +
      'are named 1-based and taken in the order written, so "3,1,2" reorders and "2-" deletes the first page. ' +
      'Several input files are joined end to end. The originals are never modified.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array', items: { type: 'string' }, minItems: 1,
          description: 'One PDF, or several to join end to end in this order.',
        },
        out: { type: 'string', description: 'Where to write the result. ".pdf" is added if missing. With splitEvery, a number is added before the extension.' },
        pages: {
          type: 'string',
          description: 'Which pages of the joined sequence to keep, 1-based, in the order written: ' +
            '"1-3,5,8-", "3,1,2" to reorder, "2-" to drop the first, and the words "all", "first", "last", ' +
            '"even", "odd". Default all.',
        },
        rotate: { type: 'integer', enum: [0, 90, 180, 270, -90], default: 0, description: 'Turn the kept pages by this much, on top of any rotation they already carry.' },
        splitEvery: { type: 'integer', minimum: 1, description: 'Instead of one file, write a file every this many pages.' },
        response_format: FORMAT_PARAM,
      },
      required: ['paths', 'out'],
    },
    run: (args) => {
      const paths = Array.isArray(args.paths) ? args.paths : [args.paths];
      if (!paths.length) throw new Error('Pass at least one path in "paths".');

      const sources = paths.map((p) => openFile(p));

      /* The joined sequence, so a page range spans the inputs the way the
         numbering in the description says it does. */
      const joined = [];
      for (const s of sources) {
        for (let i = 0; i < s.doc.pageCount; i++) joined.push({ doc: s.doc, pageIndex: i, from: s.file });
      }

      const indices = args.pages && String(args.pages).trim()
        ? PDF.ops.parseRanges(String(args.pages), joined.length)
        : joined.map((_, i) => i);
      if (!indices.length) {
        throw new Error('The page range ' + JSON.stringify(args.pages) + ' selects nothing from ' +
          joined.length + ' page(s). Pages are 1-based.');
      }

      const turn = Number(args.rotate) || 0;
      const chosen = indices.map((i) => ({
        doc: joined[i].doc,
        pageIndex: joined[i].pageIndex,
        rotate: turn || undefined,
      }));

      const every = args.splitEvery;
      const written = [];

      if (every && every > 0) {
        const base = String(args.out).replace(/\.pdf$/i, '');
        for (let at = 0; at < chosen.length; at += every) {
          const report = {};
          const slice = chosen.slice(at, at + every);
          const bytes = PDF.ops.assemble(slice, { report, rotateIsDelta: true });
          const part = Math.floor(at / every) + 1;
          written.push({
            file: writeOut(base + '-' + part + '.pdf', Buffer.from(bytes), '.pdf'),
            pages: slice.length,
          });
        }
      } else {
        const report = {};
        const bytes = PDF.ops.assemble(chosen, { report, rotateIsDelta: true });
        written.push({ file: writeOut(args.out, Buffer.from(bytes), '.pdf'), pages: chosen.length });
      }

      if (args.response_format === 'json') {
        return { text: JSON.stringify({
          sources: sources.map((s) => ({ file: s.file, pages: s.doc.pageCount })),
          joined: joined.length, kept: indices.map((i) => i + 1), rotate: turn, written,
        }, null, 2) };
      }

      const out = [];
      if (written.length === 1) {
        out.push('Wrote **' + written[0].file + '** — ' + written[0].pages +
          (written[0].pages === 1 ? ' page' : ' pages') + ', ' + sizeOf(written[0].file) + '.');
      } else {
        out.push('Wrote ' + written.length + ' files, ' + every + ' page(s) each:');
        for (const w of written) out.push('- ' + w.file + ' — ' + w.pages + ' page(s), ' + sizeOf(w.file));
      }
      out.push('', 'From ' + (sources.length === 1
        ? path.basename(sources[0].file) + ' (' + sources[0].doc.pageCount + ' pages)'
        : sources.length + ' files joined: ' + sources.map((s) => path.basename(s.file) + ' (' + s.doc.pageCount + ')').join(', ')) +
        '. Kept page' + (indices.length === 1 ? ' ' : 's ') + indices.map((i) => i + 1).join(', ') +
        (turn ? ', turned ' + turn + '°' : '') + '. The originals are untouched.');
      if (indices.length < joined.length) {
        out.push('', (joined.length - indices.length) + ' page(s) were left out.');
      }
      out.push('', 'Open it with `' + openHint(written[0].file) + '`.');
      return { text: out.join('\n') };
    },
  },
];
