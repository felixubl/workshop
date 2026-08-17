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
    view: null,           // main-plot override; null means the dataset's own
    lastMetrics: null,
    best: null,           // the record standing under the current conditions
    recordStamp: null,    // what the record list was last built from
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
    /* The record belongs to the conditions, not to the network, so a rebuild
       re-reads it: changing the hold-back or the seed asks a different question
       and a different record answers it. */
    S.best = Records.get(recordContext());

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
       optimiser, and the whole point of printing the two side by side is that
       there is no gap. */
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
      offerRecord();
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
    if (ds.d === 2) {
      /* Two classes over two inputs can be drawn either way: flat, where colour
         carries the answer, or as a surface, where height does. The gates want
         the surface and the tangled sets want the map, so the dataset says which
         it prefers and the reader can still say otherwise. */
      const want = S.view || (ds.task === 'binary' ? ds.view : null) || 'boundary';
      return want === 'surface' ? 'surface' : 'boundary';
    }
    return 'confusion';
  }

  function drawAll() {
    if (!S.ds) return;
    const o = { normalise: normalising(), reference: S.reference, yaw: S.yaw, pitch: S.pitch, focus: S.focus };
    const view = mainView();

    el('mainCaption').textContent = {
      reg1d: 'The data, and the line the network currently draws through it.',
      surface: S.ds.task === 'binary'
        ? `Height is what the network answers: the probability it puts on ${S.ds.classNames[1]}. The cases sit at the corners, and the dashed square at half height is where it changes its mind. Drag to turn it.`
        : 'Two inputs, so the network is a surface. Drag to turn it.',
      boundary: 'Where the network would put the boundary, banded by how sure it is.',
      scatter: 'More than two inputs, so there is no boundary to draw. This is what it predicted against what was true.',
      confusion: 'More than two inputs, so there is no boundary to draw. Rows are the truth, columns the guess: blue down the diagonal is what it got right, red is everything it mistook for something else.',
      none: ''
    }[view];

    const c = el('mainCanvas');
    if (view === 'reg1d') Draw.regression1D(c, S.ds, S.net, o);
    else if (view === 'surface') Draw.surface3D(c, S.ds, S.net, o);
    else if (view === 'boundary') Draw.boundary2D(c, S.ds, S.net, o);
    else if (view === 'scatter') Draw.predictedVsActual(c, S.ds, S.net, o);
    else if (view === 'confusion') Draw.confusion(c, S.ds, S.net, o);

    syncViewPick(view);
    Draw.loss(el('lossCanvas'), S.history, {
      hasTest: S.prepared && S.prepared.testN > 0,
      best: S.best ? S.best.loss : null
    });
    S.hits = Draw.network(el('netCanvas'), S.net, S.ds, o);
    drawNeuronStrip(o);
    drawActivationFaces();
    syncUnitNote();
    runProbe();
    syncReadouts();
    syncRecords();
  }

  /* The thumbnail beside each layer's menu. Here rather than in the editor that
     builds them, so a change of colour mode repaints them with everything
     else. */
  function drawActivationFaces() {
    for (const cv of el('layers').querySelectorAll('canvas[data-act]')) {
      Draw.activation(cv, cv.dataset.act);
    }
  }

  /* Offered only where both pictures are true of the same thing: two inputs and
     two classes. A regression surface has no flat form, and three classes have
     no single height. */
  function syncViewPick(view) {
    const host = el('viewPick');
    const can = S.ds && S.ds.task === 'binary' && S.ds.d === 2;
    host.hidden = !can;
    if (!can) return;
    for (const b of host.querySelectorAll('button')) {
      b.classList.toggle('is-active', b.dataset.view === view);
    }
  }

  /* ---- the pinned unit -----------------------------------------------------
     One unit can be picked in three places — the diagram, its panel, the row of
     values below — and there is one pin rather than three, so picking it
     anywhere lights it everywhere. Clicking the pinned one lets it go. */

  function focusUnit(layer, unit) {
    const same = S.focus && S.focus.layer === layer && S.focus.unit === unit;
    S.focus = same ? null : { layer, unit };
    scheduleDraw();
  }

  function unitLabel(layer, unit) {
    if (!S.net) return '';
    const last = layer === S.net.layers.length - 1;
    if (last) return S.net.layers[layer].units > 1 ? `output unit ${unit + 1}` : 'the output unit';
    return `hidden layer ${layer + 1}, unit ${unit + 1}`;
  }

  function syncUnitNote() {
    const n = el('unitNote');
    const f = S.focus;
    if (!S.net || !f || !S.net.layers[f.layer] || f.unit >= S.net.layers[f.layer].units) {
      S.focus = null;
      n.hidden = true;
      return;
    }
    const l = S.net.layers[f.layer];
    const names = f.layer === 0 ? S.ds.featureNames : null;
    const show = Math.min(l.fanIn, 6);
    const ins = [];
    for (let i = 0; i < show; i++) {
      ins.push(`${names ? names[i] : 'u' + (i + 1)} ${num(l.W[f.unit * l.fanIn + i], 3)}`);
    }
    let t = `${sentenceCase(unitLabel(f.layer, f.unit))}. Weights in: ${ins.join(', ')}` +
      (l.fanIn > show ? `, and ${l.fanIn - show} more` : '') +
      `. Bias ${num(l.b[f.unit], 3)}.`;
    const nxt = S.net.layers[f.layer + 1];
    if (nxt) {
      const outs = [];
      const showOut = Math.min(nxt.units, 6);
      for (let u = 0; u < showOut; u++) outs.push(num(nxt.W[u * nxt.fanIn + f.unit], 3));
      t += ` What the next layer makes of it: ${outs.join(', ')}` +
        (nxt.units > showOut ? `, and ${nxt.units - showOut} more` : '') + '.';
    }
    n.textContent = t + ' Click it again to unpin it.';
    n.hidden = false;
  }

  function sentenceCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ---- one observation -----------------------------------------------------
     The forward pass for a single row, which is the one thing the plots cannot
     show: they say what the network does everywhere, and this says what it did
     here. Live rather than behind a button, because everything else here is. */

  function buildProbeFields() {
    const host = el('probeFields');
    host.textContent = '';
    if (!S.ds) return;
    for (let j = 0; j < S.ds.d; j++) {
      const grp = document.createElement('div');
      grp.className = 'group';
      const lab = document.createElement('label');
      lab.htmlFor = 'probe' + j;
      lab.textContent = S.ds.featureNames[j];
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.id = 'probe' + j;
      inp.step = 'any';
      inp.value = num(S.ds.xMean[j], 2);
      inp.className = 'nb-probe-field';
      inp.addEventListener('input', runProbe);
      grp.appendChild(lab);
      grp.appendChild(inp);
      host.appendChild(grp);
    }
  }

  function probeRow() {
    const xs = new Array(S.ds.d);
    for (let j = 0; j < S.ds.d; j++) {
      const node = el('probe' + j);
      const v = node ? +node.value : NaN;
      xs[j] = Number.isFinite(v) ? v : 0;
    }
    return xs;
  }

  /* The output unit's own value, which for a normalised regression is in the
     units the network was trained in rather than the ones the answer is read
     in. Naming it after the target would be a lie by one standard deviation,
     so the target's name waits for the answer row underneath. */
  function outputName(u) {
    const ds = S.ds;
    if (ds.task === 'regression') return 'out';
    if (ds.task === 'binary') return 'p(' + ds.classNames[1] + ')';
    return 'p(' + Draw.shortName(ds.classNames[u]) + ')';
  }

  function probeVerdict(out) {
    const ds = S.ds;
    if (ds.task === 'regression') {
      return `${ds.targetName}: ${num(Draw.denorm(out[0], ds, normalising()))}`;
    }
    if (ds.task === 'binary') {
      return `it says ${ds.classNames[out[0] >= 0.5 ? 1 : 0]}`;
    }
    let bi = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[bi]) bi = i;
    return `it says ${Draw.shortName(ds.classNames[bi])}`;
  }

  function runProbe() {
    const host = el('probeOut');
    host.textContent = '';
    if (!S.ds || !S.net || el('probe0') == null) return;

    /* predict() leaves every layer's activations on the network, which is the
       whole point of asking it about one row rather than a grid. */
    const out = Draw.predict(S.net, probeRow(), normalising(), S.ds);

    for (let li = 0; li < S.net.layers.length; li++) {
      const l = S.net.layers[li];
      const last = li === S.net.layers.length - 1;
      const row = document.createElement('div');
      row.className = 'nb-probe-row';
      const lab = document.createElement('span');
      lab.className = 'section-label';
      lab.textContent = last ? 'output' : `hidden layer ${li + 1}`;
      row.appendChild(lab);

      const units = document.createElement('div');
      units.className = 'nb-probe-units';
      const shown = Math.min(l.units, 24);
      for (let u = 0; u < shown; u++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nb-unit';
        if (S.focus && S.focus.layer === li && S.focus.unit === u) b.classList.add('is-focus');
        b.setAttribute('aria-label', 'pin ' + unitLabel(li, u));
        const nm = document.createElement('span');
        nm.textContent = last ? outputName(u) : 'u' + (u + 1);
        const val = document.createElement('code');
        val.textContent = num(l.a[u], 3);
        b.appendChild(nm);
        b.appendChild(val);
        b.addEventListener('click', () => focusUnit(li, u));
        units.appendChild(b);
      }
      row.appendChild(units);
      if (l.units > shown) {
        const more = document.createElement('p');
        more.className = 'nb-more';
        more.textContent = `${l.units - shown} more not shown.`;
        row.appendChild(more);
      }
      host.appendChild(row);
    }

    const verdict = document.createElement('div');
    verdict.className = 'nb-probe-row';
    const lab = document.createElement('span');
    lab.className = 'section-label';
    lab.textContent = 'answer';
    const says = document.createElement('p');
    says.className = 'nb-probe-says';
    says.textContent = probeVerdict(out);
    verdict.appendChild(lab);
    verdict.appendChild(says);
    host.appendChild(verdict);
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

  /* ---- the record book -----------------------------------------------------
     Records.js decides what a record is and where it is kept; this decides how
     it is said. Offered on every snapshot rather than at the end of a run,
     because the lowest the loss ever went is the thing being recorded, and on
     the sets that overfit that moment is somewhere in the middle. Snapshots
     arrive on a wall-clock beat rather than every epoch, so what is kept is the
     lowest the reader was actually shown — which is the honest thing for a
     record to be, and the only one this side of the worker can see. */

  const SESSION_START = Date.now();

  /* Two different CSVs are two different problems and both arrive as 'user'.
     Name, rows and columns is not a hash, but it is enough that one reader's
     two files do not end up sharing a record. */
  function setKey(ds) {
    return ds.id === 'user' ? 'user:' + ds.name + ':' + ds.n + 'x' + ds.d : ds.id;
  }

  function recordContext() {
    return {
      set: setKey(S.ds),
      name: S.ds.name,
      normalise: normalising(),
      split: Math.round(+el('split').value) || 0,
      seed: el('seed').value || '1'
    };
  }

  function archLabel() {
    if (!S.hidden.length) return 'no hidden layer';
    return S.hidden
      .map((l) => Math.max(1, Math.round(l.units)) + '×' + MLP.ACT[l.act].label)
      .join(' + ');
  }

  function conditionsLabel(c, join) {
    return [
      c.normalise ? 'normalised' : 'raw inputs',
      c.split ? c.split + '% held back' : 'nothing held back',
      'seed ' + c.seed
    ].join(join || ' · ');
  }

  function offerRecord() {
    const m = S.lastMetrics;
    if (!S.ds || !m || m.epoch < 1) return;
    /* With nothing held back there is no held-out loss to record, so the
       training loss stands in — and says so, because a training loss is a
       claim about rows the network has already seen. */
    const held = !!(S.prepared && S.prepared.testN > 0);
    const loss = held ? m.testLoss : m.trainLoss;
    if (loss == null || !Number.isFinite(loss)) return;
    const o = opts();
    const offered = Records.offer(recordContext(), {
      loss,
      metric: held ? 'held-out' : 'training',
      accuracy: held ? m.testAcc : m.trainAcc,
      epoch: m.epoch,
      params: S.params,
      arch: archLabel(),
      lr: o.lr, batch: o.batchSize, momentum: o.momentum,
      init: el('init').value
    });
    S.best = offered.record;
  }

  /* A setting is printed as it was typed rather than to a fixed number of
     places: 0.4 is a learning rate, 0.4000 is a measurement. */
  function dial(v) {
    return Number.isFinite(v) ? String(+v.toFixed(4)) : '—';
  }

  function recordHow(r) {
    const bits = [r.metric, r.arch, 'rate ' + dial(r.lr), 'batch ' + r.batch];
    if (r.momentum) bits.push('momentum ' + dial(r.momentum));
    if (r.init && r.init !== 'auto') bits.push('from ' + (r.init === 'zeros' ? 'zeros' : 'much too large'));
    bits.push('epoch ' + r.epoch);
    return bits.join(' · ');
  }

  function syncRecords() {
    if (!S.ds) return;
    const c = recordContext();
    S.best = Records.get(c);
    el('rBest').textContent = S.best ? num(S.best.loss) : '—';

    const note = el('bestNote');
    const conditions = conditionsLabel(c, ', ');
    if (S.best) {
      const acc = S.best.accuracy == null ? '' : `, getting ${(S.best.accuracy * 100).toFixed(1)}% of them right`;
      note.textContent =
        `On ${S.ds.name} — ${conditions} — the lowest ${S.best.metric} loss this browser ` +
        `has reached is ${num(S.best.loss)}${acc}, from ${S.best.arch} at a learning rate of ` +
        `${dial(S.best.lr)}, at epoch ${S.best.epoch}. ` +
        (S.best.t >= SESSION_START ? 'Set in this sitting.' : 'Set on ' + S.best.at + '.');
    } else {
      note.textContent =
        `Nothing recorded on ${S.ds.name} — ${conditions} — yet. Train it once and the lowest ` +
        'loss it reaches is kept here, with the network that reached it.';
    }

    /* The list is rebuilt only when it has actually changed. A run offers a
       record ten times a second and beats itself most of those times, and
       rebuilding a list of buttons at that rate would put a live control under
       the pointer that is replaced before it can be clicked. */
    const held = Records.all();
    const mineKey = Records.key(c);
    const stamp = mineKey + '#' + held.map((i) => i.key + ':' + i.record.loss).join('|');
    el('recordTools').hidden = held.length < 2;
    if (stamp === S.recordStamp) return;
    S.recordStamp = stamp;

    const host = el('recordList');
    host.textContent = '';
    for (const item of held) {
      const r = item.record;
      const li = document.createElement('li');
      li.className = 'nb-record' + (item.key === mineKey ? ' is-current' : '');

      const set = document.createElement('span');
      set.className = 'nb-record-set';
      set.textContent = r.name || r.set;

      const loss = document.createElement('code');
      loss.className = 'nb-record-loss';
      loss.textContent = num(r.loss);

      const how = document.createElement('span');
      how.className = 'nb-record-how';
      how.textContent = recordHow(r);

      const when = document.createElement('span');
      when.className = 'nb-record-when';
      when.textContent = conditionsLabel(r) + ' · ' + r.at;

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'btn-ghost nb-record-forget';
      drop.textContent = 'forget';
      drop.setAttribute('aria-label', 'forget the record on ' + (r.name || r.set));
      drop.addEventListener('click', () => { Records.forget(item.key); syncRecords(); scheduleDraw(); });

      /* The button before the conditions, though it is read after them: the
         conditions take a whole line to themselves, and anything appended past
         them starts a third. */
      li.appendChild(set); li.appendChild(loss); li.appendChild(how);
      li.appendChild(drop); li.appendChild(when);
      host.appendChild(li);
    }
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
      p.className = 'note';
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
        cell.addEventListener('click', () => focusUnit(li, u));
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
      cv.parentNode.classList.toggle('is-focus',
        !!S.focus && S.focus.layer === li && S.focus.unit === u);
      if (twoD) Draw.neuronPanel(cv, fields[li], u);
      else Draw.neuronWeights(cv, S.net, li, u, li === 0 ? S.ds.featureNames : null);
    }
  }

  /* ---- architecture editor ------------------------------------------------
     Thirteen activations is too many for one flat list, so the menu groups
     them by what they do to a total rather than by when they were invented.
     The order of the shelves is the order of the argument: nothing, then
     squashing, then the hinges that replaced it, then the smooth gates that
     replaced those, and last the shapes that are not sigmoid-shaped at all.
     Within a shelf the order is MLP.ACT's own. */

  const ACT_SHELVES = [
    { family: 'plain', label: 'straight and stepped' },
    { family: 'squash', label: 'squashing' },
    { family: 'hinge', label: 'hinges' },
    { family: 'gate', label: 'smooth gates' },
    { family: 'fold', label: 'folds and bumps' }
  ];

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
      for (const shelf of ACT_SHELVES) {
        const keys = Object.keys(MLP.ACT).filter((k) => MLP.ACT[k].family === shelf.family);
        if (!keys.length) continue;
        const grp = document.createElement('optgroup');
        grp.label = shelf.label;
        for (const key of keys) {
          const op = document.createElement('option');
          op.value = key; op.textContent = MLP.ACT[key].label;
          if (key === layer.act) op.selected = true;
          grp.appendChild(op);
        }
        sel.appendChild(grp);
      }
      sel.addEventListener('change', () => { layer.act = sel.value; rebuild(); });
      row.appendChild(sel);

      /* The function itself, beside the name of it. Redrawn from drawAll rather
         than here, so it restyles with the lamp like every other picture. */
      const face = document.createElement('canvas');
      face.className = 'nb-act-face';
      face.dataset.act = layer.act;
      face.setAttribute('aria-label', MLP.ACT[layer.act].label + ': what this layer does to a unit’s total, and the slope of it');
      face.setAttribute('data-tip', 'The bend itself. Solid is the function, dashed is its slope — the part training can see');
      row.appendChild(face);

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

    const allLinear = S.hidden.length > 0 && S.hidden.every((l) => MLP.ACT[l.act].linear);
    const warn = el('linearWarn');
    warn.hidden = !allLinear;
  }

  /* ---- datasets ------------------------------------------------------------ */

  function adoptDataset(ds) {
    S.ds = ds;
    el('dsNote').textContent = ds.note;
    el('dsShape').textContent =
      `${ds.n.toLocaleString()} rows · ${ds.d} input${ds.d === 1 ? '' : 's'} · ` +
      (ds.task === 'regression' ? '1 number out' : `${ds.task === 'binary' ? 2 : ds.k} classes`);
    S.outAct = null;
    S.view = null;
    S.focus = null;
    buildProbeFields();
    rebuild();
  }

  /* Setting a control's value in code does not update the drawn face over it,
     which only listens for events. Dispatching one would re-enter our own
     handler, so the flag marks the difference between the user picking a set
     and the page announcing which one it just loaded. */
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

  /* One line under the training toolbar, and two voices in it. Progress is a
     note; a failure is the page's one red line, the same .hint every other tool
     on the site uses to say what went wrong. */
  function setStatus(text, bad) {
    const n = el('status');
    n.textContent = text || '';
    n.className = bad ? 'hint' : 'note';
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

    el('forgetAll').addEventListener('click', () => {
      Records.clear();
      S.best = null;
      syncRecords();
      scheduleDraw();
    });

    for (const b of el('viewPick').querySelectorAll('button')) {
      b.addEventListener('click', () => { S.view = b.dataset.view; scheduleDraw(); });
    }

    /* The diagram is the third way in to a unit. Draw.network hands back where
       it put every one of them, in the same coordinates the canvas is drawn in,
       so the hit test is a nearest-square-within-its-own-size and nothing more. */
    const nc = el('netCanvas');
    nc.addEventListener('click', (e) => {
      if (!S.hits || !S.hits.length) return;
      const r = nc.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = Infinity;
      for (const hit of S.hits) {
        const d = Math.hypot(hit.x - x, hit.y - y);
        if (d < bd) { bd = d; best = hit; }
      }
      if (best && bd <= Math.max(11, best.r)) focusUnit(best.layer, best.unit);
    });

    /* Turning the surface. Pointer events so it works with a finger. */
    const c = el('mainCanvas');
    let drag = null;
    S.yaw = -0.7; S.pitch = 0.55;
    c.addEventListener('pointerdown', (e) => {
      if (mainView() !== 'surface') return;
      drag = { x: e.clientX, y: e.clientY, yaw: S.yaw, pitch: S.pitch };
      c.setPointerCapture(e.pointerId);
    });
    /* The face nearest the reader follows the pointer, which is the only thing
       a drag on an object can sensibly mean. Yaw is subtracted for it: in
       draw.js the horizontal turn is a rotation of the (x, y) plane by +yaw and
       the near corner is the one with the larger ry, so raising yaw carries the
       near face LEFT while the far face swings right. Pitch is added, which
       already tips the near edge down as the pointer goes down. */
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      S.yaw = drag.yaw - (e.clientX - drag.x) * 0.01;
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
    wire();
    setDataset(el('dataset').value);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
