// Fourier Bench: the page. A sound in, four sounds out.
//
// One piece of state matters, `S`: the samples, the analysis made from them,
// the peaks found in every frame of it, and the two decompositions built on
// those. Every control rebuilds some suffix of that chain and redraws. The
// chain is short enough to say in a line:
//
//   samples → stft → peaks per frame → { split, tracks → additive }
//
// Changing a transform setting rebuilds all of it; moving the cursor rebuilds
// none of it and only redraws. Nothing here computes anything the modules next
// door compute: this file is layout, drawing and the transport.

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);

  // Twenty seconds is the cap. It is not a technical limit — the chain runs in
  // about a second and a half on twenty seconds of the worst case, which is
  // noise — it is that this is a bench for taking a sound apart, and a sound
  // you are taking apart is a note, a word or a hit, not an album side.
  const MAX_SEC = 20;

  const S = {
    samples: null, rate: 48000, name: '', sig: null, sigHz: 220,
    anal: null, per: null, split: null, tracks: null, additive: null,
    frame: 0, busy: false, dirty: false,
  };

  // ── Colour ────────────────────────────────────────────────────────────────
  //
  // Viridis, the same ten stops the eclipse map uses, and for the same reason:
  // magnitude is data rather than page furniture, the ramp is perceptually
  // uniform so equal steps in dB look like equal steps, it keeps its ordering
  // in greyscale, and it stays readable under every form of colour vision. The
  // page's own plates are its category vocabulary and would say the wrong
  // thing here.
  const VIRIDIS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e',
                   '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'];
  const RAMP = (function () {
    const stops = VIRIDIS.map((h) => [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ]);
    // 256 steps, interpolated once. Doing it per pixel would be a million
    // interpolations a redraw.
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (stops.length - 1);
      const a = Math.min(stops.length - 1, Math.floor(t));
      const b = Math.min(stops.length - 1, a + 1);
      const f = t - a;
      for (let c = 0; c < 3; c++) {
        out[i * 3 + c] = stops[a][c] + (stops[b][c] - stops[a][c]) * f;
      }
    }
    return out;
  })();

  function ink(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  // ── Canvas helpers ────────────────────────────────────────────────────────

  // The height comes from the laid-out box rather than the height attribute, so
  // a media query can shorten the spectrogram on a phone without the drawing
  // code being told twice.
  function fit(canvas) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.round(canvas.clientWidth));
    const h = Math.round(canvas.clientHeight) || Math.round(canvas.getAttribute('height') * 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g: g, w: w, h: h, dpr: dpr };
  }

  const PAD_L = 46, PAD_B = 20;

  // The frequency axis, either way up. Both directions are needed: the drawing
  // maps a pixel to a frequency, the cursor maps a frequency back to a pixel.
  function axis(plotH, rate, log) {
    const fMax = rate / 2;
    const fMin = 20;
    return {
      toHz: (py) => {
        const u = 1 - py / plotH;
        return log ? fMin * Math.pow(fMax / fMin, u) : u * fMax;
      },
      toPy: (hz) => {
        const u = log
          ? Math.log(Math.max(hz, fMin) / fMin) / Math.log(fMax / fMin)
          : hz / fMax;
        return (1 - u) * plotH;
      },
      fMin: fMin, fMax: fMax,
    };
  }

  function ticks(log, fMax) {
    if (log) {
      return [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
        .filter((f) => f <= fMax);
    }
    const out = [];
    const step = fMax > 16000 ? 4000 : 2000;
    for (let f = 0; f <= fMax; f += step) out.push(f);
    return out;
  }

  function hzLabel(f) {
    return f >= 1000 ? (f / 1000) + 'k' : String(f);
  }

  // ── The spectrogram ───────────────────────────────────────────────────────

  function drawGram() {
    const c = el('gram');
    const { g, w, h, dpr } = fit(c);
    g.clearRect(0, 0, w, h);
    if (!S.anal) return;

    const a = S.anal;
    const plotW = Math.max(1, w - PAD_L);
    const plotH = Math.max(1, h - PAD_B);
    const log = el('logf').checked;
    const ax = axis(plotH, a.rate, log);
    const floor = Number(el('floor').value);

    // Loudest bin anywhere, so the ramp means the same thing across the whole
    // picture rather than being renormalised per column — a per-column scale
    // makes silence look as loud as a note.
    let top = 0;
    for (let f = 0; f < a.frames; f++) {
      const m = a.mag[f];
      for (let k = 0; k < m.length; k++) if (m[k] > top) top = m[k];
    }
    if (top <= 0) top = 1;

    // The image is built and placed in device pixels, not in the CSS pixels
    // everything else here is drawn in: putImageData is the one canvas call
    // that ignores the transform. Sized in CSS pixels on a screen that has two
    // device pixels to each of them, the spectrogram fills a quarter of its
    // own frame and the rest stays blank — which is invisible on a desktop at
    // ratio 1 and the first thing anyone sees on a phone.
    const pw = Math.max(1, Math.round(plotW * dpr));
    const ph = Math.max(1, Math.round(plotH * dpr));
    const axPx = axis(ph, a.rate, log);

    // Each pixel row covers a span of bins. Precomputed once: the inner loop
    // runs pw × ph times and cannot afford a logarithm.
    const lo = new Int32Array(ph), hi = new Int32Array(ph);
    for (let py = 0; py < ph; py++) {
      const f1 = axPx.toHz(py + 1), f2 = axPx.toHz(py);
      let k1 = Math.floor(f1 / a.binHz), k2 = Math.ceil(f2 / a.binHz);
      k1 = Math.max(0, Math.min(a.bins - 1, k1));
      k2 = Math.max(k1, Math.min(a.bins - 1, k2));
      lo[py] = k1; hi[py] = k2;
    }

    const img = g.createImageData(pw, ph);
    const px = img.data;
    const span = -floor;
    for (let x = 0; x < pw; x++) {
      const fr = Math.min(a.frames - 1, Math.round((x / Math.max(1, pw - 1)) * (a.frames - 1)));
      const mag = a.mag[fr];
      for (let y = 0; y < ph; y++) {
        // The loudest bin in the row, not the mean: a partial one bin wide
        // must not fade out as the picture is squeezed.
        let m = 0;
        for (let k = lo[y]; k <= hi[y]; k++) if (mag[k] > m) m = mag[k];
        const dB = 20 * Math.log10(Math.max(m, 1e-12) / top);
        let u = (dB - floor) / span;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const c3 = (u * 255) | 0;
        const at = (y * pw + x) * 4;
        px[at] = RAMP[c3 * 3];
        px[at + 1] = RAMP[c3 * 3 + 1];
        px[at + 2] = RAMP[c3 * 3 + 2];
        px[at + 3] = 255;
      }
    }
    g.putImageData(img, Math.round(PAD_L * dpr), 0);

    // Axes over the image.
    const line = ink('--pp-line'), faint = ink('--pp-faint');
    g.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--pp-font-mono');
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillStyle = faint;
    g.strokeStyle = line;
    g.lineWidth = 1;
    for (const f of ticks(log, ax.fMax)) {
      const py = ax.toPy(f);
      if (py < 6 || py > plotH - 2) continue;
      g.fillText(hzLabel(f), PAD_L - 6, py);
      g.beginPath();
      g.moveTo(PAD_L - 3, Math.round(py) + 0.5);
      g.lineTo(PAD_L, Math.round(py) + 0.5);
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const dur = a.length / a.rate;
    const stepS = dur > 12 ? 2 : dur > 5 ? 1 : dur > 2 ? 0.5 : 0.2;
    for (let t = 0; t <= dur + 1e-9; t += stepS) {
      const x = PAD_L + (t / dur) * plotW;
      if (x > w - 4) break;
      g.fillText(t.toFixed(stepS < 1 ? 1 : 0) + 's', x, plotH + 5);
    }

    // The chosen moment.
    const cx = PAD_L + (S.frame / Math.max(1, a.frames - 1)) * plotW;
    g.strokeStyle = ink('--pp-ink');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(cx) + 0.5, 0);
    g.lineTo(Math.round(cx) + 0.5, plotH);
    g.stroke();
  }

  // ── The waveform ──────────────────────────────────────────────────────────

  function drawWave() {
    const c = el('wave');
    const { g, w, h } = fit(c);
    g.clearRect(0, 0, w, h);
    const x = current();
    if (!x || !S.anal) return;

    const plotW = Math.max(1, w - PAD_L);
    const mid = h / 2;
    g.strokeStyle = ink('--pp-hair');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD_L, Math.round(mid) + 0.5);
    g.lineTo(w, Math.round(mid) + 0.5);
    g.stroke();

    // Min and max per column: a waveform drawn by sampling misses every peak
    // between the samples it took and reads quieter than the sound is.
    g.strokeStyle = ink('--pp-ink');
    g.beginPath();
    const per = x.length / plotW;
    for (let i = 0; i < plotW; i++) {
      const a0 = Math.floor(i * per), a1 = Math.min(x.length, Math.floor((i + 1) * per));
      let lo = 0, hi = 0;
      for (let j = a0; j < a1; j++) {
        if (x[j] < lo) lo = x[j];
        if (x[j] > hi) hi = x[j];
      }
      const px = PAD_L + i + 0.5;
      g.moveTo(px, mid - hi * (mid - 2));
      g.lineTo(px, mid - lo * (mid - 2));
    }
    g.stroke();

    const cx = PAD_L + (S.frame / Math.max(1, S.anal.frames - 1)) * plotW;
    g.strokeStyle = ink('--pp-plate-3');
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(Math.round(cx) + 0.5, 0);
    g.lineTo(Math.round(cx) + 0.5, h);
    g.stroke();
  }

  // ── The slice ─────────────────────────────────────────────────────────────

  function drawSlice() {
    const c = el('slice');
    const { g, w, h } = fit(c);
    g.clearRect(0, 0, w, h);
    if (!S.anal) return;

    const a = S.anal;
    const mag = a.mag[S.frame];
    const plotW = Math.max(1, w - PAD_L);
    const plotH = Math.max(1, h - PAD_B);
    const log = el('logf').checked;
    const floor = Number(el('floor').value);
    const ax = axis(plotW, a.rate, log);          // reused sideways
    const toX = (hz) => PAD_L + plotW - ax.toPy(hz);

    let top = 0;
    for (let k = 0; k < mag.length; k++) if (mag[k] > top) top = mag[k];
    if (top <= 0) top = 1;
    const toY = (dB) => {
      const u = (dB - floor) / -floor;
      return plotH - Math.max(0, Math.min(1, u)) * (plotH - 4);
    };

    // Grid: recessive, and labelled only where a label earns its ink.
    g.strokeStyle = ink('--pp-hair');
    g.lineWidth = 1;
    g.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--pp-font-mono');
    g.fillStyle = ink('--pp-faint');
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const f of ticks(log, ax.fMax)) {
      const x = toX(f);
      if (x < PAD_L || x > w - 2) continue;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, 0);
      g.lineTo(Math.round(x) + 0.5, plotH);
      g.stroke();
      g.fillText(hzLabel(f), x, plotH + 5);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let dB = 0; dB >= floor; dB -= 20) {
      const y = toY(dB);
      g.beginPath();
      g.moveTo(PAD_L, Math.round(y) + 0.5);
      g.lineTo(w, Math.round(y) + 0.5);
      g.stroke();
      g.fillText(dB === 0 ? '0 dB' : String(dB), PAD_L - 6, y);
    }

    // The curve.
    g.strokeStyle = ink('--pp-ink');
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    for (let k = 1; k < mag.length; k++) {
      const hz = k * a.binHz;
      if (log && hz < ax.fMin) continue;
      const x = toX(hz);
      const y = toY(20 * Math.log10(Math.max(mag[k], 1e-12) / top));
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke();

    // Peaks, marked where they were measured — at the interpolated frequency
    // and the corrected amplitude, which is not where the curve's own tallest
    // sample is. Seeing the mark sit slightly off the top of the hump is the
    // point: that offset is the correction.
    const peaks = (S.per && S.per[S.frame]) || [];
    g.fillStyle = ink('--pp-plate-3');
    for (const p of peaks) {
      const x = toX(p.hz);
      const y = toY(20 * Math.log10(Math.max(p.amp, 1e-12) / top));
      if (x < PAD_L) continue;
      g.beginPath();
      g.arc(x, y, 2.5, 0, Math.PI * 2);
      g.fill();
    }

    // Name the three loudest, if there is room.
    const named = peaks.slice().sort((u, v) => v.amp - u.amp).slice(0, 3);
    g.fillStyle = ink('--pp-ink');
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    for (const p of named) {
      const n = Partials.note(p.hz);
      if (!n) continue;
      const x = toX(p.hz);
      if (x < PAD_L + 12 || x > w - 12) continue;
      g.fillText(n.name, x, toY(20 * Math.log10(Math.max(p.amp, 1e-12) / top)) - 6);
    }
  }

  // ── Tables ────────────────────────────────────────────────────────────────

  function fmtHz(hz) {
    return hz >= 1000 ? hz.toFixed(1) : hz.toFixed(2);
  }
  function signed(v, digits) {
    return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits === undefined ? 1 : digits);
  }

  function fillPartials() {
    const body = el('partTable').querySelector('tbody');
    body.innerHTML = '';
    const peaks = (S.per && S.per[S.frame]) || [];
    const f0 = peaks.length ? Partials.fundamental(peaks) : null;
    const rows = Partials.harmonics(peaks, f0);

    // The last column says whichever of two things is worth saying. On a
    // generated signal whose series has a closed form, it is that closed form,
    // so the measurement can be read against the answer. Otherwise it is how
    // far the partial sits from a whole multiple of the fundamental, which is
    // the same column doing the same job with the truth unavailable.
    const sig = S.sig && Signals.byId(S.sig);
    const fund = rows.filter((r) => r.n === 1)[0];
    const truth = sig && f0 ? Signals.truthFor(sig, f0.hz, fund ? fund.amp : 0) : null;
    el('thTruth').textContent = truth ? 'Fourier says' : 'Off harmonic';

    for (const r of rows) {
      const tr = document.createElement('tr');
      const note = Partials.note(r.hz);
      const want = truth && r.n ? truth.filter((t) => t.n === r.n)[0] : null;
      const cells = [
        r.n === null ? ['—', 'none'] : [String(r.n), ''],
        [fmtHz(r.hz) + ' Hz', 'num'],
        [note ? note.name : '—', note ? '' : 'none'],
        [note ? signed(note.cents) + '¢' : '—', 'num' + (note ? '' : ' none')],
        [r.db.toFixed(1) + ' dB', 'num'],
        [r.amp.toFixed(5), 'num'],
        want
          ? [want.amp.toFixed(5), 'num']
          : truth
            ? ['—', 'none']
            : r.cents === null
              ? ['—', 'none']
              : [signed(r.cents) + '¢', 'num'],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }

    const total = peaks.total === undefined ? rows.length : peaks.total;
    el('partCount').textContent = !rows.length
      ? 'nothing above the floor'
      : total > rows.length
        ? 'the ' + rows.length + ' loudest of ' + total + ' above the floor'
        : rows.length + ' peak' + (rows.length === 1 ? '' : 's') + ' above the floor';

    // The reading card.
    if (f0) {
      const n = Partials.note(f0.hz);
      el('f0Note').textContent = n ? n.name : '—';
      el('f0Hz').textContent = fmtHz(f0.hz) + ' Hz' + (n ? '  ·  ' + signed(n.cents) + '¢' : '');
      const numbered = rows.filter((r) => r.n !== null).length;
      const facts = [
        ['partials', numbered + ' of ' + rows.length + ' numbered'],
        ['fit', (f0.score * 100).toFixed(0) + '%'],
        // Below about 1e-5 there is no string stiff enough to mean it: a guitar
        // sits near 1e-5, a piano's bass strings a hundred times higher, and
        // anything under that is the fit absorbing measurement error.
        ['stiffness B', f0.inharmonicity > 1e-5 ? f0.inharmonicity.toExponential(1) : 'none measurable'],
      ];
      el('f0Facts').innerHTML = facts
        .map(([k, v]) => '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>')
        .join('');
    } else {
      el('f0Note').textContent = '—';
      el('f0Hz').textContent = 'no pitch here';
      el('f0Facts').innerHTML = '';
    }

    el('partNote').textContent = truth
      ? 'The last column is the closed form for this waveform, anchored on the measured fundamental so the two columns compare the shape of the series rather than the level the file happens to sit at. The bench is not consulted in computing it.'
      : 'A partial with no harmonic number is not an error. Bells, drums and most struck things are mostly such partials, and a fundamental fitted to them would be a fiction.';
  }

  const PROOF_SAYS = {
    source: 'What went in, after mixing to mono.',
    sines: 'Every bin under the main lobe of a detected peak, transformed back.',
    residual: 'Every other bin. Breath, bow, hammer, room — whatever is not a steady sinusoid.',
    sum: 'The two halves added together. They are bins of one spectrum split in two, so this is a check on the transform and the overlap-add, not on the analysis.',
    additive: 'The table of partials played back through one oscillator each, with the spectrum thrown away. Nothing of the original is used except the numbers.',
  };

  function fillProof() {
    const body = el('proofTable').querySelector('tbody');
    body.innerHTML = '';
    if (!S.split) return;

    const x = S.samples;
    const sum = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) sum[i] = S.split.sines[i] + S.split.residual[i];

    const rows = [
      ['the sound', 'source', x, null],
      ['sines only', 'sines', S.split.sines, Fourier.errorDb(x, S.split.sines)],
      ['residual only', 'residual', S.split.residual,
        20 * Math.log10(Math.max(1e-12, Fourier.rms(S.split.residual) / Fourier.rms(x)))],
      ['sines + residual', 'sum', sum, Fourier.errorDb(x, sum)],
      ['rebuilt from the table', 'additive', S.additive, Fourier.errorDb(x, S.additive)],
    ];

    for (const [name, key, buf, err] of rows) {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td');
      c1.textContent = name;
      const c2 = document.createElement('td');
      c2.textContent = PROOF_SAYS[key];
      c2.style.whiteSpace = 'normal';
      const c3 = document.createElement('td');
      c3.className = 'num';
      c3.textContent = err === null ? '—' :
        (key === 'residual' ? err.toFixed(1) + ' dB of it' : err.toFixed(1) + ' dB');
      if (err === null) c3.classList.add('none');
      const c4 = document.createElement('td');
      c4.className = 'play-cell';
      if (buf) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-ghost preset';
        b.textContent = 'play';
        b.addEventListener('click', () => playBuffer(buf, b));
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'btn-ghost preset';
        d.textContent = 'wav';
        d.addEventListener('click', () => save(buf, name));
        c4.appendChild(b);
        c4.appendChild(d);
      }
      tr.append(c1, c2, c3, c4);
      body.appendChild(tr);
    }

    const exact = Fourier.errorDb(x, sum);
    el('proofNote').textContent =
      'The third row is the one that cannot be argued with: ' + exact.toFixed(0) + ' dB is ' +
      'the arithmetic’s own floor, and it is there because splitting a sum of bins and adding ' +
      'the halves again is the same sum. The last row is the real claim, and it is a lossy one — ' +
      'an onset is where it does worst, because no single spectrum describes a frame in which the ' +
      'answer changed.';
  }

  function fillWindows() {
    const body = el('winTable').querySelector('tbody');
    if (body.childElementCount) return;      // measured once, never changes
    const says = {
      rectangular: 'No window at all. Only for a signal that is a whole number of cycles long.',
      hann: 'The default first guess. Sidelobes fall away fastest of any here.',
      hamming: 'Lower first sidelobe than Hann, at the cost of the ones further out.',
      blackman: 'When a quiet partial sits near a loud one.',
      'blackman-harris': 'When it sits very near a very loud one. The widest lobe here, and 92 dB of quiet around it.',
    };
    for (const kind of Object.keys(Fourier.WINDOWS)) {
      const w = Fourier.window(kind, 1024);
      const tr = document.createElement('tr');
      const cells = [
        [Fourier.WINDOWS[kind].name, ''],
        ['±' + Fourier.mainLobe(kind) + ' bins', 'num'],
        [Fourier.sidelobeDb(kind).toFixed(1) + ' dB', 'num'],
        [Fourier.enbw(w).toFixed(3) + ' bins', 'num'],
        [says[kind], ''],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        if (!cls) td.style.whiteSpace = 'normal';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  // ── The analysis chain ────────────────────────────────────────────────────

  function settings() {
    const size = Number(el('size').value);
    return {
      size: size,
      hop: Math.max(1, size / Number(el('overlap').value)),
      pad: size * Number(el('padx').value),
      window: el('win').value,
      rate: S.rate,
    };
  }

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  // Which frame a new sound opens on. Not frame zero, which is centred on the
  // first sample and so on silence for anything that starts from silence. Not
  // simply the loudest frame either: on a plucked or struck note the loudest
  // frame is the attack, and the attack is the one moment a spectrum describes
  // worst, because the sound changed inside the frame that was measuring it.
  // Opening there reports a plucked string twenty cents sharp with a stiffness
  // five times too small, while three frames later the same code returns the
  // generator's own numbers to the last digit.
  //
  // So: loudest by the energy in the samples — the sum of the magnitudes is a
  // different question with a different answer, since an amplitude ramp puts a
  // little into every bin at once and a fade-in would win — and then, among the
  // two dozen loudest, the frame whose partials fit a harmonic series best.
  // Which is the same as saying: open where the sound is clearest, and prefer
  // the louder of two equally clear moments. On something unpitched every
  // frame scores near nothing, the comparison never fires, and it falls back to
  // the loudest frame, which is the right answer there too.
  function openOn() {
    const a = S.anal;
    const en = [];
    for (let f = 0; f < a.frames; f++) {
      const at = f * a.hop - a.pre;
      let e = 0;
      for (let i = 0; i < a.size; i++) {
        const j = at + i;
        if (j >= 0 && j < S.samples.length) e += S.samples[j] * S.samples[j];
      }
      en.push([f, e]);
    }
    en.sort((p, q) => q[1] - p[1]);
    const look = en.slice(0, 24);
    let best = look[0][0], bestScore = -1;
    for (const [f] of look) {
      const r = Partials.fundamental(S.per[f]);
      // A strict margin, over a list already in loudest-first order, is what
      // makes a tie go to the louder frame.
      if (r && r.score > bestScore + 0.02) { bestScore = r.score; best = f; }
    }
    return best;
  }

  async function analyse() {
    if (!S.samples) return;
    if (S.busy) { S.dirty = true; return; }
    S.busy = true;
    el('gramCap').textContent = 'Working…';
    await raf();

    try {
      const o = settings();
      S.anal = Fourier.stft(S.samples, o);
      S.frame = Math.min(S.frame, S.anal.frames - 1);
      await raf();

      const floor = Number(el('floor').value);
      S.per = [];
      for (let f = 0; f < S.anal.frames; f++) {
        S.per.push(Partials.peaks(S.anal, f, { floorDb: floor, maxPeaks: 160, minHz: 15 }));
      }
      if (S.pickFrame) { S.frame = openOn(); S.pickFrame = false; }
      await raf();

      S.split = Synth.split(S.anal, S.per);
      await raf();

      S.tracks = Synth.track(S.per, S.anal, {});
      S.additive = Synth.additive(S.tracks, S.anal);
      await raf();

      draw();
      fillProof();
      el('gramCap').textContent = 'Press anywhere to read the spectrum at that moment.';
    } catch (e) {
      warn('The analysis failed: ' + e.message);
      el('gramCap').textContent = '';
    }

    S.busy = false;
    if (S.dirty) { S.dirty = false; analyse(); }
  }

  function draw() {
    if (!S.anal) return;
    drawGram();
    drawWave();
    drawSlice();
    fillPartials();
    meta();
  }

  function meta() {
    const a = S.anal;
    if (!a) return;
    const w = Fourier.window(a.windowKind, a.size);
    const enbw = Fourier.enbw(w);
    const dt = (a.size / a.rate) * 1000;
    const df = (enbw * a.rate) / a.size;

    el('srcMeta').textContent =
      S.rate + ' Hz · ' + (a.length / a.rate).toFixed(2) + ' s · ' + a.frames + ' frames';

    // The trade, stated as the product. Δt is the frame in milliseconds and Δf
    // is the width in hertz that two partials must differ by to be seen apart;
    // their product is the window's noise bandwidth and does not depend on the
    // frame size at all. Halving the frame halves Δt and doubles Δf. There is
    // no setting on this page, or anywhere, that improves both.
    el('trade').textContent =
      'frame ' + a.size + ' = ' + dt.toFixed(1) + ' ms  ·  bins ' + a.binHz.toFixed(2) + ' Hz  ·  ' +
      'two partials separate at ' + df.toFixed(1) + ' Hz  ·  hop ' + a.hop + ' = ' +
      ((a.hop / a.rate) * 1000).toFixed(1) + ' ms  ·  Δt × Δf = ' + enbw.toFixed(2) +
      ', whatever the frame size';

    const t = (S.frame * a.hop) / a.rate;
    el('sliceAt').textContent = t.toFixed(3) + ' s  ·  frame ' + (S.frame + 1) + ' of ' + a.frames;
    el('sliceCap').textContent =
      'One transform of ' + a.size + ' samples centred on ' + t.toFixed(3) + ' s. Dots are the ' +
      'partials as measured — interpolated frequency, amplitude corrected for where in the ' +
      'window’s lobe the bin fell — so a dot sitting a little off the top of its hump is the ' +
      'correction doing its work.';
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  function warn(msg) {
    const h = el('hint');
    h.textContent = msg;
    h.hidden = !msg;
  }

  function adopt(samples, rate, name, sigId) {
    S.samples = samples;
    S.rate = rate;
    S.name = name;
    S.sig = sigId || null;
    S.frame = 0;
    S.pickFrame = true;
    // The loader stays. It collapses to a single row once there is something
    // to look at, but hiding it outright would mean the only way to try a
    // second sound is to reload the page — and trying a second sound is most
    // of what anyone does here.
    el('intro').classList.add('is-loaded');
    el('work').hidden = false;
    el('play').disabled = false;
    el('srcName').textContent = name;
    fillWindows();
    analyse();
  }

  function mono(buf) {
    const n = Math.min(buf.length, Math.round(buf.sampleRate * MAX_SEC));
    const out = new Float64Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += ch[i];
    }
    if (buf.numberOfChannels > 1) {
      for (let i = 0; i < n; i++) out[i] /= buf.numberOfChannels;
    }
    return out;
  }

  function audioCtx() {
    if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.ctx.state === 'suspended') S.ctx.resume();
    return S.ctx;
  }

  async function loadFile(file) {
    if (!file) return;
    warn('');
    try {
      const bytes = await file.arrayBuffer();
      const buf = await audioCtx().decodeAudioData(bytes);
      if (buf.length > buf.sampleRate * MAX_SEC) {
        warn('Analysing the first ' + MAX_SEC + ' seconds. This is a bench for taking one sound apart, not a file of them.');
      }
      adopt(mono(buf), buf.sampleRate, file.name, null);
    } catch (e) {
      warn('This browser could not decode that file. ' + (e.message || ''));
    }
  }

  // ── Recording ─────────────────────────────────────────────────────────────
  //
  // The samples are taken raw off the input, through a worklet, rather than
  // through MediaRecorder. MediaRecorder would hand back Opus or AAC, and a
  // lossy codec rearranges exactly the thing this page exists to look at: it
  // discards quiet partials near loud ones because it has decided they cannot
  // be heard, which is a claim about ears and would arrive here looking like a
  // claim about the sound.

  const WORKLET = `
    class Cap extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) this.port.postMessage(ch.slice(0));
        return true;
      }
    }
    registerProcessor('cap', Cap);
  `;

  let rec = null;

  async function record() {
    if (rec) return stopRecord();
    warn('');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      warn('No microphone: ' + (e.message || 'permission refused') + '.');
      return;
    }
    try {
      const ctx = audioCtx();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'cap');
      const chunks = [];
      let total = 0;
      node.port.onmessage = (ev) => {
        if (total >= ctx.sampleRate * MAX_SEC) return stopRecord();
        chunks.push(ev.data);
        total += ev.data.length;
      };
      src.connect(node);
      // Connected to a silent gain rather than the speakers: a live microphone
      // routed to the output is feedback.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);

      rec = { stream, src, node, sink, chunks, ctx };
      el('recLabel').textContent = 'Stop';
      el('rec').classList.add('is-on');
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      warn('Could not start recording: ' + (e.message || ''));
    }
  }

  function stopRecord() {
    if (!rec) return;
    const { stream, src, node, chunks, ctx } = rec;
    rec = null;
    el('recLabel').textContent = 'Record';
    el('rec').classList.remove('is-on');
    try { src.disconnect(); node.disconnect(); } catch (e) { /* already gone */ }
    stream.getTracks().forEach((t) => t.stop());

    let n = 0;
    for (const c of chunks) n += c.length;
    if (n < ctx.sampleRate * 0.1) {
      warn('That recording was too short to analyse.');
      return;
    }
    const out = new Float64Array(n);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    adopt(out, ctx.sampleRate, 'Recording', null);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  function current() {
    if (!S.samples) return null;
    const which = el('hear').value;
    if (which === 'sines') return S.split && S.split.sines;
    if (which === 'residual') return S.split && S.split.residual;
    if (which === 'additive') return S.additive;
    return S.samples;
  }

  let playing = null;

  function stopPlay() {
    if (playing) {
      try { playing.src.stop(); } catch (e) { /* already stopped */ }
      if (playing.btn) playing.btn.textContent = playing.label;
      playing = null;
    }
    el('playLabel').textContent = 'Play';
  }

  function playBuffer(data, btn) {
    if (playing) { const same = playing.data === data; stopPlay(); if (same) return; }
    if (!data) return;
    const ctx = audioCtx();
    const buf = ctx.createBuffer(1, data.length, S.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) ch[i] = Math.max(-1, Math.min(1, data[i]));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    playing = { src, data, btn: btn || null, label: btn ? btn.textContent : '' };
    if (btn) btn.textContent = 'stop';
    else el('playLabel').textContent = 'Stop';
    src.onended = () => { if (playing && playing.src === src) stopPlay(); };
  }

  function save(data, label) {
    const blob = Synth.wav(data, S.rate);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const stem = (S.name || 'sound').replace(/\.[^.]+$/, '');
    a.download = stem + ' — ' + label + '.wav';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── Picking a moment ──────────────────────────────────────────────────────

  function pick(ev) {
    if (!S.anal) return;
    const c = el('gram');
    const r = c.getBoundingClientRect();
    const plotW = Math.max(1, r.width - PAD_L);
    const u = (ev.clientX - r.left - PAD_L) / plotW;
    S.frame = Math.max(0, Math.min(S.anal.frames - 1, Math.round(u * (S.anal.frames - 1))));
    drawGram();
    drawWave();
    drawSlice();
    fillPartials();
    meta();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  const drop = el('drop');
  el('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((k) =>
    drop.addEventListener(k, (e) => { e.preventDefault(); drop.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((k) =>
    drop.addEventListener(k, () => drop.classList.remove('drag-over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    loadFile(e.dataTransfer.files[0]);
  });

  el('rec').addEventListener('click', record);

  // The signal list, and the line under it that says what each one is for.
  const sel = el('sig');
  for (const s of Signals.list) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.value = 'square';
  const says = () => { el('sigSays').textContent = Signals.byId(sel.value).says; };
  sel.addEventListener('change', says);
  says();

  el('make').addEventListener('click', () => {
    warn('');
    const sig = Signals.byId(sel.value);
    const hz = Math.max(20, Math.min(8000, Number(el('sighz').value) || 220));
    const rate = audioCtx().sampleRate;
    S.sigHz = hz;
    adopt(sig.make(rate, 2, hz), rate, sig.name + ' · ' + hz + ' Hz', sig.id);
  });

  el('play').addEventListener('click', () => playBuffer(current(), null));
  el('hear').addEventListener('change', () => { stopPlay(); drawWave(); });

  for (const id of ['win', 'size', 'overlap', 'padx', 'floor']) {
    el(id).addEventListener('change', analyse);
  }
  el('logf').addEventListener('change', () => { drawGram(); drawSlice(); });

  el('gram').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el('gram').setPointerCapture(e.pointerId);
    pick(e);
  });
  el('gram').addEventListener('pointermove', (e) => {
    if (e.buttons) pick(e);
  });

  document.addEventListener('keydown', (e) => {
    if (!S.anal || e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      S.frame = Math.max(0, Math.min(S.anal.frames - 1, S.frame + (e.key === 'ArrowRight' ? 1 : -1)));
      drawGram(); drawWave(); drawSlice(); fillPartials(); meta();
    } else if (e.code === 'Space') {
      e.preventDefault();
      playing ? stopPlay() : playBuffer(current(), null);
    }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 120);
  });
  // The mode toggle repaints ink and ground; the canvases hold neither and
  // have to be told.
  new MutationObserver(draw).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-mode'],
  });
})();
