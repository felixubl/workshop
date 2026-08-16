// Neuron Bench: everything you can see.
//
// Six views, one canvas convention. Nothing here knows how a network trains;
// it is handed a net and a dataset and asked to show what the net currently
// believes. That split is why the pictures can be redrawn at 12 frames a
// second while the worker runs flat out.
//
// Colour is read from the PREPRINT tokens at draw time rather than baked in,
// so flipping the lamp restyles every plot with the page — the same thing
// Fourier Bench and Eclipse Recon do, for the same reason.
//
// The decision surface is drawn in discrete bands rather than a smooth ramp.
// That is a house-style choice as much as a legibility one: this site is a
// printed sheet, and a printed sheet separates a continuous field into plates.
// Bands also make it obvious where the boundary actually sits, which a soft
// gradient hides.

var Draw = (function () {
  'use strict';

  const BANDS = 9;

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function palette() {
    return {
      ink: cssVar('--pp-ink', '#171716'),
      muted: cssVar('--pp-muted', '#5c5c57'),
      faint: cssVar('--pp-faint', '#8a8a83'),
      paper: cssVar('--pp-paper', '#fbfbf9'),
      surface: cssVar('--pp-surface', '#f4f4f0'),
      hair: cssVar('--pp-hair', '#dcdcd4'),
      line: cssVar('--pp-line', '#b4b4aa'),
      edge: cssVar('--pp-edge', '#171716'),
      a: cssVar('--pp-plate-3', '#2f5fa8'),   // the network's own answer
      b: cssVar('--pp-plate-2', '#b23b2e'),   // the other class, and the reference line
      c: cssVar('--pp-plate-1', '#3f6f4a'),
      mono: cssVar('--pp-font-mono', 'monospace')
    };
  }

  /* Parse any CSS colour the tokens might hold into rgb, so bands can be mixed
     against the paper without hard-coding hex. Uses the canvas itself as the
     parser, which handles hex, rgb(), hsl() and oklch alike. */
  const _probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const _cache = new Map();
  function rgb(colour) {
    if (_cache.has(colour)) return _cache.get(colour);
    _probe.canvas.width = _probe.canvas.height = 1;
    _probe.clearRect(0, 0, 1, 1);
    _probe.fillStyle = '#000';
    _probe.fillStyle = colour;
    _probe.fillRect(0, 0, 1, 1);
    const d = _probe.getImageData(0, 0, 1, 1).data;
    const out = [d[0], d[1], d[2]];
    _cache.set(colour, out);
    return out;
  }
  function mix(from, to, t) {
    const a = rgb(from), b = rgb(to);
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
  }
  function invalidateColours() { _cache.clear(); }

  /* ---- axes ---------------------------------------------------------------
     Ticks on a 1/2/5 ladder, the same ladder every printed axis has used for a
     century, because arbitrary tick counts produce labels nobody can read
     across. */

  function ticks(lo, hi, target) {
    if (!(hi > lo)) return [lo];
    const raw = (hi - lo) / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
      out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return out;
  }

  function fmt(v, span) {
    const a = Math.abs(v);
    if (a >= 1e6 || (a > 0 && a < 1e-3)) return v.toExponential(1);
    const dp = span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 3;
    return v.toFixed(dp);
  }

  function frame(g, box, p) {
    g.strokeStyle = p.line;
    g.lineWidth = 1;
    g.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
  }

  function axes(g, box, xr, yr, p, xLabel, yLabel) {
    const xs = ticks(xr[0], xr[1], Math.max(2, Math.round(box.w / 90)));
    const ys = ticks(yr[0], yr[1], Math.max(2, Math.round(box.h / 55)));
    const sx = (v) => box.x + ((v - xr[0]) / (xr[1] - xr[0])) * box.w;
    const sy = (v) => box.y + box.h - ((v - yr[0]) / (yr[1] - yr[0])) * box.h;

    g.save();
    g.font = '11px ' + p.mono;
    g.strokeStyle = p.hair;
    g.lineWidth = 1;
    g.fillStyle = p.faint;

    for (const t of xs) {
      const x = Math.round(sx(t)) + 0.5;
      if (x < box.x || x > box.x + box.w) continue;
      g.beginPath(); g.moveTo(x, box.y); g.lineTo(x, box.y + box.h); g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText(fmt(t, xr[1] - xr[0]), x, box.y + box.h + 5);
    }
    for (const t of ys) {
      const y = Math.round(sy(t)) + 0.5;
      if (y < box.y || y > box.y + box.h) continue;
      g.beginPath(); g.moveTo(box.x, y); g.lineTo(box.x + box.w, y); g.stroke();
      g.textAlign = 'right'; g.textBaseline = 'middle';
      g.fillText(fmt(t, yr[1] - yr[0]), box.x - 6, y);
    }

    g.fillStyle = p.muted;
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    if (xLabel) g.fillText(xLabel, box.x + box.w / 2, box.y + box.h + 32);
    if (yLabel) {
      g.save();
      g.translate(box.x - 42, box.y + box.h / 2);
      g.rotate(-Math.PI / 2);
      g.fillText(yLabel, 0, 0);
      g.restore();
    }
    g.restore();
    frame(g, box, p);
    return { sx, sy };
  }

  function pad(lo, hi, frac) {
    if (!(hi > lo)) { const c = lo || 0; return [c - 1, c + 1]; }
    const m = (hi - lo) * (frac == null ? 0.06 : frac);
    return [lo - m, hi + m];
  }

  function plotBox(w, h, left, bottom) {
    return { x: left, y: 14, w: Math.max(10, w - left - 16), h: Math.max(10, h - 14 - bottom) };
  }

  /* ---- the network's own output ------------------------------------------ */

  function predict(net, xs, norm, ds) {
    const inp = new Float64Array(net.inputs);
    for (let i = 0; i < net.inputs; i++) {
      inp[i] = norm ? (xs[i] - ds.xMean[i]) / ds.xStd[i] : xs[i];
    }
    const a = MLP.forward(net, inp);
    return a;
  }

  function denorm(v, ds, norm) {
    return norm ? v * ds.yStd[0] + ds.yMean[0] : v;
  }

  /* ---- 1: one input, one output ------------------------------------------ */

  function regression1D(canvas, ds, net, o) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    const box = plotBox(w, h, 62, 52);
    const xr = pad(ds.xMin[0], ds.xMax[0]);
    const yr = pad(ds.yMin, ds.yMax);
    const { sx, sy } = axes(g, box, xr, yr, p, ds.featureNames[0], ds.targetName);

    g.save();
    g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();

    // the data
    const n = ds.n;
    const step = n > 6000 ? Math.ceil(n / 6000) : 1;
    g.fillStyle = p.muted;
    g.globalAlpha = n > 1500 ? 0.35 : 0.7;
    for (let i = 0; i < n; i += step) {
      g.fillRect(Math.round(sx(ds.X[i])) - 1, Math.round(sy(ds.Y[i])) - 1, 2.5, 2.5);
    }
    g.globalAlpha = 1;

    // the closed-form line, for the case where one exists
    if (o.reference) {
      g.strokeStyle = p.b;
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(sx(xr[0]), sy(o.reference.bias + o.reference.weights[0] * xr[0]));
      g.lineTo(sx(xr[1]), sy(o.reference.bias + o.reference.weights[0] * xr[1]));
      g.stroke();
      g.setLineDash([]);
    }

    // what the network says
    if (net) {
      g.strokeStyle = p.a;
      g.lineWidth = 2.5;
      g.beginPath();
      const steps = 240;
      for (let i = 0; i <= steps; i++) {
        const x = xr[0] + ((xr[1] - xr[0]) * i) / steps;
        const y = denorm(predict(net, [x], o.normalise, ds)[0], ds, o.normalise);
        const px = sx(x), py = sy(y);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
    g.restore();

    legend(g, box, p, [
      { colour: p.muted, label: 'the data', kind: 'dot' },
      net ? { colour: p.a, label: 'the network', kind: 'line' } : null,
      o.reference ? { colour: p.b, label: 'least squares', kind: 'dash' } : null
    ]);
  }

  function legend(g, box, p, items) {
    const list = items.filter(Boolean);
    if (!list.length) return;
    g.save();
    g.font = '11px ' + p.mono;
    g.textBaseline = 'middle';
    let x = box.x + 8;
    const y = box.y + 10;
    for (const it of list) {
      g.strokeStyle = it.colour; g.fillStyle = it.colour; g.lineWidth = 2;
      if (it.kind === 'dot') g.fillRect(x, y - 2, 4, 4);
      else {
        g.setLineDash(it.kind === 'dash' ? [5, 3] : []);
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + 14, y); g.stroke();
        g.setLineDash([]);
      }
      const lx = x + (it.kind === 'dot' ? 9 : 19);
      g.fillStyle = p.muted;
      g.textAlign = 'left';
      g.fillText(it.label, lx, y);
      x = lx + g.measureText(it.label).width + 16;
    }
    g.restore();
  }

  /* ---- 2: two inputs, a class each ---------------------------------------- */

  function boundary2D(canvas, ds, net, o) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    const box = plotBox(w, h, 62, 52);
    const xr = pad(ds.xMin[0], ds.xMax[0]);
    const yr = pad(ds.xMin[1], ds.xMax[1]);
    const { sx, sy } = axes(g, box, xr, yr, p, ds.featureNames[0], ds.featureNames[1]);

    g.save();
    g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();

    if (net) {
      const cell = 5;
      const cols = Math.ceil(box.w / cell), rows = Math.ceil(box.h / cell);
      const multi = ds.task === 'multiclass';
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const px = box.x + c * cell + cell / 2;
          const py = box.y + r * cell + cell / 2;
          const x = xr[0] + ((px - box.x) / box.w) * (xr[1] - xr[0]);
          const y = yr[1] - ((py - box.y) / box.h) * (yr[1] - yr[0]);
          const a = predict(net, [x, y], o.normalise, ds);
          let colour;
          if (multi) {
            let bi = 0, bv = -Infinity, second = -Infinity;
            for (let k = 0; k < a.length; k++) {
              if (a[k] > bv) { second = bv; bv = a[k]; bi = k; } else if (a[k] > second) second = a[k];
            }
            const conf = Math.min(1, Math.max(0, bv - second));
            colour = mix(p.paper, classColour(p, bi), 0.12 + quantise(conf) * 0.42);
          } else {
            const v = quantise(a[0]);
            colour = mix(mix(p.paper, p.a, 0.5), mix(p.paper, p.b, 0.5), v);
          }
          g.fillStyle = colour;
          g.fillRect(box.x + c * cell, box.y + r * cell, cell + 1, cell + 1);
        }
      }
    }

    // the points on top
    const n = ds.n;
    const step = n > 4000 ? Math.ceil(n / 4000) : 1;
    for (let i = 0; i < n; i += step) {
      const cls = ds.task === 'multiclass' ? argmaxRow(ds.Y, i, ds.k) : (ds.Y[i] > 0.5 ? 1 : 0);
      const px = Math.round(sx(ds.X[i * 2])), py = Math.round(sy(ds.X[i * 2 + 1]));
      g.fillStyle = ds.task === 'multiclass' ? classColour(p, cls) : (cls ? p.b : p.a);
      g.strokeStyle = p.paper;
      g.lineWidth = 1;
      if (cls === 0 && ds.task !== 'multiclass') {
        g.beginPath(); g.arc(px, py, 3, 0, Math.PI * 2); g.fill(); g.stroke();
      } else {
        g.fillRect(px - 2.5, py - 2.5, 5, 5);
        g.strokeRect(px - 2.5, py - 2.5, 5, 5);
      }
    }
    g.restore();
    frame(g, box, p);

    if (ds.task === 'multiclass') {
      legend(g, box, p, ds.classNames.map((c, i) => ({
        colour: classColour(p, i), label: shortName(c), kind: 'dot'
      })));
    } else {
      legend(g, box, p, [
        { colour: p.a, label: shortName(ds.classNames ? ds.classNames[0] : '0'), kind: 'dot' },
        { colour: p.b, label: shortName(ds.classNames ? ds.classNames[1] : '1'), kind: 'dot' }
      ]);
    }
  }

  function shortName(s) {
    const m = /^([^(]+)\(([^)]+)\)/.exec(s);
    return m ? m[2] : s;
  }

  function quantise(v) {
    const t = Math.min(1, Math.max(0, v));
    return Math.round(t * (BANDS - 1)) / (BANDS - 1);
  }

  function classColour(p, i) {
    return [p.a, p.b, p.c, p.muted, p.edge][i % 5];
  }

  function argmaxRow(Y, row, k) {
    let bi = 0, bv = -Infinity;
    for (let j = 0; j < k; j++) if (Y[row * k + j] > bv) { bv = Y[row * k + j]; bi = j; }
    return bi;
  }

  /* ---- 3: two inputs, one number — a surface ------------------------------
     Orthographic, wireframe, hidden lines not removed. A mesh reads as a
     printed contour drawing and stays legible in both modes, where a shaded
     solid would need a light source the rest of the page does not have. */

  function surface3D(canvas, ds, net, o) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    const yaw = o.yaw == null ? -0.7 : o.yaw;
    const pitch = o.pitch == null ? 0.55 : o.pitch;
    const cy = Math.cos(yaw), sy_ = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const scale = Math.min(w, h) * 0.33;
    const ox = w / 2, oy = h / 2 + h * 0.08;

    const xr = [ds.xMin[0], ds.xMax[0]];
    const yr = [ds.xMin[1], ds.xMax[1]];
    const zr = [ds.yMin, ds.yMax];
    const nx = (v) => ((v - xr[0]) / Math.max(1e-9, xr[1] - xr[0])) * 2 - 1;
    const ny = (v) => ((v - yr[0]) / Math.max(1e-9, yr[1] - yr[0])) * 2 - 1;
    const nz = (v) => ((v - zr[0]) / Math.max(1e-9, zr[1] - zr[0])) * 2 - 1;

    function proj(x, y, z) {
      const rx = x * cy - y * sy_;
      const ry = x * sy_ + y * cy;
      return {
        x: ox + rx * scale,
        y: oy - (z * cp - ry * sp) * scale * 0.62,
        depth: ry * cp + z * sp
      };
    }

    // the box floor, so the surface has something to sit on
    g.strokeStyle = p.hair; g.lineWidth = 1;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map((c) => proj(c[0], c[1], -1));
    g.beginPath();
    corners.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
    g.closePath(); g.stroke();

    // the data, behind the mesh
    const n = ds.n;
    const step = n > 3000 ? Math.ceil(n / 3000) : 1;
    g.fillStyle = p.muted;
    g.globalAlpha = 0.5;
    for (let i = 0; i < n; i += step) {
      const q = proj(nx(ds.X[i * 2]), ny(ds.X[i * 2 + 1]), nz(ds.Y[i]));
      g.fillRect(q.x - 1, q.y - 1, 2, 2);
    }
    g.globalAlpha = 1;

    if (net) {
      const N = 26;
      const grid = [];
      for (let i = 0; i <= N; i++) {
        const row = [];
        for (let j = 0; j <= N; j++) {
          const x = xr[0] + ((xr[1] - xr[0]) * i) / N;
          const y = yr[0] + ((yr[1] - yr[0]) * j) / N;
          const z = denorm(predict(net, [x, y], o.normalise, ds)[0], ds, o.normalise);
          row.push(proj(nx(x), ny(y), nz(z)));
        }
        grid.push(row);
      }
      g.strokeStyle = p.a;
      g.lineWidth = 1;
      g.globalAlpha = 0.85;
      for (let i = 0; i <= N; i++) {
        g.beginPath();
        for (let j = 0; j <= N; j++) { const q = grid[i][j]; if (j) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); }
        g.stroke();
      }
      for (let j = 0; j <= N; j++) {
        g.beginPath();
        for (let i = 0; i <= N; i++) { const q = grid[i][j]; if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); }
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    g.save();
    g.font = '11px ' + p.mono;
    g.fillStyle = p.muted;
    g.textAlign = 'center';
    const lx = proj(0, -1.25, -1), ly = proj(1.25, 0, -1);
    g.fillText(ds.featureNames[0], lx.x, lx.y + 4);
    g.fillText(ds.featureNames[1], ly.x, ly.y + 4);
    g.textAlign = 'left';
    g.fillText(ds.targetName, 10, 16);
    g.restore();
  }

  /* ---- 4: what one hidden unit is doing -----------------------------------

     Every unit in a layer is scaled against the SAME range, not against its own
     min and max. Scaling each panel to itself was the first thing tried and it
     lies: a unit contributing almost nothing gets stretched to look exactly as
     strong as the one doing the work, and a dead unit — the entire point of the
     ReLU lesson — comes out looking busy. Shared scaling makes a weak unit pale
     and a dead one blank, which is the truth. */

  function layerField(ds, net, layer, o, res) {
    res = res || 32;
    const xr = pad(ds.xMin[0], ds.xMax[0], 0.02);
    const yr = pad(ds.xMin[1], ds.xMax[1], 0.02);
    const units = net.layers[layer].units;
    const vals = new Float64Array(res * res * units);
    const inp = new Float64Array(net.inputs);
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        const x = xr[0] + ((c + 0.5) / res) * (xr[1] - xr[0]);
        const y = yr[1] - ((r + 0.5) / res) * (yr[1] - yr[0]);
        inp[0] = o.normalise ? (x - ds.xMean[0]) / ds.xStd[0] : x;
        inp[1] = o.normalise ? (y - ds.xMean[1]) / ds.xStd[1] : y;
        MLP.forward(net, inp);
        const a = net.layers[layer].a;
        for (let u = 0; u < units; u++) {
          const v = a[u];
          vals[(r * res + c) * units + u] = v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    return { vals, lo, hi, res, units };
  }

  function neuronPanel(canvas, field, unit) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    const { vals, lo, hi, res, units } = field;
    const span = hi - lo || 1;
    const cw = w / res, ch = h / res;
    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        const t = quantise((vals[(r * res + c) * units + unit] - lo) / span);
        g.fillStyle = mix(p.paper, p.a, 0.04 + t * 0.68);
        g.fillRect(c * cw, r * ch, cw + 1, ch + 1);
      }
    }
    g.strokeStyle = p.line;
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  /* ---- 5: what a unit responds to, when there is no picture ---------------
     Above two inputs there is nothing to plot the boundary on, so a unit is
     shown as the thing it actually is: a weight per input, and a bias. */

  function neuronWeights(canvas, net, layer, unit, names) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    if (!net) return;
    const l = net.layers[layer];
    const fan = l.fanIn;
    const base = unit * fan;
    let m = Math.abs(l.b[unit]);
    for (let i = 0; i < fan; i++) m = Math.max(m, Math.abs(l.W[base + i]));
    m = m || 1;

    const rows = fan + 1;
    const gap = 3;
    const rh = Math.max(6, (h - gap * (rows - 1)) / rows);
    const mid = w * 0.52;

    g.font = '10px ' + p.mono;
    g.textBaseline = 'middle';
    for (let i = 0; i < rows; i++) {
      const v = i < fan ? l.W[base + i] : l.b[unit];
      const y = i * (rh + gap);
      const len = (Math.abs(v) / m) * (w * 0.44);
      g.fillStyle = v >= 0 ? p.a : p.b;
      if (v >= 0) g.fillRect(mid, y, len, rh);
      else g.fillRect(mid - len, y, len, rh);
      g.fillStyle = p.faint;
      g.textAlign = 'right';
      const label = i < fan ? (names && names[i] ? clip(names[i], 14) : 'in ' + (i + 1)) : 'bias';
      g.fillText(label, mid - 4, y + rh / 2);
    }
    g.strokeStyle = p.hair;
    g.beginPath(); g.moveTo(mid + 0.5, 0); g.lineTo(mid + 0.5, h); g.stroke();
  }

  function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /* ---- 6: the loss ---------------------------------------------------------
     Log scale, because the interesting part of almost every training run is
     the first tenth of it and a linear axis throws that away. */

  function loss(canvas, history, o) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    const box = plotBox(w, h, 56, 40);
    if (!history.length) {
      g.font = '11px ' + p.mono;
      g.fillStyle = p.faint;
      g.textAlign = 'center';
      g.fillText('no epochs yet', w / 2, h / 2);
      frame(g, box, p);
      return;
    }

    let lo = Infinity, hi = -Infinity;
    for (const pt of history) {
      for (const v of [pt.trainLoss, pt.testLoss]) {
        if (v == null || !Number.isFinite(v) || v <= 0) continue;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    const logScale = Number.isFinite(lo) && Number.isFinite(hi) && hi / lo > 20;
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const yl = logScale ? Math.log10(lo) : Math.min(0, lo);
    const yh = logScale ? Math.log10(hi) : hi;
    const yr = pad(yl, yh, 0.08);
    const xr = [0, Math.max(1, history[history.length - 1].epoch)];

    const xs = ticks(xr[0], xr[1], Math.max(2, Math.round(box.w / 80)));
    const sx = (v) => box.x + ((v - xr[0]) / (xr[1] - xr[0])) * box.w;
    const sy = (v) => {
      const t = logScale ? Math.log10(Math.max(1e-12, v)) : v;
      return box.y + box.h - ((t - yr[0]) / (yr[1] - yr[0])) * box.h;
    };

    g.save();
    g.font = '11px ' + p.mono;
    g.strokeStyle = p.hair; g.fillStyle = p.faint; g.lineWidth = 1;
    for (const t of xs) {
      const x = Math.round(sx(t)) + 0.5;
      if (x < box.x || x > box.x + box.w) continue;
      g.beginPath(); g.moveTo(x, box.y); g.lineTo(x, box.y + box.h); g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText(String(Math.round(t)), x, box.y + box.h + 5);
    }
    const yt = ticks(yr[0], yr[1], Math.max(2, Math.round(box.h / 40)));
    for (const t of yt) {
      const y = Math.round(box.y + box.h - ((t - yr[0]) / (yr[1] - yr[0])) * box.h) + 0.5;
      if (y < box.y || y > box.y + box.h) continue;
      g.beginPath(); g.moveTo(box.x, y); g.lineTo(box.x + box.w, y); g.stroke();
      g.textAlign = 'right'; g.textBaseline = 'middle';
      g.fillText(logScale ? '1e' + Math.round(t) : fmt(t, yr[1] - yr[0]), box.x - 6, y);
    }
    g.fillStyle = p.muted;
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText('epoch', box.x + box.w / 2, box.y + box.h + 30);
    g.restore();

    g.save();
    g.beginPath(); g.rect(box.x, box.y - 2, box.w, box.h + 4); g.clip();
    for (const [key, colour, dash] of [['trainLoss', p.a, []], ['testLoss', p.b, [5, 3]]]) {
      let started = false;
      g.strokeStyle = colour; g.lineWidth = 2; g.setLineDash(dash);
      g.beginPath();
      for (const pt of history) {
        const v = pt[key];
        if (v == null || !Number.isFinite(v)) continue;
        const x = sx(pt.epoch), y = sy(v);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();
    frame(g, box, p);
    legend(g, box, p, [
      { colour: p.a, label: 'training', kind: 'line' },
      o && o.hasTest ? { colour: p.b, label: 'held out', kind: 'dash' } : null
    ]);
  }

  /* ---- 6b: above two inputs, there is no boundary to draw -----------------
     So show the thing that still works at any width: what it predicted against
     what was true. A perfect model puts every point on the diagonal, and the
     shape of the miss says which way it is wrong. */

  function predictedVsActual(canvas, ds, net, o) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    const box = plotBox(w, h, 62, 52);
    if (!net) { frame(g, box, p); return; }

    const lo = ds.yMin, hi = ds.yMax;
    const r = pad(lo, hi);
    const { sx, sy } = axes(g, box, r, r, p, 'actual ' + ds.targetName, 'predicted');

    g.save();
    g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();

    g.strokeStyle = p.b; g.lineWidth = 2; g.setLineDash([6, 4]);
    g.beginPath(); g.moveTo(sx(r[0]), sy(r[0])); g.lineTo(sx(r[1]), sy(r[1])); g.stroke();
    g.setLineDash([]);

    const n = ds.n, step = n > 4000 ? Math.ceil(n / 4000) : 1;
    const xs = new Array(ds.d);
    g.fillStyle = p.a;
    g.globalAlpha = n > 1500 ? 0.3 : 0.6;
    for (let i = 0; i < n; i += step) {
      for (let j = 0; j < ds.d; j++) xs[j] = ds.X[i * ds.d + j];
      const yh = denorm(predict(net, xs, o.normalise, ds)[0], ds, o.normalise);
      g.fillRect(Math.round(sx(ds.Y[i])) - 1, Math.round(sy(yh)) - 1, 2.5, 2.5);
    }
    g.globalAlpha = 1;
    g.restore();
    frame(g, box, p);
    legend(g, box, p, [{ colour: p.b, label: 'a perfect model sits here', kind: 'dash' }]);
  }

  /* Same problem, classification answer: a confusion matrix. Rows are truth,
     columns are the guess, so anything off the diagonal is a mistake and the
     column it lands in says what it was mistaken for. */
  function confusion(canvas, ds, net, o) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    if (!net) return;
    const k = ds.task === 'binary' ? 2 : ds.k;
    const counts = new Float64Array(k * k);
    const xs = new Array(ds.d);
    for (let i = 0; i < ds.n; i++) {
      for (let j = 0; j < ds.d; j++) xs[j] = ds.X[i * ds.d + j];
      const a = predict(net, xs, o.normalise, ds);
      let guess, truth;
      if (ds.task === 'binary') { guess = a[0] >= 0.5 ? 1 : 0; truth = ds.Y[i] > 0.5 ? 1 : 0; }
      else {
        guess = 0; let bv = -Infinity;
        for (let c = 0; c < k; c++) if (a[c] > bv) { bv = a[c]; guess = c; }
        truth = argmaxRow(ds.Y, i, k);
      }
      counts[truth * k + guess]++;
    }

    const left = Math.min(150, w * 0.3), top = 34;
    const cw = (w - left - 12) / k, ch = (h - top - 26) / k;
    let worst = 0;
    for (let r = 0; r < k; r++) {
      let rowSum = 0;
      for (let c = 0; c < k; c++) rowSum += counts[r * k + c];
      for (let c = 0; c < k; c++) worst = Math.max(worst, rowSum ? counts[r * k + c] / rowSum : 0);
    }

    g.font = '11px ' + p.mono;
    for (let r = 0; r < k; r++) {
      let rowSum = 0;
      for (let c = 0; c < k; c++) rowSum += counts[r * k + c];
      for (let c = 0; c < k; c++) {
        const frac = rowSum ? counts[r * k + c] / rowSum : 0;
        const x = left + c * cw, y = top + r * ch;
        g.fillStyle = mix(p.paper, r === c ? p.a : p.b, 0.06 + quantise(frac / (worst || 1)) * 0.55);
        g.fillRect(x, y, cw - 2, ch - 2);
        g.strokeStyle = p.hair; g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, cw - 3, ch - 3);
        g.fillStyle = p.ink;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(Math.round(frac * 100) + '%', x + (cw - 2) / 2, y + (ch - 2) / 2);
      }
      g.fillStyle = p.muted;
      g.textAlign = 'right'; g.textBaseline = 'middle';
      const label = ds.classNames ? shortName(ds.classNames[r]) : String(r);
      g.fillText(clip(label, 18), left - 6, top + r * ch + ch / 2);
    }
    g.fillStyle = p.faint;
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    for (let c = 0; c < k; c++) {
      const label = ds.classNames ? shortName(ds.classNames[c]) : String(c);
      g.fillText(clip(label, 12), left + c * cw + cw / 2, top - 6);
    }
    g.textAlign = 'left';
    g.fillText('guessed →', 4, top - 6);
    g.textBaseline = 'top';
    g.fillText('rows are what it really was', 4, h - 18);
  }

  /* ---- 7: the network itself ----------------------------------------------
     Units as squares, connections as lines whose weight is their width and
     whose sign is their colour. Above a few hundred edges it stops being a
     diagram and starts being a smear, so it thins out rather than lying. */

  function network(canvas, net, ds, o) {
    const { g, w, h } = fit(canvas);
    const p = palette();
    if (!net) return null;

    const cols = [];
    cols.push({ units: net.inputs, label: 'in', act: null });
    net.layers.forEach((l, i) => cols.push({
      units: l.units, label: i === net.layers.length - 1 ? 'out' : 'h' + (i + 1), act: l.act, layer: i
    }));

    const padX = 34, padY = 26;
    const usableW = w - padX * 2, usableH = h - padY * 2;
    const dx = cols.length > 1 ? usableW / (cols.length - 1) : 0;
    const maxUnits = Math.max.apply(null, cols.map((c) => c.units));
    const size = Math.max(5, Math.min(16, usableH / (maxUnits * 1.7)));

    const pos = cols.map((c, ci) => {
      const shown = Math.min(c.units, 28);
      const spacing = shown > 1 ? Math.min(size * 1.9, usableH / (shown - 1)) : 0;
      const top = padY + usableH / 2 - (spacing * (shown - 1)) / 2;
      const list = [];
      for (let u = 0; u < shown; u++) list.push({ x: padX + ci * dx, y: top + u * spacing, unit: u });
      return { col: c, list, hidden: c.units - shown };
    });

    // edges first
    let maxAbs = 0;
    for (const l of net.layers) for (let i = 0; i < l.W.length; i++) maxAbs = Math.max(maxAbs, Math.abs(l.W[i]));
    maxAbs = maxAbs || 1;
    const totalEdges = net.layers.reduce((s, l) => s + l.W.length, 0);
    const thin = totalEdges > 400;

    g.globalAlpha = thin ? 0.25 : 0.6;
    for (let li = 0; li < net.layers.length; li++) {
      const l = net.layers[li];
      const from = pos[li], to = pos[li + 1];
      for (const t of to.list) {
        for (const f of from.list) {
          const wgt = l.W[t.unit * l.fanIn + f.unit];
          const mag = Math.abs(wgt) / maxAbs;
          if (thin && mag < 0.25) continue;
          g.strokeStyle = wgt >= 0 ? p.a : p.b;
          g.lineWidth = Math.max(0.4, mag * 3);
          g.beginPath(); g.moveTo(f.x, f.y); g.lineTo(t.x, t.y); g.stroke();
        }
      }
    }
    g.globalAlpha = 1;

    // then the units
    const hit = [];
    g.font = '10px ' + p.mono;
    g.textAlign = 'center';
    for (let ci = 0; ci < pos.length; ci++) {
      const c = pos[ci];
      for (const u of c.list) {
        const isIO = ci === 0 || ci === pos.length - 1;
        g.fillStyle = isIO ? p.surface : p.paper;
        g.strokeStyle = p.edge;
        g.lineWidth = ci === 0 ? 1 : 2;
        g.fillRect(u.x - size / 2, u.y - size / 2, size, size);
        g.strokeRect(u.x - size / 2, u.y - size / 2, size, size);
        if (ci > 0) hit.push({ x: u.x, y: u.y, r: size, layer: ci - 1, unit: u.unit });
      }
      g.fillStyle = p.faint;
      g.textBaseline = 'top';
      g.fillText(c.col.label, c.list.length ? c.list[0].x : padX + ci * dx, padY + usableH + 6);
      if (c.hidden > 0) {
        g.fillStyle = p.faint;
        g.textBaseline = 'bottom';
        g.fillText('+' + c.hidden, c.list[c.list.length - 1].x, c.list[c.list.length - 1].y + size * 2.4);
      }
    }
    return hit;
  }

  return {
    fit, palette, invalidateColours, ticks,
    regression1D, boundary2D, surface3D, layerField, neuronPanel, neuronWeights, loss, network,
    predictedVsActual, confusion,
    predict, denorm, shortName, classColour
  };
})();
