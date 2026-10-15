/* What the chip did to the song, written down.

   Someone composing here cannot hear the result, and this chip is not a
   general-purpose synthesiser that quietly does as it is told. It rounds every
   pitch to an integer divider off one 1.789773 MHz clock. It silences a pulse
   whose timer falls under 8 rather than playing it quietly. It gives the
   triangle no volume control at all, so a careful fade on that channel is an
   abrupt cut. It has no pitch on the noise channel, only sixteen timbres, and
   it ignores the octave you picked. It quantises tempo to whole video frames,
   so most BPMs do not exist. Played by a person, every one of those announces
   itself through the speakers in a second. Rendered to a file by an agent, all
   of them are silent.

   So this is the listening, done as arithmetic: the notes the timer could not
   reach and what they became instead, how far off each one landed in cents,
   the fades that are not fades, the effects that do nothing on the channel
   they were written on, and whether the mix clipped or came out silent. It is
   the difference between a server that renders a song and one that can tell
   you your bass line is an octave higher than you wrote it. */

import { APU, Song } from './engine.mjs';
import { CHANNELS, formatNote } from './song-format.mjs';

const PULSE_FLOOR = 8;      // under this the hardware silences the channel
const TRI_FLOOR = 2;
const CEILING = APU.MAX_PERIOD;

/* The timer value a note wants, before the hardware's limits are applied.
   APU.periodFor only ever hands back a legal one, so the clamp it performed is
   invisible from outside — which is exactly the thing worth reporting. */
function wantedPeriod(note, channel) {
  const divider = channel === APU.TRIANGLE ? 32 : 16;
  return Math.round(APU.CPU_HZ / (divider * APU.noteHz(note))) - 1;
}

function nearestNoteTo(hz) {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

/* A volume sequence that never reaches zero rings until the next note or an
   OFF; one that does reach zero decays to silence on its own. The distinction
   is the whole of this chip's envelope design, so it is worth stating per
   instrument rather than making someone infer it from a list of integers. */
function sustains(seq) {
  if (!seq.data.length) return true;
  if (seq.loop >= 0) return !seq.data.slice(seq.loop).includes(0);
  return seq.data[seq.data.length - 1] !== 0;
}

function distinctNonZero(seq) {
  return new Set(seq.data.filter((v) => v > 0)).size;
}

/* Every cell the song can reach, each one once.

   Walked in the order the patterns first play in, so the first note found on a
   channel really is the first one heard, but each distinct pattern is examined
   only once: a verse used four times would otherwise report the same clamped
   note four times over, in words identical down to the row number. A pattern
   left out of the order is not reached at all, which is the point — it is
   never heard either. */
function* playedCells(song) {
  const seen = new Set();
  for (let o = 0; o < song.order.length; o++) {
    const index = song.order[o];
    if (seen.has(index)) continue;
    seen.add(index);
    const pat = song.patterns[index];
    if (!pat) continue;
    for (let row = 0; row < pat.rows; row++) {
      for (let c = 0; c < 4; c++) {
        const cell = pat.data[row * 4 + c];
        if (!Song.cellIsEmpty(cell)) yield { cell, channel: c, row, order: o, pattern: index };
      }
    }
  }
}

export function analyse(song, options) {
  options = options || {};
  const meta = options.meta || {};
  const rendered = options.rendered || null;

  const problems = [];   // things that are almost certainly not what was wanted
  const remarks = [];    // things worth knowing that may well be deliberate

  const names = meta.instrumentNames || song.instruments.map((i) => i.name);
  const patNames = meta.patternNames || song.patterns.map((_, i) => 'pattern ' + i);
  const at = (p) => patNames[p.pattern] + ' row ' + p.row + ' (' + CHANNELS[p.channel] + ')';

  const channels = CHANNELS.map((name) => ({
    name, notes: 0, instruments: new Set(), low: null, high: null, offs: 0,
  }));

  const clamped = [];
  const detuned = [];
  const noiseTimbres = new Map();
  const deadEffects = [];
  const firstNote = [null, null, null, null];
  let halts = 0;

  for (const p of playedCells(song)) {
    const { cell, channel } = p;
    const ch = channels[channel];

    if (cell.n === APU.NOTE_OFF) ch.offs++;
    if (cell.n >= 0) {
      ch.notes++;
      if (ch.low === null || cell.n < ch.low) ch.low = cell.n;
      if (ch.high === null || cell.n > ch.high) ch.high = cell.n;
      if (!firstNote[channel]) firstNote[channel] = { ...p, named: cell.i >= 0 };

      if (channel === APU.NOISE) {
        /* Only note % 16 selects a timbre, so notes an octave and a bit apart
           are indistinguishable. Collect them to show which ones collided. */
        const index = APU.noisePeriodIndex(cell.n);
        if (!noiseTimbres.has(index)) noiseTimbres.set(index, new Set());
        noiseTimbres.get(index).add(cell.n);
      } else {
        const want = wantedPeriod(cell.n, channel);
        const floor = channel === APU.TRIANGLE ? TRI_FLOOR : PULSE_FLOOR;
        const got = Math.max(floor, Math.min(CEILING, want));
        if (want !== got) {
          const hz = APU.periodHz(got, channel);
          clamped.push({
            where: at(p), asked: formatNote(cell.n),
            became: formatNote(nearestNoteTo(hz)), hz,
            direction: want > CEILING ? 'too low' : 'too high',
          });
        } else {
          const cents = APU.centsOff(cell.n, channel);
          if (Math.abs(cents) >= 10) detuned.push({ where: at(p), note: formatNote(cell.n), cents });
        }
      }
    }

    if (cell.i >= 0) ch.instruments.add(cell.i);

    /* Effects the channel has no hardware for. The player computes a noise
       period from the note and the arpeggio and then skips the whole pitch
       block for that channel, so a bend written there is simply discarded. */
    if (cell.fx && channel === APU.NOISE && ['1', '2', '4'].includes(cell.fx)) {
      const label = { 1: 'slideUp', 2: 'slideDown', 4: 'vibrato' }[cell.fx];
      deadEffects.push(at(p) + ': ' + label + ' does nothing on the noise channel, which has no timer to bend. ' +
        'To change the noise timbre over time use the instrument\'s "arpeggio" sequence or the arpeggio effect.');
    }
    if (cell.fx === 'C') halts++;
    if (cell.fx === 'B' && cell.fp >= song.order.length) {
      problems.push(at(p) + ': jump to order position ' + cell.fp + ', but the order is only ' +
        song.order.length + ' long (0-' + (song.order.length - 1) + '). The player clamps to the last position.');
    }
    if (cell.fx === 'D') {
      const next = song.patterns[song.order[(p.order + 1) % song.order.length]];
      if (next && cell.fp >= next.rows) {
        problems.push(at(p) + ': break to row ' + cell.fp + ', but the next pattern has only ' +
          next.rows + ' rows. The player falls back to row 0.');
      }
    }
  }

  /* ── The triangle's missing volume control ──
     trOn is `vol > 0`, and the level comes from a fixed 32-step table. A
     volume sequence on this channel is therefore a gate, not an envelope: it
     cuts rather than fades, at whichever frame it first reaches zero. */
  const triInstruments = [...channels[APU.TRIANGLE].instruments];
  for (const i of triInstruments) {
    const ins = song.instruments[i];
    if (!ins) continue;
    if (distinctNonZero(ins.vol) > 1) {
      problems.push('"' + names[i] + '" plays on the triangle with a volume sequence of ' +
        ins.vol.data.length + ' values, but the triangle has NO volume control — its level is a fixed ' +
        '32-step table. Those values only gate it on and off, so this will cut to silence at the first 0 ' +
        'rather than fade. Put fading parts on a pulse channel; keep the triangle sequence to [15] or ' +
        '[15,...,0] if you want it to stop.');
    }
  }
  for (const i of [...channels[APU.NOISE].instruments]) {
    const ins = song.instruments[i];
    if (ins && ins.pitch.data.length) {
      problems.push('"' + names[i] + '" plays on the noise channel and has a pitch sequence, which that ' +
        'channel discards — the player accumulates it and never applies it. On the other three channels it ' +
        'is what gives a drum its fall. To sweep a noise timbre over time use an "arpeggio" sequence, which ' +
        'does reach that channel: a lower note is a deeper timbre.');
    }
  }

  /* An unnamed first note is not an error — a channel holds whatever
     instrument it was last given — but on the first note of the song there is
     nothing to hold, so it silently plays instrument 0. */
  for (let c = 0; c < 4; c++) {
    if (firstNote[c] && !firstNote[c].named) {
      problems.push(at(firstNote[c]) + ' is the first note on ' + CHANNELS[c] + ' and names no instrument, ' +
        'so it plays "' + names[0] + '" (instruments[0]). Name one on the first note of every channel.');
    }
  }

  for (const [index, notes] of noiseTimbres) {
    if (notes.size > 1) {
      remarks.push('On the noise channel ' + [...notes].map(formatNote).join(', ') + ' are the same timbre ' +
        '(period ' + APU.NOISE_PERIODS[index] + '): only note % 16 selects one of the sixteen, and the octave ' +
        'is ignored.');
    }
  }

  /* ── Tempo ── */
  const bpm = Song.bpmFor(song.speed, song.highlight);
  const timing = {
    speed: song.speed,
    rowsPerBeat: song.highlight,
    bpm,
    orderLength: song.order.length,
    /* The whole order, repeats included, because this is what sets the length
       of the file — unlike the note counts above, which are per pattern. */
    rows: song.order.reduce((n, p) => n + (song.patterns[p] ? song.patterns[p].rows : 0), 0),
    patternsUsed: new Set(song.order).size,
  };
  if (meta.requestedBpm !== undefined) {
    timing.requestedBpm = meta.requestedBpm;
    const off = Math.abs(bpm - meta.requestedBpm);
    if (off > 0.5) {
      const near = [song.speed - 1, song.speed + 1]
        .filter((s) => s >= 1 && s <= 31)
        .map((s) => s + ' = ' + Song.bpmFor(s, song.highlight).toFixed(1) + ' BPM');
      remarks.push('Asked for ' + meta.requestedBpm + ' BPM and got ' + bpm.toFixed(1) + '. A row lasts a whole ' +
        'number of video frames, so the tempo is quantised: speed ' + song.speed + ' is the nearest. ' +
        'Neighbours are speed ' + near.join(', ') + '. For a tempo in between, change rowsPerBeat.');
    }
  }

  /* ── The audio itself ── */
  const audio = {};
  if (rendered) {
    const s = rendered.samples;
    let peak = 0;
    let clipped = 0;
    let energy = 0;
    for (let i = 0; i < s.length; i++) {
      const a = Math.abs(s[i]);
      if (a > peak) peak = a;
      if (a >= 0.999999) clipped++;
      energy += s[i] * s[i];
    }
    audio.duration = rendered.duration;
    audio.peak = peak;
    audio.rms = Math.sqrt(energy / Math.max(1, s.length));
    audio.clippedSamples = clipped;
    audio.loopStartSeconds = rendered.loopStart / rendered.rate;
    audio.rate = rendered.rate;

    if (peak < 1e-4) {
      problems.push('The render is silent. Peak amplitude is ' + peak.toExponential(2) + '. Check that notes ' +
        'name an instrument whose volume sequence is not all zeros, that the order lists patterns that have ' +
        'events, and that volumes are not 0.');
    } else if (clipped > s.length * 0.001) {
      problems.push(clipped + ' samples (' + ((clipped / s.length) * 100).toFixed(2) + '%) hit the limiter. ' +
        'Four channels at full volume through the hardware\'s non-linear mix clips: two at half volume are ' +
        'louder than one at full. Drop the volume column on the busiest parts by a few steps.');
    } else if (peak < 0.1) {
      remarks.push('Peak amplitude is only ' + peak.toFixed(3) + ', so the file will sound very quiet.');
    }
    if (halts === 0 && rendered.loopStart === 0 && s.length > 0) {
      audio.loops = true;
    }
  }

  if (halts > 1) {
    remarks.push(halts + ' halt effects; the first one the player reaches ends the song.');
  }

  /* Instructions the hardware throws away. Written last so they sit with the
     other problems rather than ahead of them. */
  for (const d of deadEffects) problems.push(d);

  return {
    problems, remarks, timing, audio,
    clamped, detuned,
    channels: channels.map((ch, c) => ({
      name: ch.name,
      notes: ch.notes,
      noteOffs: ch.offs,
      range: ch.low === null ? null : formatNote(ch.low) + ' to ' + formatNote(ch.high),
      instruments: [...ch.instruments].map((i) => names[i]),
      sustaining: [...ch.instruments].filter((i) => song.instruments[i] && sustains(song.instruments[i].vol))
        .map((i) => names[i]),
    })),
    instruments: song.instruments.map((ins, i) => ({
      name: names[i],
      duty: ins.duty,
      volumeFrames: ins.vol.data.length,
      envelope: sustains(ins.vol)
        ? 'sustains until the next note or OFF'
        : 'decays to silence over ' + ins.vol.data.length + ' frames (' +
          (ins.vol.data.length / APU.FRAME_HZ).toFixed(2) + 's)',
      sequences: ['arp', 'pitch', 'duty_'].filter((k) => ins[k].data.length)
        .map((k) => ({ arp: 'arpeggio', pitch: 'pitch', duty_: 'dutySequence' })[k]),
    })),
  };
}

/* ── The report ────────────────────────────────────────────────────────────── */

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}

/* Markdown, and only the sections that have something in them: this is read by
   something paying for every line of it. */
export function report(a, options) {
  options = options || {};
  const out = [];

  if (a.audio.duration !== undefined) {
    const bars = a.timing.rows / (a.timing.rowsPerBeat * 4);
    out.push('**' + a.audio.duration.toFixed(2) + 's** · ' + a.timing.bpm.toFixed(1) + ' BPM · speed ' +
      a.timing.speed + ' (' + a.timing.speed + ' frames per row, ' + a.timing.rowsPerBeat + ' rows per beat) · ' +
      a.timing.rows + ' rows ≈ ' + bars.toFixed(bars % 1 ? 1 : 0) + ' bars of 4/4 · peak ' +
      a.audio.peak.toFixed(3));
    if (a.audio.loops) {
      out.push('Loops from ' + a.audio.loopStartSeconds.toFixed(2) + 's.');
    }
  } else {
    out.push('**' + a.timing.bpm.toFixed(1) + ' BPM** · speed ' + a.timing.speed + ' · ' +
      a.timing.rows + ' rows over ' + plural(a.timing.orderLength, 'order position') + '.');
  }

  if (a.problems.length) {
    out.push('', '## Probably not what you wanted', ...a.problems.map((p) => '- ' + p));
  }

  if (a.clamped.length) {
    out.push('', '## Notes the timer could not reach (' + a.clamped.length + ')');
    out.push('The period is 11 bits, so a pulse bottoms out at A-1 and the triangle an octave lower. ' +
      'Below that the note is not quiet, it is a different note.');
    for (const c of a.clamped.slice(0, 12)) {
      out.push('- ' + c.where + ': **' + c.asked + '** is ' + c.direction + '; it sounds as ' + c.became +
        ' (' + c.hz.toFixed(1) + ' Hz).');
    }
    if (a.clamped.length > 12) out.push('- …and ' + (a.clamped.length - 12) + ' more.');
  }

  if (a.detuned.length) {
    const worst = a.detuned.slice().sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents));
    out.push('', '## Notes more than 10 cents off (' + a.detuned.length + ')');
    out.push('Every pitch is an integer divider off a 1.789773 MHz clock, and the rounding gets coarser as ' +
      'the notes get higher. This is the sound of the chip, not a fault — it is listed so a melody that ' +
      'needs to be in tune can be moved down an octave.');
    for (const d of worst.slice(0, 8)) {
      out.push('- ' + d.where + ': ' + d.note + ' lands ' + (d.cents > 0 ? '+' : '') + d.cents.toFixed(1) + ' cents off.');
    }
    if (worst.length > 8) out.push('- …and ' + (worst.length - 8) + ' more, the worst listed first.');
  }

  if (a.remarks.length) {
    out.push('', '## Worth knowing', ...a.remarks.map((r) => '- ' + r));
  }

  if (options.verbose) {
    out.push('', '## Channels');
    for (const ch of a.channels) {
      if (!ch.notes && !ch.noteOffs) { out.push('- **' + ch.name + '**: unused.'); continue; }
      out.push('- **' + ch.name + '**: ' + plural(ch.notes, 'note') + ' across ' +
        plural(a.timing.patternsUsed, 'pattern') + ', ' + ch.range +
        ', played by ' + (ch.instruments.join(', ') || 'instruments[0]') + '.');
    }
    out.push('', '## Instruments');
    for (const ins of a.instruments) {
      out.push('- **' + ins.name + '**: duty ' + ins.duty + ', ' + ins.envelope +
        (ins.sequences.length ? ', plus ' + ins.sequences.join(' and ') : '') + '.');
    }
  }

  if (!a.problems.length && !a.clamped.length) {
    out.push('', 'Nothing the chip had to refuse or round badly.');
  }

  return out.join('\n');
}
