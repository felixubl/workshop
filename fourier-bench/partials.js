// Fourier Bench: from a spectrum to a list of partials.
//
// A transform gives a magnitude per bin, and bins are not partials. A 1000 Hz
// sine analysed with 11.7 Hz bins does not land on a bin, so it appears as a
// hump three or four bins wide whose tallest point is at 1007.8 Hz and whose
// height is 7% short of the true amplitude. Reading the tallest bin and
// calling it the answer is the mistake this file exists to avoid: it is wrong
// by up to half a bin in frequency and up to 1.4 dB in amplitude, and the
// error does not shrink when you pad the transform, because padding
// interpolates the same curve rather than measuring a better one.
//
// Two estimators, both cheap:
//
//   parabolic    fit a parabola through the peak bin and its two neighbours in
//                dB. Exact for a Gaussian window, good to a few hundredths of
//                a bin for the rest. Needs one frame.
//   phase        compare a bin's phase against the phase it would have if it
//                held exactly the bin frequency, one hop earlier. The residue
//                is the frequency error. Good to a thousandth of a bin on a
//                steady tone, and meaningless on a transient.
//
// The tool computes both, prints both, and takes the phase estimate only when
// the two agree to within half a bin — the standard check, and the reason a
// drum hit does not report its partials to four decimal places.

(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  function db(x) { return 20 * Math.log10(Math.max(x, 1e-12)); }

  // Fold a phase difference into (−π, π]. Everything about the phase estimator
  // rests on this: the measured advance is only known modulo a turn, and the
  // bin frequency is the guess that says which turn.
  function principal(a) {
    return a - TAU * Math.round(a / TAU);
  }

  // ── Peaks ─────────────────────────────────────────────────────────────────
  //
  // opts: { floorDb, maxPeaks, minHz, maxHz, prev (previous frame's phase) }

  function peaks(s, frame, opts) {
    opts = opts || {};
    const mag = s.mag[frame];
    const ph = s.phase[frame];
    const prev = frame > 0 ? s.phase[frame - 1] : null;
    const binHz = s.binHz;
    const floorDb = opts.floorDb === undefined ? -90 : opts.floorDb;
    const minHz = opts.minHz || 0;
    const maxHz = opts.maxHz || s.rate / 2;

    let loudest = 0;
    for (let k = 0; k < mag.length; k++) if (mag[k] > loudest) loudest = mag[k];
    if (loudest <= 0) return [];
    const cut = loudest * Math.pow(10, floorDb / 20);

    const out = [];
    for (let k = 1; k < mag.length - 1; k++) {
      const m = mag[k];
      if (m < cut || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const hz0 = k * binHz;
      if (hz0 < minHz || hz0 > maxHz) continue;

      // Parabolic interpolation, in dB because that is the domain a window's
      // main lobe is nearly a parabola in.
      const a = db(mag[k - 1]), b = db(mag[k]), c = db(mag[k + 1]);
      const denom = a - 2 * b + c;
      const delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
      const parabHz = (k + delta) * binHz;
      // The peak of that parabola, which is above the tallest bin — this is
      // the correction that recovers the amplitude the scalloping lost.
      const peakDb = b - 0.25 * (a - c) * delta;
      const amp = Math.pow(10, peakDb / 20);

      // Phase-difference estimate. The bin is expected to advance by its own
      // frequency over one hop; whatever it advanced beyond that is the offset
      // from the bin centre.
      let phaseHz = NaN;
      if (prev) {
        const expected = (TAU * k * s.hop) / s.pad;
        const got = ph[k] - prev[k];
        const dev = principal(got - expected);
        phaseHz = (k + (dev * s.pad) / (TAU * s.hop)) * binHz;
      }

      // Take the phase estimate when it agrees with the parabola to within
      // half a bin. Disagreement means the bin is not holding one steady
      // sinusoid — a transient, or two partials inside one main lobe — and
      // there the parabola is the safer of two imperfect answers.
      const agrees = isFinite(phaseHz) && Math.abs(phaseHz - parabHz) < 0.5 * binHz;
      const hz = agrees ? phaseHz : parabHz;

      // Amplitude, corrected for where in the main lobe the bin fell. The
      // parabola's own peak is a good guess and this is a better one: it
      // divides the measured bin by the window's known response at the
      // measured offset, rather than extrapolating from three samples of a
      // curve that is only approximately a parabola. On a steady tone off
      // centre it is the difference between 0.8% amplitude error and 0.01%.
      // The offset is converted to bins of the window rather than bins of the
      // transform, since padding makes those differ.
      const off = ((hz / binHz) - k) * (s.size / s.pad);
      const gain = Fourier.lobeGain(s.windowKind, off);
      const corrected = gain > 0.05 ? mag[k] / gain : amp;

      out.push({
        bin: k,
        hz: hz,
        parabHz: parabHz,
        phaseHz: phaseHz,
        steady: agrees,
        amp: corrected,
        parabAmp: amp,
        db: 20 * Math.log10(Math.max(corrected, 1e-12)),
        phase: ph[k],
      });
    }

    out.sort((p, q) => q.amp - p.amp);
    const max = opts.maxPeaks || 40;
    const kept = out.slice(0, max);
    kept.sort((p, q) => p.hz - q.hz);
    // How many there were before the cap. A cap that silently drops the top
    // forty harmonics of a sawtooth makes the resynthesis 24 dB worse and
    // looks exactly like a method that is 24 dB worse, so the number that was
    // thrown away travels with the list and the page prints it.
    kept.total = out.length;
    return kept;
  }

  // ── The fundamental ───────────────────────────────────────────────────────
  //
  // Scoring a candidate f0 two ways at once, which is what keeps the answer
  // off the octaves either side:
  //
  //   explained   the share of the observed peak amplitude that lands on some
  //               multiple of f0. A candidate that is too high explains little,
  //               because the partials between its multiples have nowhere to go.
  //   present     the share of the multiples f0 predicts that are actually
  //               there, weighted 1/n so the low ones count most. A candidate
  //               an octave too low predicts a partial between every real one
  //               and scores badly here — which is the whole reason this term
  //               exists, since on `explained` alone f0/2 always ties f0.
  //
  // The product is the score. Both terms are needed; either alone has a
  // systematic octave error, in opposite directions.

  const TOL_CENTS = 45;

  function cents(a, b) { return 1200 * Math.log2(a / b); }

  // Match the series n·f0·√(1 + Bn²) against the peaks, each peak claimed by
  // at most one harmonic number. The one-to-one constraint is not tidiness:
  // without it a square wave, whose even harmonics are all absent, hands its
  // 15th partial to harmonic numbers 16 through 24 as well, because a wide
  // enough tolerance lets every unsatisfied n grab the nearest peak it can
  // reach. The fit then sees one partial claiming nine different frequencies
  // and reports a fundamental 24 cents sharp with an invented stiffness.
  //
  // Low n first: those are the partials whose position is least ambiguous, and
  // a greedy pass in that order is both what a person does by eye and enough
  // here — the alternative, a full assignment problem, buys nothing on a list
  // this short and this well separated.
  function matchSeries(list, f0, B, nMax, tol) {
    const taken = new Array(list.length).fill(false);
    const found = [];
    for (let n = 1; n <= nMax; n++) {
      const target = n * f0 * Math.sqrt(1 + B * n * n);
      let at = -1, err = Infinity;
      for (let i = 0; i < list.length; i++) {
        if (taken[i]) continue;
        const e = Math.abs(cents(list[i].hz, target));
        if (e < err) { err = e; at = i; }
      }
      if (at >= 0 && err <= tol) {
        taken[at] = true;
        found.push({ n: n, peak: list[at], cents: err });
      }
    }
    return found;
  }

  // How many multiples of f0 to expect. Rounded rather than floored, because
  // the highest peak is itself a multiple of the right f0 and floating point
  // puts that ratio a hair under the integer: flooring drops a correct
  // candidate's own top harmonic out of the count, which is enough to lose it
  // the comparison against a candidate several octaves too high.
  function harmonicCount(topHz, f0) {
    return Math.max(1, Math.min(24, Math.round(topHz / f0)));
  }

  // 1/√n rather than 1/n. Both punish a candidate an octave too low, which is
  // the point of the term, but 1/n punishes it so hard that a sound whose
  // fundamental is genuinely absent — three sines at 450, 600 and 750, the ear
  // hearing 150 — loses to its own third partial. The gentler weight keeps the
  // octave-down error out and still hears the missing fundamental.
  function weight(n) { return 1 / Math.sqrt(n); }

  function score(list, f0, B, totalAmp, topHz) {
    const nMax = harmonicCount(topHz, f0);
    const found = matchSeries(list, f0, B, nMax, TOL_CENTS);
    let predicted = 0, present = 0, explained = 0;
    for (let n = 1; n <= nMax; n++) predicted += weight(n);
    for (const h of found) { present += weight(h.n); explained += h.peak.amp; }
    return (explained / totalAmp) * (present / predicted);
  }

  function fundamental(list, opts) {
    opts = opts || {};
    const minHz = opts.minHz || 25;
    if (list.length === 0) return null;

    let totalAmp = 0, topHz = 0;
    for (const p of list) { totalAmp += p.amp; if (p.hz > topHz) topHz = p.hz; }
    if (totalAmp === 0) return null;

    // Candidates: every peak, taken as if it were the nth partial. The true
    // fundamental is in this set whenever it has any partial at all above the
    // noise, including when it is missing from the spectrum itself — which is
    // how a voice on a telephone still has a pitch.
    const cands = [];
    const strong = list.slice().sort((a, b) => b.amp - a.amp).slice(0, 12);
    for (const p of strong) {
      for (let n = 1; n <= 16; n++) {
        const f = p.hz / n;
        if (f < minHz) break;
        if (!cands.some((c) => Math.abs(cents(c, f)) < 12)) cands.push(f);
      }
    }

    let best = null, bestScore = -1;
    for (const f of cands) {
      const sc = score(list, f, 0, totalAmp, topHz);
      if (sc > bestScore) { bestScore = sc; best = f; }
    }
    if (best === null) return null;

    // Refine. A real string is stiff, so its partials do not sit at integer
    // multiples but at n·f0·√(1 + B·n²) — the stretched octaves a piano tuner
    // works around are this number and nothing else. Fitting f0 alone against
    // the integer model, on a sound that has any stiffness at all, drags f0
    // sharp: the high partials are sharp, they carry the most leverage in a
    // least-squares fit, and the fitted f0 splits the difference. Then B is
    // measured against that wrong f0 and comes out several times too small.
    //
    // So the two are fitted together, alternating — f0 given B, B given f0 —
    // and the harmonics are re-matched each round, because at n=12 a stiffness
    // the first pass could not see has moved the partial most of a semitone
    // from where the integer model looked for it. The two parameters are
    // strongly correlated, so alternation crawls rather than jumps: it takes
    // about a dozen rounds to settle, and each is a pass over at most 24
    // numbers.
    //
    // The stretch is in the prediction, so the tolerance around it stays tight
    // throughout. Widening it as well double-counts, and a free B with a loose
    // tolerance does not refine a fundamental — it goes looking for a new one,
    // and on a square wave it finds 298 Hz with a stiffness a square wave does
    // not have.
    function refine(rounds, stiff) {
      let f0 = best, B = 0, found = [];
      for (let r = 0; r < rounds; r++) {
        found = matchSeries(list, f0, B, harmonicCount(topHz, f0), TOL_CENTS);
        if (found.length === 0) break;

        // f0 given B: the model is linear in f0 once the stretch factor is
        // known, so this is one weighted division.
        let num = 0, den = 0;
        for (const h of found) {
          const g = h.n * Math.sqrt(1 + B * h.n * h.n);
          const a = h.peak.amp;
          num += a * h.peak.hz * g;
          den += a * g * g;
        }
        if (den > 0) f0 = num / den;
        if (!stiff) continue;

        // B given f0: (f_n / n·f0)² − 1 = B·n², one regression through the
        // origin. Negative stiffness is unphysical, so a negative fit means no
        // measurable stiffness rather than a springy string.
        let bn = 0, bd = 0, used = 0;
        for (const h of found) {
          if (h.n < 2) continue;
          const q = h.peak.hz / (h.n * f0);
          const x = h.n * h.n;
          bn += x * (q * q - 1); bd += x * x; used++;
        }
        B = used >= 3 && bd > 0 ? Math.max(0, Math.min(0.01, bn / bd)) : 0;
      }
      return { hz: f0, B: B, found: found };
    }

    // How far a fitted model actually lands from the partials it is fitting:
    // the amplitude-weighted RMS of the error in cents. This is the quantity
    // the two models get compared on, and it has to be — the candidate score
    // above cannot do it. That score saturates: a frame whose every partial is
    // accounted for reads 100% whether the partials sit where the model says
    // to a hundredth of a cent or to a fifth of a semitone, so comparing two
    // models on it compares two numbers that are both 1.
    function residual(fit) {
      if (!fit.found.length) return Infinity;
      let se = 0, w = 0;
      for (const h of fit.found) {
        const want = h.n * fit.hz * Math.sqrt(1 + fit.B * h.n * h.n);
        const c = cents(h.peak.hz, want);
        se += h.peak.amp * c * c;
        w += h.peak.amp;
      }
      return w > 0 ? Math.sqrt(se / w) : Infinity;
    }

    const plain = refine(4, false);
    const stiff = refine(24, true);
    const ePlain = residual(plain), eStiff = residual(stiff);

    // Occam. The stretched model has a parameter the plain one does not, so it
    // has to earn it — halve the error, and account for at least as many
    // partials. Without a test a spectrum with gaps in it, a clarinet or
    // anything with only odd harmonics, can always be fitted a shade better by
    // a fundamental somewhere else with a stiffness to match, and the tool
    // would report that instead of the note being played.
    const use = stiff.B > 0 && stiff.found.length >= plain.found.length &&
                eStiff < ePlain * 0.5
      ? stiff : plain;

    return {
      hz: use.hz,
      score: Math.max(bestScore, score(list, use.hz, use.B, totalAmp, topHz)),
      partials: use.found.length,
      inharmonicity: use.B,
      harmonics: use.found,
      centsError: use === stiff ? eStiff : ePlain,
    };
  }

  // Assign a harmonic number to every peak that has one, and mark the rest.
  // The number is found against the stretched model, so a stiff string's high
  // partials are still numbered; the cents printed beside it are against the
  // plain integer multiple, which is the interesting quantity — it is how far
  // this partial actually sits from where a harmonic series says it should,
  // and on a piano string it grows with n exactly as √(1 + Bn²) predicts.
  //
  // A peak with no number is not a failure of the analysis. A bell is mostly
  // such peaks, and a bell is the interesting case.
  function harmonics(list, f0) {
    if (!f0) return list.map((p) => Object.assign({ n: null, cents: null }, p));
    const B = f0.inharmonicity || 0;
    const predict = (n) => n * f0.hz * Math.sqrt(1 + B * n * n);
    return list.map((p) => {
      let n = null, err = Infinity;
      for (let i = 1; i <= 64; i++) {
        const e = Math.abs(cents(p.hz, predict(i)));
        if (e < err) { err = e; n = i; }
        if (predict(i) > p.hz * 1.5) break;
      }
      if (n === null || err > 60) return Object.assign({ n: null, cents: null }, p);
      return Object.assign({}, p, { n: n, cents: cents(p.hz, n * f0.hz) });
    });
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  //
  // Equal temperament off A4 = 440, with the error printed in cents. Same
  // convention as the tracker next door, where the cents are the gap between
  // the note asked for and the nearest divider the chip can produce; here they
  // are the gap between a partial and the grid Western notation puts under it,
  // which no acoustic instrument sits on exactly.

  const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

  function note(hz) {
    if (!(hz > 0)) return null;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const near = Math.round(midi);
    if (near < 0 || near > 127) return null;
    return {
      name: NAMES[((near % 12) + 12) % 12] + (Math.floor(near / 12) - 1),
      cents: (midi - near) * 100,
      midi: near,
    };
  }

  root.Partials = {
    peaks: peaks,
    fundamental: fundamental,
    harmonics: harmonics,
    note: note,
    cents: cents,
    principal: principal,
    db: db,
  };
})(typeof self !== 'undefined' ? self : globalThis);
