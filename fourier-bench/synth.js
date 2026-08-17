// Fourier Bench: putting the sound back together, which is where the tool
// either keeps its promise or does not.
//
// Anyone can draw a spectrogram. A spectrogram is unfalsifiable by eye: it is
// a coloured rectangle, and a coloured rectangle produced by a broken
// transform looks exactly as convincing as one produced by a correct one. The
// only cheap way to know that an analysis actually took a sound apart is to
// put the pieces back and listen to what is missing.
//
// Two ways back, answering two different questions.
//
//   split()      Divide the spectrum itself in two: the bins under the main
//                lobe of every detected peak, and every other bin. Transform
//                both halves back. This is exact — the halves sum to the input
//                to about −145 dB, because splitting a sum of bins and adding
//                them again is a sum of bins. The residual is what a partial
//                list can never hold: breath, bow, hammer, the room.
//
//   additive()   Throw the spectrum away and rebuild the sound from the table
//                of numbers alone, with one oscillator per tracked partial.
//                This is not exact and is not meant to be. It is the strong
//                claim — that a few hundred numbers per second are the sound —
//                and the page prints how far it lands from the original in dB
//                rather than asking anyone to take it on faith.

(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  // ── Tracking ──────────────────────────────────────────────────────────────
  //
  // A partial is not a peak, it is a peak that persists. Frame by frame, each
  // live track claims the nearest peak to where it was, and the tolerance is
  // in cents rather than hertz because a vibrato of a fixed width in cents is
  // a fixed width at every pitch, and a tolerance in hertz would be far too
  // tight at the bottom and far too loose at the top.
  //
  // Tracks are born and they die. A track that finds nothing this frame ends,
  // and its last entry is duplicated at zero amplitude so the oscillator fades
  // out over a hop instead of stopping mid-cycle; a peak nothing claimed
  // starts a track, with a zero-amplitude entry before it for the same reason.
  // A click at every birth and death is what happens without this, and on a
  // busy sound there are thousands of both.

  function track(perFrame, s, opts) {
    opts = opts || {};
    const tolCents = opts.tolCents || 60;
    const minFrames = opts.minFrames || 2;
    const maxTracks = opts.maxTracks || 200;

    let live = [];
    const done = [];

    for (let f = 0; f < perFrame.length; f++) {
      const peaks = perFrame[f] || [];
      const taken = new Array(peaks.length).fill(false);

      // Loudest tracks choose first: when two tracks cross, the one carrying
      // the energy is the one whose identity matters.
      live.sort((a, b) => b.amp[b.amp.length - 1] - a.amp[a.amp.length - 1]);

      const carried = [];
      for (const t of live) {
        const last = t.hz[t.hz.length - 1];
        let at = -1, err = Infinity;
        for (let i = 0; i < peaks.length; i++) {
          if (taken[i]) continue;
          const e = Math.abs(1200 * Math.log2(peaks[i].hz / last));
          if (e < err) { err = e; at = i; }
        }
        if (at >= 0 && err <= tolCents) {
          taken[at] = true;
          t.hz.push(peaks[at].hz);
          t.amp.push(peaks[at].amp);
          t.phase.push(peaks[at].phase);
          carried.push(t);
        } else {
          // Death: one more entry, same frequency, no amplitude.
          t.hz.push(last);
          t.amp.push(0);
          t.phase.push(t.phase[t.phase.length - 1]);
          done.push(t);
        }
      }

      for (let i = 0; i < peaks.length; i++) {
        if (taken[i]) continue;
        // Birth: a silent entry one frame earlier, so the first real frame is
        // the top of a ramp rather than a step.
        carried.push({
          start: f - 1,
          hz: [peaks[i].hz, peaks[i].hz],
          amp: [0, peaks[i].amp],
          phase: [peaks[i].phase, peaks[i].phase],
        });
      }
      live = carried;
    }
    for (const t of live) done.push(t);

    // Drop the flicker: a track two frames long is a peak that appeared once,
    // and on anything noisy there are far more of those than there are
    // partials. What survives is sorted by the energy it carries, which is the
    // order the page draws and truncates in.
    const kept = done.filter((t) => t.hz.length >= minFrames + 1);
    for (const t of kept) {
      let e = 0;
      for (const a of t.amp) e += a * a;
      t.energy = e;
      t.peakAmp = Math.max.apply(null, t.amp);
    }
    kept.sort((a, b) => b.energy - a.energy);
    return kept.slice(0, maxTracks);
  }

  // ── Additive resynthesis ──────────────────────────────────────────────────
  //
  // One oscillator per track, and the whole difficulty is the phase between
  // frames. The analysis gives a frequency and a phase every hop; a synthesis
  // that just ramps the frequency and lets the phase fall where it may drifts
  // out of step with the original within a few frames, and then the residual
  // computed by subtraction is louder than either signal — two sines of equal
  // amplitude in antiphase sum to nothing, and in phase sum to twice.
  //
  // So the phase over each hop is a cubic in time, chosen to arrive at the
  // measured phase of the next frame with the measured frequency of the next
  // frame: four conditions, four coefficients. This is McAulay and Quatieri's
  // 1986 interpolation, and the only subtle part is that phase is known modulo
  // a turn — the number of whole cycles to add is picked to make the cubic as
  // flat as it can be, which is the one choice that does not invent wobble the
  // analysis never saw.

  function additive(tracks, s, opts) {
    opts = opts || {};
    const rate = s.rate;
    const hop = s.hop;
    const out = new Float64Array(s.length);
    const limit = opts.count || tracks.length;

    for (let ti = 0; ti < Math.min(limit, tracks.length); ti++) {
      const t = tracks[ti];
      for (let k = 0; k + 1 < t.hz.length; k++) {
        const f0 = t.start + k;                 // frame index of the segment
        const at = f0 * hop;                    // phase reference, absolute
        if (at >= s.length) break;

        const w0 = (TAU * t.hz[k]) / rate;      // radians per sample
        const w1 = (TAU * t.hz[k + 1]) / rate;
        const a0 = t.amp[k], a1 = t.amp[k + 1];
        const th0 = t.phase[k], th1 = t.phase[k + 1];
        const T = hop;

        // Whole cycles to add so the cubic bends as little as possible.
        const m = Math.round(
          (th0 + w0 * T - th1 + ((w1 - w0) * T) / 2) / TAU
        );
        const d = th1 + TAU * m - th0 - w0 * T;
        const alpha = (3 * d) / (T * T) - (w1 - w0) / T;
        const beta = (-2 * d) / (T * T * T) + (w1 - w0) / (T * T);
        const dA = (a1 - a0) / T;

        for (let i = 0; i < T; i++) {
          const j = at + i;
          if (j < 0 || j >= s.length) continue;
          const th = th0 + w0 * i + alpha * i * i + beta * i * i * i;
          out[j] += (a0 + dA * i) * Math.cos(th);
        }
      }
    }
    return out;
  }

  // ── Spectral split ────────────────────────────────────────────────────────
  //
  // Every bin goes to exactly one of the two outputs, so they sum back to the
  // input by construction. A peak takes the bins under its main lobe with it,
  // which is as many bins either side as the window has cosine terms, scaled
  // by however much the transform was padded past the window.

  function split(s, perFrame, opts) {
    opts = opts || {};
    const lobe = Math.max(
      1,
      Math.round(Fourier.mainLobe(s.windowKind) * (s.pad / s.size))
    );

    const sines = shell(s);
    const rest = shell(s);

    for (let f = 0; f < s.frames; f++) {
      const mag = s.mag[f], ph = s.phase[f];
      const keep = new Uint8Array(s.bins);
      const peaks = perFrame[f] || [];
      for (const p of peaks) {
        const lo = Math.max(0, p.bin - lobe);
        const hi = Math.min(s.bins - 1, p.bin + lobe);
        for (let k = lo; k <= hi; k++) keep[k] = 1;
      }
      const sm = new Float32Array(s.bins), sp = new Float32Array(s.bins);
      const rm = new Float32Array(s.bins), rp = new Float32Array(s.bins);
      for (let k = 0; k < s.bins; k++) {
        if (keep[k]) { sm[k] = mag[k]; sp[k] = ph[k]; }
        else { rm[k] = mag[k]; rp[k] = ph[k]; }
      }
      sines.mag[f] = sm; sines.phase[f] = sp;
      rest.mag[f] = rm; rest.phase[f] = rp;
    }

    return {
      sines: Fourier.istft(sines),
      residual: Fourier.istft(rest),
      lobeBins: lobe,
    };
  }

  // A copy of an analysis with the frame data left empty, so the two halves of
  // a split inherit every setting the transform was made with and cannot
  // silently disagree with it.
  function shell(s) {
    const o = {};
    for (const k in s) if (k !== 'mag' && k !== 'phase') o[k] = s[k];
    o.mag = new Array(s.frames);
    o.phase = new Array(s.frames);
    return o;
  }

  function subtract(a, b) {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] - (b[i] || 0);
    return out;
  }

  // ── WAV ───────────────────────────────────────────────────────────────────
  //
  // 16-bit PCM, mono, no metadata — the same writer as the tracker next door,
  // for the same reason: what is exported has to be the buffer that was heard,
  // and the shortest path from one to the other is the one with nothing in it.

  function wav(samples, rate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);

    function ascii(at, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(at + i, str.charCodeAt(i));
    }

    ascii(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);      // PCM
    view.setUint16(22, 1, true);      // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, n * 2, true);

    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  root.Synth = {
    track: track,
    additive: additive,
    split: split,
    subtract: subtract,
    wav: wav,
  };
})(typeof self !== 'undefined' ? self : globalThis);
