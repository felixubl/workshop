// Photograph to one bit.
//
// None of this is invented here. Each method is a named, published one, and
// they disagree with each other in ways that matter for a face, so the bench
// runs all of them from the same prepared image and shows them together.

const $ = (id) => document.getElementById(id);

export const METHODS = [
  ["otsu", "Otsu (one global cut)"],
  ["sauvola", "Sauvola (local, document scanning)"],
  ["bradley", "Bradley (local mean)"],
  ["atkinson", "Atkinson dither (the Mac look)"],
  ["floyd", "Floyd-Steinberg dither"],
  ["bayer", "Bayer 8x8 ordered"],
  ["xdog", "XDoG (made for portraits)"],
];

// ── Preparing the picture ───────────────────────────────────────────────────

function boxBlur(f, w, h, r, passes) {
  if (r < 1) return Float32Array.from(f);
  let src = Float32Array.from(f);
  let dst = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[y * w + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        dst[y * w + x] = sum / n;
        sum -= src[y * w + Math.min(w - 1, Math.max(0, x - r))];
        sum += src[y * w + Math.min(w - 1, Math.max(0, x + r + 1))];
      }
    }
    [src, dst] = [dst, src];
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = sum / n;
        sum -= src[Math.min(h - 1, Math.max(0, y - r)) * w + x];
        sum += src[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

// Dividing the picture by a heavily blurred copy of itself throws away the
// lighting and keeps the detail. It is why one cheek being in shadow stops
// deciding the whole threshold.
function flattenLighting(lum, w, h, r) {
  if (r < 1) return Float32Array.from(lum);
  const bg = boxBlur(lum, w, h, r, 2);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.min(1, Math.max(0, (lum[i] / Math.max(0.02, bg[i])) * 0.5));
  return out;
}

function adjust(lum, w, h, contrast, gamma) {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let v = Math.min(1, Math.max(0, (lum[i] - 0.5) * contrast + 0.5));
    out[i] = Math.pow(v, gamma);
  }
  return out;
}

function meanAndStd(lum, w, h, r) {
  const n = (2 * r + 1) * (2 * r + 1);
  const t1 = new Float32Array(w * h), t2 = new Float32Array(w * h);
  const m = new Float32Array(w * h), s = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, b = 0;
    for (let k = -r; k <= r; k++) {
      const v = lum[y * w + Math.min(w - 1, Math.max(0, x + k))];
      a += v; b += v * v;
    }
    t1[y * w + x] = a; t2[y * w + x] = b;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, b = 0;
    for (let k = -r; k <= r; k++) {
      const j = Math.min(h - 1, Math.max(0, y + k)) * w + x;
      a += t1[j]; b += t2[j];
    }
    const mean = a / n;
    m[y * w + x] = mean;
    s[y * w + x] = Math.sqrt(Math.max(0, b / n - mean * mean));
  }
  return { mean: m, std: s };
}

function otsuThreshold(lum, mask) {
  const hist = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < lum.length; i++) {
    if (mask && !mask[i]) continue;
    hist[Math.min(255, Math.max(0, Math.round(lum[i] * 255)))]++;
    n++;
  }
  if (!n) return 0.5;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = i; }
  }
  return thr / 255;
}

// ── The methods ─────────────────────────────────────────────────────────────

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

function diffuse(lum, w, h, weights, divisor, bias) {
  const buf = Float32Array.from(lum);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const nv = old < 0.5 + bias ? 0 : 1;
      out[i] = nv ? 0 : 1;            // 1 means ink
      const err = old - nv;
      for (const [dx, dy, wt] of weights) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        buf[ny * w + nx] += (err * wt) / divisor;
      }
    }
  }
  return out;
}

export function binarize(method, lum, w, h, mask, p) {
  const ink = new Uint8Array(w * h);
  const put = (i, on) => { ink[i] = on ? 1 : 0; };

  if (method === "otsu") {
    const t = otsuThreshold(lum, mask) + p.bias;
    for (let i = 0; i < w * h; i++) put(i, lum[i] < t);

  } else if (method === "sauvola") {
    // t = m * (1 + k * (s/R - 1)). On a light patch with little variation the
    // threshold drops towards the mean, which is what stops flat skin from
    // filling in solid.
    const { mean, std } = meanAndStd(lum, w, h, p.window);
    const R = 0.5;
    for (let i = 0; i < w * h; i++) {
      const t = mean[i] * (1 + p.k * (std[i] / R - 1)) + p.bias;
      put(i, lum[i] < t);
    }

  } else if (method === "bradley") {
    const { mean } = meanAndStd(lum, w, h, p.window);
    for (let i = 0; i < w * h; i++) put(i, lum[i] < mean[i] - p.c + p.bias);

  } else if (method === "atkinson") {
    // Atkinson passes on only six eighths of the error, which throws contrast
    // away and is exactly why the result looks crisp rather than muddy.
    const W = [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]];
    return despeckleAll(diffuse(lum, w, h, W, 8, p.bias), w, h, mask, p);

  } else if (method === "floyd") {
    const W = [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];
    return despeckleAll(diffuse(lum, w, h, W, 16, p.bias), w, h, mask, p);

  } else if (method === "bayer") {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = (BAYER8[y & 7][x & 7] + 0.5) / 64 + p.bias;
      put(y * w + x, lum[y * w + x] < t);
    }

  } else if (method === "xdog") {
    // D = G_s - tau * G_ks, then a soft step. Above the edge threshold the
    // pixel is paper; below it the tanh rolls it into ink over a width phi
    // controls, which is the knob that decides whether it looks like pencil or
    // like a woodcut.
    const a = boxBlur(lum, w, h, p.sigma, 2);
    const b = boxBlur(lum, w, h, Math.max(p.sigma + 1, Math.round(p.sigma * 1.6)), 2);
    for (let i = 0; i < w * h; i++) {
      const d = a[i] - p.tau * b[i];
      const v = d >= p.eps ? 1 : 1 + Math.tanh(p.phi * (d - p.eps));
      put(i, v < 0.5 + p.bias);
    }
  }
  return despeckleAll(ink, w, h, mask, p);
}

// ── Cleaning up ─────────────────────────────────────────────────────────────

function removeSmall(ink, w, h, target, minArea) {
  if (minArea < 1) return ink;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = Uint8Array.from(ink);
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || ink[s] !== target) continue;
    let top = 0; const px = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top];
      px.push(i);
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && ink[i - 1] === target && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && ink[i + 1] === target && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && ink[i - w] === target && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && ink[i + w] === target && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (px.length < minArea) for (const i of px) out[i] = target ? 0 : 1;
  }
  return out;
}

function despeckleAll(ink, w, h, mask, p) {
  let out = ink;
  if (mask) for (let i = 0; i < w * h; i++) if (!mask[i]) out[i] = 0;
  if (p.despeckle > 0) {
    out = removeSmall(out, w, h, 1, p.despeckle);
    out = removeSmall(out, w, h, 0, p.despeckle);
  }
  if (p.invert) for (let i = 0; i < w * h; i++) if (!mask || mask[i]) out[i] = out[i] ? 0 : 1;
  return out;
}

// ── Layers ──────────────────────────────────────────────────────────────────
//
// The segmenter already labelled every pixel, so there is no reason for one set
// of settings to cover the whole picture. Each component is binarised on its
// own terms and the results are composited. Because the class masks do not
// overlap, compositing is just a matter of asking which class a pixel is.

export const LAYERS = [
  ["faceSkin", 3, "face skin"],
  ["hair", 1, "hair"],
  ["bodySkin", 2, "body skin"],
  ["clothes", 4, "clothes"],
  ["other", 5, "accessories"],
  ["background", 0, "background"],
];

export function defaultLayer(key) {
  const base = {
    mode: "method", method: "otsu", flatten: 24, contrast: 1, gamma: 1, preblur: 0,
    bias: 0, despeckle: 10, window: 12, k: 0.18, c: 0.03,
    sigma: 1, tau: 0.985, eps: 0.014, phi: 60,
  };
  if (key === "clothes") return { ...base, mode: "solid" };
  if (key === "background") return { ...base, mode: "paper" };
  if (key === "other") return { ...base, mode: "solid" };
  return base;
}

// The luminance of the crop, and the class of every pixel in it, both at the
// working resolution. Read once; each layer then processes its own copy.
function source(state, size) {
  const cv = document.createElement("canvas");
  cv.width = size; cv.height = size;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage($("hidden"), state.box.x, state.box.y, state.box.side, state.box.side, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    lum[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  }
  const cls = new Uint8Array(size * size);
  const matte = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(state.ch - 1, ((y / size) * state.ch) | 0);
    for (let x = 0; x < size; x++) {
      const sx = Math.min(state.cw - 1, ((x / size) * state.cw) | 0);
      const j = sy * state.cw + sx;
      cls[y * size + x] = state.cat ? state.cat[j] : 0;
      matte[y * size + x] = state.matte && state.matte[j] > 127 ? 1 : 0;
    }
  }
  return { lum, cls, matte };
}

function prepped(lum, size, s) {
  let out = flattenLighting(lum, size, size, s.flatten);
  out = adjust(out, size, size, s.contrast, s.gamma);
  if (s.preblur > 0) out = boxBlur(out, size, size, s.preblur, 1);
  return out;
}

export function composite(state, size, settings, globals, stats) {
  const { lum, cls, matte } = source(state, size);
  const ink = new Uint8Array(size * size);

  for (const [key, id] of LAYERS) {
    const s = settings[key];
    if (!s || s.mode === "off" || s.mode === "paper") continue;

    const mask = new Uint8Array(size * size);
    let n = 0;
    const headClass = id === 1 || id === 2 || id === 3;
    for (let i = 0; i < size * size; i++) {
      if (cls[i] !== id) continue;
      if (globals.limitToMatte && headClass && !matte[i]) continue;
      mask[i] = 1; n++;
    }
    if (!n) continue;

    if (s.mode === "solid") {
      for (let i = 0; i < size * size; i++) if (mask[i]) ink[i] = 1;
      if (stats) stats[key] = { n, inked: n };
      continue;
    }

    // The threshold is computed from this component's pixels alone, which is
    // the point: a face's histogram and a jacket's have nothing to say to
    // each other, and one global cut has to compromise between them.
    const bits = binarize(s.method, prepped(lum, size, s), size, size, mask, {
      bias: s.bias, window: s.window, k: s.k, c: s.c,
      sigma: s.sigma, tau: s.tau, eps: s.eps, phi: s.phi,
      despeckle: s.despeckle, invert: false,
    });
    let inked = 0;
    for (let i = 0; i < size * size; i++) if (mask[i] && bits[i]) { ink[i] = 1; inked++; }
    if (stats) stats[key] = { n, inked };
  }

  if (globals.invert) for (let i = 0; i < size * size; i++) ink[i] = ink[i] ? 0 : 1;
  return ink;
}

export function paint(ctx, ink, size, dx, dy, dw) {
  const off = document.createElement("canvas");
  off.width = size; off.height = size;
  const id = off.getContext("2d").createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = ink[i] ? 0 : 255;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  off.getContext("2d").putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, dx, dy, dw, dw);
}

export function renderMain(state, settings, globals) {
  if (!state.box) return null;
  const size = globals.size;
  const stats = {};
  const ink = composite(state, size, settings, globals, stats);
  const cv = $("bw");
  const shown = 720;
  cv.width = shown; cv.height = shown;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, shown, shown);
  paint(ctx, ink, size, 0, 0, shown);
  let on = 0;
  for (let i = 0; i < ink.length; i++) on += ink[i];
  const per = LAYERS.filter(([k]) => stats[k]).map(([k, , label]) =>
    label + " " + ((stats[k].inked / stats[k].n) * 100).toFixed(0) + "%");
  $("bwStats").textContent = size + " x " + size + " pixels, " +
    ((on / ink.length) * 100).toFixed(1) + "% ink — inked per component: " +
    (per.join(", ") || "nothing");
  return { ink, size };
}

// The thumbnails preview what the ACTIVE component would look like under each
// method, with every other component left as it is set. Otherwise they would be
// previewing a picture the tool can no longer make.
export function renderThumbs(state, settings, globals, activeLayer) {
  if (!state.box) return;
  const size = 150;
  for (const [key] of METHODS) {
    const cv = $("th_" + key);
    if (!cv) continue;
    const trial = { ...settings };
    trial[activeLayer] = { ...settings[activeLayer], mode: "method", method: key };
    cv.width = size; cv.height = size;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    paint(ctx, composite(state, size, trial, { ...globals, size }), size, 0, 0, size);
    cv.parentElement.classList.toggle("on",
      settings[activeLayer].mode === "method" && settings[activeLayer].method === key);
  }
}
