/* Abecedarian Distance — the engine.

   A word is *abecedarian* when its letters already run in alphabetical order:
   billowy, almost. Generalise that by allowing any permutation of the alphabet
   to count as "alphabetical", and a word stops being sorted-or-not and starts
   having a DISTANCE: how far the nearest alphabet that sorts it lies from the
   ordinary A–Z.

   Everything here takes the alphabet as a parameter rather than assuming 26
   letters, which is what makes the exhaustive test on ABCDE and ABCDEF
   possible — a claim about a search is worth what its brute-force check is
   worth, and 26! is not a number you can enumerate.

   The handoff spec names its API in snake_case; this is a browser file, so the
   names are camelCase and the correspondence is one to one:
     alphabet_from_seed  -> alphabetFromSeed      is_sorted     -> isSorted
     seed_from_alphabet  -> seedFromAlphabet      letter_order  -> letterOrder
     cayley_distance     -> cayleyDistance        minimal_alphabet
     kendall_tau_distance-> kendallTauDistance    alphabet_distance
     swap_sequence       -> swapSequence          profile                     */

var ABC = (function () {
  'use strict';

  var AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /* ── Addressing alphabets ────────────────────────────────────────────────
     A seed is a permutation's lexicographic rank in [0, n!). Seed 0 is the
     ordinary alphabet. The conversion both ways is the Lehmer code — the
     factorial number system — which is O(n) and bijective.

     BigInt throughout, and not as caution: 26! is 4.03e26, twenty-seven digits,
     and a double carries fifteen. Rank 1 is ABC...XZY, the smallest possible
     disturbance. The rotation BCD...ZA that people reach for first is rank
     15,511,210,043,330,985,984,000,000 — rotations are 26 of the 26!, and
     numbering by them would leave almost every alphabet unaddressable. */

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

  /* ── Distance between two alphabets ──────────────────────────────────────
     Read the alphabet as a permutation: the letter that normally sits at
     position p now sits wherever this alphabet puts it. Both measures below
     are of that permutation against the identity.

     CAYLEY is the minimum number of swaps of ANY two letters, and equals
     n minus the number of cycles: a cycle of length L costs L-1 swaps, and
     the letters left alone are cycles of length 1 costing nothing. Maximum 25.

     KENDALL TAU is the minimum number of swaps of ADJACENT letters, which is
     the inversion count. Maximum 325.

     They disagree loudly, and the disagreement is the point: the rotation
     BCD...ZA is 25 under Cayley — the worst score there is — and 25 out of 325
     under Kendall tau, which is mild. One measure asks how tangled the
     alphabet is, the other how far it has been carried. */

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

  /* O(n²), and deliberately. At 26 letters that is 325 comparisons; a
     merge-sort counter would be O(n log n) and unreadable for no gain any
     reader of this page could measure. It is the line to change first if this
     ever runs on an alphabet of thousands. */
  function kendallTauDistance(alphabet, letters) {
    letters = letters || AZ;
    var p = permOf(alphabet, letters);
    var inv = 0;
    for (var i = 0; i < p.length; i++)
      for (var j = i + 1; j < p.length; j++)
        if (p[i] > p[j]) inv++;
    return inv;
  }

  /* One minimal swap sequence, as pairs of letters, applied left to right to
     the ordinary alphabet. Selection-sort order: walk the positions, and
     whenever a position holds the wrong letter, fetch the right one from
     wherever it is. Every swap it makes puts at least one letter home for
     good, so it spends exactly n - cycles of them, which is the Cayley
     distance. The sequence is not unique; its length is. */
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

  /* ── Which words can be sorted at all ────────────────────────────────────
     A word is abecedarisable exactly when no letter appears in two separate
     blocks: aabb yes, abab no, anna no (a…n…n…a), tee yes. Under any single
     ordering every copy of a letter has to sit together, so a letter that
     leaves and comes back can never be accommodated — no permutation of the
     alphabet helps, and this is not an approximation but a complete test.
     (Formally the word must avoid the pattern abab: a Davenport-Schinzel
     sequence of order 2.)

     What survives is the FORCED ORDER: the distinct letters in order of first
     appearance. Everything else about the word — repeats, length — stops
     mattering the moment this is extracted, which is also why a dictionary run
     should cache on the forced order rather than on the word. */

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

  /* Where it breaks, for a word that cannot be sorted: the letter that comes
     back, the index it first ran to, and the index it reappears at. The tool
     shows this rather than a bare refusal — "no" is a verdict, and the reader
     asked a question. */
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

  /* ── The search ──────────────────────────────────────────────────────────
     The obvious construction is wrong, and expensively so. Reordering the
     word's own letters among their own alphabetical positions looks like the
     whole problem and is not: the letters the word never uses are parking
     spaces, and parking is usually cheaper than shuffling.

     Forced order B, C, A on the alphabet ABCDE:
       local reshuffle  -> BCADE, one 3-cycle,        two swaps
       optimal          -> DBCAE, one swap A<->D,     one swap
     D is not in the word and does nothing but hold a place, and holding a
     place is what makes it a single swap instead of a rotation.

     So: pick rising slots p_1 < … < p_k for the k bound letters l_1 … l_k.
     Each choice draws an edge "the letter that normally lives at p_i now holds
     l_i" in a partial permutation of all n letters. Whatever is left over can
     always be filled in so that every open chain closes into its own cycle, so
     the finished permutation has 26 - k + z cycles, where z counts the cycles
     already closed among the chosen edges.

       cost = n - cycles = k - z

     The whole problem is therefore to MAXIMISE z, and the word's length, its
     repeats and the size of the alphabet have all dropped out of it.

     A self-loop — a letter parked on its own square — is the commonest way to
     close a cycle, which is why a forced order with no inversions costs
     nothing and is exactly the classical abecedarian case. */

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

    /* Depth-first over the slot for each index in turn. Two things keep it in
       the milliseconds:

       ITS OWN SQUARE FIRST. A self-loop is free and usually available, so
       trying it before anything else tends to walk straight to the optimum on
       the first descent, and everything after that is pruned rather than
       searched.

       THE BOUND, in two halves. Each remaining index draws one edge and one
       edge shuts at most one loop, so no more than `remaining` cycles are
       still to be had. And every letter on a cycle is a BOUND letter — a cycle
       has the same letters as sources and as targets, and the targets are the
       word's own — so the edge that shuts a loop always runs out of some bound
       letter's own square. Distinct loops shut on distinct edges from distinct
       squares, and squares only rise, so no more loops remain than there are
       bound letters' squares at or above the floor. The smaller of the two is
       the bound, and the second half is what makes a fourteen-letter word
       finish in single-digit milliseconds instead of hundreds: once the floor
       has climbed past the last of the word's own squares, nothing below can
       close and the whole subtree goes.

       A third, sharper-LOOKING bound is available and is WRONG, which cost a
       brute-force run to find out: "an index whose own square is already
       behind the floor cannot be a self-loop, so of the m left, only the s
       that still can are worth one apiece and the rest need two each". That
       quietly assumes a cycle is paid for entirely by the indices inside it.
       It is not — an edge drawn now closes a loop through edges drawn earlier.
       On alphabet ABCDE the word EA needs A->E first and E->A second, and the
       second index alone, unable to self-loop, shuts the loop the first one
       opened. That bound scored the index zero and pruned the only optimum
       there is. */
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
           letter being placed; dst is nobody's target yet, so the walk cannot
           loop and ends at whichever letter has nothing yet. If that is the
           letter we are drawing FROM, the loop shuts. */
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
    profile: profile,
    normalise: normalise
  };
})();

if (typeof module !== 'undefined') module.exports = ABC;
