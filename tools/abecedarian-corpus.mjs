#!/usr/bin/env node
/* The dictionary survey behind the histogram at the foot of the Abecedarian
   Distance page. Runs every headword of four spelling dictionaries through the
   same engine the page uses — abecedarian/abc.js, not a copy of it — and writes
   the tallies to abecedarian/data/dictionaries.js.

       tools/abecedarian-corpus.mjs [--refresh]

   Why a build step and not a fetch. The tool is rated `local` on the index: it
   opens no socket. Shipping four word lists to the browser to count them there
   would be four megabytes to answer a question whose answer is sixty numbers,
   and fetching them from somebody else's server would move the tool up a rung
   for a chart. So the counting happens here, once, and the counts are committed
   — the same arrangement as the band crawler in crawl-vis.mjs, which computes
   into eclipse-recon/data/ for the same reason.

   The sources are pinned to one commit of one repository, so the four are
   packaged identically and the run is repeatable. Downloads are cached in
   .dict-cache (git-ignored); --refresh re-fetches. */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ABC = require(path.join(ROOT, 'abecedarian/abc.js'));

/* One repository, one commit, one packaging: wooorm/dictionaries takes the
   upstream Hunspell dictionary of each language and republishes it UTF-8 with
   the same file names. Four lists that were built by four different projects
   are at least *delivered* the same way, which is as close to like-for-like as
   this comparison can honestly get. The upstream projects are credited by name
   on the page; their licences travel with the packages, and nothing of theirs
   is redistributed here — only counts derived from them. */
const PIN = '8cfea406b505e4d7df52d5a19bce525df98c54ab';
const SOURCE = (lang) =>
  `https://raw.githubusercontent.com/wooorm/dictionaries/${PIN}/dictionaries/${lang}/index.dic`;

const LANGS = [
  { id: 'en', name: 'English', dict: 'SCOWL / en_US Hunspell' },
  { id: 'es', name: 'Spanish', dict: 'RLA es_ES Hunspell' },
  { id: 'fr', name: 'French', dict: 'Dicollecte / Grammalecte fr' },
  { id: 'de', name: 'German', dict: 'igerman98 de_DE Hunspell' },
];

const CACHE = path.join(ROOT, '.dict-cache');
const OUT = path.join(ROOT, 'abecedarian/data/dictionaries.js');
const REFRESH = process.argv.includes('--refresh');

async function load(lang) {
  const file = path.join(CACHE, lang + '.dic');
  if (!REFRESH && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  fs.mkdirSync(CACHE, { recursive: true });
  process.stderr.write(`fetching ${lang}… `);
  const res = await fetch(SOURCE(lang));
  if (!res.ok) throw new Error(`${lang}: HTTP ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(file, text);
  process.stderr.write(`${text.length} bytes\n`);
  return text;
}

/* A Hunspell .dic line is a headword, optionally an unescaped slash and the
   affix flags that generate its inflections, optionally a tab and morphological
   fields. The first line is a count, and igerman98 opens with a licence block
   indented with tabs. What is wanted is the headword: the dictionary's entries,
   not every form they generate — those are the words a dictionary prints in
   bold, and asking the same of all four keeps the four comparable. */
function headwords(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s/.test(line)) continue;      // blank, or an indented comment
    if (i === 0 && /^\d+$/.test(line.trim())) continue;   // the entry count
    let word = line.split('\t')[0];
    const slash = word.search(/(^|[^\\])\//);      // an escaped \/ is part of the word
    if (slash >= 0) word = word.slice(0, slash === 0 ? 0 : slash + 1);
    word = word.replace(/\\\//g, '/').trim();
    if (word) out.push(word);
  }
  return out;
}

/* What counts as a word. A-Z after folding, which is what the engine accepts:
   accents fold to the letter underneath (schön -> SCHON) so a German or French
   word spelled as it is spelled still gets an answer, and anything carrying a
   hyphen, apostrophe, digit or space is dropped rather than silently mended —
   the same rule the page applies to what is typed into it.

   Initialisms go too. A .dic holds ABS and ADSL beside its words, and those are
   spellings of letters rather than words; an all-capital entry of two letters
   or more is the test, which is safe in German, where every noun is capitalised
   but only the initialisms are capitalised throughout.

   Deduplication happens after folding, so résumé and resume are one word here.
   They are one word to this tool: it can only see the letters underneath. */
function accept(raw) {
  if (raw.length > 1 && raw === raw.toUpperCase() && raw !== raw.toLowerCase()) return null;
  const norm = ABC.normalise(raw);
  if (!norm.word || norm.rejected) return null;
  return norm.word;
}

function survey(words) {
  /* The distance depends only on the root — the word with its repeats taken
     out — which the page says in as many words under "the word, re-read". So
     the search runs once per root and the dictionary's hundred thousand words
     collapse to far fewer searches. */
  const byRoot = new Map();
  const seen = new Set();
  const hist = new Map();
  let kept = 0, unsortable = 0, longest = 0;

  for (const raw of words) {
    const word = accept(raw);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    kept++;
    if (word.length > longest) longest = word.length;

    const root = ABC.letterOrder(word);
    if (root === null) { unsortable++; continue; }

    let d = byRoot.get(root);
    if (d === undefined) { d = ABC.alphabetDistance(word); byRoot.set(root, d); }
    hist.set(d, (hist.get(d) || 0) + 1);
  }

  return { kept, unsortable, hist, roots: byRoot.size, longest };
}

const results = [];
for (const lang of LANGS) {
  const t0 = Date.now();
  const text = await load(lang.id);
  const words = headwords(text);
  const r = survey(words);
  const sortable = r.kept - r.unsortable;
  results.push({ ...lang, ...r, sortable });
  const max = Math.max(...r.hist.keys());
  process.stderr.write(
    `${lang.id}: ${words.length} entries -> ${r.kept} words, ` +
    `${sortable} sortable (${r.roots} roots), max distance ${max}, ` +
    `${((r.unsortable / r.kept) * 100).toFixed(1)}% unsortable, ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

/* The survey has to add up before it is written. A histogram that has lost a
   word somewhere is not visibly wrong on the page — it is a column a fraction
   of a percent short — so the arithmetic is checked here, where being wrong is
   still loud. */
for (const r of results) {
  const summed = [...r.hist.values()].reduce((a, b) => a + b, 0);
  if (summed !== r.sortable)
    throw new Error(`${r.id}: histogram sums to ${summed}, expected ${r.sortable}`);
  if (r.sortable + r.unsortable !== r.kept)
    throw new Error(`${r.id}: ${r.sortable} + ${r.unsortable} != ${r.kept}`);
}

/* One shared x axis, so the four rows are the same length and the page can
   read them as a matrix rather than as four ragged lists. */
const MAX = Math.max(...results.map((r) => Math.max(...r.hist.keys())));

const rows = results.map((r) => {
  const counts = [];
  for (let d = 0; d <= MAX; d++) counts.push(r.hist.get(d) || 0);
  return '  { id: ' + JSON.stringify(r.id) +
    ', name: ' + JSON.stringify(r.name) +
    ', dict: ' + JSON.stringify(r.dict) +
    ',\n    words: ' + r.kept +
    ', sortable: ' + r.sortable +
    ', unsortable: ' + r.unsortable +
    ',\n    counts: [' + counts.join(', ') + '] }';
});

const out = `/* Written by tools/abecedarian-corpus.mjs — do not edit by hand.

   Every headword of four Hunspell spelling dictionaries, folded to A-Z, put
   through abecedarian/abc.js. counts[d] is how many of that dictionary's words
   need exactly d swaps of the alphabet; "unsortable" is how many no ordering
   can sort at all, and words = sortable + unsortable. Sources are pinned to
   wooorm/dictionaries @ ${PIN.slice(0, 7)}. */

var ABC_CORPUS = {
  pin: ${JSON.stringify(PIN.slice(0, 7))},
  maxDistance: ${MAX},
  languages: [
${rows.join(',\n')}
  ]
};

if (typeof module !== 'undefined') module.exports = ABC_CORPUS;
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
process.stderr.write('wrote ' + path.relative(ROOT, OUT) + '\n');
