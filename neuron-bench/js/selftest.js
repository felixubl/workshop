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

  function run(log) {
    let pass = 0, fail = 0;
    const ok = (name, cond, extra) => {
      if (cond) pass++; else fail++;
      log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`);
    };

    log('-- gradients against finite differences --');
    const cases = [
      ['mse', 'identity', ['tanh', 'tanh']],
      ['mse', 'identity', ['relu', 'leaky']],
      ['mse', 'identity', ['sigmoid', 'relu']],
      ['mse', 'tanh', ['tanh', 'sigmoid']],
      ['bce', 'sigmoid', ['tanh', 'relu']],
      ['bce', 'sigmoid', ['leaky', 'leaky']],
      ['ce', 'identity', ['relu', 'tanh']],
      ['ce', 'identity', ['tanh', 'tanh']]
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
      const run1 = (hidden, seed) => {
        const layers = hidden
          ? [{ units: hidden, act: 'tanh' }, { units: 1, act: 'sigmoid' }]
          : [{ units: 1, act: 'sigmoid' }];
        const net = M.create({ inputs: 2, layers, loss: 'bce', seed });
        const rand = M.rng('x' + seed);
        for (let e = 0; e < 4000; e++) M.trainEpoch(net, X, Y, 4, { lr: 0.5, batchSize: 4, momentum: 0.9, order, rand });
        return M.evaluate(net, X, Y, 4).accuracy;
      };
      let bestSingle = 0, bestPair = 0;
      for (const s of [1, 2, 3, 4, 5, 6]) {
        bestSingle = Math.max(bestSingle, run1(0, s));
        bestPair = Math.max(bestPair, run1(2, s));
      }
      ok('no single neuron ever solves XOR', bestSingle <= 0.75, `best over 6 seeds ${bestSingle}`);
      ok('two hidden units do', bestPair === 1, `best over 6 seeds ${bestPair}`);
    }

    log('');
    log('-- failures the lessons rely on --');
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
