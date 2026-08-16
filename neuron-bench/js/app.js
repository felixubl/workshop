// Neuron Bench: the page.
//
// State lives in one object, `S`. A change to the architecture rebuilds the
// worker's network from scratch; a change to a hyperparameter does not. That
// distinction is the whole control flow:
//
//   architecture  → rebuild(): new spec, new worker net, history cleared
//   hyperparameter→ nothing until the next epoch reads it
//   dataset       → load, re-derive the output layer, then rebuild()
//
// The worker owns the live network. This file keeps a mirror of it, restored
// from each snapshot, purely so the drawing code has something to call
// forward() on. The mirror is never trained here.

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);

  const S = {
    ds: null,
    hidden: [{ units: 4, act: 'tanh' }],
    outAct: null,
    net: null,
    spec: null,
    history: [],
    running: false,
    ready: false,
    silent: false,
    params: 0,
    worker: null,
    prepared: null,
    reference: null,
    focus: null,          // {layer, unit} pinned in the neuron strip
    lastMetrics: null,
    dirty: false
  };

  const opts = () => ({
    lr: +el('lr').value,
    batchSize: Math.max(1, Math.round(+el('batch').value)),
    momentum: +el('momentum').value,
    clip: 5
  });

  const normalising = () => el('normalise').checked;

  /* ---- the shape of the output layer -------------------------------------
     Not a user choice, because the pairing of output activation and loss is
     what makes the gradient come out as (prediction - target). The tool says
     so rather than hiding it. */

  function outputFor(ds) {
    if (ds.task === 'regression') return { units: 1, act: 'identity', loss: 'mse' };
    if (ds.task === 'binary') return { units: 1, act: 'sigmoid', loss: 'bce' };
    return { units: ds.k, act: 'identity', loss: 'ce' };
  }

  function buildSpec() {
    const out = outputFor(S.ds);
    const act = S.outAct || out.act;
    return {
      inputs: S.ds.d,
      layers: S.hidden.map((l) => ({ units: Math.max(1, Math.round(l.units)), act: l.act }))
        .concat([{ units: out.units, act }]),
      loss: out.loss,
      seed: el('seed').value || '1',
      init: el('init').value
    };
  }

  /* ---- worker lifecycle --------------------------------------------------- */

  function ensureWorker() {
    if (S.worker) return S.worker;
    S.worker = new Worker('js/worker.js');
    S.worker.onmessage = (e) => onWorker(e.data);
    S.worker.onerror = (e) => {
      setStatus('the training thread failed: ' + (e.message || 'unknown error'), true);
      S.running = false;
      syncButtons();
    };
    return S.worker;
  }

  function rebuild() {
    if (!S.ds) return;
    const spec = buildSpec();
    S.spec = spec;
    S.net = MLP.create(spec);
    S.params = MLP.paramCount(S.net);
    S.history = [];
    S.lastMetrics = null;
    S.running = false;
    S.ready = false;

    const prep = Data.prepare(S.ds, normalising());
    const frac = +el('split').value / 100;
    const parts = Data.split(S.ds.n, frac, el('seed').value || '1');
    const d = S.ds.d, k = S.net.outputs;
    S.prepared = {
      trainX: Data.gather(prep.X, parts.train, d),
      trainY: Data.gather(prep.Y, parts.train, k),
      trainN: parts.train.length,
      testX: Data.gather(prep.X, parts.test, d),
      testY: Data.gather(prep.Y, parts.test, k),
      testN: parts.test.length
    };

    /* The closed-form line has to be fitted on exactly the rows the network
       trains on, not on the whole set. Comparing a neuron trained on 75% with a
       regression fitted on 100% would show a gap that is the split, not the
       optimiser, and the whole point of the first lesson is that there is no
       gap. */
    S.reference = S.ds.task === 'regression' && S.ds.d === 1
      ? MLP.leastSquares(Data.gather(S.ds.X, parts.train, 1),
                         Data.gather(S.ds.Y, parts.train, 1), parts.train.length, 1)
      : null;

    ensureWorker().postMessage(Object.assign({ type: 'init', spec }, S.prepared));
    buildNeuronStrip();
    syncArchitectureUI();
    scheduleDraw();
  }

  function onWorker(m) {
    if (m.type === 'ready') {
      S.ready = true;
      S.params = m.params;
      S.running = false;
    } else if (m.type === 'progress') {
      S.ready = true;
    } else if (m.type === 'done') {
      S.running = false;
      if (m.reason === 'diverged') {
        setStatus('the loss stopped being a number. The learning rate is too large for this network — halve it and reset.', true);
      } else if (m.reason === 'reached') {
        setStatus('finished ' + m.epoch + ' epochs.');
      } else {
        setStatus('stopped at epoch ' + m.epoch + '.');
      }
    }

    if (m.snapshot && S.net) {
      MLP.restore(S.net, m.snapshot);
      S.lastMetrics = {
        epoch: m.epoch, trainLoss: m.trainLoss, trainAcc: m.trainAcc,
        testLoss: m.testLoss, testAcc: m.testAcc
      };
      const last = S.history[S.history.length - 1];
      if (!last || last.epoch !== m.epoch) S.history.push(S.lastMetrics);
      if (S.history.length > 4000) S.history = S.history.filter((_, i) => i % 2 === 0);
    }
    syncButtons();
    scheduleDraw();
  }

  /* ---- drawing ------------------------------------------------------------
     One rAF-throttled pass redraws everything visible. Cheap enough because
     each view is a few thousand forward passes at most, and it keeps the
     picture honest: nothing on screen is ever from a different epoch than
     anything else. */

  let pending = false;
  function scheduleDraw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; drawAll(); });
  }

  function mainView() {
    const ds = S.ds;
    if (!ds) return 'none';
    if (ds.task === 'regression') {
      if (ds.d === 1) return 'reg1d';
      if (ds.d === 2) return 'surface';
      return 'scatter';
    }
    if (ds.d === 2) return 'boundary';
    return 'confusion';
  }

  function drawAll() {
    if (!S.ds) return;
    const o = { normalise: normalising(), reference: S.reference, yaw: S.yaw, pitch: S.pitch };
    const view = mainView();

    el('mainCaption').textContent = {
      reg1d: 'The data, and the line the network currently draws through it.',
      surface: 'Two inputs, so the network is a surface. Drag to turn it.',
      boundary: 'Where the network would put the boundary, banded by how sure it is.',
      scatter: 'More than two inputs, so there is no boundary to draw. This is what it predicted against what was true.',
      confusion: 'More than two inputs, so there is no boundary to draw. Rows are the truth, columns the guess.',
      none: ''
    }[view];

    const c = el('mainCanvas');
    if (view === 'reg1d') Draw.regression1D(c, S.ds, S.net, o);
    else if (view === 'surface') Draw.surface3D(c, S.ds, S.net, o);
    else if (view === 'boundary') Draw.boundary2D(c, S.ds, S.net, o);
    else if (view === 'scatter') Draw.predictedVsActual(c, S.ds, S.net, o);
    else if (view === 'confusion') Draw.confusion(c, S.ds, S.net, o);

    Draw.loss(el('lossCanvas'), S.history, { hasTest: S.prepared && S.prepared.testN > 0 });
    S.hits = Draw.network(el('netCanvas'), S.net, S.ds, o);
    drawNeuronStrip(o);
    syncReadouts();
  }

  /* ---- readouts ----------------------------------------------------------- */

  function num(v, dp) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
    return v.toFixed(dp == null ? 4 : dp);
  }

  function syncReadouts() {
    const m = S.lastMetrics;
    el('rEpoch').textContent = m ? m.epoch : 0;
    el('rParams').textContent = S.params.toLocaleString();
    el('rTrain').textContent = m ? num(m.trainLoss) : '—';
    el('rTest').textContent = m && m.testLoss != null ? num(m.testLoss) : '—';
    const accRow = el('accRow');
    if (m && m.trainAcc != null) {
      accRow.hidden = false;
      el('rTrainAcc').textContent = (m.trainAcc * 100).toFixed(1) + '%';
      el('rTestAcc').textContent = m.testAcc == null ? '—' : (m.testAcc * 100).toFixed(1) + '%';
    } else accRow.hidden = true;

    const ref = el('refRow');
    if (S.reference && S.ds && S.ds.d === 1 && S.net && S.ds.task === 'regression') {
      ref.hidden = false;
      const wOut = recoveredLine();
      el('rLine').textContent = wOut
        ? `y = ${num(wOut.w, 3)}·x ${wOut.b >= 0 ? '+' : '−'} ${num(Math.abs(wOut.b), 3)}`
        : 'more than one neuron — no single line to read off';
      el('rOls').textContent = `y = ${num(S.reference.weights[0], 3)}·x ${S.reference.bias >= 0 ? '+' : '−'} ${num(Math.abs(S.reference.bias), 3)}`;
    } else ref.hidden = true;
  }

  /* With one identity neuron and normalisation on, the weight the network
     holds is in normalised units. Undoing that is the step that lets the
     network's answer be compared with the textbook one at all, and it is the
     same algebra the original single-neuron write-up does by hand. */
  function recoveredLine() {
    if (!S.net || S.net.layers.length !== 1) return null;
    const l = S.net.layers[0];
    if (l.units !== 1 || l.act !== 'identity') return null;
    const ds = S.ds;
    if (!normalising()) return { w: l.W[0], b: l.b[0] };
    const w = (l.W[0] * ds.yStd[0]) / ds.xStd[0];
    const b = ds.yMean[0] + ds.yStd[0] * l.b[0] - w * ds.xMean[0];
    return { w, b };
  }

  /* ---- the neuron strip --------------------------------------------------- */

  function buildNeuronStrip() {
    const host = el('neurons');
    host.textContent = '';
    if (!S.net) return;
    const hiddenCount = S.net.layers.length - 1;
    if (hiddenCount < 1) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No hidden layer. The output unit is the whole network — whatever it computes is what you see above.';
      host.appendChild(p);
      return;
    }
    for (let li = 0; li < hiddenCount; li++) {
      const l = S.net.layers[li];
      const wrap = document.createElement('div');
      wrap.className = 'nb-layer';
      const head = document.createElement('p');
      head.className = 'section-label';
      head.textContent = `hidden layer ${li + 1} · ${l.units} × ${MLP.ACT[l.act].label}`;
      wrap.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'nb-grid';
      const shown = Math.min(l.units, 16);
      for (let u = 0; u < shown; u++) {
        const cell = document.createElement('figure');
        cell.className = 'nb-cell';
        const cv = document.createElement('canvas');
        cv.dataset.layer = li; cv.dataset.unit = u;
        const cap = document.createElement('figcaption');
        cap.textContent = 'unit ' + (u + 1);
        cell.appendChild(cv); cell.appendChild(cap);
        grid.appendChild(cell);
      }
      wrap.appendChild(grid);
      if (l.units > shown) {
        const more = document.createElement('p');
        more.className = 'nb-more';
        more.textContent = `${l.units - shown} more not drawn.`;
        wrap.appendChild(more);
      }
      host.appendChild(wrap);
    }
  }

  function drawNeuronStrip(o) {
    if (!S.net) return;
    const twoD = S.ds.d === 2;
    el('neuronNote').textContent = twoD
      ? 'Each panel is one hidden unit, drawn over the same axes as the plot above: dark where that unit fires. Units in a layer share one scale, so a pale panel is a unit barely contributing and a blank one is a unit that has died. The network can only build its answer out of these.'
      : 'With more than two inputs there is nothing to draw the unit over, so each panel is what the unit actually is: one weight per input, and a bias. Bars right are positive, left negative.';

    /* One field per layer rather than one per panel: the units share a scale,
       and the grid is walked once instead of once per unit. */
    const fields = twoD
      ? S.net.layers.slice(0, -1).map((_, li) => Draw.layerField(S.ds, S.net, li, o))
      : null;

    const canvases = el('neurons').querySelectorAll('canvas');
    for (const cv of canvases) {
      const li = +cv.dataset.layer, u = +cv.dataset.unit;
      if (twoD) Draw.neuronPanel(cv, fields[li], u);
      else Draw.neuronWeights(cv, S.net, li, u, li === 0 ? S.ds.featureNames : null);
    }
  }

  /* ---- architecture editor ------------------------------------------------ */

  function syncArchitectureUI() {
    const host = el('layers');
    host.textContent = '';
    S.hidden.forEach((layer, i) => {
      const row = document.createElement('div');
      row.className = 'group nb-layer-row';

      const label = document.createElement('label');
      label.textContent = 'layer ' + (i + 1);
      row.appendChild(label);

      const n = document.createElement('input');
      n.type = 'number'; n.min = '1'; n.max = '2048'; n.step = '1';
      n.value = layer.units;
      n.setAttribute('data-tip', 'How many neurons in this layer');
      n.addEventListener('change', () => {
        layer.units = Math.max(1, Math.round(+n.value) || 1);
        n.value = layer.units;
        rebuild();
      });
      row.appendChild(n);

      const sel = document.createElement('select');
      sel.setAttribute('data-tip', 'The bend this layer applies');
      for (const key of ['identity', 'sigmoid', 'tanh', 'relu', 'leaky', 'step']) {
        const op = document.createElement('option');
        op.value = key; op.textContent = MLP.ACT[key].label;
        if (key === layer.act) op.selected = true;
        sel.appendChild(op);
      }
      sel.addEventListener('change', () => { layer.act = sel.value; rebuild(); });
      row.appendChild(sel);

      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'btn-ghost';
      rm.textContent = 'remove';
      rm.addEventListener('click', () => { S.hidden.splice(i, 1); rebuild(); });
      row.appendChild(rm);

      host.appendChild(row);
    });

    const out = outputFor(S.ds);
    el('outputNote').textContent = S.ds.task === 'regression'
      ? `Output: 1 unit, identity, mean squared error. Identity because the answer is a number and squashing it would cap what the network can say.`
      : S.ds.task === 'binary'
        ? `Output: 1 unit, sigmoid, binary cross-entropy. That pairing is what makes the output gradient come out as simply (prediction − target).`
        : `Output: ${out.units} units, softmax, cross-entropy. Softmax makes the ${out.units} outputs a set of probabilities that add to one.`;

    const act = MLP.ACT[S.hidden.length ? S.hidden[S.hidden.length - 1].act : 'identity'];
    el('actNote').textContent = S.hidden.length ? act.note : '';

    const allLinear = S.hidden.length > 0 && S.hidden.every((l) => l.act === 'identity');
    const warn = el('linearWarn');
    warn.hidden = !allLinear;
  }

  /* ---- lessons ------------------------------------------------------------
     Each one is a configuration plus the reason it is worth looking at. They
     set the controls and rebuild; nothing is hidden from the user afterwards,
     so a lesson is a starting point rather than a mode. */

  const LESSONS = [
    {
      id: 'ols', title: 'A neuron is a linear regression',
      dataset: 'ash', hidden: [], lr: 0.5, batch: 8192, epochs: 900, split: 25, seed: '1',
      normalise: true, init: 'auto',
      say: 'One neuron, identity activation, nothing hidden. Train it and the line it walks to is the same line the closed-form least squares gives — the two are printed side by side and they agree to every digit shown. Gradient descent is not doing anything mysterious here; it is arriving at the textbook answer the slow way.'
    },
    {
      id: 'noscale', title: 'The same thing, unnormalised',
      dataset: 'ash', hidden: [], lr: 0.5, batch: 8192, epochs: 900, split: 25, seed: '1',
      normalise: false, init: 'auto',
      say: 'Identical, except the inputs keep their real units. Planting years near 1990 and trunk circumferences near 100 cm produce gradients of wildly different sizes, and one learning rate cannot suit both. It does not converge slowly. It fails.'
    },
    {
      id: 'bend', title: 'A straight line cannot bend',
      dataset: 'curve', hidden: [], lr: 0.4, batch: 8192, epochs: 800, split: 25, seed: '1',
      normalise: true, init: 'auto',
      say: 'The data curves. One identity neuron can only ever produce a straight line, so it settles for the best straight line available — exactly the one least squares gives, printed beside it — and that line is visibly not the answer. Nothing is broken and no amount of training will help. The model cannot express the shape.'
    },
    {
      id: 'bend2', title: 'Give it something that bends',
      dataset: 'curve', hidden: [{ units: 6, act: 'tanh' }], lr: 0.15, batch: 32, epochs: 800, split: 25, seed: '1',
      normalise: true, init: 'auto',
      say: 'Six tanh units, then the same output neuron. Each unit contributes one soft bend and the output adds them up. Look at the panels underneath: the curve above is literally a weighted sum of those six shapes.'
    },
    {
      id: 'xor1', title: 'XOR: one neuron cannot',
      dataset: 'xor', hidden: [], lr: 0.5, batch: 4, epochs: 3000, split: 0, seed: '1',
      normalise: false, init: 'auto',
      say: 'Four points, nothing held back. A single neuron draws one straight boundary, and no straight line puts the two diagonal pairs on opposite sides. It settles at 50% and a loss of 0.693, which is exactly ln 2 — the loss of a model that has given up and guesses. This is the failure that stalled the field for a decade.'
    },
    {
      id: 'xor2', title: 'Two neurons fix it',
      dataset: 'xor', hidden: [{ units: 2, act: 'tanh' }], lr: 0.5, batch: 4, epochs: 3000, split: 0, seed: '3',
      normalise: false, init: 'auto',
      say: 'One hidden layer of two. Each draws its own straight line; the output neuron combines them into a region no single line could carve out. The two panels below are those two lines. Loss goes to nearly nothing and accuracy to 100%.'
    },
    {
      id: 'xor3', title: 'The same network, a worse start',
      dataset: 'xor', hidden: [{ units: 2, act: 'tanh' }], lr: 0.5, batch: 4, epochs: 3000, split: 0, seed: '1',
      normalise: false, init: 'auto',
      say: 'Identical to the last one except the seed, so the weights start somewhere else. It sticks at 50% and a loss of about 0.347, and it will stay there however long you run it or however large you make the learning rate — this is a local minimum, not slow progress. Two units is the exact theoretical minimum for XOR and it is fragile; raise the layer to three and it succeeds from almost anywhere. Solvable in principle and solvable in practice are different claims.'
    },
    {
      id: 'dead', title: 'Dead ReLU',
      dataset: 'moons', hidden: [{ units: 8, act: 'relu' }], lr: 4, batch: 16, epochs: 400, split: 25, seed: '1',
      normalise: true, init: 'auto',
      say: 'ReLU with a learning rate far too high. A unit pushed negative for every input has a gradient of exactly zero from then on, so it stops being part of the network. Watch panels below go flat and stay flat: those units are gone, and the survivors have to cover for them. Leaky ReLU keeps a sliver of slope on the left precisely to avoid this.'
    },
    {
      id: 'zeros', title: 'Every neuron the same',
      dataset: 'moons', hidden: [{ units: 8, act: 'tanh' }], lr: 0.3, batch: 16, epochs: 400, split: 25, seed: '1',
      normalise: true, init: 'zeros',
      say: 'Start every weight at zero and every unit in a layer receives exactly the same gradient, forever. Eight units, all identical, so the network has the expressive power of one. Every panel below is the same picture. This is why initialisation is random.'
    },
    {
      id: 'ceiling', title: 'Real data has a ceiling',
      dataset: 'two-species', hidden: [{ units: 32, act: 'tanh' }, { units: 32, act: 'tanh' }], lr: 0.08, batch: 32, epochs: 2500, split: 92, seed: '1',
      normalise: true, init: 'auto',
      say: 'Two real species told apart by trunk and height alone, and deliberately starved: 92% of the rows are held back, so about a thousand examples are being fitted by about twelve hundred weights. Watch the two loss curves separate. The training loss keeps falling because the network is memorising rows it has seen; the held-out loss stops improving and turns upward, because those memorised rows say nothing about the ones it has not seen. The species genuinely overlap, so there is a ceiling here that no amount of network gets past — and a bigger network makes the gap worse, not better.'
    },
    {
      id: 'spiral', title: 'When you actually need depth',
      dataset: 'spiral', hidden: [{ units: 16, act: 'tanh' }, { units: 16, act: 'tanh' }], lr: 0.12, batch: 32, epochs: 2000, split: 25, seed: '1',
      normalise: true, init: 'auto',
      say: 'Two interleaved arms. Remove the second hidden layer and watch one layer of sixteen fail at it, then put the layer back. This is the case where depth rather than width is what buys the answer.'
    },
    {
      id: 'blind', title: 'Four inputs, nothing to look at',
      dataset: 'species', hidden: [{ units: 16, act: 'tanh' }], lr: 0.1, batch: 64, epochs: 800, split: 25, seed: '1',
      normalise: true, init: 'auto',
      say: 'Four measurements, four species. At four dimensions there is no boundary to draw, which is the ordinary situation in practice rather than a special case. What is left is the confusion matrix — which species get mistaken for which — and the per-unit weights, which say what each neuron is actually watching.'
    }
  ];

  function applyLesson(lesson) {
    el('split').value = lesson.split;
    el('seed').value = lesson.seed;
    el('lr').value = lesson.lr;
    el('batch').value = lesson.batch;
    el('epochs').value = lesson.epochs;
    el('normalise').checked = lesson.normalise;
    el('init').value = lesson.init;
    S.hidden = lesson.hidden.map((l) => ({ units: l.units, act: l.act }));
    el('lessonSay').textContent = lesson.say;
    el('lessonSay').hidden = false;
    for (const b of el('lessons').querySelectorAll('button')) {
      b.classList.toggle('is-active', b.dataset.lesson === lesson.id);
    }
    setDataset(lesson.dataset).then(() => {
      // controls.js mirrors native values into its drawn faces on input events
      for (const id of ['lr', 'batch', 'epochs', 'init', 'normalise', 'split', 'seed']) {
        el(id).dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  function buildLessons() {
    const host = el('lessons');
    for (const l of LESSONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-ghost preset';
      b.textContent = l.title;
      b.dataset.lesson = l.id;
      b.addEventListener('click', () => applyLesson(l));
      host.appendChild(b);
    }
  }

  /* ---- datasets ------------------------------------------------------------ */

  function adoptDataset(ds) {
    S.ds = ds;
    el('dsNote').textContent = ds.note;
    el('dsShape').textContent =
      `${ds.n.toLocaleString()} rows · ${ds.d} input${ds.d === 1 ? '' : 's'} · ` +
      (ds.task === 'regression' ? '1 number out' : `${ds.task === 'binary' ? 2 : ds.k} classes`);
    S.outAct = null;
    rebuild();
  }

  /* Setting a control's value in code does not update the drawn face over it,
     which only listens for events. Dispatching one would re-enter our own
     handler, so the flag marks the difference between the user picking a set
     and a lesson announcing which one it just loaded. */
  function setSelectSilently(id, value) {
    const n = el(id);
    if (n.value === value) return;
    S.silent = true;
    n.value = value;
    n.dispatchEvent(new Event('change', { bubbles: true }));
    S.silent = false;
  }

  function setDataset(id) {
    setStatus('loading…');
    return Data.load(id).then((ds) => {
      setSelectSilently('dataset', id);
      adoptDataset(ds);
      setStatus('');
    }).catch((err) => {
      setStatus(err.message, true);
    });
  }

  function setStatus(text, bad) {
    const n = el('status');
    n.textContent = text || '';
    n.classList.toggle('is-bad', !!bad);
    n.hidden = !text;
  }

  /* ---- buttons ------------------------------------------------------------- */

  function syncButtons() {
    el('train').textContent = S.running ? 'stop' : 'train';
    el('step').disabled = S.running || !S.ready;
    el('reset').disabled = S.running;
  }

  function wire() {
    el('dataset').addEventListener('change', () => {
      if (S.silent) return;
      setDataset(el('dataset').value);
    });

    el('addLayer').addEventListener('click', () => {
      const last = S.hidden[S.hidden.length - 1];
      S.hidden.push({ units: last ? last.units : 4, act: last ? last.act : 'tanh' });
      rebuild();
    });

    for (const id of ['normalise', 'split', 'seed', 'init']) {
      el(id).addEventListener('change', rebuild);
    }

    el('train').addEventListener('click', () => {
      if (!S.ready) return;
      if (S.running) {
        S.worker.postMessage({ type: 'stop' });
        S.running = false;
      } else {
        const target = Math.max(1, Math.round(+el('epochs').value));
        setStatus('');
        S.running = true;
        S.worker.postMessage({
          type: 'start', opts: opts(),
          until: (S.lastMetrics ? S.lastMetrics.epoch : 0) + target
        });
      }
      syncButtons();
    });

    el('step').addEventListener('click', () => {
      if (!S.ready || S.running) return;
      S.worker.postMessage({ type: 'step', opts: opts() });
    });

    el('reset').addEventListener('click', () => { setStatus(''); rebuild(); });

    /* Turning the surface. Pointer events so it works with a finger. */
    const c = el('mainCanvas');
    let drag = null;
    S.yaw = -0.7; S.pitch = 0.55;
    c.addEventListener('pointerdown', (e) => {
      if (mainView() !== 'surface') return;
      drag = { x: e.clientX, y: e.clientY, yaw: S.yaw, pitch: S.pitch };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      S.yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
      S.pitch = Math.max(-0.2, Math.min(1.4, drag.pitch + (e.clientY - drag.y) * 0.006));
      scheduleDraw();
    });
    const endDrag = () => { drag = null; };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    /* CSV in */
    const drop = el('drop');
    const file = el('file');
    file.addEventListener('change', () => {
      if (file.files && file.files[0]) readFile(file.files[0]);
    });
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
      e.preventDefault(); drop.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => {
      e.preventDefault(); drop.classList.remove('drag-over');
    }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f);
    });
    el('usePaste').addEventListener('click', () => {
      const text = el('paste').value.trim();
      if (!text) { setStatus('nothing pasted yet', true); return; }
      loadCsv(text, 'Pasted data');
    });

    window.addEventListener('resize', scheduleDraw);
    new MutationObserver(() => { Draw.invalidateColours(); scheduleDraw(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  }

  function readFile(f) {
    f.text().then((t) => loadCsv(t, f.name)).catch(() => setStatus('could not read that file', true));
  }

  function loadCsv(text, name) {
    try {
      const ds = Data.fromCsv(text, name);
      setSelectSilently('dataset', '');
      adoptDataset(ds);
      setStatus('');
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function buildDatasetOptions() {
    const sel = el('dataset');
    for (const grp of Data.catalogue) {
      const g = document.createElement('optgroup');
      g.label = grp.group;
      for (const it of grp.items) {
        const o = document.createElement('option');
        o.value = it.id; o.textContent = it.label;
        g.appendChild(o);
      }
      sel.appendChild(g);
    }
    sel.value = 'ash';
  }

  function start() {
    buildDatasetOptions();
    buildLessons();
    wire();
    applyLesson(LESSONS[0]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
