// Neuron Bench: the self-test. Runs headless under node — `node
// neuron-bench/js/selftest.js` — and in the browser, where the page calls
// NeuronBenchSelfTest() and prints the same lines.
//
// The gradient check is the one that matters. Everything else in the tool is
// built on backward() being right, and backward() is the only part where being
// subtly wrong still looks plausible: the network trains, the loss falls, and
// the answer is off. So it is checked against finite differences on every
// activation and loss pairing the UI can produce.
//
// Rectifiers need care here. A finite difference straddling the kink at z=0
// measures the average of two different slopes and disagrees with any correct
// analytic gradient, so a coordinate whose perturbation flips the sign of any
// pre-activation is skipped rather than counted as a failure. That is a
// property of the test, not a licence for the code.

(function (root) {
  'use strict';

  const M = typeof MLP !== 'undefined' ? MLP : require('./mlp.js');
  /* data.js reads MLP off the global the way a browser hands it over, so under
     node it has to be there before the file is asked for. */
  const D = typeof Data !== 'undefined' ? Data
    : (function () { globalThis.MLP = M; return require('./data.js'); })();

  function signature(net, X, n, xw) {
    const xs = new Float64Array(xw);
    const s = [];
    for (let r = 0; r < n; r++) {
      for (let i = 0; i < xw; i++) xs[i] = X[r * xw + i];
      M.forward(net, xs);
      for (const l of net.layers) for (let j = 0; j < l.units; j++) s.push(l.z[j] > 0 ? 1 : 0);
    }
    return s.join('');
  }

  function gradientCheck(loss, outAct, hidden, seed) {
    const outUnits = loss === 'bce' ? 1 : loss === 'ce' ? 3 : 2;
    const net = M.create({
      inputs: 3,
      layers: hidden.map((a) => ({ units: 4, act: a })).concat([{ units: outUnits, act: outAct }]),
      loss, seed, init: 'auto'
    });
    const rand = M.rng('d' + seed);
    const n = 6, xw = 3, yw = net.outputs;
    const X = new Float64Array(n * xw), Y = new Float64Array(n * yw);
    for (let i = 0; i < X.length; i++) X[i] = rand() * 2 - 1;
    for (let r = 0; r < n; r++) {
      if (loss === 'mse') for (let k = 0; k < yw; k++) Y[r * yw + k] = rand() * 2 - 1;
      else if (loss === 'bce') Y[r] = rand() < 0.5 ? 0 : 1;
      else Y[r * yw + ((rand() * yw) | 0)] = 1;
    }

    const total = () => {
      const xs = new Float64Array(xw);
      let s = 0;
      for (let r = 0; r < n; r++) {
        for (let i = 0; i < xw; i++) xs[i] = X[r * xw + i];
        const a = M.forward(net, xs);
        s += M.LOSS[loss].value(a, Y.subarray(r * yw, r * yw + yw), yw);
      }
      return s;
    };

    M.zeroGrads(net);
    const xs = new Float64Array(xw);
    for (let r = 0; r < n; r++) {
      for (let i = 0; i < xw; i++) xs[i] = X[r * xw + i];
      M.forward(net, xs);
      M.backward(net, xs, Y.subarray(r * yw, r * yw + yw));
    }
    const analytic = net.layers.map((l) => ({ W: Array.from(l.dW), b: Array.from(l.db) }));

    const eps = 1e-6;
    let worst = 0, checked = 0, skipped = 0;
    for (let li = 0; li < net.layers.length; li++) {
      const l = net.layers[li];
      for (const [arr, grad] of [[l.W, analytic[li].W], [l.b, analytic[li].b]]) {
        for (let i = 0; i < arr.length; i++) {
          const orig = arr[i];
          const s0 = signature(net, X, n, xw);
          arr[i] = orig + eps; const lp = total(); const sp = signature(net, X, n, xw);
          arr[i] = orig - eps; const lm = total(); const sm = signature(net, X, n, xw);
          arr[i] = orig;
          if (s0 !== sp || s0 !== sm) { skipped++; continue; }
          const num = (lp - lm) / (2 * eps);
          const rel = Math.abs(num - grad[i]) / Math.max(1e-8, Math.abs(num) + Math.abs(grad[i]));
          if (rel > worst) worst = rel;
          checked++;
        }
      }
    }
    return { worst, checked, skipped };
  }

  /* Each activation on its own, before any network is built out of it: is the
     derivative the derivative of the function next to it? A wrong df trains to
     something plausible and wrong, and it is far easier to read the failure
     here, one activation at a time, than out of a whole net's gradient.

     z = 0 is skipped for the same reason a straddled kink is skipped below:
     the hinges and the fold have their corner there and the step its jump, and
     a central difference across it measures the average of two slopes. */
  function derivativeCheck(key) {
    const act = M.ACT[key];
    const h = 1e-6;
    let worst = 0, checked = 0;
    for (let i = -40; i <= 40; i++) {
      if (i === 0) continue;
      const z = i * 0.1;
      const num = (act.f(z + h) - act.f(z - h)) / (2 * h);
      const rel = Math.abs(num - act.df(z, act.f(z))) /
        Math.max(1e-6, Math.abs(num) + Math.abs(act.df(z, act.f(z))));
      if (rel > worst) worst = rel;
      checked++;
    }
    return { worst, checked };
  }

  /* A diverging network hands its activation whatever it likes. Anything that
     comes back as NaN takes the rest of the run with it, and a page that stops
     printing numbers teaches nothing, so every f and df has to stay finite out
     to the edges of what a float can hold. */
  function finiteCheck(key) {
    const act = M.ACT[key];
    const wild = [0, 1e-9, -1e-9, 15, -15, 40, -40, 710, -710, 1e30, -1e30, 1e300, -1e300];
    for (const z of wild) {
      const a = act.f(z);
      if (!Number.isFinite(a) || !Number.isFinite(act.df(z, a))) return z;
    }
    return null;
  }

  function run(log) {
    let pass = 0, fail = 0;
    const ok = (name, cond, extra) => {
      if (cond) pass++; else fail++;
      log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);
    };

    log('-- each activation against its own derivative --');
    for (const key of Object.keys(M.ACT)) {
      const r = derivativeCheck(key);
      const wild = finiteCheck(key);
      ok(`${key} differentiates to its df`, r.worst < 1e-6 && wild === null,
        `worst ${r.worst.toExponential(2)} over ${r.checked} points` +
        (wild === null ? ', finite everywhere' : `, NOT FINITE at z=${wild}`));
    }

    log('');
    log('-- gradients against finite differences --');
    const cases = [
      ['mse', 'identity', ['tanh', 'tanh']],
      ['mse', 'identity', ['relu', 'leaky']],
      ['mse', 'identity', ['sigmoid', 'relu']],
      ['mse', 'identity', ['elu', 'softplus']],
      ['mse', 'identity', ['abs', 'gauss']],
      ['mse', 'tanh', ['tanh', 'sigmoid']],
      ['bce', 'sigmoid', ['tanh', 'relu']],
      ['bce', 'sigmoid', ['leaky', 'leaky']],
      ['bce', 'sigmoid', ['silu', 'gelu']],
      ['ce', 'identity', ['relu', 'tanh']],
      ['ce', 'identity', ['tanh', 'tanh']],
      ['ce', 'identity', ['sin', 'elu']]
    ];
    for (const [loss, outAct, hidden] of cases) {
      const r = gradientCheck(loss, outAct, hidden, loss + outAct + hidden.join());
      ok(`${loss} / ${outAct} / ${hidden.join('+')}`, r.worst < 1e-6,
        `worst ${r.worst.toExponential(2)} over ${r.checked} coords, ${r.skipped} at a kink`);
    }

    log('');
    log('-- one identity neuron is ordinary least squares --');
    {
      const rand = M.rng('ols');
      const n = 400;
      const X = new Float64Array(n), Y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = rand() * 4 - 2;
        X[i] = x; Y[i] = 1.7 * x - 0.4 + (rand() * 2 - 1) * 0.3;
      }
      const ls = M.leastSquares(X, Y, n, 1);
      const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;

      const full = M.create({ inputs: 1, layers: [{ units: 1, act: 'identity' }], loss: 'mse', seed: 7 });
      const r1 = M.rng('a');
      for (let e = 0; e < 2000; e++) M.trainEpoch(full, X, Y, n, { lr: 0.1, batchSize: n, momentum: 0.9, order, rand: r1 });
      ok('full-batch descent reaches the closed form',
        Math.abs(full.layers[0].W[0] - ls.weights[0]) < 1e-9 && Math.abs(full.layers[0].b[0] - ls.bias) < 1e-9,
        `w ${full.layers[0].W[0].toFixed(9)} vs ${ls.weights[0].toFixed(9)}`);

      const mini = M.create({ inputs: 1, layers: [{ units: 1, act: 'identity' }], loss: 'mse', seed: 7 });
      const r2 = M.rng('b');
      for (let e = 0; e < 400; e++) M.trainEpoch(mini, X, Y, n, { lr: 0.05, batchSize: 32, momentum: 0.9, order, rand: r2 });
      const gap = Math.abs(mini.layers[0].W[0] - ls.weights[0]);
      ok('mini-batch lands near it but hovers', gap < 0.05 && gap > 1e-6,
        `off by ${gap.toExponential(2)} — the noise floor of a constant step size`);
    }

    log('');
    log('-- XOR: the whole argument for a hidden layer --');
    {
      const X = new Float64Array([0, 0, 0, 1, 1, 0, 1, 1]);
      const Y = new Float64Array([0, 1, 1, 0]);
      const order = new Uint32Array([0, 1, 2, 3]);
      const run1 = (hidden, seed, act) => {
        const layers = hidden
          ? [{ units: hidden, act: act || 'tanh' }, { units: 1, act: 'sigmoid' }]
          : [{ units: 1, act: 'sigmoid' }];
        const net = M.create({ inputs: 2, layers, loss: 'bce', seed });
        const rand = M.rng('x' + seed);
        for (let e = 0; e < 4000; e++) M.trainEpoch(net, X, Y, 4, { lr: 0.5, batchSize: 4, momentum: 0.9, order, rand });
        return M.evaluate(net, X, Y, 4).accuracy;
      };
      let bestSingle = 0, bestPair = 0, folds = 0;
      for (const s of [1, 2, 3, 4, 5, 6]) {
        bestSingle = Math.max(bestSingle, run1(0, s));
        bestPair = Math.max(bestPair, run1(2, s));
        /* The claim the absolute value carries in the menu. A bend of any kind
           needs two units; a fold needs one, because |A − B| is XOR outright.
           It is a bare minimum like the pair above, and fails from a dead start
           as readily, so what is asserted is that it happens and happens often
           — not that it always does. */
        if (run1(1, s, 'abs') === 1) folds++;
      }
      ok('no single neuron ever solves XOR', bestSingle <= 0.75, `best over 6 seeds ${bestSingle}`);
      ok('two hidden units do', bestPair === 1, `best over 6 seeds ${bestPair}`);
      ok('one folded unit does it alone, from most starts', folds >= 3, `${folds} of 6 seeds`);
    }

    log('');
    log('-- the logic gates --');
    {
      const ids = ['and', 'or', 'nand', 'nor', 'xor', 'xnor'];
      const separable = { and: 1, or: 1, nand: 1, nor: 1 };

      /* The reason the cases are repeated. Four rows and a hold-back leaves the
         network to guess a corner nothing else in the set says anything about,
         which is not a thing anybody can infer. */
      let worstMissing = 0;
      for (const id of ids) {
        const ds = D.logic(id);
        for (const frac of [0.25, 0.4, 0.6]) {
          for (const seed of ['1', '2', '3', '4', '5', '6']) {
            const parts = D.split(ds.n, frac, seed);
            const seen = new Set();
            for (const i of parts.train) seen.add(ds.X[i * 2] + ',' + ds.X[i * 2 + 1]);
            worstMissing = Math.max(worstMissing, 4 - seen.size);
          }
        }
      }
      ok('a hold-back never takes a case away from a gate', worstMissing === 0,
        `worst case ${worstMissing} of 4 missing`);

      const settle = (ds, hidden, seed) => {
        const layers = hidden
          ? [{ units: hidden, act: 'tanh' }, { units: 1, act: 'sigmoid' }]
          : [{ units: 1, act: 'sigmoid' }];
        const net = M.create({ inputs: 2, layers, loss: 'bce', seed });
        const order = new Uint32Array(ds.n);
        for (let i = 0; i < ds.n; i++) order[i] = i;
        const rand = M.rng('g' + seed);
        for (let e = 0; e < 600; e++) {
          M.trainEpoch(net, ds.X, ds.Y, ds.n, { lr: 0.5, batchSize: 20, momentum: 0.9, order, rand });
        }
        return M.evaluate(net, ds.X, ds.Y, ds.n).accuracy;
      };

      let worstFlat = 1, bestCurved = 0, bestFixed = 0;
      for (const id of ids) {
        const ds = D.logic(id);
        const flat = Math.max(settle(ds, 0, 1), settle(ds, 0, 2), settle(ds, 0, 3));
        if (separable[id]) worstFlat = Math.min(worstFlat, flat);
        else {
          bestCurved = Math.max(bestCurved, flat);
          bestFixed = Math.max(bestFixed, settle(ds, 2, 1), settle(ds, 2, 2), settle(ds, 2, 3));
        }
      }
      ok('one neuron settles AND, OR, NAND and NOR', worstFlat === 1, `worst of the four ${worstFlat}`);
      ok('one neuron settles neither XOR nor XNOR', bestCurved <= 0.75, `best of the two ${bestCurved}`);
      ok('two hidden units settle both', bestFixed === 1, `best of the two ${bestFixed}`);
    }

    log('');
    log('-- failures a lesson would rely on --');
    {
      const rand = M.rng('fm');
      const n = 200, X = new Float64Array(n * 2), Y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        X[i * 2] = rand() * 2 - 1; X[i * 2 + 1] = rand() * 2 - 1;
        Y[i] = X[i * 2] * X[i * 2 + 1] > 0 ? 1 : 0;
      }
      const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;

      const z = M.create({ inputs: 2, layers: [{ units: 4, act: 'tanh' }, { units: 1, act: 'sigmoid' }], loss: 'bce', seed: 3, init: 'zeros' });
      const rz = M.rng('z');
      for (let e = 0; e < 200; e++) M.trainEpoch(z, X, Y, n, { lr: 0.3, batchSize: 16, order, rand: rz });
      const h = z.layers[0];
      let same = true;
      for (let u = 1; u < h.units; u++)
        for (let i = 0; i < h.fanIn; i++)
          if (Math.abs(h.W[u * h.fanIn + i] - h.W[i]) > 1e-12) same = false;
      ok('zero init leaves every hidden unit identical forever', same);

      const st = M.create({ inputs: 2, layers: [{ units: 4, act: 'step' }, { units: 1, act: 'sigmoid' }], loss: 'bce', seed: 3 });
      const before = Array.from(st.layers[0].W);
      const rs = M.rng('s');
      for (let e = 0; e < 50; e++) M.trainEpoch(st, X, Y, n, { lr: 0.3, batchSize: 16, order, rand: rs });
      ok('a step activation cannot be trained at all',
        before.every((v, i) => Math.abs(v - st.layers[0].W[i]) < 1e-15));

      const d = M.create({ inputs: 2, layers: [{ units: 8, act: 'relu' }, { units: 1, act: 'sigmoid' }], loss: 'bce', seed: 3 });
      const rd = M.rng('d');
      for (let e = 0; e < 60; e++) M.trainEpoch(d, X, Y, n, { lr: 50, batchSize: 16, order, rand: rd });
      const ev = M.evaluate(d, X, Y, n);
      ok('a wild learning rate diverges visibly without going NaN', Number.isFinite(ev.loss),
        `loss ${ev.loss.toFixed(2)}, accuracy ${ev.accuracy.toFixed(2)}`);
    }

    log('');
    log('-- where the weights start --');
    {
      /* A wide layer, so the spread of the drawn weights is the spread the
         formula asked for rather than an accident of eight numbers. */
      const spreadOf = (act) => {
        const net = M.create({ inputs: 400, layers: [{ units: 400, act }], loss: 'mse', seed: 'init:' + act });
        const W = net.layers[0].W;
        let s = 0;
        for (let i = 0; i < W.length; i++) s += W[i] * W[i];
        return Math.sqrt(s / W.length);
      };
      const he = Math.sqrt(2 / 400), xavier = Math.sqrt(1 / 400);
      const near = (v, want) => Math.abs(v - want) / want < 0.05;
      ok('a rectifier starts from He', near(spreadOf('relu'), he) && near(spreadOf('gelu'), he),
        `relu ${spreadOf('relu').toFixed(5)} and gelu ${spreadOf('gelu').toFixed(5)} against ${he.toFixed(5)}`);
      ok('a squashing unit starts from Xavier', near(spreadOf('tanh'), xavier) && near(spreadOf('abs'), xavier),
        `tanh ${spreadOf('tanh').toFixed(5)} against ${xavier.toFixed(5)}`);
      ok('a sine starts wider than either', near(spreadOf('sin'), 3 * xavier),
        `${spreadOf('sin').toFixed(5)} against ${(3 * xavier).toFixed(5)}`);

      const biasesOf = (act) => Array.from(M.create({
        inputs: 4, layers: [{ units: 8, act }, { units: 1, act: 'identity' }], loss: 'mse', seed: 5
      }).layers[0].b);
      ok('a one-sided activation starts every bias at zero',
        biasesOf('relu').every((v) => v === 0) && biasesOf('tanh').every((v) => v === 0));
      ok('an even one starts its centres apart',
        new Set(biasesOf('abs')).size === 8 && new Set(biasesOf('gauss')).size === 8);

      /* And why that is worth doing. A fold is symmetric, so folds sharing a
         centre are one shape in eight widths, and eight of those cannot follow
         a curve any better than one can. */
      const rand = M.rng('folds');
      const n = 250, X = new Float64Array(n), Y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = rand() * 4 - 2;
        X[i] = x; Y[i] = Math.sin(x * 1.6) + x * 0.2;
      }
      const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
      const foldFit = (flatten) => {
        const net = M.create({ inputs: 1, layers: [{ units: 8, act: 'abs' }, { units: 1, act: 'identity' }], loss: 'mse', seed: 2 });
        if (flatten) net.layers[0].b.fill(0);
        const r = M.rng('ff');
        for (let e = 0; e < 800; e++) M.trainEpoch(net, X, Y, n, { lr: 0.05, batchSize: 32, momentum: 0.9, order, rand: r });
        return M.evaluate(net, X, Y, n).loss;
      };
      const apart = foldFit(false), together = foldFit(true);
      ok('folds all on one centre cannot follow a curve, and spread ones can',
        apart < 0.02 && together > 5 * apart,
        `${apart.toExponential(2)} spread against ${together.toExponential(2)} together`);
    }

    log('');
    log('-- the record book --');
    {
      const R = typeof Records !== 'undefined' ? Records : require('./records.js');
      const base = { set: 'spiral', normalise: true, split: 25, seed: '1' };
      ok('the same conditions are the same record',
        R.key(base) === R.key({ set: 'spiral', normalise: true, split: 25, seed: '1' }));
      /* Each of these changes what the number on the scoreboard would mean, so
         each has to start a record of its own rather than overwrite one. */
      const apart = [{ set: 'moons' }, { normalise: false }, { split: 0 }, { seed: '2' }]
        .map((d) => R.key(Object.assign({}, base, d)));
      const distinct = new Set(apart.concat([R.key(base)]));
      ok('a set, a normalisation, a hold-back and a seed each start their own',
        distinct.size === 5, apart.join('  '));
    }

    log('');
    log('-- multiclass --');
    {
      const rand = M.rng('mc');
      const n = 300, k = 3;
      const X = new Float64Array(n * 2), Y = new Float64Array(n * k);
      for (let i = 0; i < n; i++) {
        const c = i % k, ang = (c * 2 * Math.PI) / k;
        X[i * 2] = Math.cos(ang) * 2 + (rand() * 2 - 1) * 0.3;
        X[i * 2 + 1] = Math.sin(ang) * 2 + (rand() * 2 - 1) * 0.3;
        Y[i * k + c] = 1;
      }
      const net = M.create({ inputs: 2, layers: [{ units: 6, act: 'tanh' }, { units: k, act: 'identity' }], loss: 'ce', seed: 11 });
      const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
      const rr = M.rng('mcs');
      for (let e = 0; e < 300; e++) M.trainEpoch(net, X, Y, n, { lr: 0.1, batchSize: 32, order, rand: rr });
      const ev = M.evaluate(net, X, Y, n);
      ok('softmax separates three clusters', ev.accuracy > 0.97, `accuracy ${ev.accuracy.toFixed(3)}`);
    }

    log('');
    log(`${pass} pass, ${fail} fail`);
    return { pass, fail };
  }

  root.NeuronBenchSelfTest = run;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = run;
    if (require.main === module) {
      const r = run(console.log);
      process.exit(r.fail ? 1 : 0);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
