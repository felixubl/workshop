const distSelect = document.getElementById("dist");
const paramsGroup = document.getElementById("params");
const countInput = document.getElementById("count");
const dimsInput = document.getElementById("dims");
const seedInput = document.getElementById("seed");
const newSeedBtn = document.getElementById("newSeed");
const decimalsInput = document.getElementById("decimals");
const drawBtn = document.getElementById("draw");
const clearBtn = document.getElementById("clear");
const hint = document.getElementById("hint");
const emptyState = document.getElementById("empty");
const results = document.getElementById("results");
const capLabel = document.getElementById("capLabel");
const capMeta = document.getElementById("capMeta");
const drawTable = document.getElementById("drawTable");
const drawNote = document.getElementById("drawNote");
const statsTable = document.getElementById("statsTable");
const shapeMeta = document.getElementById("shapeMeta");
const plots = document.getElementById("plots");
const copyBtn = document.getElementById("copy");
const csvBtn = document.getElementById("csv");
const jsonBtn = document.getElementById("json");

// A browser tab has to stay responsive, and the whole sample is held in memory
// twice over (once raw, once formatted for export), so the cap is on values
// rather than on rows: ten dimensions of ten thousand draws is the same work as
// one dimension of a hundred thousand.
const MAX_VALUES = 100000;
// The table is a look at the sample, not the sample itself. Past a couple of
// hundred rows the DOM is the slow part and nobody is reading them anyway — the
// export is how you get the rest.
const MAX_ROWS_SHOWN = 200;

let lastRun = null;

/* ── The generator ─────────────────────────────────────────────────────────
   Math.random() cannot be seeded, so a reproducible run needs its own PRNG.
   mulberry32 is a 32-bit state generator with a full 2^32 period and good
   enough statistics for sampling work; xmur3 turns the seed *string* into the
   32-bit state, so "banana" and "banana " start in genuinely different places
   rather than in adjacent ones. */

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeed() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ── Samplers ──────────────────────────────────────────────────────────────
   Every sampler takes the uniform `rng` as its first argument and returns one
   draw. Nothing here caches state between calls: the gamma sampler draws
   normals of its own, and a shared spare would interleave the two streams and
   make a seed mean different things depending on which distribution asked
   first. */

// Box-Muller. The rejection of exactly 0 matters: log(0) is -Infinity.
function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// Lanczos approximation, g = 7. Only the Poisson sampler needs it, for the
// log-factorial in its rejection test.
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Marsaglia-Tsang. Shapes below 1 are handled by the standard boost: draw at
// shape+1 and scale down by U^(1/shape).
function gammaSample(rng, shape, scale) {
  if (shape < 1) return gammaSample(rng, shape + 1, scale) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

// Knuth's product method is O(mean), so it only holds up while the mean is
// small. Past 30 this switches to Hörmann's transformed rejection (PTRS),
// which is constant time whatever the mean.
function poisson(rng, mean) {
  if (mean < 30) {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng();
    } while (p > limit);
    return k - 1;
  }
  const b = 0.931 + 2.53 * Math.sqrt(mean);
  const a = -0.059 + 0.02483 * b;
  const invAlpha = 1.1239 + 1.1328 / (b - 3.4);
  const vr = 0.9277 - 3.6224 / (b - 2);
  for (;;) {
    const u = rng() - 0.5;
    const v = rng();
    const us = 0.5 - Math.abs(u);
    const k = Math.floor((((2 * a) / us + b) * u + mean + 0.43));
    if (us >= 0.07 && v <= vr) return k;
    // us of exactly 0 sends k to infinity; that falls through to here and is
    // rejected rather than escaping as a draw.
    if (k < 0 || (us < 0.013 && v > us)) continue;
    if (Math.log((v * invAlpha) / (a / (us * us) + b)) <= k * Math.log(mean) - mean - logGamma(k + 1)) {
      return k;
    }
  }
}

// Inversion, walking the CDF from the tail that converges fastest — expected
// steps are trials × min(p, 1-p) rather than trials. The starting term
// (1-p)^trials is what bounds trials at 1000 in the UI: much past that it
// underflows to zero and the walk has nothing to add to.
function binomial(rng, trials, prob) {
  const mirror = prob > 0.5;
  const p = mirror ? 1 - prob : prob;
  if (p <= 0) return mirror ? trials : 0;
  const q = 1 - p;
  let k = 0;
  let term = Math.pow(q, trials);
  let cdf = term;
  const u = rng();
  while (u > cdf && k < trials) {
    k++;
    term *= ((trials - k + 1) / k) * (p / q);
    cdf += term;
  }
  return mirror ? trials - k : k;
}

/* ── Distributions ─────────────────────────────────────────────────────────
   Each entry owns its own parameter fields, its own validation message, and a
   `make` that binds those parameters into a sampler. `integer: true` means the
   draws are counts, so the decimals control does not apply to them. */

const DISTRIBUTIONS = [
  {
    id: "uniform",
    label: "Uniform (continuous)",
    params: [
      { key: "min", label: "min", value: 0 },
      { key: "max", label: "max", value: 1 },
    ],
    validate: (p) => (p.max > p.min ? null : "Max has to be greater than min."),
    make: (p) => (rng) => p.min + rng() * (p.max - p.min),
  },
  {
    id: "integer",
    label: "Uniform (integer)",
    integer: true,
    params: [
      { key: "min", label: "min", value: 1, step: 1 },
      { key: "max", label: "max", value: 6, step: 1 },
    ],
    validate: (p) =>
      !Number.isInteger(p.min) || !Number.isInteger(p.max)
        ? "Min and max have to be whole numbers."
        : p.max >= p.min
          ? null
          : "Max has to be at least min.",
    // Both ends are inclusive, so a 1-6 range rolls a die rather than
    // quietly never landing on 6.
    make: (p) => (rng) => p.min + Math.floor(rng() * (p.max - p.min + 1)),
  },
  {
    id: "normal",
    label: "Normal",
    params: [
      { key: "mean", label: "mean", value: 0 },
      { key: "sd", label: "sd", value: 1 },
    ],
    validate: (p) => (p.sd > 0 ? null : "Standard deviation has to be greater than 0."),
    make: (p) => (rng) => p.mean + p.sd * gaussian(rng),
  },
  {
    id: "lognormal",
    label: "Log-normal",
    params: [
      { key: "mu", label: "log mean", value: 0 },
      { key: "sigma", label: "log sd", value: 1 },
    ],
    validate: (p) => (p.sigma > 0 ? null : "Log standard deviation has to be greater than 0."),
    make: (p) => (rng) => Math.exp(p.mu + p.sigma * gaussian(rng)),
  },
  {
    id: "exponential",
    label: "Exponential",
    params: [{ key: "rate", label: "rate", value: 1 }],
    validate: (p) => (p.rate > 0 ? null : "Rate has to be greater than 0."),
    make: (p) => (rng) => -Math.log(1 - rng()) / p.rate,
  },
  {
    id: "gamma",
    label: "Gamma",
    params: [
      { key: "shape", label: "shape", value: 2 },
      { key: "scale", label: "scale", value: 1 },
    ],
    validate: (p) =>
      p.shape > 0 && p.scale > 0 ? null : "Shape and scale both have to be greater than 0.",
    make: (p) => (rng) => gammaSample(rng, p.shape, p.scale),
  },
  {
    id: "beta",
    label: "Beta",
    params: [
      { key: "alpha", label: "alpha", value: 2 },
      { key: "beta", label: "beta", value: 2 },
    ],
    validate: (p) =>
      p.alpha > 0 && p.beta > 0 ? null : "Alpha and beta both have to be greater than 0.",
    // Two gammas share a stream here, which is the standard construction:
    // X/(X+Y) with X ~ Gamma(alpha), Y ~ Gamma(beta).
    make: (p) => (rng) => {
      const x = gammaSample(rng, p.alpha, 1);
      const y = gammaSample(rng, p.beta, 1);
      return x / (x + y);
    },
  },
  {
    id: "binomial",
    label: "Binomial",
    integer: true,
    params: [
      { key: "trials", label: "trials", value: 10, step: 1, min: 1, max: 1000 },
      { key: "p", label: "p", value: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    validate: (p) =>
      !Number.isInteger(p.trials) || p.trials < 1 || p.trials > 1000
        ? "Trials has to be a whole number between 1 and 1000."
        : p.p >= 0 && p.p <= 1
          ? null
          : "p has to be between 0 and 1.",
    make: (p) => (rng) => binomial(rng, p.trials, p.p),
  },
  {
    id: "poisson",
    label: "Poisson",
    integer: true,
    params: [{ key: "mean", label: "mean", value: 4, min: 0 }],
    validate: (p) => (p.mean > 0 ? null : "Mean has to be greater than 0."),
    make: (p) => (rng) => poisson(rng, p.mean),
  },
  {
    id: "geometric",
    label: "Geometric",
    integer: true,
    params: [{ key: "p", label: "p", value: 0.3, min: 0, max: 1, step: 0.01 }],
    validate: (p) => (p.p > 0 && p.p <= 1 ? null : "p has to be greater than 0 and at most 1."),
    // Counts the failures before the first success, so p = 1 is a run of zeros
    // rather than a division by log(0).
    make: (p) => (rng) => (p.p >= 1 ? 0 : Math.floor(Math.log(1 - rng()) / Math.log(1 - p.p))),
  },
  {
    id: "triangular",
    label: "Triangular",
    params: [
      { key: "min", label: "min", value: 0 },
      { key: "mode", label: "mode", value: 0.5 },
      { key: "max", label: "max", value: 1 },
    ],
    validate: (p) =>
      p.max <= p.min
        ? "Max has to be greater than min."
        : p.mode >= p.min && p.mode <= p.max
          ? null
          : "Mode has to sit between min and max.",
    make: (p) => (rng) => {
      const split = (p.mode - p.min) / (p.max - p.min);
      const u = rng();
      return u < split
        ? p.min + Math.sqrt(u * (p.max - p.min) * (p.mode - p.min))
        : p.max - Math.sqrt((1 - u) * (p.max - p.min) * (p.max - p.mode));
    },
  },
];

/* ── Controls ──────────────────────────────────────────────────────────── */

function currentDist() {
  return DISTRIBUTIONS.find((d) => d.id === distSelect.value) || DISTRIBUTIONS[0];
}

function renderDistOptions() {
  distSelect.innerHTML = DISTRIBUTIONS.map(
    (d) => `<option value="${d.id}">${d.label}</option>`
  ).join("");
}

// Parameters belong to the distribution, so the fields are rebuilt on every
// change rather than hidden — a stale "trials" left sitting beside a Poisson
// mean is a control that lies about what it does.
function renderParams() {
  const dist = currentDist();
  paramsGroup.innerHTML =
    `<label for="p-${dist.params[0].key}">Parameters</label>` +
    dist.params
      .map((p) => {
        const attrs = [
          `id="p-${p.key}"`,
          `class="field num"`,
          `type="number"`,
          `value="${p.value}"`,
          `step="${p.step ?? "any"}"`,
          p.min !== undefined ? `min="${p.min}"` : "",
          p.max !== undefined ? `max="${p.max}"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<label class="param" for="p-${p.key}">${p.label}</label><input ${attrs}>`;
      })
      .join("");
}

function readParams() {
  const values = {};
  for (const p of currentDist().params) {
    values[p.key] = Number(document.getElementById(`p-${p.key}`).value);
  }
  return values;
}

function showHint(message) {
  hint.textContent = message;
  hint.hidden = !message;
}

/* ── Drawing ───────────────────────────────────────────────────────────── */

function draw() {
  const dist = currentDist();
  const params = readParams();
  const count = Math.floor(Number(countInput.value));
  const dims = Math.floor(Number(dimsInput.value));
  const decimals = Math.floor(Number(decimalsInput.value));

  if (Object.values(params).some((v) => !Number.isFinite(v))) {
    return showHint("Every parameter needs a number.");
  }
  const problem = dist.validate(params);
  if (problem) return showHint(problem);
  if (!Number.isFinite(count) || count < 1) return showHint("Draws has to be at least 1.");
  if (!Number.isFinite(dims) || dims < 1 || dims > 10) {
    return showHint("Dimensions has to be between 1 and 10.");
  }
  if (count * dims > MAX_VALUES) {
    return showHint(
      `That is ${(count * dims).toLocaleString()} numbers. Draws × dimensions has to stay at or under ${MAX_VALUES.toLocaleString()}.`
    );
  }
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 15) {
    return showHint("Decimals has to be between 0 and 15.");
  }
  showHint("");

  // An empty field means an unseeded run, but the seed is still shown, so any
  // run can be reproduced after the fact by pasting it back in.
  const seed = seedInput.value.trim() || randomSeed();
  const rng = mulberry32(xmur3(seed));
  const sample = dist.make(params);

  const rows = new Array(count);
  for (let i = 0; i < count; i++) {
    const row = new Array(dims);
    for (let d = 0; d < dims; d++) row[d] = sample(rng);
    rows[i] = row;
  }

  lastRun = { dist, params, rows, count, dims, decimals, seed };
  render(lastRun);
}

function format(value, run) {
  return run.dist.integer ? String(value) : value.toFixed(run.decimals);
}

function columnLabels(run) {
  return run.dims === 1 ? ["value"] : Array.from({ length: run.dims }, (_, i) => `d${i + 1}`);
}

function notation(run) {
  const parts = run.dist.params.map((p) => `${p.label} ${run.params[p.key]}`);
  return `${run.dist.label} · ${parts.join(" · ")}`;
}

function render(run) {
  const labels = columnLabels(run);

  capLabel.textContent = notation(run);
  // The seed is whatever was typed into the field, so it is set as text on a
  // built node rather than interpolated into markup.
  const reuse = document.createElement("button");
  reuse.className = "seed-tag";
  reuse.type = "button";
  reuse.dataset.tip = "Put this seed in the seed field";
  reuse.textContent = run.seed;
  reuse.addEventListener("click", () => {
    seedInput.value = run.seed;
    seedInput.focus();
  });
  capMeta.textContent = `n = ${run.count.toLocaleString()} · seed `;
  capMeta.appendChild(reuse);

  const shown = Math.min(run.count, MAX_ROWS_SHOWN);
  const head = `<thead><tr><th scope="col">n</th>${labels
    .map((l) => `<th scope="col">${l}</th>`)
    .join("")}</tr></thead>`;
  const body = [];
  for (let i = 0; i < shown; i++) {
    body.push(
      `<tr><td>${i + 1}</td>${run.rows[i].map((v) => `<td>${format(v, run)}</td>`).join("")}</tr>`
    );
  }
  drawTable.innerHTML = `${head}<tbody>${body.join("")}</tbody>`;

  drawNote.textContent =
    run.count > shown
      ? `Showing the first ${shown} of ${run.count.toLocaleString()} draws. The exports carry the whole set.`
      : "";
  drawNote.hidden = run.count <= shown;

  renderStats(run, labels);
  renderPlots(run, labels);

  emptyState.hidden = true;
  results.hidden = false;
}

// Summary runs on the raw doubles, not on the rounded strings in the table, so
// the decimals control changes what you read and never what was measured.
function renderStats(run, labels) {
  const head = `<thead><tr><th scope="col">dim</th><th scope="col">mean</th><th scope="col">sd</th><th scope="col">min</th><th scope="col">median</th><th scope="col">max</th></tr></thead>`;
  const body = labels.map((label, d) => {
    const column = new Float64Array(run.count);
    for (let i = 0; i < run.count; i++) column[i] = run.rows[i][d];

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < run.count; i++) {
      sum += column[i];
      if (column[i] < min) min = column[i];
      if (column[i] > max) max = column[i];
    }
    const mean = sum / run.count;

    let squares = 0;
    for (let i = 0; i < run.count; i++) squares += (column[i] - mean) ** 2;
    // Sample standard deviation: n-1. A single draw has no spread to report.
    const sd = run.count > 1 ? Math.sqrt(squares / (run.count - 1)) : 0;

    const sorted = column.slice().sort();
    const mid = run.count >> 1;
    const median = run.count % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    // Statistics of counts are not counts, so these keep their decimals even
    // where the draws themselves are whole numbers.
    const places = Math.max(run.decimals, run.dist.integer ? 2 : 0);
    const stat = (v) => v.toFixed(places);
    return `<tr><td>${label}</td><td>${stat(mean)}</td><td>${stat(sd)}</td><td>${format(min, run)}</td><td>${stat(median)}</td><td>${format(max, run)}</td></tr>`;
  });
  statsTable.innerHTML = `${head}<tbody>${body.join("")}</tbody>`;
}

/* ── The plots ─────────────────────────────────────────────────────────────
   The tables say what was drawn, one number at a time. The histogram says what
   the sample looks like, which is the thing a distribution is actually chosen
   for, so it reads the whole sample rather than the first two hundred rows.

   Drawn in SVG, in user units 600 wide, and stretched to whatever width the
   sheet has. Only the horizontal axis stretches: the height attribute matches
   the viewBox height, so the baseline stays a single crisp pixel however wide
   the page is. */

const PLOT_W = 600;
const PLOT_H = 72;
const RUG_TOP = PLOT_H + 2;
const RUG_H = 7;
const PLOT_TOTAL = RUG_TOP + RUG_H;
// Bin counts either side of the integer case: too few and a normal looks like a
// block, too many and every bin holds one draw and the shape is noise.
const MIN_BINS = 8;
const MAX_BINS = 48;
// One bin per value while the counts are few enough for that to be readable.
const MAX_INTEGER_BINS = 60;

function histogram(values, integer) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // Every draw identical — a p = 1 geometric, or a one-draw run. There is no
  // range to divide, so it is one bin holding everything.
  if (min === max) return { min, max, lo: min - 0.5, hi: max + 0.5, counts: [values.length] };

  const bins =
    integer && max - min + 1 <= MAX_INTEGER_BINS
      ? max - min + 1
      : Math.max(MIN_BINS, Math.min(MAX_BINS, Math.ceil(Math.sqrt(values.length))));
  // Counts sit on the integers, not between them, so the edges go half a step
  // out and each bar is centred on the value it counts.
  const lo = integer ? min - 0.5 : min;
  const hi = integer ? max + 0.5 : max;
  const width = (hi - lo) / bins;

  const counts = new Array(bins).fill(0);
  for (const v of values) {
    // The maximum sits exactly on the last edge and would index one past the
    // end, so it is folded back into the last bin rather than dropped.
    const k = Math.min(bins - 1, Math.floor((v - lo) / width));
    counts[k]++;
  }
  return { min, max, lo, hi, counts };
}

function plotMarkup(hist, values) {
  const bins = hist.counts.length;
  const step = PLOT_W / bins;
  // Two neighbouring bars of the same height read as one wide bar unless the
  // gap is wide enough to be a gap. It grows as the bins get fewer, and is
  // capped so a fifty-bin plot stays mostly bar.
  const gap = Math.min(6, step / 5);
  let peak = 0;
  for (const c of hist.counts) if (c > peak) peak = c;

  const bars = hist.counts
    .map((c, i) => {
      if (!c) return "";
      // A bin with one draw in it still gets a mark: a bar rounded away to
      // nothing reads as an empty bin, which is a different claim.
      const h = Math.max(1, (c / peak) * PLOT_H);
      const x = i * step + gap / 2;
      const w = Math.max(0.5, step - gap);
      return `<rect class="hist-bar" x="${x.toFixed(2)}" y="${(PLOT_H - h).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"></rect>`;
    })
    .join("");

  // The rug is where a twenty-draw run is legible at all: the bars are too few
  // to have a shape, but the ticks are the sample itself. A hundred thousand
  // of them is a hundred thousand nodes, so positions round to half a unit and
  // the duplicates collapse — past a couple of thousand draws the rug is a
  // solid band either way, and that saturation is honest.
  const span = hist.hi - hist.lo;
  const ticks = new Set();
  for (const v of values) {
    ticks.add(Math.round((((v - hist.lo) / span) * PLOT_W) * 2) / 2);
  }
  const rug = Array.from(
    ticks,
    (x) =>
      `<rect class="hist-rug" x="${Math.min(x, PLOT_W - 1).toFixed(2)}" y="${RUG_TOP}" width="1" height="${RUG_H}"></rect>`
  ).join("");

  return `${bars}<rect class="hist-base" x="0" y="${PLOT_H}" width="${PLOT_W}" height="1"></rect>${rug}`;
}

function renderPlots(run, labels) {
  shapeMeta.textContent = `n = ${run.count.toLocaleString()}${run.dims > 1 ? " per dimension" : ""}`;

  plots.innerHTML = labels
    .map((label, d) => {
      const values = [];
      for (let i = 0; i < run.count; i++) {
        const v = run.rows[i][d];
        // A log-normal with a large sigma can overflow to Infinity. One such
        // draw would collapse every bin into the first, so the plot leaves
        // them out and says how many it left.
        if (Number.isFinite(v)) values.push(v);
      }

      if (!values.length) {
        return `<figure class="hist"><figcaption class="hist-name">${label}</figcaption><p class="hist-empty">Nothing finite to plot.</p></figure>`;
      }

      const hist = histogram(values, run.dist.integer);
      const dropped = run.count - values.length;
      const bins = hist.counts.length;
      return `<figure class="hist">
        <figcaption class="hist-name">${label}</figcaption>
        <svg class="hist-plot" width="100%" height="${PLOT_TOTAL}" viewBox="0 0 ${PLOT_W} ${PLOT_TOTAL}" preserveAspectRatio="none" role="img" aria-label="Histogram of ${values.length} draws for ${label}, from ${format(hist.min, run)} to ${format(hist.max, run)}, in ${bins} bins.">${plotMarkup(hist, values)}</svg>
        <div class="hist-axis"><span>${format(hist.min, run)}</span><span class="hist-bins">${bins} ${bins === 1 ? "bin" : "bins"}${dropped ? ` · ${dropped} not finite` : ""}</span><span>${format(hist.max, run)}</span></div>
      </figure>`;
    })
    .join("");
}

/* ── Export ────────────────────────────────────────────────────────────── */

function delimited(run, separator) {
  const labels = columnLabels(run);
  const lines = [["n", ...labels].join(separator)];
  for (let i = 0; i < run.count; i++) {
    lines.push([i + 1, ...run.rows[i].map((v) => format(v, run))].join(separator));
  }
  return lines.join("\n");
}

function download(text, extension, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  // A seed is free text, and a filename is not — anything that is not a plain
  // word gets folded to a hyphen so the download lands with a usable name.
  const stem = lastRun.seed.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40);
  link.download = `random-${lastRun.dist.id}-${stem || "run"}.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
}

// A pressed button that says nothing looks broken, and a clipboard write is the
// one action here with no visible result of its own.
function flash(button, message) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = message;
  setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1400);
}

/* ── Wiring ────────────────────────────────────────────────────────────── */

renderDistOptions();
renderParams();

distSelect.addEventListener("change", () => {
  renderParams();
  showHint("");
});

drawBtn.addEventListener("click", draw);

newSeedBtn.addEventListener("click", () => {
  seedInput.value = randomSeed();
});

clearBtn.addEventListener("click", () => {
  lastRun = null;
  results.hidden = true;
  emptyState.hidden = false;
  showHint("");
});

copyBtn.addEventListener("click", async () => {
  if (!lastRun) return;
  // Tabs rather than commas: this one goes to a spreadsheet, where a pasted
  // comma is a column boundary nobody asked for.
  try {
    await navigator.clipboard.writeText(delimited(lastRun, "\t"));
    flash(copyBtn, "Copied");
  } catch {
    flash(copyBtn, "Blocked");
  }
});

csvBtn.addEventListener("click", () => {
  if (!lastRun) return;
  download(delimited(lastRun, ","), "csv", "text/csv");
});

jsonBtn.addEventListener("click", () => {
  if (!lastRun) return;
  const values = lastRun.rows.map((row) => row.map((v) => Number(format(v, lastRun))));
  const payload = {
    distribution: lastRun.dist.id,
    parameters: lastRun.params,
    draws: lastRun.count,
    dimensions: lastRun.dims,
    seed: lastRun.seed,
    decimals: lastRun.dist.integer ? 0 : lastRun.decimals,
    generated: new Date().toISOString(),
    // One dimension gives a flat list. Wrapping every number in its own
    // single-element array is a shape that only exists to be unwrapped again.
    values: lastRun.dims === 1 ? values.map((row) => row[0]) : values,
  };
  download(JSON.stringify(payload, null, 2), "json", "application/json");
});

// Enter anywhere in the controls draws, the way it would in a form.
document.querySelector(".toolbar").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    draw();
  }
});
