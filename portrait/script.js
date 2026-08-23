import { renderMain, renderThumbs, LAYERS, defaultLayer } from "./binarize.js";
import { toSVG } from "./vectorize.js";
import { FilesetResolver, FaceLandmarker, ImageSegmenter }
  from "./vendor/vision_bundle.mjs";

const WASM_ROOT = "vendor/wasm";
const LANDMARK_MODEL = "vendor/face_landmarker.task";
const SEGMENT_MODEL = "vendor/selfie_multiclass_256x256.tflite";

// The model's own category order. Anything not named here is background.
const CLASSES = [
  { id: 0, key: "background", label: "background", colour: [244, 242, 238] },
  { id: 1, key: "hair", label: "hair", colour: [150, 95, 176] },
  { id: 2, key: "bodySkin", label: "body skin (ears, neck)", colour: [200, 122, 32] },
  { id: 3, key: "faceSkin", label: "face skin", colour: [214, 105, 105] },
  { id: 4, key: "clothes", label: "clothes", colour: [47, 111, 159] },
  { id: 5, key: "other", label: "accessories", colour: [63, 143, 95] },
];

const $ = (id) => document.getElementById(id);
const say = (m) => { $("status").textContent = m; };

const state = {
  img: null, W: 0, H: 0,
  landmarks: null,
  box: null,        // square head crop in image pixels
  cat: null,        // Uint8Array of class ids, crop space
  cw: 0, ch: 0,
  matte: null,      // Uint8Array 0..255 alpha, crop space
};

let landmarker = null;
let segmenter = null;

async function models() {
  if (landmarker && segmenter) return;
  say("loading the two models from this site (41 MB, cached after the first time)");
  const files = await FilesetResolver.forVisionTasks(WASM_ROOT);
  // The landmarker runs on the CPU on purpose. On the GPU delegate it returns
  // exactly one face however high numFaces is set, so a picture of two people
  // silently loses one of them. A single still frame costs little on the CPU.
  landmarker = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: LANDMARK_MODEL, delegate: "CPU" },
    runningMode: "IMAGE", numFaces: 5,
  });
  const makeSegmenter = async (delegate) => {
    segmenter = await ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: SEGMENT_MODEL, delegate },
      runningMode: "IMAGE", outputCategoryMask: true, outputConfidenceMasks: false,
    });
  };
  try { await makeSegmenter("GPU"); }
  catch (e) { say("GPU delegate refused, segmenting on the CPU"); await makeSegmenter("CPU"); }
}

// ── Where the head is ───────────────────────────────────────────────────────
//
// The landmark mesh stops at the face; hair sits well outside it and a beard
// hangs below the chin. The crop is therefore the mesh's own box grown by a
// fixed share of the face's height, then squared off, because the segmentation
// model reads a square and letterboxing would waste half of its 256 pixels.

function headBox() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of state.landmarks) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const grow = +$("grow").value;
  const fw = (x1 - x0) * state.W, fh = (y1 - y0) * state.H;
  let bx0 = x0 * state.W - fw * grow * 0.75;
  let bx1 = x1 * state.W + fw * grow * 0.75;
  let by0 = y0 * state.H - fh * grow * 1.15;   // hair goes up further than out
  let by1 = y1 * state.H + fh * grow * 0.55;   // and a beard goes down a little
  let side = Math.max(bx1 - bx0, by1 - by0);
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  // A square that runs off the picture gets padded with white, and that padding
  // belongs to no component and can never be drawn. Shrink the box to whatever
  // the picture can actually supply, then slide it back inside.
  side = Math.min(side, state.W, state.H);
  const x = Math.min(Math.max(0, cx - side / 2), state.W - side);
  const y = Math.min(Math.max(0, cy - side / 2), state.H - side);
  return {
    x: Math.round(x), y: Math.round(y),
    side: Math.round(side),
    faceTop: y0 * state.H, faceBottom: y1 * state.H,
    faceHeight: fh, faceWidth: fw,
  };
}

function cropCanvas(box, size) {
  const cv = document.createElement("canvas");
  cv.width = size; cv.height = size;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage($("hidden"), box.x, box.y, box.side, box.side, 0, 0, size, size);
  return cv;
}

function segment(canvas) {
  let out = null;
  const r = segmenter.segment(canvas, (res) => { out = res; });
  if (r && r.categoryMask) out = r;
  if (!out || !out.categoryMask) throw new Error("segmenter returned no category mask");
  const m = out.categoryMask;
  const data = Uint8Array.from(m.getAsUint8Array());
  const dims = { w: m.width, h: m.height };
  m.close();
  return { data, ...dims };
}

// ── Cleaning the matte ──────────────────────────────────────────────────────

function boxMax(src, w, h, r, take) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = take === Math.max ? 0 : 255;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        v = take(v, src[y * w + xx]);
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = take === Math.max ? 0 : 255;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        v = take(v, tmp[yy * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

const dilate = (m, w, h, r) => (r > 0 ? boxMax(m, w, h, r, Math.max) : m);
const erode = (m, w, h, r) => (r > 0 ? boxMax(m, w, h, r, Math.min) : m);

function largestBlob(mask, w, h) {
  const seen = new Uint8Array(w * h);
  let best = null, bestN = 0;
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let top = 0, n = 0;
    const blob = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top];
      blob.push(i); n++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (n > bestN) { bestN = n; best = blob; }
  }
  const out = new Uint8Array(w * h);
  if (best) for (const i of best) out[i] = 255;
  return out;
}

// A gap the model left inside the head — between strands of hair, or a dark
// nostril it read as background — is any hole the border cannot reach.
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const push = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (top) {
    const i = stack[--top];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] || !outside[i] ? 255 : 0;
  return out;
}

function feather(mask, w, h, r) {
  if (r < 1) return mask;
  const tmp = new Float32Array(w * h), out = new Uint8Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += mask[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      sum -= mask[y * w + Math.min(w - 1, Math.max(0, x - r))];
      sum += mask[y * w + Math.min(w - 1, Math.max(0, x + r + 1))];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(sum / n);
      sum -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
      sum += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
    }
  }
  return out;
}

function buildMatte() {
  const { cat, cw, ch, box } = state;
  const wanted = new Set();
  for (const c of CLASSES) if (c.id && $("cls_" + c.key).checked) wanted.add(c.id);

  const raw = new Uint8Array(cw * ch);
  for (let i = 0; i < cat.length; i++) raw[i] = wanted.has(cat[i]) ? 255 : 0;

  // The neck cut, expressed in face heights below the chin, so it travels with
  // the face rather than with the picture's own scale.
  const keep = +$("neck").value;
  if (keep < 2) {
    const cutImage = box.faceBottom + state.landmarkFaceHeight * keep;
    const cutCrop = ((cutImage - box.y) / box.side) * ch;
    for (let y = Math.max(0, Math.ceil(cutCrop)); y < ch; y++) {
      raw.fill(0, y * cw, y * cw + cw);
    }
  }

  let m = raw;
  const r = +$("close").value;
  if (r > 0) { m = dilate(m, cw, ch, r); m = erode(m, cw, ch, r); }
  if ($("largest").checked) m = largestBlob(m, cw, ch);
  if ($("holes").checked) m = fillHoles(m, cw, ch);
  return feather(m, cw, ch, +$("feather").value);
}

// ── Drawing ─────────────────────────────────────────────────────────────────

function clear(cv, w, h) {
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function drawSource() {
  const ctx = clear($("src"), state.W, state.H);
  ctx.drawImage($("hidden"), 0, 0);
  if (!state.landmarks) return;
  if ($("showBox").checked && state.box) {
    ctx.strokeStyle = "#2f6f9f";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(state.box.x, state.box.y, state.box.side, state.box.side);
    ctx.setLineDash([]);
  }
  if ($("showMarks").checked) {
    ctx.fillStyle = "rgba(214,69,69,0.7)";
    for (const p of state.landmarks) ctx.fillRect(p.x * state.W - 0.6, p.y * state.H - 0.6, 1.2, 1.2);
  }
}

function drawClasses() {
  const { cat, cw, ch, box } = state;
  const off = document.createElement("canvas");
  off.width = cw; off.height = ch;
  const id = off.getContext("2d").createImageData(cw, ch);
  for (let i = 0; i < cat.length; i++) {
    const c = CLASSES[cat[i]] || CLASSES[0];
    id.data[i * 4] = c.colour[0];
    id.data[i * 4 + 1] = c.colour[1];
    id.data[i * 4 + 2] = c.colour[2];
    id.data[i * 4 + 3] = 255;
  }
  off.getContext("2d").putImageData(id, 0, 0);
  const ctx = clear($("classes"), box.side, box.side);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, box.side, box.side);
}

function drawCutout() {
  const { matte, cw, ch, box } = state;
  const off = document.createElement("canvas");
  off.width = box.side; off.height = box.side;
  const octx = off.getContext("2d");
  octx.drawImage($("hidden"), box.x, box.y, box.side, box.side, 0, 0, box.side, box.side);
  const id = octx.getImageData(0, 0, box.side, box.side);

  for (let y = 0; y < box.side; y++) {
    const sy = Math.min(ch - 1, ((y / box.side) * ch) | 0);
    for (let x = 0; x < box.side; x++) {
      const sx = Math.min(cw - 1, ((x / box.side) * cw) | 0);
      id.data[(y * box.side + x) * 4 + 3] = matte[sy * cw + sx];
    }
  }
  octx.putImageData(id, 0, 0);

  const ctx = clear($("cut"), box.side, box.side);
  ctx.drawImage(off, 0, 0);
  state.cutCanvas = off;

  if ($("showRings").checked && state.landmarks) {
    ctx.lineWidth = Math.max(1, box.side / 380);
    for (const [name, set] of REGIONS()) {
      if (!set) continue;
      ctx.strokeStyle = name === "face oval" ? "rgba(47,111,159,0.85)" : "rgba(214,69,69,0.9)";
      for (const cyc of cyclesFromConnections(set)) {
        ctx.beginPath();
        cyc.forEach((i, k) => {
          const p = state.landmarks[i];
          const x = p.x * state.W - box.x, y = p.y * state.H - box.y;
          k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.stroke();
      }
    }
  }
}

function cyclesFromConnections(conns) {
  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const c of conns) {
    const a = c.start !== undefined ? c.start : c[0];
    const b = c.end !== undefined ? c.end : c[1];
    link(a, b); link(b, a);
  }
  const nodes = [...adj.keys()];
  const order = [...nodes.filter((n) => adj.get(n).length === 1), ...nodes];
  const seen = new Set(); const cycles = [];
  for (const start of order) {
    if (seen.has(start)) continue;
    const path = []; let prev = null, cur = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur); path.push(cur);
      let next;
      for (const n of adj.get(cur)) if (n !== prev && !seen.has(n)) { next = n; break; }
      prev = cur; cur = next;
    }
    if (path.length > 2) cycles.push(path);
  }
  return cycles;
}

const REGIONS = () => [
  ["face oval", FaceLandmarker.FACE_LANDMARKS_FACE_OVAL],
  ["lips", FaceLandmarker.FACE_LANDMARKS_LIPS],
  ["left eye", FaceLandmarker.FACE_LANDMARKS_LEFT_EYE],
  ["right eye", FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE],
  ["left brow", FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW],
  ["right brow", FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW],
  ["left iris", FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS],
  ["right iris", FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS],
];

// Hair the model found inside the face oval is not hair on the head: it is a
// beard, a moustache or brows. Counting it is the only way the extractor can
// say anything about facial hair at all.
function facialHairShare() {
  const oval = cyclesFromConnections(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL)[0];
  if (!oval) return null;
  const poly = oval.map((i) => {
    const p = state.landmarks[i];
    return { x: ((p.x * state.W - state.box.x) / state.box.side) * state.cw,
             y: ((p.y * state.H - state.box.y) / state.box.side) * state.ch };
  });
  const inside = (x, y) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i].y > y) !== (poly[j].y > y) &&
          x < ((poly[j].x - poly[i].x) * (y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) hit = !hit;
    }
    return hit;
  };
  let hair = 0, total = 0;
  for (let y = 0; y < state.ch; y++) {
    for (let x = 0; x < state.cw; x++) {
      if (!inside(x, y)) continue;
      total++;
      if (state.cat[y * state.cw + x] === 1) hair++;
    }
  }
  return total ? { hair, total, share: hair / total } : null;
}

function report() {
  const counts = new Array(CLASSES.length).fill(0);
  for (const v of state.cat) counts[v] = (counts[v] || 0) + 1;
  const n = state.cat.length;
  const parts = CLASSES.filter((c) => c.id && counts[c.id])
    .map((c) => c.label + " " + ((counts[c.id] / n) * 100).toFixed(1) + "%");
  let kept = 0;
  for (const v of state.matte) if (v > 127) kept++;
  const fh = facialHairShare();
  $("stats").innerHTML =
    "<strong>face:</strong> " + Math.round(state.box.faceWidth) + " x " +
      Math.round(state.box.faceHeight) + " px in a " + state.W + " x " + state.H + " image" +
    "<br><strong>in the crop:</strong> " + (parts.join(", ") || "nothing but background") +
    "<br><strong>kept as head:</strong> " + ((kept / n) * 100).toFixed(1) + "% of the crop" +
    (fh ? "<br><strong>facial hair:</strong> " + (fh.share * 100).toFixed(1) +
          "% of the face oval reads as hair (beard, moustache, brows)" : "");
}

function rerun() {
  if (!state.cat) return;
  const t0 = performance.now();
  state.matte = buildMatte();
  drawSource();
  drawClasses();
  drawCutout();
  report();
  const globals = {
    size: +$("binres").value,
    invert: $("invert").checked,
    limitToMatte: $("limitToMatte").checked,
  };
  $("work").hidden = false;
  $("drop").classList.remove("dz-open");
  state.out = renderMain(state, state.layers, globals);
  renderThumbs(state, state.layers, globals, state.activeLayer);
  $("savePng").disabled = $("saveSvg").disabled = !state.out;
  window.__state = state;
  say("rebuilt the matte in " + Math.round(performance.now() - t0) + " ms");
}

async function loadFile(file) {
  if (!file) return;
  say("reading image");
  const img = await createImageBitmap(file);
  const scale = Math.min(2000 / img.width, 2000 / img.height, 1);
  state.W = Math.round(img.width * scale);
  state.H = Math.round(img.height * scale);
  const hid = $("hidden");
  hid.width = state.W; hid.height = state.H;
  hid.getContext("2d").drawImage(img, 0, 0, state.W, state.H);
  state.img = img;
  drawSource();

  await models();
  say("looking for a face");
  const res = landmarker.detect(hid);
  state.faces = res.faceLandmarks || [];
  state.faceIndex = 0;
  buildFacePicker();
  state.landmarks = state.faces.length ? state.faces[0] : null;
  if (state.faces.length > 1) say("found " + state.faces.length + " faces; showing the first");
  if (!state.landmarks) {
    state.cat = null;
    state.matte = null;
    state.cutCanvas = null;
    clear($("classes"), 10, 10);
    clear($("cut"), 10, 10);
    $("stats").textContent = "";
    say("no face found, so there is no head to extract");
    return;
  }
  recrop();
}

function recrop() {
  if (!state.landmarks) return;
  state.box = headBox();
  state.landmarkFaceHeight = state.box.faceHeight;
  say("segmenting the head");
  const size = +$("segsize").value;
  const cc = cropCanvas(state.box, size);
  const { data, w, h } = segment(cc);
  state.cat = data; state.cw = w; state.ch = h;
  const px = cc.getContext("2d").getImageData(0, 0, size, size).data;
  const lum = new Float32Array(w * h);
  const sx = size / w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((Math.min(size - 1, (y * sx) | 0) * size) + Math.min(size - 1, (x * sx) | 0)) * 4;
      lum[y * w + x] = (0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2]) / 255;
    }
  }
  state.cropLum = lum;
  rerun();
}

const LAYER_DOT = { faceSkin: "#d66969", hair: "#965fb0", bodySkin: "#c87a20",
                    clothes: "#2f6f9f", other: "#3f8f5f", background: "#bbb" };

state.layers = {};
for (const [key] of LAYERS) state.layers[key] = defaultLayer(key);
state.activeLayer = "faceSkin";

const FIELDS = [
  ["lmode", "mode", "value"], ["lmethod", "method", "value"],
  ["lflatten", "flatten", "num"], ["lcontrast", "contrast", "num"],
  ["lgamma", "gamma", "num"], ["lpreblur", "preblur", "num"],
  ["lbias", "bias", "num"], ["ldespeckle", "despeckle", "num"],
  ["lwindow", "window", "num"], ["lk", "k", "num"], ["lc", "c", "num"],
  ["lsigma", "sigma", "num"], ["ltau", "tau", "num"],
  ["leps", "eps", "num"], ["lphi", "phi", "num"],
];

$("layerTabs").innerHTML = LAYERS.map(([key, , label]) =>
  '<button type="button" class="ltab" data-l="' + key + '">' +
  '<span class="dot" style="background:' + LAYER_DOT[key] + '"></span>' + label + "</button>").join("");

// PREPRINT draws its own select over the native one and only refreshes the
// label when a person picks from the list, so a value set from code leaves the
// trigger reading the option before it. Carry the text across by hand until
// that is fixed upstream. The trigger's id is the select's plus "-trigger".
function setSelect(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = value;
  const shown = document.getElementById(id + "-trigger");
  const text = shown && shown.querySelector(".select-value");
  if (text) text.textContent = el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent : "";
}

// The list of faces is only known once the models have run, and an enhanced
// select never rebuilds its list. Replacing the whole control lets the observer
// in controls.js draw the new one from scratch.
function buildFacePicker() {
  const wrap = $("faceWrap");
  wrap.hidden = state.faces.length <= 1;
  const old = document.getElementById("facePick");
  const host = old && old.parentElement && old.parentElement.querySelector(".select-trigger")
    ? old.parentElement : old;
  const fresh = document.createElement("select");
  fresh.id = "facePick";
  fresh.setAttribute("aria-label", "Which face to work on");
  fresh.innerHTML = state.faces
    .map((_, i) => '<option value="' + i + '">' + (i + 1) + "</option>").join("");
  fresh.value = String(state.faceIndex);
  fresh.addEventListener("change", (e) => {
    state.faceIndex = +e.target.value;
    state.landmarks = state.faces[state.faceIndex];
    recrop();
  });
  if (host) host.replaceWith(fresh); else wrap.appendChild(fresh);
}

function settingsToControls() {
  const s = state.layers[state.activeLayer];
  for (const [id, prop, kind] of FIELDS) {
    const el = $(id);
    if (!el) continue;
    if (el.tagName === "SELECT") setSelect(id, s[prop]);
    else el.value = String(s[prop]);
  }
  const isMethod = s.mode === "method";
  $("lmethodWrap").style.display = isMethod ? "" : "none";
  $("lparams").style.display = isMethod ? "" : "none";
  for (const el of document.querySelectorAll(".mparams")) {
    el.classList.toggle("on", isMethod && el.dataset.for.split(" ").includes(s.method));
  }
  for (const b of document.querySelectorAll(".ltab")) {
    b.classList.toggle("on", b.dataset.l === state.activeLayer);
  }
}

function controlsToSettings() {
  const s = state.layers[state.activeLayer];
  for (const [id, prop, kind] of FIELDS) {
    const el = $(id);
    if (!el) continue;
    s[prop] = kind === "num" ? +el.value : el.value;
  }
}

for (const b of document.querySelectorAll(".ltab")) {
  b.addEventListener("click", () => {
    state.activeLayer = b.dataset.l;
    settingsToControls();
    rerun();
  });
}

for (const [id] of FIELDS) {
  const el = $(id);
  if (el) el.addEventListener("change", () => { controlsToSettings(); settingsToControls(); rerun(); });
}

$("applyAll").addEventListener("click", () => {
  const src = state.layers[state.activeLayer];
  for (const [key] of LAYERS) {
    if (key === state.activeLayer) continue;
    state.layers[key] = { ...src };
  }
  rerun();
});

for (const b of document.querySelectorAll(".thumb")) {
  b.addEventListener("click", () => {
    const s = state.layers[state.activeLayer];
    s.mode = "method";
    s.method = b.dataset.m;
    settingsToControls();
    rerun();
  });
}

settingsToControls();

function download(name, href) {
  const a = document.createElement("a");
  a.download = name;
  a.href = href;
  a.click();
}

$("savePng").addEventListener("click", () => {
  if (!state.out) return;
  const n = +$("exportSize").value;
  const cv = document.createElement("canvas");
  cv.width = n; cv.height = n;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, n, n);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage($("bw"), 0, 0, n, n);
  download("portrait.png", cv.toDataURL("image/png"));
});

$("saveSvg").addEventListener("click", () => {
  if (!state.out) return;
  const { svg, loops } = toSVG(state.out.ink, state.out.size, +$("exportSize").value, {
    tolerance: +$("vtol").value,
    smoothing: +$("vsmooth").value,
    minArea: +$("vmin").value,
  });
  say("SVG: " + loops + " outlines");
  download("portrait.svg", URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })));
});

$("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });

for (const id of ["grow", "segsize"]) $(id).addEventListener("change", recrop);
for (const c of CLASSES) if (c.id) $("cls_" + c.key).addEventListener("change", rerun);
for (const id of ["neck", "close", "feather", "largest", "holes", "showRings", "showBox", "showMarks",
                  "binres", "invert", "limitToMatte", "vsmooth", "vtol", "vmin"]) {
  $(id).addEventListener("change", rerun);
}

$("save").addEventListener("click", () => {
  if (!state.cutCanvas) return;
  const a = document.createElement("a");
  a.download = "head-cutout.png";
  a.href = state.cutCanvas.toDataURL("image/png");
  a.click();
});

say("drop a photograph anywhere, or use the file button");
