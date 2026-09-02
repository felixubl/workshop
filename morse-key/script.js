/* The space bar is the key. Everything the tool knows comes from two numbers
   per press: how long it was down, and how long it was up afterwards.

   The code itself, the thresholds and the key that reads them are in morse.js
   beside this file, which Morse Bench loads from here as well. What is left in
   this file is the page: the line, the paper tape, the alphabet and the dials. */

const { pretty, fitting, TABLE, CHAR_OF, ALIAS, GROUPS } = Morse;

const TAPE_UNITS = 60;

const slab = document.getElementById("slab");
const wpm = document.getElementById("wpm");
const unitOut = document.getElementById("unitOut");
const spacing = document.getElementById("spacing");
const gapOut = document.getElementById("gapOut");
const fistOut = document.getElementById("fistOut");
const matchBtn = document.getElementById("match");
const pitch = document.getElementById("pitch");
const sound = document.getElementById("sound");
const copyBtn = document.getElementById("copy");
const clearBtn = document.getElementById("clear");
const liveCode = document.getElementById("liveCode");
const liveSay = document.getElementById("liveSay");
const line = document.getElementById("line");
const count = document.getElementById("count");
const chart = document.getElementById("chart");
const chartSay = document.getElementById("chartSay");
const tape = document.getElementById("tape");
const tapeLegend = document.getElementById("tapeLegend");

const cells = [];

/* Only the message. The pattern in hand, the marks and the reader's measured
   timing all belong to the key. */
const state = { tokens: [] };

const keyer = new Morse.Keyer({
  mark(down) {
    slab.classList.toggle("is-down", down);
    if (down) Morse.Sidetone.on();
    else Morse.Sidetone.off();
    wake();
  },
  change: render,
  char(char, code) {
    state.tokens.push({ char, code });
    if (char) flash(char);
  },
  space() {
    const last = state.tokens[state.tokens.length - 1];
    if (!last || last.space) return;
    state.tokens.push({ space: true });
  },
});

function rub() {
  if (!keyer.rub()) {
    state.tokens.pop();
    render();
  }
}

function clearAll() {
  keyer.reset();
  state.tokens = [];
  render();
  wake();
}

/* ---- reading it back ---- */

function text() {
  let out = "";
  for (const token of state.tokens) {
    if (token.space) out += " ";
    else out += token.char || "<" + token.code + ">";
  }
  return out.trim();
}

function render() {
  liveCode.textContent = pretty(keyer.code);

  if (!keyer.code) {
    liveSay.textContent = "nothing yet";
  } else {
    const hit = CHAR_OF[keyer.code];
    const n = fitting(keyer.code);
    if (hit && n === 1) liveSay.textContent = hit + ", and nothing longer";
    else if (hit) liveSay.textContent = hit + ", or " + (n - 1) + " longer";
    else if (n === 0) liveSay.textContent = "no character fits";
    else liveSay.textContent = n + " still fit";
  }

  line.textContent = "";
  for (const token of state.tokens) {
    const span = document.createElement("span");
    if (token.space) {
      span.className = "tok tok-space";
      span.textContent = " ";
    } else if (token.char) {
      span.className = "tok";
      span.textContent = token.char;
    } else {
      span.className = "tok tok-lost";
      span.textContent = "<" + pretty(token.code) + ">";
      span.title = "";
      span.setAttribute("data-tip", "No character has this pattern");
    }
    line.append(span);
  }
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.setAttribute("aria-hidden", "true");
  line.append(caret);

  const letters = state.tokens.filter((t) => !t.space).length;
  count.textContent = letters === 1 ? "1 character" : letters + " characters";

  for (const cell of cells) {
    const code = cell.dataset.code;
    const live = keyer.code !== "";
    cell.classList.toggle("is-out", live && code.indexOf(keyer.code) !== 0);
    cell.classList.toggle("is-hit", live && code === keyer.code);
  }

  const hand = keyer.hand();
  if (hand) {
    let label = hand.wpm + " wpm";
    if (hand.spacing) label += " · spacing " + hand.spacing;
    fistOut.textContent = label;
    const sameSpeed = hand.wpm === Number(wpm.value);
    const sameSpacing = !hand.spacing || hand.spacing === Number(spacing.value);
    matchBtn.disabled = (sameSpeed && sameSpacing) || hand.wpm < 5 || hand.wpm > 40;
    matchBtn.dataset.wpm = String(hand.wpm);
    matchBtn.dataset.spacing = hand.spacing ? String(hand.spacing) : "";
  } else {
    fistOut.textContent = "—";
    matchBtn.disabled = true;
  }
}

let flashTimer = 0;
function flash(char) {
  const cell = chart.querySelector('[data-char="' + CSS.escape(char) + '"]');
  if (!cell) return;
  clearTimeout(flashTimer);
  for (const other of chart.querySelectorAll(".is-sent")) other.classList.remove("is-sent");
  cell.classList.add("is-sent");
  flashTimer = setTimeout(() => cell.classList.remove("is-sent"), 420);
}

/* The chart is built from the same table the decoder reads, so a character the
   tool can decode and a character the page prints cannot come apart. */
function buildChart() {
  let total = 0;
  for (const group of GROUPS) {
    const head = document.createElement("p");
    head.className = "chart-head section-label";
    head.textContent = group.name;
    chart.append(head);

    for (const char of group.chars) {
      const code = TABLE[char];
      const cell = document.createElement("div");
      cell.className = code.length >= 8 ? "cell is-long" : "cell";
      cell.dataset.code = code;
      cell.dataset.char = char;

      const glyph = document.createElement("span");
      glyph.className = "cell-char";
      glyph.textContent = char;

      const dits = document.createElement("code");
      dits.className = "cell-code";
      dits.textContent = pretty(code);

      cell.append(glyph, dits);
      if (ALIAS[char]) {
        const alias = document.createElement("code");
        alias.className = "cell-alias";
        alias.textContent = ALIAS[char];
        cell.append(alias);
      }
      chart.append(cell);
      cells.push(cell);
      total += 1;
    }
  }
  chartSay.textContent = total + " characters";
}

/* ---- the tape ---- */

const g = tape.getContext("2d");
let cw = 0;
let ch = 0;
let raf = 0;
let ink = null;

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name) => cs.getPropertyValue(name).trim();
  return {
    mark: read("--pp-ink"),
    live: read("--pp-plate-2"),
    rule: read("--pp-line"),
    faint: read("--pp-faint"),
    mono: read("--pp-font-mono") || "monospace",
  };
}

function sizeTape() {
  const dpr = window.devicePixelRatio || 1;
  cw = tape.clientWidth;
  ch = tape.clientHeight;
  tape.width = Math.max(1, Math.round(cw * dpr));
  tape.height = Math.max(1, Math.round(ch * dpr));
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawTape(now) {
  if (!cw || !ch) return;
  const span = keyer.unit * TAPE_UNITS;
  const from = now - span;
  const at = (t) => ((t - from) / span) * cw;
  const base = ch - 22;
  const bar = 30;

  g.clearRect(0, 0, cw, ch);

  /* Ticks are placed on absolute time, not on the canvas, so the ruler travels
     with the marks instead of standing still under them. */
  const step = cw / TAPE_UNITS;
  if (step >= 4) {
    g.fillStyle = ink.faint;
    for (let t = Math.ceil(from / keyer.unit) * keyer.unit; t <= now; t += keyer.unit) {
      g.fillRect(Math.round(at(t)), base + 5, 1, 6);
    }
  }

  g.fillStyle = ink.rule;
  g.fillRect(0, base, cw, 1);

  g.font = "10px " + ink.mono;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";

  for (const event of keyer.events) {
    const end = event.t1 || now;
    if (end < from) continue;
    const x0 = at(Math.max(event.t0, from));
    const x1 = at(end);
    const width = Math.max(1, x1 - x0);
    g.fillStyle = event.t1 ? ink.mark : ink.live;
    g.fillRect(x0, base - bar, width, bar);
    if (event.t1 && width >= 9) {
      g.fillStyle = ink.faint;
      g.fillText(event.dit ? "·" : "–", x0 + width / 2, base - bar - 5);
    }
  }

  while (keyer.events.length && (keyer.events[0].t1 || now) < from - keyer.unit) {
    keyer.events.shift();
  }
}

function tick() {
  raf = 0;
  const now = performance.now();
  drawTape(now);
  const last = keyer.events.length ? keyer.events[keyer.events.length - 1] : null;
  const quiet = last ? now - (last.t1 || now) : Infinity;
  if (keyer.down || quiet < keyer.unit * TAPE_UNITS) raf = requestAnimationFrame(tick);
}

function wake() {
  if (!raf) raf = requestAnimationFrame(tick);
}

/* ---- controls ---- */

function applyUnit() {
  const t = keyer.speed(Number(wpm.value), Number(spacing.value));

  unitOut.textContent = Math.round(t.unit) + " ms";
  gapOut.textContent = "letter " + Math.round(t.letterAt) +
                       " · word " + Math.round(t.wordAt) + " ms";
  tapeLegend.textContent = TAPE_UNITS + " units · " + (t.unit * TAPE_UNITS / 1000).toFixed(1) + " s";
  render();
  wake();
}

wpm.addEventListener("input", applyUnit);
wpm.addEventListener("change", applyUnit);
spacing.addEventListener("input", applyUnit);
spacing.addEventListener("change", applyUnit);

matchBtn.addEventListener("click", () => {
  wpm.value = matchBtn.dataset.wpm;
  if (matchBtn.dataset.spacing) spacing.value = matchBtn.dataset.spacing;
  wpm.dispatchEvent(new Event("input", { bubbles: true }));
  spacing.dispatchEvent(new Event("input", { bubbles: true }));
  applyUnit();
});

pitch.addEventListener("input", () => Morse.Sidetone.pitch(Number(pitch.value)));

sound.addEventListener("change", () => {
  Morse.Sidetone.enabled = sound.checked;
  if (!sound.checked) Morse.Sidetone.off();
  else if (keyer.down) Morse.Sidetone.on();
});

clearBtn.addEventListener("click", clearAll);

copyBtn.addEventListener("click", async () => {
  const body = text();
  if (!body) return;
  try {
    await navigator.clipboard.writeText(body);
    copyBtn.textContent = "copied";
    setTimeout(() => { copyBtn.textContent = "copy text"; }, 1200);
  } catch (err) {
    copyBtn.textContent = "no clipboard";
    setTimeout(() => { copyBtn.textContent = "copy text"; }, 1200);
  }
});

/* ---- input ---- */

slab.addEventListener("pointerdown", (evt) => {
  evt.preventDefault();
  slab.setPointerCapture(evt.pointerId);
  keyer.press(performance.now());
});

for (const name of ["pointerup", "pointercancel"]) {
  slab.addEventListener(name, () => keyer.release(performance.now()));
}

/* Space keys unless another control has the focus, so a number field still
   takes a space and the buttons beside it still answer to one. The slab is a
   button too, and is the exception: it is the key. */
function elsewhere(target) {
  if (!target || !target.closest) return false;
  if (target === slab || target.closest(".key-slab")) return false;
  return !!target.closest("input, select, textarea, button, label, [contenteditable]");
}

document.addEventListener("keydown", (evt) => {
  if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
  if (elsewhere(evt.target)) return;

  if (evt.key === " ") {
    evt.preventDefault();
    if (!evt.repeat) keyer.press(performance.now());
    return;
  }
  if (evt.key === "Backspace") {
    evt.preventDefault();
    rub();
  }
});

document.addEventListener("keyup", (evt) => {
  if (evt.key === " ") keyer.release(performance.now());
});

/* A key held while the tab goes away would otherwise never come up. */
window.addEventListener("blur", () => keyer.release(performance.now()));

new ResizeObserver(() => {
  sizeTape();
  drawTape(performance.now());
}).observe(tape);

new MutationObserver(() => {
  ink = palette();
  drawTape(performance.now());
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

buildChart();
ink = palette();
sizeTape();
Morse.Sidetone.enabled = sound.checked;
Morse.Sidetone.hz = Number(pitch.value) || 600;
applyUnit();
