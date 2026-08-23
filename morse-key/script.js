/* The space bar is the key. Everything the tool knows comes from two numbers
   per press: how long it was down, and how long it was up afterwards. */

const MORSE = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.",
  H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.",
  O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-",
  V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-",
  5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--",
  "/": "-..-.", "(": "-.--.", ")": "-.--.-", "&": ".-...", ":": "---...",
  ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-", "_": "..--.-",
  '"': ".-..-.", $: "...-..-", "@": ".--.-.",
  "<SOS>": "...---...", "<SK>": "...-.-",
};

/* Where a punctuation mark and a prosign share one pattern, the mark is what
   the tool prints and the operator's name for it is printed beside it. */
const ALIAS = { "+": "AR", "=": "BT", "(": "KN", "&": "AS" };

const GROUPS = [
  { name: "Letters", chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("") },
  { name: "Digits", chars: "0123456789".split("") },
  { name: "Punctuation", chars: [".", ",", "?", "'", "!", "/", "(", ")", "&", ":", ";", "=", "+", "-", "_", '"', "$", "@"] },
  { name: "Prosigns", chars: ["<SOS>", "<SK>"] },
];

const CHAR_OF = Object.create(null);
for (const name of Object.keys(MORSE)) CHAR_OF[MORSE[name]] = name;
const CODES = Object.keys(CHAR_OF);

/* The lengths the code defines, and the thresholds between them. A press is a
   dah past two units, two being the midpoint of one and three.

   Silences are counted against a SECOND unit, because a hand does not pause the
   way it presses. The elements inside a character are muscle memory and come out
   at the speed of the dial; the gap before the next character also holds however
   long it takes to remember what that character is, and for anyone not yet
   fluent that is several times longer. Counting both against one unit is what
   makes a beginner's message arrive as single letters — every thinking pause
   reads as the end of a word.

   The trade has had a name for this since the 1950s: Farnsworth timing,
   characters at one speed and the spacing at another. The spacing dial is that
   second speed. Set it equal to the sending speed and this reduces exactly to
   strict timing.

   The thresholds are still midpoints, which is still where a guess is least
   likely to be wrong. A silence ends the letter halfway between one character
   unit and three spacing units, and adds a word space at five spacing units,
   halfway between three and seven. */
const DAH_AT = 2;
const INTRA_GAP = 1;
const LETTER_GAP = 3;
const WORD_GAP = 7;
const TAPE_UNITS = 60;
const LEVEL = 0.16;

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

const state = {
  unit: 100,
  gapUnit: 240,
  letterAt: 410,
  wordAt: 1200,
  code: "",
  tokens: [],
  events: [],
  dits: [],
  gaps: [],
  down: 0,
  lastUp: 0,
};

let letterTimer = 0;
let wordTimer = 0;

function pretty(code) {
  let out = "";
  for (const c of code) out += c === "." ? "·" : "–";
  return out;
}

/* ---- the key ---- */

function press(now) {
  if (state.down) return;
  /* The silence that just ended, measured before anything is decided about it.
     Anything past the dah threshold is a gap BETWEEN characters rather than one
     inside a character, and that judgement uses only the sending speed. Reading
     it independently of the letter and word thresholds is the point: a
     measurement that depended on the spacing dial could never tell you the
     spacing dial was wrong. */
  if (state.lastUp) {
    const silence = now - state.lastUp;
    if (silence > state.unit * DAH_AT && silence < 8000) {
      state.gaps.push(silence);
      if (state.gaps.length > 12) state.gaps.shift();
    }
  }
  state.down = now;
  clearTimeout(letterTimer);
  clearTimeout(wordTimer);
  state.events.push({ t0: now, t1: 0, dit: true });
  slab.classList.add("is-down");
  toneOn();
  wake();
}

function release(now) {
  if (!state.down) return;
  const held = now - state.down;
  const dit = held < state.unit * DAH_AT;
  const event = state.events[state.events.length - 1];

  state.down = 0;
  event.t1 = now;
  event.dit = dit;
  state.code += dit ? "." : "-";
  if (dit) {
    state.dits.push(held);
    if (state.dits.length > 12) state.dits.shift();
  }

  slab.classList.remove("is-down");
  toneOff();
  state.lastUp = now;
  letterTimer = setTimeout(commitLetter, state.letterAt);
  wordTimer = setTimeout(commitWord, state.wordAt);
  render();
  wake();
}

function commitLetter() {
  if (!state.code) return;
  const char = CHAR_OF[state.code] || null;
  state.tokens.push({ char, code: state.code });
  state.code = "";
  render();
  if (char) flash(char);
}

function commitWord() {
  const last = state.tokens[state.tokens.length - 1];
  if (!last || last.space) return;
  state.tokens.push({ space: true });
  render();
}

function rub() {
  if (state.code) {
    state.code = "";
  } else {
    state.tokens.pop();
  }
  clearTimeout(letterTimer);
  clearTimeout(wordTimer);
  render();
}

function clearAll() {
  clearTimeout(letterTimer);
  clearTimeout(wordTimer);
  state.code = "";
  state.tokens = [];
  state.events = [];
  state.dits = [];
  state.gaps = [];
  state.lastUp = 0;
  render();
  wake();
}

/* ---- the sidetone ----
   One oscillator runs for the life of the page and a gain gates it, ramped over
   a few milliseconds at each end. Gating a sine by starting and stopping it
   clicks, and the click is louder than the note. */

let ac = null;
let osc = null;
let amp = null;

function engine() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    osc = ac.createOscillator();
    amp = ac.createGain();
    amp.gain.value = 0;
    osc.type = "sine";
    osc.frequency.value = Number(pitch.value) || 600;
    osc.connect(amp).connect(ac.destination);
    osc.start();
  }
  if (ac.state === "suspended") ac.resume();
  return ac;
}

function ramp(to, seconds) {
  const t = ac.currentTime;
  amp.gain.cancelScheduledValues(t);
  amp.gain.setValueAtTime(amp.gain.value, t);
  amp.gain.linearRampToValueAtTime(to, t + seconds);
}

function toneOn() {
  if (!sound.checked) return;
  if (!engine()) return;
  ramp(LEVEL, 0.004);
}

function toneOff() {
  if (ac) ramp(0, 0.006);
}

/* ---- reading it back ---- */

function fitting(prefix) {
  let n = 0;
  for (const code of CODES) if (code.indexOf(prefix) === 0) n += 1;
  return n;
}

function median(list) {
  const sorted = list.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function text() {
  let out = "";
  for (const token of state.tokens) {
    if (token.space) out += " ";
    else out += token.char || "<" + token.code + ">";
  }
  return out.trim();
}

function render() {
  liveCode.textContent = pretty(state.code);

  if (!state.code) {
    liveSay.textContent = "nothing yet";
  } else {
    const hit = CHAR_OF[state.code];
    const n = fitting(state.code);
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
    const live = state.code !== "";
    cell.classList.toggle("is-out", live && code.indexOf(state.code) !== 0);
    cell.classList.toggle("is-hit", live && code === state.code);
  }

  /* Both halves of the reader's own timing, read back. The dits give the speed
     the characters are actually going out at; the gaps between characters give
     the speed the spacing is actually going out at, which for most hands is a
     good deal slower. A letter gap is three spacing units, so the spacing unit
     is a third of the median gap. */
  if (state.dits.length >= 3) {
    const measured = Math.round(1200 / median(state.dits));
    let label = measured + " wpm";
    let spaced = 0;
    if (state.gaps.length >= 3) {
      spaced = Math.min(measured, Math.max(3, Math.round(3600 / median(state.gaps))));
      label += " · spacing " + spaced;
    }
    fistOut.textContent = label;
    const sameSpeed = measured === Number(wpm.value);
    const sameSpacing = !spaced || spaced === Number(spacing.value);
    matchBtn.disabled = (sameSpeed && sameSpacing) || measured < 5 || measured > 40;
    matchBtn.dataset.wpm = String(measured);
    matchBtn.dataset.spacing = spaced ? String(spaced) : "";
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
      const code = MORSE[char];
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
  const span = state.unit * TAPE_UNITS;
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
    for (let t = Math.ceil(from / state.unit) * state.unit; t <= now; t += state.unit) {
      g.fillRect(Math.round(at(t)), base + 5, 1, 6);
    }
  }

  g.fillStyle = ink.rule;
  g.fillRect(0, base, cw, 1);

  g.font = "10px " + ink.mono;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";

  for (const event of state.events) {
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

  while (state.events.length && (state.events[0].t1 || now) < from - state.unit) {
    state.events.shift();
  }
}

function tick() {
  raf = 0;
  const now = performance.now();
  drawTape(now);
  const last = state.events.length ? state.events[state.events.length - 1] : null;
  const quiet = last ? now - (last.t1 || now) : Infinity;
  if (state.down || quiet < state.unit * TAPE_UNITS) raf = requestAnimationFrame(tick);
}

function wake() {
  if (!raf) raf = requestAnimationFrame(tick);
}

/* ---- controls ---- */

function applyUnit() {
  const value = Math.min(40, Math.max(5, Number(wpm.value) || 12));
  state.unit = 1200 / value;
  /* Spacing may be slower than the characters but never faster: a gap shorter
     than the elements it separates is not a gap anyone could read. */
  const spaced = Math.min(value, Math.max(3, Number(spacing.value) || 5));
  state.gapUnit = 1200 / spaced;
  state.letterAt = (state.unit * INTRA_GAP + state.gapUnit * LETTER_GAP) / 2;
  state.wordAt = state.gapUnit * (LETTER_GAP + WORD_GAP) / 2;

  unitOut.textContent = Math.round(state.unit) + " ms";
  gapOut.textContent = "letter " + Math.round(state.letterAt) +
                       " · word " + Math.round(state.wordAt) + " ms";
  tapeLegend.textContent = TAPE_UNITS + " units · " + (state.unit * TAPE_UNITS / 1000).toFixed(1) + " s";
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

pitch.addEventListener("input", () => {
  if (osc) osc.frequency.setTargetAtTime(Number(pitch.value) || 600, ac.currentTime, 0.01);
});

sound.addEventListener("change", () => {
  if (!sound.checked) toneOff();
  else if (state.down) toneOn();
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
  press(performance.now());
});

for (const name of ["pointerup", "pointercancel"]) {
  slab.addEventListener(name, () => release(performance.now()));
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
    if (!evt.repeat) press(performance.now());
    return;
  }
  if (evt.key === "Backspace") {
    evt.preventDefault();
    rub();
  }
});

document.addEventListener("keyup", (evt) => {
  if (evt.key === " ") release(performance.now());
});

/* A key held while the tab goes away would otherwise never come up. */
window.addEventListener("blur", () => release(performance.now()));

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
applyUnit();
