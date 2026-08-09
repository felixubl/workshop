const headingInput = document.getElementById("heading");
const subtitleInput = document.getElementById("subtitle");
const sizeInput = document.getElementById("size");
const sizePresets = document.getElementById("sizePresets");
const freeToggle = document.getElementById("freeSpace");
const freeLabelInput = document.getElementById("freeLabel");
const paperSelect = document.getElementById("paper");
const itemsInput = document.getElementById("items");
const itemsNote = document.getElementById("itemsNote");
const exampleBtn = document.getElementById("example");
const clearItemsBtn = document.getElementById("clearItems");
const countCap = document.getElementById("countCap");
const countMeta = document.getElementById("countMeta");
const countBig = document.getElementById("countBig");
const countExact = document.getElementById("countExact");
const countFacts = document.getElementById("countFacts");
const wantedInput = document.getElementById("wanted");
const maxOutBtn = document.getElementById("maxOut");
const seedInput = document.getElementById("seed");
const newSeedBtn = document.getElementById("newSeed");
const buildBtn = document.getElementById("build");
const hint = document.getElementById("hint");
const emptyState = document.getElementById("empty");
const results = document.getElementById("results");
const dealCap = document.getElementById("dealCap");
const dealMeta = document.getElementById("dealMeta");
const dealNote = document.getElementById("dealNote");
const pagerAt = document.getElementById("pagerAt");
const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");
const preview = document.getElementById("preview");
const copyListBtn = document.getElementById("copyList");
const downloadBtn = document.getElementById("download");

// One card is one page, and a PDF is held in memory whole before it is handed
// to the browser. Five hundred pages is around a megabyte and a couple of
// seconds, which is the point where a cap is kinder than a hung tab. It is also
// well past what anybody prints: a village hall seats fewer.
const MAX_CARDS = 500;

// A run of draws that all come back already-seen means the space is nearly
// exhausted, not that the generator is stuck. Four thousand in a row is
// impossible for any pool big enough to matter and merely slow for a tiny one,
// so it ends the search rather than the tab.
const MAX_MISSES = 4000;

let deal = null;
let showing = 0;

/* ── The list ──────────────────────────────────────────────────────────────
   What the user types is lines; what a card needs is distinct squares. Blank
   lines go, and so do repeats — two identical squares would make two cards
   that look the same while the arithmetic below insisted they were different,
   and a count that is not true of the paper is worse than no count. */

function readItems() {
  const seen = new Set();
  const items = [];
  let blank = 0;
  let repeated = 0;
  for (const line of itemsInput.value.split("\n")) {
    const text = line.trim();
    if (!text) { blank++; continue; }
    if (seen.has(text)) { repeated++; continue; }
    seen.add(text);
    items.push(text);
  }
  return { items, blank, repeated };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Grids run from 2 to 8, and exactly one of those needs "an".
function article(size) {
  return size === 8 ? "An" : "A";
}

/* ── The arithmetic ────────────────────────────────────────────────────────
   With n squares to choose from and k cells to fill, the number of cards is
   the number of ways to fill the cells in order: n × (n−1) × … × (n−k+1). That
   is a permutation and not a combination, because position is what a bingo
   card is for — the same twenty-four squares dealt differently win on
   different lines, so they are different cards.

   The numbers leave doubles behind immediately (a 5×5 from thirty squares is
   already past 10^30), so every count here is a BigInt and stays exact. */

function permutations(n, k) {
  let p = 1n;
  for (let i = 0; i < k; i++) p *= BigInt(n - i);
  return p;
}

// C(n, k), built up so that each step divides exactly: the product of any j
// consecutive integers is divisible by j!, so the running value is always whole
// and nothing has to be held as a fraction.
function combinations(n, k) {
  let c = 1n;
  for (let i = 0; i < k; i++) c = (c * BigInt(n - i)) / BigInt(i + 1);
  return c;
}

const SUPERSCRIPT = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };

// Past fifteen digits the exact figure has stopped being a quantity anybody can
// read and become a piece of evidence, so the headline goes to three
// significant figures and the whole thing is printed underneath.
function readable(value) {
  const digits = value.toString();
  if (digits.length <= 15) return { short: value.toLocaleString(), exact: null };
  const mantissa = digits[0] + "." + digits.slice(1, 4);
  const exponent = String(digits.length - 1).replace(/\d/g, (d) => SUPERSCRIPT[d]);
  return { short: `${mantissa} × 10${exponent}`, exact: value.toLocaleString() };
}

/* ── The shape of a card ───────────────────────────────────────────────────
   An even grid has no middle square, so it cannot have a free one. The
   checkbox stays where it is and stops applying, which is the honest state to
   show: the setting is not wrong, the grid just has nowhere to put it. */

function readShape() {
  const size = Math.round(Number(sizeInput.value));
  const valid = Number.isFinite(size) && size >= 2 && size <= 8;
  const odd = valid && size % 2 === 1;
  const free = odd && freeToggle.checked;
  const cells = valid ? size * size : 0;
  return {
    size,
    valid,
    odd,
    free,
    cells,
    fill: cells - (free ? 1 : 0),
    freeIndex: free ? (cells - 1) / 2 : -1,
    freeLabel: freeLabelInput.value.trim() || "FREE",
  };
}

// Everything the count panel says, worked out in one place so the panel, the
// validation and the deal cannot disagree about it.
function survey() {
  const shape = readShape();
  const list = readItems();
  const n = list.items.length;
  const enough = shape.valid && n >= shape.fill && shape.fill > 0;
  return {
    shape,
    list,
    n,
    enough,
    arrangements: enough ? permutations(n, shape.fill) : 0n,
    sets: enough ? combinations(n, shape.fill) : 0n,
  };
}

/* ── The panels ────────────────────────────────────────────────────────── */

function fact(term, detail) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = detail;
  countFacts.append(dt, dd);
}

function renderCount() {
  const state = survey();
  const { shape, list, n } = state;

  const parts = [plural(n, "square")];
  if (list.repeated) parts.push(`${list.repeated} repeated, dropped`);
  if (list.blank) parts.push(`${plural(list.blank, "blank line")}`);
  itemsNote.textContent = n === 0 ? "Nothing typed yet." : parts.join(" · ");

  // The encoding warning belongs here rather than at the download, where the
  // list can no longer be edited without going back. It counts lines rather
  // than characters, because "two of your squares lose something" is a thing
  // you can act on and "seven characters" is not.
  const carried = Bingo.pdf.check([
    ...list.items,
    headingInput.value,
    subtitleInput.value,
    shape.freeLabel,
  ]);
  if (carried.affected) {
    itemsNote.textContent +=
      ` · ${carried.affected} of these lose characters the printed font cannot set` +
      (carried.blank ? `, and ${carried.blank} would print blank` : "");
  }

  countFacts.textContent = "";
  countExact.textContent = "";

  if (!shape.valid) {
    countCap.textContent = "—";
    countMeta.textContent = "";
    countBig.textContent = "—";
    fact("Grid", "Between 2 and 8 squares a side.");
    return state;
  }

  countCap.textContent = `${shape.size} × ${shape.size}`;
  countMeta.textContent = shape.free
    ? `${shape.fill} to fill · free centre`
    : shape.odd
      ? `${shape.fill} to fill`
      : `${shape.fill} to fill · even grid, no centre`;

  if (!state.enough) {
    countBig.textContent = "none";
    countBig.classList.add("is-none");
    fact("Short by", plural(shape.fill - n, "square"));
    fact("Needed", `${plural(shape.fill, "square")} for this grid`);
    fact("Typed", plural(n, "square"));
    return state;
  }

  countBig.classList.remove("is-none");
  const arrangements = readable(state.arrangements);
  countBig.textContent = arrangements.short;
  countExact.textContent = arrangements.exact || "";

  const sets = readable(state.sets);
  fact("Squares used per card", `${shape.fill} of ${n}`);
  fact("Different sets of squares", sets.short);
  fact(
    "Most you can ask for",
    state.arrangements < BigInt(MAX_CARDS)
      ? `${state.arrangements} — the list runs out first`
      : `${MAX_CARDS} — one file, one page each`
  );
  return state;
}

function showHint(message) {
  hint.textContent = message;
  hint.hidden = !message;
}

/* ── Dealing ───────────────────────────────────────────────────────────────
   mulberry32 seeded through xmur3, the same pair the Random Number Generator
   uses, so a seed typed into either tool means a run that can be repeated. */

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeed() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// A partial Fisher-Yates: only the first `fill` positions are shuffled, because
// only those are dealt. Each step picks uniformly from what is left, so the
// prefix is a uniform random arrangement however the pool happened to be
// ordered when the previous card finished with it.
function dealOne(pool, fill, rng) {
  for (let i = 0; i < fill; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    const swap = pool[i];
    pool[i] = pool[j];
    pool[j] = swap;
  }
  return pool.slice(0, fill);
}

// Uniqueness is enforced rather than hoped for. Above a few dozen squares a
// collision is astronomically unlikely and the check costs nothing; below that
// it is the whole ballgame, because a nine-square 3×3 has only 362,880 cards
// and a party wants a hundred of them.
function dealCards(n, fill, wanted, rng) {
  const pool = Array.from({ length: n }, (_, i) => i);
  const seen = new Set();
  const cards = [];
  let misses = 0;
  while (cards.length < wanted && misses < MAX_MISSES) {
    const pick = dealOne(pool, fill, rng);
    const key = pick.join(",");
    if (seen.has(key)) { misses++; continue; }
    seen.add(key);
    misses = 0;
    cards.push(pick);
  }
  return cards;
}

// A card as the printer wants it: every cell of the grid in reading order,
// with the free square sitting in the middle holding its label.
function toCells(pick, shape, items) {
  const cells = [];
  let at = 0;
  for (let i = 0; i < shape.cells; i++) {
    if (i === shape.freeIndex) cells.push({ text: shape.freeLabel, free: true });
    else cells.push({ text: items[pick[at++]], free: false });
  }
  return cells;
}

function build() {
  const state = renderCount();
  const { shape, list, n } = state;

  if (!shape.valid) return showHint("A grid is between 2 and 8 squares a side.");
  if (!n) return showHint("Type the squares first — one per line.");
  if (!state.enough) {
    return showHint(
      `${article(shape.size)} ${shape.size} × ${shape.size} card${shape.free ? " with a free centre" : ""} needs ${plural(shape.fill, "square")}, and there ${n === 1 ? "is" : "are"} ${n}.`
    );
  }

  let wanted = Math.round(Number(wantedInput.value));
  if (!Number.isFinite(wanted) || wanted < 1) return showHint("Ask for at least one card.");

  const ceiling = state.arrangements < BigInt(MAX_CARDS) ? Number(state.arrangements) : MAX_CARDS;
  let capped = "";
  if (wanted > ceiling) {
    capped =
      ceiling === MAX_CARDS
        ? `Asked for ${wanted}, capped at ${MAX_CARDS} — that is one page each and as far as this tool goes in one file.`
        : `Asked for ${wanted}, but ${plural(ceiling, "card")} ${ceiling === 1 ? "is" : "are"} all this list can make without repeating one.`;
    wanted = ceiling;
    wantedInput.value = String(wanted);
  }
  showHint(capped);

  const seed = seedInput.value.trim() || randomSeed();
  const rng = mulberry32(xmur3(seed));
  const picks = dealCards(n, shape.fill, wanted, rng);

  deal = {
    seed,
    shape,
    items: list.items,
    cards: picks.map((pick) => toCells(pick, shape, list.items)),
    heading: headingInput.value.trim(),
    subtitle: subtitleInput.value.trim(),
    paper: paperSelect.value,
  };
  showing = 0;

  if (picks.length < wanted) {
    dealNote.textContent = `Stopped at ${plural(picks.length, "card")}: every further draw came back as one already dealt.`;
  } else {
    dealNote.textContent = "";
  }
  renderDeal();
}

/* ── The preview ───────────────────────────────────────────────────────── */

function renderDeal() {
  const { shape, cards, seed } = deal;

  dealCap.textContent = `${cards.length} ${cards.length === 1 ? "card" : "cards"} · ${shape.size} × ${shape.size}`;
  dealMeta.textContent = "";
  dealMeta.append(document.createTextNode("seed "));
  const reuse = document.createElement("button");
  reuse.className = "seed-tag";
  reuse.type = "button";
  reuse.dataset.tip = "Put this seed in the seed field";
  reuse.textContent = seed;
  reuse.addEventListener("click", () => {
    seedInput.value = seed;
    seedInput.focus();
  });
  dealMeta.appendChild(reuse);

  emptyState.hidden = true;
  results.hidden = false;
  renderCard();
}

function renderCard() {
  const { shape, cards } = deal;
  const cells = cards[showing];

  pagerAt.textContent = `${showing + 1} / ${cards.length}`;
  prevBtn.disabled = showing === 0;
  nextBtn.disabled = showing === cards.length - 1;

  preview.style.setProperty("--cols", String(shape.size));
  preview.textContent = "";
  for (const cell of cells) {
    const box = document.createElement("div");
    box.className = cell.free ? "bingo-cell is-free" : "bingo-cell";
    box.setAttribute("role", "cell");
    box.textContent = cell.text;
    preview.appendChild(box);
  }
}

function step(by) {
  if (!deal) return;
  showing = Math.min(deal.cards.length - 1, Math.max(0, showing + by));
  renderCard();
}

/* ── Out ───────────────────────────────────────────────────────────────── */

function slug(text, fallback) {
  const out = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return out || fallback;
}

function downloadPdf() {
  if (!deal) return;
  const bytes = Bingo.pdf.print({
    cards: deal.cards.map((cells) => ({ cells })),
    columns: deal.shape.size,
    rows: deal.shape.size,
    title: deal.heading,
    subtitle: deal.subtitle,
    footer: `seed ${deal.seed} · workshop.fubl.org/bingo-cards`,
    paper: deal.paper,
  });

  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug(deal.heading, "bingo")}-${slug(deal.seed, "cards")}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

// A pressed button that says nothing looks broken, and a clipboard write is the
// one action here with no visible result of its own.
function flash(button, message) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = message;
  setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1400);
}

/* ── Wiring ────────────────────────────────────────────────────────────── */

const EXAMPLE = [
  "Someone says “circle back”",
  "You're on mute",
  "Screen sharing fails",
  "Can everyone see my screen?",
  "Let's take this offline",
  "Awkward silence",
  "Dog barks",
  "Doorbell",
  "Baby in shot",
  "Cat walks across the keyboard",
  "Frozen mid-sentence",
  "Echo on the line",
  "Wrong meeting",
  "Joins fifteen minutes late",
  "Leaves without saying anything",
  "“Can you hear me now?”",
  "Eating on camera",
  "Virtual background glitches",
  "“Sorry, go ahead”",
  "Two people talk at once",
  "“Quick question”, then ten minutes",
  "“Let's park that”",
  "“Hard stop at the top of the hour”",
  "Reads the slide out loud",
  "Nobody has the agenda",
  "This could have been an email",
  "Action items with no owner",
  "“Does that make sense?”",
  "Sirens outside",
  "Runs over by twenty minutes",
];

function markPresets() {
  for (const button of sizePresets.querySelectorAll(".preset")) {
    button.classList.toggle("is-active", Number(button.dataset.size) === Number(sizeInput.value));
  }
}

function refresh() {
  markPresets();
  renderCount();
  showHint("");
}

sizePresets.addEventListener("click", (event) => {
  const button = event.target.closest(".preset");
  if (!button) return;
  sizeInput.value = button.dataset.size;
  // The drawn number field mirrors the native input, and only an `input` event
  // tells it the value moved underneath it.
  sizeInput.dispatchEvent(new Event("input", { bubbles: true }));
  refresh();
});

for (const control of [sizeInput, freeToggle, freeLabelInput, headingInput, subtitleInput]) {
  control.addEventListener("input", refresh);
  control.addEventListener("change", refresh);
}
itemsInput.addEventListener("input", () => {
  renderCount();
  showHint("");
});

exampleBtn.addEventListener("click", () => {
  itemsInput.value = EXAMPLE.join("\n");
  refresh();
});

clearItemsBtn.addEventListener("click", () => {
  itemsInput.value = "";
  itemsInput.focus();
  refresh();
});

maxOutBtn.addEventListener("click", () => {
  const state = survey();
  if (!state.enough) return showHint("There are not enough squares to make a card yet.");
  const ceiling = state.arrangements < BigInt(MAX_CARDS) ? Number(state.arrangements) : MAX_CARDS;
  wantedInput.value = String(ceiling);
  wantedInput.dispatchEvent(new Event("input", { bubbles: true }));
  showHint("");
});

newSeedBtn.addEventListener("click", () => {
  seedInput.value = randomSeed();
});

buildBtn.addEventListener("click", build);
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));
downloadBtn.addEventListener("click", downloadPdf);

copyListBtn.addEventListener("click", async () => {
  if (!deal) return;
  try {
    await navigator.clipboard.writeText(deal.items.join("\n"));
    flash(copyListBtn, "Copied");
  } catch {
    flash(copyListBtn, "Blocked");
  }
});

// Enter in the settings deals, the way it would in a form. The list itself is a
// textarea, where Enter is a new square.
document.querySelector(".toolbar.make").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    build();
  }
});

refresh();
