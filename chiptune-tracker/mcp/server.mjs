#!/usr/bin/env node
/* Chiptune Tracker, as a set of tools an agent can compose with.

   The tracker page is a page: it wants a keyboard, a pair of ears and somebody
   sitting in front of it. Everything underneath it does not — apu.js and
   song.js are arithmetic over integers and touch neither the DOM nor the Web
   Audio API — so the engine runs here unchanged and the page becomes optional.
   Ask for a song in Claude Code and a WAV lands on disk; nobody has to open
   the editor, and the song can still be opened there afterwards because the
   file written is the same file the page saves.

   Five tools, in the order they are used: read the reference, check a song,
   render it, audition an instrument while designing it, open one somebody
   already made. The checking is the part that matters. A person at the tracker
   discovers in one second that the triangle will not fade and that the bass
   line is an octave higher than they wrote it; from here both are silent, so
   analyse.mjs says them out loud.

   MCP over stdio is newline-delimited JSON-RPC 2.0 and nothing more, so there
   is no dependency here and nothing to install — which matches a repository
   whose whole claim is a folder of static files and no build step.

       node chiptune-tracker/mcp/server.mjs

   Protocol messages go to stdout and must be the only thing there; anything
   worth saying goes to stderr. */

import fs from 'node:fs';
import path from 'node:path';

import { APU, Song, TRACKER_DIR } from './engine.mjs';
import { compile, decompile, parseNote, formatNote, CHANNELS } from './song-format.mjs';
import { analyse, report } from './analyse.mjs';
import { reference, SECTIONS } from './reference.mjs';

const SERVER = { name: 'chiptune-mcp-server', version: '1.0.0' };

/* The server has no version-dependent behaviour — it speaks the tools subset
   and nothing else — so it agrees to whatever the client opened with and falls
   back to the last version it was written against. */
const DEFAULT_PROTOCOL = '2025-06-18';

const MAX_RENDER_SECONDS = 600;

function log(...args) {
  process.stderr.write('[chiptune] ' + args.join(' ') + '\n');
}

/* ── Schemas ───────────────────────────────────────────────────────────────── */

const EVENT_SCHEMA = {
  type: 'object',
  description: 'One cell: a row, and what happens on it. Only "row" is required.',
  properties: {
    row: { type: 'integer', minimum: 0, description: 'Row within the pattern, 0-based.' },
    note: {
      description: 'Letter + accidental + octave, octaves 0-7: "C-4" (middle C), "A#3", "Bb2". ' +
        'The dash is optional. "OFF" stops a ringing note. On the noise channel "kick", "snare" and "hat" ' +
        'are shorthand. A MIDI integer 12-107 also works.',
      anyOf: [{ type: 'string' }, { type: 'integer' }],
    },
    instrument: {
      description: 'Instrument name (or index). Required on the first note of each channel; after that the ' +
        'channel holds the last one it was given.',
      anyOf: [{ type: 'string' }, { type: 'integer' }],
    },
    volume: { type: 'integer', minimum: 0, maximum: 15, description: "Scales the instrument's volume sequence." },
    effect: {
      type: 'string',
      description: 'One of: arpeggio (x, y), slideUp (rate), slideDown (rate), portamento (rate), ' +
        'vibrato (speed, depth), jump (to), break (toRow), setSpeed (frames), halt. Its parameters are ' +
        'given as sibling fields.',
    },
    x: { type: 'integer' }, y: { type: 'integer' },
    rate: { type: 'integer' }, speed: { type: 'integer' }, depth: { type: 'integer' },
    to: { type: 'integer' }, toRow: { type: 'integer' }, frames: { type: 'integer' },
  },
  required: ['row'],
};

const SEQ = (what) => ({
  type: 'array', items: { type: 'integer' },
  description: what + ' One value per video frame (60.1 a second), not an envelope. Runs out and holds ' +
    'its last value forever unless a loop index is given.',
});

const SONG_SCHEMA = {
  type: 'object',
  description: 'A song. Call chiptune_get_reference with section "format" for the full description, ' +
    'or "example" for a complete one to copy.',
  properties: {
    title: { type: 'string' },
    speed: { type: 'integer', minimum: 1, maximum: 31, description: 'Frames per row; lower is faster. Give this or bpm, not both.' },
    bpm: { type: 'number', description: 'Instead of speed. Tempo is quantised to whole video frames, so the nearest achievable is used and reported.' },
    rowsPerBeat: { type: 'integer', minimum: 1, maximum: 16, description: 'Default 4. With speed it decides the BPM.' },
    instruments: {
      type: 'array', minItems: 1, maxItems: Song.MAX_INSTRUMENTS,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'How patterns refer to it.' },
          duty: { type: 'integer', minimum: 0, maximum: 3, description: 'Pulse waveform: 0=12.5%, 1=25%, 2=50%, 3=75%. On noise, bit 0 picks the long or short shift-register run. The triangle ignores it.' },
          volume: SEQ('0-15 per frame. [15] sustains; [15,12,9,6,3,0] decays. The triangle has no volume control, so there it only gates.'),
          volumeLoop: { type: 'integer', description: 'Index to loop back to; -1 or absent holds the last value.' },
          arpeggio: SEQ('Semitone offsets.'),
          arpeggioLoop: { type: 'integer' },
          pitch: SEQ('Timer-period deltas. Positive LOWERS the pitch. Ignored on the noise channel.'),
          pitchLoop: { type: 'integer' },
          dutySequence: SEQ('Per-frame waveform 0-3. Different field from "duty".'),
          dutySequenceLoop: { type: 'integer' },
        },
        required: ['name'],
      },
    },
    patterns: {
      type: 'array', minItems: 1, maxItems: Song.MAX_PATTERNS,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'How the order refers to it.' },
          rows: { type: 'integer', minimum: Song.MIN_ROWS, maximum: Song.MAX_ROWS },
          pulse1: { type: 'array', items: EVENT_SCHEMA, description: 'Pulse. One note at a time.' },
          pulse2: { type: 'array', items: EVENT_SCHEMA, description: 'Second pulse. One note at a time.' },
          triangle: { type: 'array', items: EVENT_SCHEMA, description: 'Triangle: reaches an octave lower, cannot fade.' },
          noise: { type: 'array', items: EVENT_SCHEMA, description: 'Noise: 16 timbres, no pitch. Drums.' },
        },
        required: ['rows'],
      },
    },
    order: {
      type: 'array', minItems: 1, maxItems: Song.MAX_ORDER,
      items: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      description: 'Pattern names in the order they play. Repeats are how a song is built: ["verse","verse","chorus"].',
    },
  },
  required: ['instruments', 'patterns', 'order'],
};

const FORMAT_PARAM = {
  type: 'string', enum: ['markdown', 'json'], default: 'markdown',
  description: 'markdown is written to be read; json returns the same findings as data.',
};

/* ── Loading a song from either shape of argument ──────────────────────────── */

function loadSong(args, where) {
  if (args.song && args.path) {
    throw new Error('Give either "song" (a song written out) or "path" (a saved .json), not both.');
  }

  if (args.path) {
    const file = path.resolve(String(args.path));
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error('Could not read a song from ' + file + ': ' + err.message);
    }
    let song;
    try {
      song = Song.deserialise(raw);
    } catch (err) {
      throw new Error(file + ' is not a Chiptune Tracker song: ' + err.message +
        '. A song file has "format": "workshop-chiptune".');
    }
    const patternNames = song.patterns.map((_, i) => 'pattern ' + i);
    return {
      song,
      meta: { instrumentNames: song.instruments.map((i) => i.name), patternNames },
      errors: [], warnings: [], from: file,
    };
  }

  if (!args.song) {
    throw new Error('Nothing to ' + where + '. Pass "song" (written out in full) or "path" to a saved .json. ' +
      'Call chiptune_get_reference with section "example" for a song to start from.');
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

/* ── Writing files ─────────────────────────────────────────────────────────── */

function writeOut(where, bytes, extension) {
  let file = path.resolve(String(where));
  if (extension && path.extname(file).toLowerCase() !== extension) file += extension;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

async function wavBytes(rendered) {
  const blob = APU.wav(rendered.samples, rendered.rate);
  return Buffer.from(await blob.arrayBuffer());
}

/* How to actually listen to it. Worth saying: the point of this server is a
   file somebody plays, and the command differs per platform. */
function playHint(file) {
  const q = JSON.stringify(file);
  if (process.platform === 'darwin') return 'afplay ' + q;
  if (process.platform === 'win32') return 'start "" ' + q;
  return 'aplay ' + q + '   (or ffplay -nodisp -autoexit ' + q + ')';
}

/* ── The tools ─────────────────────────────────────────────────────────────── */

const TOOLS = [
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
        rate: { type: 'integer', minimum: 8000, maximum: 48000, default: 44100, description: 'Sample rate.' },
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

      const kb = (fs.statSync(file).size / 1024).toFixed(0);
      const out = [
        'Wrote **' + file + '** — ' + rendered.duration.toFixed(2) + 's, ' + kb + ' kB, mono ' +
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
        rowsPerNote: { type: 'integer', minimum: 1, maximum: 64, default: 8, description: 'How long to hold each note.' },
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

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ── JSON-RPC over stdio ───────────────────────────────────────────────────── */

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      reply(id, {
        protocolVersion: typeof asked === 'string' && asked ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions:
          'Writes music for the NES sound chip, rendering it with the same engine as the browser tracker ' +
          'at workshop.fubl.org/chiptune-tracker/. Start with chiptune_get_reference. Four voices, one note ' +
          'each; read what chiptune_check_song reports, because this chip rounds pitches, silences notes it ' +
          'cannot reach and gives the triangle no volume control, and none of that is audible from a file.',
      });
      return;
    }

    /* Notifications carry no id and must not be answered. */
    case 'notifications/initialized':
    case 'initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      if (isRequest) reply(id, {});
      return;

    case 'tools/list':
      reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });
      return;

    /* Not advertised in capabilities, but clients probe for them. An empty
       list is a truthful answer and cheaper than an error for both sides. */
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const tool = BY_NAME.get(name);
      if (!tool) {
        reply(id, {
          isError: true,
          content: [{ type: 'text', text: 'No tool called "' + name + '". Available: ' +
            TOOLS.map((t) => t.name).join(', ') + '.' }],
        });
        return;
      }
      try {
        const result = await tool.run((params && params.arguments) || {});
        reply(id, {
          content: [{ type: 'text', text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (err) {
        /* Reported inside the result rather than as a protocol error, so the
           model sees it and can act on it instead of the call just failing. */
        log(name + ' failed: ' + (err && err.stack ? err.stack : err));
        reply(id, {
          isError: true,
          content: [{ type: 'text', text: (err && err.message) || String(err) }],
        });
      }
      return;
    }

    default:
      if (isRequest) replyError(id, -32601, 'Unknown method: ' + method);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      replyError(null, -32700, 'Parse error: ' + err.message);
      continue;
    }
    /* Each message is handled as it arrives rather than awaited in turn: a
       render takes a tenth of a second and JSON-RPC carries ids for exactly
       this reason. */
    handle(message).catch((err) => {
      log('handler failed: ' + (err && err.stack ? err.stack : err));
      if (message && message.id !== undefined && message.id !== null) {
        replyError(message.id, -32603, 'Internal error: ' + ((err && err.message) || String(err)));
      }
    });
  }
});

process.stdin.on('end', () => process.exit(0));

log('ready — ' + TOOLS.length + ' tools, engine from ' + TRACKER_DIR);
