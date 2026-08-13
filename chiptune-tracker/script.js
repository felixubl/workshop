/* Chiptune Tracker: the page. The grid, the keyboard, the instrument bench and
   the transport. It edits the song object from song.js and hands it to apu.js
   to hear; it computes nothing about sound itself. */

const grid = document.getElementById("grid");
const gridBody = document.getElementById("gridBody");
const patName = document.getElementById("patName");
const cursorNote = document.getElementById("cursorNote");
const orderList = document.getElementById("orderList");
const orderAdd = document.getElementById("orderAdd");
const orderDel = document.getElementById("orderDel");
const patAtInput = document.getElementById("patAt");
const patNewBtn = document.getElementById("patNew");
const patCloneBtn = document.getElementById("patClone");
const rowsInput = document.getElementById("rows");
const speedInput = document.getElementById("speed");
const bpmOut = document.getElementById("bpm");
const octaveInput = document.getElementById("octave");
const stepInput = document.getElementById("step");
const playBtn = document.getElementById("play");
const playLabel = document.getElementById("playLabel");
const stopBtn = document.getElementById("stop");
const followToggle = document.getElementById("follow");
const previewToggle = document.getElementById("preview");
const instList = document.getElementById("instList");
const instName = document.getElementById("instName");
const instNewBtn = document.getElementById("instNew");
const instDupBtn = document.getElementById("instDup");
const instDelBtn = document.getElementById("instDel");
const instTryBtn = document.getElementById("instTry");
const dutyPresets = document.getElementById("dutyPresets");
const seqs = document.getElementById("seqs");
const titleInput = document.getElementById("title");
const loopsInput = document.getElementById("loops");
const exportBtn = document.getElementById("export");
const saveBtn = document.getElementById("save");
const loadInput = document.getElementById("load");
const demoBtn = document.getElementById("demo");
const clearBtn = document.getElementById("clear");
const hint = document.getElementById("hint");
const fxTable = document.getElementById("fxTable");

const STORE = "workshop-chiptune";

/* Five stops per channel: the note, two digits of instrument, one of volume,
   the effect letter and two digits of its parameter. The effect is split from
   its parameter because otherwise B and D would be ambiguous — both name an
   effect and are hex digits. */
const F_NOTE = 0, F_INST = 1, F_VOL = 2, F_FX = 3, F_PARAM = 4;
const FIELDS = 5;

let song = null;
let cursor = { at: 0, row: 0, ch: 0, field: F_NOTE };
let instrument = 0;
let cellEls = [];
let rowEls = [];

/* ── The song, and keeping it ─────────────────────────────────────────────── */

function boot() {
  let stored = null;
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) stored = Song.deserialise(JSON.parse(raw));
  } catch (e) {
    stored = null;
  }
  song = stored || Song.demoSong();
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try {
      localStorage.setItem(STORE, JSON.stringify(Song.serialise(song)));
    } catch (e) {
      /* A full or blocked store costs the autosave and nothing else. The Save
         button writes a real file and does not depend on this. */
    }
  }, 700);
}

/* ── Undo ─────────────────────────────────────────────────────────────────── */

const undoStack = [];
const redoStack = [];
const UNDO_DEPTH = 50;

function pushUndo() {
  undoStack.push(Song.serialise(song));
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  redoStack.length = 0;
}

function restore(from, to) {
  if (!from.length) return;
  to.push(Song.serialise(song));
  song = Song.deserialise(from.pop());
  if (instrument >= song.instruments.length) instrument = song.instruments.length - 1;
  if (cursor.at >= song.order.length) cursor.at = song.order.length - 1;
  clampCursor();
  drawAll();
  touch();
}

/* ── Reading the song at the cursor ───────────────────────────────────────── */

function currentPattern() {
  return song.patterns[song.order[cursor.at]] || song.patterns[0];
}

function cellAt(row, ch) {
  return currentPattern().data[row * 4 + ch];
}

function cellFor(row, ch) {
  const pat = currentPattern();
  const i = row * 4 + ch;
  if (!pat.data[i]) pat.data[i] = Song.emptyCell();
  return pat.data[i];
}

function tidyCell(row, ch) {
  const pat = currentPattern();
  const i = row * 4 + ch;
  if (Song.cellIsEmpty(pat.data[i])) pat.data[i] = null;
}

function clampCursor() {
  cursor.at = Math.max(0, Math.min(cursor.at, song.order.length - 1));
  cursor.row = Math.max(0, Math.min(cursor.row, currentPattern().rows - 1));
  cursor.ch = Math.max(0, Math.min(cursor.ch, 3));
  cursor.field = Math.max(0, Math.min(cursor.field, FIELDS - 1));
}

/* ── Drawing the pattern ──────────────────────────────────────────────────── */

const HEX = "0123456789ABCDEF";

function noteText(c) {
  if (!c || c.n === APU.NOTE_NONE) return "···";
  if (c.n === APU.NOTE_OFF) return "OFF";
  return APU.noteName(c.n);
}

function instText(c) {
  if (!c || c.i < 0) return "··";
  return HEX[(c.i >> 4) & 15] + HEX[c.i & 15];
}

function volText(c) {
  if (!c || c.v < 0) return "·";
  return HEX[c.v & 15];
}

function fxText(c) {
  return c && c.fx ? c.fx : "·";
}

function paramText(c) {
  if (!c || !c.fx) return "··";
  return HEX[(c.fp >> 4) & 15] + HEX[c.fp & 15];
}

const FIELD_TEXT = [noteText, instText, volText, fxText, paramText];
const FIELD_CLASS = ["fn", "fi", "fv", "fx", "fp"];

function buildGrid() {
  const pat = currentPattern();
  gridBody.textContent = "";
  cellEls = [];
  rowEls = [];

  const frag = document.createDocumentFragment();
  for (let row = 0; row < pat.rows; row++) {
    const tr = document.createElement("div");
    tr.className = "tr";
    if (row % (song.highlight * 4) === 0) tr.classList.add("is-bar");
    else if (row % song.highlight === 0) tr.classList.add("is-beat");

    const rn = document.createElement("span");
    rn.className = "rn";
    rn.textContent = HEX[(row >> 4) & 15] + HEX[row & 15];
    tr.appendChild(rn);

    const rowFields = [];
    for (let ch = 0; ch < 4; ch++) {
      const tc = document.createElement("span");
      tc.className = "tc";
      const fields = [];
      for (let f = 0; f < FIELDS; f++) {
        const el = document.createElement("span");
        el.className = "f " + FIELD_CLASS[f];
        el.dataset.row = row;
        el.dataset.ch = ch;
        el.dataset.field = f;
        tc.appendChild(el);
        fields.push(el);
      }
      rowFields.push(fields);
      tr.appendChild(tc);
    }
    cellEls.push(rowFields);
    rowEls.push(tr);
    frag.appendChild(tr);
  }
  gridBody.appendChild(frag);

  for (let row = 0; row < pat.rows; row++) {
    for (let ch = 0; ch < 4; ch++) paintCell(row, ch);
  }
  patName.textContent = HEX[(song.order[cursor.at] >> 4) & 15] + HEX[song.order[cursor.at] & 15];
  drawCursor();
}

function paintCell(row, ch) {
  const c = cellAt(row, ch);
  const fields = cellEls[row] && cellEls[row][ch];
  if (!fields) return;
  for (let f = 0; f < FIELDS; f++) {
    fields[f].textContent = FIELD_TEXT[f](c);
    fields[f].classList.toggle("is-set", FIELD_TEXT[f](c).indexOf("·") < 0);
  }
}

let cursorEl = null;
function drawCursor() {
  if (cursorEl) cursorEl.classList.remove("is-cursor");
  const fields = cellEls[cursor.row] && cellEls[cursor.row][cursor.ch];
  cursorEl = fields ? fields[cursor.field] : null;
  if (cursorEl) {
    cursorEl.classList.add("is-cursor");
    if (document.activeElement === grid) scrollCursorIntoView();
  }
  describeCursor();
}

/* The column heads are sticky, so the first rows of the scroll box are behind
   them and "visible" starts below. Two rows of margin at each end, because a
   cursor pinned to the edge of the box gives no sight of what it is moving
   into. */
function scrollCursorIntoView() {
  const tr = rowEls[cursor.row];
  if (!tr) return;
  const head = grid.querySelector(".grid-head");
  const headH = head ? head.offsetHeight : 0;
  const h = tr.offsetHeight;
  const top = tr.offsetTop - grid.scrollTop;
  if (top < headH + h * 2) grid.scrollTop = tr.offsetTop - headH - h * 2;
  else if (top + h > grid.clientHeight - h * 2) grid.scrollTop = tr.offsetTop + h * 3 - grid.clientHeight;
}

/* What the note under the cursor actually comes out as. The chip divides one
   clock down to a period, so the pitch is whatever that integer gives, and at
   the top of the range the gap is wide enough to hear. */
function describeCursor() {
  const c = cellAt(cursor.row, cursor.ch);
  if (!c || c.n < 0) {
    cursorNote.textContent = APU.CHANNEL_NAMES[cursor.ch].toLowerCase() + " · row " + cursor.row;
    return;
  }
  if (cursor.ch === APU.NOISE) {
    const idx = APU.noisePeriodIndex(c.n);
    cursorNote.textContent = "noise period " + idx + " · " + APU.NOISE_PERIODS[idx] + " cycles per shift";
    return;
  }
  const period = APU.periodFor(c.n, cursor.ch);
  const hz = APU.periodHz(period, cursor.ch);
  const cents = APU.centsOff(c.n, cursor.ch);
  cursorNote.textContent =
    APU.noteName(c.n) + " · period " + period + " · " + hz.toFixed(1) + " Hz · " +
    (cents >= 0 ? "+" : "") + cents.toFixed(1) + " cents";
}

/* ── Editing ──────────────────────────────────────────────────────────────── */

function setCursor(row, ch, field) {
  cursor.row = row;
  cursor.ch = ch;
  cursor.field = field;
  clampCursor();
  drawCursor();
}

function moveRow(by) {
  const rows = currentPattern().rows;
  let row = cursor.row + by;
  while (row < 0) row += rows;
  cursor.row = row % rows;
  drawCursor();
}

function moveField(by) {
  let n = cursor.ch * FIELDS + cursor.field + by;
  const total = 4 * FIELDS;
  while (n < 0) n += total;
  n %= total;
  cursor.ch = Math.floor(n / FIELDS);
  cursor.field = n % FIELDS;
  drawCursor();
}

/* The step drops the cursor after a note and after nothing else. Trackers
   usually advance on every keystroke, which works when each hex digit has a
   cursor stop of its own; here a two-digit column takes two keystrokes in one
   place, and advancing between them would scatter one number across two rows.
   The effect letter hops right to its parameter instead, so 4, 3, 6 types the
   vibrato it looks like it should. */
function afterEntry() {
  const step = Math.max(0, Math.min(16, Number(stepInput.value) || 0));
  if (step) moveRow(step);
  else drawCursor();
}

function writeNote(note) {
  pushUndo();
  const c = cellFor(cursor.row, cursor.ch);
  c.n = note;
  /* The instrument column is written with every note, as trackers do, and the
     volume column is left alone: a channel carries the last volume it was
     given, so filling it in on every row would only be noise. */
  if (note >= 0) c.i = instrument;
  tidyCell(cursor.row, cursor.ch);
  paintCell(cursor.row, cursor.ch);
  if (note >= 0) previewNote(note);
  afterEntry();
  touch();
}

/* Two-digit columns take digits from the right, so typing 0 then 3 leaves 03
   and typing 3 alone leaves 03 as well. It is the behaviour of every tracker
   and the reason nobody has to type leading zeroes. */
function pushHex(value, digit, width) {
  const mask = width === 2 ? 0xff : 0xf;
  return ((value << 4) | digit) & mask;
}

function writeDigit(digit) {
  pushUndo();
  const c = cellFor(cursor.row, cursor.ch);
  if (cursor.field === F_INST) {
    c.i = Math.min(song.instruments.length - 1, pushHex(Math.max(0, c.i), digit, 2));
  } else if (cursor.field === F_VOL) {
    c.v = digit;
  } else if (cursor.field === F_PARAM) {
    if (!c.fx) c.fx = "0";
    c.fp = pushHex(c.fp, digit, 2);
  }
  tidyCell(cursor.row, cursor.ch);
  paintCell(cursor.row, cursor.ch);
  drawCursor();
  touch();
}

function writeEffect(letter) {
  pushUndo();
  const c = cellFor(cursor.row, cursor.ch);
  c.fx = letter;
  tidyCell(cursor.row, cursor.ch);
  paintCell(cursor.row, cursor.ch);
  cursor.field = F_PARAM;
  drawCursor();
  touch();
}

function clearField() {
  pushUndo();
  const c = cellAt(cursor.row, cursor.ch);
  if (c) {
    if (cursor.field === F_NOTE) { c.n = APU.NOTE_NONE; c.i = -1; c.v = -1; }
    else if (cursor.field === F_INST) c.i = -1;
    else if (cursor.field === F_VOL) c.v = -1;
    else { c.fx = ""; c.fp = 0; }
    tidyCell(cursor.row, cursor.ch);
    paintCell(cursor.row, cursor.ch);
  }
  touch();
}

/* ── The keyboard ─────────────────────────────────────────────────────────── */

/* Two rows of the typing keyboard laid out as an octave each, the way every
   tracker since Amiga days has done it. The digits do double duty: piano keys
   in the note column, hex everywhere else. */
const PIANO = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
  ",": 12, l: 13, ".": 14, ";": 15, "/": 16,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23,
  i: 24, 9: 25, o: 26, 0: 27, p: 28,
};

function octave() {
  return Math.max(0, Math.min(7, Number(octaveInput.value) || 0));
}

grid.addEventListener("keydown", function (ev) {
  const key = ev.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  if ((ev.ctrlKey || ev.metaKey) && lower === "z") {
    ev.preventDefault();
    if (ev.shiftKey) restore(redoStack, undoStack);
    else restore(undoStack, redoStack);
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

  switch (key) {
    case "ArrowUp": ev.preventDefault(); moveRow(-1); return;
    case "ArrowDown": ev.preventDefault(); moveRow(1); return;
    case "ArrowLeft": ev.preventDefault(); moveField(-1); return;
    case "ArrowRight": ev.preventDefault(); moveField(1); return;
    case "Tab":
      ev.preventDefault();
      cursor.ch = (cursor.ch + (ev.shiftKey ? 3 : 1)) % 4;
      cursor.field = F_NOTE;
      drawCursor();
      return;
    case "PageUp": ev.preventDefault(); moveRow(-16); return;
    case "PageDown": ev.preventDefault(); moveRow(16); return;
    case "Home": ev.preventDefault(); cursor.row = 0; drawCursor(); return;
    case "End": ev.preventDefault(); cursor.row = currentPattern().rows - 1; drawCursor(); return;
    case "Delete": ev.preventDefault(); clearField(); return;
    case "Backspace": ev.preventDefault(); moveRow(-1); clearField(); return;
    case " ": ev.preventDefault(); playing ? stopPlaying() : startPlaying(cursor.at, 0); return;
    case "Enter": ev.preventDefault(); startPlaying(cursor.at, cursor.row); return;
    case "Escape": ev.preventDefault(); stopPlaying(); return;
  }

  if (lower === "[") { ev.preventDefault(); octaveInput.value = Math.max(0, octave() - 1); return; }
  if (lower === "]") { ev.preventDefault(); octaveInput.value = Math.min(7, octave() + 1); return; }

  if (cursor.field === F_NOTE) {
    if (key === "-" || key === "_") { ev.preventDefault(); writeNote(APU.NOTE_OFF); return; }
    if (Object.prototype.hasOwnProperty.call(PIANO, lower)) {
      ev.preventDefault();
      const note = (octave() + 1) * 12 + PIANO[lower];
      if (note >= APU.NOTE_MIN && note <= APU.NOTE_MAX) writeNote(note);
      return;
    }
    return;
  }

  if (cursor.field === F_FX) {
    const up = key.toUpperCase();
    if (Song.EFFECTS[up]) { ev.preventDefault(); writeEffect(up); }
    else if (key === ".") { ev.preventDefault(); clearField(); }
    return;
  }

  const digit = HEX.indexOf(key.toUpperCase());
  if (digit >= 0) { ev.preventDefault(); writeDigit(digit); }
});

grid.addEventListener("pointerdown", function (ev) {
  const el = ev.target.closest(".f");
  if (!el) return;
  grid.focus();
  setCursor(Number(el.dataset.row), Number(el.dataset.ch), Number(el.dataset.field));
});

/* Space anywhere that is not a control starts and stops the song, because the
   transport is the one thing wanted while looking at something else. */
document.addEventListener("keydown", function (ev) {
  if (ev.key !== " " || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  if (t === grid || t.closest("input, select, textarea, button, label, .grid")) return;
  ev.preventDefault();
  playing ? stopPlaying() : startPlaying(cursor.at, 0);
});

/* ── The order ────────────────────────────────────────────────────────────── */

function drawOrder() {
  orderList.textContent = "";
  song.order.forEach(function (pat, i) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "order-row" + (i === cursor.at ? " is-current" : "");
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === cursor.at ? "true" : "false");
    b.innerHTML =
      '<code class="oi">' + HEX[(i >> 4) & 15] + HEX[i & 15] + "</code>" +
      '<code class="op">' + HEX[(pat >> 4) & 15] + HEX[pat & 15] + "</code>";
    b.addEventListener("click", function () {
      cursor.at = i;
      cursor.row = Math.min(cursor.row, currentPattern().rows - 1);
      drawOrder();
      drawPatternControls();
      buildGrid();
    });
    orderList.appendChild(b);
  });
  const playingRow = orderList.children[playOrder];
  if (playing && playingRow) playingRow.classList.add("is-playing");
}

function drawPatternControls() {
  patAtInput.value = song.order[cursor.at];
  patAtInput.max = Song.MAX_PATTERNS - 1;
  rowsInput.value = currentPattern().rows;
}

orderAdd.addEventListener("click", function () {
  if (song.order.length >= Song.MAX_ORDER) return say("The order holds " + Song.MAX_ORDER + " positions.");
  pushUndo();
  song.order.splice(cursor.at + 1, 0, song.order[cursor.at]);
  cursor.at++;
  drawOrder();
  drawPatternControls();
  buildGrid();
  touch();
});

orderDel.addEventListener("click", function () {
  if (song.order.length <= 1) return say("A song needs one position in the order.");
  pushUndo();
  song.order.splice(cursor.at, 1);
  cursor.at = Math.min(cursor.at, song.order.length - 1);
  clampCursor();
  drawOrder();
  drawPatternControls();
  buildGrid();
  touch();
});

patAtInput.addEventListener("change", function () {
  const want = Math.max(0, Math.min(Song.MAX_PATTERNS - 1, Number(patAtInput.value) || 0));
  pushUndo();
  while (song.patterns.length <= want) song.patterns.push(Song.makePattern(currentPattern().rows));
  song.order[cursor.at] = want;
  clampCursor();
  drawOrder();
  drawPatternControls();
  buildGrid();
  touch();
});

patNewBtn.addEventListener("click", function () {
  if (song.patterns.length >= Song.MAX_PATTERNS) return say("There are " + Song.MAX_PATTERNS + " patterns, which is all of them.");
  pushUndo();
  song.patterns.push(Song.makePattern(currentPattern().rows));
  song.order[cursor.at] = song.patterns.length - 1;
  clampCursor();
  drawOrder();
  drawPatternControls();
  buildGrid();
  touch();
});

patCloneBtn.addEventListener("click", function () {
  if (song.patterns.length >= Song.MAX_PATTERNS) return say("There are " + Song.MAX_PATTERNS + " patterns, which is all of them.");
  pushUndo();
  const from = currentPattern();
  const copy = Song.makePattern(from.rows);
  for (let i = 0; i < from.data.length; i++) {
    copy.data[i] = from.data[i] ? Object.assign({}, from.data[i]) : null;
  }
  song.patterns.push(copy);
  song.order[cursor.at] = song.patterns.length - 1;
  drawOrder();
  drawPatternControls();
  buildGrid();
  touch();
});

rowsInput.addEventListener("change", function () {
  const want = Math.max(Song.MIN_ROWS, Math.min(Song.MAX_ROWS, Number(rowsInput.value) || 64));
  const pat = currentPattern();
  if (want === pat.rows) return;
  pushUndo();
  const data = new Array(want * 4).fill(null);
  for (let i = 0; i < Math.min(want, pat.rows) * 4; i++) data[i] = pat.data[i];
  pat.rows = want;
  pat.data = data;
  clampCursor();
  buildGrid();
  touch();
});

/* ── Instruments ──────────────────────────────────────────────────────────── */

const SEQ_SPECS = [
  { key: "vol", label: "Volume", min: 0, max: 15, tip: "0 to 15, one value per frame. On the triangle only the difference between zero and everything else is heard." },
  { key: "arp", label: "Arpeggio", min: -24, max: 24, tip: "Semitones added to the note, one per frame. On the noise channel this is what steps through the sixteen periods, one per semitone." },
  { key: "pitch", label: "Pitch", min: -16, max: 16, tip: "Added to the timer period every frame, and it accumulates. Positive falls, because a longer period is a lower note. The noise channel has no timer, so it ignores this — use the arpeggio for a noise sweep." },
  { key: "duty_", label: "Duty", min: 0, max: 3, tip: "Switches the pulse waveform per frame. Two or three values here are the difference between a pluck and an organ." },
];

function currentInstrument() {
  return song.instruments[instrument] || song.instruments[0];
}

function drawInstruments() {
  instList.textContent = "";
  song.instruments.forEach(function (ins, i) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "inst-row" + (i === instrument ? " is-current" : "");
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === instrument ? "true" : "false");
    b.innerHTML =
      '<code class="oi">' + HEX[(i >> 4) & 15] + HEX[i & 15] + "</code>" +
      '<span class="inm"></span>';
    b.querySelector(".inm").textContent = ins.name;
    b.addEventListener("click", function () {
      instrument = i;
      drawInstruments();
      drawInstrumentEditor();
    });
    instList.appendChild(b);
  });
}

function drawInstrumentEditor() {
  const ins = currentInstrument();
  if (!ins) return;
  instName.value = ins.name;
  for (const b of dutyPresets.querySelectorAll("[data-duty]")) {
    b.classList.toggle("is-active", Number(b.dataset.duty) === ins.duty);
  }
  for (const ed of seqEditors) ed.draw();
}

instName.addEventListener("input", function () {
  currentInstrument().name = instName.value;
  const row = instList.children[instrument];
  if (row) row.querySelector(".inm").textContent = instName.value;
  saveSoon();
});

dutyPresets.addEventListener("click", function (ev) {
  const b = ev.target.closest("[data-duty]");
  if (!b) return;
  pushUndo();
  currentInstrument().duty = Number(b.dataset.duty);
  drawInstrumentEditor();
  touch();
});

instNewBtn.addEventListener("click", function () {
  if (song.instruments.length >= Song.MAX_INSTRUMENTS) return say("There are " + Song.MAX_INSTRUMENTS + " instruments, which is all of them.");
  pushUndo();
  song.instruments.push(Song.makeInstrument("instrument " + song.instruments.length));
  instrument = song.instruments.length - 1;
  drawInstruments();
  drawInstrumentEditor();
  touch();
});

instDupBtn.addEventListener("click", function () {
  if (song.instruments.length >= Song.MAX_INSTRUMENTS) return say("There are " + Song.MAX_INSTRUMENTS + " instruments, which is all of them.");
  pushUndo();
  const from = currentInstrument();
  const copy = Song.makeInstrument(from.name + " copy");
  copy.duty = from.duty;
  for (const spec of SEQ_SPECS) {
    copy[spec.key] = Song.makeSequence(from[spec.key].data, from[spec.key].loop);
  }
  song.instruments.push(copy);
  instrument = song.instruments.length - 1;
  drawInstruments();
  drawInstrumentEditor();
  touch();
});

instDelBtn.addEventListener("click", function () {
  if (song.instruments.length <= 1) return say("A song needs one instrument.");
  pushUndo();
  song.instruments.splice(instrument, 1);
  /* Every cell pointing past the gap has to move down with it, or a pattern
     would quietly start playing the instrument next door. */
  for (const pat of song.patterns) {
    for (const c of pat.data) {
      if (!c || c.i < 0) continue;
      if (c.i === instrument) c.i = -1;
      else if (c.i > instrument) c.i--;
    }
  }
  instrument = Math.min(instrument, song.instruments.length - 1);
  drawInstruments();
  drawInstrumentEditor();
  buildGrid();
  touch();
});

instTryBtn.addEventListener("click", function () {
  const c = cellAt(cursor.row, cursor.ch);
  previewNote(c && c.n >= 0 ? c.n : (octave() + 1) * 12, true);
});

/* ── Sequence editors ─────────────────────────────────────────────────────────

   A canvas each, because a sequence is drawn by dragging across it and 64
   draggable elements per sequence would be four times the DOM of the pattern
   grid for something that is one shape. Colours are read from the PREPRINT
   tokens at draw time, so switching mode restyles them with the page. */

const seqEditors = [];
const CELL_W = 13;
const SEQ_H = 74;

function ink(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function makeSeqEditor(spec) {
  const wrap = document.createElement("div");
  wrap.className = "seq";
  wrap.innerHTML =
    '<div class="seq-head">' +
      '<span class="seq-name"></span>' +
      '<code class="seq-at"></code>' +
      '<span class="seq-controls">' +
        '<label>Length</label>' +
        '<input class="field num narrow seq-len" type="number" min="0" max="64" step="1">' +
        '<button class="btn-ghost preset seq-loopclear" type="button">No loop</button>' +
      "</span>" +
    "</div>" +
    '<canvas class="seq-canvas"></canvas>' +
    '<div class="seq-strip"><span class="seq-flag"></span></div>';

  wrap.querySelector(".seq-name").textContent = spec.label;
  wrap.querySelector(".seq-name").setAttribute("data-tip", spec.tip);
  const canvas = wrap.querySelector(".seq-canvas");
  const strip = wrap.querySelector(".seq-strip");
  const flag = wrap.querySelector(".seq-flag");
  const lenInput = wrap.querySelector(".seq-len");
  const loopClear = wrap.querySelector(".seq-loopclear");
  const readout = wrap.querySelector(".seq-at");
  const ctx2d = canvas.getContext("2d");

  function seq() {
    return currentInstrument()[spec.key];
  }

  function width() {
    return Math.max(16, seq().data.length) * CELL_W;
  }

  function draw() {
    const s = seq();
    const w = width();
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = w + "px";
    canvas.style.height = SEQ_H + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(SEQ_H * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    const paper = ink("--pp-sunk");
    const hair = ink("--pp-hair");
    const line = ink("--pp-line");
    const edge = ink("--pp-edge");
    const plate = ink("--pp-plate-3");

    ctx2d.fillStyle = paper;
    ctx2d.fillRect(0, 0, w, SEQ_H);

    const span = spec.max - spec.min;
    const y = function (v) { return SEQ_H - 2 - ((v - spec.min) / span) * (SEQ_H - 4); };

    // Every fourth column, so a sequence can be counted in frames by eye.
    ctx2d.strokeStyle = hair;
    ctx2d.lineWidth = 1;
    for (let i = 4; i * CELL_W < w; i += 4) {
      ctx2d.beginPath();
      ctx2d.moveTo(i * CELL_W + 0.5, 0);
      ctx2d.lineTo(i * CELL_W + 0.5, SEQ_H);
      ctx2d.stroke();
    }

    if (spec.min < 0) {
      ctx2d.strokeStyle = line;
      ctx2d.beginPath();
      ctx2d.moveTo(0, Math.round(y(0)) + 0.5);
      ctx2d.lineTo(w, Math.round(y(0)) + 0.5);
      ctx2d.stroke();
    }

    const zero = spec.min < 0 ? y(0) : SEQ_H - 2;
    ctx2d.fillStyle = edge;
    for (let i = 0; i < s.data.length; i++) {
      const v = Math.max(spec.min, Math.min(spec.max, s.data[i]));
      const top = y(v);
      const h = Math.max(1, Math.abs(zero - top));
      ctx2d.fillRect(i * CELL_W + 1, Math.min(top, zero), CELL_W - 2, h);
    }

    if (s.loop >= 0 && s.loop < s.data.length) {
      ctx2d.strokeStyle = plate;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.moveTo(s.loop * CELL_W + 1, 0);
      ctx2d.lineTo(s.loop * CELL_W + 1, SEQ_H);
      ctx2d.stroke();
    }

    lenInput.value = s.data.length;
    loopClear.textContent = s.loop >= 0 ? "Loop at " + s.loop : "No loop";
    strip.style.width = w + "px";
    flag.style.display = s.loop >= 0 ? "block" : "none";
    flag.style.left = s.loop * CELL_W + "px";
  }

  function valueAt(ev) {
    const r = canvas.getBoundingClientRect();
    const i = Math.floor((ev.clientX - r.left) / CELL_W);
    const t = 1 - (ev.clientY - r.top) / SEQ_H;
    const v = Math.round(spec.min + t * (spec.max - spec.min));
    return { i: i, v: Math.max(spec.min, Math.min(spec.max, v)) };
  }

  let drawing = false;
  canvas.addEventListener("pointerdown", function (ev) {
    const s = seq();
    const at = valueAt(ev);
    if (at.i < 0 || at.i >= s.data.length) return;
    pushUndo();
    drawing = true;
    canvas.setPointerCapture(ev.pointerId);
    s.data[at.i] = at.v;
    draw();
    touch();
  });
  canvas.addEventListener("pointermove", function (ev) {
    const s = seq();
    const at = valueAt(ev);
    readout.textContent = at.i >= 0 && at.i < s.data.length ? "frame " + at.i + " · " + s.data[at.i] : "";
    if (!drawing || at.i < 0 || at.i >= s.data.length) return;
    s.data[at.i] = at.v;
    draw();
    touch();
  });
  canvas.addEventListener("pointerup", function () { drawing = false; });
  canvas.addEventListener("pointerleave", function () { readout.textContent = ""; });

  strip.addEventListener("pointerdown", function (ev) {
    const s = seq();
    const r = strip.getBoundingClientRect();
    const i = Math.floor((ev.clientX - r.left) / CELL_W);
    pushUndo();
    s.loop = i >= 0 && i < s.data.length && i !== s.loop ? i : -1;
    draw();
    touch();
  });

  loopClear.addEventListener("click", function () {
    pushUndo();
    seq().loop = -1;
    draw();
    touch();
  });

  lenInput.addEventListener("change", function () {
    const s = seq();
    const want = Math.max(0, Math.min(64, Number(lenInput.value) || 0));
    pushUndo();
    while (s.data.length > want) s.data.pop();
    while (s.data.length < want) s.data.push(s.data.length ? s.data[s.data.length - 1] : spec.max);
    if (s.loop >= s.data.length) s.loop = -1;
    draw();
    touch();
  });

  seqs.appendChild(wrap);
  return { draw: draw };
}

/* ── Sound ────────────────────────────────────────────────────────────────── */

let audio = null;
let source = null;
let previewSource = null;
let playing = false;
let rendered = null;
let startedAt = 0;
let startOffset = 0;
let playOrder = -1;
let playRow = -1;
let raf = 0;

function ctx() {
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audio = new AC();
  }
  if (audio.state === "suspended") audio.resume();
  return audio;
}

function toBuffer(ac, result) {
  const buf = ac.createBuffer(1, Math.max(1, result.samples.length), ac.sampleRate);
  buf.copyToChannel(result.samples, 0);
  return buf;
}

function offsetFor(order, row) {
  for (const m of rendered.marks) {
    if (m.order === order && m.row === row) return m.s / rendered.rate;
  }
  return 0;
}

function startPlaying(order, row) {
  const ac = ctx();
  stopSource();
  try {
    rendered = APU.render(Song.forPlayback(song), { rate: ac.sampleRate, loops: 1 });
  } catch (e) {
    return say("The song could not be rendered: " + e.message);
  }
  if (!rendered.samples.length) return say("There is nothing to play yet.");

  source = ac.createBufferSource();
  source.buffer = toBuffer(ac, rendered);
  source.loop = true;
  source.loopStart = rendered.loopStart / rendered.rate;
  source.loopEnd = rendered.samples.length / rendered.rate;
  source.connect(ac.destination);

  startOffset = offsetFor(order, row);
  source.start(0, startOffset);
  startedAt = ac.currentTime;
  playing = true;
  playLabel.textContent = "Playing";
  playBtn.classList.add("is-playing");
  say("");
  follow();
}

function stopSource() {
  if (source) {
    try { source.stop(); } catch (e) { /* already finished */ }
    source.disconnect();
    source = null;
  }
}

function stopPlaying() {
  stopSource();
  playing = false;
  playLabel.textContent = "Play";
  playBtn.classList.remove("is-playing");
  cancelAnimationFrame(raf);
  if (playRow >= 0 && rowEls[playRow]) rowEls[playRow].classList.remove("is-playing");
  playRow = -1;
  playOrder = -1;
  drawOrder();
}

function playSample() {
  let t = audio.currentTime - startedAt + startOffset;
  const end = source.loopEnd;
  const start = source.loopStart;
  if (t >= end) {
    const span = end - start;
    t = span > 0 ? start + ((t - start) % span) : start;
  }
  return t * rendered.rate;
}

function markAt(sample) {
  const marks = rendered.marks;
  let lo = 0, hi = marks.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].s <= sample) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return marks[best];
}

function follow() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(function tick() {
    if (!playing || !source) return;
    const m = markAt(playSample());
    if (m && (m.order !== playOrder || m.row !== playRow)) {
      if (playRow >= 0 && rowEls[playRow]) rowEls[playRow].classList.remove("is-playing");
      const orderChanged = m.order !== playOrder;
      playOrder = m.order;
      playRow = m.row;
      if (followToggle.checked && orderChanged && cursor.at !== m.order) {
        cursor.at = m.order;
        clampCursor();
        drawOrder();
        drawPatternControls();
        buildGrid();
      } else if (orderChanged) {
        drawOrder();
      }
      if (cursor.at === m.order && rowEls[m.row]) {
        rowEls[m.row].classList.add("is-playing");
        if (followToggle.checked) {
          const tr = rowEls[m.row];
          gridBody.parentNode.scrollTop = tr.offsetTop - gridBody.parentNode.clientHeight / 2;
        }
      }
    }
    raf = requestAnimationFrame(tick);
  });
}

/* An edit while the song is playing re-renders it and drops the needle back on
   the row it had reached. Rendering the whole song each time is affordable —
   the demo is seventeen seconds of audio in under a tenth of a second — and it
   keeps the loop boundaries where they were. */
let rerenderTimer = null;
function touch() {
  saveSoon();
  if (!playing) return;
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(function () {
    if (playing) startPlaying(playOrder >= 0 ? playOrder : cursor.at, playRow >= 0 ? playRow : 0);
  }, 300);
}

function previewNote(note, force) {
  if (!force && !previewToggle.checked) return;
  const ac = ctx();
  if (previewSource) {
    try { previewSource.stop(); } catch (e) { /* already finished */ }
    previewSource = null;
  }
  const r = APU.renderNote(Song.forPlayback(song), instrument, note, cursor.ch, 0.9, ac.sampleRate);
  if (!r.samples.length) return;
  previewSource = ac.createBufferSource();
  previewSource.buffer = toBuffer(ac, r);
  previewSource.connect(ac.destination);
  previewSource.start();
}

playBtn.addEventListener("click", function () {
  if (playing) stopPlaying();
  else startPlaying(cursor.at, 0);
});

stopBtn.addEventListener("click", stopPlaying);

/* ── Tempo ────────────────────────────────────────────────────────────────── */

function drawTempo() {
  speedInput.value = song.speed;
  const bpm = Song.bpmFor(song.speed, song.highlight);
  bpmOut.textContent = bpm.toFixed(1) + " BPM";
  bpmOut.setAttribute(
    "data-tip",
    "A row is " + song.speed + " frames at " + APU.FRAME_HZ.toFixed(4) +
      " Hz, counted four to the beat. Speed " + (song.speed - 1) + " would be " +
      Song.bpmFor(song.speed - 1, song.highlight).toFixed(1) + " and speed " + (song.speed + 1) + " would be " +
      Song.bpmFor(song.speed + 1, song.highlight).toFixed(1) + "."
  );
}

speedInput.addEventListener("change", function () {
  const want = Math.max(1, Math.min(31, Number(speedInput.value) || 6));
  if (want === song.speed) return;
  pushUndo();
  song.speed = want;
  drawTempo();
  touch();
});

/* ── Files ────────────────────────────────────────────────────────────────── */

function say(text) {
  hint.textContent = text || "";
  hint.hidden = !text;
}

function fileName(ext) {
  const base = (song.title || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (base || "untitled") + "." + ext;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

exportBtn.addEventListener("click", function () {
  const loops = Math.max(1, Math.min(16, Number(loopsInput.value) || 1));
  exportBtn.disabled = true;
  say("");
  /* One frame between disabling the button and doing the work, so the label
     changes before the main thread goes away for a second. */
  requestAnimationFrame(function () {
    setTimeout(function () {
      try {
        const out = APU.render(Song.forPlayback(song), { loops: loops });
        download(APU.wav(out.samples, out.rate), fileName("wav"));
        say("");
      } catch (e) {
        say("The song could not be rendered: " + e.message);
      }
      exportBtn.disabled = false;
    }, 0);
  });
});

saveBtn.addEventListener("click", function () {
  const blob = new Blob([JSON.stringify(Song.serialise(song), null, 1)], { type: "application/json" });
  download(blob, fileName("json"));
});

loadInput.addEventListener("change", function () {
  const file = loadInput.files && loadInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const next = Song.deserialise(JSON.parse(String(reader.result)));
      pushUndo();
      song = next;
      instrument = 0;
      cursor = { at: 0, row: 0, ch: 0, field: F_NOTE };
      stopPlaying();
      drawAll();
      touch();
      say("");
    } catch (e) {
      say("That file could not be read as a song: " + e.message);
    }
    loadInput.value = "";
  };
  reader.readAsText(file);
});

demoBtn.addEventListener("click", function () {
  pushUndo();
  song = Song.demoSong();
  instrument = 0;
  cursor = { at: 0, row: 0, ch: 0, field: F_NOTE };
  stopPlaying();
  drawAll();
  touch();
});

clearBtn.addEventListener("click", function () {
  pushUndo();
  const kept = song.instruments;
  song = Song.blankSong();
  song.instruments = kept;
  instrument = 0;
  cursor = { at: 0, row: 0, ch: 0, field: F_NOTE };
  stopPlaying();
  drawAll();
  touch();
  say("Every pattern is empty. The instruments were kept; Undo brings the song back.");
});

titleInput.addEventListener("input", function () {
  song.title = titleInput.value;
  saveSoon();
});

/* ── Drawing everything ───────────────────────────────────────────────────── */

function drawAll() {
  titleInput.value = song.title;
  drawTempo();
  drawOrder();
  drawPatternControls();
  drawInstruments();
  drawInstrumentEditor();
  buildGrid();
}

function drawEffectTable() {
  for (const key in Song.EFFECTS) {
    const fx = Song.EFFECTS[key];
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = fx.syntax;
    const td2 = document.createElement("td");
    td2.textContent = fx.name + " — " + fx.help;
    tr.appendChild(td1);
    tr.appendChild(td2);
    fxTable.appendChild(tr);
  }
}

/* The canvases hold ink rather than reading it from a stylesheet, so they have
   to be told when the page changes mode. */
new MutationObserver(function () {
  for (const ed of seqEditors) ed.draw();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

boot();
for (const spec of SEQ_SPECS) seqEditors.push(makeSeqEditor(spec));
drawEffectTable();
drawAll();
grid.focus();
