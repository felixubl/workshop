/* The format an agent writes a song in, and how it becomes a tracker song.

   The saved format in song.js is built to be small: a pattern is a sparse map
   keyed by `row * 4 + channel`, a cell is the positional tuple
   `[note, instrument, volume, effect, param]`, notes are MIDI integers,
   instruments are indices into a list, and an effect parameter is one byte
   usually written in hex. All of that is right for a file that has to stay a
   few kilobytes, and all of it is wrong for something composing without ears.
   Every one of those is a silent failure: an off-by-four lands a bass note on
   the noise channel, `0x37` written as `37` detunes an arpeggio by three
   octaves, and an instrument index that slipped by one plays the snare patch
   on the lead.

   So this module is a second dialect of the same song, and nothing more than a
   dialect — it compiles to the real thing and hands it to the real player.
   Channels, instruments and patterns are named rather than numbered, notes are
   written the way the tracker prints them, effects carry named parameters, and
   anything the compiler cannot make sense of is an error with a position
   rather than a clamp. Misspelling a key is an error too, because `instuments`
   silently renders a minute of silence and that is the least useful thing this
   server could do.

   compile() goes to the canonical song; decompile() comes back, so a song a
   human saved from the page can be read, edited and written out again. */

import { APU, Song } from './engine.mjs';

export const CHANNELS = ['pulse1', 'pulse2', 'triangle', 'noise'];

/* What each channel can actually do. The compiler quotes these back when a
   song asks for something a channel does not have — a volume ramp on the
   triangle, a tune on the noise. */
export const CHANNEL_NOTES = {
  pulse1: 'Pulse. Four duty cycles, volume 0-15, notes A-1 to B-7.',
  pulse2: 'Pulse. Identical to pulse1; the second voice for harmony or a second part.',
  triangle: 'Triangle. 32 fixed levels and NO volume control: volume gates it on or off, it cannot fade. Reaches an octave lower than the pulses.',
  noise: 'Noise. No pitch at all — 16 timbres. Only note % 12 picks one, the octave is ignored. duty bit 0 picks the long 32767-step run or the short 93-step metallic one.',
};

const NOTE_LETTERS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/* The three noise notes the page's own demo drums with, kept as words because
   "kick" is what an agent means and C-3 is only how the chip spells it. */
export const DRUM_ALIASES = { kick: 48, snare: 60, hat: 62, hihat: 62 };

/* ── Notes ─────────────────────────────────────────────────────────────────── */

/* Accepted: the tracker's own spelling ("C-4", "A#3"), the same without the
   filler dash ("C4"), flats ("Bb3"), a plain MIDI integer, and "OFF" for the
   note-off that stops a note ringing. Octave 0-7, which is MIDI 12 to 107 —
   the range an 11-bit timer can address. */
export function parseNote(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('note ' + value + ' is not a whole number');
    if (value === APU.NOTE_OFF) return APU.NOTE_OFF;
    if (value < APU.NOTE_MIN || value > APU.NOTE_MAX) {
      throw new Error('note ' + value + ' is outside MIDI ' + APU.NOTE_MIN + '-' + APU.NOTE_MAX +
        ' (C-0 to B-7). Middle C is 60.');
    }
    return value;
  }

  if (typeof value !== 'string') throw new Error('a note is a string like "C-4" or a MIDI number, not ' + typeof value);

  const raw = value.trim();
  const low = raw.toLowerCase();
  if (low === 'off' || low === '===' || low === '---' || low === 'stop') return APU.NOTE_OFF;
  if (Object.prototype.hasOwnProperty.call(DRUM_ALIASES, low)) return DRUM_ALIASES[low];
  if (/^-?\d+$/.test(raw)) return parseNote(Number(raw));

  const m = /^([A-Ga-g])\s*([#b\-s]?)\s*(-?\d)$/.exec(raw);
  if (!m) {
    throw new Error('cannot read the note ' + JSON.stringify(value) +
      '. Write it as letter + accidental + octave, like "C-4", "A#3", "Bb2" or "F-5"; ' +
      '"OFF" stops a ringing note; "kick", "snare" and "hat" are shorthand on the noise channel.');
  }

  let semi = NOTE_LETTERS[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === 's') semi += 1;
  else if (m[2] === 'b') semi -= 1;

  const octave = Number(m[3]);
  const note = (octave + 1) * 12 + semi;
  if (note < APU.NOTE_MIN || note > APU.NOTE_MAX) {
    throw new Error('note ' + raw + ' is MIDI ' + note + ', outside the tracker range C-0 to B-7.');
  }
  return note;
}

export function formatNote(n) {
  return APU.noteName(n);
}

/* ── Effects ───────────────────────────────────────────────────────────────── */

/* The same nine effects song.js defines, given names and named parameters so
   nobody has to pack a nibble pair by hand. The raw tracker spelling
   ({ effect: "4", param: "36" }) still works for anyone who thinks in it. */
export const NAMED_EFFECTS = {
  arpeggio: {
    letter: '0',
    params: { x: [0, 15], y: [0, 15] },
    pack: (p) => ((p.x & 15) << 4) | (p.y & 15),
    note: 'The note, then x semitones above, then y, one per frame. The only way to hear a chord on one channel. A minor triad is x=3 y=7, a major one x=4 y=7.',
  },
  slideUp: {
    letter: '1', params: { rate: [0, 255] }, pack: (p) => p.rate,
    note: 'Bend up by rate timer periods every frame. The units are periods, not cents, so the same rate bends further at the top of the keyboard.',
  },
  slideDown: {
    letter: '2', params: { rate: [0, 255] }, pack: (p) => p.rate,
    note: 'Bend down by rate every frame.',
  },
  portamento: {
    letter: '3', params: { rate: [0, 255] }, pack: (p) => p.rate,
    note: "Slide to this row's note at rate per frame instead of retriggering it. Leaves the instrument's sequences running.",
  },
  vibrato: {
    letter: '4', params: { speed: [0, 15], depth: [0, 15] },
    pack: (p) => ((p.speed & 15) << 4) | (p.depth & 15),
    note: 'Speed and depth, 0-15 each. speed 0 depth 0 turns it off.',
  },
  jump: {
    letter: 'B', params: { to: [0, 127] }, pack: (p) => p.to,
    note: 'Carry on at this position in the order. Position, not pattern name.',
  },
  break: {
    letter: 'D', params: { toRow: [0, 127] }, pack: (p) => p.toRow,
    note: 'End the pattern here and start the next one at this row. Named "toRow" because "row" is already the event\'s own position.',
  },
  setSpeed: {
    letter: 'F', params: { frames: [1, 31] }, pack: (p) => p.frames,
    note: 'Frames per row from here on, to the end of the song or the next one of these.',
  },
  halt: {
    letter: 'C', params: {}, pack: () => 0,
    note: 'Stop. The render ends here rather than looping.',
  },
};

const EFFECT_ALIASES = {
  arp: 'arpeggio', vibrato_: 'vibrato', vib: 'vibrato',
  slideup: 'slideUp', slidedown: 'slideDown', porta: 'portamento',
  patternbreak: 'break', speed: 'setSpeed', tempo: 'setSpeed',
};

const BY_LETTER = {};
for (const [name, def] of Object.entries(NAMED_EFFECTS)) BY_LETTER[def.letter] = name;

/* ── Helpers for readable complaints ───────────────────────────────────────── */

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function nearest(key, known) {
  let best = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = distance(key.toLowerCase(), k.toLowerCase());
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= Math.max(2, Math.ceil(key.length / 3)) ? best : null;
}

/* A misspelled key is the one mistake that produces no error and no sound, so
   it gets caught here rather than being quietly ignored by the reader. */
function checkKeys(obj, known, where, errors) {
  for (const key of Object.keys(obj)) {
    if (known.includes(key)) continue;
    const guess = nearest(key, known);
    errors.push(where + ': unknown field ' + JSON.stringify(key) +
      (guess ? '. Did you mean ' + JSON.stringify(guess) + '?' : '. Known fields: ' + known.join(', ')));
  }
}

function int(value, lo, hi, where, what, errors, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    errors.push(where + ': ' + what + ' must be a whole number, got ' + JSON.stringify(value));
    return fallback;
  }
  if (n < lo || n > hi) {
    errors.push(where + ': ' + what + ' must be ' + lo + '-' + hi + ', got ' + n);
    return fallback;
  }
  return n;
}

function readSequence(raw, loopRaw, lo, hi, where, what, errors) {
  if (raw === null || raw === undefined) return Song.makeSequence([], -1);
  if (!Array.isArray(raw)) {
    errors.push(where + ': ' + what + ' must be an array of one value per frame, got ' + typeof raw);
    return Song.makeSequence([], -1);
  }
  const data = raw.map((v, i) => int(v, lo, hi, where, what + '[' + i + ']', errors, 0));
  let loop = -1;
  if (loopRaw !== null && loopRaw !== undefined) {
    loop = int(loopRaw, -1, Math.max(-1, data.length - 1), where, what + 'Loop', errors, -1);
    if (!data.length && loop >= 0) {
      errors.push(where + ': ' + what + 'Loop is set but ' + what + ' is empty.');
      loop = -1;
    }
  }
  return Song.makeSequence(data, loop);
}

/* ── Compiling ─────────────────────────────────────────────────────────────── */

const SONG_KEYS = ['title', 'speed', 'bpm', 'rowsPerBeat', 'instruments', 'patterns', 'order'];
const INSTRUMENT_KEYS = [
  'name', 'duty', 'dutySequence', 'dutySequenceLoop',
  'volume', 'volumeLoop', 'arpeggio', 'arpeggioLoop', 'pitch', 'pitchLoop',
];
const PATTERN_KEYS = ['name', 'rows', ...CHANNELS];
const EVENT_KEYS = ['row', 'note', 'instrument', 'volume', 'effect', 'param',
  'x', 'y', 'rate', 'speed', 'depth', 'to', 'toRow', 'frames'];

function compileEffect(event, where, errors) {
  if (event.effect === null || event.effect === undefined || event.effect === '') return { fx: '', fp: 0 };

  const given = String(event.effect).trim();
  let name = Object.prototype.hasOwnProperty.call(NAMED_EFFECTS, given) ? given : null;
  if (!name) {
    const alias = EFFECT_ALIASES[given.toLowerCase()];
    if (alias) name = alias;
  }

  /* The raw tracker spelling: a letter and a byte. The byte must be a string of
     hex digits, because `param: 37` cannot be told apart from `param: "37"`
     meaning 0x37 and guessing would detune an arpeggio by three octaves. */
  if (!name && Object.prototype.hasOwnProperty.call(BY_LETTER, given.toUpperCase())) {
    const letter = given.toUpperCase();
    const p = event.param;
    if (p === null || p === undefined) return { fx: letter, fp: 0 };
    if (typeof p !== 'string' || !/^[0-9a-fA-F]{1,2}$/.test(p.trim())) {
      errors.push(where + ': with the raw effect letter "' + letter + '", param must be one or two hex' +
        ' digits as a STRING, like "37". Got ' + JSON.stringify(p) + '. Easier: use the named form, ' +
        '{ "effect": "' + BY_LETTER[letter] + '", ... }.');
      return { fx: letter, fp: 0 };
    }
    return { fx: letter, fp: parseInt(p.trim(), 16) };
  }

  if (!name) {
    const guess = nearest(given, Object.keys(NAMED_EFFECTS));
    errors.push(where + ': unknown effect ' + JSON.stringify(event.effect) +
      (guess ? '. Did you mean ' + JSON.stringify(guess) + '?' : '') +
      ' Effects: ' + Object.keys(NAMED_EFFECTS).join(', ') + '.');
    return { fx: '', fp: 0 };
  }

  const def = NAMED_EFFECTS[name];
  const packed = {};
  for (const [field, [lo, hi]] of Object.entries(def.params)) {
    if (event[field] === null || event[field] === undefined) {
      errors.push(where + ': effect "' + name + '" needs "' + field + '" (' + lo + '-' + hi + '). ' + def.note);
      packed[field] = lo;
      continue;
    }
    packed[field] = int(event[field], lo, hi, where, 'effect "' + name + '" field "' + field + '"', errors, lo);
  }
  if (event.param !== undefined && event.param !== null) {
    errors.push(where + ': effect "' + name + '" takes ' +
      (Object.keys(def.params).length ? Object.keys(def.params).map((f) => '"' + f + '"').join(' and ') : 'no parameters') +
      ', not "param". Drop "param".');
  }
  return { fx: def.letter, fp: def.pack(packed) & 255 };
}

/* Resolve a name-or-index reference against a list, which is how instruments
   are addressed in a pattern and patterns in the order. A name that is not
   there is an error rather than index 0, because playing the wrong instrument
   is harder to notice than playing nothing. */
function resolve(ref, names, kind, where, errors) {
  if (ref === null || ref === undefined) return -1;
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref < 0 || ref >= names.length) {
      errors.push(where + ': ' + kind + ' index ' + ref + ' does not exist (there are ' + names.length + ').');
      return -1;
    }
    return ref;
  }
  if (typeof ref !== 'string') {
    errors.push(where + ': ' + kind + ' must be a name or an index, got ' + typeof ref);
    return -1;
  }
  const at = names.indexOf(ref);
  if (at >= 0) return at;
  const ci = names.findIndex((n) => n.toLowerCase() === ref.toLowerCase());
  if (ci >= 0) return ci;
  const guess = nearest(ref, names);
  errors.push(where + ': no ' + kind + ' named ' + JSON.stringify(ref) +
    (guess ? '. Did you mean ' + JSON.stringify(guess) + '?' : '. Defined: ' + (names.join(', ') || 'none')));
  return -1;
}

export function compile(input) {
  const errors = [];
  const warnings = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { song: null, errors: ['a song is a JSON object with "instruments", "patterns" and "order".'], warnings, meta: {} };
  }
  checkKeys(input, SONG_KEYS, 'song', errors);

  const song = Song.blankSong();
  song.title = String(input.title === undefined ? 'untitled' : input.title).slice(0, 60);
  song.highlight = int(input.rowsPerBeat, 1, 16, 'song', 'rowsPerBeat', errors, 4);

  /* A row lasts a whole number of video frames, so most tempos do not exist on
     this chip. Either number may be given; what comes back says what was
     actually possible. */
  const meta = {};
  if (input.bpm !== undefined && input.bpm !== null) {
    const wanted = Number(input.bpm);
    if (!Number.isFinite(wanted) || wanted <= 0) {
      errors.push('song: bpm must be a positive number, got ' + JSON.stringify(input.bpm));
      song.speed = 6;
    } else {
      song.speed = Song.speedFor(wanted, song.highlight);
      meta.requestedBpm = wanted;
    }
    if (input.speed !== undefined && input.speed !== null) {
      errors.push('song: give either "bpm" or "speed", not both. speed is frames per row; bpm is derived from it.');
    }
  } else {
    song.speed = int(input.speed, 1, 31, 'song', 'speed', errors, 6);
  }

  /* ── Instruments ── */
  const rawInstruments = input.instruments;
  if (!Array.isArray(rawInstruments) || !rawInstruments.length) {
    errors.push('song: "instruments" must be a non-empty array. Every note names one.');
  }
  const instruments = Array.isArray(rawInstruments) ? rawInstruments : [];
  if (instruments.length > Song.MAX_INSTRUMENTS) {
    errors.push('song: ' + instruments.length + ' instruments, the limit is ' + Song.MAX_INSTRUMENTS + '.');
  }

  const instNames = [];
  song.instruments = instruments.slice(0, Song.MAX_INSTRUMENTS).map((raw, n) => {
    const where = 'instruments[' + n + ']' + (raw && raw.name ? ' "' + raw.name + '"' : '');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(where + ': an instrument is an object with a "name" and a "volume" sequence.');
      instNames.push('instrument ' + n);
      return Song.makeInstrument('instrument ' + n);
    }
    checkKeys(raw, INSTRUMENT_KEYS, where, errors);

    const name = String(raw.name === undefined ? 'instrument ' + n : raw.name).slice(0, 24);
    if (instNames.includes(name)) {
      warnings.push(where + ': a second instrument is also called "' + name + '". Patterns that name it get the first one.');
    }
    instNames.push(name);

    const out = Song.makeInstrument(name);
    if (Array.isArray(raw.duty)) {
      errors.push(where + ': "duty" is the single fallback waveform (0-3). ' +
        'For a waveform that changes frame by frame use "dutySequence".');
      out.duty = 2;
    } else {
      out.duty = int(raw.duty, 0, 3, where, 'duty', errors, 2);
    }
    out.vol = readSequence(raw.volume, raw.volumeLoop, 0, 15, where, 'volume', errors);
    out.arp = readSequence(raw.arpeggio, raw.arpeggioLoop, -96, 96, where, 'arpeggio', errors);
    out.pitch = readSequence(raw.pitch, raw.pitchLoop, -128, 127, where, 'pitch', errors);
    out.duty_ = readSequence(raw.dutySequence, raw.dutySequenceLoop, 0, 3, where, 'dutySequence', errors);

    if (!out.vol.data.length) {
      out.vol = Song.makeSequence([15], -1);
      warnings.push(where + ': no "volume" sequence, so it holds full volume forever. ' +
        'A volume sequence is what gives this chip an envelope: [15,12,9,6,3,0] decays, [15] sustains.');
    }
    return out;
  });
  if (!song.instruments.length) song.instruments = [Song.makeInstrument('pulse')];

  /* ── Patterns ── */
  const rawPatterns = input.patterns;
  if (!Array.isArray(rawPatterns) || !rawPatterns.length) {
    errors.push('song: "patterns" must be a non-empty array.');
  }
  const patterns = Array.isArray(rawPatterns) ? rawPatterns : [];
  if (patterns.length > Song.MAX_PATTERNS) {
    errors.push('song: ' + patterns.length + ' patterns, the limit is ' + Song.MAX_PATTERNS + '.');
  }

  const patNames = [];
  const used = new Set();
  song.patterns = patterns.slice(0, Song.MAX_PATTERNS).map((raw, n) => {
    const label = raw && raw.name ? ' "' + raw.name + '"' : '';
    const where = 'patterns[' + n + ']' + label;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(where + ': a pattern is an object with "rows" and one array per channel (' + CHANNELS.join(', ') + ').');
      patNames.push('pattern ' + n);
      return Song.makePattern(64);
    }
    checkKeys(raw, PATTERN_KEYS, where, errors);

    patNames.push(String(raw.name === undefined ? 'pattern ' + n : raw.name).slice(0, 40));
    const rows = int(raw.rows, Song.MIN_ROWS, Song.MAX_ROWS, where, 'rows', errors, 64);
    const pat = Song.makePattern(rows);

    let anyEvent = false;
    for (let c = 0; c < CHANNELS.length; c++) {
      const channel = CHANNELS[c];
      const events = raw[channel];
      if (events === null || events === undefined) continue;
      if (!Array.isArray(events)) {
        errors.push(where + '.' + channel + ': must be an array of events, got ' + typeof events +
          '. An event is { "row": 0, "note": "C-4", "instrument": "bass" }.');
        continue;
      }

      const takenRows = new Map();
      for (let e = 0; e < events.length; e++) {
        const ev = events[e];
        const at = where + '.' + channel + '[' + e + ']';
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
          errors.push(at + ': an event is an object like { "row": 0, "note": "C-4", "instrument": "lead" }.');
          continue;
        }
        checkKeys(ev, EVENT_KEYS, at, errors);

        if (ev.row === undefined || ev.row === null) {
          errors.push(at + ': every event needs a "row" (0-' + (rows - 1) + ').');
          continue;
        }
        const row = int(ev.row, 0, rows - 1, at, 'row', errors, -1);
        if (row < 0) continue;

        /* One cell per row per channel: the chip is monophonic there. Two
           events on the same row would silently keep the last one, and an
           agent writing a chord on one channel needs telling that the arpeggio
           effect is how that is done. */
        if (takenRows.has(row)) {
          errors.push(at + ': row ' + row + ' on ' + channel + ' already has an event (' +
            takenRows.get(row) + '). Each channel plays one note at a time — for a chord on one channel use ' +
            'the "arpeggio" effect, or put the other notes on another channel.');
          continue;
        }
        takenRows.set(row, at);

        const cell = Song.emptyCell();

        if (ev.note !== undefined && ev.note !== null) {
          try {
            cell.n = parseNote(ev.note);
            if (typeof ev.note === 'string' &&
                Object.prototype.hasOwnProperty.call(DRUM_ALIASES, ev.note.trim().toLowerCase()) &&
                channel !== 'noise') {
              warnings.push(at + ': "' + ev.note + '" is shorthand for a noise timbre but this is ' +
                channel + ', where it is the pitch ' + formatNote(cell.n) + '.');
            }
          } catch (err) {
            errors.push(at + ': ' + err.message);
          }
        }

        cell.i = resolve(ev.instrument, instNames, 'instrument', at, errors);
        if (cell.i >= 0) used.add(cell.i);
        cell.v = ev.volume === undefined || ev.volume === null
          ? -1
          : int(ev.volume, 0, 15, at, 'volume', errors, -1);

        const fx = compileEffect(ev, at, errors);
        cell.fx = fx.fx;
        cell.fp = fx.fp;

        if (Song.cellIsEmpty(cell)) {
          warnings.push(at + ': nothing in this event but a row number, so it does nothing.');
          continue;
        }
        pat.data[row * 4 + c] = cell;
        anyEvent = true;
      }
    }
    if (!anyEvent) warnings.push(where + ': no events at all, so it plays ' + rows + ' rows of silence.');
    return pat;
  });
  if (!song.patterns.length) song.patterns = [Song.makePattern(64)];

  /* ── Order ── */
  const rawOrder = input.order;
  if (rawOrder === undefined || rawOrder === null) {
    song.order = song.patterns.map((_, i) => i);
    warnings.push('song: no "order", so the patterns play once each in the order they are written.');
  } else if (!Array.isArray(rawOrder) || !rawOrder.length) {
    errors.push('song: "order" must be a non-empty array of pattern names, in the order they play. ' +
      'Repeats are how a song is built: ["verse","verse","chorus"].');
    song.order = [0];
  } else {
    if (rawOrder.length > Song.MAX_ORDER) {
      errors.push('song: the order is ' + rawOrder.length + ' long, the limit is ' + Song.MAX_ORDER + '.');
    }
    song.order = rawOrder.slice(0, Song.MAX_ORDER)
      .map((ref, i) => resolve(ref, patNames, 'pattern', 'order[' + i + ']', errors))
      .filter((n) => n >= 0);
    if (!song.order.length) song.order = [0];
  }

  for (let i = 0; i < patNames.length; i++) {
    if (!song.order.includes(i)) {
      warnings.push('patterns[' + i + '] "' + patNames[i] + '" is never in the order, so it is never heard.');
    }
  }
  for (let i = 0; i < instNames.length; i++) {
    if (!used.has(i)) warnings.push('instruments[' + i + '] "' + instNames[i] + '" is never named by a note.');
  }

  meta.instrumentNames = instNames;
  meta.patternNames = patNames;
  meta.bpm = Song.bpmFor(song.speed, song.highlight);

  return { song: errors.length ? null : song, errors, warnings, meta };
}

/* ── Decompiling ───────────────────────────────────────────────────────────── */

/* The way back, so a song saved from the page can be read and edited here.
   References come out as names where a name is unambiguous and as indices
   where two things share one, which is the only way round-tripping a
   hand-edited file cannot change which instrument plays. */
export function decompile(song, names) {
  const instNames = (names && names.instruments) || song.instruments.map((ins) => ins.name);
  const patNames = (names && names.patterns) || song.patterns.map((_, i) => 'pattern ' + i);

  const unique = (list, i) => list.filter((n) => n === list[i]).length === 1 ? list[i] : i;

  const out = {
    title: song.title,
    speed: song.speed,
    rowsPerBeat: song.highlight,
    instruments: song.instruments.map((ins) => {
      const o = { name: ins.name, duty: ins.duty, volume: ins.vol.data.slice() };
      if (ins.vol.loop >= 0) o.volumeLoop = ins.vol.loop;
      if (ins.arp.data.length) { o.arpeggio = ins.arp.data.slice(); if (ins.arp.loop >= 0) o.arpeggioLoop = ins.arp.loop; }
      if (ins.pitch.data.length) { o.pitch = ins.pitch.data.slice(); if (ins.pitch.loop >= 0) o.pitchLoop = ins.pitch.loop; }
      if (ins.duty_.data.length) { o.dutySequence = ins.duty_.data.slice(); if (ins.duty_.loop >= 0) o.dutySequenceLoop = ins.duty_.loop; }
      return o;
    }),
    patterns: song.patterns.map((pat, p) => {
      const o = { name: patNames[p], rows: pat.rows };
      for (let c = 0; c < CHANNELS.length; c++) {
        const events = [];
        for (let row = 0; row < pat.rows; row++) {
          const cell = pat.data[row * 4 + c];
          if (Song.cellIsEmpty(cell)) continue;
          const ev = { row: row };
          if (cell.n !== -1) ev.note = formatNote(cell.n);
          if (cell.i >= 0) ev.instrument = unique(instNames, cell.i);
          if (cell.v >= 0) ev.volume = cell.v;
          if (cell.fx) {
            const name = BY_LETTER[cell.fx];
            const def = name && NAMED_EFFECTS[name];
            if (def) {
              ev.effect = name;
              const fields = Object.keys(def.params);
              if (fields.length === 2) {
                ev[fields[0]] = (cell.fp >> 4) & 15;
                ev[fields[1]] = cell.fp & 15;
              } else if (fields.length === 1) {
                ev[fields[0]] = cell.fp;
              }
            } else {
              ev.effect = cell.fx;
              ev.param = cell.fp.toString(16).toUpperCase().padStart(2, '0');
            }
          }
          events.push(ev);
        }
        if (events.length) o[CHANNELS[c]] = events;
      }
      return o;
    }),
    order: song.order.map((i) => unique(patNames, i)),
  };
  return out;
}
