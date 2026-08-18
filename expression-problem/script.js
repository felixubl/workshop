/* Expression Problem Bench — objects and functions as two ways of boxing one grid.
 *
 * THE CLAIM, and the reason the tool is shaped the way it is. A program that
 * handles several cases and does several things with each of them is a grid:
 * cases down the side, operations along the top, one expression per cell. What
 * a language chooses is not what goes in the cells — it is where the boxes go.
 * Objects box the rows: a class per case, holding every operation on it.
 * Functions box the columns: a function per operation, matching on every case.
 * Same cells, same answers, and each arrangement is cheap to extend in exactly
 * the direction the other is dear. That is Wadler's expression problem, and it
 * is the honest relationship between the two styles — not that one is better,
 * but that they are duals across the same table.
 *
 * WHY THE CELLS ARE THE MODEL. Everything on the page is derived from one
 * object of expressions: the board, both assemblies, both walks and the
 * results. Nothing is written out twice, so "only the boxes moved" is a fact
 * about the code rather than a claim in a caption.
 *
 * WHY ONE CELL SERVES BOTH. A cell is an expression over the row's own field
 * names — `math.pi * r * r`, not `self.r` and not `shape["r"]`. The class binds
 * those names off `self` and the match binds them in its pattern, and the
 * expression between never learns which happened.
 *
 * THE WALK IS THE POINT OF THE SECOND HALF. Both arrangements reach the same
 * answer, and saying so is worth nothing next to showing the two roads. So one
 * call is stepped through both: the class side looks the method up on the
 * value's own type in one hop, the function side scans its match arms in order
 * until one fits. Different lengths, different work, and the last step is
 * literally the same expression on both sides. That is where they meet.
 *
 * PYTHON IS READ, NOT FAKED. `python.js` is a small Python — a lexer, a Pratt
 * parser over the expression grammar, and an evaluator that keeps ints and
 * floats apart the way Python does. The same token stream colours the source,
 * so a thing painted as a number is a thing the evaluator read as a number.
 * `selftest.js` checks all of it against CPython's own answers.
 */
const board = document.getElementById("board");
const boardNote = document.getElementById("boardNote");
const costTable = document.getElementById("costTable");
const costMeta = document.getElementById("costMeta");
const listing = document.getElementById("listing");
const listingMeta = document.getElementById("listingMeta");
const runTable = document.getElementById("runTable");
const runNote = document.getElementById("runNote");
const agreement = document.getElementById("agreement");
const groupButtons = Array.from(document.querySelectorAll("[data-group]"));
const addVariantBtn = document.getElementById("addVariant");
const addOperationBtn = document.getElementById("addOperation");
const resetBtn = document.getElementById("reset");

const traceMeta = document.getElementById("traceMeta");
const traceStep = document.getElementById("traceStep");
const traceBack = document.getElementById("traceBack");
const traceNext = document.getElementById("traceNext");
const tracePlay = document.getElementById("tracePlay");
const traceSides = {
  type: {
    source: document.getElementById("traceTypeSrc"),
    say: document.getElementById("traceTypeSay"),
    cost: document.getElementById("traceTypeCost"),
  },
  operation: {
    source: document.getElementById("traceOpSrc"),
    say: document.getElementById("traceOpSay"),
    cost: document.getElementById("traceOpCost"),
  },
};
const traceJoin = document.getElementById("traceJoin");

// Past six of either the grid stops being readable at a glance, and a grid you
// cannot take in at a glance has stopped making the argument.
const MAX_SIDE = 6;
const PLAY_MS = 900;

/* ── the library ────────────────────────────────────────────────────────────
   Cases and operations the bench knows how to fill in, and the cells for every
   pair of them. The Add buttons take the next one off these lists so the grid
   is always a working program; past the end they add an empty row or column,
   which is the truer picture of what an addition costs anyway. */
const VARIANTS = [
  { id: "circle", cls: "Circle", fields: [["r", 2]] },
  { id: "square", cls: "Square", fields: [["a", 3]] },
  { id: "triangle", cls: "Triangle", fields: [["b", 4], ["h", 3]] },
  { id: "pentagon", cls: "Pentagon", fields: [["s", 2]] },
  { id: "ellipse", cls: "Ellipse", fields: [["a", 3], ["b", 2]] },
];

const OPERATIONS = ["area", "perimeter", "describe", "corners", "is_round"];

const LIBRARY = {
  circle: {
    area: "math.pi * r * r",
    perimeter: "2 * math.pi * r",
    describe: 'f"circle r={r}"',
    corners: "0",
    is_round: "True",
  },
  square: {
    area: "a * a",
    perimeter: "4 * a",
    describe: 'f"square a={a}"',
    corners: "4",
    is_round: "False",
  },
  triangle: {
    area: "b * h / 2",
    perimeter: "b + h + math.hypot(b, h)",
    describe: 'f"right triangle {b}×{h}"',
    corners: "3",
    is_round: "False",
  },
  pentagon: {
    area: "5 * s * s / (4 * math.tan(math.pi / 5))",
    perimeter: "5 * s",
    describe: 'f"pentagon s={s}"',
    corners: "5",
    is_round: "False",
  },
  ellipse: {
    area: "math.pi * a * b",
    perimeter: "math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))",
    describe: 'f"ellipse {a}×{b}"',
    corners: "0",
    is_round: "True",
  },
};

const START_VARIANTS = 3;
const START_OPERATIONS = 3;

let variants = [];
let operations = [];
let cells = {};
let grouping = "type";
// The cells the last press wrote. Kept until the next one, because the point of
// the highlight is how many places one change reached and a count that fades
// cannot be counted.
let touched = new Set();
let lastAction = null;
let made = 0;

let walk = null;
let step = 0;
let playing = null;

const key = (variantId, operationId) => `${variantId}|${operationId}`;
const names = (variant) => variant.fields.map((field) => field[0]);

function reset() {
  variants = VARIANTS.slice(0, START_VARIANTS).map(copyVariant);
  operations = OPERATIONS.slice(0, START_OPERATIONS).map((id) => ({ id: id }));
  cells = {};
  variants.forEach((variant) => {
    operations.forEach((operation) => {
      cells[key(variant.id, operation.id)] = (LIBRARY[variant.id] || {})[operation.id] || "";
    });
  });
  touched = new Set();
  lastAction = null;
  made = 0;
  walk = { variant: variants[0].id, operation: operations[0].id };
  rebuild();
}

function copyVariant(source) {
  return { id: source.id, cls: source.cls, fields: source.fields.map((field) => field.slice()) };
}

function newVariant(n) {
  return { id: `shape${n}`, cls: `Shape${n}`, fields: [["x", 1]] };
}

/* ── growing the grid ───────────────────────────────────────────────────── */
function addVariant() {
  if (variants.length >= MAX_SIDE) return;
  const known = VARIANTS[variants.length];
  // The counter only moves when a name has to be invented, so the generated
  // ones run shape1, shape2 rather than skipping past every known case first.
  const variant = known ? copyVariant(known) : newVariant(++made);
  variants.push(variant);
  touched = new Set();
  operations.forEach((operation) => {
    cells[key(variant.id, operation.id)] = (LIBRARY[variant.id] || {})[operation.id] || "";
    touched.add(key(variant.id, operation.id));
  });
  lastAction = { what: "case", name: variant.id };
  rebuild();
}

function addOperation() {
  if (operations.length >= MAX_SIDE) return;
  const known = OPERATIONS[operations.length];
  const operation = { id: known || `op${++made}` };
  operations.push(operation);
  touched = new Set();
  variants.forEach((variant) => {
    cells[key(variant.id, operation.id)] = (LIBRARY[variant.id] || {})[operation.id] || "";
    touched.add(key(variant.id, operation.id));
  });
  lastAction = { what: "operation", name: operation.id };
  rebuild();
}

/* ── the two assemblies ─────────────────────────────────────────────────────
   The only place in this file that knows Python's syntax. Both are built out of
   the same three moves — name the box, bind the row's fields, return the cell —
   and everything that differs between them is the scaffolding, which is the
   argument. */
const IMPORT = ["import math", ""];

function cellOf(variant, operation) {
  return cells[key(variant.id, operation.id)] || "";
}

function returnLine(variant, operation, indent) {
  const cell = cellOf(variant, operation);
  const pad = " ".repeat(indent);
  return cell ? `${pad}return ${cell}` : `${pad}return None  # not written yet`;
}

// `r = self.r` for one field, `b, h = self.b, self.h` for several. Python's own
// way of taking a handful of attributes into locals, and the line the cell
// underneath depends on without knowing it is there.
function bindFromSelf(variant, indent) {
  const list = names(variant);
  if (!list.length) return null;
  return `${" ".repeat(indent)}${list.join(", ")} = ${list.map((name) => `self.${name}`).join(", ")}`;
}

// The mapping pattern binds the same names, in the pattern itself rather than
// in a line of its own. That difference is the whole of what `match` buys.
function casePattern(variant, indent) {
  const parts = [`"kind": "${variant.id}"`].concat(
    names(variant).map((name) => `"${name}": ${name}`));
  return `${" ".repeat(indent)}case {${parts.join(", ")}}:`;
}

function classBlock(variant) {
  const list = names(variant);
  const out = [`class ${variant.cls}:`];
  out.push(`    def __init__(self${list.length ? ", " + list.join(", ") : ""}):`);
  if (list.length) list.forEach((name) => out.push(`        self.${name} = ${name}`));
  else out.push("        pass");
  operations.forEach((operation) => {
    out.push("");
    out.push(`    def ${operation.id}(self):`);
    const bind = bindFromSelf(variant, 8);
    if (bind) out.push(bind);
    out.push(returnLine(variant, operation, 8));
  });
  return out;
}

function functionBlock(operation) {
  const out = [`def ${operation.id}(shape):`];
  out.push("    match shape:");
  variants.forEach((variant) => {
    out.push(casePattern(variant, 8));
    out.push(returnLine(variant, operation, 12));
  });
  return out;
}

function assembleClasses() {
  const out = IMPORT.slice();
  variants.forEach((variant) => {
    out.push(...classBlock(variant), "");
  });
  return out.join("\n").replace(/\n+$/, "");
}

function assembleFunctions() {
  const out = IMPORT.slice();
  operations.forEach((operation) => {
    out.push(...functionBlock(operation), "");
  });
  return out.join("\n").replace(/\n+$/, "");
}

/* ── walking a call ─────────────────────────────────────────────────────────
   Each side returns its own small program and a list of steps over it. A step
   is a line to point at and a sentence about what just happened, and the last
   step of each is the same expression with the same names bound — which is the
   thing worth showing, and the reason the two lists are built separately rather
   than one being derived from the other. */
function bindings(variant) {
  const env = {};
  variant.fields.forEach((field) => { env[field[0]] = Py.int(field[1]); });
  return env;
}

function fieldList(variant) {
  return variant.fields.map((field) => `${field[0]} = ${field[1]}`).join(", ");
}

function evaluateCell(variant, operation) {
  const cell = cellOf(variant, operation);
  if (!cell) return { value: Py.none, error: null };
  try {
    return { value: Py.evaluate(cell, bindings(variant)), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function walkByType(variant, operation) {
  const lines = classBlock(variant);
  const list = names(variant);
  const args = variant.fields.map((field) => field[1]).join(", ");
  const methodAt = lines.indexOf(`    def ${operation.id}(self):`);
  const bindAt = list.length ? methodAt + 1 : -1;
  const returnAt = methodAt + (list.length ? 2 : 1);
  const outcome = evaluateCell(variant, operation);

  const steps = [
    {
      line: 0,
      say: `\`shape = ${variant.cls}(${args})\` — the value is built from a class, so it carries its type with it wherever it goes.`,
    },
    {
      line: methodAt,
      say: `\`shape.${operation.id}()\` — Python looks \`${operation.id}\` up on \`type(shape)\`, which is \`${variant.cls}\`. One hop, and no search: a class already holds its own methods.`,
    },
  ];
  if (bindAt >= 0) {
    steps.push({
      line: bindAt,
      say: `The method takes the fields off \`self\`: ${fieldList(variant)}.`,
    });
  }
  steps.push({
    line: returnAt,
    say: "And evaluates the cell.",
    final: true,
  });
  return { lines: lines, steps: steps, outcome: outcome };
}

function walkByOperation(variant, operation) {
  const lines = functionBlock(operation);
  const index = variants.indexOf(variant);
  const record = variants.length
    ? `{"kind": "${variant.id}"${variant.fields.map((f) => `, "${f[0]}": ${f[1]}`).join("")}}`
    : "{}";
  const outcome = evaluateCell(variant, operation);

  const steps = [
    {
      line: 0,
      say: `\`shape = ${record}\` — a plain record. It carries a tag, not a type, and knows nothing about \`${operation.id}\`.`,
    },
    {
      line: 1,
      say: `\`match shape:\` — the function was handed something and has to find out what.`,
    },
  ];
  variants.slice(0, index + 1).forEach((candidate, i) => {
    const at = 2 + i * 2;
    steps.push({
      line: at,
      say: i === index
        ? `\`case {"kind": "${candidate.id}", …}\` — this one fits, and the pattern binds the names as it matches: ${fieldList(variant)}.`
        : `\`case {"kind": "${candidate.id}", …}\` — the tag does not match. On to the next arm.`,
    });
  });
  steps.push({
    line: 3 + index * 2,
    say: "And evaluates the cell.",
    final: true,
  });
  return { lines: lines, steps: steps, outcome: outcome };
}

/* ── the board ──────────────────────────────────────────────────────────────
   Rebuilt only when the grid's shape changes. Typing in a cell must not rebuild
   it: the input under the hand would be replaced mid-keystroke and the rings
   would restart their transition on every character. */
function rebuild() {
  board.style.setProperty("--cols", String(operations.length));
  const parts = [];

  const corner = document.createElement("div");
  corner.className = "corner";
  parts.push(corner);

  operations.forEach((operation) => {
    const head = document.createElement("div");
    head.className = "colhead";
    head.dataset.op = operation.id;
    parts.push(head);
  });

  variants.forEach((variant) => {
    const head = document.createElement("div");
    head.className = "rowhead";
    head.dataset.variant = variant.id;
    parts.push(head);

    operations.forEach((operation) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.cell = key(variant.id, operation.id);
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.autocomplete = "off";
      input.value = cells[key(variant.id, operation.id)];
      input.placeholder = "not written";
      input.setAttribute("aria-label", `${operation.id} of a ${variant.id}`);
      input.addEventListener("input", () => {
        cells[key(variant.id, operation.id)] = input.value;
        touched = new Set();
        lastAction = null;
        refresh();
        paintCells();
      });
      // Focusing a cell is how the walk below is aimed. No extra control for
      // it: the thing you are looking at is the thing it walks.
      input.addEventListener("focus", () => {
        walk = { variant: variant.id, operation: operation.id };
        step = 0;
        stopPlaying();
        drawWalk();
      });
      cell.appendChild(input);
      parts.push(cell);
    });
  });

  const rings = document.createElement("div");
  rings.className = "rings";
  const ringCount = Math.max(variants.length, operations.length);
  for (let i = 0; i < ringCount; i++) {
    const ring = document.createElement("div");
    ring.className = "ring";
    rings.appendChild(ring);
  }
  parts.push(rings);

  board.replaceChildren(...parts);
  paintCells();
  refresh();
  // Straight away, and not on the next frame. Reading a box forces the layout
  // that has to happen first, so there is nothing to wait for — and a frame
  // that never comes leaves every ring a box of nothing at the origin, which
  // is what waiting for one actually bought.
  drawRings();
}

function paintCells() {
  variants.forEach((variant) => {
    operations.forEach((operation) => {
      const id = key(variant.id, operation.id);
      const cell = board.querySelector(`[data-cell="${id}"]`);
      if (!cell) return;
      cell.classList.toggle("is-touched", touched.has(id));
      cell.classList.toggle("is-empty", !cells[id]);
      cell.classList.toggle("is-walked", Boolean(walk) && walk.variant === variant.id && walk.operation === operation.id);
    });
  });
}

/* One box per group in the current arrangement, measured off the cells it
   holds. The pool is as long as the longer side and never resized between
   arrangements, so a box always has a box to become and the change of
   arrangement is one movement rather than a removal and an appearance. */
function drawRings() {
  const rings = Array.from(board.querySelectorAll(".ring"));
  const frame = board.getBoundingClientRect();
  const byType = grouping === "type";
  const groups = byType ? variants : operations;
  const outset = 6;

  rings.forEach((ring, index) => {
    const group = groups[index];
    if (!group) {
      ring.style.opacity = "0";
      return;
    }
    // The header goes inside the box, which is what makes the box read as a
    // declaration rather than as a lasso: `class Circle` sits at the head of its
    // own row, `area(shape)` at the head of its own column, and whichever one is
    // not boxed at the moment is simply a label outside.
    const head = byType
      ? board.querySelector(`[data-variant="${group.id}"]`)
      : board.querySelector(`[data-op="${group.id}"]`);
    const held = [head].concat((byType ? operations : variants).map((other) => {
      const id = byType ? key(group.id, other.id) : key(other.id, group.id);
      return board.querySelector(`[data-cell="${id}"]`);
    })).filter(Boolean);
    if (!held.length) {
      ring.style.opacity = "0";
      return;
    }

    const boxes = held.map((cell) => cell.getBoundingClientRect());
    const top = Math.min(...boxes.map((b) => b.top)) - frame.top - outset;
    const left = Math.min(...boxes.map((b) => b.left)) - frame.left - outset;
    const right = Math.max(...boxes.map((b) => b.right)) - frame.left + outset;
    const bottom = Math.max(...boxes.map((b) => b.bottom)) - frame.top + outset;

    ring.style.opacity = "1";
    ring.style.top = `${top}px`;
    ring.style.left = `${left}px`;
    ring.style.width = `${right - left}px`;
    ring.style.height = `${bottom - top}px`;
  });
}

/* ── everything derived ─────────────────────────────────────────────────── */
function refresh() {
  const byType = grouping === "type";

  board.querySelectorAll(".rowhead").forEach((head) => {
    const variant = variants.find((v) => v.id === head.dataset.variant);
    head.textContent = byType ? `class ${variant.cls}` : variant.id;
    head.classList.toggle("is-boxed", byType);
  });
  board.querySelectorAll(".colhead").forEach((head) => {
    const id = head.dataset.op;
    head.textContent = byType ? id : `${id}(shape)`;
    head.classList.toggle("is-boxed", !byType);
  });

  groupButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.group === grouping);
  });
  addVariantBtn.disabled = variants.length >= MAX_SIDE;
  addOperationBtn.disabled = operations.length >= MAX_SIDE;

  if (walk && (!variants.some((v) => v.id === walk.variant) || !operations.some((o) => o.id === walk.operation))) {
    walk = { variant: variants[0].id, operation: operations[0].id };
    step = 0;
  }

  drawNote();
  drawCost();
  drawListing();
  drawWalk();
  drawRun();
}

function drawNote() {
  if (!lastAction) {
    boardNote.textContent =
      `${variants.length} cases and ${operations.length} operations: ` +
      `${variants.length * operations.length} cells, and one box round every ` +
      `${grouping === "type" ? "row" : "column"}. ` +
      "Change the arrangement and watch what moves.";
    return;
  }
  const opened = lastAction.what === "case" ? operations.length : variants.length;
  const boxes = grouping === "type" ? "classes" : "functions";
  const oneBox = (lastAction.what === "case") === (grouping === "type");
  boardNote.textContent = oneBox
    ? `Added ${lastAction.name}: one new box, and not a line changed in any ` +
      `of the ${(grouping === "type" ? variants : operations).length - 1} already there. ` +
      "Now press the other arrangement without touching anything else."
    : `Added ${lastAction.name}: no new box, and every one of the ${opened} ${boxes} ` +
      "had to be opened. The marked cells are where the change landed.";
}

function drawCost() {
  const rows = [
    {
      change: "add a case",
      byType: "1 new class, 0 opened",
      byOperation: `0 new, ${operations.length} functions opened`,
    },
    {
      change: "add an operation",
      byType: `0 new, ${variants.length} classes opened`,
      byOperation: "1 new function, 0 opened",
    },
  ];
  const on = (which) => (grouping === which ? " class=\"is-on\"" : "");
  costTable.innerHTML =
    "<thead><tr><th>change</th>" +
    `<th${on("type")}>boxed by case</th>` +
    `<th${on("operation")}>boxed by operation</th></tr></thead><tbody>` +
    rows.map((row) =>
      `<tr><td>${row.change}</td>` +
      `<td${on("type")}>${row.byType}</td>` +
      `<td${on("operation")}>${row.byOperation}</td></tr>`
    ).join("") +
    "</tbody>";
  costMeta.textContent = `${variants.length} × ${operations.length}`;
}

// One span per line, so a walk can point at one of them. Painted line by line
// rather than in one pass, which is safe because nothing here spans a line.
// Joined with nothing: each span is already a block, and a newline between two
// blocks inside a <pre> is a second line break nobody asked for.
function paintLines(lines, current) {
  return lines.map((line, index) =>
    `<span class="ln${index === current ? " is-at" : ""}">${Py.paint(line) || "&nbsp;"}</span>`).join("");
}

function drawListing() {
  const source = grouping === "type" ? assembleClasses() : assembleFunctions();
  listing.innerHTML = Py.paint(source);
  listingMeta.textContent = grouping === "type"
    ? `${variants.length} classes`
    : `${operations.length} functions`;
}

/* ── the walk ───────────────────────────────────────────────────────────── */
function drawWalk() {
  if (!walk) return;
  const variant = variants.find((v) => v.id === walk.variant);
  const operation = operations.find((o) => o.id === walk.operation);
  if (!variant || !operation) return;

  const sides = {
    type: walkByType(variant, operation),
    operation: walkByOperation(variant, operation),
  };
  const total = Math.max(sides.type.steps.length, sides.operation.steps.length);
  step = Math.max(0, Math.min(step, total - 1));

  traceMeta.textContent = `${variant.id} · ${operation.id}`;
  traceStep.textContent = `${step + 1} / ${total}`;
  traceBack.disabled = step === 0;
  traceNext.disabled = step >= total - 1;

  Object.keys(sides).forEach((which) => {
    const side = sides[which];
    const at = Math.min(step, side.steps.length - 1);
    const done = step >= side.steps.length - 1;
    const target = traceSides[which];
    target.source.innerHTML = paintLines(side.lines, side.steps[at].line);
    target.say.innerHTML = mono(side.steps[at].say);
    target.say.classList.toggle("is-done", done);
    target.cost.textContent = `${side.steps.length} steps`;
  });

  // The two sides finish at the same expression with the same names bound, and
  // that is the only sentence on this page that had to be earned rather than
  // written: it is printed from the value both walks actually came back with.
  const bothDone = step >= total - 1;
  const outcome = sides.type.outcome;
  const cell = cellOf(variant, operation);
  if (!bothDone) {
    traceJoin.hidden = true;
    return;
  }
  traceJoin.hidden = false;
  if (outcome.error) {
    traceJoin.className = "trace-join is-broken";
    traceJoin.innerHTML = mono(`Both roads arrive at \`${cell}\` — and it will not read: ${outcome.error}`);
    return;
  }
  traceJoin.className = "trace-join";
  const bound = fieldList(variant);
  const tried = variants.indexOf(variant) + 1;
  const byType = sides.type.steps.length;
  const byOperation = sides.operation.steps.length;
  traceJoin.innerHTML = cell
    ? mono(
        `Both roads arrive at the same expression — \`${cell}\`${bound ? ` with ${bound}` : ""} — ` +
        `and both come back with \`${Py.show(outcome.value)}\`. ` +
        `By case: ${byType} steps, and it would be ${byType} for any case in the grid, because a class ` +
        `already holds its own methods. By operation: ${byOperation} steps, ` +
        (tried === 1
          ? "because this case is the first arm the match tries."
          : `because the match tried ${tried} arms before this one fitted.`))
    : mono("Both roads arrive at a cell nobody has written, and both come back with `None`.");
}

// Backticks in a step's sentence become code, which is the one bit of markup
// these strings are allowed. Everything else is escaped first.
function mono(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
}

function stopPlaying() {
  if (!playing) return;
  clearInterval(playing);
  playing = null;
  tracePlay.textContent = "Play";
}

function play() {
  if (playing) return stopPlaying();
  step = 0;
  drawWalk();
  tracePlay.textContent = "Stop";
  playing = setInterval(() => {
    const before = traceStep.textContent;
    step += 1;
    drawWalk();
    if (traceStep.textContent === before) stopPlaying();
  }, PLAY_MS);
}

/* ── running every cell ─────────────────────────────────────────────────────
   Both roads walked for every pair, and the answers compared. What that catches
   is not that two identical expressions are equal — they are — but that both
   dispatches landed on the SAME cell with the SAME names bound, which is the
   part a hand-written lookup gets wrong. */
function runAll() {
  const rows = [];
  let agreed = 0;
  let checked = 0;
  let broken = null;

  variants.forEach((variant) => {
    const results = operations.map((operation) => {
      const written = Boolean(cellOf(variant, operation));
      const byType = walkByType(variant, operation).outcome;
      const byOperation = walkByOperation(variant, operation).outcome;
      const same = byType.error || byOperation.error
        ? byType.error === byOperation.error
        : Py.same(byType.value, byOperation.value);
      if (written) {
        checked += 1;
        if (same) agreed += 1;
        if (byType.error && !broken) broken = `${variant.id} · ${operation.id}: ${byType.error}`;
      }
      return {
        same: same,
        shown: byType.error ? `!${byType.error}` : Py.show(byType.value),
        failed: Boolean(byType.error),
      };
    });
    rows.push({ variant: variant, results: results });
  });

  return { rows: rows, agreed: agreed, checked: checked, broken: broken };
}

function drawRun() {
  const result = runAll();

  agreement.className = result.broken ? "is-broken" : "";
  agreement.textContent = result.checked === 0
    ? "nothing written"
    : `${result.agreed} of ${result.checked} agree`;

  runTable.innerHTML =
    "<thead><tr><th>value</th>" +
    operations.map((operation) => `<th>${escapeHtml(operation.id)}</th>`).join("") +
    "</tr></thead><tbody>" +
    result.rows.map((row) => {
      const label = `${row.variant.cls}(${row.variant.fields.map((f) => f[1]).join(", ")})`;
      return `<tr><td>${escapeHtml(label)}</td>` +
        row.results.map((cell) =>
          `<td${cell.failed || !cell.same ? " class=\"is-broken\"" : ""}>${escapeHtml(cell.shown)}</td>`
        ).join("") +
        "</tr>";
    }).join("") +
    "</tbody>";

  runNote.className = result.broken ? "sheet-note is-broken" : "sheet-note";
  runNote.textContent = result.broken
    ? result.broken
    : result.checked === 0
      ? "Every cell is empty, so there is nothing to compare."
      : "One table, walked twice. Every value here was reached once through a " +
        "class and once through a match, and the two were compared before it " +
        "was printed. Python's own int and float rules are kept, which is why " +
        "an area can come back 6.0 where a corner count comes back 4.";
}

// `escape` is a global of its own, and shadowing a built-in in a file this
// small is the kind of thing that reads as a bug three months later.
function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
}

/* ── the controls ───────────────────────────────────────────────────────── */
groupButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (grouping === button.dataset.group) return;
    grouping = button.dataset.group;
    refresh();
    drawRings();
  });
});

addVariantBtn.addEventListener("click", addVariant);
addOperationBtn.addEventListener("click", addOperation);
resetBtn.addEventListener("click", reset);

traceBack.addEventListener("click", () => { stopPlaying(); step -= 1; drawWalk(); });
traceNext.addEventListener("click", () => { stopPlaying(); step += 1; drawWalk(); });
tracePlay.addEventListener("click", play);

// The rings are pixel measurements, so anything that reflows the board makes
// them wrong. A resize is the only such thing the page does not already know
// about.
let queued = false;
addEventListener("resize", () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    drawRings();
  });
});

reset();
