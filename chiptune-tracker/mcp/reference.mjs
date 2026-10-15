/* What an agent needs to know before it writes a note, and nothing else.

   The sections are separate because they are paid for by the line. Somebody
   writing a bass line does not need the effect table, and somebody adding
   vibrato does not need the song schema again. The effect list and the channel
   notes are built from the same objects the compiler validates against, so the
   documentation cannot drift away from what the code accepts. */

import { APU, Song } from './engine.mjs';
import { NAMED_EFFECTS, CHANNEL_NOTES, CHANNELS, DRUM_ALIASES } from './song-format.mjs';

/* A complete song, short enough to read and correct enough to copy: it renders
   with no problems and no warnings, which the test suite checks, because an
   example that trips the server's own diagnostics teaches the wrong thing. */
export const EXAMPLE_SONG = {
  title: 'two bars',
  speed: 6,
  rowsPerBeat: 4,
  instruments: [
    { name: 'lead', duty: 2, volume: [15, 15, 14, 13, 12, 11, 10], dutySequence: [1, 1, 2] },
    { name: 'bass', duty: 0, volume: [15] },
    { name: 'kick', duty: 0, volume: [15, 15, 13, 10, 6, 2, 0] },
    { name: 'hat', duty: 1, volume: [8, 4, 1, 0] },
  ],
  patterns: [
    {
      name: 'verse',
      rows: 16,
      pulse1: [
        { row: 0, note: 'A-4', instrument: 'lead', volume: 15 },
        { row: 4, note: 'C-5' },
        { row: 6, note: 'B-4' },
        { row: 8, note: 'E-4', effect: 'vibrato', speed: 3, depth: 4 },
        { row: 14, note: 'OFF' },
      ],
      pulse2: [
        { row: 0, note: 'A-3', instrument: 'lead', volume: 10, effect: 'arpeggio', x: 3, y: 7 },
        { row: 8, note: 'E-3' },
        { row: 14, note: 'OFF' },
      ],
      triangle: [
        { row: 0, note: 'A-2', instrument: 'bass', volume: 15 },
        { row: 4, note: 'A-2' },
        { row: 8, note: 'E-2' },
        { row: 12, note: 'E-3' },
      ],
      noise: [
        { row: 0, note: 'kick', instrument: 'kick', volume: 15 },
        { row: 4, note: 'hat', instrument: 'hat' },
        { row: 8, note: 'kick', instrument: 'kick' },
        { row: 12, note: 'hat', instrument: 'hat' },
      ],
    },
  ],
  order: ['verse', 'verse'],
};

function effectTable() {
  const rows = ['| effect | parameters | what it does |', '|---|---|---|'];
  for (const [name, def] of Object.entries(NAMED_EFFECTS)) {
    const params = Object.entries(def.params)
      .map(([f, [lo, hi]]) => '`' + f + '` ' + lo + '–' + hi)
      .join(', ') || '—';
    rows.push('| `' + name + '` | ' + params + ' | ' + def.note + ' |');
  }
  return rows.join('\n');
}

const OVERVIEW = `# Writing music for the NES sound chip

This renders songs on a written-out Ricoh 2A03 — the sound hardware in the
Nintendo Entertainment System — as arithmetic rather than samples. It is the
same engine the browser tracker at workshop.fubl.org/chiptune-tracker/ runs, so
a song composed here is a song that tool can open, and the WAV is what it would
have exported.

## How to work

1. \`chiptune_reference\` with the section you need (\`format\`, \`channels\`,
   \`instruments\`, \`effects\`, \`example\`).
2. Write the song as JSON and call \`chiptune_check\`. It renders nothing to
   disk; it tells you what is wrong and what the chip would do to what is right.
3. \`chiptune_render\` to write a WAV, and \`saveSongTo\` to also write a
   \`.json\` the browser tracker can open.
4. \`chiptune_audition\` to hear one instrument on its own while designing it.

**Read the diagnostics.** You cannot hear this and the chip does not do as it is
told: it rounds every pitch to an integer divider, silences notes it cannot
reach, gives the triangle no volume control, has no pitch at all on the noise
channel, and quantises tempo to whole video frames. Every one of those is
audible in a second and invisible in a file, so the server reports them.

## Four voices, and that is all

Two pulse channels, one triangle, one noise. **One note at a time on each.**
Four notes is the whole of the harmony, so a chord means either spreading it
across channels or the \`arpeggio\` effect, which rotates through three notes one
video frame apart and reads as a single rough tone.

There is no reverb, no filter, no stereo and no sample playback. ${Math.round(APU.FRAME_HZ)} frames
a second is the clock everything happens on.`;

const FORMAT = `# The song format

\`\`\`
{
  "title":       string
  "speed":       1-31     frames per row. Lower is faster.
  "bpm":         number    instead of "speed" — the nearest achievable is used
                           and reported. Never give both.
  "rowsPerBeat": 1-16     default 4. With "speed" it decides the BPM.

  "instruments": [ {                       1-${Song.MAX_INSTRUMENTS} of them
      "name":        string                referenced by name from patterns
      "duty":        0-3                   pulse waveform; see channels
      "volume":      [0-15, ...]           ONE VALUE PER FRAME, not an envelope
      "volumeLoop":  index                 optional; -1 or absent holds the last
      "arpeggio":    [semitones, ...]      optional, per frame
      "pitch":       [deltas, ...]         optional, per frame, period units
      "dutySequence":[0-3, ...]            optional, per frame
      ... each sequence also takes <name>Loop
  } ]

  "patterns": [ {                          1-${Song.MAX_PATTERNS} of them
      "name":  string                      referenced by name from the order
      "rows":  ${Song.MIN_ROWS}-${Song.MAX_ROWS}
      "pulse1": [ event, ... ]             one array per channel, all optional
      "pulse2": [ ... ]
      "triangle": [ ... ]
      "noise": [ ... ]
  } ]

  "order": [ "pattern name", ... ]         1-${Song.MAX_ORDER} positions.
                                           Repeats are how a song is built.
}
\`\`\`

An **event** is one cell of one channel on one row:

\`\`\`
{
  "row":        0 to rows-1                required
  "note":       "C-4" | "A#3" | "Bb2" | 60 | "OFF"
  "instrument": "name" or index            needed on the first note of a channel
  "volume":     0-15                       scales the instrument's sequence
  "effect":     see the effects section, with its own named parameters
}
\`\`\`

Only \`row\` is required. A channel **holds** the instrument and volume it was
last given, so they need repeating only when they change — but the first note on
each channel must name an instrument or it plays \`instruments[0]\`.

\`"OFF"\` is an instruction, not an absence: it stops a note ringing. An
instrument whose volume sequence never reaches 0 sounds until the next note or
an \`OFF\`.

**Two events on the same row of the same channel is an error.** Each channel
plays one note at a time.

Notes are letter + accidental + octave, octaves 0 to 7, the way the tracker
prints them: \`C-4\` is middle C, \`A-4\` is 440 Hz. The filler dash is optional
(\`C4\`), sharps and flats both work (\`A#3\`, \`Bb3\`), and a MIDI integer is
accepted. On the noise channel ${Object.keys(DRUM_ALIASES).map((k) => '`' + k + '`').join(', ')} are shorthand.`;

const CHANNELS_DOC = `# The four channels

${CHANNELS.map((c) => '**`' + c + '`** — ' + CHANNEL_NOTES[c]).join('\n\n')}

## What this means in practice

**Bass goes on the triangle**, which reaches an octave below the pulses — but it
cannot fade, so give it a \`[15]\` volume sequence and stop it with \`OFF\`. A
decaying sequence there cuts abruptly at the first 0 instead of fading, and the
server will tell you so.

**The pulse floor is A-1.** The timer is 11 bits; below A-1 on a pulse (A-0 on
the triangle) the note is not quiet, it is a different note. Write a bass line
too low and it comes out an octave or two up.

**Pitch is approximate, and worse higher up.** Every note is the nearest integer
divider off a ${(APU.CPU_HZ / 1e6).toFixed(6)} MHz clock. Around B-7 that is
about 19 cents sharp — a fifth of a semitone. For a melody that has to be in
tune, stay below the top octave.

**The noise channel has sixteen timbres and no pitch.** Only \`note % 16\`
selects one, so notes 16 apart are identical and the octave is ignored. Low
notes are deep, high notes are bright: \`kick\` is C-3, \`snare\` C-4, \`hat\`
D-4. \`duty\` bit 0 picks the long 32767-step run or the short 93-step one,
which is the metallic ring on every NES snare.

**Duty cycles on a pulse**, as proportions of the cycle spent high:
\`0\` = 12.5% (thin and nasal), \`1\` = 25%, \`2\` = 50% (a full square, the
default lead), \`3\` = 75% — which is \`1\` inverted and sounds identical alone.

**The mix is not a sum.** The hardware's resistor ladders are deliberately
non-linear: two channels at half volume are louder than one at full, and the
step from 14 to 15 is smaller than from 1 to 2. Four parts at volume 15 clip,
and the server reports it.`;

const INSTRUMENTS_DOC = `# Instruments are sequences, not envelopes

An instrument on this chip is not an ADSR. It is a list of values read **one per
video frame** — ${APU.FRAME_HZ.toFixed(2)} of them a second — which is how every
sound driver on the console did it. One frame is ${(1000 / APU.FRAME_HZ).toFixed(1)} ms.

\`\`\`
"volume": [15, 12, 9, 6, 3, 0]     a 100 ms pluck, then silence
"volume": [15]                      full volume until the next note or OFF
"volume": [0, 4, 8, 12, 15]        fades in, then holds 15 forever
"volume": [15, 10], "volumeLoop": 0   alternates 15, 10 forever — a tremolo
\`\`\`

**A sequence that runs out holds its last value forever** unless it names a
\`...Loop\` index to go back to. That single distinction is the difference
between a note that decays and one that sustains, so it is the first thing to
get right.

The volume column on an event **scales** the sequence rather than replacing it,
so turning a part down keeps the shape of its notes.

## The other three sequences

\`arpeggio\` adds semitones per frame: \`[0, 4, 7]\` with \`arpeggioLoop: 0\` is
a major chord on one channel. \`dutySequence\` changes the pulse waveform per
frame: \`[1, 1, 2]\` reads as a pluck rather than an organ and costs four
numbers.

\`pitch\` adds **timer periods**, not semitones, and the timer is a divider — so
a positive value makes the period longer and the pitch *lower*. \`[0, 6, 10, 14]\`
falls; negative values rise. It is what gives a tom its drop or a lead an
overshoot on the attack.

Three traps worth knowing. \`duty\` (a single 0–3 fallback) and \`dutySequence\`
(per frame) are different fields. The triangle ignores \`volume\` beyond
on-or-off. And **the noise channel ignores \`pitch\` entirely** — to sweep a
noise timbre over time use \`arpeggio\` instead, which does reach it: a kick that
starts bright and drops is \`{ "note": "C-4", "arpeggio": [0, -4, -8, -12] }\`,
since on that channel a lower note is a deeper timbre.

## Starting points

\`\`\`
lead    { "duty": 2, "volume": [15,15,14,13,12,11,10], "dutySequence": [1,1,2] }
bass    { "duty": 0, "volume": [15] }                       (on the triangle)
pluck   { "duty": 1, "volume": [15,13,10,7,4,2,0] }
organ   { "duty": 2, "volume": [13] }
kick    { "duty": 0, "volume": [15,15,13,10,6,2,0] }        (noise, note C-3)
snare   { "duty": 1, "volume": [15,14,12,11,9,7,5,3,2,1,0] } (noise, note C-4)
hat     { "duty": 1, "volume": [8,4,1,0] }                  (noise, note D-4)
tom     { "duty": 0, "volume": [15,12,8,4,0], "pitch": [0,8,14,20] } (pulse)
\`\`\``;

const EFFECTS_DOC = `# Effects

One effect per event, written with named parameters:

\`\`\`
{ "row": 8, "note": "E-4", "effect": "vibrato", "speed": 3, "depth": 4 }
{ "row": 0, "note": "A-3", "effect": "arpeggio", "x": 3, "y": 7 }
{ "row": 31, "effect": "break", "toRow": 0 }
\`\`\`

${effectTable()}

The raw tracker spelling works too — \`{ "effect": "4", "param": "34" }\` — where
\`param\` must be a **string** of hex digits, because \`37\` and \`"37"\` mean
different things and guessing would detune an arpeggio by three octaves. The
named form avoids the question.

\`arpeggio\` is the only way to hear a chord on one channel: it plays the note,
then \`x\` semitones above, then \`y\`, one per frame, which at 60 frames a
second reads as one rough sustained tone. A minor triad is \`x: 3, y: 7\`; a
major one \`x: 4, y: 7\`.

\`slideUp\`, \`slideDown\` and \`vibrato\` bend the timer, not the pitch, so the
same rate bends further at the top of the keyboard — and none of them do anything
on the noise channel, which has no timer.

\`jump\`, \`break\`, \`setSpeed\` and \`halt\` affect the whole song rather than
one channel, so write them on one channel only. \`jump\` takes a position in the
order, not a pattern name.`;

const EXAMPLE_DOC = `# A complete song

Two bars of A minor: a lead with vibrato on pulse 1, an arpeggiated chord on
pulse 2, a bass on the triangle, and a kick and hat on the noise channel. It
renders with no problems reported. Pass it to \`chiptune_check\` and then to
\`chiptune_render\`.

\`\`\`json
${JSON.stringify(EXAMPLE_SONG, null, 2)}
\`\`\`

Things to notice. The first note on every channel names an instrument; after
that the channel holds it. The lead's \`OFF\` at row 14 stops it ringing into the
repeat, because its volume sequence ends on 10 rather than 0. The bass is on the
triangle with \`[15]\`, since that channel cannot fade. The order names \`verse\`
twice — that is how a song is made longer. And the noise events use \`kick\` and
\`hat\` rather than note names, which is the same thing written more plainly.`;

export const SECTIONS = {
  overview: OVERVIEW,
  format: FORMAT,
  channels: CHANNELS_DOC,
  instruments: INSTRUMENTS_DOC,
  effects: EFFECTS_DOC,
  example: EXAMPLE_DOC,
};

export function reference(section) {
  if (!section || section === 'all') {
    return Object.values(SECTIONS).join('\n\n---\n\n');
  }
  const doc = SECTIONS[section];
  if (!doc) {
    return 'No section called "' + section + '". Sections: ' + Object.keys(SECTIONS).join(', ') + '.';
  }
  return doc;
}
