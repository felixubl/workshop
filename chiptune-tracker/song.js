/* Chiptune Tracker: what a song is, and how it survives the tab closing.

   A song is four things: a list of instruments, a list of patterns, an order
   that plays those patterns, and one speed. There is no sample data and no
   audio in a saved file — the whole tune is a few kilobytes of integers,
   because everything that makes a sound is computed from them.

   Nothing here makes noise. apu.js reads this; script.js edits it. */

;(function (root) {
  "use strict";

  const APU = root.APU;

  const MAX_PATTERNS = 64;
  const MAX_INSTRUMENTS = 32;
  const MAX_ROWS = 128;
  const MIN_ROWS = 4;
  const MAX_ORDER = 128;

  /* The effect column, and the whole of it. Each is one letter and two hex
     digits, the notation every tracker has used since Amiga ProTracker, so a
     pattern reads the same here as it does anywhere else. */
  const EFFECTS = {
    "0": { syntax: "0xy", name: "Arpeggio", help: "The note, then x semitones above it, then y, one per frame. The only way to hear a chord on one channel." },
    "1": { syntax: "1xx", name: "Slide up", help: "Bend up by xx every frame. The units are timer periods, not cents, so the same xx bends further at the top of the keyboard." },
    "2": { syntax: "2xx", name: "Slide down", help: "Bend down by xx every frame." },
    "3": { syntax: "3xx", name: "Portamento", help: "Slide to this row's note at xx per frame rather than retriggering it. Leaves the instrument's sequences where they were." },
    "4": { syntax: "4xy", name: "Vibrato", help: "Speed x, depth y. 400 turns it off." },
    "B": { syntax: "Bxx", name: "Jump", help: "Carry on at position xx in the order." },
    "D": { syntax: "Dxx", name: "Break", help: "End the pattern here and start the next one at row xx." },
    "F": { syntax: "Fxx", name: "Speed", help: "xx frames per row, from here to the end of the song or the next Fxx." },
    "C": { syntax: "Cxx", name: "Halt", help: "Stop. The export ends here; playback stops rather than looping." },
  };

  function emptyCell() {
    return { n: -1, i: -1, v: -1, fx: "", fp: 0 };
  }

  /* A note-off is content, not the absence of it: it is the instruction that
     stops a note ringing. Testing `n < 0` here rather than `n === -1` would
     drop every one of them on save and leave the song sustaining through its
     own rests. */
  function cellIsEmpty(c) {
    return !c || (c.n === -1 && c.i < 0 && c.v < 0 && !c.fx);
  }

  function makePattern(rows) {
    return { rows: rows, data: new Array(rows * 4).fill(null) };
  }

  function makeSequence(data, loop) {
    return { data: data ? data.slice() : [], loop: loop === undefined ? -1 : loop };
  }

  /* An instrument is the same object on all four channels. Duty selects the
     pulse waveform, and on the noise channel its low bit picks the long
     32767-step run or the short 93-step one; the triangle ignores it, having
     nothing to select. This is how the chip's own instruments worked, and it
     means an instrument can be moved between channels to hear what it becomes. */
  function makeInstrument(name) {
    return {
      name: name || "instrument",
      duty: 2,
      vol: makeSequence([15]),
      arp: makeSequence([]),
      pitch: makeSequence([]),
      duty_: makeSequence([]),
    };
  }

  /* apu.js reads the duty sequence as `inst.duty`, which is also the name of
     the single fallback value. Kept apart here and joined on the way out, so
     the editor can hold both without one shadowing the other. */
  function forPlayback(song) {
    return {
      speed: song.speed,
      order: song.order,
      patterns: song.patterns,
      instruments: song.instruments.map(function (ins) {
        return {
          duty: ins.duty,
          vol: ins.vol,
          arp: ins.arp,
          pitch: ins.pitch,
          dutySeq: ins.duty_,
        };
      }),
    };
  }

  function blankSong() {
    const song = {
      title: "untitled",
      speed: 6,
      highlight: 4,
      instruments: [makeInstrument("pulse")],
      patterns: [makePattern(64)],
      order: [0],
    };
    return song;
  }

  /* ── Tempo ─────────────────────────────────────────────────────────────────

     A row lasts a whole number of video frames and nothing finer, so a tracker
     on this chip cannot play at an arbitrary tempo. Speed 6 is 150.2 BPM and
     speed 7 is 128.8; there is nothing in between. The page states the tempo it
     actually got rather than the one that was asked for. */

  function bpmFor(speed, highlight) {
    return (APU.FRAME_HZ * 60) / (speed * (highlight || 4));
  }

  function speedFor(bpm, highlight) {
    const s = Math.round((APU.FRAME_HZ * 60) / (bpm * (highlight || 4)));
    return Math.max(1, Math.min(31, s));
  }

  /* ── The demo ──────────────────────────────────────────────────────────────

     A tune loaded on first open, so the page makes a sound before anything is
     typed and so every part of the engine is exercised by something audible:
     arpeggiated chords on one pulse, a lead with vibrato on the other, a bass
     on the triangle, and drums built out of noise and a falling pitch sequence.
     Written as sparse rows — [row, note, instrument, volume, effect, param] —
     because a pattern is mostly empty and a table of nulls would not be. */

  const N = {
    // Written as MIDI numbers: C-4 is 60, and A-4 is 440 Hz.
    A2: 45, G2: 43, F2: 41, E2: 40, C3: 48, D3: 50, E3: 52, F3: 53, G3: 55, A3: 57, B3: 59,
    C4: 60, D4: 62, E4: 64, F4: 65, Fs4: 66, G4: 67, A4: 69, B4: 71, C5: 72, D5: 74, E5: 76,
    // On the noise channel a note picks one of sixteen periods. These three are
    // the ones the drums use: deepest, bright, brightest.
    KICK: 48, SNARE: 60, HAT: 62,
  };

  const LEAD = 0, ARP = 1, BASS = 2, KICK = 3, SNARE = 4, HAT = 5;

  function demoInstruments() {
    const lead = makeInstrument("lead");
    lead.duty = 2;
    lead.vol = makeSequence([15, 15, 14, 13, 12, 12, 11, 11, 10]);
    // A pulse that changes duty on the attack reads as a pluck rather than as
    // an organ, and costs nothing but four numbers.
    lead.duty_ = makeSequence([1, 1, 2]);

    const arp = makeInstrument("chord");
    arp.duty = 1;
    arp.vol = makeSequence([12, 11, 10, 10, 9, 9, 8, 8, 7]);

    const bass = makeInstrument("bass");
    bass.duty = 0;
    bass.vol = makeSequence([15]);

    const kick = makeInstrument("kick");
    kick.duty = 0;
    kick.vol = makeSequence([15, 15, 14, 12, 9, 5, 0]);

    const snare = makeInstrument("snare");
    snare.duty = 0;
    snare.vol = makeSequence([15, 14, 12, 11, 9, 7, 5, 3, 2, 1, 0]);

    const hat = makeInstrument("hat");
    hat.duty = 1;
    hat.vol = makeSequence([9, 5, 2, 0]);

    return [lead, arp, bass, kick, snare, hat];
  }

  function drums(fill) {
    const rows = [
      [0, N.KICK, KICK, 15], [2, N.HAT, HAT, 15], [4, N.SNARE, SNARE, 15],
      [6, N.HAT, HAT, 15], [8, N.KICK, KICK, 15], [10, N.HAT, HAT, 15],
      [11, N.KICK, KICK, 12], [12, N.SNARE, SNARE, 15], [14, N.HAT, HAT, 15],
    ];
    const out = [];
    for (let bar = 0; bar < 2; bar++) {
      for (const r of rows) out.push([r[0] + bar * 16, r[1], r[2], r[3]]);
    }
    if (fill) {
      out.push([26, N.SNARE, SNARE, 11], [28, N.SNARE, SNARE, 13], [30, N.SNARE, SNARE, 15]);
    }
    return out;
  }

  // Root, then the two arpeggio intervals that make the chord: 37 is a minor
  // triad, 47 a major one.
  function chord(row, note, shape) {
    return [row, note, ARP, 12, "0", shape];
  }

  const DEMO_PATTERNS = [
    // Am, F
    {
      rows: 32,
      lead: [
        [0, N.E4, LEAD, 15], [4, N.A4], [6, N.G4], [8, N.E4], [12, N.D4], [14, N.C4],
        [16, N.C4], [20, N.F4], [22, N.E4], [24, N.C4], [28, N.A3],
      ],
      arp: [chord(0, N.A3, 0x37), chord(8, N.A3, 0x37), chord(16, N.F3, 0x47), chord(24, N.F3, 0x47)],
      bass: [
        [0, N.A2, BASS, 15], [3, N.A2], [6, N.A3], [8, N.A2], [11, N.A2], [14, N.E3],
        [16, N.F2], [19, N.F2], [22, N.F3], [24, N.F2], [27, N.F2], [30, N.C3],
      ],
      noise: drums(false),
    },
    // C, G
    {
      rows: 32,
      lead: [
        [0, N.E4, LEAD, 15], [4, N.G4], [8, N.C5], [10, N.B4], [12, N.G4],
        [16, N.D4], [20, N.G4], [22, N.Fs4], [24, N.D4], [28, N.B3],
      ],
      arp: [chord(0, N.C4, 0x47), chord(8, N.C4, 0x47), chord(16, N.G3, 0x47), chord(24, N.G3, 0x47)],
      bass: [
        [0, N.C3, BASS, 15], [3, N.C3], [6, N.G3], [8, N.C3], [11, N.C3], [14, N.G2],
        [16, N.G2], [19, N.G2], [22, N.G3], [24, N.G2], [27, N.G2], [30, N.D3],
      ],
      noise: drums(false),
    },
    // Am, F — the lead takes the vibrato out for a walk
    {
      rows: 32,
      lead: [
        [0, N.A4, LEAD, 15], [2, N.C5], [4, N.B4], [6, N.A4],
        [8, N.E4, -1, -1, "4", 0x36], [14, -2],
        [16, N.F4, -1, -1, "4", 0x00], [20, N.A4], [24, N.C5, -1, -1, "4", 0x46], [31, -2],
      ],
      arp: [chord(0, N.A3, 0x37), chord(8, N.A3, 0x37), chord(16, N.F3, 0x47), chord(24, N.F3, 0x47)],
      bass: [
        [0, N.A2, BASS, 15], [3, N.A2], [6, N.A3], [8, N.A2], [11, N.A2], [14, N.E3],
        [16, N.F2], [19, N.F2], [22, N.F3], [24, N.F2], [27, N.F2], [30, N.C3],
      ],
      noise: drums(false),
    },
    // C, G — the turnaround, ending on the note the first pattern starts from
    {
      rows: 32,
      lead: [
        [0, N.C5, LEAD, 15], [4, N.B4], [8, N.G4], [12, N.E4],
        [16, N.D4], [20, N.B3], [24, N.A3, -1, -1, "4", 0x25], [31, -2],
      ],
      arp: [chord(0, N.C4, 0x47), chord(8, N.C4, 0x47), chord(16, N.G3, 0x47), chord(24, N.G3, 0x47)],
      bass: [
        [0, N.C3, BASS, 15], [3, N.C3], [6, N.G3], [8, N.C3], [11, N.C3], [14, N.G2],
        [16, N.G2], [19, N.G2], [22, N.G3], [24, N.G2], [27, N.G2], [30, N.G2],
      ],
      noise: drums(true),
    },
  ];

  function fillChannel(pat, channel, rows, fallbackInst) {
    let inst = fallbackInst;
    let vol = 15;
    for (const r of rows) {
      const row = r[0];
      if (row >= pat.rows) continue;
      if (r[2] !== undefined && r[2] >= 0) inst = r[2];
      if (r[3] !== undefined && r[3] >= 0) vol = r[3];
      const cell = emptyCell();
      cell.n = r[1] === undefined ? -1 : r[1];
      if (r[4]) { cell.fx = r[4]; cell.fp = r[5] || 0; }
      if (cell.n >= 0) { cell.i = inst; cell.v = vol; }
      pat.data[row * 4 + channel] = cell;
    }
  }

  /* Blank the instrument and volume columns wherever they only repeat what the
     channel is already holding. Done as a pass over the finished pattern rather
     than while writing it, because the rows above are listed in the order they
     were composed and a channel's state follows the order they are played in. */
  function tidy(pat) {
    for (let c = 0; c < 4; c++) {
      let inst = -1;
      let vol = -1;
      for (let row = 0; row < pat.rows; row++) {
        const cell = pat.data[row * 4 + c];
        if (!cell) continue;
        if (cell.i >= 0) {
          if (cell.i === inst) cell.i = -1;
          else inst = cell.i;
        }
        if (cell.v >= 0) {
          if (cell.v === vol) cell.v = -1;
          else vol = cell.v;
        }
      }
    }
    return pat;
  }

  function demoSong() {
    const song = blankSong();
    song.title = "eight bars in A minor";
    song.speed = 8;
    song.instruments = demoInstruments();
    song.patterns = DEMO_PATTERNS.map(function (p) {
      const pat = makePattern(p.rows);
      fillChannel(pat, 0, p.lead, LEAD);
      fillChannel(pat, 1, p.arp, ARP);
      fillChannel(pat, 2, p.bass, BASS);
      fillChannel(pat, 3, p.noise, KICK);
      return tidy(pat);
    });
    song.order = [0, 1, 2, 3];
    return song;
  }

  /* ── Saving ────────────────────────────────────────────────────────────────

     JSON, and sparse: a pattern is mostly empty, so only the cells that hold
     something are written. A song of the demo's size lands around four
     kilobytes. There is no server to save to, so the file is the save. */

  function serialise(song) {
    return {
      format: "workshop-chiptune",
      version: 1,
      title: song.title,
      speed: song.speed,
      highlight: song.highlight,
      order: song.order.slice(),
      instruments: song.instruments.map(function (ins) {
        return {
          name: ins.name,
          duty: ins.duty,
          vol: [ins.vol.data.slice(), ins.vol.loop],
          arp: [ins.arp.data.slice(), ins.arp.loop],
          pitch: [ins.pitch.data.slice(), ins.pitch.loop],
          dutySeq: [ins.duty_.data.slice(), ins.duty_.loop],
        };
      }),
      patterns: song.patterns.map(function (pat) {
        const cells = {};
        for (let i = 0; i < pat.data.length; i++) {
          const c = pat.data[i];
          if (cellIsEmpty(c)) continue;
          cells[i] = [c.n, c.i, c.v, c.fx, c.fp];
        }
        return { rows: pat.rows, cells: cells };
      }),
    };
  }

  function clamp(n, lo, hi, fallback) {
    n = Number(n);
    if (!isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }

  function readSequence(raw) {
    if (!Array.isArray(raw)) return makeSequence([]);
    const data = Array.isArray(raw[0]) ? raw[0] : [];
    const loop = clamp(raw[1], -1, data.length - 1, -1);
    return makeSequence(data.map(function (v) { return clamp(v, -128, 127, 0); }), loop);
  }

  /* Everything read from a file is clamped rather than trusted. A song is a
     file the reader can edit by hand, and a bad number should cost a note
     rather than the page. */
  function deserialise(raw) {
    if (!raw || typeof raw !== "object") throw new Error("not a song file");
    if (raw.format !== "workshop-chiptune") throw new Error("not a Chiptune Tracker file");

    const song = blankSong();
    song.title = String(raw.title || "untitled").slice(0, 60);
    song.speed = clamp(raw.speed, 1, 31, 6);
    song.highlight = clamp(raw.highlight, 1, 16, 4);

    const instruments = Array.isArray(raw.instruments) ? raw.instruments.slice(0, MAX_INSTRUMENTS) : [];
    song.instruments = instruments.map(function (ins, n) {
      const out = makeInstrument(String((ins && ins.name) || "instrument " + n).slice(0, 24));
      out.duty = clamp(ins && ins.duty, 0, 3, 2);
      out.vol = readSequence(ins && ins.vol);
      out.arp = readSequence(ins && ins.arp);
      out.pitch = readSequence(ins && ins.pitch);
      out.duty_ = readSequence(ins && ins.dutySeq);
      return out;
    });
    if (!song.instruments.length) song.instruments = [makeInstrument("pulse")];

    const patterns = Array.isArray(raw.patterns) ? raw.patterns.slice(0, MAX_PATTERNS) : [];
    song.patterns = patterns.map(function (p) {
      const rows = clamp(p && p.rows, MIN_ROWS, MAX_ROWS, 64);
      const pat = makePattern(rows);
      const cells = (p && p.cells) || {};
      for (const key in cells) {
        const at = Number(key);
        if (!isFinite(at) || at < 0 || at >= pat.data.length) continue;
        const c = cells[key];
        if (!Array.isArray(c)) continue;
        const cell = emptyCell();
        cell.n = clamp(c[0], -2, APU.NOTE_MAX, -1);
        cell.i = clamp(c[1], -1, song.instruments.length - 1, -1);
        cell.v = clamp(c[2], -1, 15, -1);
        cell.fx = EFFECTS[c[3]] ? c[3] : "";
        cell.fp = clamp(c[4], 0, 255, 0);
        pat.data[at] = cell;
      }
      return pat;
    });
    if (!song.patterns.length) song.patterns = [makePattern(64)];

    const order = Array.isArray(raw.order) ? raw.order.slice(0, MAX_ORDER) : [];
    song.order = order
      .map(function (n) { return clamp(n, 0, song.patterns.length - 1, 0); })
      .filter(function (n) { return n >= 0; });
    if (!song.order.length) song.order = [0];

    return song;
  }

  root.Song = {
    MAX_PATTERNS: MAX_PATTERNS,
    MAX_INSTRUMENTS: MAX_INSTRUMENTS,
    MAX_ROWS: MAX_ROWS,
    MIN_ROWS: MIN_ROWS,
    MAX_ORDER: MAX_ORDER,
    EFFECTS: EFFECTS,
    emptyCell: emptyCell,
    cellIsEmpty: cellIsEmpty,
    makePattern: makePattern,
    makeSequence: makeSequence,
    makeInstrument: makeInstrument,
    blankSong: blankSong,
    demoSong: demoSong,
    forPlayback: forPlayback,
    bpmFor: bpmFor,
    speedFor: speedFor,
    serialise: serialise,
    deserialise: deserialise,
  };
})(typeof window !== "undefined" ? window : globalThis);
