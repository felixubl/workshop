// Fourier Bench: the transform. Nothing here is taken from a library, for the
// same reason the PDF engine and the NES chip next door are not: the tool's
// whole claim is about what a Fourier transform does to a sound, and a claim
// resting on an opaque dependency is not a claim the reader can check.
//
// Three layers, each a thin skin on the one below:
//
//   fft/ifft      an in-place radix-2 Cooley–Tukey butterfly over two
//                 Float64Arrays, real and imaginary.
//   realFFT       the same thing for real input at half the cost, by packing
//                 the even samples into the real part and the odd into the
//                 imaginary and undoing the mixing afterwards.
//   stft/istft    a spectrum per moment, and the way back.
//
// The way back matters more than it looks. A spectrogram is easy to draw and
// impossible to check by eye — every implementation produces something that
// looks like a spectrogram. Being able to run the analysis backwards and land
// on the input again, to fifteen decimal places, is the only cheap proof that
// the forward pass is arithmetic rather than decoration. selftest.js asserts
// exactly that, and the page prints the number.

(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  // ── Twiddles ──────────────────────────────────────────────────────────────
  //
  // cos/sin tables per transform size, built once and kept. The alternative —
  // advancing one complex rotor by repeated multiplication — costs no memory
  // and drifts: thirteen stages of a 8192-point transform accumulate enough
  // rounding in the rotor to put the round-trip error near 1e-10 instead of
  // 1e-16. The table costs 64 KB at the largest size used here and is exact to
  // whatever Math.cos is exact to.

  const tables = new Map();

  function table(n) {
    let t = tables.get(n);
    if (t) return t;

    const half = n >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      cos[k] = Math.cos((-TAU * k) / n);
      sin[k] = Math.sin((-TAU * k) / n);
    }

    // Bit-reversal permutation, precomputed. rev[i] is i with its log2(n) bits
    // reversed; the transform reads its input in this order so that each stage
    // afterwards works on adjacent pairs.
    const rev = new Uint32Array(n);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[i] = r;
    }

    t = { cos, sin, rev };
    tables.set(n, t);
    return t;
  }

  function isPow2(n) {
    return n > 0 && (n & (n - 1)) === 0;
  }

  // ── The butterfly ─────────────────────────────────────────────────────────
  //
  // In place, decimation in time. `inverse` flips the sign of the rotation and
  // divides by n at the end, which is the only difference between a transform
  // and its inverse.

  function fft(re, im, inverse) {
    const n = re.length;
    if (n !== im.length) throw new Error('fft: re and im differ in length');
    if (!isPow2(n)) throw new Error('fft: length ' + n + ' is not a power of two');
    if (n === 1) return;

    const t = table(n);
    const rev = t.rev, tc = t.cos, ts = t.sin;
    const sign = inverse ? -1 : 1;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let x = re[i]; re[i] = re[j]; re[j] = x;
        x = im[i]; im[i] = im[j]; im[j] = x;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;                   // stride into the size-n table
      for (let base = 0; base < n; base += len) {
        for (let j = 0, tw = 0; j < half; j++, tw += step) {
          const wr = tc[tw], wi = sign * ts[tw];
          const a = base + j, b = a + half;
          const br = re[b], bi = im[b];
          const vr = br * wr - bi * wi;
          const vi = br * wi + bi * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr;        im[a] += vi;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  function ifft(re, im) { fft(re, im, true); }

  // ── Real input ────────────────────────────────────────────────────────────
  //
  // A real signal's spectrum is conjugate-symmetric, so half of a complex
  // transform's output is redundant and half of its work is wasted. The
  // standard dodge: pack x[2k] into the real part and x[2k+1] into the
  // imaginary part of a half-length sequence, transform that, and separate the
  // two interleaved spectra afterwards. Z[k] carries the sum of the even and
  // odd transforms; conj(Z[M-k]) carries their difference, because conjugating
  // and reflecting is what packing two real sequences into one complex one
  // does to them.
  //
  // Returns { re, im } of length n/2 + 1 — bin 0 to bin n/2, DC to Nyquist,
  // both of which are real for real input.

  function realFFT(x) {
    const n = x.length;
    if (!isPow2(n)) throw new Error('realFFT: length ' + n + ' is not a power of two');

    const m = n >> 1;
    const zr = new Float64Array(m);
    const zi = new Float64Array(m);
    for (let k = 0; k < m; k++) { zr[k] = x[2 * k]; zi[k] = x[2 * k + 1]; }
    fft(zr, zi, false);

    const outR = new Float64Array(m + 1);
    const outI = new Float64Array(m + 1);
    const t = table(n);

    for (let k = 0; k <= m; k++) {
      const k1 = k % m, k2 = (m - k) % m;
      // E = even-sample transform, O = odd-sample transform, recovered from
      // the packed one.
      const er = 0.5 * (zr[k1] + zr[k2]);
      const ei = 0.5 * (zi[k1] - zi[k2]);
      const or_ = 0.5 * (zi[k1] + zi[k2]);
      const oi = -0.5 * (zr[k1] - zr[k2]);
      // X[k] = E[k] + W_n^k · O[k]
      const wr = t.cos[k % m] * (k === m ? -1 : 1);
      const wi = t.sin[k % m] * (k === m ? -1 : 1);
      outR[k] = er + (or_ * wr - oi * wi);
      outI[k] = ei + (or_ * wi + oi * wr);
    }
    return { re: outR, im: outI };
  }

  // The naive transform, O(n²), straight from the definition. Not used by the
  // tool — it exists so the fast one has something independent to be checked
  // against, and so a reader can see the thing the fast one is fast at.
  function naiveDFT(x) {
    const n = x.length;
    const m = n >> 1;
    const re = new Float64Array(m + 1), im = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) {
      let sr = 0, si = 0;
      for (let i = 0; i < n; i++) {
        const a = (-TAU * k * i) / n;
        sr += x[i] * Math.cos(a);
        si += x[i] * Math.sin(a);
      }
      re[k] = sr; im[k] = si;
    }
    return { re: re, im: im };
  }

  // ── Windows ───────────────────────────────────────────────────────────────
  //
  // Cutting a sound into frames means multiplying by a rectangle, and a
  // rectangle's own spectrum is a sinc that rings for the whole width of the
  // band: a single steady sine, analysed through a rectangle, smears across
  // every bin. Every other window trades a wider main lobe — coarser frequency
  // resolution — for lower sidelobes, and the whole choice is that trade.
  //
  // The figures the page prints for each window are measured from the window
  // itself rather than quoted from Harris 1978, so they cannot drift from the
  // arrays actually used.

  const WINDOWS = {
    rectangular: { name: 'Rectangular', cos: [1] },
    hann:        { name: 'Hann',        cos: [0.5, -0.5] },
    hamming:     { name: 'Hamming',     cos: [0.54, -0.46] },
    blackman:    { name: 'Blackman',    cos: [0.42, -0.5, 0.08] },
    'blackman-harris': {
      name: 'Blackman–Harris',
      cos: [0.35875, -0.48829, 0.14128, -0.01168],
    },
  };

  // Every window here is a sum of cosines at multiples of the frame rate — the
  // family that covers all five — so one loop builds them all.
  function window(kind, n) {
    const spec = WINDOWS[kind] || WINDOWS.hann;
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let j = 0; j < spec.cos.length; j++) {
        v += spec.cos[j] * Math.cos((TAU * j * i) / n);
      }
      w[i] = v;
    }
    return w;
  }

  // Half the width of the window's main lobe, in bins of a transform the same
  // length as the window. For every window in the family above it is just the
  // number of cosine terms — one for the rectangle, two for Hann and Hamming,
  // three for Blackman, four for Blackman–Harris — because each extra term
  // adds a pair of shifted sincs a bin either side of the last. It is how wide
  // a single partial is smeared, and so how many bins have to be lifted out of
  // the spectrum to lift out one sinusoid.
  function mainLobe(kind) {
    return (WINDOWS[kind] || WINDOWS.hann).cos.length;
  }

  // Coherent gain: what the window does to the amplitude of a sine sitting
  // exactly on a bin. Dividing by it is what makes a peak's height read as the
  // amplitude of the partial rather than the amplitude times whatever the
  // window happened to be.
  function coherentGain(w) {
    let s = 0;
    for (let i = 0; i < w.length; i++) s += w[i];
    return s / w.length;
  }

  // Equivalent noise bandwidth, in bins: how wide a perfect rectangular filter
  // would have to be to pass the same noise power. It is the honest answer to
  // "how far apart must two tones be", and it is always wider than one bin.
  function enbw(w) {
    let s = 0, s2 = 0;
    for (let i = 0; i < w.length; i++) { s += w[i]; s2 += w[i] * w[i]; }
    return (w.length * s2) / (s * s);
  }

  // ── The main lobe's shape ─────────────────────────────────────────────────
  //
  // A partial almost never sits on a bin. When it sits a third of a bin away,
  // the tallest bin near it does not read the partial's amplitude: it reads
  // the partial's amplitude times whatever the window's transform is a third
  // of a bin off centre, which for a Hann window is 0.85. Ignoring that costs
  // up to 1.4 dB, and it is the single largest error left in an otherwise
  // exact chain — larger than the frequency estimate, larger than the
  // transform, larger than everything downstream of it.
  //
  // So the shape is measured once per window and divided out. Because the
  // window is a sum of cosines evaluated symmetrically, its transform is real
  // and the sum below is the transform: no FFT, no padding, and no need to do
  // it at the length actually in use, since the normalised main lobe of a
  // cosine-sum window is the same shape at every length that matters.

  const LOBE_STEPS = 512;                 // over δ ∈ [0, 1] bins
  const lobes = new Map();

  function lobeTable(kind) {
    let t = lobes.get(kind);
    if (t) return t;
    const L = 512;
    const w = window(kind, L);
    t = new Float64Array(LOBE_STEPS + 1);
    let w0 = 0;
    for (let i = 0; i < L; i++) w0 += w[i];
    for (let d = 0; d <= LOBE_STEPS; d++) {
      const delta = d / LOBE_STEPS;
      let re = 0, im = 0;
      for (let i = 0; i < L; i++) {
        const a = (-TAU * delta * (i - L / 2)) / L;
        re += w[i] * Math.cos(a);
        im += w[i] * Math.sin(a);
      }
      t[d] = Math.hypot(re, im) / Math.abs(w0);
    }
    lobes.set(kind, t);
    return t;
  }

  // The window's response δ bins off centre, relative to its response on
  // centre. Symmetric, so only |δ| matters.
  function lobeGain(kind, delta) {
    const t = lobeTable(kind);
    const d = Math.min(1, Math.abs(delta)) * LOBE_STEPS;
    const i = Math.floor(d);
    if (i >= LOBE_STEPS) return t[LOBE_STEPS];
    return t[i] + (t[i + 1] - t[i]) * (d - i);
  }

  // The highest sidelobe, in dB below the peak, measured by transforming the
  // window itself heavily zero-padded and looking past the first null.
  function sidelobeDb(kind) {
    const n = 64, pad = 4096;
    const w = window(kind, n);
    const x = new Float64Array(pad);
    x.set(w);
    const s = realFFT(x);
    const mag = [];
    for (let k = 0; k <= pad >> 1; k++) mag.push(Math.hypot(s.re[k], s.im[k]));
    const peak = mag[0];
    // Walk down off the main lobe to the first null, then take the largest
    // thing after it.
    let k = 1;
    while (k < mag.length - 1 && mag[k + 1] < mag[k]) k++;
    let hi = 0;
    for (let j = k; j < mag.length; j++) if (mag[j] > hi) hi = mag[j];
    return 20 * Math.log10(hi / peak);
  }

  // ── Short-time Fourier transform ──────────────────────────────────────────
  //
  // opts: { size, hop, window, pad, rate }. `size` is how many samples each
  // frame looks at and `pad` is the transform length: padding to a longer
  // transform does not tell you anything new — it interpolates between the
  // bins you already had, drawing the same curve at more points. The page says
  // so, because "more bins" reads like "more resolution" and is not.
  //
  // Returns frames of magnitude and phase, magnitude already corrected for
  // coherent gain and for the one-sided spectrum, so a 0.5-amplitude sine
  // reads 0.5.

  function stft(samples, opts) {
    const size = opts.size;
    const hop = opts.hop;
    const pad = Math.max(size, opts.pad || size);
    const w = window(opts.window || 'hann', size);
    const cg = coherentGain(w);
    const bins = (pad >> 1) + 1;

    // Frames are centred rather than aligned to their left edge: frame f looks
    // at the samples around f·hop, which is the instant the page reports for
    // it. That takes half a frame of silence in front of the signal, and a
    // whole one after it — without them the first and last half-frame of a
    // sound are covered by too few windows to be rebuilt, and the way back
    // returns silence at both ends. The bug that costs is quiet: a spectrogram
    // that looks perfect and a reconstruction 17 dB off, all of it in the
    // first and last few hundredths of a second.
    const pre = size >> 1;
    const len = samples.length;
    const count = Math.floor((len + pre) / hop) + 1;

    const mags = new Array(count);
    const phases = new Array(count);
    const buf = new Float64Array(pad);

    for (let f = 0; f < count; f++) {
      const at = f * hop - pre;
      buf.fill(0);
      // Zero-phase: the windowed frame is laid into the buffer rotated so its
      // middle sample sits at index 0 and the first half wraps round to the
      // end. Without this, every reported phase carries the window's own
      // linear phase term on top of the signal's, which is harmless for a
      // picture and fatal for resynthesis — the partials come back at the
      // right frequencies and the wrong phases, and a residual computed by
      // subtraction is then as loud as the thing it was meant to cancel.
      //
      // The rotation also puts the phase reference where it belongs: with the
      // window centred and pre = size/2, frame f reports the phase the signal
      // had at absolute sample f·hop, which is the instant the page labels it.
      for (let i = 0; i < size; i++) {
        const j = at + i;
        if (j < 0 || j >= len) continue;
        buf[(i - pre + pad) % pad] = samples[j] * w[i];
      }

      const s = realFFT(buf);
      const mag = new Float32Array(bins);
      const ph = new Float32Array(bins);
      // Two corrections. 2/size turns the transform's sum into an amplitude
      // and doubles it for the half of the spectrum not being looked at;
      // 1/cg undoes the window's own attenuation. DC and Nyquist have no
      // mirror image, so they do not get the doubling.
      const scale = 2 / (size * cg);
      for (let k = 0; k < bins; k++) {
        const re = s.re[k], im = s.im[k];
        const half = k === 0 || k === bins - 1 ? 0.5 : 1;
        mag[k] = Math.hypot(re, im) * scale * half;
        ph[k] = Math.atan2(im, re);
      }
      mags[f] = mag;
      phases[f] = ph;
    }

    return {
      mag: mags,
      phase: phases,
      frames: count,
      bins: bins,
      size: size,
      hop: hop,
      pad: pad,
      pre: pre,
      rate: opts.rate,
      windowKind: opts.window || 'hann',
      coherentGain: cg,
      binHz: opts.rate / pad,
      frameSec: hop / opts.rate,
      length: samples.length,
    };
  }

  // The way back: weighted overlap-add. Each frame is transformed back,
  // multiplied by the analysis window a second time, and summed; the running
  // sum of the squared window is divided out at the end. Dividing by the sum
  // actually accumulated, rather than by the value a constant-overlap-add hop
  // is supposed to produce, is what makes this exact for any window and any
  // hop — including at the two ends, where fewer frames overlap and the COLA
  // assumption is false.
  //
  // What comes back is the input to about −145 dB. That floor is not the
  // transform, which round-trips at 1e-16: it is the Float32Array the
  // magnitudes and phases are stored in, which halves the memory a long file
  // costs and is 90 dB below anything audible.
  function istft(s) {
    const w = window(s.windowKind, s.size);
    const out = new Float64Array(s.length);
    const norm = new Float64Array(s.length);
    const re = new Float64Array(s.pad);
    const im = new Float64Array(s.pad);
    const cg = s.coherentGain;
    const bins = s.bins;

    for (let f = 0; f < s.frames; f++) {
      const mag = s.mag[f], ph = s.phase[f];
      re.fill(0); im.fill(0);
      const scale = 2 / (s.size * cg);
      for (let k = 0; k < bins; k++) {
        const half = k === 0 || k === bins - 1 ? 0.5 : 1;
        const m = mag[k] / (scale * half);
        const r = m * Math.cos(ph[k]);
        const i = m * Math.sin(ph[k]);
        re[k] = r; im[k] = i;
        if (k > 0 && k < bins - 1) { re[s.pad - k] = r; im[s.pad - k] = -i; }
      }
      ifft(re, im);

      const at = f * s.hop - s.pre;
      for (let i = 0; i < s.size; i++) {
        const j = at + i;
        if (j < 0 || j >= s.length) continue;
        out[j] += re[(i - s.pre + s.pad) % s.pad] * w[i];   // undo the rotation
        norm[j] += w[i] * w[i];
      }
    }

    for (let i = 0; i < out.length; i++) {
      if (norm[i] > 1e-12) out[i] /= norm[i];
    }
    return out;
  }

  // ── Numbers the page prints ───────────────────────────────────────────────

  function db(x) { return 20 * Math.log10(Math.max(x, 1e-12)); }

  // Root-mean-square difference between two signals, in dB relative to the
  // first. The tool's headline honesty figure: how far a reconstruction is
  // from the thing it reconstructs.
  function errorDb(a, b) {
    let se = 0, sa = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i];
      se += d * d;
      sa += a[i] * a[i];
    }
    if (sa === 0) return -Infinity;
    return 10 * Math.log10(se / sa);
  }

  function rms(x) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, x.length));
  }

  root.Fourier = {
    fft: fft,
    ifft: ifft,
    realFFT: realFFT,
    naiveDFT: naiveDFT,
    window: window,
    WINDOWS: WINDOWS,
    coherentGain: coherentGain,
    mainLobe: mainLobe,
    lobeGain: lobeGain,
    enbw: enbw,
    sidelobeDb: sidelobeDb,
    stft: stft,
    istft: istft,
    db: db,
    errorDb: errorDb,
    rms: rms,
    isPow2: isPow2,
  };
})(typeof self !== 'undefined' ? self : globalThis);
