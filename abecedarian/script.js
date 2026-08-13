/* Abecedarian Distance: the page. The engine is in abc.js and knows nothing
   about the DOM; this file knows nothing about permutations. It reads the
   field, asks for a profile and prints it. No button: a real word is answered
   in well under a millisecond, and the worst forty-character input takes about
   a third of a second. */

var field = document.getElementById('word');
var hint = document.getElementById('hint');
var empty = document.getElementById('empty');
var result = document.getElementById('result');

var distanceEl = document.getElementById('distance');
var verdictSay = document.getElementById('verdictSay');
var verdictMeta = document.getElementById('verdictMeta');
var facts = document.getElementById('facts');
var alphaMeta = document.getElementById('alphaMeta');
/* The three blocks that exist only when there is an alphabet. A word no
   ordering can sort has no strip, no swaps and no seed. */
var whenSortable = document.querySelectorAll('[data-when="sortable"]');
var strip = document.getElementById('strip');
var stripKey = document.getElementById('stripKey');
var swaps = document.getElementById('swaps');
var swapMeta = document.getElementById('swapMeta');
var swapNote = document.getElementById('swapNote');
var reread = document.getElementById('reread');
var readMeta = document.getElementById('readMeta');
var rereadNote = document.getElementById('rereadNote');
var seedEl = document.getElementById('seed');

/* Thin spaces every three digits. A twenty-seven-digit number is evidence
   rather than reading, and ungrouped it cannot be checked against another
   copy. */
function grouped(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fact(dl, term, value) {
  dl.appendChild(el('dt', null, term));
  dl.appendChild(el('dd', null, value));
}

/* The strip: twenty-six squares in position order. Each holds the letter that
   occupies that position under the new alphabet; where that differs from the
   usual letter, the usual one is printed above it and struck through, so the
   substitution can be read off the square. */
function drawStrip(p) {
  strip.textContent = '';
  var inWord = {};
  for (var i = 0; i < p.order.length; i++) inWord[p.order[i]] = true;

  var moved = 0;
  for (var q = 0; q < p.alphabet.length; q++) {
    var now = p.alphabet[q], usual = ABC.AZ[q];
    var cell = el('div', 'cell', null);
    cell.setAttribute('role', 'listitem');
    if (now !== usual) { cell.classList.add('is-moved'); moved++; }
    if (inWord[now]) cell.classList.add('is-word');

    cell.appendChild(el('span', 'cell-was', now === usual ? ' ' : usual));
    cell.appendChild(el('span', 'cell-now', now));
    cell.appendChild(el('span', 'cell-at', String(q + 1)));
    cell.setAttribute('aria-label',
      'Position ' + (q + 1) + ': ' + now + (now === usual ? ', unchanged' : ', normally ' + usual));
    strip.appendChild(cell);
  }

  stripKey.textContent = moved === 0
    ? 'Nothing moved: the ordinary alphabet already sorts this word.'
    : plural(moved, 'letter sits', 'letters sit') + ' somewhere other than usual' +
      ', and the small struck letter above one is the letter that normally has that place. ' +
      'The word’s own ' + plural(p.order.length, 'letter is', 'letters are') + ' boxed.';
}

function drawSwaps(p) {
  swaps.textContent = '';
  /* An abecedarian word needs no swaps, and an empty list inside a bordered
     box reads as a failure to load rather than as the correct answer, so the
     panel says so in words. */
  if (!p.swaps.length) {
    swaps.appendChild(el('li', 'swap-none', 'nothing to swap'));
    swapMeta.textContent = 'none needed';
    swapNote.textContent = 'The ordinary alphabet is already the answer.';
    return;
  }
  for (var i = 0; i < p.swaps.length; i++) {
    var li = el('li', 'swap', null);
    li.appendChild(el('code', 'swap-pair', p.swaps[i][0] + ' ↔ ' + p.swaps[i][1]));
    swaps.appendChild(li);
  }
  swapMeta.textContent = plural(p.swaps.length, 'swap', 'swaps');
  swapNote.textContent = 'Applied to the ordinary alphabet in this order, these build the ' +
    'alphabet above. There are other sequences of the same length; there is none shorter.';
}

/* The word read back under its new alphabet, letter by letter with the
   position each now occupies. The numbers only increase, which is the page's
   claim made checkable in one line. */
function drawReread(p) {
  reread.textContent = '';
  var at = {};
  for (var i = 0; i < p.alphabet.length; i++) at[p.alphabet[i]] = i + 1;
  for (var j = 0; j < p.word.length; j++) {
    var g = el('span', 'glyph', null);
    g.appendChild(el('span', 'glyph-l', p.word[j]));
    g.appendChild(el('span', 'glyph-n', String(at[p.word[j]])));
    reread.appendChild(g);
  }
  readMeta.textContent = p.word.length === p.order.length
    ? plural(p.word.length, 'letter', 'letters')
    : p.word.length + ' letters, ' + p.order.length + ' different';
  /* The second sentence appears only for a word with repeats; without them the
     root is the word itself. */
  rereadNote.textContent = 'The place each letter takes under the alphabet above. ' +
    'They never decrease — which is what it means for the word to be sorted.' +
    (p.word.length === p.order.length ? '' :
      ' The repeats change nothing: every word with the root ' +
      p.order.toLowerCase() + ' answers the same way.');
}

function showNothing(message) {
  result.hidden = true;
  empty.hidden = false;
  hint.hidden = !message;
  if (message) hint.textContent = message;
}

function showWord(input) {
  var norm = ABC.normalise(input);

  if (!norm.word) { showNothing(''); return; }
  if (norm.rejected) {
    /* Refused rather than stripped: dropping a hyphen would silently turn two
       words into one. */
    var uniq = norm.rejected.split('').filter(function (c, i, a) { return a.indexOf(c) === i; });
    showNothing('Letters A to Z only — this has ' +
      uniq.map(function (c) { return c === ' ' ? 'a space' : '“' + c + '”'; }).join(', ') +
      ' in it.');
    return;
  }

  var p = ABC.profile(norm.word);
  empty.hidden = true;
  result.hidden = false;
  hint.hidden = !norm.changed;
  if (norm.changed) {
    hint.textContent = 'Read as ' + norm.word.toLowerCase() +
      ' — accents and ß fold to the letters underneath them.';
  }

  /* ── The word no alphabet sorts ─────────────────────────────────────────
     A refusal with the reason in it. The letter that comes back is named, and
     the two places it appears are quoted out of the word itself, because
     "impossible" is a verdict and the reader asked a question. */
  if (p.distance === null) {
    var b = p.broke;
    var w = p.word.toLowerCase();
    distanceEl.textContent = 'no distance';
    distanceEl.className = 'count-big is-none';
    verdictMeta.textContent = 'not abecedarisable';
    /* The word printed back with both appearances of the offending letter in
       ink and everything between them faint: the reader sees the letter leave
       and return rather than being told it did. */
    var quote = w.slice(0, b.first) +
      '<b>' + w[b.first] + '</b>' + w.slice(b.first + 1, b.again) +
      '<b>' + w[b.again] + '</b>' + w.slice(b.again + 1);
    verdictSay.innerHTML = 'No alphabet in any order sorts <em>' + w + '</em>. ' +
      'Under one ordering every copy of a letter sits together, and ' +
      '<strong>' + b.letter.toLowerCase() + '</strong> leaves and comes back &mdash; ' +
      '<span class="quote">' + quote + '</span>.';
    facts.textContent = '';
    fact(facts, 'the letter that returns', b.letter);
    fact(facts, 'first at', 'position ' + (b.first + 1));
    fact(facts, 'again at', 'position ' + (b.again + 1));
    fact(facts, 'alphabets that sort it', '0 of 26!');
    whenSortable.forEach(function (n) { n.hidden = true; });
    return;
  }

  whenSortable.forEach(function (n) { n.hidden = false; });

  distanceEl.className = 'count-big' + (p.distance === 0 ? ' is-zero' : '');
  distanceEl.textContent = p.distance === 0
    ? 'already abecedarian'
    : plural(p.distance, 'swap', 'swaps');
  verdictMeta.textContent = p.distance + ' of a possible 25';

  verdictSay.innerHTML = p.distance === 0
    ? 'The letters of <em>' + p.word.toLowerCase() +
      '</em> are already in alphabetical order. Nothing has to move.'
    : 'Swap ' + plural(p.distance, 'pair of letters', 'pairs of letters') +
      ' in the alphabet and <em>' + p.word.toLowerCase() +
      '</em> comes out sorted. No fewer will do it, though ' +
      (p.distance === 1 ? 'a different pair would serve as well'
                        : 'other pairs would serve as well') + '.';

  /* The root first, because after it nothing else about the word is used. It
     is printed as a word rather than as a list with arrows between the
     letters: it IS a string, several real words often share one, and the
     arrows made it look like a derivation when it is just the word with its
     repeats taken out. */
  facts.textContent = '';
  fact(facts, 'root', p.order.toLowerCase());
  fact(facts, 'adjacent swaps instead', p.kendall + ' of a possible 325');
  fact(facts, 'alphabets that sort it',
       'one in ' + grouped(ABC.factorial(p.order.length)));
  fact(facts, 'which is', grouped(p.valid) + ' of them');

  alphaMeta.textContent = 'Cayley ' + p.distance + ' · Kendall tau ' + p.kendall;
  drawStrip(p);
  drawSwaps(p);
  drawReread(p);
  seedEl.textContent = grouped(p.seed);
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */

var timer = null;
function run() {
  var v = field.value;
  showWord(v);
  /* The hash is the deep link. The copy-link button deliberately copies the
     tool's address rather than the current state, as every tool on this site
     does. Clearing it uses the real path rather than a single space, which is
     not a valid URL. Wrapped in a try, because Safari throws after about a
     hundred replaceState calls in thirty seconds. */
  var slug = ABC.normalise(v).word.toLowerCase();
  var next = slug ? '#' + encodeURIComponent(slug) : location.pathname + location.search;
  if (location.hash.slice(1) === slug) return;
  try { history.replaceState(null, '', next); } catch (err) {}
}

field.addEventListener('input', function () {
  clearTimeout(timer);
  timer = setTimeout(run, 120);
});

/* Someone editing the address, or arriving from a link while the page is
   already open, should get the word they asked for. The guard is against the
   echo: run() rewrites the hash itself, and replaceState is silent, but a
   browser that ever did fire for it would otherwise reset the field mid-word. */
window.addEventListener('hashchange', function () {
  var asked = decodeURIComponent(location.hash.slice(1) || '');
  if (ABC.normalise(asked).word === ABC.normalise(field.value).word) return;
  field.value = asked;
  showWord(asked);
});

var fromHash = decodeURIComponent(location.hash.slice(1) || '');
field.value = fromHash;
showWord(fromHash);

/* Focus on load, but not on a touch screen. A phone will not open its keyboard
   for a script, so the field would arrive focused with a caret and no
   keyboard. The tap that should raise one then lands on an already-focused
   input, which iOS treats as moving the caret rather than entering the field,
   so often nothing appears. (hover: none) is the system's own test for a
   finger rather than a pointer, and is what tokens/rules.css uses. */
if (!window.matchMedia || !window.matchMedia('(hover: none)').matches) field.focus();
