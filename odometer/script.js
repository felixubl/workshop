/* A row of reels geared to each other. A count turns the rightmost reel, and a
   reel passing its last digit pushes the one on its left up by one. Digits are
   stored least significant first, so reel i is worth base^i.

   Each reel is drawn as a strip of five cells around its digit, and its teeth
   ride on strips of their own beside it. What the reels show is always derived
   from the digits in `state`; an animation only gets from one set of digits to
   the next and then repaints. */

const SYMBOLS = "0123456789ABCDEF";
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const MAX_WHEELS = 12;
const ROLL = 520;
const EASE = "cubic-bezier(.3, .1, .3, 1)";

/* The carry tooth starts SLACK of a digit short of the tooth it pushes, and
   that gap is the chain reaction: each reel starts SLACK of a step after the
   one pushing it. Reels move at one constant speed while teeth touch, so the
   two rows of teeth never pass through each other, and a pushed reel eases
   into place (HOLD) once the reel behind it has stopped. HOLD starts at the
   constant speed so the hand-over does not jolt. */
const SLACK = 0.3;
const HOLD = "cubic-bezier(.33, .33, .6, 1)";

const box = document.getElementById("reelsBox");
const row = document.getElementById("reels");
const reading = row.querySelector(".reading");
const baseIn = document.getElementById("base");
const wheelsIn = document.getElementById("wheels");
const speedIn = document.getElementById("speed");
const jumpIn = document.getElementById("jump");
const capOut = document.getElementById("capOut");
const valueOut = document.getElementById("valueOut");
const sumOut = document.getElementById("sumOut");
const otherOut = document.getElementById("otherOut");
const rollOut = document.getElementById("rollOut");
const runBtn = document.getElementById("run");
const slab = document.getElementById("slab");
const presets = [...document.querySelectorAll("[data-base]")];
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

const state = { base: 2, wheels: 8, digits: new Array(8).fill(0) };
let reels = [];
let running = false;
const pending = new Set();

function mod(n, m) {
  return ((n % m) + m) % m;
}

function power(b, k) {
  return `${b}${String(k).split("").map((c) => SUPERSCRIPT[c]).join("")}`;
}

function capacity() {
  return state.base ** state.wheels;
}

function valueOf() {
  return state.digits.reduceRight((v, d) => v * state.base + d, 0);
}

function setValue(v) {
  const cap = capacity();
  let rest = ((Math.floor(v) % cap) + cap) % cap;
  state.digits = state.digits.map(() => {
    const d = rest % state.base;
    rest = Math.floor(rest / state.base);
    return d;
  });
}

/* One count at reel `from`, carrying left. Returns every reel it touched in
   the order the carry reaches them, and whether it ran off the last reel. */
function advance(from, dir) {
  const last = dir > 0 ? state.base - 1 : 0;
  const reset = dir > 0 ? 0 : state.base - 1;
  const changes = [];
  for (let i = from; i < state.wheels; i++) {
    const d = state.digits[i];
    if (d !== last) {
      state.digits[i] = d + dir;
      changes.push({ i, from: d, to: d + dir, wrap: false });
      return { changes, overflow: false };
    }
    state.digits[i] = reset;
    changes.push({ i, from: d, to: reset, wrap: true });
  }
  return { changes, overflow: true };
}

/* ---- the reels ---- */

function build() {
  settle();
  row.querySelectorAll(".wheel, .reel-band").forEach((el) => el.remove());
  row.style.setProperty("--n", state.wheels);
  box.style.setProperty("--len", (capacity() - 1).toLocaleString("en").length);
  row.insertAdjacentHTML("afterbegin", '<span class="reel-band" aria-hidden="true"></span>');
  reels = [];
  for (let i = state.wheels - 1; i >= 0; i--) {
    const weight = state.base ** i;
    const wheel = document.createElement("div");
    wheel.className = "wheel";

    const face = document.createElement("button");
    face.type = "button";
    face.className = "reel";
    face.setAttribute("aria-label", `Add ${weight}, one step on this reel`);
    face.addEventListener("click", () => count(i, 1));
    face.innerHTML = `<span class="reel-strip">${'<span class="reel-cell"></span>'.repeat(5)}</span>`;

    const place = document.createElement("p");
    place.className = "place";
    place.innerHTML = '<span class="place-pow"></span><span class="place-val"></span>';
    place.firstChild.textContent = power(state.base, i);
    place.lastChild.textContent = String(weight).length <= 7 ? `×${weight}` : "";

    wheel.append(face, place);
    const reel = { strip: face.firstChild, cells: [...face.querySelectorAll(".reel-cell")], teeth: [] };
    if (i > 0) {
      wheel.insertAdjacentHTML("beforeend", '<span class="teeth teeth--own" aria-hidden="true"><span class="teeth-strip"></span></span>');
      reel.teeth.push(wheel.lastChild.firstChild);
    }
    if (i < state.wheels - 1) {
      wheel.insertAdjacentHTML("beforeend", '<span class="teeth teeth--carry" aria-hidden="true"><span class="teeth-strip"></span></span>');
      reel.carry = wheel.lastChild.firstChild;
      reel.teeth.push(reel.carry);
    }
    row.insertBefore(wheel, reading);
    reels[i] = reel;
  }
  paintAll();
  readout(false);
}

/* The strip holds the digits two below to two above the current one. The
   carry tooth sits on every seam between the last digit and 0 that falls on
   the strip, which in base 2 is every other cell. */
function paint(i, d) {
  const b = state.base;
  const reel = reels[i];
  reel.cells.forEach((cell, k) => {
    cell.textContent = SYMBOLS[mod(d + k - 2, b)];
  });
  if (!reel.carry) return;
  reel.carry.textContent = "";
  reel.cells.forEach((cell, k) => {
    if (mod(d + k - 2, b) !== b - 1) return;
    const tooth = document.createElement("span");
    tooth.className = "tooth";
    tooth.style.top = `calc(var(--w) * ${k + 1})`;
    reel.carry.append(tooth);
  });
}

function paintAll() {
  state.digits.forEach((d, i) => paint(i, d));
}

/* The strips rest at -30% (digit strip) and -36% (teeth, whose window starts
   lower); a step moves both one cell of five, 20%. */
function roll(from, by, pushed) {
  if (!pushed) return [{ transform: `translateY(${from}%)` }, { transform: `translateY(${from + by}%)` }];
  return [
    { transform: `translateY(${from}%)` },
    { transform: `translateY(${from + by * (1 - SLACK)}%)`, offset: 1 - SLACK, easing: HOLD },
    { transform: `translateY(${from + by}%)` },
  ];
}

/* One reel's animations as a unit. `finish` repaints the end state before the
   animations are cancelled, in the same task, so no frame shows the gap. */
function track(anims, finish) {
  return new Promise((resolve) => {
    let over = false;
    const done = () => {
      if (over) return;
      over = true;
      pending.delete(done);
      finish();
      anims.forEach((a) => a.cancel());
      resolve();
    };
    pending.add(done);
    anims[0].onfinish = done;
  });
}

/* Jump every running animation to its end, so a fast hand never waits behind
   a slow carry. */
function settle() {
  [...pending].forEach((done) => done());
}

/* A reel that pushes another moves at constant speed to the end, because its
   tooth is in mesh until it stops. The reel a count starts on eases from
   rest. A reel that is pushed and pushes nothing eases in at the end. */
function animate(changes, dir, duration) {
  const top = state.wheels - 1;
  const by = -20 * dir;
  return Promise.all(changes.map((c, j) => {
    const reel = reels[c.i];
    const drives = c.wrap && c.i < top;
    const pushed = j > 0 && !drives;
    const opts = { duration, delay: j * duration * SLACK, fill: "forwards", easing: j || drives ? "linear" : EASE };
    const anims = [reel.strip.animate(roll(-30, by, pushed), opts)];
    reel.teeth.forEach((strip) => anims.push(strip.animate(roll(-36, by, pushed), opts)));
    return track(anims, () => paint(c.i, c.to));
  }));
}

/* ---- counting ---- */

function duration() {
  if (reduced.matches) return 0;
  const speed = Number(speedIn.value) || 2;
  return running ? Math.min(ROLL, 450 / speed) : ROLL;
}

function readout(overflow) {
  const b = state.base;
  const v = valueOf();
  valueOut.textContent = v.toLocaleString("en");
  const terms = [];
  for (let i = state.wheels - 1; i >= 0; i--) {
    const d = state.digits[i];
    if (d) terms.push(`${SYMBOLS[d]}×${power(b, i)}`);
  }
  sumOut.textContent = terms.length ? `${terms.join(" + ")} = ${v.toLocaleString("en")}` : "nothing on any reel";
  otherOut.textContent = "";
  [2, 8, 10, 16].forEach((ob) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `base ${ob}  ${v.toString(ob).toUpperCase()}`;
    otherOut.append(tag);
  });
  capOut.textContent = `0 to ${(capacity() - 1).toLocaleString("en")}`;
  rollOut.hidden = !overflow;
}

function count(from, dir) {
  settle();
  const { changes, overflow } = advance(from, dir);
  readout(overflow);
  return animate(changes, dir, duration());
}

function jumpTo(v) {
  settle();
  setValue(v);
  paintAll();
  readout(false);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  while (running) {
    const t0 = performance.now();
    await count(0, 1);
    const wait = 1000 / (Number(speedIn.value) || 2) - (performance.now() - t0);
    if (wait > 0) await sleep(wait);
  }
}

function setRunning(on) {
  running = on;
  runBtn.textContent = on ? "stop" : "run";
  if (on) run();
}

/* Changing the base or the number of reels keeps the number and redraws the
   reels around it. A number too big for the new reels keeps its low digits,
   the way an odometer that runs out of reels does. */
function setBase(b) {
  b = Math.min(16, Math.max(2, Math.round(b) || 2));
  const v = valueOf();
  state.base = b;
  baseIn.value = b;
  presets.forEach((p) => p.classList.toggle("is-active", Number(p.dataset.base) === b));
  setValue(v);
  build();
}

function setWheels(n) {
  n = Math.min(MAX_WHEELS, Math.max(1, Math.round(n) || 1));
  const v = valueOf();
  state.wheels = n;
  state.digits = new Array(n).fill(0);
  wheelsIn.value = n;
  setValue(v);
  build();
}

presets.forEach((p) => p.addEventListener("click", () => setBase(Number(p.dataset.base))));
baseIn.addEventListener("change", () => setBase(Number(baseIn.value)));
wheelsIn.addEventListener("change", () => setWheels(Number(wheelsIn.value)));
jumpIn.addEventListener("change", () => jumpTo(Number(jumpIn.value) || 0));
document.getElementById("up").addEventListener("click", () => count(0, 1));
document.getElementById("down").addEventListener("click", () => count(0, -1));
document.getElementById("reset").addEventListener("click", () => {
  setRunning(false);
  jumpTo(0);
});
runBtn.addEventListener("click", () => setRunning(!running));
slab.addEventListener("click", () => count(0, 1));

function elsewhere(target) {
  if (!target || !target.closest) return false;
  return !!target.closest("input, select, textarea, [contenteditable]");
}

document.addEventListener("keydown", (evt) => {
  if (evt.metaKey || evt.ctrlKey || evt.altKey || elsewhere(evt.target)) return;
  if (evt.key === "ArrowUp" || evt.key === "+") {
    evt.preventDefault();
    count(0, 1);
  } else if (evt.key === "ArrowDown" || evt.key === "-") {
    evt.preventDefault();
    count(0, -1);
  }
});

setBase(2);
