// A radix-2 FFT, and the two things this tool needs from it.
//
// The transform is the cheap part. What matters here is that the inverse is
// used to rebuild the drawing: keeping the M largest coefficients and running
// the whole thing back through an inverse transform costs O(N log N), where
// evaluating M rotating circles at N points by hand costs O(N·M). At a few
// thousand circles that is the difference between a slider that moves and one
// that does not.

export function fft(re, im, inverse) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error("fft: length " + n + " is not a power of two");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// A closed path read as a complex signal: x along the real axis, y along the
// imaginary one. Each coefficient is then one circle — |c| its radius, arg(c)
// where it starts, and its signed index how many turns it makes per lap.
export function coefficients(points) {
  const n = points.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = points[i].x; im[i] = points[i].y; }
  fft(re, im, false);
  const terms = new Array(n);
  for (let k = 0; k < n; k++) {
    terms[k] = {
      bin: k,
      freq: k <= n / 2 ? k : k - n,
      re: re[k] / n,
      im: im[k] / n,
      mag: Math.hypot(re[k], im[k]) / n,
    };
  }
  return terms;
}

// Keep the M biggest circles, throw the rest away, and transform back. The
// zeroed bins are what "fewer circles" means; the inverse puts the curve back
// in one pass instead of summing every circle at every sample.
export function rebuild(terms, keep) {
  const n = terms.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  const order = terms.slice().sort((a, b) => b.mag - a.mag);
  const m = Math.min(keep, n);
  for (let i = 0; i < m; i++) {
    const t = order[i];
    re[t.bin] = t.re * n;
    im[t.bin] = t.im * n;
  }
  fft(re, im, true);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { x: re[i], y: im[i] };
  return { points: out, kept: order.slice(0, m) };
}

// Where every circle's rim sits at time t. The chain is drawn in order of
// decreasing radius, which is the convention and also the only order in which
// the small ones are visible.
export function chain(kept, t) {
  const pts = [{ x: 0, y: 0 }];
  let x = 0, y = 0;
  for (const c of kept) {
    const a = 2 * Math.PI * c.freq * t;
    const cs = Math.cos(a), sn = Math.sin(a);
    x += c.re * cs - c.im * sn;
    y += c.re * sn + c.im * cs;
    pts.push({ x, y });
  }
  return pts;
}
