const svg = document.getElementById("canvas");
const widthInput = document.getElementById("width");
const heightInput = document.getElementById("height");
const resizeBtn = document.getElementById("resize");
const colorInput = document.getElementById("color");
const strokeInput = document.getElementById("stroke");
const strokeValue = document.getElementById("strokeValue");
const clearBtn = document.getElementById("clear");
const exportBtn = document.getElementById("export");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomFitBtn = document.getElementById("zoomFit");
const zoomValue = document.getElementById("zoomValue");
const gridToggle = document.getElementById("gridToggle");
const gridOverlay = document.getElementById("gridOverlay");
const presetButtons = Array.from(document.querySelectorAll("#presets .preset"));

// Pixel art is normally drawn on a small square sprite canvas, so the tool
// starts at 32x32 rather than a page-sized surface. Anything the presets don't
// cover can still be typed into the width/height fields.
const DEFAULT_WIDTH = 32;
const DEFAULT_HEIGHT = 32;

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_ZOOM = 0.05;
// High enough that even a tiny pixel-art canvas (e.g. 16x16) can be blown up
// to fill the screen with huge per-pixel blocks. It's a px-per-logical-unit
// multiplier, so 256 means one logical pixel can render up to 256px on screen.
const MAX_ZOOM = 256;
const ZOOM_STEP = 1.25;

let drawing = false;
let lastCell = null;
let paintedThisStroke = null;
let logicalWidth = Math.max(1, parseInt(widthInput.value, 10) || DEFAULT_WIDTH);
let logicalHeight = Math.max(1, parseInt(heightInput.value, 10) || DEFAULT_HEIGHT);
let zoom = 1;
let manualZoom = false;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Fit fills the drawing area: sized to the #canvasWrap content box (kept in
// sync with its CSS max-width/max-height) so a small canvas scales all the way
// up to fill it, and a large one scales down to stay fully visible.
function computeFitZoom(w, h) {
  const maxW = Math.min(window.innerWidth * 0.92, 1100) - 8;
  const maxH = window.innerHeight * 0.78 - 8;
  return clamp(Math.min(maxW / w, maxH / h), MIN_ZOOM, MAX_ZOOM);
}

function applyZoom() {
  svg.setAttribute("width", Math.round(logicalWidth * zoom));
  svg.setAttribute("height", Math.round(logicalHeight * zoom));
  zoomValue.textContent = `${Math.round(zoom * 100)}%`;
}

// Brush size is in whole canvas pixels (grid cells), so a fixed 1-40 range
// would let a small pixel-sized canvas be painted over by one brush stamp.
// Cap it relative to the canvas so the brush never outsizes the pixels it's
// meant to paint.
function updateStrokeRange() {
  const maxBrush = clamp(Math.floor(Math.min(logicalWidth, logicalHeight) / 2), 1, 40);
  strokeInput.max = maxBrush;
  if (Number(strokeInput.value) > maxBrush) {
    strokeInput.value = maxBrush;
  }
  strokeValue.textContent = `${strokeInput.value}px`;
}

// The highlight tracks the canvas that's actually applied, not what's typed in
// the fields, so a custom size simply leaves every preset unlit.
function syncPresetSelection() {
  presetButtons.forEach((btn) => {
    const active =
      Number(btn.dataset.w) === logicalWidth &&
      Number(btn.dataset.h) === logicalHeight;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function applySize() {
  logicalWidth = Math.max(1, parseInt(widthInput.value, 10) || DEFAULT_WIDTH);
  logicalHeight = Math.max(1, parseInt(heightInput.value, 10) || DEFAULT_HEIGHT);
  svg.setAttribute("viewBox", `0 0 ${logicalWidth} ${logicalHeight}`);
  updateStrokeRange();
  syncPresetSelection();
  zoom = computeFitZoom(logicalWidth, logicalHeight);
  manualZoom = false;
  applyZoom();
}

function getCell(evt) {
  const rect = svg.getBoundingClientRect();
  const scaleX = svg.viewBox.baseVal.width / rect.width;
  const scaleY = svg.viewBox.baseVal.height / rect.height;
  const x = (evt.clientX - rect.left) * scaleX;
  const y = (evt.clientY - rect.top) * scaleY;
  return {
    x: clamp(Math.floor(x), 0, logicalWidth - 1),
    y: clamp(Math.floor(y), 0, logicalHeight - 1),
  };
}

// This is a pixel-sized canvas: a cell is either painted or it isn't, so
// drawing snaps to the grid and fills whole 1x1 cells instead of a smooth
// vector stroke. The brush is a square stamp of cells centered on the
// cursor's cell.
function stampCell(cx, cy) {
  const brush = Number(strokeInput.value);
  const half = Math.floor(brush / 2);
  for (let dx = 0; dx < brush; dx++) {
    for (let dy = 0; dy < brush; dy++) {
      paintCell(cx - half + dx, cy - half + dy);
    }
  }
}

function paintCell(x, y) {
  if (x < 0 || y < 0 || x >= logicalWidth || y >= logicalHeight) return;
  const key = `${x},${y}`;
  if (paintedThisStroke.has(key)) return;
  paintedThisStroke.add(key);
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", x);
  rect.setAttribute("y", y);
  rect.setAttribute("width", 1);
  rect.setAttribute("height", 1);
  rect.setAttribute("fill", colorInput.value);
  rect.classList.add("px");
  // Insert just before the grid overlay (rather than appendChild, which would
  // paint on top of it) so the grid always stays visible above painted
  // pixels — it's a drawing aid, not part of the artwork, and shouldn't be
  // coverable by paint.
  svg.insertBefore(rect, gridOverlay);
}

// Bresenham between the last and current cell so a fast drag still stamps a
// continuous line instead of leaving gaps between sampled pointer positions.
function stampLine(x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1;
  let sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    stampCell(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function pointerDown(evt) {
  drawing = true;
  paintedThisStroke = new Set();
  const cell = getCell(evt);
  lastCell = cell;
  stampCell(cell.x, cell.y);
  svg.setPointerCapture(evt.pointerId);
}

function pointerMove(evt) {
  if (!drawing) return;
  const cell = getCell(evt);
  if (cell.x === lastCell.x && cell.y === lastCell.y) return;
  stampLine(lastCell.x, lastCell.y, cell.x, cell.y);
  lastCell = cell;
}

function pointerUp(evt) {
  if (!drawing) return;
  drawing = false;
  lastCell = null;
  paintedThisStroke = null;
  svg.releasePointerCapture(evt.pointerId);
}

function clearCanvas() {
  svg.querySelectorAll("rect.px").forEach((r) => r.remove());
}

function exportSvg() {
  const serializer = new XMLSerializer();
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", SVG_NS);
  // The on-screen size follows zoom; the exported file must always be the
  // true pixel dimensions the canvas was set to.
  clone.setAttribute("width", logicalWidth);
  clone.setAttribute("height", logicalHeight);
  const overlay = clone.querySelector("#gridOverlay");
  if (overlay) overlay.remove();
  const defs = clone.querySelector("defs");
  if (defs) defs.remove();
  const source = serializer.serializeToString(clone);
  const blob = new Blob(
    [`<?xml version="1.0" encoding="UTF-8"?>\n${source}`],
    { type: "image/svg+xml" }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "drawing.svg";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

resizeBtn.addEventListener("click", applySize);

// Presets are a shortcut for the width/height fields, not a separate mode:
// they fill the fields in and apply, so the custom inputs always show the
// canvas you're actually on.
presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    widthInput.value = btn.dataset.w;
    heightInput.value = btn.dataset.h;
    applySize();
  });
});

// Enter in either size field applies, so a custom size doesn't need a trip to
// the "Set canvas" button.
[widthInput, heightInput].forEach((input) => {
  input.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") applySize();
  });
});
strokeInput.addEventListener("input", () => {
  strokeValue.textContent = `${strokeInput.value}px`;
});
clearBtn.addEventListener("click", clearCanvas);
exportBtn.addEventListener("click", exportSvg);

zoomInBtn.addEventListener("click", () => {
  zoom = clamp(zoom * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
  manualZoom = true;
  applyZoom();
});
zoomOutBtn.addEventListener("click", () => {
  zoom = clamp(zoom / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
  manualZoom = true;
  applyZoom();
});
zoomFitBtn.addEventListener("click", () => {
  zoom = computeFitZoom(logicalWidth, logicalHeight);
  manualZoom = false;
  applyZoom();
});

gridToggle.addEventListener("change", () => {
  gridOverlay.style.display = gridToggle.checked ? "" : "none";
});

window.addEventListener("resize", () => {
  if (manualZoom) return;
  zoom = computeFitZoom(logicalWidth, logicalHeight);
  applyZoom();
});

svg.addEventListener("pointerdown", pointerDown);
svg.addEventListener("pointermove", pointerMove);
svg.addEventListener("pointerup", pointerUp);
svg.addEventListener("pointercancel", pointerUp);

applySize();
