import { coefficients, rebuild, chain } from "./fft.js";
import { readSVG, stitch, resample } from "./paths.js";

const $ = (id) => document.getElementById(id);
const say = (m) => { $("status").textContent = m; };

const BOX = 1000;

const state = {
  loops: null,
  single: null,
  samples: null,
  terms: null,
  built: null,
  t: 0,
  raf: null,
  traced: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
};

function inputOpts() {
  return {
    step: +$("step").value,
    tolerance: +$("tolerance").value,
    minLength: +$("minloop").value,
    maxLoops: +$("maxloops").value,
    dropBackground: $("dropBg").checked,
  };
}

// Everything is fitted into one fixed square before the transform runs, so the
// drawing does not jump around the canvas as circles are added or taken away.
function normalise(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const s = BOX / Math.max(x1 - x0, y1 - y0, 1e-9);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return pts.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s }));
}

function transform() {
  const n = +$("samples").value;
  const pts = resample(state.single, n);
  if (!pts) { say("that path has no length"); return false; }
  state.samples = normalise(pts);
  state.terms = coefficients(state.samples);
  const circles = $("circles");
  circles.max = String(n / 2);
  if (+circles.value > n / 2) circles.value = String(n / 2);
  return true;
}

function rebuildNow() {
  if (!state.terms) return;
  state.built = rebuild(state.terms, +$("circles").value);
  let err = 0;
  for (let i = 0; i < state.samples.length; i++) {
    err += (state.built.points[i].x - state.samples[i].x) ** 2 +
           (state.built.points[i].y - state.samples[i].y) ** 2;
  }
  err = Math.sqrt(err / state.samples.length);
  const bg = state.loops.dropped ? ", " + state.loops.dropped + " background shape" +
    (state.loops.dropped > 1 ? "s" : "") + " dropped" : "";
  const s1 = state.single;
  const joins = s1 && s1.total > 0
    ? " · joins are " + ((2 * s1.bridge / s1.total) * 100).toFixed(1) + "% of the line" : "";
  $("stats").textContent =
    state.loops.length + " loops joined into one line" + bg + " · " +
    state.samples.length + " samples · " + state.built.kept.length +
    " circles · mean error " + (err / BOX * 100).toFixed(2) + "% of the frame" + joins;
  paintCurve();
  resetTrace();
}

// ── Drawing ─────────────────────────────────────────────────────────────────

let curveCanvas = null;
let traceCanvas = null;

function view() {
  const cv = $("stage");
  const size = cv.width;
  const pad = size * 0.06;
  const s = ((size - pad * 2) / BOX) * state.zoom;
  return { size, s, ox: size / 2 + state.panX, oy: size / 2 + state.panY };
}

function ensureLayers(size) {
  if (!curveCanvas || curveCanvas.width !== size) {
    curveCanvas = document.createElement("canvas");
    traceCanvas = document.createElement("canvas");
    curveCanvas.width = curveCanvas.height = size;
    traceCanvas.width = traceCanvas.height = size;
  }
}

function paintCurve() {
  const cv = $("stage");
  const size = +$("res").value;
  cv.width = cv.height = size;
  ensureLayers(size);
  const v = view();
  const ctx = curveCanvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.lineWidth = +$("weight").value;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = getComputedStyle(cv).getPropertyValue("--pp-ink").trim() || "#141414";
  ctx.beginPath();
  const p = state.built.points;
  for (let i = 0; i < p.length; i++) {
    const x = v.ox + p[i].x * v.s, y = v.oy + p[i].y * v.s;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  compose();
}

function resetTrace() {
  if (!traceCanvas) return;
  traceCanvas.getContext("2d").clearRect(0, 0, traceCanvas.width, traceCanvas.height);
  state.traced = 0;
  compose();
}

// The traced portion is accumulated on its own layer rather than redrawn from
// zero every frame: at thirty thousand samples, restroking the whole curve each
// tick is what makes an animation stutter.
function extendTrace(upto) {
  const p = state.built.points;
  const v = view();
  const ctx = traceCanvas.getContext("2d");
  ctx.lineWidth = +$("weight").value + 0.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#c2452f";
  ctx.beginPath();
  for (let i = state.traced; i <= upto && i < p.length; i++) {
    const x = v.ox + p[i].x * v.s, y = v.oy + p[i].y * v.s;
    i === state.traced ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  state.traced = Math.max(state.traced, Math.min(upto, p.length - 1));
}

function compose() {
  const cv = $("stage");
  const ctx = cv.getContext("2d");
  const size = cv.width;
  ctx.clearRect(0, 0, size, size);
  const showAll = $("showCurve").checked;
  if (showAll) {
    ctx.globalAlpha = $("trace").checked ? 0.22 : 1;
    ctx.drawImage(curveCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }
  if ($("trace").checked) ctx.drawImage(traceCanvas, 0, 0);
  if ($("showCircles").checked && state.built) drawCircles(ctx);
}

function drawCircles(ctx) {
  const v = view();
  const pts = chain(state.built.kept, state.t);
  ctx.save();
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = "rgba(120,120,120,0.45)";
  for (let i = 1; i < pts.length; i++) {
    const r = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * v.s;
    if (r < 0.7) break;
    ctx.beginPath();
    ctx.arc(v.ox + pts[i - 1].x * v.s, v.oy + pts[i - 1].y * v.s, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(60,60,60,0.75)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = v.ox + pts[i].x * v.s, y = v.oy + pts[i].y * v.s;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  const tip = pts[pts.length - 1];
  ctx.fillStyle = "#c2452f";
  ctx.beginPath();
  ctx.arc(v.ox + tip.x * v.s, v.oy + tip.y * v.s, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function tick() {
  const speed = +$("speed").value / 6000;
  const prev = state.t;
  state.t = (state.t + speed) % 1;
  if (state.t < prev) resetTrace();
  if ($("trace").checked) extendTrace(Math.floor(state.t * state.built.points.length));
  compose();
  state.raf = requestAnimationFrame(tick);
}

function setAnimation() {
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = null;
  if (!state.built) return;
  if ($("animate").checked) state.raf = requestAnimationFrame(tick);
  else compose();
}


// The drawing has to be wholly visible without scrolling, and how much room is
// left depends on how tall the controls above it happen to be — which changes
// with the width of the window and with whether the drop target has collapsed.
// So the space is measured rather than guessed at in the stylesheet.
function fitStage() {
  const sheet = document.querySelector(".sheet");
  if (!sheet || $("work").hidden) return;
  sheet.style.maxWidth = "";
  const top = sheet.getBoundingClientRect().top;
  const room = window.innerHeight - top - 84;
  const wide = sheet.parentElement ? sheet.parentElement.clientWidth : room;
  sheet.style.maxWidth = Math.max(260, Math.min(wide, room)) + "px";
}

// ── Zoom and pan ────────────────────────────────────────────────────────────
//
// The curve is rasterised onto its own layer, so moving the view means drawing
// it again rather than transforming a bitmap. Repainting is deferred to the
// next frame so a wheel or a drag cannot queue up more repaints than the screen
// can show.

let viewQueued = false;
function viewChanged() {
  if (viewQueued) return;
  viewQueued = true;
  requestAnimationFrame(() => {
    viewQueued = false;
    if (!state.built) return;
    paintCurve();
    resetTrace();
  });
  showZoom();
}

function showZoom() {
  $("zoomOut").textContent = Math.round(state.zoom * 100) + "%";
}

function fitView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  viewChanged();
}

function setupNavigation() {
  const cv = $("stage");

  cv.addEventListener("wheel", (e) => {
    if (!state.built) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    // Keep whatever is under the pointer under the pointer.
    const px = ((e.clientX - r.left) / r.width) * cv.width;
    const py = ((e.clientY - r.top) / r.height) * cv.height;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(40, Math.max(0.4, state.zoom * factor));
    const k = next / state.zoom;
    state.panX = px - k * (px - state.panX);
    state.panY = py - k * (py - state.panY);
    state.zoom = next;
    viewChanged();
  }, { passive: false });

  let dragging = false, lx = 0, ly = 0;
  cv.addEventListener("pointerdown", (e) => {
    if (!state.built) return;
    dragging = true;
    lx = e.clientX; ly = e.clientY;
    cv.setPointerCapture(e.pointerId);
    cv.classList.add("dragging");
  });
  cv.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    state.panX += (e.clientX - lx) * k;
    state.panY += (e.clientY - ly) * k;
    lx = e.clientX; ly = e.clientY;
    viewChanged();
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    cv.classList.remove("dragging");
    try { cv.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  cv.addEventListener("pointerup", stop);
  cv.addEventListener("pointercancel", stop);

  $("zoomIn").addEventListener("click", () => {
    state.zoom = Math.min(40, state.zoom * 1.4); viewChanged();
  });
  $("zoomBack").addEventListener("click", () => {
    state.zoom = Math.max(0.4, state.zoom / 1.4); viewChanged();
  });
  $("fit").addEventListener("click", fitView);
}

// ── Pipeline ────────────────────────────────────────────────────────────────

function recompute(fromInput) {
  if (!state.loops) return;
  const t0 = performance.now();
  if (fromInput) state.single = stitch(state.loops);
  if (!transform()) return;
  rebuildNow();
  setAnimation();
  say("redrawn in " + Math.round(performance.now() - t0) + " ms");
}

async function loadFile(file) {
  if (!file) return;
  say("reading the file");
  const text = await file.text();
  try {
    state.loops = readSVG(text, inputOpts());
  } catch (e) {
    say(e.message);
    return;
  }
  if (!state.loops.length) {
    say("nothing drawable in that file — every shape was shorter than the smallest loop allowed");
    return;
  }
  $("work").hidden = false;
  $("drop").classList.remove("dz-open");
  $("saveSvg").disabled = false;
  $("savePng").disabled = false;
  fitStage();
  fitView();
  recompute(true);
}

$("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

for (const id of ["step", "tolerance", "minloop", "maxloops", "dropBg"]) {
  $(id).addEventListener("change", () => {
    if (!state.loops) return;
    say("re-reading the file");
    recompute(true);
  });
}
for (const id of ["samples"]) $(id).addEventListener("change", () => recompute(false));
for (const ev of ["input", "change"]) {
  $("circles").addEventListener(ev, () => { rebuildNow(); setAnimation(); });
}
for (const id of ["res", "weight"]) $(id).addEventListener("change", () => { paintCurve(); resetTrace(); });
for (const id of ["showCurve", "showCircles", "trace"]) {
  $(id).addEventListener("change", () => { resetTrace(); setAnimation(); });
}
$("animate").addEventListener("change", setAnimation);
$("speed").addEventListener("input", () => {});

// Both exports show the whole drawing, fitted, whatever the screen happens to
// be zoomed to. The zoom is for looking; a saved file that quietly cropped
// itself to the last thing you inspected would be a trap.
function exportView(size) {
  const pad = size * 0.06;
  return { s: (size - pad * 2) / BOX, ox: size / 2, oy: size / 2 };
}

function renderExport(size) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  const v = exportView(size);
  // The stroke is scaled with the frame, so a big export is not a hairline.
  ctx.lineWidth = +$("weight").value * (size / +$("res").value);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#141414";
  ctx.beginPath();
  const p = state.built.points;
  for (let i = 0; i < p.length; i++) {
    const x = v.ox + p[i].x * v.s, y = v.oy + p[i].y * v.s;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  return cv;
}

$("savePng").addEventListener("click", () => {
  if (!state.built) return;
  const size = +$("exportSize").value;
  const a = document.createElement("a");
  a.download = "one-line.png";
  a.href = renderExport(size).toDataURL("image/png");
  a.click();
  say("saved a " + size + " x " + size + " PNG");
});

$("saveSvg").addEventListener("click", () => {
  if (!state.built) return;
  const out = +$("exportSize").value;
  const v = exportView(out);
  const s = v.s, o = out / 2;
  const d = state.built.points
    .map((p, i) => (i ? "L" : "M") + (o + p.x * s).toFixed(2) + " " + (o + p.y * s).toFixed(2))
    .join(" ") + " Z";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + out + " " + out +
    '" width="' + out + '" height="' + out + '">\n' +
    '  <rect width="' + out + '" height="' + out + '" fill="#ffffff"/>\n' +
    '  <path d="' + d + '" fill="none" stroke="#141414" stroke-width="' +
    (+$("weight").value) + '" stroke-linejoin="round" stroke-linecap="round"/>\n</svg>\n';
  const a = document.createElement("a");
  a.download = "one-line.svg";
  a.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  a.click();
  say("saved one path of " + state.built.points.length + " points");
});

setupNavigation();
showZoom();
window.addEventListener("resize", fitStage);
say("drop an SVG anywhere, or use the file button");
