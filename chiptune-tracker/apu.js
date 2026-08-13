/* Chiptune Tracker: the sound chip and the player that drives it.

   This is the audio half of the Ricoh 2A03 — the NES sound hardware — written
   as arithmetic rather than played back from samples: two pulse channels with
   four duty cycles, a triangle stepping through 32 fixed levels, and noise
   tapped off a 15-bit shift register. Every pitch on the chip is a divider off
   one 1.789773 MHz clock, so a note is not a frequency here but an integer
   period, and the rounding that follows is audible. That rounding is the sound.

   Nothing in this file touches the DOM or the Web Audio API. It takes a song
   and hands back a buffer of samples, which is what the page plays and what the
   WAV writer at the foot of the file exports. The two cannot drift apart,
   because there is only one of them.

   The DMC channel is missing. It plays 1-bit deltas out of cartridge ROM, and a
   tracker with no sample bank has nothing to feed it. */

;(function (root) {
  "use strict";

  /* The NTSC master clock, divided by 12 for the CPU. The frame counter runs
     one step every 29780.5 CPU cycles, which is where 60.0988 Hz comes from —
     not 60. A tracker row is counted in those frames, so a song's tempo is
     quantised to this number and the readout on the page says so. */
  const CPU_HZ = 1789773;
  const FRAME_HZ = CPU_HZ / 29780.5;

  /* The four duty cycles, as the chip stores them: eight-step sequences the
     pulse channel walks one step at a time. The fourth is the second inverted,
     which sounds identical on its own and only differs when phase matters. */
  const DUTY = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1],
  ];

  /* The triangle's 32 steps. It has no volume control at all: it is these
     levels or nothing, which is why a triangle bass line is the one voice on
     the chip that cannot be faded. */
  const TRI = [
    15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ];

  /* Sixteen noise periods, in CPU cycles per shift. The channel has no timer of
     its own to set — a note picks one of these and nothing in between. */
  const NOISE_PERIODS = [
    4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
  ];

  /* The timer is 11 bits. Above this the pulse channels have no lower note
     left, which lands at A-1; the triangle divides by twice as much and so
     reaches an octave below that. */
  const MAX_PERIOD = 2047;

  /* Below 8 the pulse timer is silenced by the hardware, not merely inaudible.
     Worth keeping: it is what makes a badly clamped high note vanish rather
     than scream. */
  const MIN_PULSE_PERIOD = 8;

  const PULSE_1 = 0, PULSE_2 = 1, TRIANGLE = 2, NOISE = 3;
  const CHANNEL_NAMES = ["Pulse 1", "Pulse 2", "Triangle", "Noise"];

  const NOTE_NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

  /* Notes are MIDI numbers throughout, so C-4 is 60 and A-4 is 440 Hz. The
     tracker shows octaves 0 to 7, which is MIDI 12 to 107. */
  const NOTE_MIN = 12;
  const NOTE_MAX = 107;

  const NOTE_OFF = -2;
  const NOTE_NONE = -1;

  function noteName(n) {
    if (n === NOTE_OFF) return "OFF";
    if (n < 0) return "---";
    return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12 - 1);
  }

  function noteHz(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  /* A pulse completes its eight steps in 16 × (t+1) CPU cycles, the triangle
     its thirty-two in 32 × (t+1). Both round to an integer, and both clamp:
     asking for a note the timer cannot address gives the nearest one it can. */
  function pulsePeriod(n) {
    const t = Math.round(CPU_HZ / (16 * noteHz(n))) - 1;
    return Math.max(MIN_PULSE_PERIOD, Math.min(MAX_PERIOD, t));
  }

  function triPeriod(n) {
    const t = Math.round(CPU_HZ / (32 * noteHz(n))) - 1;
    return Math.max(2, Math.min(MAX_PERIOD, t));
  }

  /* What a note actually comes out as, once the timer has rounded it. The page
     prints the error in cents beside the cursor, because at the top of the
     range it reaches a quarter-tone and that is not a bug to hide. */
  function periodHz(period, channel) {
    if (channel === TRIANGLE) return CPU_HZ / (32 * (period + 1));
    return CPU_HZ / (16 * (period + 1));
  }

  function centsOff(note, channel) {
    if (channel === NOISE) return 0;
    const period = channel === TRIANGLE ? triPeriod(note) : pulsePeriod(note);
    return 1200 * Math.log2(periodHz(period, channel) / noteHz(note));
  }

  /* The noise channel has no pitch, only sixteen timbres, so a tracker has to
     spend the note column on something. Convention since the first NES trackers:
     the note picks a period and the octave is ignored. Higher note, shorter
     period, brighter noise — which means the table is read backwards. */
  function noisePeriodIndex(note) {
    return 15 - (((note % 16) + 16) % 16);
  }

  /* ── The chip ──────────────────────────────────────────────────────────────

     Registers in, samples out. The four voices are stepped in CPU cycles at an
     oversampled rate and then decimated, because a square wave sampled straight
     at 44.1 kHz folds every harmonic above 22 kHz back down into the audible
     band as inharmonic whistling. The hardware is analog and has no such
     problem. Four times over with a box average is not a brick wall, but its
     nulls sit exactly on the output rate, which is where the folding comes
     from, and the 14 kHz filter below takes the rest. */

  function Chip(rate, oversample) {
    this.rate = rate;
    this.os = oversample || 4;
    this.cyc = CPU_HZ / (rate * this.os);

    /* One entry per voice. `period` is the timer reload value the chip would
       hold, `vol` is 0-15, `duty` selects the sequence for a pulse and the
       shift-register tap for noise. */
    this.v = [
      { period: 0, vol: 0, duty: 2, phase: 0, count: 0 },
      { period: 0, vol: 0, duty: 2, phase: 0, count: 0 },
      { period: 0, vol: 0, duty: 0, phase: 0, count: 0 },
      { period: 4, vol: 0, duty: 0, phase: 0, count: 0 },
    ];

    /* The shift register starts at 1 and can never reach 0, which is why the
       noise repeats after 32767 shifts instead of falling silent. */
    this.lfsr = 1;

    /* The analog chain on the console's output: two high-passes at 90 Hz and
       440 Hz and a low-pass at 14 kHz. They are the reason NES audio sounds
       thinner than a raw square wave, and leaving them out is the usual reason
       an emulated chip sounds wrong while measuring right. */
    const dtOut = 1 / rate;
    const dtOs = 1 / (rate * this.os);
    this.a90 = rcHigh(90, dtOut);
    this.a440 = rcHigh(440, dtOut);
    this.bLow = rcLow(14000, dtOs);
    this.hp90x = 0; this.hp90y = 0;
    this.hp440x = 0; this.hp440y = 0;
    this.low = 0;
  }

  function rcHigh(hz, dt) {
    const rc = 1 / (2 * Math.PI * hz);
    return rc / (rc + dt);
  }

  function rcLow(hz, dt) {
    const rc = 1 / (2 * Math.PI * hz);
    return dt / (rc + dt);
  }

  Chip.prototype.set = function (i, period, vol, duty) {
    const v = this.v[i];
    v.period = period;
    v.vol = vol;
    v.duty = duty;
  };

  /* The mix is not a sum. The console's two output pins drive resistor ladders
     that are deliberately non-linear, so two channels at half volume are louder
     than one at full and the difference between volume 14 and 15 is smaller
     than between 1 and 2. These are the measured curves from the hardware, and
     using them rather than an average is most of what makes a chip mix sound
     like a chip. */
  Chip.prototype.run = function (out, at, n) {
    const os = this.os, cyc = this.cyc, gain = 1.5;
    const p1 = this.v[0], p2 = this.v[1], tr = this.v[2], nz = this.v[3];
    const d1 = DUTY[p1.duty & 3], d2 = DUTY[p2.duty & 3];
    const nzTap = nz.duty ? 6 : 1;
    const bLow = this.bLow, a90 = this.a90, a440 = this.a440;

    const p1On = p1.vol > 0 && p1.period >= MIN_PULSE_PERIOD;
    const p2On = p2.vol > 0 && p2.period >= MIN_PULSE_PERIOD;
    const trOn = tr.vol > 0 && tr.period >= 2;
    const nzOn = nz.vol > 0;

    /* Step lengths in CPU cycles. A pulse advances one of eight steps every
       2 × (t+1) cycles; the triangle one of thirty-two every (t+1); the shift
       register once per table entry. */
    const s1 = 2 * (p1.period + 1);
    const s2 = 2 * (p2.period + 1);
    const s3 = tr.period + 1;
    const s4 = NOISE_PERIODS[nz.period & 15];

    let ph1 = p1.phase, ph2 = p2.phase, ph3 = tr.phase;
    let c1 = p1.count, c2 = p2.count, c3 = tr.count, c4 = nz.count;
    let lfsr = this.lfsr, low = this.low;

    for (let i = 0; i < n; i++) {
      let acc = 0;

      for (let k = 0; k < os; k++) {
        if (p1On) {
          c1 -= cyc;
          while (c1 <= 0) { c1 += s1; ph1 = (ph1 + 1) & 7; }
        }
        if (p2On) {
          c2 -= cyc;
          while (c2 <= 0) { c2 += s2; ph2 = (ph2 + 1) & 7; }
        }
        if (trOn) {
          c3 -= cyc;
          while (c3 <= 0) { c3 += s3; ph3 = (ph3 + 1) & 31; }
        }
        if (nzOn) {
          c4 -= cyc;
          while (c4 <= 0) {
            c4 += s4;
            /* Bit 0 against bit 1 gives the full 32767-step run; against bit 6
               it closes into 93 steps, short enough to be heard as a pitch.
               That short mode is the metallic ring on every NES snare. */
            const bit = (lfsr ^ (lfsr >> nzTap)) & 1;
            lfsr = (lfsr >> 1) | (bit << 14);
          }
        }

        const a = p1On ? d1[ph1] * p1.vol : 0;
        const b = p2On ? d2[ph2] * p2.vol : 0;
        /* The triangle is dropped to zero when silent rather than held at the
           step it stopped on, as the hardware does. The difference is a DC
           offset, and the 90 Hz high-pass below removes it either way. */
        const t = trOn ? TRI[ph3] : 0;
        /* The channel is loud when bit 0 is clear, not set. */
        const z = nzOn && (lfsr & 1) === 0 ? nz.vol : 0;

        const p = a + b;
        const pulseOut = p > 0 ? 95.88 / (8128 / p + 100) : 0;
        const tnd = t / 8227 + z / 12241;
        const tndOut = tnd > 0 ? 159.79 / (1 / tnd + 100) : 0;

        low += bLow * (pulseOut + tndOut - low);
        acc += low;
      }

      let s = (acc / os) * gain;

      const y90 = a90 * (this.hp90y + s - this.hp90x);
      this.hp90x = s; this.hp90y = y90;
      const y440 = a440 * (this.hp440y + y90 - this.hp440x);
      this.hp440x = y90; this.hp440y = y440;
      s = y440;

      out[at + i] = s > 1 ? 1 : s < -1 ? -1 : s;
    }

    p1.phase = ph1; p2.phase = ph2; tr.phase = ph3;
    p1.count = c1; p2.count = c2; tr.count = c3; nz.count = c4;
    this.lfsr = lfsr;
    this.low = low;
  };

  /* ── Instrument sequences ──────────────────────────────────────────────────

     A chip instrument is not an envelope with an attack time; it is a list of
     values read one per frame, which is how every NES sound driver has done it.
     A sequence that runs out holds its last value forever unless it names a
     loop point, and that distinction is the whole difference between a note
     that decays to silence and one that sustains. */

  function seqAt(seq, pos) {
    if (!seq || !seq.data || !seq.data.length) return null;
    const d = seq.data;
    if (pos < d.length) return d[pos];
    if (seq.loop >= 0 && seq.loop < d.length) {
      const span = d.length - seq.loop;
      return d[seq.loop + ((pos - d.length) % span)];
    }
    return d[d.length - 1];
  }

  /* ── The player ────────────────────────────────────────────────────────────

     One step per frame. On the first frame of a row it reads the row; on every
     frame it advances each instrument's sequences and each effect, works out a
     period and a volume, and writes them to the chip. Everything a tracker can
     do to a note between rows happens here. */

  function newVoice() {
    return {
      inst: 0,
      note: NOTE_NONE,
      on: false,
      volCol: 15,
      basePeriod: 0,
      target: 0,
      seq: [0, 0, 0, 0],
      pitchAcc: 0,
      slide: 0,
      porta: 0,
      arpX: 0, arpY: 0,
      vibSpeed: 0, vibDepth: 0, vibPhase: 0,
    };
  }

  function Player(song, from) {
    this.song = song;
    this.order = from && from.order ? from.order : 0;
    this.row = from && from.row ? from.row : 0;
    this.tick = 0;
    this.speed = song.speed;
    this.done = false;
    this.jump = -1;
    this.brk = -1;
    this.halt = false;
    this.voices = [newVoice(), newVoice(), newVoice(), newVoice()];
  }

  Player.prototype.pattern = function () {
    const idx = this.song.order[this.order];
    return this.song.patterns[idx] || this.song.patterns[0];
  };

  Player.prototype.startRow = function () {
    const pat = this.pattern();
    this.jump = -1;
    this.brk = -1;
    this.halt = false;

    for (let c = 0; c < 4; c++) {
      const cell = pat.data[this.row * 4 + c];
      const v = this.voices[c];
      if (!cell) continue;

      if (cell.i >= 0) v.inst = cell.i;
      if (cell.v >= 0) v.volCol = cell.v;

      /* Effects are read before the note, because tone portamento changes what
         a note means: with 3xx on the row, a note names a destination to slide
         to rather than something to retrigger. */
      const fx = cell.fx;
      const fp = cell.fp | 0;
      if (fx === "0") { v.arpX = (fp >> 4) & 15; v.arpY = fp & 15; }
      else if (fx === "1") { v.slide = -fp; v.porta = 0; }
      else if (fx === "2") { v.slide = fp; v.porta = 0; }
      else if (fx === "3") { v.porta = fp; v.slide = 0; }
      else if (fx === "4") { v.vibSpeed = (fp >> 4) & 15; v.vibDepth = fp & 15; }
      else if (fx === "B") { this.jump = fp; }
      else if (fx === "D") { this.brk = fp; }
      else if (fx === "F") { this.speed = Math.max(1, Math.min(31, fp)); }
      else if (fx === "C") { this.halt = true; }

      if (cell.n === NOTE_OFF) {
        v.on = false;
        v.note = NOTE_NONE;
      } else if (cell.n >= 0) {
        const period = periodFor(cell.n, c);
        if (v.porta > 0 && v.on) {
          v.target = period;
        } else {
          v.note = cell.n;
          v.basePeriod = period;
          v.target = period;
          v.on = true;
          v.seq = [0, 0, 0, 0];
          v.pitchAcc = 0;
          v.vibPhase = 0;
        }
      }
    }
    return { order: this.order, row: this.row };
  };

  function periodFor(note, channel) {
    if (channel === NOISE) return noisePeriodIndex(note);
    if (channel === TRIANGLE) return triPeriod(note);
    return pulsePeriod(note);
  }

  Player.prototype.tickVoice = function (c, chip) {
    const v = this.voices[c];
    const inst = this.song.instruments[v.inst] || this.song.instruments[0];

    if (!v.on || !inst) {
      chip.set(c, c === NOISE ? 4 : 0, 0, 0);
      return;
    }

    const seqVol = seqAt(inst.vol, v.seq[0]);
    const seqArp = seqAt(inst.arp, v.seq[1]);
    const seqPitch = seqAt(inst.pitch, v.seq[2]);
    const seqDuty = seqAt(inst.dutySeq, v.seq[3]);
    for (let s = 0; s < 4; s++) v.seq[s]++;

    /* Arpeggio, the effect: three notes in rotation, one per frame. On a chip
       with two pulses it is the only way to hear a chord, and at 60 frames a
       second it reads as one rough sustained tone rather than three notes. */
    let semis = seqArp || 0;
    if (v.arpX || v.arpY) {
      const step = this.tick % 3;
      semis += step === 1 ? v.arpX : step === 2 ? v.arpY : 0;
    }

    let period;
    if (c === NOISE) {
      period = noisePeriodIndex(v.note + semis);
    } else {
      const note = Math.max(NOTE_MIN, Math.min(NOTE_MAX, v.note + semis));
      period = semis ? periodFor(note, c) : v.basePeriod;
    }

    if (this.tick > 0) {
      if (v.porta > 0 && v.target !== v.basePeriod) {
        const d = v.target - v.basePeriod;
        const move = Math.min(v.porta, Math.abs(d)) * (d < 0 ? -1 : 1);
        v.basePeriod += move;
        period = v.basePeriod;
      } else if (v.slide) {
        v.pitchAcc += v.slide;
      }
    }
    /* The pitch sequence runs from the note's first frame, unlike the effects
       above, which need a row to have happened before they mean anything. It is
       what gives a drum its fall and a lead its overshoot on the attack. */
    if (seqPitch) v.pitchAcc += seqPitch;

    if (c !== NOISE) {
      period += v.pitchAcc;
      if (v.vibDepth) {
        v.vibPhase += v.vibSpeed;
        period += Math.sin((v.vibPhase / 32) * Math.PI * 2) * v.vibDepth * 2;
      }
      period = Math.round(period);
      const floor = c === TRIANGLE ? 2 : MIN_PULSE_PERIOD;
      period = Math.max(floor, Math.min(MAX_PERIOD, period));
    }

    /* The volume column scales the instrument's sequence rather than replacing
       it, so turning a channel down does not flatten the shape of its notes. */
    const base = seqVol === null ? 15 : seqVol;
    let vol = Math.round((base * v.volCol) / 15);
    vol = Math.max(0, Math.min(15, vol));

    let duty = seqDuty === null ? inst.duty : seqDuty;
    if (c === NOISE) duty = duty & 1;

    chip.set(c, period, vol, duty);
  };

  Player.prototype.advance = function () {
    if (this.halt) { this.done = true; return; }
    const rows = this.pattern().rows;

    if (this.jump >= 0) {
      this.order = Math.min(this.jump, this.song.order.length - 1);
      this.row = this.brk >= 0 ? this.brk : 0;
    } else if (this.brk >= 0) {
      this.order++;
      this.row = this.brk;
    } else {
      this.row++;
      if (this.row >= rows) { this.order++; this.row = 0; }
    }

    if (this.order >= this.song.order.length) this.order = 0;
    const nowRows = this.pattern().rows;
    if (this.row >= nowRows) this.row = 0;
  };

  Player.prototype.step = function (chip) {
    let started = null;
    if (this.tick === 0) started = this.startRow();
    for (let c = 0; c < 4; c++) this.tickVoice(c, chip);
    this.tick++;
    if (this.tick >= this.speed) {
      this.tick = 0;
      this.advance();
    }
    return started;
  };

  /* ── Rendering ─────────────────────────────────────────────────────────────

     A pass ends when the player arrives at a row it has already played, which
     is the only definition of "the song looped" that survives contact with
     jumps and breaks. The sample offset of that row is the loop point, so
     playback can repeat from it and an export can render as many passes as
     asked for — properly, by continuing to run the player, rather than by
     pasting the buffer to itself and cutting every note that crossed the seam. */

  function render(song, opts) {
    opts = opts || {};
    const rate = opts.rate || 44100;
    const loops = Math.max(1, opts.loops || 1);
    const maxSamples = Math.floor(rate * (opts.maxSeconds || 900));

    const chip = new Chip(rate, opts.oversample || 4);
    const player = new Player(song, opts.from);
    const perTick = rate / FRAME_HZ;

    let buf = new Float32Array(Math.min(maxSamples, rate * 8));
    let pos = 0;
    let acc = 0;
    let pass = 0;
    let loopStart = 0;
    const marks = [];
    let seen = new Map();

    while (!player.done && pos < maxSamples) {
      const started = player.step(chip);

      if (started) {
        const key = started.order + ":" + started.row;
        if (seen.has(key)) {
          if (pass === 0) loopStart = seen.get(key);
          pass++;
          if (pass >= loops) break;
          seen = new Map();
        }
        seen.set(key, pos);
        marks.push({ s: pos, order: started.order, row: started.row });
      }

      acc += perTick;
      const n = Math.floor(acc);
      acc -= n;

      if (pos + n > buf.length) {
        const grown = new Float32Array(Math.min(maxSamples, Math.max(buf.length * 2, pos + n)));
        grown.set(buf.subarray(0, pos));
        buf = grown;
      }
      if (pos + n > buf.length) break;

      chip.run(buf, pos, n);
      pos += n;
    }

    return {
      samples: buf.subarray(0, pos),
      rate: rate,
      marks: marks,
      loopStart: loopStart,
      duration: pos / rate,
    };
  }

  /* One note on one channel, for the keyboard preview and the instrument
     editor. Built as a one-row song so it goes through the same player: an
     instrument that sounds different under the preview than in the pattern
     would be worse than no preview. */
  function renderNote(song, instIndex, note, channel, seconds, rate) {
    const rows = Math.max(2, Math.ceil(((seconds || 0.9) * FRAME_HZ) / song.speed) + 1);
    const data = new Array(rows * 4).fill(null);
    data[channel] = { n: note, i: instIndex, v: 15, fx: "", fp: 0 };
    const one = {
      speed: song.speed,
      instruments: song.instruments,
      patterns: [{ rows: rows, data: data }],
      order: [0],
    };
    return render(one, { loops: 1, maxSeconds: 4, rate: rate });
  }

  /* ── WAV ───────────────────────────────────────────────────────────────────

     16-bit PCM, mono, no metadata. The console's output is one pin; writing it
     to two identical channels would double the file and add nothing. */

  function wav(samples, rate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);

    function ascii(at, s) {
      for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
    }

    ascii(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);      // PCM
    view.setUint16(22, 1, true);      // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, n * 2, true);

    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  root.APU = {
    CPU_HZ: CPU_HZ,
    FRAME_HZ: FRAME_HZ,
    NOTE_MIN: NOTE_MIN,
    NOTE_MAX: NOTE_MAX,
    NOTE_OFF: NOTE_OFF,
    NOTE_NONE: NOTE_NONE,
    MAX_PERIOD: MAX_PERIOD,
    CHANNEL_NAMES: CHANNEL_NAMES,
    PULSE_1: PULSE_1,
    PULSE_2: PULSE_2,
    TRIANGLE: TRIANGLE,
    NOISE: NOISE,
    DUTY: DUTY,
    NOISE_PERIODS: NOISE_PERIODS,
    noteName: noteName,
    noteHz: noteHz,
    centsOff: centsOff,
    periodFor: periodFor,
    periodHz: periodHz,
    noisePeriodIndex: noisePeriodIndex,
    seqAt: seqAt,
    Chip: Chip,
    Player: Player,
    render: render,
    renderNote: renderNote,
    wav: wav,
  };
})(typeof window !== "undefined" ? window : globalThis);
