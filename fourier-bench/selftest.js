// Fourier Bench: the proof.
//
// This tool makes a claim a reader cannot check by looking at it. A
// spectrogram is a coloured rectangle; a broken transform draws one exactly as
// convincing as a working one, and a partials table full of plausible numbers
// is the easiest thing on this site to get quietly wrong. So the claims are
// asserted here, against three things that do not depend on any of this code
// being right:
//
//   the definition   a naive O(n²) sum straight out of the definition of the
//                    discrete Fourier transform, which the fast one has to
//                    agree with to the last few bits.
//   the literature   the window figures Harris published in 1978. If the
//                    arrays in fourier.js are the windows they are named
//                    after, they measure what he measured.
//   Fourier          the closed forms for a square, a sawtooth and a triangle,
//                    which have been known since 1822 and are not up for
//                    negotiation by anything in this directory.
//
// Runs in the browser through tools/verify/fourier-bench.html and under node
// with `node fourier-bench/selftest.js`, off one set of assertions.

(function (root) {
  'use strict';

  function run(report) {
    const F = root.Fourier, P = root.Partials, Sy = root.Synth, G = root.Signals;
    const results = [];

    function ok(name, pass, detail) {
      const r = { name: name, pass: !!pass, detail: detail || '' };
      results.push(r);
      if (report) report(r);
      return r.pass;
    }
    function near(a, b, tol) { return Math.abs(a - b) <= tol; }
    function pct(a, b) { return Math.abs(a - b) / Math.abs(b || 1); }

    const RATE = 48000;
    function tone(hz, amp, n, rate) {
      const x = new Float64Array(n || RATE);
      for (let i = 0; i < x.length; i++) {
        x[i] = amp * Math.sin((2 * Math.PI * hz * i) / (rate || RATE));
      }
      return x;
    }
    function analyse(x, o) {
      o = o || {};
      return F.stft(x, {
        size: o.size || 4096,
        hop: (o.size || 4096) / (o.overlap || 4),
        pad: o.pad,
        window: o.window || 'blackman-harris',
        rate: o.rate || RATE,
      });
    }

    /* ── The transform against its own definition ───────────────────────── */

    (function () {
      let worst = 0;
      for (const n of [8, 16, 64, 256, 1024]) {
        const x = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          x[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + ((i % 5) - 2) * 0.11;
        }
        const fast = F.realFFT(x), slow = F.naiveDFT(x);
        // Relative to the size of the transform: the sum grows with n, and so
        // does the rounding error in any correct implementation.
        let scale = 0;
        for (let k = 0; k < slow.re.length; k++) {
          scale = Math.max(scale, Math.hypot(slow.re[k], slow.im[k]));
        }
        for (let k = 0; k < fast.re.length; k++) {
          worst = Math.max(
            worst,
            Math.hypot(fast.re[k] - slow.re[k], fast.im[k] - slow.im[k]) / scale
          );
        }
      }
      ok('the fast transform agrees with the definition',
         worst < 1e-13,
         'worst relative disagreement over five sizes: ' + worst.toExponential(2));
    })();

    (function () {
      const n = 4096;
      const re = new Float64Array(n), im = new Float64Array(n), was = new Float64Array(n);
      // A fixed pseudo-random signal: an assertion that passes on some runs
      // and not others is worse than no assertion.
      let z = 0x13579bd;
      for (let i = 0; i < n; i++) {
        z ^= z << 13; z >>>= 0; z ^= z >> 17; z ^= z << 5; z >>>= 0;
        re[i] = was[i] = (z / 0xffffffff) * 2 - 1;
      }
      F.fft(re, im, false);
      F.ifft(re, im);
      let worst = 0;
      for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(re[i] - was[i]));
      ok('transform then inverse returns the input',
         worst < 1e-14, 'worst sample error at n=4096: ' + worst.toExponential(2));
    })();

    (function () {
      // Parseval: the energy in the samples is the energy in the spectrum. A
      // scaling mistake anywhere in the butterfly breaks this and almost
      // nothing else catches it.
      const n = 1024;
      const x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.31) * 0.7 + Math.cos(i * 1.7) * 0.2;
      let time = 0;
      for (let i = 0; i < n; i++) time += x[i] * x[i];
      const s = F.realFFT(x);
      let freq = 0;
      for (let k = 0; k <= n / 2; k++) {
        const p = s.re[k] * s.re[k] + s.im[k] * s.im[k];
        freq += (k === 0 || k === n / 2 ? 1 : 2) * p;
      }
      freq /= n;
      ok('energy is conserved between the samples and the spectrum',
         pct(freq, time) < 1e-12,
         'time ' + time.toFixed(6) + ' vs spectrum ' + freq.toFixed(6));
    })();

    (function () {
      // Real input has a real DC and a real Nyquist bin. If the packing that
      // halves the work is wrong, this is usually where it shows first.
      const n = 512;
      const x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.13) + 0.4;
      const s = F.realFFT(x);
      ok('the real transform leaves DC and Nyquist real',
         Math.abs(s.im[0]) < 1e-10 && Math.abs(s.im[n / 2]) < 1e-10,
         'imaginary parts ' + s.im[0].toExponential(1) + ' and ' + s.im[n / 2].toExponential(1));
    })();

    /* ── The windows against Harris 1978 ─────────────────────────────────── */

    (function () {
      // Table I of "On the Use of Windows for Harmonic Analysis with the
      // Discrete Fourier Transform", Proc. IEEE 66(1). Equivalent noise
      // bandwidth in bins, and the highest sidelobe in dB.
      const HARRIS = {
        rectangular: [1.00, -13.3],
        hann: [1.50, -31.5],
        hamming: [1.36, -42.7],
        blackman: [1.73, -58.1],
        'blackman-harris': [2.00, -92.0],
      };
      let worstB = 0, worstS = 0, names = [];
      for (const kind in HARRIS) {
        const w = F.window(kind, 1024);
        const eb = Math.abs(F.enbw(w) - HARRIS[kind][0]);
        const sl = Math.abs(F.sidelobeDb(kind) - HARRIS[kind][1]);
        worstB = Math.max(worstB, eb);
        worstS = Math.max(worstS, sl);
        names.push(kind + ' ' + F.enbw(w).toFixed(3) + '/' + F.sidelobeDb(kind).toFixed(1));
      }
      ok('the windows measure what Harris measured',
         worstB < 0.01 && worstS < 0.6,
         names.join(', '));
    })();

    (function () {
      // Coherent gain is the window's mean, and for a cosine-sum window that
      // is its first coefficient. A window built from the wrong coefficients
      // still looks like a bell and fails here.
      const want = { rectangular: 1, hann: 0.5, hamming: 0.54, blackman: 0.42,
                     'blackman-harris': 0.35875 };
      let worst = 0;
      for (const kind in want) {
        worst = Math.max(worst, Math.abs(F.coherentGain(F.window(kind, 2048)) - want[kind]));
      }
      ok('every window\'s mean is its own first coefficient',
         worst < 1e-9, 'worst difference ' + worst.toExponential(2));
    })();

    /* ── Reading one partial ─────────────────────────────────────────────── */

    (function () {
      // A sine sitting exactly on a bin, which is the easy case: whatever the
      // amplitude calibration is doing, it has to get this one exactly right.
      const binHz = RATE / 4096;
      const s = analyse(tone(binHz * 300, 0.5), { window: 'hann' });
      const p = P.peaks(s, 6, { floorDb: -80, maxPeaks: 4 })[0];
      ok('a sine on a bin reads its own amplitude',
         p && pct(p.amp, 0.5) < 1e-4,
         p ? 'read ' + p.amp.toFixed(6) + ' for 0.500000' : 'no peak found');
    })();

    (function () {
      // And the hard case: a sine between bins, where the tallest bin is short
      // of the true amplitude by up to 1.4 dB and the tallest bin's own
      // frequency is wrong by up to half a bin. This is the assertion the
      // window-lobe correction and the phase estimator exist for.
      const binHz = RATE / 4096;
      let worstA = 0, worstC = 0;
      for (const frac of [0.1, 0.25, 0.37, 0.5]) {
        for (const win of ['hann', 'blackman', 'blackman-harris']) {
          const hz = binHz * (300 + frac);
          const s = analyse(tone(hz, 0.5), { window: win });
          // The loudest peak, not the lowest in frequency. A tone that does
          // not sit on a bin leaks into its window's sidelobes, and a Hann
          // window's are only 31 dB down — well above an −80 dB floor — so the
          // list starts with a sidelobe and the tone is somewhere in the
          // middle of it.
          const p = P.peaks(s, 6, { floorDb: -80, maxPeaks: 40 })
            .slice().sort((u, v) => v.amp - u.amp)[0];
          if (!p) { worstA = 1; continue; }
          worstA = Math.max(worstA, pct(p.amp, 0.5));
          worstC = Math.max(worstC, Math.abs(P.cents(p.hz, hz)));
        }
      }
      ok('a sine between bins reads its amplitude to a hundredth of a percent',
         worstA < 1e-4, 'worst amplitude error ' + (worstA * 100).toFixed(4) + '%');
      ok('and its frequency to a hundredth of a cent',
         worstC < 0.01, 'worst frequency error ' + worstC.toFixed(4) + ' cents');
    })();

    (function () {
      // The phase reported for a frame is the phase the signal had at that
      // frame's own instant — not at the start of the analysis window, and not
      // with the window's linear phase still on it. Resynthesis depends on
      // this entirely, and nothing else on the page would show it was wrong.
      const hz = 1000, phi = 0.9;
      const x = new Float64Array(RATE);
      for (let i = 0; i < x.length; i++) {
        x[i] = 0.6 * Math.cos((2 * Math.PI * hz * i) / RATE + phi);
      }
      const s = analyse(x, { window: 'hann' });
      let worst = 0;
      for (const f of [4, 9, 20]) {
        const p = P.peaks(s, f, { floorDb: -60, maxPeaks: 3 })[0];
        const want = phi + (2 * Math.PI * hz * (f * s.hop)) / RATE;
        worst = Math.max(worst, Math.abs(P.principal(p.phase - want)));
      }
      ok('phase is reported at the frame\'s own instant',
         worst < 1e-3, 'worst phase error ' + worst.toExponential(2) + ' rad');
    })();

    (function () {
      // Forty cents rather than fifty: at exactly half a semitone the nearer
      // note is a coin toss, and asserting which way the coin lands would be
      // asserting a property of Math.round.
      ok('equal temperament is anchored on A4 = 440',
         P.note(440).name === 'A4' && Math.abs(P.note(440).cents) < 1e-9 &&
         P.note(261.6255653).name === 'C4' && P.note(880).name === 'A5' &&
         P.note(466.1637615).name === 'A♯4' &&
         Math.abs(P.note(440 * Math.pow(2, 40 / 1200)).cents - 40) < 1e-6,
         'A4, C4, A5, A♯4, and a note 40 cents sharp');
    })();

    /* ── The closed forms ────────────────────────────────────────────────── */

    function seriesCheck(id, amp, odd) {
      const hz = 220;
      const x = G.byId(id).make(RATE, 2, hz);
      const s = analyse(x, { size: 8192 });
      // A frame well past the fade, where the tone is steady.
      const f = Math.floor(s.frames * 0.4);
      const peaks = P.peaks(s, f, { floorDb: -70, maxPeaks: 160, minHz: 15 });
      const f0 = P.fundamental(peaks);
      const rows = P.harmonics(peaks, f0);
      const first = rows.filter((r) => r.n === 1)[0];
      if (!f0 || !first) return ok('a ' + id + ' is the series Fourier says it is', false, 'no fundamental');

      // Everything is compared against the measured fundamental, so this tests
      // the shape of the series rather than the level the file sits at.
      let worst = 0, checked = 0, stray = 0;
      for (const r of rows) {
        if (!r.n || r.n > 20) continue;
        const want = (amp(r.n) / amp(1)) * first.amp;
        if (odd && r.n % 2 === 0) { stray++; continue; }
        worst = Math.max(worst, pct(r.amp, want));
        checked++;
      }
      const pitchOk = Math.abs(P.cents(f0.hz, hz)) < 1;
      ok('a ' + id + ' is the series Fourier says it is',
         checked >= 8 && worst < 0.01 && stray === 0 && pitchOk,
         checked + ' partials, worst amplitude error ' + (worst * 100).toFixed(3) + '%, ' +
         stray + ' partials where there should be none, f0 ' + f0.hz.toFixed(2) + ' Hz');
    }
    seriesCheck('square', (n) => 4 / (Math.PI * n), true);
    seriesCheck('saw', (n) => 2 / (Math.PI * n), false);
    seriesCheck('triangle', (n) => 8 / (Math.PI * Math.PI * n * n), true);

    (function () {
      // Three partials at 450, 600 and 750 and no energy whatever at 150. The
      // ear hears 150; so should this. It is the case that separates a
      // fundamental estimator from a peak finder.
      const x = new Float64Array(RATE);
      for (const n of [3, 4, 5]) {
        for (let i = 0; i < x.length; i++) {
          x[i] += 0.3 * Math.sin((2 * Math.PI * 150 * n * i) / RATE);
        }
      }
      const s = analyse(x, { size: 8192 });
      const f0 = P.fundamental(P.peaks(s, 8, { floorDb: -70, maxPeaks: 40 }));
      ok('a missing fundamental is still the fundamental',
         f0 && Math.abs(P.cents(f0.hz, 150)) < 5,
         f0 ? 'found ' + f0.hz.toFixed(2) + ' Hz for 150 Hz' : 'nothing found');
    })();

    (function () {
      // A stiff string: partials at n·f0·√(1 + Bn²) rather than n·f0. Both
      // numbers have to come back, and they are strongly correlated, so
      // getting one right by luck while the other absorbs the error is the
      // failure this watches for.
      const f0t = 110, Bt = 4e-4;
      const x = new Float64Array(RATE);
      for (let n = 1; n <= 14; n++) {
        const f = n * f0t * Math.sqrt(1 + Bt * n * n);
        for (let i = 0; i < x.length; i++) {
          x[i] += (0.24 / n) * Math.sin((2 * Math.PI * f * i) / RATE + n);
        }
      }
      const s = analyse(x, { size: 8192 });
      const f0 = P.fundamental(P.peaks(s, 8, { floorDb: -70, maxPeaks: 60, minHz: 15 }));
      ok('a stiff string gives up both its pitch and its stiffness',
         f0 && Math.abs(P.cents(f0.hz, f0t)) < 3 && pct(f0.inharmonicity, Bt) < 0.1,
         f0 ? 'f0 ' + f0.hz.toFixed(3) + ' for ' + f0t + ', B ' +
              f0.inharmonicity.toExponential(2) + ' for ' + Bt.toExponential(2)
            : 'nothing found');
    })();

    (function () {
      // A square wave has no even harmonics and no stiffness. A fit free to
      // invent one can always explain a gapped series a shade better by moving
      // the fundamental and adding a stretch, and did, before the Occam test.
      const s = analyse(G.byId('square').make(RATE, 2, 220), { size: 8192 });
      const f0 = P.fundamental(P.peaks(s, Math.floor(s.frames * 0.4),
        { floorDb: -70, maxPeaks: 160, minHz: 15 }));
      ok('a square wave is not reported as a stiff string',
         f0 && f0.inharmonicity === 0 && Math.abs(P.cents(f0.hz, 220)) < 1,
         f0 ? 'f0 ' + f0.hz.toFixed(3) + ', B ' + f0.inharmonicity : 'nothing found');
    })();

    /* ── Putting it back ─────────────────────────────────────────────────── */

    (function () {
      // Every window, both hops, and a length that is not a multiple of
      // anything. The edges are the interesting part: the first and last half
      // frame are covered by fewer windows than the middle, and dividing by
      // the overlap a constant-overlap-add hop is supposed to produce, rather
      // than by the one actually accumulated, returns silence there and a
      // round trip 17 dB off.
      const x = new Float64Array(37913);
      for (let i = 0; i < x.length; i++) {
        x[i] = 0.5 * Math.sin(i * 0.07) + 0.2 * Math.sin(i * 0.31 + 1);
      }
      let worst = -999, at = '';
      for (const kind in F.WINDOWS) {
        for (const overlap of [2, 4]) {
          const s = analyse(x, { size: 2048, window: kind, overlap: overlap });
          const e = F.errorDb(x, F.istft(s));
          if (e > worst) { worst = e; at = kind + ' at 1/' + overlap; }
        }
      }
      ok('the analysis runs backwards to the input, at every window and hop',
         worst < -140, 'worst of ten: ' + worst.toFixed(1) + ' dB (' + at + ')');
    })();

    (function () {
      // The two halves of the split are bins of one spectrum, so they add back
      // to it. This is the page's headline number and it should be at the
      // arithmetic's floor, not near it.
      const x = G.byId('pluck').make(RATE, 2, 196);
      const s = analyse(x);
      const per = [];
      for (let f = 0; f < s.frames; f++) {
        per.push(P.peaks(s, f, { floorDb: -60, maxPeaks: 160, minHz: 15 }));
      }
      const sp = Sy.split(s, per);
      const sum = new Float64Array(x.length);
      for (let i = 0; i < x.length; i++) sum[i] = sp.sines[i] + sp.residual[i];
      ok('sines and residual add back to the sound exactly',
         F.errorDb(x, sum) < -140, F.errorDb(x, sum).toFixed(1) + ' dB');
    })();

    (function () {
      // The strong claim: a steady tone rebuilt from nothing but the table of
      // numbers, through one oscillator, landing on the original. Measured
      // away from the fade at each end, where the amplitude moves faster than
      // a frame can follow and no sinusoid model is expected to hold.
      const size = 2048;
      const x = G.byId('sine').make(RATE, 2, 440);
      const s = analyse(x, { size: size });
      const per = [];
      for (let f = 0; f < s.frames; f++) {
        per.push(P.peaks(s, f, { floorDb: -60, maxPeaks: 20, minHz: 15 }));
      }
      const add = Sy.additive(Sy.track(per, s, {}), s);
      const cut = (v) => v.slice(size * 3, v.length - size * 3);
      const e = F.errorDb(cut(x), cut(add));
      ok('a steady tone survives being rebuilt from the numbers alone',
         e < -100, 'interior error ' + e.toFixed(1) + ' dB');
    })();

    (function () {
      // Not every sound is sinusoids, and the tool must not pretend otherwise.
      // Noise has no partials; the honest result is a residual that holds
      // nearly all of it.
      const x = G.byId('noise').make(RATE, 1, 220);
      const s = analyse(x);
      const per = [];
      for (let f = 0; f < s.frames; f++) {
        per.push(P.peaks(s, f, { floorDb: -60, maxPeaks: 160, minHz: 15 }));
      }
      const sp = Sy.split(s, per);
      const kept = 20 * Math.log10(F.rms(sp.sines) / F.rms(x));
      ok('noise is not mistaken for partials',
         kept > -6, 'the sine half holds ' + kept.toFixed(1) + ' dB of it — most of the sound');
    })();

    (function () {
      const wav = Sy.wav(new Float64Array(1000), 44100);
      ok('the exported file is a WAV', wav && wav.size === 44 + 2000 && wav.type === 'audio/wav',
         wav ? wav.size + ' bytes for 1000 mono samples, ' + wav.type : 'nothing written');
    })();

    return results;
  }

  root.FBTest = { run: run };
})(typeof self !== 'undefined' ? self : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.FBTest;
  if (require.main === module) {
    // Under node the modules have to be pulled in before the assertions can
    // ask them anything; in the browser the page's own script tags did it.
    ['./fourier.js', './partials.js', './synth.js', './signals.js'].forEach(require);
    if (typeof Blob === 'undefined') {
      // node has Blob from 18 on; older ones would fail the WAV assertion for
      // a reason that has nothing to do with the WAV.
      globalThis.Blob = function (parts, o) {
        this.size = parts.reduce((n, p) => n + (p.byteLength || p.length || 0), 0);
        this.type = (o && o.type) || '';
      };
    }
    const t0 = Date.now();
    const res = globalThis.FBTest.run((r) => {
      console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '  ::  ' + r.detail : ''));
    });
    const bad = res.filter((r) => !r.pass).length;
    console.log('\n' + (res.length - bad) + ' pass, ' + bad + ' fail, ' +
                ((Date.now() - t0) / 1000).toFixed(1) + 's');
    process.exit(bad ? 1 : 0);
  }
}
