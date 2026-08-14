/* Abecedarian Distance: the proof. The engine's central claim is a minimum
   over 26! alphabets, which cannot be enumerated. So it is checked on
   alphabets short enough to enumerate completely: for ABCDE and ABCDEF, every
   word up to the length of the alphabet is scored by the solver and again by
   brute force over all n! permutations, and the two must agree. Runs in the
   browser and under node against the same assertions. */

var ABCTest = (function (ABC) {
  'use strict';

  function permutations(letters) {
    if (letters.length <= 1) return [letters];
    var out = [];
    for (var i = 0; i < letters.length; i++) {
      var rest = letters.slice(0, i) + letters.slice(i + 1);
      var sub = permutations(rest);
      for (var j = 0; j < sub.length; j++) out.push(letters[i] + sub[j]);
    }
    return out;                       // recursion in this order IS lex order
  }

  /* Every word over the alphabet, from length 1 up to `max`. */
  function words(letters, max) {
    var out = [], level = [''];
    for (var len = 1; len <= max; len++) {
      var next = [];
      for (var i = 0; i < level.length; i++)
        for (var j = 0; j < letters.length; j++)
          next.push(level[i] + letters[j]);
      out = out.concat(next);
      level = next;
    }
    return out;
  }

  /* The exhaustive answer: try every alphabet. */
  function bruteForce(word, letters, perms) {
    var best = null;
    for (var i = 0; i < perms.length; i++) {
      if (!ABC.isSorted(word, perms[i])) continue;
      var d = ABC.cayleyDistance(perms[i], letters);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  function run(report) {
    var results = [];
    function ok(name, pass, detail) {
      results.push({ name: name, pass: !!pass, detail: detail || '' });
      if (report) report(results[results.length - 1]);
    }

    /* ── Lehmer, both ways, against the permutations themselves ──────────── */
    ['ABC', 'ABCDE'].forEach(function (letters) {
      var perms = permutations(letters);
      var bad = 0, first = '';
      for (var r = 0; r < perms.length; r++) {
        var made = ABC.alphabetFromSeed(r, letters);
        var back = ABC.seedFromAlphabet(perms[r], letters);
        if (made !== perms[r] || back !== BigInt(r)) {
          if (!bad) first = 'rank ' + r + ': got ' + made + ', ranked ' + back;
          bad++;
        }
      }
      ok('[' + letters + '] seed <-> alphabet is the lexicographic rank, both ways',
         bad === 0, bad ? bad + ' wrong, first ' + first : perms.length + ' ranks');
    });

    ok('seed 0 is the ordinary alphabet',
       ABC.alphabetFromSeed(0n) === ABC.AZ, ABC.alphabetFromSeed(0n));
    ok('rank 1 is ABC...XZY, the smallest disturbance',
       ABC.alphabetFromSeed(1n) === 'ABCDEFGHIJKLMNOPQRSTUVWXZY',
       ABC.alphabetFromSeed(1n));

    /* The handoff puts the rotation at 25! =
       15,511,210,043,330,985,984,000,000, the rank of BACDEF...Z, the first
       alphabet beginning with B, since 25! counts everything starting with A.
       The rotation itself is not first in the B block (BACD... precedes it)
       and has rank 25! + 24! + ... + 1!. Both are asserted. */
    var rot = ABC.AZ.slice(1) + ABC.AZ[0];
    ok('25! is the rank of BACDEF...Z, the first alphabet starting with B',
       ABC.alphabetFromSeed(15511210043330985984000000n) === 'BACDEFGHIJKLMNOPQRSTUVWXYZ',
       ABC.alphabetFromSeed(15511210043330985984000000n));
    ok('the rotation BCD...ZA ranks 25! + 24! + … + 1!',
       ABC.seedFromAlphabet(rot) === 16158688114800553828940313n,
       String(ABC.seedFromAlphabet(rot)));
    ok('the last seed is the reversed alphabet',
       ABC.alphabetFromSeed(ABC.factorial(26) - 1n) ===
       ABC.AZ.split('').reverse().join(''));

    /* The two distances, on alphabets whose answers are known. */
    ok('an untouched alphabet is zero under both measures',
       ABC.cayleyDistance(ABC.AZ) === 0 && ABC.kendallTauDistance(ABC.AZ) === 0);
    ok('the rotation is Cayley 25 and Kendall tau 25 — the measures diverge',
       ABC.cayleyDistance(rot) === 25 && ABC.kendallTauDistance(rot) === 25,
       'cayley ' + ABC.cayleyDistance(rot) + ', tau ' + ABC.kendallTauDistance(rot));
    var rev = ABC.AZ.split('').reverse().join('');
    ok('the mirrored alphabet is Cayley 13 and Kendall tau 325, the tau maximum',
       ABC.cayleyDistance(rev) === 13 && ABC.kendallTauDistance(rev) === 325,
       'cayley ' + ABC.cayleyDistance(rev) + ', tau ' + ABC.kendallTauDistance(rev));

    /* The swap sequence rebuilds the alphabet in exactly Cayley-many swaps. */
    (function () {
      var perms = permutations('ABCDEF'), bad = 0, first = '';
      for (var i = 0; i < perms.length; i++) {
        var sw = ABC.swapSequence(perms[i], 'ABCDEF');
        var made = ABC.applySwaps(sw, 'ABCDEF');
        var d = ABC.cayleyDistance(perms[i], 'ABCDEF');
        if (made !== perms[i] || sw.length !== d) {
          if (!bad) first = perms[i] + ': built ' + made + ' in ' + sw.length + ', cayley ' + d;
          bad++;
        }
      }
      ok('[ABCDEF] every swap sequence rebuilds its alphabet in exactly Cayley many swaps',
         bad === 0, bad ? bad + ' wrong, first ' + first : perms.length + ' alphabets');
    })();

    (function () {
      var bad = 0, n = 0;
      for (var s = 0n; s < 4000n; s += 137n) {                // a spread of A–Z
        var a = ABC.alphabetFromSeed(s * 10n ** 20n + s);
        var sw = ABC.swapSequence(a);
        if (ABC.applySwaps(sw) !== a || sw.length !== ABC.cayleyDistance(a)) bad++;
        n++;
      }
      ok('[A–Z] the same holds on full-size alphabets', bad === 0,
         bad ? bad + ' of ' + n + ' wrong' : n + ' alphabets');
    })();

    /* ── The claim itself: the solver against exhaustion ─────────────────── */
    ['ABCDE', 'ABCDEF'].forEach(function (letters) {
      var perms = permutations(letters);
      var all = words(letters, letters.length);
      var cache = {};
      var wrong = 0, unsorted = 0, firstWrong = '';

      for (var i = 0; i < all.length; i++) {
        var w = all[i];
        var got = ABC.alphabetDistance(w, letters);

        var key = ABC.letterOrder(w);
        /* Words no alphabet sorts share one cache entry. The sentinel is
           parenthesised, because a forced order is uppercase letters only and
           cannot collide. */
        key = (key === null) ? '(none)' : key;
        if (cache[key] === undefined) cache[key] = bruteForce(w, letters, perms);
        var want = cache[key];

        if (got !== want) {
          if (!wrong) firstWrong = w + ': solver ' + got + ', brute force ' + want;
          wrong++;
        }
        /* A distance is only as good as the alphabet it came from. */
        if (got !== null) {
          var alpha = ABC.minimalAlphabet(w, letters);
          if (!ABC.isSorted(w, alpha) || ABC.cayleyDistance(alpha, letters) !== got) unsorted++;
        }
      }

      ok('[' + letters + '] the solver matches brute force on every word', wrong === 0,
         wrong ? wrong + ' of ' + all.length + ' wrong, first ' + firstWrong
               : all.length + ' words, ' + Object.keys(cache).length + ' distinct forced orders');
      ok('[' + letters + '] every alphabet it returns really sorts the word at that cost',
         unsorted === 0, unsorted ? unsorted + ' bad' : 'all of them');
    });

    /* ── The parking-space trap, which the naive construction fails ──────── */
    (function () {
      var d = ABC.alphabetDistance('BCA', 'ABCDE');
      ok('forced order B,C,A costs one swap and not two — free letters are parking',
         d === 1, 'distance ' + d + ', alphabet ' + ABC.minimalAlphabet('BCA', 'ABCDE'));
    })();

    /* ── Which words are admissible at all ───────────────────────────────── */
    [['AABB', 'AB'], ['TEE', 'TE'], ['ABAB', null], ['ANNA', null],
     ['BILLOWY', 'BILOWY'], ['', '']].forEach(function (c) {
      ok('forced order of "' + (c[0] || '(empty)') + '" is ' + (c[1] === null ? 'None' : '"' + c[1] + '"'),
         ABC.letterOrder(c[0]) === c[1], String(ABC.letterOrder(c[0])));
    });

    /* The published table. The distance is asserted; the Kendall tau beside it
       is not, because the nearest alphabet is not unique. Tau is a property of
       whichever minimal alphabet the search reaches, so a solver finding an
       equally good one and reporting a different tau is still correct. It is
       printed next to the table's value for comparison; five of the seven
       agree. */
    [['BILLOWY', 0, 0], ['ALMOST', 0, 0], ['TEE', 1, 31], ['ZEBRA', 2, 56],
     ['SPHINX', 2, 62], ['CLAUDE', 3, 87], ['DEUTSCH', 3, 55],
     ['ANNA', null, null],
     ['ZYXWVUTSRQPONMLKJIHGFEDCBA', 13, 325]].forEach(function (c) {
      var p = ABC.profile(c[0]);
      var pass = p.distance === c[1] &&
                 (p.alphabet === null ? c[1] === null : ABC.isSorted(c[0], p.alphabet));
      ok('"' + c[0].toLowerCase() + '" is ' + c[1] + ', by an alphabet that sorts it', pass,
         'got ' + p.distance + ', tau ' + p.kendall + ' (table says ' + c[2] + ')' +
         (p.alphabet ? ' via ' + p.alphabet : ''));
    });

    /* ── What each letter of the root is carrying ───────────────────────────
       Two claims. That taking a letter out can never RAISE the distance is the
       one the page leans on, and it is checked on every root over five and six
       letters rather than argued. That the audit reports what a plain
       recomputation reports is the other, and it is what holds the shortcut
       honest: carry() skips the search entirely for an already-sorted word,
       and this is where that skip has to agree with doing the work. */
    ['ABCDE', 'ABCDEF'].forEach(function (letters) {
      var all = words(letters, letters.length);
      var seen = {}, roots = 0, rose = 0, wrong = 0, first = '';
      for (var i = 0; i < all.length; i++) {
        var c = ABC.carry(all[i], letters);
        if (c === null || seen[c.order]) continue;
        seen[c.order] = true;
        roots++;
        for (var j = 0; j < c.letters.length; j++) {
          var want = ABC.alphabetDistance(c.order.slice(0, j) + c.order.slice(j + 1), letters);
          if (want > c.distance) rose++;
          if (c.letters[j].without !== want || c.letters[j].drop !== c.distance - want) {
            if (!wrong) first = c.order + ' minus ' + c.order[j] + ': audit ' +
                                c.letters[j].without + ', recomputed ' + want;
            wrong++;
          }
        }
      }
      ok('[' + letters + '] taking a letter out of a root never raises its distance',
         rose === 0, rose ? rose + ' raised it' : roots + ' roots');
      ok('[' + letters + '] the per-letter audit agrees with the distances recomputed one at a time',
         wrong === 0, wrong ? wrong + ' wrong, first ' + first : roots + ' roots');
    });

    /* The letters that are carrying, spelled out, and the largest single drop.
       vortex and billowy are both all-free and for different reasons: billowy
       is already sorted and there is nothing to carry, vortex costs a swap
       that no one letter of it accounts for. waltz and flummox are there
       because a letter can be worth more than one swap. */
    [['zebra', 2, 'EB', 1], ['sphinx', 2, 'SP', 1], ['claude', 3, 'AUDE', 1],
     ['waltz', 2, 'WA', 2], ['flummox', 2, 'LUMO', 2],
     ['vortex', 1, '', 0], ['billowy', 0, '', 0]].forEach(function (c) {
      var got = ABC.carry(ABC.normalise(c[0]).word);
      var load = '', big = 0;
      got.letters.forEach(function (l) {
        if (l.drop > 0) load += l.letter;
        if (l.drop > big) big = l.drop;
      });
      ok('"' + c[0] + '" costs ' + c[1] + ', carried by ' +
         (c[2] ? c[2].toLowerCase().split('').join(' and ') : 'no single letter'),
         got.distance === c[1] && load === c[2] && big === c[3],
         'distance ' + got.distance + ', carried by "' + load + '", largest drop ' + big);
    });

    /* Why the page says the drops are not shares. Every letter of vortex is
       free on its own and the swap does not go away; two of them together are
       what it costs. */
    (function () {
      var c = ABC.carry('VORTEX');
      var free = c.letters.filter(function (l) { return l.drop === 0; }).length;
      ok('free is not additive: no letter of vortex carries its swap, and v and e together do',
         c.distance === 1 && free === 6 && ABC.alphabetDistance('ORTX') === 0,
         'distance ' + c.distance + ', ' + free + ' of 6 free, without v and e ' +
         ABC.alphabetDistance('ORTX'));
    })();

    /* ── How many alphabets sort a word: n!/k!, so a share of 1/k! ───────── */
    (function () {
      var letters = 'ABCDEF', perms = permutations(letters), bad = 0;
      var all = words(letters, 4);
      for (var i = 0; i < all.length; i++) {
        var v = ABC.validAlphabets(all[i], letters);
        if (v === null) continue;
        var count = 0;
        for (var j = 0; j < perms.length; j++) if (ABC.isSorted(all[i], perms[j])) count++;
        if (BigInt(count) !== v) bad++;
      }
      ok('[ABCDEF] the count of sorting alphabets is n!/k!, checked one by one',
         bad === 0, bad ? bad + ' wrong' : all.length + ' words');
    })();

    ok('a word using 6 different letters is sorted by one alphabet in 720',
       ABC.factorial(26) / ABC.validAlphabets('SPHINX') === 720n);

    /* ── Normalising the input ───────────────────────────────────────────── */
    [['Schön', 'SCHON', ''], ['grüße', 'GRUSSE', ''], ['zebra', 'ZEBRA', ''],
     ['two words', 'TWO WORDS', ' '], ['x1', 'X1', '1']].forEach(function (c) {
      var r = ABC.normalise(c[0]);
      ok('"' + c[0] + '" folds to "' + c[1] + '"' + (c[2] ? ' and refuses "' + c[2] + '"' : ''),
         r.word === c[1] && r.rejected === c[2], r.word + ' / ' + JSON.stringify(r.rejected));
    });

    return results;
  }

  return { run: run, permutations: permutations, words: words, bruteForce: bruteForce };
})(typeof ABC !== 'undefined' ? ABC : require('./abc.js'));

if (typeof module !== 'undefined') module.exports = ABCTest;

/* node abecedarian/selftest.js */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  var t0 = Date.now();
  var res = ABCTest.run();
  var failed = 0;
  res.forEach(function (r) {
    if (!r.pass) failed++;
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '  ::  ' + r.detail : ''));
  });
  console.log('\n' + (res.length - failed) + ' pass, ' + failed + ' fail, ' +
              ((Date.now() - t0) / 1000).toFixed(1) + 's');
  process.exitCode = failed ? 1 : 0;
}
