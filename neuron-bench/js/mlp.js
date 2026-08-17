// Neuron Bench: the network itself. No DOM, no drawing, no data loading — this
// file knows how to build a multilayer perceptron, run it forward, and push a
// gradient back through it. Everything else in the tool is a view onto it.
//
// A layer is a flat Float64Array of weights in row-major [unit][input] order
// plus a bias per unit. Flat arrays rather than arrays-of-arrays because the
// inner loop runs millions of times and this is the shape the JIT keeps in
// registers.
//
// The one deliberate omission is any cap on size. A network is as big as the
// machine will carry: the tool is partly about letting someone find that edge
// for themselves.

var MLP = (function () {
  'use strict';

  /* ---- randomness ---------------------------------------------------------
     Seeded so a lesson reproduces exactly. Same mulberry32/xmur3 pair the
     Random Number Generator uses, for the same reason: short, seedable, and
     good enough that nobody has to think about it. */

  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rng(seed) {
    return mulberry32(xmur3(String(seed))());
  }

  /* Standard normal from uniforms, for weight init. */
  function gauss(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---- activations --------------------------------------------------------
     `df` takes both the pre-activation z and the activation a, because some
     derivatives are far cheaper from a (sigmoid, tanh) and others need z
     (relu at exactly 0). Passing both costs nothing and keeps every entry the
     same shape.

     Two fields beyond the maths. `gain` is what 'auto' initialisation
     multiplies 1/sqrt(fanIn) by: sqrt(2) for anything that throws half its
     input away, which would otherwise halve the variance with it, and 1 —
     plain Xavier — for anything that keeps both signs. `family` is the shelf
     the menu puts it on, and nothing else reads it.

     Every f here has to stay finite for any z a diverging network can produce,
     which is why the large-z branches exist: a NaN would take the whole run
     with it, and the tool would rather show a bad answer than no answer. */

  const GELU_C = Math.sqrt(2 / Math.PI);
  const GELU_A = 0.044715;

  const ACT = {
    identity: {
      label: 'identity', family: 'plain', linear: true,
      f: (z) => z,
      df: () => 1,
      note: 'No bend. A layer of these can only ever be a linear map, however many you stack.'
    },
    step: {
      label: 'step', family: 'plain',
      f: (z) => (z > 0 ? 1 : 0),
      df: () => 0,
      note: 'The 1950s perceptron. Included to be instructive: its gradient is zero everywhere, so gradient descent cannot train it at all.'
    },
    sigmoid: {
      label: 'sigmoid', family: 'squash',
      f: (z) => 1 / (1 + Math.exp(-z)),
      df: (z, a) => a * (1 - a),
      note: 'Squashes to (0,1). Saturates: once a unit is far from zero its gradient is nearly nothing.'
    },
    tanh: {
      label: 'tanh', family: 'squash',
      f: (z) => Math.tanh(z),
      df: (z, a) => 1 - a * a,
      note: 'Squashes to (-1,1), centred on zero, which usually trains faster than sigmoid.'
    },
    relu: {
      label: 'ReLU', family: 'hinge', gain: Math.SQRT2,
      f: (z) => (z > 0 ? z : 0),
      df: (z) => (z > 0 ? 1 : 0),
      note: 'A hinge at zero. Cheap and rarely saturates upward, but a unit pushed negative for every input is dead and stays dead.'
    },
    leaky: {
      label: 'leaky ReLU', family: 'hinge', gain: Math.SQRT2,
      f: (z) => (z > 0 ? z : 0.01 * z),
      df: (z) => (z > 0 ? 1 : 0.01),
      note: 'A hinge that keeps a sliver of slope on the left, so a unit that goes negative can still come back.'
    },
    elu: {
      label: 'ELU', family: 'hinge', gain: Math.SQRT2,
      f: (z) => (z > 0 ? z : Math.expm1(z)),
      /* exp(z) - 1 differentiates to exp(z), which is a + 1 */
      df: (z, a) => (z > 0 ? 1 : a + 1),
      note: 'A hinge whose left half curves down to −1 rather than lying flat. A unit on the negative side keeps a little slope to climb back on, and its output stays near zero on average, which the next layer prefers.'
    },
    softplus: {
      label: 'softplus', family: 'hinge', gain: Math.SQRT2,
      /* log(1+e^z) is z to full precision long before e^z overflows */
      f: (z) => (z > 30 ? z : Math.log1p(Math.exp(z))),
      df: (z) => 1 / (1 + Math.exp(-z)),
      note: 'ReLU with the corner rounded off: smooth everywhere and never exactly zero, so no unit can die. It also never switches fully off, which gives up the one thing the hard hinge is liked for.'
    },
    silu: {
      label: 'SiLU (swish)', family: 'gate', gain: Math.SQRT2,
      f: (z) => z / (1 + Math.exp(-z)),
      df: (z) => {
        const s = 1 / (1 + Math.exp(-z));
        return s * (1 + z * (1 - s));
      },
      note: 'The input times its own sigmoid, so a unit fades in instead of switching on, and dips a little below zero just left of the origin. That dip makes it non-monotonic, which sounds like a mistake and trains better than ReLU.'
    },
    gelu: {
      label: 'GELU', family: 'gate', gain: Math.SQRT2,
      /* The tanh approximation from the original paper rather than the exact
         erf form: it is what the transformers actually run, and it is a closed
         form we can differentiate exactly, which the finite-difference check
         in the self-test insists on. */
      f: (z) => {
        if (z > 15) return z;
        if (z < -15) return 0;
        return 0.5 * z * (1 + Math.tanh(GELU_C * (z + GELU_A * z * z * z)));
      },
      df: (z) => {
        if (z > 15) return 1;
        if (z < -15) return 0;
        const t = Math.tanh(GELU_C * (z + GELU_A * z * z * z));
        return 0.5 * (1 + t) + 0.5 * z * (1 - t * t) * GELU_C * (1 + 3 * GELU_A * z * z);
      },
      note: 'The one in the transformers. It scales each input by roughly the chance a standard normal lands below it, so small values are damped rather than cut off. Drawn here by the usual tanh approximation.'
    },
    abs: {
      label: 'absolute value', family: 'fold', even: true,
      f: (z) => Math.abs(z),
      df: (z) => (z > 0 ? 1 : z < 0 ? -1 : 0),
      note: 'A fold rather than a bend: both halves rise. |A − B| is XOR outright, so one unit of this can settle it alone where no single bend of any kind can — and being the bare minimum it also starts dead about a third of the time, which two units never do.'
    },
    gauss: {
      label: 'Gaussian bump', family: 'fold', even: true,
      f: (z) => Math.exp(-z * z),
      df: (z, a) => -2 * z * a,
      note: 'A bump rather than a step: the unit answers to a band and ignores everything either side of it. Two such bands crossing make a patch, which is how a radial basis network covers a space — by pieces that are somewhere rather than halves that go on forever.'
    },
    sin: {
      label: 'sine', family: 'fold', gain: 3,
      f: (z) => Math.sin(z),
      df: (z) => Math.cos(z),
      note: 'Periodic, so one unit carries a whole ripple rather than one bend, and a wave takes startlingly few neurons. It starts from larger weights than the others for that to be true at all, and every hill being as good as the next it settles into a bad one just as readily.'
    }
  };

  /* ---- losses -------------------------------------------------------------
     Each pairs with the output activation that makes its gradient collapse to
     (prediction - target). That cancellation is not a trick, it is why these
     pairings are the standard ones, and the tool says so in the UI. */

  const LOSS = {
    mse: {
      label: 'mean squared error',
      outputs: (net) => net.outputs,
      /* 0.5*(a-y)^2 summed over outputs, so dL/da is exactly (a-y) */
      value: (a, y, n) => {
        let s = 0;
        for (let i = 0; i < n; i++) { const d = a[i] - y[i]; s += d * d; }
        return 0.5 * s;
      },
      /* with an identity output layer this is also dL/dz */
      grad: (a, y, n, out) => { for (let i = 0; i < n; i++) out[i] = a[i] - y[i]; }
    },
    bce: {
      label: 'binary cross-entropy',
      outputs: () => 1,
      value: (a, y, n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const p = Math.min(1 - 1e-12, Math.max(1e-12, a[i]));
          s -= y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p);
        }
        return s;
      },
      /* paired with a sigmoid output, dL/dz is (a-y) */
      grad: (a, y, n, out) => { for (let i = 0; i < n; i++) out[i] = a[i] - y[i]; }
    },
    ce: {
      label: 'cross-entropy',
      outputs: (net) => net.outputs,
      value: (a, y, n) => {
        let s = 0;
        for (let i = 0; i < n; i++) if (y[i] > 0) s -= y[i] * Math.log(Math.max(1e-12, a[i]));
        return s;
      },
      /* paired with softmax, dL/dz is (a-y) */
      grad: (a, y, n, out) => { for (let i = 0; i < n; i++) out[i] = a[i] - y[i]; }
    }
  };

  function softmax(z, n, out) {
    let m = -Infinity;
    for (let i = 0; i < n; i++) if (z[i] > m) m = z[i];
    let s = 0;
    for (let i = 0; i < n; i++) { out[i] = Math.exp(z[i] - m); s += out[i]; }
    for (let i = 0; i < n; i++) out[i] /= s;
  }

  /* ---- construction -------------------------------------------------------

     spec = {
       inputs:  number of input features
       layers:  [{ units, act }]   the last entry is the output layer
       loss:    'mse' | 'bce' | 'ce'
       seed:    anything stringable
       init:    'auto' | 'zeros' | 'big'
     }

     `init` is a teaching control as much as a setting. 'zeros' shows why
     symmetric initialisation makes every unit in a layer learn the same thing
     forever; 'big' shows saturation. 'auto' reads the gain off the activation —
     He for the rectifiers, Xavier for the rest — which is what anyone would
     actually want. */

  function create(spec) {
    const layers = [];
    let fanIn = spec.inputs;
    const rand = rng(spec.seed == null ? 1 : spec.seed);

    for (const l of spec.layers) {
      const units = l.units;
      const W = new Float64Array(units * fanIn);
      const b = new Float64Array(units);
      const act = l.act || 'tanh';
      const mode = spec.init || 'auto';

      let scale;
      if (mode === 'zeros') scale = 0;
      else if (mode === 'big') scale = 8;
      else scale = ((ACT[act] && ACT[act].gain) || 1) * Math.sqrt(1 / fanIn);

      for (let i = 0; i < W.length; i++) W[i] = gauss(rand) * scale;

      /* Biases start at zero, which is the usual thing and right for anything
         one-sided: a hinge at the origin still faces two ways depending on the
         sign of its weights. An even activation does not. A fold or a bump is
         symmetric about z = 0, so a layer of them with every bias at zero is a
         layer of the same shape drawn at the same place in different widths —
         eight neurons with the power of about one, which is the failure the
         'all zeros' setting exists to show. So their centres are spread
         instead, by one unit of z, which is where a normalised input puts
         them. */
      if (mode === 'auto' && ACT[act] && ACT[act].even) {
        for (let j = 0; j < b.length; j++) b[j] = gauss(rand);
      }

      layers.push({
        units, fanIn, W, b, act,
        dW: new Float64Array(units * fanIn),
        db: new Float64Array(units),
        vW: new Float64Array(units * fanIn),   // momentum
        vb: new Float64Array(units),
        z: new Float64Array(units),
        a: new Float64Array(units),
        delta: new Float64Array(units)
      });
      fanIn = units;
    }

    return {
      inputs: spec.inputs,
      outputs: layers[layers.length - 1].units,
      layers,
      loss: spec.loss || 'mse',
      softmaxOut: (spec.loss || 'mse') === 'ce',
      seed: spec.seed,
      init: spec.init || 'auto',
      epoch: 0,
      history: []
    };
  }

  /* Total learnable parameters, which is the number people actually want to
     see next to "how big is this thing". */
  function paramCount(net) {
    let n = 0;
    for (const l of net.layers) n += l.W.length + l.b.length;
    return n;
  }

  /* ---- forward ------------------------------------------------------------
     Writes into each layer's own scratch buffers and returns the final
     activation array. Not reentrant, by design: one net, one forward pass at a
     time, no allocation per sample. */

  function forward(net, x) {
    let input = x;
    for (let li = 0; li < net.layers.length; li++) {
      const l = net.layers[li];
      const last = li === net.layers.length - 1;
      const fn = ACT[l.act].f;
      const { W, b, z, a, units, fanIn } = l;

      for (let j = 0; j < units; j++) {
        let s = b[j];
        const base = j * fanIn;
        for (let i = 0; i < fanIn; i++) s += W[base + i] * input[i];
        z[j] = s;
      }

      if (last && net.softmaxOut) softmax(z, units, a);
      else for (let j = 0; j < units; j++) a[j] = fn(z[j]);

      input = a;
    }
    return input;
  }

  /* ---- backward -----------------------------------------------------------
     Accumulates into dW/db; the caller applies them. Assumes `forward` has
     just run on this same x. */

  function backward(net, x, y) {
    const L = net.layers;
    const outL = L[L.length - 1];

    LOSS[net.loss].grad(outL.a, y, outL.units, outL.delta);

    /* The output pairing (mse+identity, bce+sigmoid, ce+softmax) makes dL/dz
       exactly (a-y). Anything else and we still owe the activation derivative. */
    const paired =
      (net.loss === 'mse' && outL.act === 'identity') ||
      (net.loss === 'bce' && outL.act === 'sigmoid') ||
      (net.loss === 'ce' && net.softmaxOut);
    if (!paired) {
      const df = ACT[outL.act].df;
      for (let j = 0; j < outL.units; j++) outL.delta[j] *= df(outL.z[j], outL.a[j]);
    }

    for (let li = L.length - 1; li >= 0; li--) {
      const l = L[li];
      const prev = li > 0 ? L[li - 1].a : x;
      const { delta, dW, db, units, fanIn } = l;

      for (let j = 0; j < units; j++) {
        const d = delta[j];
        if (d === 0) { db[j] += 0; continue; }
        db[j] += d;
        const base = j * fanIn;
        for (let i = 0; i < fanIn; i++) dW[base + i] += d * prev[i];
      }

      if (li > 0) {
        const p = L[li - 1];
        const df = ACT[p.act].df;
        p.delta.fill(0);
        for (let j = 0; j < units; j++) {
          const d = delta[j];
          if (d === 0) continue;
          const base = j * fanIn;
          for (let i = 0; i < fanIn; i++) p.delta[i] += l.W[base + i] * d;
        }
        for (let i = 0; i < p.units; i++) p.delta[i] *= df(p.z[i], p.a[i]);
      }
    }
  }

  function zeroGrads(net) {
    for (const l of net.layers) { l.dW.fill(0); l.db.fill(0); }
  }

  /* Averaged over the batch, then a momentum step. Gradient clipping is on by
     default because without it a too-large learning rate produces NaN rather
     than the visible divergence that actually teaches something. */
  function applyGrads(net, batchSize, lr, momentum, clip) {
    const scale = 1 / batchSize;
    for (const l of net.layers) {
      for (let i = 0; i < l.dW.length; i++) {
        let g = l.dW[i] * scale;
        if (clip > 0) g = g > clip ? clip : g < -clip ? -clip : g;
        l.vW[i] = momentum * l.vW[i] - lr * g;
        l.W[i] += l.vW[i];
      }
      for (let j = 0; j < l.db.length; j++) {
        let g = l.db[j] * scale;
        if (clip > 0) g = g > clip ? clip : g < -clip ? -clip : g;
        l.vb[j] = momentum * l.vb[j] - lr * g;
        l.b[j] += l.vb[j];
      }
    }
  }

  /* ---- data ---------------------------------------------------------------
     X and Y are flat Float64Arrays of n rows; the caller keeps the widths. */

  function evaluate(net, X, Y, n) {
    if (n === 0) return { loss: 0, accuracy: null };
    const lossFn = LOSS[net.loss];
    const outN = net.outputs;
    const xw = net.inputs;
    const xs = new Float64Array(xw);
    let total = 0, correct = 0;
    const classify = net.loss === 'ce' || net.loss === 'bce';

    for (let r = 0; r < n; r++) {
      for (let i = 0; i < xw; i++) xs[i] = X[r * xw + i];
      const a = forward(net, xs);
      total += lossFn.value(a, Y.subarray(r * outN, r * outN + outN), outN);
      if (classify) {
        if (net.loss === 'bce') {
          if ((a[0] >= 0.5 ? 1 : 0) === Y[r * outN]) correct++;
        } else {
          let bi = 0, bv = -Infinity, ti = 0, tv = -Infinity;
          for (let k = 0; k < outN; k++) {
            if (a[k] > bv) { bv = a[k]; bi = k; }
            if (Y[r * outN + k] > tv) { tv = Y[r * outN + k]; ti = k; }
          }
          if (bi === ti) correct++;
        }
      }
    }
    return { loss: total / n, accuracy: classify ? correct / n : null };
  }

  /* One pass over the training set in shuffled mini-batches. Returns nothing;
     the caller reads net.history. Kept as a single epoch so the worker can
     interleave progress messages between epochs without threading a callback
     through the inner loop. */
  function trainEpoch(net, X, Y, n, opts) {
    const lr = opts.lr;
    const batchSize = Math.max(1, Math.min(opts.batchSize || 32, n));
    const momentum = opts.momentum == null ? 0.9 : opts.momentum;
    const clip = opts.clip == null ? 5 : opts.clip;
    const order = opts.order;
    const rand = opts.rand;
    const xw = net.inputs, yw = net.outputs;
    const xs = new Float64Array(xw);

    for (let i = n - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }

    for (let start = 0; start < n; start += batchSize) {
      const end = Math.min(n, start + batchSize);
      zeroGrads(net);
      for (let k = start; k < end; k++) {
        const r = order[k];
        for (let i = 0; i < xw; i++) xs[i] = X[r * xw + i];
        forward(net, xs);
        backward(net, xs, Y.subarray(r * yw, r * yw + yw));
      }
      applyGrads(net, end - start, lr, momentum, clip);
    }
    net.epoch++;
  }

  /* ---- inspection ---------------------------------------------------------
     What the drawing code needs: the whole activation stack for one input, and
     a fast path for scoring a grid of inputs. */

  function activations(net, x) {
    forward(net, x);
    return net.layers.map((l) => Array.from(l.a));
  }

  /* Every layer's activations for a whole grid at once, laid out per layer as
     a flat array of [point][unit]. The decision-boundary and per-neuron views
     are both reading this, so it runs once per redraw rather than twice. */
  function fieldsOverGrid(net, points, count) {
    const xw = net.inputs;
    const xs = new Float64Array(xw);
    const out = net.layers.map((l) => new Float64Array(count * l.units));
    for (let p = 0; p < count; p++) {
      for (let i = 0; i < xw; i++) xs[i] = points[p * xw + i];
      forward(net, xs);
      for (let li = 0; li < net.layers.length; li++) {
        const l = net.layers[li];
        out[li].set(l.a, p * l.units);
      }
    }
    return out;
  }

  /* A snapshot small enough to post between worker and page every frame. */
  function snapshot(net) {
    return {
      epoch: net.epoch,
      layers: net.layers.map((l) => ({
        units: l.units, fanIn: l.fanIn, act: l.act,
        W: Array.from(l.W), b: Array.from(l.b)
      }))
    };
  }

  function restore(net, snap) {
    net.epoch = snap.epoch;
    for (let i = 0; i < snap.layers.length; i++) {
      net.layers[i].W.set(snap.layers[i].W);
      net.layers[i].b.set(snap.layers[i].b);
    }
  }

  /* ---- closed forms, for the lessons -------------------------------------
     Ordinary least squares by the normal equations, so the tool can put the
     analytical answer next to the one gradient descent walked to. Solved with
     Gauss-Jordan on the (p+1) square system, which is ample for the handful of
     features anything here will have. */

  function leastSquares(X, Y, n, p) {
    const m = p + 1;
    const A = new Float64Array(m * m);
    const bv = new Float64Array(m);
    const row = new Float64Array(m);
    for (let r = 0; r < n; r++) {
      row[0] = 1;
      for (let i = 0; i < p; i++) row[i + 1] = X[r * p + i];
      const y = Y[r];
      for (let i = 0; i < m; i++) {
        bv[i] += row[i] * y;
        for (let j = 0; j < m; j++) A[i * m + j] += row[i] * row[j];
      }
    }
    for (let c = 0; c < m; c++) {
      let piv = c;
      for (let r = c + 1; r < m; r++) if (Math.abs(A[r * m + c]) > Math.abs(A[piv * m + c])) piv = r;
      if (Math.abs(A[piv * m + c]) < 1e-12) return null;
      if (piv !== c) {
        for (let j = 0; j < m; j++) { const t = A[c * m + j]; A[c * m + j] = A[piv * m + j]; A[piv * m + j] = t; }
        const t = bv[c]; bv[c] = bv[piv]; bv[piv] = t;
      }
      const d = A[c * m + c];
      for (let j = 0; j < m; j++) A[c * m + j] /= d;
      bv[c] /= d;
      for (let r = 0; r < m; r++) {
        if (r === c) continue;
        const f = A[r * m + c];
        if (f === 0) continue;
        for (let j = 0; j < m; j++) A[r * m + j] -= f * A[c * m + j];
        bv[r] -= f * bv[c];
      }
    }
    return { bias: bv[0], weights: Array.from(bv.subarray(1)) };
  }

  return {
    ACT, LOSS,
    create, paramCount, forward, backward,
    zeroGrads, applyGrads, trainEpoch, evaluate,
    activations, fieldsOverGrid, snapshot, restore,
    leastSquares, rng
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MLP;
