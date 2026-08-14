/* Abecedarian Distance: the engine. A word is abecedarian when its letters run
   in alphabetical order (billowy, almost). Allowing any permutation of the
   alphabet to count as alphabetical turns that into a distance: how far the
   nearest alphabet that sorts the word lies from ordinary A-Z. Everything here
   takes the alphabet as a parameter, so the same code runs on 5, 6 or 26
   letters; the small cases are what the brute-force tests check. */

var ABC = (function () {
  'use strict';

  var AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /* Addressing alphabets. A seed is a permutation's lexicographic rank in [0,
     n!). Seed 0 is the ordinary alphabet. The conversion both ways is the
     Lehmer code (the factorial number system), which is O(n) and bijective.
     BigInt throughout: 26! is 4.03e26, twenty-seven digits, and a double
     carries fifteen. */

  function factorial(n) {
    var f = 1n;
    for (var i = 2n; i <= BigInt(n); i++) f *= i;
    return f;
  }

  function alphabetFromSeed(seed, letters) {
    letters = letters || AZ;
    var n = letters.length;
    var rest = BigInt(seed);
    var total = factorial(n);
    if (rest < 0n || rest >= total) throw new RangeError('seed out of range');
    var pool = letters.split('');
    var out = '';
    for (var i = n - 1; i >= 0; i--) {
      var f = factorial(i);
      var pick = Number(rest / f);
      rest %= f;
      out += pool.splice(pick, 1)[0];
    }
    return out;
  }

  function seedFromAlphabet(alphabet, letters) {
    letters = letters || AZ;
    var n = letters.length;
    var pool = letters.split('');
    var seed = 0n;
    for (var i = 0; i < n; i++) {
      var at = pool.indexOf(alphabet[i]);
      if (at < 0) throw new Error('not a permutation of the alphabet');
      seed += BigInt(at) * factorial(n - 1 - i);
      pool.splice(at, 1);
    }
    return seed;
  }

  /* Distance between two alphabets. Read an alphabet as a permutation of
     positions and measure it against the identity. Cayley distance is the
     minimum number of swaps of any two letters and equals n minus the number
     of cycles, because a cycle of length L costs L-1 swaps. Kendall tau counts
     adjacent transpositions, which is the number of inversions. */

  function permOf(alphabet, letters) {
    var idx = {}, i;
    for (i = 0; i < letters.length; i++) idx[letters[i]] = i;
    var p = new Array(letters.length);
    for (i = 0; i < letters.length; i++) p[i] = idx[alphabet[i]];
    return p;
  }

  function cayleyDistance(alphabet, letters) {
    letters = letters || AZ;
    var p = permOf(alphabet, letters);
    var seen = new Array(p.length).fill(false);
    var cycles = 0;
    for (var i = 0; i < p.length; i++) {
      if (seen[i]) continue;
      cycles++;
      for (var j = i; !seen[j]; j = p[j]) seen[j] = true;
    }
    return p.length - cycles;
  }

  /* O(n squared), deliberately. At 26 letters that is 325 comparisons; a
     merge-sort counter would be O(n log n) and harder to read for no
     measurable gain. This is the first line to change if it ever runs on an
     alphabet of thousands. */
  function kendallTauDistance(alphabet, letters) {
    letters = letters || AZ;
    var p = permOf(alphabet, letters);
    var inv = 0;
    for (var i = 0; i < p.length; i++)
      for (var j = i + 1; j < p.length; j++)
        if (p[i] > p[j]) inv++;
    return inv;
  }

  /* One minimal swap sequence, as pairs of letters applied left to right to
     the ordinary alphabet. Selection-sort order: walk the positions, and when
     a position holds the wrong letter, fetch the right one. Every swap places
     at least one letter permanently, so it uses exactly n minus cycles swaps,
     which is the Cayley distance. The sequence is not unique; its length is. */
  function swapSequence(alphabet, letters) {
    letters = letters || AZ;
    var cur = letters.split('');
    var out = [];
    for (var i = 0; i < cur.length; i++) {
      if (cur[i] === alphabet[i]) continue;
      var j = cur.indexOf(alphabet[i], i + 1);
      out.push([cur[i], cur[j]]);
      var t = cur[i]; cur[i] = cur[j]; cur[j] = t;
    }
    return out;
  }

  function applySwaps(swaps, letters) {
    letters = letters || AZ;
    var cur = letters.split('');
    for (var s = 0; s < swaps.length; s++) {
      var a = cur.indexOf(swaps[s][0]), b = cur.indexOf(swaps[s][1]);
      var t = cur[a]; cur[a] = cur[b]; cur[b] = t;
    }
    return cur.join('');
  }

  /* Which words can be sorted at all. A word is abecedarisable exactly when no
     letter appears in two separate blocks: aabb yes, abab no, anna no. Under
     any single ordering every copy of a letter must sit together, so a letter
     that leaves and returns can never be accommodated, whatever the
     permutation. */

  function letterOrder(word) {
    var seen = {}, out = '';
    for (var i = 0; i < word.length; i++) {
      var ch = word[i];
      if (i > 0 && word[i - 1] === ch) continue;   // same block, still fine
      if (seen[ch]) return null;                   // second block of this one
      seen[ch] = true;
      out += ch;
    }
    return out;
  }

  /* Where it breaks, for a word that cannot be sorted: the letter that recurs,
     the index it first ran to, and the index it reappears at. Shown rather
     than a bare refusal. */
  function firstBreak(word) {
    var last = {}, i, ch;
    for (i = 0; i < word.length; i++) {
      ch = word[i];
      if (i > 0 && word[i - 1] === ch) { last[ch] = i; continue; }
      if (last[ch] !== undefined) return { letter: ch, first: last[ch], again: i };
      last[ch] = i;
    }
    return null;
  }

  function isSorted(word, alphabet) {
    var rank = {}, i;
    for (i = 0; i < alphabet.length; i++) rank[alphabet[i]] = i;
    for (i = 1; i < word.length; i++)
      if (rank[word[i - 1]] > rank[word[i]]) return false;
    return true;
  }

  /* The search. Reordering only the word's own letters among their own
     positions is not the whole problem: the letters the word never uses are
     free positions, and using them is usually cheaper than shuffling. The
     search therefore considers the full alphabet. */

  function solve(word, letters) {
    letters = letters || AZ;
    var order = letterOrder(word);
    if (order === null) return null;

    var n = letters.length;
    var k = order.length;
    var idx = {}, i;
    for (i = 0; i < n; i++) idx[letters[i]] = i;
    for (i = 0; i < k; i++)
      if (idx[order[i]] === undefined) throw new Error('letter outside the alphabet: ' + order[i]);

    var home = [];                       // where each bound letter normally lives
    for (i = 0; i < k; i++) home.push(idx[order[i]]);

    var best = -1, bestSlots = null;
    var slots = new Array(k);
    var succ = {};                       // letter -> the letter it now holds

    /* Depth-first over the slot for each index in turn. Two things keep it
       fast. Its own square first: a self-loop is free and usually available,
       so trying it first tends to reach the optimum on the first descent and
       prune the rest. The bound: each remaining index draws one edge, and one
       edge closes at most one cycle, so the best possible remaining cost is
       known and any branch that cannot beat the incumbent is cut. */
    var homeAtOrAfter = new Array(n + 1).fill(0);
    (function () {
      var isHome = new Array(n).fill(0);
      for (var j = 0; j < k; j++) isHome[home[j]] = 1;
      for (var p = n - 1; p >= 0; p--) homeAtOrAfter[p] = homeAtOrAfter[p + 1] + isHome[p];
    })();

    function reachable(i, lo) {
      var m = k - i, h = homeAtOrAfter[lo];
      return m < h ? m : h;
    }

    function dfs(i, lo, z) {
      if (i === k) {
        if (z > best) { best = z; bestSlots = slots.slice(); }
        return;
      }
      if (z + reachable(i, lo) <= best) return;

      var dst = order[i];
      var top = n - (k - i);             // leave room for the indices after this
      var own = home[i];

      var cands = [], p;
      if (own >= lo && own <= top) cands.push(own);
      for (p = lo; p <= top; p++) if (p !== own) cands.push(p);

      for (var c = 0; c < cands.length; c++) {
        p = cands[c];
        if (z + reachable(i, lo) <= best) return;

        var src = letters[p];
        /* Does this edge close a cycle? Follow the chain forward from the
           letter being placed. dst is nobody's target yet, so the walk cannot
           loop and ends at whichever letter has no target. If that is the
           letter being drawn from, the cycle closes. */
        var end = dst;
        while (succ[end] !== undefined) end = succ[end];

        succ[src] = dst;
        slots[i] = p;
        dfs(i + 1, p + 1, z + (end === src ? 1 : 0));
        delete succ[src];

        if (best === k) return;          // every index a cycle; nothing beats it
      }
    }

    dfs(0, 0, 0);
    if (bestSlots === null) return null;

    /* Rebuild the alphabet. The bound letters go on their chosen squares; then
       every square still empty holds the letter at the far end of its chain,
       walked backwards, which is exactly what closes that chain into a cycle
       and is why the count above was allowed to assume it could. */
    var alphabet = new Array(n).fill(null);
    var pred = {};
    for (i = 0; i < k; i++) {
      alphabet[bestSlots[i]] = order[i];
      pred[order[i]] = letters[bestSlots[i]];
    }
    for (var q = 0; q < n; q++) {
      if (alphabet[q] !== null) continue;
      var s = letters[q];
      while (pred[s] !== undefined) s = pred[s];
      alphabet[q] = s;
    }

    return {
      order: order,
      alphabet: alphabet.join(''),
      distance: k - best,
      cycles: best,
      slots: bestSlots.slice()
    };
  }

  function minimalAlphabet(word, letters) {
    var r = solve(word, letters);
    return r === null ? null : r.alphabet;
  }

  function alphabetDistance(word, letters) {
    var r = solve(word, letters);
    return r === null ? null : r.distance;
  }

  /* How many of the n! alphabets sort this word: n!/k!, because the k distinct
     letters may sit anywhere so long as their relative order is the forced one,
     and exactly one of the k! orders of them is that one. So the SHARE is
     1/k! — it depends only on how many different letters the word uses, and
     not at all on which they are or how long the word is. */
  function validAlphabets(word, letters) {
    letters = letters || AZ;
    var order = letterOrder(word);
    if (order === null) return null;
    return factorial(letters.length) / factorial(order.length);
  }

  /* ── What each letter is carrying ────────────────────────────────────────
     The distance is one number over the whole root, and it is fair to ask
     where it came from. Take a letter out of the root and ask again: the
     answer can only fall or stay, never rise, because an alphabet that sorts
     a word still sorts what is left of the word when a letter is deleted — a
     subsequence of a sorted sequence is sorted. How far it falls is what that
     letter was carrying, and a letter that changes nothing is one the word
     could do without at no cost.

     This is one question asked of each letter and not a division of the
     distance into shares, which is a real distinction rather than a
     disclaimer: vortex costs one swap, no single letter of it is carrying
     that swap, and v and e together are. The drops do not add up to the
     distance and are not meant to.

     Kept out of profile(), which runs on every keystroke. This costs one
     search per letter of the root — on the longest words in the dictionary
     survey, something over a second — so a caller that must not block the
     thread does them one at a time through carryAt(). */

  function carryAt(order, i, letters) {
    return alphabetDistance(order.slice(0, i) + order.slice(i + 1), letters);
  }

  function carry(word, letters) {
    var order = letterOrder(word);
    if (order === null) return null;
    var base = alphabetDistance(order, letters);
    var out = [];
    for (var i = 0; i < order.length; i++) {
      /* An already-sorted word has nothing to fall to: the distance is zero
         and removal cannot raise it, so every letter is free and not one
         search is needed to know it. */
      var without = base === 0 ? 0 : carryAt(order, i, letters);
      out.push({ letter: order[i], without: without, drop: base - without });
    }
    return { order: order, distance: base, letters: out };
  }

  /* ── The word inside the word ────────────────────────────────────────────
     The root with everything the distance does not rest on taken out of it:
     the shortest run of its letters, in its own order, that still costs the
     same. zebra is two swaps and so is ebra; vortex is one swap and so is te.

     Two facts make the search cheap on real words. Every load-bearing letter
     is in every core — if leaving x out lowers the cost, then so does any set
     that has already left x out — so only the FREE letters are in question,
     and the audit above has just named them. And the sets that still cost the
     full distance are an up-set: a set can only cost d if every set one letter
     larger does, so each level generates the next level's candidates and most
     of what could be tried never reaches a search.

     Two shapes are answered before the search starts, and they are the two
     that would otherwise cost the most: a root with no free letter at all is
     its own core, and a root whose load-bearing letters already cost the full
     distance has exactly those for its core and no other, since every core
     contains them. Between them they dispose of a pasted alphabet.

     The SIZE is the invariant; WHICH letters usually is not. vortex costs one
     swap and seven different pairs of its six letters cost that same swap on
     their own, so the search returns all of them rather than picking one.

     Underneath it is still a largest-droppable-set problem, and there is no
     polynomial answer to those. So it runs a step at a time and publishes as
     it goes: after every level, state() holds real cores of one agreed length,
     and `done` says whether anything shorter has been ruled out. A caller that
     runs out of patience stops calling step() and still has a true answer, a
     weaker one. Every root of up to seven letters agrees exactly with
     exhaustion, in at most 104 searches; the dictionaries' worst word takes
     29. What does not finish is a contrived one — the alphabet with its
     second half reversed has 26 free letters and no short-circuit — and the
     page bounds that with a clock rather than the engine guessing a number. */

  function coreSearch(word, letters, budget) {
    letters = letters || AZ;
    var cap = budget === undefined ? Infinity : budget;

    var order = letterOrder(word);
    var s = {
      order: order, distance: null, without: [], free: null,
      size: null, cores: null, count: 0, searched: 0, done: false
    };
    var k = order === null ? 0 : order.length;
    var keep = 0, level = null, queue = null, hits = null, at = 0, phase = 'root';

    for (var i = 0; i < k; i++) s.without.push(null);

    /* Nothing is worked out here: a constructor that solved the root would
       cost a third of a second on the worst word, in front of whichever
       keystroke made it. The first step() does it instead. */
    if (order === null) s.done = true;

    /* A set of free letters spelled back out, with every load-bearing letter
       kept, in the root's own order. Bits of `mask` index s.free. */
    function spell(mask) {
      var take = keep, j, out = '';
      for (j = 0; j < s.free.length; j++) if (mask & (1 << j)) take |= 1 << s.free[j];
      for (j = 0; j < k; j++) if (take & (1 << j)) out += order[j];
      return out;
    }

    /* Publish the level just confirmed. Everything in it is a genuine core of
       one agreed length, so this is a true answer at every moment — `done` is
       the separate claim that nothing shorter exists. */
    function publish() {
      s.cores = [];
      for (var j = 0; j < level.length; j++) s.cores.push(spell(level[j]));
      s.cores.sort();
      s.size = s.cores[0].length;
      s.count = s.cores.length;
    }

    function finish() {
      publish();
      s.done = true;
    }

    /* One level down. Every candidate is a level member with one more letter
       dropped, kept only if all of ITS one-larger supersets are in this level
       — anything else cannot cost the full distance and is not searched. */
    function nextLevel() {
      var f = s.free.length, have = {}, seen = {}, i, j, b, t, ok;
      for (i = 0; i < level.length; i++) have[level[i]] = true;
      queue = [];
      for (i = 0; i < level.length; i++) {
        for (j = 0; j < f; j++) {
          if (!(level[i] & (1 << j))) continue;
          t = level[i] & ~(1 << j);
          if (seen[t]) continue;
          seen[t] = true;
          ok = true;
          for (b = 0; b < f && ok; b++) if (!(t & (1 << b))) ok = have[t | (1 << b)] === true;
          if (ok) queue.push(t);
        }
      }
      hits = [];
      at = 0;
      if (!queue.length) finish();
    }

    function startLevels() {
      var f;
      keep = 0; s.free = [];
      for (var j = 0; j < k; j++) {
        if (s.without[j] < s.distance) keep |= 1 << j; else s.free.push(j);
      }
      f = s.free.length;
      level = [(1 << f) - 1];              // the whole root, always a core
      publish();
      /* Nothing free — the root is its own core, and nextLevel finds no
         candidate to try, which is the same answer for one less search. */
      if (!f) { nextLevel(); return; }
      /* The load-bearing letters on their own. Every core contains them, so if
         they already cost the full distance they ARE the core and nothing
         shorter or other exists. */
      s.searched++;
      if (alphabetDistance(spell(0), letters) === s.distance) {
        level = [0];
        finish();
        return;
      }
      nextLevel();
    }

    function step() {
      if (s.done) return false;
      if (phase === 'root') {
        s.distance = alphabetDistance(order, letters);
        s.searched++;
        /* Already sorted. Nothing carries it, and the shortest run of its
           letters that still costs nothing is no letters at all. */
        if (s.distance === 0) {
          for (var j = 0; j < k; j++) s.without[j] = 0;
          s.free = []; s.size = 0; s.cores = ['']; s.count = 1; s.done = true;
          return false;
        }
        phase = 'audit';
        return true;
      }
      if (phase === 'audit') {
        s.without[at] = carryAt(order, at, letters);
        s.searched++;
        if (++at === k) { phase = 'levels'; startLevels(); }
        return !s.done;
      }
      if (s.searched >= cap) return false;      // stopped, not finished
      var t = queue[at++];
      s.searched++;
      if (alphabetDistance(spell(t), letters) === s.distance) hits.push(t);
      if (at === queue.length) {
        if (hits.length) { level = hits; publish(); nextLevel(); }
        else finish();
      }
      return !s.done;
    }

    return { step: step, state: function () { return s; } };
  }

  /* The whole search in one go, for a caller that can afford to block. */
  function core(word, letters, budget) {
    var run = coreSearch(word, letters, budget);
    while (run.step()) {}
    return run.state();
  }

  function profile(word, letters) {
    letters = letters || AZ;
    var r = solve(word, letters);
    if (r === null) {
      return {
        word: word, order: null, alphabet: null, seed: null,
        distance: null, kendall: null, valid: null, swaps: null,
        letters: letters, broke: firstBreak(word)
      };
    }
    return {
      word: word,
      order: r.order,
      alphabet: r.alphabet,
      seed: seedFromAlphabet(r.alphabet, letters),
      distance: r.distance,
      kendall: kendallTauDistance(r.alphabet, letters),
      valid: factorial(letters.length) / factorial(r.order.length),
      swaps: swapSequence(r.alphabet, letters),
      letters: letters,
      broke: null
    };
  }

  /* A–Z only. Diacritics fold to their base letter (schön -> SCHON) because a
     German word typed as it is spelled should still get an answer, and the
     caller is told it happened rather than left to notice. Anything else —
     digits, spaces, punctuation — is refused rather than silently dropped,
     since dropping a hyphen quietly turns two words into one. */
  function normalise(input) {
    var raw = String(input == null ? '' : input).trim();
    var folded = raw
      .replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/ø/gi, 'O').replace(/æ/gi, 'AE').replace(/œ/gi, 'OE')
      .replace(/đ|ð/gi, 'D').replace(/ł/gi, 'L').replace(/þ/gi, 'TH')
      .toUpperCase();
    var bad = folded.replace(/[A-Z]/g, '');
    return { word: folded, changed: folded !== raw.toUpperCase(), rejected: bad };
  }

  return {
    AZ: AZ,
    factorial: factorial,
    alphabetFromSeed: alphabetFromSeed,
    seedFromAlphabet: seedFromAlphabet,
    cayleyDistance: cayleyDistance,
    kendallTauDistance: kendallTauDistance,
    swapSequence: swapSequence,
    applySwaps: applySwaps,
    isSorted: isSorted,
    letterOrder: letterOrder,
    firstBreak: firstBreak,
    solve: solve,
    minimalAlphabet: minimalAlphabet,
    alphabetDistance: alphabetDistance,
    validAlphabets: validAlphabets,
    carryAt: carryAt,
    carry: carry,
    coreSearch: coreSearch,
    core: core,
    profile: profile,
    normalise: normalise
  };
})();

if (typeof module !== 'undefined') module.exports = ABC;
