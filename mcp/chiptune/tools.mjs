/* The chiptune tracker's five tools.

   The tracker is a page: it wants a keyboard, a pair of ears and somebody
   sitting in front of it. Everything underneath it does not, so the engine
   runs here and the page becomes optional — ask for eight bars in A minor and
   a WAV lands on disk, beside a song file the page will still open.

   The checking is the part that matters. A person at the tracker discovers in
   one second that the triangle will not fade and that the bass line is an
   octave above where they wrote it. From here both are silent, so analyse.mjs
   says them out loud. */

import fs from 'node:fs';

import { APU, Song } from './engine.mjs';
import { compile, decompile, parseNote, formatNote, CHANNELS } from './song-format.mjs';
import { analyse, report } from './analyse.mjs';
import { reference, SECTIONS } from './reference.mjs';
import { writeOut, readIn, sizeOf, playHint, FORMAT_PARAM } from '../lib/files.mjs';

const MAX_RENDER_SECONDS = 600;

/* The schema gets a caller through the door; the compiler's errors teach the
   rest. Spelling the whole song out as nested JSON Schema cost about 2,300
   tokens in each of the two tools that take one, for detail that is better
   delivered by chiptune_get_reference on request and by an error message that
   names a position and suggests a fix. So the shape is described here in prose
   and validated properly where validation belongs. */
const SONG_SCHEMA = {
  type: 'object',
  description:
    'A song: { title, speed (frames per row 1-31) or bpm, rowsPerBeat (default 4), instruments, ' +
    'patterns, order }.\n' +
    '• An instrument is { name, duty 0-3, volume: [0-15 ONE PER VIDEO FRAME], volumeLoop } and ' +
    'optionally arpeggio / pitch / dutySequence arrays with matching ...Loop indices. A volume ' +
    'sequence is not an envelope: [15] sustains until the next note, [15,12,9,6,3,0] decays. A ' +
    'sequence that runs out holds its last value forever unless it names a loop index.\n' +
    '• A pattern is { name, rows 4-128, pulse1, pulse2, triangle, noise }, each channel a list of ' +
    'events. An event is { row, note, instrument, volume, effect + that effect\'s own named ' +
    'parameters } and only "row" is required. Notes are "C-4", "A#3", "Bb2", 60 or "OFF"; on the ' +
    'noise channel also "kick", "snare", "hat". A channel holds the instrument and volume it was ' +
    'last given, but the FIRST note on each channel must name an instrument. One note at a time ' +
    'per channel — two events on one row is an error.\n' +
    '• order is pattern names in the order they play; repeats are how a song is built: ' +
    '["verse","verse","chorus"].\n' +
    'Call chiptune_get_reference (sections format, channels, instruments, effects, example) for the ' +
    'full description and a complete song to copy.',
  properties: {
    title: { type: 'string' },
    speed: { type: 'integer', minimum: 1, maximum: 31, description: 'Frames per row; lower is faster. Give this or bpm, not both.' },
    bpm: { type: 'number', description: 'Instead of speed. Tempo is quantised to whole video frames, so the nearest achievable is used and reported.' },
    rowsPerBeat: { type: 'integer', minimum: 1, maximum: 16 },
    instruments: { type: 'array', minItems: 1, maxItems: Song.MAX_INSTRUMENTS, items: { type: 'object' } },
    patterns: { type: 'array', minItems: 1, maxItems: Song.MAX_PATTERNS, items: { type: 'object' } },
    order: { type: 'array', minItems: 1, maxItems: Song.MAX_ORDER },
  },
  required: ['instruments', 'patterns', 'order'],
};

function loadSong(args, where) {
  if (args.song && args.path) {
    throw new Error('Give either "song" (a song written out) or "path" (a saved .json), not both.');
  }

  if (args.path) {
    const { file, bytes } = readIn(args.path, 'song');
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      throw new Error(file + ' is not readable as JSON: ' + err.message);
    }
    let song;
    try {
      song = Song.deserialise(raw);
    } catch (err) {
      throw new Error(file + ' is not a Chiptune Tracker song: ' + err.message +
        '. A song file has "format": "workshop-chiptune".');
    }
    return {
      song,
      meta: {
        instrumentNames: song.instruments.map((i) => i.name),
        patternNames: song.patterns.map((_, i) => 'pattern ' + i),
      },
      errors: [], warnings: [], from: file,
    };
  }

  if (!args.song) {
    throw new Error('Nothing to ' + where + '. Pass "song" (written out in full) or "path" to a saved ' +
      '.json. Call chiptune_get_reference with section "example" for a song to start from.');
  }
  return compile(args.song);
}

function refuse(result) {
  const lines = ['The song was not rendered: ' + result.errors.length +
    (result.errors.length === 1 ? ' thing' : ' things') + ' need fixing first.', ''];
  for (const e of result.errors) lines.push('- ' + e);
  if (result.warnings.length) {
    lines.push('', 'Also worth fixing:');
    for (const w of result.warnings) lines.push('- ' + w);
  }
  return lines.join('\n');
}

async function wavBytes(rendered) {
  const blob = APU.wav(rendered.samples, rendered.rate);
  return Buffer.from(await blob.arrayBuffer());
}

export const tools = [
  {
    name: 'chiptune_get_reference',
    description:
      'How to write music for the NES sound chip with these tools: the song format, what each of the four ' +
      'channels can and cannot do, how instruments work (per-frame sequences, not envelopes), the effect ' +
      'table, and a complete worked song. Read this before composing. Sections: ' +
      Object.keys(SECTIONS).join(', ') + '.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string', enum: [...Object.keys(SECTIONS), 'all'], default: 'overview',
          description: 'overview: the chip and the workflow. format: the song JSON. channels: what each ' +
            'voice can do. instruments: sequences and envelopes. effects: the effect table. example: a ' +
            'complete song to copy. all: everything, which is long.',
        },
      },
    },
    run: (args) => ({ text: reference(args.section || 'overview') }),
  },

  {
    name: 'chiptune_check_song',
    description:
      'Check a song and report what the chip would do to it, without writing any file. Catches the mistakes ' +
      'that are silent in a rendered file: notes the 11-bit timer cannot reach and what they become instead, ' +
      'how far off each note lands in cents, volume sequences on the triangle (which has no volume control), ' +
      'effects written on the noise channel that it discards, a tempo that does not exist on this hardware, ' +
      'a mix that clips, and a render that comes out silent. Call this before rendering.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        song: SONG_SCHEMA,
        path: { type: 'string', description: 'Instead of "song": a saved .json to check.' },
        verbose: { type: 'boolean', default: false, description: 'Also summarise every channel and instrument.' },
        response_format: FORMAT_PARAM,
      },
    },
    run: (args) => {
      const loaded = loadSong(args, 'check');
      if (!loaded.song) return { text: refuse(loaded), isError: true };

      const rendered = APU.render(Song.forPlayback(loaded.song), { loops: 1, maxSeconds: MAX_RENDER_SECONDS });
      const a = analyse(loaded.song, { meta: loaded.meta, rendered });

      if (args.response_format === 'json') {
        return { text: JSON.stringify({ ok: true, warnings: loaded.warnings, ...a }, null, 2) };
      }
      const out = [report(a, { verbose: args.verbose })];
      if (loaded.warnings.length) {
        out.push('', '## Worth tidying', ...loaded.warnings.map((w) => '- ' + w));
      }
      return { text: out.join('\n') };
    },
  },

  {
    name: 'chiptune_render_song',
    description:
      'Render a song to a mono 16-bit WAV file and report what the chip did to it. Optionally also write the ' +
      'song as a .json that the browser tracker at workshop.fubl.org/chiptune-tracker/ can open. Returns the ' +
      'path, the duration, the real tempo, and the same diagnostics as chiptune_check_song.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        song: SONG_SCHEMA,
        path: { type: 'string', description: 'Instead of "song": a saved .json to render.' },
        out: { type: 'string', description: 'Where to write the WAV. ".wav" is added if missing. Parent directories are created.' },
        saveSongTo: { type: 'string', description: 'Optional: also write the song as a .json the browser tracker can open.' },
        loops: { type: 'integer', minimum: 1, maximum: 16, default: 1, description: 'How many times through. The player keeps running rather than the buffer being pasted to itself, so notes across the seam are not cut.' },
        rate: { type: 'integer', minimum: 8000, maximum: 48000, default: 44100 },
        verbose: { type: 'boolean', default: false },
        response_format: FORMAT_PARAM,
      },
      required: ['out'],
    },
    run: async (args) => {
      const loaded = loadSong(args, 'render');
      if (!loaded.song) return { text: refuse(loaded), isError: true };

      const rendered = APU.render(Song.forPlayback(loaded.song), {
        loops: args.loops || 1,
        rate: args.rate || 44100,
        maxSeconds: MAX_RENDER_SECONDS,
      });
      const file = writeOut(args.out, await wavBytes(rendered), '.wav');
      const a = analyse(loaded.song, { meta: loaded.meta, rendered });

      let songFile = null;
      if (args.saveSongTo) {
        songFile = writeOut(args.saveSongTo,
          JSON.stringify(Song.serialise(loaded.song), null, 2) + '\n', '.json');
      }

      if (args.response_format === 'json') {
        return { text: JSON.stringify({
          wav: file, song: songFile, bytes: fs.statSync(file).size,
          warnings: loaded.warnings, ...a,
        }, null, 2) };
      }

      const out = [
        'Wrote **' + file + '** — ' + rendered.duration.toFixed(2) + 's, ' + sizeOf(file) + ', mono ' +
          rendered.rate + ' Hz' + ((args.loops || 1) > 1 ? ', ' + args.loops + ' times through' : '') + '.',
        'Play it with `' + playHint(file) + '`.',
      ];
      if (songFile) {
        out.push('Wrote **' + songFile + '** — open it with Load in the browser tracker to keep editing by hand.');
      }
      out.push('', report(a, { verbose: args.verbose }));
      if (loaded.warnings.length) {
        out.push('', '## Worth tidying', ...loaded.warnings.map((w) => '- ' + w));
      }
      return { text: out.join('\n') };
    },
  },

  {
    name: 'chiptune_audition_instrument',
    description:
      'Render one instrument on its own, playing a few notes, so its design can be checked before it is used ' +
      'in a song. Writes a WAV and reports how long the instrument sounds for, whether it sustains or decays, ' +
      'and what the chip did to each note. Use it while working out a lead, a bass or a drum.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        instrument: {
          type: 'object',
          description: 'The instrument to hear, in the same shape a song uses: ' +
            '{ "name": "lead", "duty": 2, "volume": [15,12,9,6,3,0] }.',
        },
        notes: {
          type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          description: 'Notes to play, one per bar. Defaults to a short phrase suited to the channel.',
        },
        channel: {
          type: 'string', enum: CHANNELS, default: 'pulse1',
          description: 'Which voice to hear it on. The same instrument is a different thing on each.',
        },
        rowsPerNote: { type: 'integer', minimum: 1, maximum: 64, default: 8 },
        speed: { type: 'integer', minimum: 1, maximum: 31, default: 6 },
        out: { type: 'string', description: 'Where to write the WAV. ".wav" is added if missing.' },
        response_format: FORMAT_PARAM,
      },
      required: ['instrument', 'out'],
    },
    run: async (args) => {
      const channel = CHANNELS.indexOf(args.channel || 'pulse1');
      if (channel < 0) throw new Error('channel must be one of ' + CHANNELS.join(', ') + '.');

      const defaults = channel === APU.NOISE
        ? ['kick', 'snare', 'hat', 'snare']
        : channel === APU.TRIANGLE ? ['A-2', 'C-3', 'E-3', 'A-2'] : ['A-4', 'C-5', 'E-5', 'A-4'];
      const wanted = (args.notes && args.notes.length ? args.notes : defaults);

      const notes = wanted.map((n, i) => {
        try {
          return parseNote(n);
        } catch (err) {
          throw new Error('notes[' + i + ']: ' + err.message);
        }
      });

      const rowsPerNote = args.rowsPerNote || 8;
      const rows = Math.max(Song.MIN_ROWS, Math.min(Song.MAX_ROWS, notes.length * rowsPerNote));

      /* Built as a real song and rendered by the real player, so an instrument
         cannot sound different here from the way it will sound in a pattern. */
      const song = {
        title: 'audition',
        speed: args.speed || 6,
        instruments: [args.instrument],
        patterns: [{
          name: 'audition', rows,
          [CHANNELS[channel]]: notes.map((n, i) => ({
            row: i * rowsPerNote,
            note: formatNote(n),
            ...(i === 0 ? { instrument: 0, volume: 15 } : {}),
          })).filter((e) => e.row < rows),
        }],
        order: ['audition'],
      };

      const loaded = compile(song);
      if (!loaded.song) return { text: refuse(loaded), isError: true };

      const rendered = APU.render(Song.forPlayback(loaded.song), { loops: 1, maxSeconds: 60 });
      const file = writeOut(args.out, await wavBytes(rendered), '.wav');
      const a = analyse(loaded.song, { meta: loaded.meta, rendered });
      const ins = a.instruments[0];

      if (args.response_format === 'json') {
        return { text: JSON.stringify({ wav: file, notes: wanted, channel: CHANNELS[channel], ...a }, null, 2) };
      }

      const out = [
        'Wrote **' + file + '** — "' + ins.name + '" on ' + CHANNELS[channel] + ', playing ' +
          notes.map(formatNote).join(' ') + '.',
        'Play it with `' + playHint(file) + '`.',
        '',
        '**' + ins.name + '**: duty ' + ins.duty + ', ' + ins.envelope +
          (ins.sequences.length ? ', plus ' + ins.sequences.join(' and ') : '') + '.',
        '',
        report(a),
      ];
      if (loaded.warnings.length) out.push('', ...loaded.warnings.map((w) => '- ' + w));
      return { text: out.join('\n') };
    },
  },

  {
    name: 'chiptune_open_song',
    description:
      'Read a saved Chiptune Tracker .json — one written by these tools or saved from the browser tracker — ' +
      'and return it in the readable form these tools take, so it can be edited and rendered again. ' +
      'Also summarises what is in it.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The .json to read.' },
        response_format: FORMAT_PARAM,
      },
      required: ['path'],
    },
    run: (args) => {
      const loaded = loadSong({ path: args.path }, 'open');
      const friendly = decompile(loaded.song, {
        instruments: loaded.meta.instrumentNames,
        patterns: loaded.meta.patternNames,
      });
      const a = analyse(loaded.song, { meta: loaded.meta });

      if (args.response_format === 'json') {
        return { text: JSON.stringify({ song: friendly, analysis: a }, null, 2) };
      }
      return { text: [
        '**' + (loaded.song.title || 'untitled') + '** from ' + loaded.from,
        report(a, { verbose: true }),
        '',
        'As these tools take it — edit this and pass it back as "song":',
        '',
        '```json',
        JSON.stringify(friendly, null, 2),
        '```',
      ].join('\n') };
    },
  },
];
