// What a PDF says about the person who made it.
//
// Three places keep it. The information dictionary is the old one: eight or so
// named fields, written by whatever produced the file, and the only one most
// people have heard of. The XMP packet is the newer one, an XML block in the
// catalog that usually repeats the first and adds the identifiers that let two
// copies of a document be recognised as the same document. And the pages carry
// their own: private application data, page-level packets, and the names and
// timestamps on every comment anyone left.
//
// This file only reads. What is done with the answer is the panel's business,
// and what the saved file keeps is pdf-ops.js's.

;(function (PDF) {
  'use strict';

  const { Name, Dict, PDFStream } = PDF;

  const HIGH = 'high', MED = 'med', LOW = 'low';

  // key -> [label, risk, note]
  const INFO_FIELDS = {
    Title:        ['Title', MED, 'Often the name of the file it was written from, or of the template.'],
    Author:       ['Author', HIGH, 'A person, or the account the document was written under.'],
    Subject:      ['Subject', MED, 'A description written by hand or by a template.'],
    Keywords:     ['Keywords', MED, 'Written by hand, and sometimes left over from a template.'],
    Creator:      ['Written in', MED, 'The program the document was written in, and its version.'],
    Producer:     ['Written out by', MED, 'The program that produced the PDF, and its version.'],
    CreationDate: ['Created', MED, 'When the document was first written, to the second, with the time zone.'],
    ModDate:      ['Last changed', MED, 'When it was last saved, to the second, with the time zone.'],
    Trapped:      ['Trapped', LOW, 'A printing flag. It says nothing about you.'],
  };

  // The XMP tags worth naming. Everything else in the packet is counted rather
  // than listed, because a packet can carry a hundred of them.
  const XMP_FIELDS = [
    ['dc:title', 'Title', MED],
    ['dc:creator', 'Author', HIGH],
    ['dc:description', 'Description', MED],
    ['dc:rights', 'Rights', MED],
    ['xmp:CreatorTool', 'Written in', MED],
    ['xmp:CreateDate', 'Created', MED],
    ['xmp:ModifyDate', 'Last changed', MED],
    ['xmp:MetadataDate', 'Metadata touched', MED],
    ['pdf:Producer', 'Written out by', MED],
    ['xmpMM:DocumentID', 'Document identifier', HIGH],
    ['xmpMM:InstanceID', 'Save identifier', HIGH],
    ['xmpMM:OriginalDocumentID', 'Original document identifier', HIGH],
    ['photoshop:AuthorsPosition', 'Author position', HIGH],
  ];

  // A path with a home directory in it is a name, whoever wrote the field.
  const PATHY = /(?:[a-z]:\\|\/(?:users|home)\/|\\users\\|\/Volumes\/)/i;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];

  // D:YYYYMMDDHHmmSSOHH'mm'. Anything that does not parse is shown as it was
  // written, because a date this tool cannot read is still evidence.
  function readDate(s) {
    const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(String(s));
    if (!m || !m[1]) return String(s);
    const month = m[2] ? MONTHS[Math.min(11, Math.max(0, +m[2] - 1))] : null;
    let out = m[3] ? +m[3] + ' ' : '';
    if (month) out += month + ' ';
    out += m[1];
    if (m[4]) out += ', ' + m[4] + ':' + (m[5] || '00') + (m[6] ? ':' + m[6] : '');
    if (m[7] === 'Z') out += ' UTC';
    else if (m[7] && m[8]) out += ' UTC' + m[7] + m[8] + (m[9] && m[9] !== '00' ? ':' + m[9] : '');
    return out;
  }

  function isDateKey(key) {
    return key === 'CreationDate' || key === 'ModDate' || /date$/i.test(key);
  }

  function textOf(doc, value) {
    const v = doc.resolve(value);
    if (typeof v === 'string') return PDF.decodeTextString(v);
    if (v instanceof Name) return '/' + v.name;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map((x) => textOf(doc, x)).join(', ');
    if (v instanceof Dict) return '(a dictionary of ' + v.size + ')';
    return '';
  }

  function hex(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) out += (s.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
    return out;
  }

  // --- the information dictionary ---------------------------------------------

  // What the tool puts in these three when they are left ticked, whatever the
  // loaded file had.
  const WRITTEN = {
    Producer: "Felix' Workshop PDF Toolkit",
    ModDate: 'the moment you save',
    CreationDate: 'the date the file already carried, or the moment you save',
  };

  function infoRows(doc) {
    const info = doc.info;
    const rows = [];
    const seen = new Set();

    const add = (key, raw) => {
      if (seen.has(key)) return;
      seen.add(key);
      const spec = INFO_FIELDS[key];
      const here = raw !== undefined;
      const value = here ? (isDateKey(key) ? readDate(textOf(doc, raw)) : textOf(doc, raw)) : '';
      let risk = spec ? spec[1] : MED;
      if (PATHY.test(value)) risk = HIGH;

      let note = spec ? spec[2] : 'A field this file\'s writer invented. Nothing says what is in it.';
      if (WRITTEN[key]) note += ' Kept, the saved file records ' + WRITTEN[key] + '.';

      // A field this tool would not carry across in any case is shown without
      // a switch: there is no decision to offer.
      const carried = typeof raw === 'string' || !!WRITTEN[key];
      rows.push({
        id: 'info:' + key,
        group: 'info',
        key: '/' + key,
        label: spec ? spec[0] : key,
        value: value || (WRITTEN[key] ? '(written when you save)' : ''),
        raw: typeof raw === 'string' && !WRITTEN[key] ? raw : null,
        risk,
        note,
        removable: carried,
        fixedNote: carried ? null : 'dropped',
        blank: !value,
      });
    };

    if (info) {
      for (const [key, raw] of info.entries()) add(key, raw);
    }
    // The three the tool writes itself, whether or not the file had them. They
    // are shown for the same reason the rest are: they end up in the file.
    for (const key of Object.keys(WRITTEN)) add(key, undefined);
    return rows;
  }

  // --- the XMP packet ------------------------------------------------------------

  function xmpText(doc) {
    const cat = doc.catalog;
    const ref = cat ? cat.get('Metadata') : null;
    const stream = doc.resolve(ref);
    if (!(stream instanceof PDFStream)) return null;
    let bytes;
    try { bytes = doc.decodeStreamBytes(stream, ref && ref.num); } catch { return null; }
    if (!bytes || !bytes.length) return null;
    let text;
    try { text = new TextDecoder('utf-8').decode(bytes); }
    catch { text = PDF.bytesToLatin1(bytes); }
    return { text, size: bytes.length };
  }

  function xmpValue(text, tag) {
    const el = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(text);
    if (el) {
      // rdf:Alt and rdf:Bag wrap their values in list items.
      const items = el[1].match(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/gi);
      const body = items
        ? items.map((s) => s.replace(/<[^>]*>/g, '')).join(', ')
        : el[1].replace(/<[^>]*>/g, '');
      const clean = body.replace(/\s+/g, ' ').trim();
      if (clean) return clean;
    }
    // The shorthand form writes them as attributes instead.
    const attr = new RegExp(tag + '\\s*=\\s*"([^"]*)"', 'i').exec(text);
    return attr ? attr[1].trim() : '';
  }

  function xmpRows(doc) {
    const packet = xmpText(doc);
    if (!packet) return [];
    const rows = [];
    for (const [tag, label, risk] of XMP_FIELDS) {
      const value = xmpValue(packet.text, tag);
      if (!value) continue;
      rows.push({
        id: 'xmp:' + tag,
        group: 'attached',
        key: tag,
        label,
        value,
        risk: PATHY.test(value) ? HIGH : risk,
        note: 'From the XMP packet, which this tool never copies into the file it saves.',
        removable: false,
        fixedNote: 'dropped',
      });
    }
    const tags = (packet.text.match(/<[a-z0-9]+:[A-Za-z0-9_.-]+[\s>]/g) || []).length;
    rows.unshift({
      id: 'xmp:packet',
      group: 'attached',
      key: '/Metadata',
      label: 'XMP packet',
      value: Math.round(packet.size / 102.4) / 10 + ' kB of XML, ' + tags + ' tags',
      risk: MED,
      note: 'An XML block in the catalog. It repeats most of the information dictionary and adds the identifiers that tie copies of a document together.',
      removable: false,
      fixedNote: 'dropped',
    });
    return rows;
  }

  // --- the file identifier ---------------------------------------------------------

  function idRow(doc) {
    const id = doc.resolve(doc.trailer.get('ID'));
    if (!Array.isArray(id) || !id.length) return [];
    const first = doc.resolve(id[0]);
    if (typeof first !== 'string') return [];
    return [{
      id: 'file:id',
      group: 'attached',
      key: '/ID',
      label: 'File identifier',
      value: hex(first),
      risk: LOW,
      note: 'Two byte strings a reader uses to tell one file from another. A fresh pair is written every time this tool saves.',
      removable: false,
      fixedNote: 'replaced',
    }];
  }

  // --- what the pages carry ------------------------------------------------------

  function pageRows(doc) {
    const rows = [];
    let withMeta = 0, withPiece = 0;
    const authors = new Set();
    let annots = 0, dated = 0;

    const pages = doc.pages;
    for (const page of pages) {
      if (page.dict.has('Metadata')) withMeta++;
      if (page.dict.has('PieceInfo')) withPiece++;
      if (annots > 4000) continue;
      for (const annot of page.annotations) {
        annots++;
        if (annots > 4000) break;
        const t = doc.resolve(annot.get('T'));
        if (typeof t === 'string' && t) authors.add(PDF.decodeTextString(t));
        if (annot.has('M') || annot.has('CreationDate')) dated++;
      }
    }

    if (withMeta || withPiece) {
      const parts = [];
      if (withMeta) parts.push('an XMP packet on ' + withMeta + (withMeta === 1 ? ' page' : ' pages'));
      if (withPiece) parts.push('private application data on ' + withPiece + (withPiece === 1 ? ' page' : ' pages'));
      rows.push({
        id: 'page:extras',
        group: 'pages',
        key: '/Metadata, /PieceInfo',
        label: 'Attached to the pages',
        value: parts.join(', '),
        risk: MED,
        note: 'What an editor left on the page itself: its own working data, and sometimes a second copy of the document metadata. It travels with the page unless it is dropped here.',
        removable: true,
      });
    }

    if (authors.size || dated) {
      const names = Array.from(authors);
      const shown = names.slice(0, 6).join(', ');
      const value = (names.length ? shown + (names.length > 6 ? ', and ' + (names.length - 6) + ' more' : '') : 'no names') +
                    (dated ? ' · ' + dated + (dated === 1 ? ' timestamp' : ' timestamps') : '');
      rows.push({
        id: 'page:annots',
        group: 'pages',
        key: '/T, /M',
        label: 'Comment authors and dates',
        value,
        risk: authors.size ? HIGH : MED,
        note: 'Every comment, note and stamp carries who wrote it and when. Dropping these leaves the comments themselves in place.',
        removable: true,
      });
    }

    return rows;
  }

  // --- the whole answer -------------------------------------------------------------

  function read(doc) {
    let rows = [];
    try { rows = rows.concat(infoRows(doc)); } catch { /* unreadable dictionary */ }
    try { rows = rows.concat(xmpRows(doc)); } catch { /* unreadable packet */ }
    try { rows = rows.concat(idRow(doc)); } catch { /* no identifier */ }
    try { rows = rows.concat(pageRows(doc)); } catch { /* unreadable pages */ }
    return rows;
  }

  PDF.metadata = { read, readDate, INFO_FIELDS, HIGH, MED, LOW };

})(globalThis.PDF || (globalThis.PDF = {}));
