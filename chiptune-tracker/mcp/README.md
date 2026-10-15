# Chiptune Tracker, for agents

An MCP server that writes music for the NES sound chip. It turns
[Chiptune Tracker](../) from a page somebody sits in front of into something an
agent can compose with: ask Claude Code for eight bars in A minor and a WAV
lands on disk. The editor never has to be opened, though the song file written
alongside the audio opens there if you want to keep working by hand.

It is the page's own engine, not a port of it. [`apu.js`](../apu.js) and
[`song.js`](../song.js) touch neither the DOM nor the Web Audio API, so they
load into Node unchanged — which is the whole reason this is cheap to maintain
and the reason it sounds right. There is one 2A03 in this repository and both
the page and this server play it, so the WAV written here is the WAV the page
would have exported. The test suite asserts that sample for sample.

No dependencies, no build step, no install, no package.json. MCP over stdio is
newline-delimited JSON-RPC and nothing else, so the server is four files of
plain JavaScript. It opens no sockets; it reads and writes only the paths it is
given.

## Setting it up

In Claude Code, from a clone of this repository:

```sh
claude mcp add chiptune -- node "$PWD/chiptune-tracker/mcp/server.mjs"
```

Or, for any MCP client that takes the usual JSON — `.mcp.json` in a project,
`claude_desktop_config.json`, or whatever your client calls it:

```json
{
  "mcpServers": {
    "chiptune": {
      "command": "node",
      "args": ["/absolute/path/to/chiptune-tracker/mcp/server.mjs"]
    }
  }
}
```

Node 18 or newer. Nothing to `npm install`.

## The five tools

| tool | what it is for |
|---|---|
| `chiptune_get_reference` | The chip, the song format, the four channels, instruments, the effect table, a complete worked song. Sections are fetched one at a time. Read this first. |
| `chiptune_check_song` | Renders nothing to disk and reports what the chip would do to the song. Call it before rendering. |
| `chiptune_render_song` | Writes a mono 16-bit WAV, and optionally a `.json` the browser tracker can open. |
| `chiptune_audition_instrument` | One instrument on its own, a few notes, so its envelope can be checked while it is being designed. |
| `chiptune_open_song` | Reads a saved `.json` — including one saved from the page — back into the readable form these tools take. |

## Reading the diagnostics is the point

A person at the tracker learns in one second that the triangle will not fade and
that their bass line came out an octave higher than they wrote it. From here
both are silent, and a WAV gives nothing back. So the server does the listening
as arithmetic and says what it found:

- **Notes the timer could not reach.** The period is 11 bits, so a pulse bottoms
  out at A-1 and the triangle an octave below. Underneath that a note is not
  quiet, it is a different note — and the server names the one you actually got.
- **How far off each note landed, in cents.** Every pitch is the nearest integer
  divider off a 1.789773 MHz clock, and the rounding coarsens as you go up:
  around B-7 it is about 19 cents sharp.
- **Volume sequences on the triangle,** which has no volume control at all. A
  careful six-step fade there is an abrupt cut at the first zero.
- **Effects and pitch sequences written on the noise channel,** which has no
  timer to bend and discards them.
- **Tempos that do not exist.** A row lasts a whole number of video frames, so
  speed 6 is 150.2 BPM and speed 7 is 128.8 and there is nothing in between. Ask
  for 140 and the server tells you what you got and what the neighbours are.
- **A mix that clips, and a render that came out silent** — which is the least
  useful possible result and the easiest to ship without noticing.

It also refuses rather than guesses. A misspelled `instuments` would otherwise
render a minute of silence, so unknown fields, unknown instrument and pattern
names, out-of-range rows, two notes on one row of one channel, and effect
parameters given as numbers where hex was meant are all errors with a position
and a suggested fix. Nothing is quietly clamped.

## A session

```
> write me eight bars of something in A minor and let me hear it

  chiptune_get_reference   section: "overview"
  chiptune_get_reference   section: "example"
  chiptune_check_song      song: {...}
      → 128.8 BPM · speed 7 · 128 rows ≈ 8 bars of 4/4
        ## Probably not what you wanted
        - "bass" plays on the triangle with a volume sequence of 6 values, but
          the triangle has NO volume control …
  chiptune_check_song      song: {...}          (bass volume now [15])
      → Nothing the chip had to refuse or round badly.
  chiptune_render_song     out: "ladder.wav", saveSongTo: "ladder.json"
      → Wrote ladder.wav — 14.91s, 1284 kB, mono 44100 Hz
```

Then play it: `afplay ladder.wav` on macOS, `aplay ladder.wav` on Linux,
`start ladder.wav` on Windows. The render tool prints the right one for the
platform it is running on.

## The song format

The saved format in `song.js` is built to be small — a pattern is a sparse map
keyed by `row * 4 + channel`, a cell is the tuple `[note, instrument, volume,
effect, param]`, and parameters are hex. That is right for a file that has to
stay a few kilobytes and wrong for something composing without ears: an
off-by-four lands a bass note on the noise channel and `0x37` written as `37`
detunes an arpeggio by three octaves.

So these tools take a second dialect of the same song, and it compiles to the
real thing before it reaches the real player. Channels, instruments and patterns
are named; notes are written the way the tracker prints them; effects carry
named parameters:

```json
{
  "title": "two bars",
  "speed": 6,
  "rowsPerBeat": 4,
  "instruments": [
    { "name": "lead", "duty": 2, "volume": [15, 14, 13, 12, 11, 10] },
    { "name": "bass", "duty": 0, "volume": [15] }
  ],
  "patterns": [
    {
      "name": "verse",
      "rows": 16,
      "pulse1": [
        { "row": 0, "note": "A-4", "instrument": "lead", "volume": 15 },
        { "row": 8, "note": "E-4", "effect": "vibrato", "speed": 3, "depth": 4 },
        { "row": 14, "note": "OFF" }
      ],
      "triangle": [
        { "row": 0, "note": "A-2", "instrument": "bass", "volume": 15 }
      ]
    }
  ],
  "order": ["verse", "verse"]
}
```

`chiptune_get_reference` with section `format` describes every field, and
`example` gives a complete song with drums and arpeggiated chords.

## The files

| file | |
|---|---|
| `server.mjs` | The JSON-RPC stdio server and the five tool definitions. |
| `engine.mjs` | Loads `../apu.js` and `../song.js` into Node. |
| `song-format.mjs` | The agent-writable dialect, and the compiler both ways. |
| `analyse.mjs` | What the chip did to the song, and the report. |
| `reference.mjs` | The documentation the tools serve, built from the same tables the compiler validates against. |
| `test.mjs` | The self-test. |

## Testing

```sh
node chiptune-tracker/mcp/test.mjs
```

113 checks, no framework — a test file that needs installing is a test file that
stops being run. It renders the page's demo song both directly and through a
round trip of the agent-facing format and asserts every sample is identical;
feeds in a song with fifteen deliberate mistakes and checks each one is reported;
checks the chip's awkwardness is all surfaced; and runs the protocol against a
real child process over real pipes, calling every tool.
