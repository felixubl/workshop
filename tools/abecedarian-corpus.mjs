#!/usr/bin/env node
/* The dictionary survey behind the figures at the foot of the Abecedarian
   Distance page. Runs every headword of thirteen spelling dictionaries through
   the same engine the page uses — abecedarian/abc.js, not a copy of it — and
   writes the tallies to abecedarian/data/dictionaries.js.

       tools/abecedarian-corpus.mjs [--refresh]

   Why a build step and not a fetch. The tool is rated `local` on the index: it
   opens no socket. Shipping thirteen word lists to the browser to count them
   there would be forty megabytes to answer a question whose answer is a couple
   of hundred numbers, and fetching them from somebody else's server would move
   the tool up a rung for a chart. So the counting happens here, once, and the
   counts are committed
   — the same arrangement as the band crawler in crawl-vis.mjs, which computes
   into eclipse-recon/data/ for the same reason.

   The sources are pinned to one commit of one repository, so all thirteen are
   packaged identically and the run is repeatable. It takes about three quarters
   of an hour from a warm cache — eight minutes of that is the distances, and
   the rest is the cores, which are a search apiece rather than a number.
   Downloads are cached in .dict-cache (git-ignored); --refresh re-fetches. */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ABC = require(path.join(ROOT, 'abecedarian/abc.js'));

/* One repository, one commit, one packaging: wooorm/dictionaries takes the
   upstream Hunspell dictionary of each language and republishes it UTF-8 with
   the same file names. Thirteen lists built by thirteen different projects are
   at least *delivered* the same way, which is as close to like-for-like as this
   comparison can honestly get — there is no standard dictionary across
   languages, only a standard format, and the editorial policy behind each list
   is its own. It shows in the entry counts: Turkish carries 371 009 and English
   49 510, which is a difference in how the two spellcheckers are built rather
   than in the size of the languages. The upstream projects are credited by name
   on the page; their licences travel with the packages, and nothing of theirs
   is redistributed here — only counts derived from them. */
const PIN = '8cfea406b505e4d7df52d5a19bce525df98c54ab';
const SOURCE = (lang) =>
  `https://raw.githubusercontent.com/wooorm/dictionaries/${PIN}/dictionaries/${lang}/index.dic`;

/* Thirteen, and the list is a judgement rather than everything available.

   The pin carries 92 dictionaries. Thirteen of those are in scripts this
   engine cannot read: it works in A-Z, so Greek, Cyrillic, Hebrew, Korean,
   Armenian, Georgian and the rest are not "few results", they are no results.
   Generalising the engine to another alphabet is a real possibility — solve()
   already takes the letters as a parameter — but the answers would not belong
   on the same axis as these, because a 33-letter alphabet has a longer way to
   travel than a 26-letter one.

   Of the Latin-script rest, two were measured and dropped: the Galician .dic
   does not parse as headwords (three quarters of it refused) and the
   Vietnamese one holds 6 632 entries of which three quarters collapse into
   each other the moment tone marks fold away — surveying that is not surveying
   Vietnamese. Several more were left out for the same reason in milder form,
   Catalan, Romanian, Hungarian and Basque among them, where folding costs
   between 7 and 9 per cent of the dictionary's own distinctions.

   What is left is thirteen where the fold is cheap enough to defend, ordered
   by name because no other order is defensible. Czech is the dearest of them
   at 7%, and German at 37% is dearer than any — both stay because their
   spelling systems are the reason this tool folds at all, and the page says
   what it cost. */
const LANGS = [
  { id: 'cs', name: 'Czech', dict: 'cs_CZ Hunspell' },
  { id: 'da', name: 'Danish', dict: 'Stavekontrolden da_DK' },
  { id: 'nl', name: 'Dutch', dict: 'OpenTaal nl_NL' },
  { id: 'en', name: 'English', dict: 'SCOWL / en_US Hunspell' },
  { id: 'fr', name: 'French', dict: 'Dicollecte / Grammalecte fr' },
  { id: 'de', name: 'German', dict: 'igerman98 de_DE Hunspell' },
  { id: 'it', name: 'Italian', dict: 'Italian Writing Aids it_IT' },
  { id: 'nb', name: 'Norwegian', dict: 'spell-norwegian nb_NO' },
  { id: 'pl', name: 'Polish', dict: 'Polish Native Lang pl_PL' },
  { id: 'pt', name: 'Portuguese', dict: 'pt_BR Hunspell (Moura)' },
  { id: 'es', name: 'Spanish', dict: 'RLA es_ES Hunspell' },
  { id: 'sv', name: 'Swedish', dict: 'sv_SE Hunspell (Andersson)' },
  { id: 'tr', name: 'Turkish', dict: 'tr_TR Hunspell (Zafer)' },
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
   bold, and asking the same of all thirteen is what keeps them comparable. */
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

  /* How many words each root stands for, and a few of their spellings. Almost
     every root stands for exactly one word: collapsing repeats only ever merges
     spellings that differ in a doubled letter, and a dictionary rarely carries
     both. The exceptions are worth printing, which is why the spellings are
     kept and not just the count. */
  const rootWords = new Map();

  /* The far end of the tail, kept as words rather than as a count. The page
     draws a column at ten swaps and cannot say which words are standing in it;
     these are them. Everything at the current record is held, and the list is
     emptied whenever the record breaks, so what comes out is every word that
     ties for worst — the spelling as the dictionary prints it, not the folded
     form, because a reader should recognise it. */
  let peak = -1;
  let peakWords = [];

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

    let held = rootWords.get(root);
    if (held === undefined) { held = []; rootWords.set(root, held); }
    held.push(raw);

    if (d > peak) { peak = d; peakWords = []; }
    if (d === peak) peakWords.push(raw);
  }

  return { kept, unsortable, hist, longest, peak, peakWords, byRoot, rootWords };
}

/* ── What the words come down to ───────────────────────────────────────────
   The second question the page asks of a word, asked of every word: the core,
   the shortest run of the root's letters that still costs the same.

   Only of the words that cost something. An already-abecedarian word has a
   distance of nought and its core is the empty string — true, and no more than
   that, so counting five thousand words as sharing "" would be the arithmetic
   answering a question nobody asked.

   A word can have several cores and usually does, so these families overlap on
   purpose: a core's count is how many words hold it among their shortest, and
   zebra is counted under ebra, zeba and zebr alike. That is what "words that
   come down to the same thing" means when the thing is not unique, and it is
   why the counts do not sum to the number of words.

   This is the expensive half of the survey — English alone is eighty seconds —
   so it runs once per ROOT and multiplies by how many words that root stands
   for, which is the same trick the distance itself uses. The allowance is the
   page's, thirty times over: no dictionary root has ever come near it, and any
   that did would be counted and reported rather than quietly cut off. */
const CORE_ALLOWANCE = 30000;

/* How many families to carry, and how many spellings to name inside each. One
   family would print a fact with no scale beside it; the page draws three so a
   reader can see whether the biggest is a cliff or a plateau. */
const TOP_KEEP = 3;
const WORDS_KEEP = 4;

function cores(byRoot, rootWords) {
  const held = new Map();               // core -> { words, spellings }
  let costing = 0, costingRoots = 0, plural = 0, stopped = 0, slowest = 0, slowestRoot = '';

  for (const [root, d] of byRoot) {
    if (d === 0) continue;
    const spellings = rootWords.get(root);
    costing += spellings.length;
    costingRoots++;

    const t0 = Date.now();
    const run = ABC.coreSearch(root);
    while (run.step()) if (Date.now() - t0 > CORE_ALLOWANCE) break;
    const s = run.state();
    const ms = Date.now() - t0;
    if (ms > slowest) { slowest = ms; slowestRoot = root; }
    if (!s.done) { stopped++; continue; }
    if (s.count > 1) plural++;

    for (const core of s.cores) {
      let fam = held.get(core);
      if (fam === undefined) { fam = { words: 0, spellings: [] }; held.set(core, fam); }
      fam.words += spellings.length;
      if (fam.spellings.length < 4) fam.spellings.push(spellings[0]);
    }
  }

  return { held, costing, costingRoots, plural, stopped, slowest, slowestRoot };
}

/* The biggest families, most words first. Ties broken by the shorter string
   and then alphabetically, so a re-run of the same dictionary prints the same
   list rather than whichever the Map happened to hold first. */
function biggest(entries, keep) {
  return entries
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, keep);
}


const results = [];
for (const lang of LANGS) {
  const t0 = Date.now();
  const text = await load(lang.id);
  const words = headwords(text);
  const r = survey(words);
  const sortable = r.kept - r.unsortable;
  const c = cores(r.byRoot, r.rootWords);

  /* How many roots stand for one word, two, three, more. Kept as a short
     distribution rather than a mean, because the mean of a distribution this
     lopsided — nearly all ones — says nothing a reader wants. */
  const spread = [0, 0, 0, 0];          // 1, 2, 3, 4-or-more
  for (const held of r.rootWords.values())
    spread[Math.min(held.length, 4) - 1]++;

  const rootTop = biggest([...r.rootWords].map(([k, v]) => [k, v.length]), TOP_KEEP)
    .map(([root, n]) => ({ root, n, words: r.rootWords.get(root).slice(0, WORDS_KEEP) }));
  const coreTop = biggest([...c.held].map(([k, v]) => [k, v.words]), TOP_KEEP)
    .map(([core, n]) => ({ core, n, words: c.held.get(core).spellings.slice(0, WORDS_KEEP) }));

  results.push({ ...lang, ...r, sortable, ...c, spread, rootTop, coreTop });
  const max = Math.max(...r.hist.keys());
  process.stderr.write(
    `${lang.id}: ${words.length} entries -> ${r.kept} words, ` +
    `${sortable} sortable (${r.byRoot.size} roots), max distance ${max}, ` +
    `${((r.unsortable / r.kept) * 100).toFixed(1)}% unsortable | ` +
    `${c.costing} costing words, ${c.costingRoots} roots, ${c.held.size} cores` +
    `${c.stopped ? ', ' + c.stopped + ' CUT OFF' : ''} ` +
    `(slowest ${c.slowest}ms on ${c.slowestRoot}), ` +
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
  /* The worst words have to be the words in the last column of the histogram,
     or the page would be printing one thing and drawing another. */
  if (r.peak !== Math.max(...r.hist.keys()))
    throw new Error(`${r.id}: peak ${r.peak} is not the histogram's last column`);
  if (r.peakWords.length !== r.hist.get(r.peak))
    throw new Error(`${r.id}: ${r.peakWords.length} worst words, histogram says ${r.hist.get(r.peak)}`);

  /* The two collapses have to account for the same words the histogram does.
     Every sortable word has exactly one root, so the root families partition
     them; the costing words are the sortable ones less the already-sorted
     column. The CORE families are not a partition and are not checked as one —
     a word with three cores is in three of them on purpose. */
  const inFamilies = [...r.rootWords.values()].reduce((a, w) => a + w.length, 0);
  if (inFamilies !== r.sortable)
    throw new Error(`${r.id}: root families hold ${inFamilies}, expected ${r.sortable}`);
  if (r.spread.reduce((a, b) => a + b, 0) !== r.byRoot.size)
    throw new Error(`${r.id}: family spread counts ${r.spread} against ${r.byRoot.size} roots`);
  if (r.costing !== r.sortable - r.hist.get(0))
    throw new Error(`${r.id}: ${r.costing} costing words, expected ${r.sortable - r.hist.get(0)}`);
  /* A cut-off search publishes a core it could not prove shortest, and one of
     those in the tally would make every count downstream of it a guess. None
     has ever happened; if one does, the survey stops rather than ships. */
  if (r.stopped)
    throw new Error(`${r.id}: ${r.stopped} roots were cut off at ${CORE_ALLOWANCE}ms`);
}

/* One shared x axis, so the four rows are the same length and the page can
   read them as a matrix rather than as four ragged lists. */
const MAX = Math.max(...results.map((r) => Math.max(...r.hist.keys())));

/* How many of the worst words to carry. All of them, where "all" is two or
   three; a handful where a dozen tie, with the true count beside it so the page
   can say it is showing a handful. They come out in dictionary order, which is
   the order they were read in — arbitrary between ties, but not chosen. */
const PEAK_KEEP = 6;

const fam = (list, key) => '[' + list.map((f) =>
  '{ ' + key + ': ' + JSON.stringify(f[key]) + ', n: ' + f.n +
  ', words: ' + JSON.stringify(f.words) + ' }').join(',\n                ') + ']';

const rows = results.map((r) => {
  const counts = [];
  for (let d = 0; d <= MAX; d++) counts.push(r.hist.get(d) || 0);
  return '  { id: ' + JSON.stringify(r.id) +
    ', name: ' + JSON.stringify(r.name) +
    ', dict: ' + JSON.stringify(r.dict) +
    ',\n    words: ' + r.kept +
    ', sortable: ' + r.sortable +
    ', unsortable: ' + r.unsortable +
    ',\n    peak: ' + r.peak +
    ', peakCount: ' + r.peakWords.length +
    ',\n    peakWords: ' + JSON.stringify(r.peakWords.slice(0, PEAK_KEEP)) +
    ',\n    counts: [' + counts.join(', ') + ']' +
    ',\n    roots: ' + r.byRoot.size +
    ', spread: [' + r.spread.join(', ') + ']' +
    ',\n    costing: ' + r.costing +
    ', costingRoots: ' + r.costingRoots +
    ', cores: ' + r.held.size +
    ', plural: ' + r.plural +
    ',\n    rootTop: ' + fam(r.rootTop, 'root') +
    ',\n    coreTop: ' + fam(r.coreTop, 'core') + ' }';
});

const out = `/* Written by tools/abecedarian-corpus.mjs — do not edit by hand.

   Every headword of ${results.length} Hunspell spelling dictionaries, folded to A-Z, put
   through abecedarian/abc.js. counts[d] is how many of that dictionary's words
   need exactly d swaps of the alphabet; "unsortable" is how many no ordering
   can sort at all, and words = sortable + unsortable.

   The two collapses. "roots" counts the distinct roots the sortable words have,
   and spread[i] how many of those roots stand for i+1 words (the last bucket is
   four or more) — nearly all stand for one. "costing" is the sortable words
   less the already-abecedarian ones, over "costingRoots" roots, and "cores" is
   how many distinct cores those roots come down to; "plural" is how many of the
   roots have more than one shortest core, which is why cores can outnumber the
   roots they came from. rootTop and coreTop are the biggest families, n words
   apiece. A core family counts every word holding that core among its shortest,
   so the families overlap and do not sum to the word count.

   Sources are pinned to wooorm/dictionaries @ ${PIN.slice(0, 7)}. */

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
