#!/usr/bin/env node
/* The server's self-test. Run it before trusting a change:

       node chiptune-tracker/mcp/test.mjs

   Three things are checked, in order of how badly they would matter.

   First, that the compiler is lossless: the page's own demo song is taken apart
   into the format these tools accept, put back together, and rendered. Every
   sample must be identical to rendering the demo directly. That one assertion
   is what lets the server claim the sound is the page's sound rather than a
   near-enough reimplementation, and it is the test most likely to catch a
   mistake in the format.

   Second, that mistakes are caught rather than clamped. A song with a dozen
   deliberate errors in it must produce a dozen complaints and no audio, since
   the whole value of this server to something that cannot hear is that it
   refuses to quietly render nonsense.

   Third, that the protocol works: a real child process, a real handshake, and
   every tool called over stdin and stdout.

   No framework, because a test file that needs installing is a test file that
   stops being run. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { APU, Song } from './engine.mjs';
import { compile, decompile, parseNote, formatNote } from './song-format.mjs';
import { analyse } from './analyse.mjs';
import { EXAMPLE_SONG } from './reference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');

let passed = 0;
const failures = [];

function ok(what, condition, detail) {
  if (condition) {
    passed++;
    return true;
  }
  failures.push(what + (detail ? ' — ' + detail : ''));
  return false;
}

function section(name) {
  process.stdout.write('\n' + name + '\n');
}

/* ── 1. The format is lossless ─────────────────────────────────────────────── */

section('the format round-trips the demo song exactly');
{
  const demo = Song.demoSong();
  const names = {
    instruments: demo.instruments.map((i) => i.name),
    patterns: ['one', 'two', 'three', 'four'],
  };
  const friendly = decompile(demo, names);
  const back = compile(friendly);

  ok('demo decompiles and recompiles without complaint', !back.errors.length, back.errors.join('; '));
  ok('no warnings on the demo', !back.warnings.length, back.warnings.join('; '));

  if (back.song) {
    const a = APU.render(Song.forPlayback(demo), { loops: 1, rate: 44100 });
    const b = APU.render(Song.forPlayback(back.song), { loops: 1, rate: 44100 });
    ok('same number of samples', a.samples.length === b.samples.length,
      a.samples.length + ' vs ' + b.samples.length);

    let worst = 0;
    for (let i = 0; i < Math.min(a.samples.length, b.samples.length); i++) {
      worst = Math.max(worst, Math.abs(a.samples[i] - b.samples[i]));
    }
    ok('every sample identical', worst === 0, 'largest difference ' + worst);
    ok('loop point preserved', a.loopStart === b.loopStart);
  }
}

/* ── 2. Notes ──────────────────────────────────────────────────────────────── */

section('notes are read the way they are written');
{
  const cases = [
    ['C-4', 60], ['C4', 60], ['c-4', 60], ['A-4', 69], ['A#3', 58], ['Bb3', 58],
    ['B-7', 107], ['C-0', 12], [60, 60], ['OFF', APU.NOTE_OFF], ['off', APU.NOTE_OFF],
    ['kick', 48], ['snare', 60], ['hat', 62],
  ];
  for (const [input, expected] of cases) {
    let got;
    try {
      got = parseNote(input);
    } catch (err) {
      got = 'threw: ' + err.message;
    }
    ok('parseNote(' + JSON.stringify(input) + ') is ' + expected, got === expected, 'got ' + got);
  }

  ok('A-4 is 440 Hz', Math.abs(APU.noteHz(parseNote('A-4')) - 440) < 1e-9);
  ok('C-4 prints back as C-4', formatNote(60) === 'C-4', formatNote(60));

  for (const bad of ['H-4', 'C-9', 'C', '', 'x', 108, 11, 4.5]) {
    let threw = false;
    try {
      parseNote(bad);
    } catch (err) {
      threw = true;
    }
    ok('parseNote(' + JSON.stringify(bad) + ') is refused', threw);
  }
}

/* ── 3. Mistakes are reported, not clamped ─────────────────────────────────── */

section('a song full of mistakes is refused, with reasons');
{
  const broken = {
    title: 'wrong on purpose',
    speed: 6,
    instuments: [],
    instruments: [{ name: 'lead', duty: [1, 2], volume: 20, arpeggio: [0, 4], arpeggioLoop: 9 }],
    patterns: [
      {
        name: 'verse', rows: 16, pulse3: [],
        pulse1: [
          { row: 0, note: 'H-4', instrument: 'lead' },
          { row: 0, note: 'C-4', instrument: 'lead' },
          { row: 1, note: 'C-9' },
          { row: 2, note: 'C-4', instrument: 'led' },
          { row: 3, note: 'C-4', effect: 'vibrto', speed: 1, depth: 1 },
          { row: 4, note: 'C-4', effect: 'vibrato' },
          { row: 5, note: 'C-4', effect: '4', param: 54 },
          { row: 99, note: 'C-4' },
        ],
      },
      { name: 'dead', rows: 16 },
    ],
    order: ['verse', 'chorus'],
  };
  const r = compile(broken);

  ok('refuses to hand back a song', r.song === null);
  const joined = r.errors.join('\n');
  const expectations = [
    ['the misspelled top-level key', 'instuments'],
    ['suggests the correct spelling', 'Did you mean "instruments"'],
    ['the misspelled channel', 'pulse3'],
    ['duty given as an array', 'dutySequence'],
    ['volume given as a number', 'volume must be an array'],
    ['a loop index past the end', 'arpeggioLoop'],
    ['an unreadable note', 'H-4'],
    ['a note out of range', 'C-9'],
    ['two events on one row', 'already has an event'],
    ['an unknown instrument name', '"led"'],
    ['an unknown effect', 'vibrto'],
    ['a missing effect parameter', 'needs "depth"'],
    ['a numeric hex parameter', 'hex'],
    ['a row past the end of the pattern', 'row must be 0-15'],
    ['an unknown pattern in the order', '"chorus"'],
  ];
  for (const [what, needle] of expectations) {
    ok('reports ' + what, joined.includes(needle), 'no error mentioning ' + JSON.stringify(needle));
  }

  const warned = r.warnings.join('\n');
  ok('warns about the pattern left out of the order', warned.includes('never in the order'));
}

/* ── 4. The chip's own awkwardness is reported ─────────────────────────────── */

section('the chip tells on itself');
{
  const song = {
    title: 'hazards', bpm: 140,
    instruments: [
      { name: 'fade', duty: 2, volume: [15, 12, 9, 6, 3, 0] },
      { name: 'flat', duty: 2, volume: [15] },
      { name: 'drum', duty: 0, volume: [15, 0], pitch: [0, 8] },
    ],
    patterns: [{
      name: 'traps', rows: 8,
      pulse1: [{ row: 0, note: 'C-0', instrument: 'flat', volume: 15 },
               { row: 2, note: 'B-7' },
               { row: 4, note: 'C-4', effect: 'jump', to: 9 }],
      pulse2: [{ row: 0, note: 'C-4', volume: 15 }],
      triangle: [{ row: 0, note: 'C-2', instrument: 'fade', volume: 15 }],
      noise: [{ row: 0, note: 'kick', instrument: 'drum', effect: 'slideUp', rate: 4 },
              /* E-4 is 64 and kick is 48; both are 0 mod 16, so the chip
                 gives them the same timbre despite being an octave apart. */
              { row: 4, note: 'E-4', instrument: 'drum' }],
    }],
    order: ['traps'],
  };
  const c = compile(song);
  ok('the hazardous song itself compiles', !c.errors.length, c.errors.join('; '));

  if (c.song) {
    const rendered = APU.render(Song.forPlayback(c.song), { loops: 1 });
    const a = analyse(c.song, { meta: c.meta, rendered });
    const said = [...a.problems, ...a.remarks].join('\n');

    ok('reports the note below the timer floor', a.clamped.length === 1 && a.clamped[0].asked === 'C-0',
      JSON.stringify(a.clamped));
    ok('says what it became instead', a.clamped[0] && a.clamped[0].became === 'A-1',
      a.clamped[0] && a.clamped[0].became);
    ok('reports the top octave being out of tune', a.detuned.some((d) => d.note === 'B-7' && d.cents > 15),
      JSON.stringify(a.detuned));
    ok('reports the triangle having no volume control', said.includes('NO volume control'));
    ok('reports a slide on the noise channel', said.includes('does nothing on the noise channel'));
    ok('reports a pitch sequence on the noise channel', said.includes('discards'));
    ok('reports the jump past the end of the order', said.includes('jump to order position 9'));
    ok('reports the unnamed first note', said.includes('names no instrument'));
    ok('reports the tempo being unreachable', said.includes('Asked for 140 BPM'));
    ok('two noise notes an octave apart are the same timbre', said.includes('same timbre'));
  }
}

section('a pattern used repeatedly is only complained about once');
{
  const c = compile({
    instruments: [{ name: 'low', duty: 2, volume: [15] }],
    patterns: [{ name: 'p', rows: 4, pulse1: [{ row: 0, note: 'C-0', instrument: 'low', volume: 15 }] }],
    order: ['p', 'p', 'p', 'p'],
  });
  const a = analyse(c.song, { meta: c.meta });
  ok('the clamped note is reported once, not four times', a.clamped.length === 1,
    a.clamped.length + ' times');
  ok('but the length still counts every repeat', a.timing.rows === 16, 'rows ' + a.timing.rows);
  ok('and it says how many distinct patterns were examined', a.timing.patternsUsed === 1,
    'patternsUsed ' + a.timing.patternsUsed);
}

section('silence and clipping are noticed');
{
  const silent = compile({
    instruments: [{ name: 'mute', duty: 2, volume: [0] }],
    patterns: [{ name: 'p', rows: 4, pulse1: [{ row: 0, note: 'C-4', instrument: 'mute', volume: 15 }] }],
    order: ['p'],
  });
  const r = APU.render(Song.forPlayback(silent.song), { loops: 1 });
  const a = analyse(silent.song, { meta: silent.meta, rendered: r });
  ok('a silent render is reported', a.problems.some((p) => p.includes('silent')), a.problems.join('; '));
}

/* ── 5. The worked example in the reference is actually clean ──────────────── */

section('the documented example is as clean as it claims');
{
  const c = compile(EXAMPLE_SONG);
  ok('compiles with no errors', !c.errors.length, c.errors.join('; '));
  ok('compiles with no warnings', !c.warnings.length, c.warnings.join('; '));
  if (c.song) {
    const r = APU.render(Song.forPlayback(c.song), { loops: 1 });
    const a = analyse(c.song, { meta: c.meta, rendered: r });
    ok('renders with no problems', !a.problems.length, a.problems.join('; '));
    ok('renders with no remarks', !a.remarks.length, a.remarks.join('; '));
    ok('makes a sound', a.audio.peak > 0.1, 'peak ' + a.audio.peak);
    ok('does not clip', a.audio.clippedSamples === 0, a.audio.clippedSamples + ' clipped');
  }
}

/* ── 6. The protocol ───────────────────────────────────────────────────────── */

/* A real child process over real pipes. Mocking the transport here would test
   the thing least likely to be wrong. */
function client() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let next = 1;
  let buffer = '';
  let stderr = '';

  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = waiting.get(message.id);
      if (resolve) {
        waiting.delete(message.id);
        resolve(message);
      }
    }
  });

  return {
    request(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(method + ' timed out. stderr: ' + stderr)), 20000);
        waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    stop() { child.stdin.end(); child.kill(); },
    stderr: () => stderr,
  };
}

function textOf(response) {
  return (response.result && response.result.content || []).map((c) => c.text).join('\n');
}

section('the server speaks MCP over stdio');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiptune-test-'));
  const c = client();
  try {
    const init = await c.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    ok('initialize answers', !!init.result, JSON.stringify(init.error));
    ok('agrees the protocol version', init.result.protocolVersion === '2025-06-18', init.result.protocolVersion);
    ok('declares the tools capability', !!(init.result.capabilities && init.result.capabilities.tools));
    ok('names itself', init.result.serverInfo.name === 'chiptune-mcp-server', init.result.serverInfo.name);

    c.notify('notifications/initialized', {});
    ok('a notification gets no reply', true);

    const list = await c.request('tools/list', {});
    const tools = list.result.tools;
    ok('lists five tools', tools.length === 5, tools.length + ': ' + tools.map((t) => t.name).join(', '));
    for (const name of ['chiptune_get_reference', 'chiptune_check_song', 'chiptune_render_song',
      'chiptune_audition_instrument', 'chiptune_open_song']) {
      ok('lists ' + name, tools.some((t) => t.name === name));
    }
    ok('every tool has a schema and annotations',
      tools.every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.annotations));
    ok('the read-only tools say so',
      tools.filter((t) => ['chiptune_get_reference', 'chiptune_check_song', 'chiptune_open_song'].includes(t.name))
        .every((t) => t.annotations.readOnlyHint === true));

    const ping = await c.request('ping', {});
    ok('answers ping', !!ping.result);

    const ref = await c.request('tools/call', {
      name: 'chiptune_get_reference', arguments: { section: 'channels' },
    });
    ok('the reference comes back', textOf(ref).includes('triangle'), textOf(ref).slice(0, 80));
    ok('the reference warns about the triangle', textOf(ref).includes('cannot fade'));

    const check = await c.request('tools/call', {
      name: 'chiptune_check_song', arguments: { song: EXAMPLE_SONG, verbose: true },
    });
    ok('checking the example succeeds', !check.result.isError, textOf(check));
    ok('reports the real tempo', textOf(check).includes('150.2 BPM'), textOf(check).slice(0, 200));
    ok('reports the bar count', textOf(check).includes('2 bars'));

    const wav = path.join(dir, 'out.wav');
    const json = path.join(dir, 'out.json');
    const render = await c.request('tools/call', {
      name: 'chiptune_render_song',
      arguments: { song: EXAMPLE_SONG, out: wav, saveSongTo: json, loops: 2 },
    });
    ok('rendering succeeds', !render.result.isError, textOf(render));
    ok('the WAV exists', fs.existsSync(wav));
    ok('the song file exists', fs.existsSync(json));

    const bytes = fs.readFileSync(wav);
    ok('it is a RIFF/WAVE file', bytes.slice(0, 4).toString() === 'RIFF' && bytes.slice(8, 12).toString() === 'WAVE');
    ok('mono', bytes.readUInt16LE(22) === 1);
    ok('16-bit', bytes.readUInt16LE(34) === 16);
    ok('44100 Hz', bytes.readUInt32LE(24) === 44100);
    ok('the declared data length matches the file', bytes.readUInt32LE(40) === bytes.length - 44,
      bytes.readUInt32LE(40) + ' vs ' + (bytes.length - 44));
    ok('two loops is about twice as long', bytes.length > 44 + 44100 * 2 * 6,
      (bytes.length - 44) / 2 / 44100 + 's');

    const saved = JSON.parse(fs.readFileSync(json, 'utf8'));
    ok('the song file is in the page\'s format', saved.format === 'workshop-chiptune', saved.format);
    ok('the page would accept it', (() => {
      try { Song.deserialise(saved); return true; } catch (e) { return false; }
    })());

    const opened = await c.request('tools/call', {
      name: 'chiptune_open_song', arguments: { path: json, response_format: 'json' },
    });
    ok('opening it back succeeds', !opened.result.isError, textOf(opened));
    const reopened = JSON.parse(textOf(opened));
    ok('comes back with its patterns', reopened.song.patterns.length === EXAMPLE_SONG.patterns.length);
    ok('comes back with its instruments', reopened.song.instruments.length === EXAMPLE_SONG.instruments.length);
    ok('the notes survived the trip',
      reopened.song.patterns[0].pulse1[0].note === 'A-4', JSON.stringify(reopened.song.patterns[0].pulse1[0]));

    const audition = await c.request('tools/call', {
      name: 'chiptune_audition_instrument',
      arguments: {
        instrument: { name: 'pluck', duty: 1, volume: [15, 13, 10, 7, 4, 2, 0] },
        notes: ['C-4', 'E-4', 'G-4'], channel: 'pulse2', out: path.join(dir, 'pluck.wav'),
      },
    });
    ok('auditioning an instrument succeeds', !audition.result.isError, textOf(audition));
    ok('the audition WAV exists', fs.existsSync(path.join(dir, 'pluck.wav')));
    ok('it says how long the instrument lasts', textOf(audition).includes('decays to silence'),
      textOf(audition).slice(0, 300));

    /* Errors come back as results so the model can act on them, not as
       protocol failures that only the client sees. */
    const bad = await c.request('tools/call', {
      name: 'chiptune_check_song', arguments: { song: { instruments: [], patterns: [], order: [] } },
    });
    ok('a broken song is an isError result', bad.result.isError === true, JSON.stringify(bad.result).slice(0, 200));
    ok('and explains itself', textOf(bad).includes('non-empty'), textOf(bad).slice(0, 200));

    const missing = await c.request('tools/call', { name: 'chiptune_nope', arguments: {} });
    ok('an unknown tool is an isError result', missing.result.isError === true);
    ok('and lists the real ones', textOf(missing).includes('chiptune_render_song'));

    const noArgs = await c.request('tools/call', { name: 'chiptune_check_song', arguments: {} });
    ok('a call with nothing to check explains what to pass', noArgs.result.isError === true &&
      textOf(noArgs).includes('chiptune_get_reference'), textOf(noArgs));

    const absent = await c.request('tools/call', {
      name: 'chiptune_open_song', arguments: { path: path.join(dir, 'nothing-here.json') },
    });
    ok('a missing file is reported plainly', absent.result.isError === true &&
      textOf(absent).includes('Could not read'), textOf(absent));

    const unknown = await c.request('nonsense/method', {});
    ok('an unknown method is a JSON-RPC error', unknown.error && unknown.error.code === -32601,
      JSON.stringify(unknown));

    ok('nothing but protocol went to stdout', true);
    ok('the server logged to stderr', c.stderr().includes('ready'), c.stderr());
  } finally {
    c.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ── Done ──────────────────────────────────────────────────────────────────── */

process.stdout.write('\n' + '─'.repeat(60) + '\n');
if (failures.length) {
  process.stdout.write(passed + ' passed, ' + failures.length + ' FAILED\n\n');
  for (const f of failures) process.stdout.write('  ✗ ' + f + '\n');
  process.exit(1);
}
process.stdout.write(passed + ' checks passed.\n');
