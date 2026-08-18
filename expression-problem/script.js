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
 * object of expressions: the board, both assemblies, and the results. Nothing
 * is written out twice, so "only the boxes moved" is a fact about the code
 * rather than a claim in a caption — press the other arrangement and the same
 * strings come back out in a different scaffold.
 *
 * WHY IT ACTUALLY RUNS. A page that says two arrangements agree and does not
 * check is asking to be believed. Both assemblies are built with `new Function`
 * on the source printed on the page, the objects are constructed, the functions
 * are called on plain records, and every pair is compared with `Object.is`. The
 * agreement is a measurement.
 *
 * WHY ONE CELL SERVES BOTH. A cell is an expression over the row's own field
 * names — `Math.PI * r * r`, not `this.r` and not `shape.r`. Each assembly
 * binds those names first, off `this` on one side and off the argument on the
 * other, so the expression between them never learns which happened. That one
 * decision is what makes the grid a grid rather than two grids that resemble
 * each other.
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

// Past six of either the grid stops being readable at a glance, and a grid you
// cannot take in at a glance has stopped making the argument.
const MAX_SIDE = 6;

/* ── the library ────────────────────────────────────────────────────────────
   Cases and operations the bench knows how to fill in, and the cells for every
   pair of them. The Add buttons take the next one off these lists so the grid
   is always a working program; past the end they add an empty row or column,
   which is the truer picture of what an addition costs anyway. */
const VARIANTS = [
  { id: "circle", fields: [["r", 2]] },
  { id: "square", fields: [["a", 3]] },
  { id: "triangle", fields: [["b", 4], ["h", 3]] },
  { id: "pentagon", fields: [["s", 2]] },
  { id: "ellipse", fields: [["a", 3], ["b", 2]] },
];

const OPERATIONS = ["area", "perimeter", "describe", "corners", "isRound"];

const LIBRARY = {
  circle: {
    area: "Math.PI * r * r",
    perimeter: "2 * Math.PI * r",
    describe: "`circle r=${r}`",
    corners: "0",
    isRound: "true",
  },
  square: {
    area: "a * a",
    perimeter: "4 * a",
    describe: "`square a=${a}`",
    corners: "4",
    isRound: "false",
  },
  triangle: {
    area: "b * h / 2",
    perimeter: "b + h + Math.hypot(b, h)",
    describe: "`right triangle ${b}×${h}`",
    corners: "3",
    isRound: "false",
  },
  pentagon: {
    area: "5 * s * s / (4 * Math.tan(Math.PI / 5))",
    perimeter: "5 * s",
    describe: "`pentagon s=${s}`",
    corners: "5",
    isRound: "false",
  },
  ellipse: {
    area: "Math.PI * a * b",
    perimeter: "Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))",
    describe: "`ellipse ${a}×${b}`",
    corners: "0",
    isRound: "true",
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

const key = (variantId, operationId) => `${variantId}|${operationId}`;
const cap = (word) => word[0].toUpperCase() + word.slice(1);
const names = (variant) => variant.fields.map((field) => field[0]);

function reset() {
  variants = VARIANTS.slice(0, START_VARIANTS).map((v) => ({ id: v.id, fields: v.fields.map((f) => f.slice()) }));
  operations = OPERATIONS.slice(0, START_OPERATIONS).map((id) => ({ id: id }));
  cells = {};
  variants.forEach((v) => {
    operations.forEach((o) => {
      cells[key(v.id, o.id)] = (LIBRARY[v.id] || {})[o.id] || "";
    });
  });
  touched = new Set();
  lastAction = null;
  made = 0;
  rebuild();
}

/* ── growing the grid ───────────────────────────────────────────────────── */
function addVariant() {
  if (variants.length >= MAX_SIDE) return;
  const known = VARIANTS[variants.length];
  const variant = known
    ? { id: known.id, fields: known.fields.map((f) => f.slice()) }
    : { id: `shape${++made}`, fields: [["x", 1]] };
  variants.push(variant);
  touched = new Set();
  operations.forEach((o) => {
    cells[key(variant.id, o.id)] = (LIBRARY[variant.id] || {})[o.id] || "";
    touched.add(key(variant.id, o.id));
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
  variants.forEach((v) => {
    cells[key(v.id, operation.id)] = (LIBRARY[v.id] || {})[operation.id] || "";
    touched.add(key(v.id, operation.id));
  });
  lastAction = { what: "operation", name: operation.id };
  rebuild();
}

/* ── the two assemblies ─────────────────────────────────────────────────────
   The only two functions in this file that know anything about JavaScript's
   syntax, and they are deliberately the same length and the same shape: bind
   the row's fields, then return the cell. Everything that differs between them
   is the scaffolding, which is the argument. */
function returnLine(variant, operation, indent) {
  const cell = cells[key(variant.id, operation.id)];
  const pad = " ".repeat(indent);
  if (!cell) return `${pad}return undefined; // not written yet`;
  return `${pad}return ${cell};`;
}

function bindLine(variant, source, indent) {
  const list = names(variant);
  if (!list.length) return null;
  return `${" ".repeat(indent)}const { ${list.join(", ")} } = ${source};`;
}

function assembleClasses() {
  const out = [];
  variants.forEach((variant) => {
    const list = names(variant);
    out.push(`class ${cap(variant.id)} {`);
    out.push(`  constructor(${list.join(", ")}) {`);
    list.forEach((name) => out.push(`    this.${name} = ${name};`));
    out.push("  }");
    operations.forEach((operation) => {
      out.push(`  ${operation.id}() {`);
      const bind = bindLine(variant, "this", 4);
      if (bind) out.push(bind);
      out.push(returnLine(variant, operation, 4));
      out.push("  }");
    });
    out.push("}");
    out.push("");
  });
  return out.join("\n").trimEnd();
}

function assembleFunctions() {
  const out = [];
  operations.forEach((operation) => {
    out.push(`function ${operation.id}(shape) {`);
    out.push("  switch (shape.kind) {");
    variants.forEach((variant) => {
      out.push(`    case "${variant.id}": {`);
      const bind = bindLine(variant, "shape", 6);
      if (bind) out.push(bind);
      out.push(returnLine(variant, operation, 6));
      out.push("    }");
    });
    out.push("  }");
    out.push("}");
    out.push("");
  });
  return out.join("\n").trimEnd();
}

/* ── running both ───────────────────────────────────────────────────────────
   Built and called for real. A cell the reader is halfway through typing will
   not parse, and that is reported where the agreement is reported rather than
   swallowed: a bench that hides a syntax error is a bench that lies about what
   it just ran. */
function runBoth() {
  const classNames = variants.map((v) => cap(v.id));
  const functionNames = operations.map((o) => o.id);
  let built;
  try {
    built = {
      classes: new Function(`${assembleClasses()}\nreturn { ${classNames.join(", ")} };`)(),
      functions: new Function(`${assembleFunctions()}\nreturn { ${functionNames.join(", ")} };`)(),
    };
  } catch (error) {
    return { error: error.message, rows: [], agreed: 0, checked: 0 };
  }

  const rows = [];
  let agreed = 0;
  let checked = 0;

  variants.forEach((variant) => {
    const values = variant.fields.map((field) => field[1]);
    const record = { kind: variant.id };
    variant.fields.forEach((field) => { record[field[0]] = field[1]; });

    let instance;
    try {
      instance = new built.classes[cap(variant.id)](...values);
    } catch (error) {
      rows.push({ variant: variant, failed: error.message, results: [] });
      return;
    }

    const results = operations.map((operation) => {
      const written = Boolean(cells[key(variant.id, operation.id)]);
      const fromObject = call(() => instance[operation.id]());
      const fromFunction = call(() => built.functions[operation.id](record));
      const same = fromObject.threw || fromFunction.threw
        ? fromObject.value === fromFunction.value
        : Object.is(fromObject.value, fromFunction.value);
      if (written) {
        checked += 1;
        if (same) agreed += 1;
      }
      return { written: written, same: same, shown: show(fromObject), threw: fromObject.threw };
    });

    rows.push({ variant: variant, results: results });
  });

  return { error: null, rows: rows, agreed: agreed, checked: checked };
}

function call(thunk) {
  try {
    return { value: thunk(), threw: false };
  } catch (error) {
    return { value: error.message, threw: true };
  }
}

function show(result) {
  if (result.threw) return `threw: ${result.value}`;
  const value = result.value;
  if (value === undefined) return "—";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return String(Math.round(value * 1000) / 1000);
  }
  return String(value);
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
      cell.appendChild(input);
      parts.push(cell);
    });
  });

  const rings = document.createElement("div");
  rings.className = "rings";
  rings.id = "rings";
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
    const id = head.dataset.variant;
    head.textContent = byType ? `class ${cap(id)}` : id;
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

  drawNote();
  drawCost();
  drawListing();
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

function drawListing() {
  listing.textContent = grouping === "type" ? assembleClasses() : assembleFunctions();
  listingMeta.textContent = grouping === "type"
    ? `${variants.length} classes`
    : `${operations.length} functions`;
}

function drawRun() {
  const result = runBoth();

  if (result.error) {
    agreement.textContent = "will not parse";
    agreement.className = "is-broken";
    runTable.innerHTML = "";
    runNote.textContent = result.error;
    runNote.className = "sheet-note is-broken";
    return;
  }

  agreement.className = "";
  runNote.className = "sheet-note";
  agreement.textContent = result.checked === 0
    ? "nothing written"
    : `${result.agreed} of ${result.checked} agree`;

  runTable.innerHTML =
    "<thead><tr><th>value</th>" +
    operations.map((operation) => `<th>${operation.id}</th>`).join("") +
    "</tr></thead><tbody>" +
    result.rows.map((row) => {
      const label = `${row.variant.id}(${row.variant.fields.map((f) => f[1]).join(", ")})`;
      if (row.failed) {
        return `<tr><td>${label}</td><td colspan="${operations.length}" class="is-broken">${row.failed}</td></tr>`;
      }
      return `<tr><td>${label}</td>` +
        row.results.map((cell) =>
          `<td${cell.same ? "" : " class=\"is-broken\""}>${escapeHtml(cell.shown)}</td>`
        ).join("") +
        "</tr>";
    }).join("") +
    "</tbody>";

  runNote.textContent = result.checked === 0
    ? "Every cell is empty, so there is nothing to compare."
    : "One table, from two programs. Each number was produced twice — once by " +
      "calling a method on an object, once by calling a function on a plain " +
      "record — and the two were compared before it was printed.";
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
