/* Overprint Bench — shapes, and the colour their overlaps make.
 *
 * The whole tool is one function. `buildSvg` turns the list of shapes into an
 * SVG document, and everything else either edits that list or calls it: the
 * screen gets the document with a selection outline on it, the export gets the
 * same document without one. There is no second drawing path, no canvas and no
 * serializer that has to be kept in step with a renderer, so "what you see is
 * what you get" is not a claim about the tool, it is the shape of the file.
 *
 * WHY REGIONS AND NOT A BLEND MODE. `mix-blend-mode: multiply` on each shape
 * would give the same picture in a browser in a tenth of the code, and an SVG
 * that only some readers can open. What is written here instead is what a
 * printer does: work out which plates cover a patch, mix those inks once, and
 * put that patch down as a flat opaque shape. The geometry of a patch is the
 * intersection of the shapes covering it, and SVG has had exactly that since
 * 1.1 — nested <clipPath>, which every reader supports. Circles stay circles
 * rather than becoming 128-gons, because a clip is the real curve.
 *
 * The painter's order is the only thing that has to be right: every subset is
 * drawn after all of its own subsets. Sorting by how many shapes are in a
 * subset does it — the overlap of {a,b} and {a,c} is {a,b,c}, which is longer
 * than both and so lands on top of them.
 */
const canvas = document.getElementById("canvas");
const shapeGroup = document.getElementById("shapeGroup");
const colorInput = document.getElementById("shapeColor");
const sizeInput = document.getElementById("shapeSize");
const sizeValue = document.getElementById("sizeValue");
const turnInput = document.getElementById("shapeTurn");
const turnValue = document.getElementById("turnValue");
const removeBtn = document.getElementById("remove");
const clearBtn = document.getElementById("clear");
const exportBtn = document.getElementById("export");
const addButtons = Array.from(document.querySelectorAll("[data-add]"));
const modelButtons = Array.from(document.querySelectorAll("[data-model]"));

const VIEW_W = 640;
const VIEW_H = 480;

// The ground each model needs, and the reason it can be left out of the
// arithmetic: white multiplied by anything is that thing, black screened with
// anything is that thing. So the sheet never changes a colour that was chosen,
// it is only what the uncovered part of it looks like.
const GROUND = { ink: "#ffffff", light: "#000000" };

// What a new shape is inked with: the primaries of the model it is added
// under. Three shapes and no further decision give the textbook picture in
// either model — cyan, magenta and yellow multiply down to black, red, green
// and blue screen up to white — and a fourth starts the cycle again.
const PRIMARIES = {
  ink: ["#00ffff", "#ff00ff", "#ffff00"],
  light: ["#ff0000", "#00ff00", "#0000ff"],
};

const MIN_SIZE = Number(sizeInput.min);
const MAX_SIZE = Number(sizeInput.max);
const START_SIZE = 230;

// Where a new shape lands: a third of a turn round from the last one, at a
// radius that leaves three of them overlapping the way the demonstration in
// every colour book does. Every third shape comes back to the same bearing and
// is pushed further out, because a shape dropped exactly on top of an earlier
// one looks like a press that did nothing. It is a starting position and not a
// rule — the first thing anyone does with a shape here is drag it elsewhere.
const SPILL = 74;
const SPILL_STEP = 0.5;
const SPILL_MAX = 160;

let shapes = [];
let model = "ink";
let selectedId = null;
let added = 0;
let nextId = 1;
let drag = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Two decimals is a tenth of a screen pixel at this size, and it keeps the
// exported path data readable by a person.
function f(n) {
  return String(Math.round(n * 100) / 100);
}

/* ── the shapes ─────────────────────────────────────────────────────────────
   A shape is described by the width of its bounding box before it is turned,
   so a square, a triangle and a hexagon set to 230 all read as the same size.
   Everything else follows from that: the circumradius is whatever makes the
   corner angles below span that width, and it is the only per-kind number. */
const CORNERS = {
  square: [45, 135, 225, 315],
  triangle: [-90, 30, 150],
  hexagon: [-90, -30, 30, 90, 150, 210],
};
const SPREAD = {
  square: Math.SQRT2,
  triangle: Math.sqrt(3),
  hexagon: Math.sqrt(3),
};

function cornersOf(shape) {
  const r = shape.size / SPREAD[shape.kind];
  return CORNERS[shape.kind].map((deg) => {
    const a = ((deg + shape.turn) * Math.PI) / 180;
    return [shape.x + r * Math.cos(a), shape.y + r * Math.sin(a)];
  });
}

// A circle is two half-arcs rather than a <circle>, so that every shape is one
// <path> and the clip and the fill can be written by the same line of code.
function pathFor(shape) {
  if (shape.kind === "circle") {
    const r = shape.size / 2;
    const arc = `a${f(r)} ${f(r)} 0 1 0 `;
    return `M${f(shape.x - r)} ${f(shape.y)}${arc}${f(2 * r)} 0${arc}${f(-2 * r)} 0Z`;
  }
  return `M${cornersOf(shape).map((p) => `${f(p[0])} ${f(p[1])}`).join("L")}Z`;
}

function boxOf(shape) {
  if (shape.kind === "circle") {
    const r = shape.size / 2;
    return { x0: shape.x - r, y0: shape.y - r, x1: shape.x + r, y1: shape.y + r };
  }
  const pts = cornersOf(shape);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/* ── the arithmetic ─────────────────────────────────────────────────────────
   Ink multiplies and light screens, which are the same operation seen from the
   two ends: one asks how much of the paper's light survives both filters, the
   other how much of the room's darkness survives neither beam. Both are
   commutative and associative, which is what makes the sheet order-free. */
function toRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
  return "#" + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
}

function mix(a, b) {
  return model === "ink"
    ? a.map((v, i) => (v * b[i]) / 255)
    : a.map((v, i) => 255 - ((255 - v) * (255 - b[i])) / 255);
}

function blend(set) {
  return toHex(set.map((i) => toRgb(shapes[i].color)).reduce(mix));
}

/* ── which shapes overlap which ─────────────────────────────────────────────
   Every subset of two or more, found by walking the shapes in order and
   carrying the running intersection of their bounding boxes. The boxes are the
   prune and the reason this is not 2^n work: the moment a partial subset's
   boxes come apart, no subset containing it can meet either, and the whole
   branch is dropped. Boxes are generous — two shapes whose boxes cross need not
   themselves cross — so a few subsets survive that turn out to be empty. They
   cost an empty clip and draw nothing, which is the right way to be wrong. */
function overlaps() {
  const boxes = shapes.map(boxOf);
  const found = [];
  const walk = (from, chosen, box) => {
    for (let i = from; i < shapes.length; i++) {
      const next = {
        x0: Math.max(box.x0, boxes[i].x0),
        y0: Math.max(box.y0, boxes[i].y0),
        x1: Math.min(box.x1, boxes[i].x1),
        y1: Math.min(box.y1, boxes[i].y1),
      };
      if (next.x0 >= next.x1 || next.y0 >= next.y1) continue;
      chosen.push(i);
      if (chosen.length > 1) found.push(chosen.slice());
      walk(i + 1, chosen, next);
      chosen.pop();
    }
  };
  walk(0, [], { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity });
  return found.sort((a, b) => a.length - b.length);
}

/* ── the document ───────────────────────────────────────────────────────────
   `chrome` is the one difference between the screen and the file: the marks
   that say which shape is selected, and the index each shape carries so a click
   can find it again. */
function buildSvg(chrome) {
  const sets = overlaps();
  const clipped = new Set();
  sets.forEach((set) => set.slice(0, -1).forEach((i) => clipped.add(i)));

  const body = [`<rect width="${VIEW_W}" height="${VIEW_H}" fill="${GROUND[model]}"/>`];

  if (clipped.size) {
    const defs = Array.from(clipped)
      .sort((a, b) => a - b)
      .map((i) => `<clipPath id="ov${i}"><path d="${pathFor(shapes[i])}"/></clipPath>`);
    body.push(`<defs>${defs.join("")}</defs>`);
  }

  shapes.forEach((shape, i) => {
    const tag = chrome ? ` data-i="${i}"` : "";
    body.push(`<path d="${pathFor(shape)}" fill="${shape.color}"${tag}/>`);
  });

  // A patch is the last shape of the subset, clipped by all the others. Nested
  // clips intersect, so the nesting is the intersection and no path arithmetic
  // is done anywhere in this file.
  sets.forEach((set) => {
    const open = set.slice(0, -1).map((i) => `<g clip-path="url(#ov${i})">`).join("");
    const top = shapes[set[set.length - 1]];
    body.push(`${open}<path d="${pathFor(top)}" fill="${blend(set)}"/>${"</g>".repeat(set.length - 1)}`);
  });

  const picked = chrome && selected();
  if (picked) {
    const d = pathFor(picked);
    body.push(`<path class="pick-mat" d="${d}"/><path class="pick" d="${d}"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW_W}" height="${VIEW_H}" viewBox="0 0 ${VIEW_W} ${VIEW_H}">${body.join("")}</svg>`;
}

// Parsed as XML rather than assigned as innerHTML, so the string that reaches
// the screen is parsed by the same rules as the string that reaches the file.
// A document that would not open is then a document that does not draw, here,
// rather than a surprise in somebody else's editor.
function render() {
  const doc = new DOMParser().parseFromString(buildSvg(true), "image/svg+xml");
  canvas.replaceChildren(...Array.from(doc.documentElement.childNodes, (n) => document.importNode(n, true)));
  canvas.setAttribute("aria-label", describe());
}

function describe() {
  if (!shapes.length) return "An empty sheet";
  const kinds = shapes.map((s) => s.kind).join(", ");
  return `${shapes.length} shapes on the sheet, mixed as ${model}: ${kinds}`;
}

/* ── the list ───────────────────────────────────────────────────────────── */
function selected() {
  return shapes.find((s) => s.id === selectedId) || null;
}

function add(kind) {
  const slots = PRIMARIES[model].length;
  const slot = added % slots;
  const a = ((-90 + slot * 120) * Math.PI) / 180;
  const spill = Math.min(SPILL * (1 + Math.floor(added / slots) * SPILL_STEP), SPILL_MAX);
  shapes.push({
    id: nextId++,
    kind: kind,
    slot: slot,
    x: VIEW_W / 2 + spill * Math.cos(a),
    y: VIEW_H / 2 + spill * Math.sin(a),
    size: START_SIZE,
    turn: 0,
    color: PRIMARIES[model][slot],
    // Whether the reader chose this colour. Until they do, the shape wears the
    // model's primary and follows it when the model changes; the moment they
    // pick one it is theirs and nothing moves it again.
    inked: false,
  });
  added++;
  selectedId = shapes[shapes.length - 1].id;
  sync();
  render();
}

function setModel(next) {
  if (next === model) return;
  model = next;
  shapes.forEach((s) => {
    if (!s.inked) s.color = PRIMARIES[model][s.slot];
  });
  modelButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.model === model));
  sync();
  render();
}

// The toolbar shows the selection or says there is none. The colour input is
// left holding the last colour it showed rather than blanked, because an empty
// colour input is not a thing a colour input can be.
function sync() {
  const shape = selected();
  shapeGroup.classList.toggle("is-idle", !shape);
  [colorInput, sizeInput, turnInput, removeBtn].forEach((el) => {
    el.disabled = !shape;
  });
  if (!shape) return;
  colorInput.value = shape.color;
  sizeInput.value = String(Math.round(shape.size));
  sizeValue.textContent = String(Math.round(shape.size));
  turnInput.value = String(Math.round(shape.turn));
  turnValue.textContent = `${Math.round(shape.turn)}°`;
  // A circle has no rotation to report, and a live control that changes nothing
  // is worse than one that says it does not apply.
  turnInput.disabled = shape.kind === "circle";
}

function pick(id) {
  if (selectedId === id) return;
  selectedId = id;
  sync();
  render();
}

/* ── the sheet ──────────────────────────────────────────────────────────── */
// The pointer's place in the drawing's own units. The sheet is scaled by CSS
// and keeps its ratio, so one factor does both axes.
function toUser(evt) {
  const box = canvas.getBoundingClientRect();
  return {
    x: ((evt.clientX - box.left) / box.width) * VIEW_W,
    y: ((evt.clientY - box.top) / box.height) * VIEW_H,
  };
}

canvas.addEventListener("pointerdown", (evt) => {
  if (evt.button !== 0) return;
  const hit = evt.target.closest("[data-i]");
  if (!hit) {
    pick(null);
    return;
  }
  const shape = shapes[Number(hit.dataset.i)];
  pick(shape.id);
  const p = toUser(evt);
  drag = { id: shape.id, pointer: evt.pointerId, dx: shape.x - p.x, dy: shape.y - p.y };
  // Captured on the sheet rather than on the shape, because the shape is
  // rebuilt on every frame of the drag and a capture held by a node that has
  // been replaced is a drag that stops the first time the picture changes.
  try {
    canvas.setPointerCapture(evt.pointerId);
  } catch (err) {
    /* a pointer that has already gone */
  }
});

canvas.addEventListener("pointermove", (evt) => {
  if (!drag || evt.pointerId !== drag.pointer) return;
  const shape = shapes.find((s) => s.id === drag.id);
  if (!shape) return;
  const p = toUser(evt);
  // The centre is held on the sheet, so a shape can hang off an edge but can
  // never be pushed out of reach of the hand that put it there.
  shape.x = clamp(p.x + drag.dx, 0, VIEW_W);
  shape.y = clamp(p.y + drag.dy, 0, VIEW_H);
  render();
});

function endDrag(evt) {
  if (!drag || evt.pointerId !== drag.pointer) return;
  try {
    canvas.releasePointerCapture(drag.pointer);
  } catch (err) {
    /* released with the pointer */
  }
  drag = null;
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

/* ── the toolbar ────────────────────────────────────────────────────────── */
addButtons.forEach((btn) => {
  btn.addEventListener("click", () => add(btn.dataset.add));
});

modelButtons.forEach((btn) => {
  btn.addEventListener("click", () => setModel(btn.dataset.model));
});

colorInput.addEventListener("input", () => {
  const shape = selected();
  if (!shape) return;
  shape.color = colorInput.value;
  shape.inked = true;
  render();
});

sizeInput.addEventListener("input", () => {
  const shape = selected();
  if (!shape) return;
  shape.size = clamp(Number(sizeInput.value), MIN_SIZE, MAX_SIZE);
  sizeValue.textContent = String(Math.round(shape.size));
  render();
});

turnInput.addEventListener("input", () => {
  const shape = selected();
  if (!shape) return;
  shape.turn = Number(turnInput.value);
  turnValue.textContent = `${Math.round(shape.turn)}°`;
  render();
});

removeBtn.addEventListener("click", () => {
  const shape = selected();
  if (!shape) return;
  shapes = shapes.filter((s) => s.id !== shape.id);
  selectedId = null;
  sync();
  render();
});

clearBtn.addEventListener("click", () => {
  shapes = [];
  selectedId = null;
  added = 0;
  sync();
  render();
});

// Arrow keys move the selection, which is the one thing on this page a pointer
// can do and a keyboard otherwise cannot. Skipped while a field has focus, so
// an arrow inside a slider still belongs to the slider.
document.addEventListener("keydown", (evt) => {
  const shape = selected();
  if (!shape || evt.metaKey || evt.ctrlKey || evt.altKey) return;
  const tag = document.activeElement ? document.activeElement.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (evt.key === "Delete" || evt.key === "Backspace") {
    evt.preventDefault();
    removeBtn.click();
    return;
  }
  const step = evt.shiftKey ? 20 : 4;
  const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[evt.key];
  if (!move) return;
  evt.preventDefault();
  shape.x = clamp(shape.x + move[0], 0, VIEW_W);
  shape.y = clamp(shape.y + move[1], 0, VIEW_H);
  render();
});

function exportSvg() {
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${buildSvg(false)}\n`], {
    type: "image/svg+xml",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "overprint.svg";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener("click", exportSvg);

// The sheet starts with the demonstration on it rather than empty: three
// circles is what the tool is for, and a reader who has seen it once knows what
// every other control does.
for (let i = 0; i < 3; i++) add("circle");
