// Neuron Bench: where the numbers come from.
//
// Three sources, one shape. The Vienna tree registry, a handful of synthetic
// sets whose right answer is known in advance, and whatever CSV somebody
// pastes in. Everything downstream sees the same object, so the network never
// learns which it is looking at.
//
// A dataset holds raw values, not normalised ones. Normalisation is a step the
// user can switch off, because switching it off is one of the lessons: with
// planting years around 1990 and trunk circumferences around 100, a learning
// rate that suits one is hopeless for the other, and the failure is much more
// convincing seen than described.

var Data = (function () {
  'use strict';

  const TREES_URL = 'data/baumkataster.csv';
  const SPECIES = [
    'Acer platanoides', 'Aesculus hippocastanum', 'Celtis australis',
    'Tilia cordata', 'Platanus x acerifolia', 'Fraxinus excelsior',
    'Acer pseudoplatanus', 'Tilia platyphyllos'
  ];
  const COMMON = {
    'Acer platanoides': 'Norway maple',
    'Aesculus hippocastanum': 'horse chestnut',
    'Celtis australis': 'nettle tree',
    'Tilia cordata': 'small-leaved lime',
    'Platanus x acerifolia': 'London plane',
    'Fraxinus excelsior': 'common ash',
    'Acer pseudoplatanus': 'sycamore maple',
    'Tilia platyphyllos': 'large-leaved lime'
  };

  /* The registry records height and crown as banded codes rather than metres.
     Showing the band midpoint is honest about the resolution and keeps the
     axis in units somebody can picture. */
  const HEIGHT_M = { 1: 3, 2: 8, 3: 13, 4: 18, 5: 23, 6: 28, 7: 33 };
  const CROWN_M = { 1: 1.5, 2: 4.5, 3: 7.5, 4: 10.5, 5: 13.5, 6: 16.5, 7: 19.5, 8: 22.5 };

  let treeRows = null;

  function parseCsv(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cells = [];
      let cur = '', q = false;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (q) {
          if (ch === '"') { if (line[c + 1] === '"') { cur += '"'; c++; } else q = false; }
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',' || ch === ';' || ch === '\t') { cells.push(cur); cur = ''; }
        else cur += ch;
      }
      cells.push(cur);
      out.push(cells);
    }
    return out;
  }

  function loadTrees() {
    if (treeRows) return Promise.resolve(treeRows);
    return fetch(TREES_URL).then((r) => {
      if (!r.ok) throw new Error('tree data unavailable (' + r.status + ')');
      return r.text();
    }).then((t) => {
      const rows = parseCsv(t);
      const out = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (r.length < 6) continue;
        out.push({
          species: +r[0], year: +r[1], circ: +r[2],
          height: +r[3], crown: +r[4], district: +r[5]
        });
      }
      treeRows = out;
      return out;
    });
  }

  function make(spec) {
    const d = spec.featureNames.length;
    const k = spec.task === 'multiclass' ? spec.classNames.length : 1;
    return Object.assign({
      d, k, n: spec.X.length / d,
      task: spec.task, classNames: spec.classNames || null
    }, spec);
  }

  /* ---- statistics ---------------------------------------------------------
     Kept on the dataset rather than recomputed, because every axis label and
     every un-normalised readout in the UI needs them. */

  function stats(ds) {
    const { X, Y, n, d, k } = ds;
    const xMean = new Float64Array(d), xStd = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      let s = 0; for (let i = 0; i < n; i++) s += X[i * d + j];
      xMean[j] = s / n;
      let v = 0; for (let i = 0; i < n; i++) { const e = X[i * d + j] - xMean[j]; v += e * e; }
      xStd[j] = Math.sqrt(v / n) || 1;
    }
    const yMean = new Float64Array(k), yStd = new Float64Array(k);
    for (let j = 0; j < k; j++) {
      let s = 0; for (let i = 0; i < n; i++) s += Y[i * k + j];
      yMean[j] = s / n;
      let v = 0; for (let i = 0; i < n; i++) { const e = Y[i * k + j] - yMean[j]; v += e * e; }
      yStd[j] = Math.sqrt(v / n) || 1;
    }
    ds.xMean = xMean; ds.xStd = xStd; ds.yMean = yMean; ds.yStd = yStd;
    ds.xMin = new Float64Array(d); ds.xMax = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { const v = X[i * d + j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      ds.xMin[j] = lo; ds.xMax[j] = hi;
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < Y.length; i++) { if (Y[i] < lo) lo = Y[i]; if (Y[i] > hi) hi = Y[i]; }
    ds.yMin = lo; ds.yMax = hi;
    return ds;
  }

  /* Targets are only ever normalised for regression. Scaling a 0/1 label or a
     one-hot row would break the loss it is paired with. */
  function prepare(ds, normalise) {
    const { X, Y, n, d, k } = ds;
    const Xn = new Float64Array(X.length), Yn = new Float64Array(Y.length);
    if (normalise) {
      for (let i = 0; i < n; i++)
        for (let j = 0; j < d; j++)
          Xn[i * d + j] = (X[i * d + j] - ds.xMean[j]) / ds.xStd[j];
    } else Xn.set(X);

    if (normalise && ds.task === 'regression') {
      for (let i = 0; i < n; i++)
        for (let j = 0; j < k; j++)
          Yn[i * k + j] = (Y[i * k + j] - ds.yMean[j]) / ds.yStd[j];
    } else Yn.set(Y);

    return { X: Xn, Y: Yn };
  }

  /* A deterministic split, so "it did better this time" is never the seed. */
  function split(n, testFrac, seed) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const rand = MLP.rng('split' + seed);
    for (let i = n - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    const nTest = Math.max(0, Math.min(n - 1, Math.round(n * testFrac)));
    return { test: idx.slice(0, nTest), train: idx.slice(nTest) };
  }

  function gather(src, idx, width) {
    const out = new Float64Array(idx.length * width);
    for (let i = 0; i < idx.length; i++)
      for (let j = 0; j < width; j++)
        out[i * width + j] = src[idx[i] * width + j];
    return out;
  }

  /* ---- synthetic sets -----------------------------------------------------
     Each one exists to make a specific point, and the note says which. */

  function xor() {
    return stats(make({
      id: 'xor', name: 'XOR',
      note: 'Four points. No straight line separates the filled from the hollow, so no single neuron can ever get this right, however long it trains. Two hidden units can.',
      task: 'binary',
      featureNames: ['input A', 'input B'], targetName: 'class',
      classNames: ['0', '1'],
      X: new Float64Array([0, 0, 0, 1, 1, 0, 1, 1]),
      Y: new Float64Array([0, 1, 1, 0])
    }));
  }

  function synth(id, name, note, n, seed, fn) {
    const rand = MLP.rng(seed);
    const X = new Float64Array(n * 2), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = fn(rand, i, n);
      X[i * 2] = p[0]; X[i * 2 + 1] = p[1]; Y[i] = p[2];
    }
    return stats(make({
      id, name, note, task: 'binary',
      featureNames: ['x', 'y'], targetName: 'class', classNames: ['0', '1'], X, Y
    }));
  }

  function circles() {
    return synth('circles', 'Rings',
      'One class surrounds the other. A straight boundary cannot do it; a few hidden units bend one around.',
      400, 'ring', (rand) => {
        const inner = rand() < 0.5;
        const r = inner ? rand() * 0.8 : 1.6 + rand() * 0.8;
        const a = rand() * Math.PI * 2;
        return [Math.cos(a) * r + (rand() - 0.5) * 0.15, Math.sin(a) * r + (rand() - 0.5) * 0.15, inner ? 1 : 0];
      });
  }

  function spiral() {
    return synth('spiral', 'Spiral',
      'Two interleaved arms. This is the one that needs real depth or real width — it is where a network that looked fine on the rings starts to fail.',
      500, 'spi', (rand, i, n) => {
        const c = i % 2;
        const t = (i / n) * 4.2 + 0.4;
        const a = t * 2.2 + c * Math.PI;
        const r = t * 0.75;
        return [Math.cos(a) * r + (rand() - 0.5) * 0.25, Math.sin(a) * r + (rand() - 0.5) * 0.25, c];
      });
  }

  function moons() {
    return synth('moons', 'Two moons',
      'Curved but not tangled. A small hidden layer handles it, and it is a good place to watch each unit claim a piece of the boundary.',
      400, 'moon', (rand, i) => {
        const c = i % 2;
        const a = rand() * Math.PI;
        const x = Math.cos(a) * 1.4 + (c ? 0.7 : -0.7);
        const y = (c ? -1 : 1) * Math.sin(a) * 1.0 + (c ? 0.45 : -0.45);
        return [x + (rand() - 0.5) * 0.35, y + (rand() - 0.5) * 0.35, c];
      });
  }

  function noisyLine() {
    const rand = MLP.rng('line');
    const n = 200;
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = rand() * 8 - 4;
      X[i] = x;
      Y[i] = 2.4 * x - 1.1 + (rand() + rand() + rand() - 1.5) * 1.6;
    }
    return stats(make({
      id: 'line', name: 'A straight line with noise',
      note: 'Made by y = 2.4x - 1.1 plus noise, so the right answer is known. One identity neuron should find those two numbers and nothing else can improve on them.',
      task: 'regression', featureNames: ['x'], targetName: 'y', X, Y
    }));
  }

  function curve() {
    const rand = MLP.rng('curve');
    const n = 250;
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = rand() * 8 - 4;
      X[i] = x;
      Y[i] = Math.sin(x * 1.1) * 2.2 + x * 0.3 + (rand() - 0.5) * 0.5;
    }
    return stats(make({
      id: 'curve', name: 'A curve',
      note: 'A straight line is the best a single identity neuron can do here, and it is visibly not good enough. Add hidden units with a bend in them and watch the fit follow.',
      task: 'regression', featureNames: ['x'], targetName: 'y', X, Y
    }));
  }

  /* ---- the tree registry --------------------------------------------------

     The ash regression is the one from the ml-single-neuron repo, kept
     deliberately: it is the case where a neuron and a textbook regression give
     the same two numbers, and having it here means that claim is checkable
     rather than asserted. */

  function ashRegression(rows) {
    const sel = rows.filter((r) => r.species === 5 && r.year > 1900 && r.circ > 0);
    const n = sel.length;
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) { X[i] = sel[i].year; Y[i] = sel[i].circ; }
    return stats(make({
      id: 'ash', name: 'Ash trees: planting year to trunk',
      note: 'Every common ash in the Vienna registry. Older trees are thicker, near enough to a straight line, which is why this is the first thing a single neuron should be pointed at. Leave normalisation off and it will not learn at all: the years are around 1990 and the trunks around 100.',
      task: 'regression', featureNames: ['planting year'], targetName: 'trunk circumference (cm)',
      X, Y
    }));
  }

  function treeSurface(rows) {
    const sel = rows.filter((r) => r.year > 1900 && r.circ > 0 && r.height > 0);
    const n = sel.length;
    const X = new Float64Array(n * 2), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      X[i * 2] = sel[i].year;
      X[i * 2 + 1] = HEIGHT_M[sel[i].height] || sel[i].height * 5;
      Y[i] = sel[i].circ;
    }
    return stats(make({
      id: 'surface', name: 'Trees: year and height to trunk',
      note: 'Two inputs, so what the network computes is a surface rather than a line. Height is recorded in bands, which is why the points sit in rows — real data has a resolution and this one shows it.',
      task: 'regression', featureNames: ['planting year', 'height (m)'], targetName: 'trunk circumference (cm)',
      X, Y
    }));
  }

  function twoSpecies(rows) {
    const sel = rows.filter((r) => (r.species === 0 || r.species === 1) && r.circ > 0 && r.height > 0);
    const n = sel.length;
    const X = new Float64Array(n * 2), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      X[i * 2] = sel[i].circ;
      X[i * 2 + 1] = HEIGHT_M[sel[i].height] || sel[i].height * 5;
      Y[i] = sel[i].species === 1 ? 1 : 0;
    }
    return stats(make({
      id: 'two-species', name: 'Maple or chestnut',
      note: 'Two real species from trunk and height alone. They overlap, heavily, so perfect accuracy is not available at any size — a network that claims it has memorised the training set. This is the honest one: watch the test score stop improving while the training score keeps going.',
      task: 'binary', featureNames: ['trunk circumference (cm)', 'height (m)'],
      targetName: 'species', classNames: [SPECIES[0] + ' (' + COMMON[SPECIES[0]] + ')', SPECIES[1] + ' (' + COMMON[SPECIES[1]] + ')'],
      X, Y
    }));
  }

  function speciesMulti(rows) {
    const keep = [0, 1, 2, 3];
    const sel = rows.filter((r) => keep.indexOf(r.species) >= 0 && r.circ > 0 && r.height > 0 && r.crown > 0 && r.year > 1900);
    const n = sel.length, k = keep.length, d = 4;
    const X = new Float64Array(n * d), Y = new Float64Array(n * k);
    for (let i = 0; i < n; i++) {
      X[i * d] = sel[i].circ;
      X[i * d + 1] = HEIGHT_M[sel[i].height] || sel[i].height * 5;
      X[i * d + 2] = CROWN_M[sel[i].crown] || sel[i].crown * 3;
      X[i * d + 3] = sel[i].year;
      Y[i * k + keep.indexOf(sel[i].species)] = 1;
    }
    return stats(make({
      id: 'species', name: 'Four species, four measurements',
      note: 'Four inputs, so there is no picture of the whole thing to draw. This is where the per-neuron view earns its keep: you cannot see the boundary, but you can see what each unit responds to.',
      task: 'multiclass',
      featureNames: ['trunk circumference (cm)', 'height (m)', 'crown (m)', 'planting year'],
      targetName: 'species',
      classNames: keep.map((i) => SPECIES[i] + ' (' + COMMON[SPECIES[i]] + ')'),
      X, Y
    }));
  }

  /* ---- user data ----------------------------------------------------------
     Last column is the target. Numeric target with more than a handful of
     distinct values is a regression; anything else is treated as classes. */

  function fromCsv(text, name) {
    const rows = parseCsv(text).filter((r) => r.length > 1 && r.some((c) => c.trim() !== ''));
    if (rows.length < 2) throw new Error('needs a header row and at least one data row');

    const header = rows[0].map((h) => h.trim());
    const looksNumeric = header.every((h) => h !== '' && Number.isFinite(+h));
    const names = looksNumeric ? header.map((_, i) => 'column ' + (i + 1)) : header;
    const body = looksNumeric ? rows : rows.slice(1);

    const width = names.length;
    const d = width - 1;
    if (d < 1) throw new Error('needs at least one feature column plus a target column');

    const targets = [], feats = [];
    for (const r of body) {
      if (r.length < width) continue;
      const xs = [];
      let bad = false;
      for (let j = 0; j < d; j++) {
        const v = +String(r[j]).trim();
        if (!Number.isFinite(v)) { bad = true; break; }
        xs.push(v);
      }
      if (bad) continue;
      feats.push(xs);
      targets.push(String(r[d]).trim());
    }
    if (!feats.length) throw new Error('no rows where every feature column is a number');

    const uniq = Array.from(new Set(targets));
    const numericTarget = targets.every((t) => t !== '' && Number.isFinite(+t));
    const n = feats.length;

    if (numericTarget && uniq.length > 12) {
      const X = new Float64Array(n * d), Y = new Float64Array(n);
      for (let i = 0; i < n; i++) { for (let j = 0; j < d; j++) X[i * d + j] = feats[i][j]; Y[i] = +targets[i]; }
      return stats(make({
        id: 'user', name: name || 'Your data',
        note: `${n} rows, ${d} feature${d === 1 ? '' : 's'}, a numeric target. Treated as a regression.`,
        task: 'regression', featureNames: names.slice(0, d), targetName: names[d], X, Y
      }));
    }

    uniq.sort();
    const k = uniq.length;
    if (k < 2) throw new Error('the target column has only one distinct value');
    const binary = k === 2;
    const X = new Float64Array(n * d), Y = new Float64Array(n * (binary ? 1 : k));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < d; j++) X[i * d + j] = feats[i][j];
      const c = uniq.indexOf(targets[i]);
      if (binary) Y[i] = c; else Y[i * k + c] = 1;
    }
    return stats(make({
      id: 'user', name: name || 'Your data',
      note: `${n} rows, ${d} feature${d === 1 ? '' : 's'}, ${k} classes. Treated as a ${binary ? 'binary' : 'multiclass'} classification.`,
      task: binary ? 'binary' : 'multiclass',
      featureNames: names.slice(0, d), targetName: names[d], classNames: uniq, X, Y
    }));
  }

  const SYNTHETIC = {
    line: noisyLine, curve, xor, circles, moons, spiral
  };
  const TREE = {
    ash: ashRegression, surface: treeSurface, 'two-species': twoSpecies, species: speciesMulti
  };

  function load(id) {
    if (SYNTHETIC[id]) return Promise.resolve(SYNTHETIC[id]());
    if (TREE[id]) return loadTrees().then((rows) => TREE[id](rows));
    return Promise.reject(new Error('unknown dataset ' + id));
  }

  return {
    load, fromCsv, prepare, split, gather, stats, parseCsv,
    SPECIES, COMMON, HEIGHT_M, CROWN_M,
    catalogue: [
      { group: 'Vienna tree registry', items: [
        { id: 'ash', label: 'Ash: year to trunk' },
        { id: 'surface', label: 'Year + height to trunk' },
        { id: 'two-species', label: 'Maple or chestnut' },
        { id: 'species', label: 'Four species' }
      ] },
      { group: 'Made up, so the answer is known', items: [
        { id: 'line', label: 'Straight line' },
        { id: 'curve', label: 'A curve' },
        { id: 'xor', label: 'XOR' },
        { id: 'moons', label: 'Two moons' },
        { id: 'circles', label: 'Rings' },
        { id: 'spiral', label: 'Spiral' }
      ] }
    ]
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Data;
