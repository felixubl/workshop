// Expression Problem Bench: the proof.
//
// The bench prints Python and says it read it. Nothing on the page shows
// whether that is true — a wrong answer in the run table looks exactly as
// convincing as a right one, and a highlighter that quietly drops a character
// looks like nothing at all. So the claims are asserted here against CPython's
// own answers, taken by running `print(expr)` through python3 and pasting what
// came back. `print` rather than `repr` because that is what the bench's tables
// show; for every type but a string the two agree anyway.
//
// Three things are checked:
//
//   the arithmetic   Python's rules, not JavaScript's. True division always
//                    widens to float, // and % follow the divisor's sign, and
//                    ** binds tighter than a unary minus, so -2 ** 2 is -4.
//   the cells        every expression the bench ships, against the value
//                    CPython prints for it.
//   the colouring    the painted source, stripped of its spans, must be the
//                    source it was given. A highlighter that loses a character
//                    is showing the reader a program that was never run.
//
// Runs in the browser through tools/verify/expression-problem.html and under
// node with `node expression-problem/selftest.js`, off one set of assertions.

(function (root) {
  'use strict';

  function run(report) {
    const Py = root.Py;
    const results = [];

    function ok(name, pass, detail) {
      results.push({ name: name, pass: pass, detail: detail || '' });
    }

    // What CPython prints. Every `want` below was produced by running the
    // expression through python3 and copying what print() put out.
    function is(source, bindings, want) {
      let got;
      try {
        got = Py.show(Py.evaluate(source, bindings));
      } catch (error) {
        got = '!' + error.message;
      }
      ok(source, got === want, got === want ? want : `want ${want}, got ${got}`);
    }

    // Transcendental functions come from the host's own library rather than
    // CPython's, and the two are entitled to differ in the last bit. Compared
    // to twelve significant figures, which is far past anything the page shows
    // and far short of claiming they are the same function.
    function near(source, bindings, want) {
      let got;
      try {
        got = Py.evaluate(source, bindings).v;
      } catch (error) {
        ok(source, false, '!' + error.message);
        return;
      }
      const pass = Math.abs(got - want) <= Math.abs(want) * 1e-12;
      ok(source, pass, pass ? String(want) : `want ~${want}, got ${got}`);
    }

    const I = Py.int;

    /* ── Python's arithmetic, where it differs from JavaScript's ───────── */
    is('4 * 3 / 2', {}, '6.0');
    is('7 / 2', {}, '3.5');
    is('6 / 3', {}, '2.0');
    is('7 // 2', {}, '3');
    is('-7 // 2', {}, '-4');
    is('-7 % 3', {}, '2');
    is('7 % -3', {}, '-2');
    is('2 ** 3 ** 2', {}, '512');
    is('-2 ** 2', {}, '-4');
    is('(-2) ** 2', {}, '4');
    is('3 * 2', {}, '6');
    is('3.0 * 2', {}, '6.0');
    is('1 + 2 * 3', {}, '7');
    is('(1 + 2) * 3', {}, '9');
    is('2 == 2.0', {}, 'True');
    is('not 0', {}, 'True');
    is('1 < 2 ', {}, 'True');
    is('abs(-3)', {}, '3');
    is('min(3, 1)', {}, '1');

    /* ── the cells the bench ships ─────────────────────────────────────── */
    near('math.pi * r * r', { r: I(2) }, 12.566370614359172);
    near('2 * math.pi * r', { r: I(2) }, 12.566370614359172);
    is('f"circle r={r}"', { r: I(2) }, 'circle r=2');
    is('a * a', { a: I(3) }, '9');
    is('4 * a', { a: I(3) }, '12');
    is('f"square a={a}"', { a: I(3) }, 'square a=3');
    is('b * h / 2', { b: I(4), h: I(3) }, '6.0');
    near('b + h + math.hypot(b, h)', { b: I(4), h: I(3) }, 12.0);
    is('f"right triangle {b}×{h}"', { b: I(4), h: I(3) }, 'right triangle 4×3');
    near('5 * s * s / (4 * math.tan(math.pi / 5))', { s: I(2) }, 6.881909602355868);
    is('5 * s', { s: I(2) }, '10');
    near('math.pi * a * b', { a: I(3), b: I(2) }, 18.84955592153876);
    near('math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))',
      { a: I(3), b: I(2) }, 15.865437575563961);
    is('True', {}, 'True');
    is('False', {}, 'False');
    is('0', {}, '0');

    /* ── what a cell may not do, and how it says so ────────────────────── */
    is('1 / 0', {}, '!division by zero');
    is('nope', {}, "!name 'nope' is not defined");
    is('1 +', {}, '!the expression stops early');
    is('[1, 2]', {}, '!cannot read [');
    is('math.nope', {}, "!'math' has no attribute 'nope'");

    /* ── the colouring ─────────────────────────────────────────────────── */
    const source = [
      'class Circle:',
      '    def __init__(self, r):',
      '        self.r = r  # the one field',
      '',
      '    def area(self):',
      '        r = self.r',
      '        return math.pi * r * r',
      '',
    ].join('\n');
    const painted = Py.paint(source);
    const bare = painted
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    ok('painting loses nothing', bare === source, bare === source ? '' : 'text changed');
    ok('class is a keyword', /tk-keyword">class</.test(painted));
    ok('the declared name is marked', /tk-declared">Circle</.test(painted));
    ok('self is marked', /tk-soft">self</.test(painted));
    ok('the comment is marked', /tk-comment">/.test(painted));
    ok('a plain name takes no colour', !/tk-[a-z]+">math</.test(painted));
    ok('an operator is marked', /tk-op">\*</.test(painted));

    // An f-string is a string with code in it, and a reader who cannot see the
    // code inside one has been told the wrong thing about f-strings.
    const fpainted = Py.paint('f"circle r={r}"');
    ok('an f-string keeps its quotes as string', /tk-string/.test(fpainted));
    ok('an f-string colours what is inside the braces',
      fpainted.indexOf('tk-string">{</span>') >= 0);

    const passed = results.filter((result) => result.pass).length;
    if (report) report(results, passed, results.length);
    return { results: results, passed: passed, total: results.length };
  }

  root.ExpressionProblemSelftest = { run: run };

  // Under node, run on load and set the exit code.
  if (typeof process !== 'undefined' && process.argv && /selftest\.js$/.test(process.argv[1] || '')) {
    require('./python.js');
    const outcome = run(function (results, passed, total) {
      results.forEach(function (result) {
        if (!result.pass) console.log('FAIL  ' + result.name + '  ::  ' + result.detail);
      });
      console.log(passed + ' pass, ' + (total - passed) + ' fail');
    });
    process.exit(outcome.passed === outcome.total ? 0 : 1);
  }
})(typeof self !== 'undefined' ? self : globalThis);
