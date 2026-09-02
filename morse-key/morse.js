/* Morse itself: what a pattern means, how long each part of it lasts, and a key
   that turns presses back into characters.

   Morse Bench loads this file from here rather than keeping a copy, the way
   Eclipse Countdown loads Eclipse Recon's engine, so the two tools cannot
   disagree about what a pattern is worth or where a letter ends. Everything
   above the key is arithmetic on the code and holds no DOM; the key holds
   timers and calls back. */

const Morse = (function () {
  "use strict";

  const TABLE = {
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
  for (const name of Object.keys(TABLE)) CHAR_OF[TABLE[name]] = name;
  const CODES = Object.keys(CHAR_OF);

  /* The lengths the code defines, and the thresholds between them. A press is a
     dah past two units, two being the midpoint of one and three.

     Silences are counted against a SECOND unit, because a hand does not pause
     the way it presses. The elements inside a character are muscle memory and
     come out at the speed of the dial; the gap before the next character also
     holds however long it takes to remember what that character is, and for
     anyone not yet fluent that is several times longer. Counting both against
     one unit is what makes a beginner's message arrive as single letters —
     every thinking pause reads as the end of a word.

     The trade has had a name for this since the 1950s: Farnsworth timing,
     characters at one speed and the spacing at another. The spacing dial is
     that second speed. Set it equal to the sending speed and this reduces
     exactly to strict timing.

     The thresholds are still midpoints, which is still where a guess is least
     likely to be wrong. A silence ends the letter halfway between one character
     unit and three spacing units, and adds a word space at five spacing units,
     halfway between three and seven. */
  const DAH_AT = 2;
  const INTRA_GAP = 1;
  const LETTER_GAP = 3;
  const WORD_GAP = 7;

  /* A press is only ever remembered as a dit or a dah, so both readings need a
     ceiling. Twelve is enough to take a median through and short enough that a
     hand which has just sped up is not still being averaged against one that
     had not. */
  const SAMPLES = 12;

  /* Anything past this is somebody who walked away, not a gap. */
  const STALE = 8000;

  function pretty(code) {
    let out = "";
    for (const c of code) out += c === "." ? "·" : "–";
    return out;
  }

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

  /* Whether a silence between two marks is a gap BETWEEN characters rather than
     one inside a character. The judgement uses only the sending speed, never the
     letter or word thresholds: a measurement that depended on the spacing dial
     could never tell you the spacing dial was wrong. */
  function isGap(silence, unit) {
    return silence > unit * DAH_AT && silence < STALE;
  }

  /* The lengths a hand can be measured by, pulled off a list of marks: how long
     its dits are, how long its silences between characters are, and how much of
     the whole stretch had the key down. Over how many marks is the caller's
     business — a rolling dozen for a live readout, a whole run for a score — and
     that is the only thing the two differ in. */
  function samples(marks, unit) {
    const dits = [];
    const gaps = [];
    let markTime = 0;
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i];
      if (!mark.t1) continue;
      markTime += mark.t1 - mark.t0;
      if (mark.dit) dits.push(mark.t1 - mark.t0);
      const next = marks[i + 1];
      if (next && isGap(next.t0 - mark.t1, unit)) gaps.push(next.t0 - mark.t1);
    }
    return { dits: dits, gaps: gaps, markTime: markTime };
  }

  /* What those lengths say the hand is going out at. A dit is one unit, so 1200
     over the median dit is the speed the characters are sending at; a letter gap
     is three spacing units, so 3600 over the median gap is the speed the spacing
     is sending at, which for most hands is a good deal slower. Null until there
     are enough dits to take a median through, and zero spacing until there are
     enough gaps. Raw: rounding this to a dial is the caller's business, and the
     two callers round it differently on purpose. */
  function readHand(taken) {
    if (taken.dits.length < 3) return null;
    const wpm = 1200 / median(taken.dits);
    /* Spacing may be slower than the characters but never faster, the same rule
       the dial itself is resolved under. */
    const spacing = taken.gaps.length >= 3
      ? Math.min(wpm, 3600 / median(taken.gaps))
      : 0;
    return { wpm: wpm, spacing: spacing };
  }

  /* The error signal: eight dits, which no character claims. An operator sends
     it to say the word just sent was wrong and is about to be sent again. Morse
     Key prints it as an unassigned pattern, having no word to take back; Morse
     Bench acts on it. Eight OR MORE, because the trade says eight and a hand
     that overshoots meant the same thing. */
  function isError(code) {
    return code.length >= 8 && code.indexOf("-") === -1;
  }

  /* What a character costs in units: its elements, a dit one and a dah three,
     with one unit of silence between each pair. */
  function costOf(char) {
    const code = TABLE[char];
    if (!code) return 0;
    let units = code.length - 1;
    for (const c of code) units += c === "." ? 1 : 3;
    return units;
  }

  /* Units over to words per minute, PARIS being fifty of them: five characters
     and their four three-unit gaps come to forty-three, and the seven-unit
     space after the word makes fifty. Which units a caller counts is the
     caller's business; the divisor is the code's. */
  function wpmOf(units, ms) {
    if (!(ms > 0)) return 0;
    return (units / 50) * (60000 / ms);
  }

  /* The dial, resolved. Spacing may be slower than the characters but never
     faster: a gap shorter than the elements it separates is not a gap anyone
     could read. */
  function timing(wpm, spacingWpm) {
    const speed = Math.min(40, Math.max(5, wpm || 12));
    const spaced = Math.min(speed, Math.max(3, spacingWpm || 5));
    const unit = 1200 / speed;
    const gapUnit = 1200 / spaced;
    return {
      wpm: speed,
      spacing: spaced,
      unit: unit,
      gapUnit: gapUnit,
      letterAt: (unit * INTRA_GAP + gapUnit * LETTER_GAP) / 2,
      wordAt: gapUnit * (LETTER_GAP + WORD_GAP) / 2,
    };
  }

  /* ---- the sidetone ----
     One oscillator runs for the life of the page and a gain gates it, ramped
     over a few milliseconds at each end. Gating a sine by starting and stopping
     it clicks, and the click is louder than the note. */

  const LEVEL = 0.16;

  const Sidetone = {
    enabled: true,
    hz: 600,
    ac: null,
    osc: null,
    amp: null,

    engine() {
      if (!this.ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ac = new AC();
        this.osc = this.ac.createOscillator();
        this.amp = this.ac.createGain();
        this.amp.gain.value = 0;
        this.osc.type = "sine";
        this.osc.frequency.value = this.hz;
        this.osc.connect(this.amp).connect(this.ac.destination);
        this.osc.start();
      }
      if (this.ac.state === "suspended") this.ac.resume();
      return this.ac;
    },

    ramp(to, seconds) {
      const t = this.ac.currentTime;
      this.amp.gain.cancelScheduledValues(t);
      this.amp.gain.setValueAtTime(this.amp.gain.value, t);
      this.amp.gain.linearRampToValueAtTime(to, t + seconds);
    },

    on() {
      if (!this.enabled) return;
      if (!this.engine()) return;
      this.ramp(LEVEL, 0.004);
    },

    /* Not guarded by `enabled`, so switching the sidetone off mid-press
       silences the note that is sounding rather than stranding it. */
    off() {
      if (this.ac) this.ramp(0, 0.006);
    },

    pitch(hz) {
      this.hz = hz || 600;
      if (this.osc) this.osc.frequency.setTargetAtTime(this.hz, this.ac.currentTime, 0.01);
    },
  };

  /* ---- the key ----

     Everything it knows comes from two numbers per press: how long it was down,
     and how long it was up afterwards. It owns the thresholds, the timers and
     the pattern in hand, and nothing above them — what a decoded character is
     then FOR is the page's business, so it is handed over through hooks:

       mark(down, now)   the key went down or came up, and when
       change()          the pattern in hand moved
       char(char, code)  a character finished; char is null when nothing fits
       space()           a word gap elapsed
  */

  function Keyer(hooks) {
    this.hooks = hooks || {};
    this.code = "";
    /* Every mark since the last reset, as {t0, t1, dit}. Kept for whatever
       wants to draw or measure them; a page that keeps one forever should
       shift the front off as it goes. */
    this.events = [];
    this.dits = [];
    this.gaps = [];
    this.down = 0;
    this.lastUp = 0;
    this.letterTimer = 0;
    this.wordTimer = 0;
    this.speed(12, 5);
  }

  Keyer.prototype.speed = function (wpm, spacingWpm) {
    const t = timing(wpm, spacingWpm);
    this.unit = t.unit;
    this.gapUnit = t.gapUnit;
    this.letterAt = t.letterAt;
    this.wordAt = t.wordAt;
    return t;
  };

  Keyer.prototype.press = function (now) {
    if (this.down) return;
    /* The silence that just ended, measured before anything is decided about
       it. What counts as a gap is isGap's rule and nobody else's. */
    if (this.lastUp) {
      const silence = now - this.lastUp;
      if (isGap(silence, this.unit)) {
        this.gaps.push(silence);
        if (this.gaps.length > SAMPLES) this.gaps.shift();
      }
    }
    this.down = now;
    clearTimeout(this.letterTimer);
    clearTimeout(this.wordTimer);
    this.events.push({ t0: now, t1: 0, dit: true });
    if (this.hooks.mark) this.hooks.mark(true, now);
  };

  Keyer.prototype.release = function (now) {
    if (!this.down) return;
    const held = now - this.down;
    const dit = held < this.unit * DAH_AT;
    const event = this.events[this.events.length - 1];

    this.down = 0;
    event.t1 = now;
    event.dit = dit;
    this.code += dit ? "." : "-";
    if (dit) {
      this.dits.push(held);
      if (this.dits.length > SAMPLES) this.dits.shift();
    }

    this.lastUp = now;
    const self = this;
    this.letterTimer = setTimeout(() => { self.commitLetter(); }, this.letterAt);
    this.wordTimer = setTimeout(() => { self.commitWord(); }, this.wordAt);
    if (this.hooks.mark) this.hooks.mark(false, now);
    if (this.hooks.change) this.hooks.change();
  };

  Keyer.prototype.commitLetter = function () {
    if (!this.code) return;
    const code = this.code;
    this.code = "";
    if (this.hooks.char) this.hooks.char(CHAR_OF[code] || null, code);
    if (this.hooks.change) this.hooks.change();
  };

  Keyer.prototype.commitWord = function () {
    if (this.hooks.space) this.hooks.space();
    if (this.hooks.change) this.hooks.change();
  };

  /* Clears the pattern part way through, or reports that there is none and the
     page should take back whatever it last committed. */
  Keyer.prototype.rub = function () {
    const partial = this.code !== "";
    this.code = "";
    clearTimeout(this.letterTimer);
    clearTimeout(this.wordTimer);
    if (this.hooks.change) this.hooks.change();
    return partial;
  };

  Keyer.prototype.reset = function () {
    clearTimeout(this.letterTimer);
    clearTimeout(this.wordTimer);
    this.code = "";
    this.events = [];
    this.dits = [];
    this.gaps = [];
    this.down = 0;
    this.lastUp = 0;
  };

  /* The reader's own timing over the rolling dozen the key keeps, rounded to
     whole words a minute because what it is read against is a dial. The reading
     itself is readHand's, so a page that measures a longer stretch gets the same
     arithmetic rather than its own copy of it. */
  Keyer.prototype.hand = function () {
    const raw = readHand({ dits: this.dits, gaps: this.gaps });
    if (!raw) return null;
    const wpm = Math.round(raw.wpm);
    return {
      wpm: wpm,
      spacing: raw.spacing ? Math.min(wpm, Math.max(3, Math.round(raw.spacing))) : 0,
    };
  };

  /* What leaves the module. DAH_AT, STALE, CODES, INTRA_GAP, WORD_GAP and
     timing() are all still here, inside — they are how the code works, not
     things a page has to know. They were on this list while Morse Bench was
     rebuilding the hand reading out of them, which is what samples() and
     readHand() are for. */
  return {
    TABLE: TABLE,
    ALIAS: ALIAS,
    GROUPS: GROUPS,
    CHAR_OF: CHAR_OF,
    LETTER_GAP: LETTER_GAP,
    pretty: pretty,
    fitting: fitting,
    median: median,
    isError: isError,
    costOf: costOf,
    wpmOf: wpmOf,
    samples: samples,
    readHand: readHand,
    Sidetone: Sidetone,
    Keyer: Keyer,
  };
})();
