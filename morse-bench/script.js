/* A words-a-minute test for a key. Words go up, you send them, and the run is
   scored on what came out rather than on what the dials were set to.

   The alphabet, the thresholds, the sidetone and the key itself are
   ../morse-key/morse.js, which Morse Key loads too. What is in this file is the
   run: the material in front of you, where the cursor is in it, and the
   arithmetic that turns a list of presses into two speeds. */

const { pretty, fitting, CHAR_OF, TABLE, costOf, wpmOf, median, isError,
        LETTER_GAP, DAH_AT, STALE } = Morse;

const slab = document.getElementById("slab");
const wpm = document.getElementById("wpm");
const unitOut = document.getElementById("unitOut");
const spacing = document.getElementById("spacing");
const gapOut = document.getElementById("gapOut");
const cribPick = document.getElementById("cribPick");
const matPick = document.getElementById("matPick");
const count = document.getElementById("length");
const pitch = document.getElementById("pitch");
const sound = document.getElementById("sound");
const go = document.getElementById("go");
const runSay = document.getElementById("runSay");
const strip = document.getElementById("strip");
const stage = document.getElementById("stage");
const liveSay = document.getElementById("liveSay");
const liveCode = document.getElementById("liveCode");
const readSay = document.getElementById("readSay");
const effOut = document.getElementById("effOut");
const charOut = document.getElementById("charOut");
const accOut = document.getElementById("accOut");
const timeOut = document.getElementById("timeOut");
const matchBtn = document.getElementById("match");
const splitSay = document.getElementById("splitSay");
const sheetSay = document.getElementById("sheetSay");
const capSay = document.getElementById("capSay");
const rows = document.getElementById("rows");

const REST = "The two speeds are the reading. If they are far apart the time is " +
             "going into the silences, not the elements.";

const run = {
  words: [],
  w: 0,
  c: 0,
  /* One per character actually sent: what was asked, what arrived, and the
     span from the first press for it to the first press for the next. */
  attempts: [],
  /* The current word only, so the stage can mark the letters already sent. */
  wordGot: [],
  wordClean: true,
  fumbles: [],
  startedAt: 0,
  endedAt: 0,
  live: false,
  done: false,
  crib: true,
  source: "words",
  marks: [],
  measured: null,
};

/* When the character now being keyed was first pressed for. */
let pendingT0 = 0;

const keyer = new Morse.Keyer({
  mark(down, now) {
    slab.classList.toggle("is-down", down);
    if (down) Morse.Sidetone.on();
    else Morse.Sidetone.off();
    if (!down || run.done) return;

    /* The clock starts on the first press and not on the first letter that
       lands, because working out what the first letter is takes time and that
       time is part of the run. */
    if (!run.live) {
      run.live = true;
      run.startedAt = now;
      startClock();
    }
    /* Nothing has been keyed toward this character yet, so this press opens
       one — and closes the last, whose span runs up to here. */
    if (keyer.code === "") {
      const last = run.attempts[run.attempts.length - 1];
      if (last && !last.t1) last.t1 = now;
      pendingT0 = now;
    }
  },
  change: render,
  char: land,
});

/* ---- the run ---- */

function source() {
  return matPick.querySelector(".is-active").dataset.material;
}

function cribShown() {
  return cribPick.querySelector(".is-active").dataset.crib === "shown";
}

function newRun() {
  keyer.reset();
  run.words = Material.draw(source(), Math.min(40, Math.max(3, Number(count.value) || 10)));
  run.w = 0;
  run.c = 0;
  run.attempts = [];
  run.wordGot = [];
  run.wordClean = true;
  run.fumbles = [];
  run.startedAt = 0;
  run.endedAt = 0;
  run.live = false;
  run.done = false;
  run.crib = cribShown();
  run.source = source();
  run.marks = [];
  run.measured = null;
  stopClock();

  effOut.textContent = "—";
  charOut.textContent = "—";
  accOut.textContent = "—";
  timeOut.textContent = "—";
  readSay.textContent = "no run finished yet";
  splitSay.textContent = REST;
  sheetSay.textContent = "—";
  capSay.textContent = "no run yet";
  rows.textContent = "";
  matchBtn.disabled = true;
  render();
}

function land(char, code) {
  if (run.done) return;

  /* Eight dits, the operator's error signal, and the word starts again. It is
     not an attempt and is not scored as one; what it costs is the seconds it
     took, which the clock has been counting all along. The characters already
     fumbled stay on the tally — the signal takes back the text, not the
     record. */
  if (isError(code)) {
    run.c = 0;
    run.wordGot = [];
    run.wordClean = false;
    return;
  }

  const word = run.words[run.w];
  if (!word) return;
  const want = word[run.c];

  run.attempts.push({ want: want, got: char, code: code, t0: pendingT0, t1: 0 });
  run.wordGot.push({ want: want, got: char, code: code });
  if (char !== want) run.wordClean = false;

  run.c += 1;
  if (run.c < word.length) return;

  run.fumbles[run.w] = !run.wordClean;
  run.w += 1;
  run.c = 0;
  run.wordGot = [];
  run.wordClean = true;
  if (run.w >= run.words.length) finish();
}

function finish() {
  const last = run.attempts[run.attempts.length - 1];
  if (last && !last.t1) last.t1 = keyer.lastUp;
  run.endedAt = keyer.lastUp;
  run.live = false;
  run.done = true;
  run.marks = keyer.events.slice();
  stopClock();
  score();
}

/* ---- the arithmetic ----

   What the run asked for, in units. Every character plus three units of
   silence between each pair, and no word space: the next word opens the moment
   the last letter of this one lands, so that space is never sent and cannot be
   charged. It is the same accounting PARIS is fifty units under, which is why a
   run keyed at strict timing on the dial reads back exactly the dial's speed. */
function askedUnits(words) {
  let units = 0;
  let chars = 0;
  for (const word of words) {
    for (const char of word) {
      units += costOf(char);
      chars += 1;
    }
  }
  return units + LETTER_GAP * Math.max(0, chars - 1);
}

/* The two halves of the reader's own timing, taken over the whole run rather
   than over a rolling dozen: the dits fix the unit the characters went out at,
   and a letter gap being three spacing units, a third of the median silence
   between characters fixes the other. */
function ownTiming(marks) {
  const dits = [];
  const gaps = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    if (!mark.t1) continue;
    if (mark.dit) dits.push(mark.t1 - mark.t0);
    const next = marks[i + 1];
    if (!next) continue;
    const silence = next.t0 - mark.t1;
    if (silence > keyer.unit * DAH_AT && silence < STALE) gaps.push(silence);
  }
  return {
    wpm: dits.length >= 3 ? 1200 / median(dits) : 0,
    spacing: gaps.length >= 3 ? 3600 / median(gaps) : 0,
    markTime: marks.reduce((sum, m) => sum + (m.t1 ? m.t1 - m.t0 : 0), 0),
  };
}

function score() {
  const seconds = (run.endedAt - run.startedAt) / 1000;
  const asked = askedUnits(run.words);
  const effective = wpmOf(asked, run.endedAt - run.startedAt);
  const own = ownTiming(run.marks);
  const hits = run.attempts.filter((a) => a.got === a.want).length;
  const accuracy = run.attempts.length ? (hits / run.attempts.length) * 100 : 0;

  effOut.textContent = effective.toFixed(1);
  charOut.textContent = own.wpm ? own.wpm.toFixed(1) : "—";
  accOut.textContent = Math.round(accuracy);
  timeOut.textContent = seconds.toFixed(1);

  const extra = run.attempts.length - charCount(run.words);
  readSay.textContent = run.words.length + " " +
    (run.source === "groups" ? "groups" : "words") + " · crib " +
    (run.crib ? "shown" : "hidden") + " · " + asked + " units" +
    (extra > 0 ? " · " + extra + " resent" : "");

  const share = own.markTime / (run.endedAt - run.startedAt);
  splitSay.textContent =
    "Of " + seconds.toFixed(1) + " seconds, " + (own.markTime / 1000).toFixed(1) +
    " went on marks and " + ((run.endedAt - run.startedAt - own.markTime) / 1000).toFixed(1) +
    " on silence — " + Math.round(share * 100) + " per cent of the run had the key down. " +
    (own.wpm
      ? (own.wpm - effective > 2
          ? "Your elements are going out at " + own.wpm.toFixed(1) +
            " and the run at " + effective.toFixed(1) + ", so the difference is time spent between characters rather than in them."
          : "The two speeds are within two words a minute of each other, which is what fluent sending looks like.")
      : REST);

  run.measured = {
    wpm: Math.min(40, Math.max(5, Math.round(own.wpm))),
    spacing: own.spacing ? Math.min(40, Math.max(3, Math.round(own.spacing))) : 0,
  };
  matchBtn.disabled = !own.wpm;

  buildSheet();
}

/* How many characters the run asked for, which the number sent exceeds by
   exactly the characters a resend put back on the key. */
function charCount(words) {
  let n = 0;
  for (const word of words) n += word.length;
  return n;
}

function buildSheet() {
  const stats = new Map();
  run.attempts.forEach((attempt, i) => {
    if (!attempt.t1 || attempt.t1 <= attempt.t0) return;
    const last = i === run.attempts.length - 1;
    const units = costOf(attempt.want) + (last ? 0 : LETTER_GAP);
    let stat = stats.get(attempt.want);
    if (!stat) {
      stat = { char: attempt.want, n: 0, missed: 0, speeds: [] };
      stats.set(attempt.want, stat);
    }
    stat.n += 1;
    if (attempt.got !== attempt.want) stat.missed += 1;
    stat.speeds.push(wpmOf(units, attempt.t1 - attempt.t0));
  });

  const list = [...stats.values()];
  for (const stat of list) stat.wpm = median(stat.speeds);
  list.sort((a, b) => a.wpm - b.wpm);

  rows.textContent = "";
  for (const stat of list) {
    const tr = document.createElement("tr");
    const cells = [
      stat.char,
      pretty(TABLE[stat.char] || ""),
      String(costOf(stat.char) + LETTER_GAP),
      String(stat.n),
      stat.missed ? String(stat.missed) : "—",
      stat.wpm.toFixed(1),
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    if (stat.missed) tr.className = "is-fumbled";
    rows.append(tr);
  }

  sheetSay.textContent = list.length + (list.length === 1 ? " character" : " characters");
  capSay.textContent = list.length
    ? list[0].char + " is your slowest at " + list[0].wpm.toFixed(1) + " wpm"
    : "nothing measurable";
}

/* ---- the page ---- */

function render() {
  liveCode.textContent = pretty(keyer.code);

  if (!keyer.code) {
    liveSay.textContent = "nothing yet";
  } else {
    const hit = CHAR_OF[keyer.code];
    const n = fitting(keyer.code);
    if (isError(keyer.code)) liveSay.textContent = "error signal, resends the word";
    else if (hit && n === 1) liveSay.textContent = hit + ", and nothing longer";
    else if (hit) liveSay.textContent = hit + ", or " + (n - 1) + " longer";
    else if (n === 0) liveSay.textContent = "no character fits";
    else liveSay.textContent = n + " still fit";
  }

  renderStrip();
  renderStage();

  if (run.done) runSay.textContent = "run over";
  else if (run.live) runSay.textContent = "word " + (run.w + 1) + " of " + run.words.length;
  else runSay.textContent = run.words.length + " to send · press the key to start";
}

function renderStrip() {
  strip.textContent = "";
  run.words.forEach((word, i) => {
    const span = document.createElement("code");
    span.className = "word";
    span.textContent = word;
    if (i < run.w) span.classList.add(run.fumbles[i] ? "is-fumbled" : "is-clean");
    else if (i === run.w && !run.done) span.classList.add("is-now");
    strip.append(span);
  });
}

function renderStage() {
  stage.textContent = "";
  stage.classList.toggle("is-blind", !cribShown());

  if (run.done) {
    const say = document.createElement("p");
    say.className = "stage-say";
    say.textContent = "Run over. The reading is below.";
    stage.append(say);
    return;
  }

  const word = run.words[run.w] || "";
  [...word].forEach((char, i) => {
    const cell = document.createElement("div");
    cell.className = "letter";

    const glyph = document.createElement("span");
    glyph.className = "letter-char";
    glyph.textContent = char;
    cell.append(glyph);

    const sent = run.wordGot[i];
    if (sent && sent.got === char) cell.classList.add("is-hit");
    else if (sent) cell.classList.add("is-miss");
    else if (i === run.c) cell.classList.add("is-now");

    /* One slot under the letter. Before it is sent it holds the crib, which the
       hidden setting makes invisible without taking its room back, so the stage
       does not change height when the crib goes away. After a miss it holds
       what actually arrived, which is worth seeing in either setting. */
    if (sent && sent.got !== char) {
      const got = document.createElement("code");
      got.className = "letter-got";
      got.textContent = sent.got || pretty(sent.code);
      cell.append(got);
    } else {
      const code = document.createElement("code");
      code.className = "letter-code";
      code.textContent = pretty(TABLE[char] || "");
      cell.append(code);
    }
    stage.append(cell);
  });
}

/* The clock is the one reading that moves while nothing is being pressed, so it
   runs on an interval rather than off the key. */
let clock = 0;

function startClock() {
  stopClock();
  clock = setInterval(() => {
    timeOut.textContent = ((performance.now() - run.startedAt) / 1000).toFixed(1);
  }, 100);
}

function stopClock() {
  clearInterval(clock);
  clock = 0;
}

/* ---- controls ---- */

function applyUnit() {
  const t = keyer.speed(Number(wpm.value), Number(spacing.value));
  unitOut.textContent = Math.round(t.unit) + " ms";
  gapOut.textContent = "letter " + Math.round(t.letterAt) +
                       " · word " + Math.round(t.wordAt) + " ms";
}

function pickIn(group, evt) {
  const button = evt.target.closest("button[data-crib], button[data-material]");
  if (!button) return null;
  for (const other of group.querySelectorAll(".preset")) {
    other.classList.toggle("is-active", other === button);
  }
  handOver(button, evt);
  return button;
}

/* A toolbar button keeps the focus after a click, and the space bar belongs to
   whatever has the focus — so the press that was meant to start the run would
   press the button again instead. Give the focus up, but only when the button
   was clicked: a reader who tabbed to it and hit Enter is navigating by keyboard
   and moving their place would be worse than the thing this fixes. `detail` is
   0 for a keyboard activation and 1 or more for a pointer. */
function handOver(button, evt) {
  if (evt.detail) button.blur();
}

wpm.addEventListener("input", applyUnit);
wpm.addEventListener("change", applyUnit);
spacing.addEventListener("input", applyUnit);
spacing.addEventListener("change", applyUnit);

cribPick.addEventListener("click", (evt) => {
  if (!pickIn(cribPick, evt)) return;
  /* A run that had the crib up at any point was a run with the crib up, and the
     reading says so rather than reporting the setting it happens to end on. */
  if (run.live && cribShown()) run.crib = true;
  render();
});

matPick.addEventListener("click", (evt) => {
  if (pickIn(matPick, evt)) newRun();
});

count.addEventListener("change", newRun);
go.addEventListener("click", (evt) => {
  handOver(go, evt);
  newRun();
});

matchBtn.addEventListener("click", () => {
  if (!run.measured) return;
  wpm.value = String(run.measured.wpm);
  if (run.measured.spacing) {
    spacing.value = String(Math.min(run.measured.spacing, run.measured.wpm));
  }
  applyUnit();
  matchBtn.disabled = true;
});

pitch.addEventListener("input", () => Morse.Sidetone.pitch(Number(pitch.value)));

sound.addEventListener("change", () => {
  Morse.Sidetone.enabled = sound.checked;
  if (!sound.checked) Morse.Sidetone.off();
  else if (keyer.down) Morse.Sidetone.on();
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
  /* Only the pattern in hand. A character already on the board is taken back
     with the error signal, which is what an operator sends and what costs what
     a correction should cost. */
  if (evt.key === "Backspace") {
    evt.preventDefault();
    keyer.rub();
  }
});

document.addEventListener("keyup", (evt) => {
  if (evt.key === " ") keyer.release(performance.now());
});

/* A key held while the tab goes away would otherwise never come up. */
window.addEventListener("blur", () => keyer.release(performance.now()));

Morse.Sidetone.enabled = sound.checked;
Morse.Sidetone.hz = Number(pitch.value) || 600;
applyUnit();
newRun();
