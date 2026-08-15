/* PDF Toolkit: the proof.

   The tool makes one claim a reader cannot check by looking: that a blackout
   takes the words out of the file rather than painting over them. Painting
   over them is what most tools do and what every leaked-redaction story is
   about, and the difference is invisible on screen — both look like a black
   bar. So it is asserted here, against the bytes of a saved file.

   The check that matters most is not "is the text gone from the page" but "is
   the text gone from the FILE". Those came apart once: the page's instructions
   were rewritten correctly and /Contents pointed at the rewrite, while the
   original stream stayed in the file as an object nothing referred to. The
   page looked right, the words were still there, and `strings` found them.
   Assertion 3 is that bug, pinned.

   Runs in the browser through tools/verify/pdf-toolkit.html and under node
   with `node pdf-toolkit/selftest.js`, off one set of assertions. */

var PDFTest = (function (PDF) {
  'use strict';

  /* A small PDF with known words in known places, written by hand so the test
     depends on nothing it is testing. Four lines at 18pt, baselines 40 apart,
     the left edge at x=72. */
  function probe() {
    var objs = [];
    function add(s) { objs.push(s); return objs.length; }

    var font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    var text =
      'BT /F1 18 Tf 72 700 Td (PUBLICHEADING) Tj ET\n' +
      'BT /F1 18 Tf 72 660 Td (SECRETWORD) Tj ET\n' +
      'BT /F1 18 Tf 72 620 Td (HIGHLIGHTME) Tj ET\n' +
      'BT /F1 18 Tf 72 580 Td (TAILTEXT) Tj ET';
    var cont = add('<< /Length ' + text.length + ' >>\nstream\n' + text + '\nendstream');
    var page = add('<< /Type /Page /Parent 5 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 ' + font + ' 0 R >> >> /Contents ' + cont + ' 0 R >>');
    var pages = add('<< /Type /Pages /Kids [' + page + ' 0 R] /Count 1 >>');
    var info = add('<< /Title (QuarterlySecrets) /Author (JaneWhistleblower) ' +
      '/Creator (SecretWriter) /Producer (SecretWriter) >>');
    var cat = add('<< /Type /Catalog /Pages ' + pages + ' 0 R >>');

    var out = '%PDF-1.4\n', offs = [];
    for (var i = 0; i < objs.length; i++) {
      offs.push(out.length);
      out += (i + 1) + ' 0 obj\n' + objs[i] + '\nendobj\n';
    }
    var xref = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    for (var j = 0; j < offs.length; j++) {
      var pad = String(offs[j]);
      while (pad.length < 10) pad = '0' + pad;
      out += pad + ' 00000 n \n';
    }
    out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + cat + ' 0 R /Info ' +
      info + ' 0 R /ID [<AABB> <AABB>] >>\nstartxref\n' + xref + '\n%%EOF\n';
    return PDF.latin1ToBytes(out);
  }

  function load() {
    var doc = new PDF.PDFDocument(probe());
    doc.parse();
    return doc;
  }

  /* The saved file as a latin1 string, so a word can be looked for in it the
     way a text extractor or `strings` would look. */
  function save(marks, opts) {
    var doc = load();
    var bytes = PDF.ops.assemble(
      [{ doc: doc, pageIndex: 0, rotate: doc.pages[0].rotate, marks: marks || [] }],
      opts || {});
    return PDF.bytesToLatin1(bytes);
  }

  /* Every `N 0 obj ... stream` in a file, however it is referred to — which is
     the point: an orphan is still an object and still carries its bytes. */
  function streams(file) {
    var re = /\d+ 0 obj\s*<<[\s\S]*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
    var out = [], m;
    while ((m = re.exec(file))) out.push(m[1]);
    return out;
  }

  /* The blackout covers the SECRETWORD line and nothing else: the baseline is
     at 660, a glyph box runs about 656 to 676, and the neighbouring lines are
     40 away in each direction. */
  var CENSOR = { kind: 'censor', x: 66, y: 650, w: 200, h: 32 };
  var HIGHLIGHT = { kind: 'highlight', tone: 'mint', x: 66, y: 610, w: 200, h: 32 };

  function run(report) {
    var results = [];
    function ok(name, pass, detail) {
      results.push({ name: name, pass: !!pass, detail: detail || '' });
      if (report) report(results[results.length - 1]);
    }

    /* ── The claim ──────────────────────────────────────────────────────── */

    var blacked = save([CENSOR]);
    ok('a blackout takes its word out of the saved file',
       blacked.indexOf('SECRETWORD') < 0,
       blacked.indexOf('SECRETWORD') < 0 ? 'not in the bytes anywhere'
                                         : 'STILL IN THE FILE at ' + blacked.indexOf('SECRETWORD'));

    ok('and leaves the rest of the page alone',
       blacked.indexOf('PUBLICHEADING') >= 0 && blacked.indexOf('TAILTEXT') >= 0 &&
       blacked.indexOf('HIGHLIGHTME') >= 0,
       'the three lines it does not cover are all still there');

    /* The regression. A rewrite that leaves the original behind passes the
       first assertion on the page and fails the file, so the count is what is
       asserted: one set of instructions, not two. */
    var kept = streams(blacked);
    ok('the original instructions are not left in the file as an orphan',
       kept.length === 1,
       kept.length + ' content stream' + (kept.length === 1 ? '' : 's') +
       (kept.length > 1 ? ' — one of them is the page before it was redacted' : ''));

    /* ── A highlight is not a blackout ──────────────────────────────────── */

    var lit = save([HIGHLIGHT]);
    ok('a highlight leaves the words under it in the file',
       lit.indexOf('HIGHLIGHTME') >= 0,
       'a highlighter marks text, it does not remove it');

    ok('a highlight is written to multiply, so the words read through it',
       lit.indexOf('/Multiply') >= 0,
       lit.indexOf('/Multiply') >= 0 ? 'the ExtGState carries /BM /Multiply'
                                     : 'no /Multiply in the file');

    /* Both at once, which is the ordinary case: one comes out, one does not. */
    var both = save([CENSOR, HIGHLIGHT]);
    ok('a page can carry both, and only the blackout removes anything',
       both.indexOf('SECRETWORD') < 0 && both.indexOf('HIGHLIGHTME') >= 0 &&
       streams(both).length === 1,
       'secret gone, highlighted word kept, ' + streams(both).length + ' content stream');

    /* ── Metadata ───────────────────────────────────────────────────────── */

    /* The shape the panel speaks in: a value for every field it was told to
       keep, a null for every one it was told to cut. An empty object is not
       "cut everything", it is "no instruction", which is why the panel sends
       one entry per switch rather than a summary. */
    var stripped = save([], {
      info: { Title: null, Author: null, Subject: null, Keywords: null,
              Creator: null, Producer: null, CreationDate: null, ModDate: null },
      dropPageMeta: true, dropAnnotAuthors: true,
    });
    ok('cutting the metadata takes the author and title out of the bytes',
       stripped.indexOf('JaneWhistleblower') < 0 && stripped.indexOf('QuarterlySecrets') < 0,
       'author ' + (stripped.indexOf('JaneWhistleblower') < 0 ? 'gone' : 'PRESENT') +
       ', title ' + (stripped.indexOf('QuarterlySecrets') < 0 ? 'gone' : 'PRESENT'));

    ok('and the metadata reader finds those fields in the first place',
       (function () {
         var rows = PDF.metadata.read(load());
         var all = JSON.stringify(rows);
         return all.indexOf('JaneWhistleblower') >= 0 && all.indexOf('QuarterlySecrets') >= 0;
       })(),
       'a panel that showed nothing would pass the cut test for the wrong reason');

    /* ── The renderer's side of the same claim ──────────────────────────── */

    /* Writing /BM /Multiply is only half of it. A renderer that reads the file
       and drops the blend paints the pastel as opaque paint, over exactly the
       words the pen was meant to leave readable — which is what this tool's
       own renderer did until it was taught the modes. */
    var modes = PDF.BLEND_MODES || {};
    ok('the renderer knows the blend a highlight is written in',
       modes.Multiply === 'multiply',
       'Multiply -> ' + JSON.stringify(modes.Multiply));

    ok('and knows the rest of the separable modes, without inventing the two that mean “no blend”',
       modes.Screen === 'screen' && modes.Darken === 'darken' &&
       modes.ColorDodge === 'color-dodge' && modes.Luminosity === 'luminosity' &&
       modes.Normal === undefined && modes.Compatible === undefined,
       Object.keys(modes).length + ' modes, Normal and Compatible left to fall through');

    return results;
  }

  return { run: run, probe: probe, save: save, streams: streams };
})(globalThis.PDF);

if (typeof module !== 'undefined' && module.exports) module.exports = PDFTest;
