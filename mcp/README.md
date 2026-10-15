# The workshop, for agents

An MCP server that gives the engines behind
[workshop.fubl.org](https://workshop.fubl.org) to Claude Code and anything else
that speaks the protocol. Ask for eight bars in A minor and a WAV lands on disk;
ask for a name to be taken out of a PDF and the characters leave the file.

It is not a port of anything. Every substantial tool on this site is already
built in two halves — the arithmetic in modules of its own, the DOM confined to
`script.js` — so the engines load into Node unchanged, and three of them ship a
`selftest.js` that already said it ran there. The chiptune tracker's chip, and a
PDF implementation written from scratch across twelve files and some 6,700
lines, are both required as they stand. A song rendered here is the tracker's
own render; a blackout applied here removes the bytes the page removes. The test
suite asserts the first of those sample for sample.

No dependencies, no build step, no `package.json`. MCP over stdio is
newline-delimited JSON-RPC and nothing more.

## Setting it up

```sh
claude mcp add workshop -- node "$PWD/mcp/server.mjs"
```

Or, for any client that takes the usual JSON — `.mcp.json` in a project,
`claude_desktop_config.json`, or whatever yours calls it:

```json
{
  "mcpServers": {
    "workshop": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/server.mjs"]
    }
  }
}
```

Node 18 or newer. Nothing to `npm install`.

## Music for the NES sound chip

| tool | |
|---|---|
| `chiptune_get_reference` | The chip, the song format, the four channels, instruments, effects, a worked song. A section at a time. Read this first. |
| `chiptune_check_song` | Writes nothing; reports what the chip would do to the song. |
| `chiptune_render_song` | A mono 16-bit WAV, and optionally a `.json` the tracker page can open. |
| `chiptune_audition_instrument` | One instrument on its own, while it is being designed. |
| `chiptune_open_song` | A saved `.json` — including one saved from the page — back into the readable form. |

Four voices, one note each: two pulse channels, a triangle, noise. A song is
written as JSON with notes spelled the way the tracker prints them and effects
carrying named parameters:

```json
{ "row": 8, "note": "E-4", "effect": "vibrato", "speed": 3, "depth": 4 }
```

The saved format is built to be small — a pattern keyed by `row * 4 + channel`,
cells as positional tuples, parameters in hex — and every one of those
economies is a silent failure for something composing without ears: an
off-by-four lands a bass note on the noise channel, and `0x37` written as `37`
detunes an arpeggio by three octaves. So the tools take a second dialect that
compiles to the real thing before it reaches the real player, and it refuses
rather than clamps. Unknown fields, unknown instrument and pattern names, two
notes on one row of one channel and hex given as a number all come back with a
position and a suggested spelling, because a misspelled `instuments` would
otherwise render a minute of silence.

**The diagnostics are the point.** A person at the tracker learns in one second
that the triangle will not fade and that their bass line came out an octave
above where they wrote it. From a file, both are silent, so the server does the
listening as arithmetic: notes the 11-bit timer could not reach and the ones
they became instead, the cents each landed off, volume sequences on the channel
that has no volume control, effects and pitch sequences the noise channel
discards, the tempo asked for against the one the frame counter allows, a mix
that clipped, a render that came out silent.

## PDFs

| tool | |
|---|---|
| `pdf_inspect_file` | Pages and their sizes, how much text each carries, fonts, and every metadata field with what it discloses. |
| `pdf_read_text` | The text, line by line, with positions if asked. |
| `pdf_redact_text` | Remove words so they leave the file, then check that they did. |
| `pdf_edit_metadata` | Cut or change what the file says about whoever made it. |
| `pdf_rearrange_pages` | Merge, split, extract, reorder, delete, rotate. |

A blackout here is not a black rectangle drawn over a name. The page's own
instructions are rewritten with everything under it removed — the glyphs, any
image lying wholly inside it, any drawing that does — so a text extractor
afterwards has nothing to hand back. Painting over them is what most tools do
and what every leaked-redaction story is about, and on screen the two are the
same black bar.

An agent cannot see the page, so "redact this rectangle" is useless to it. It
gives the words; the server finds the boxes:

```
pdf_redact_text  path: "statement.pdf", out: "redacted.pdf",
                 text: ["Jane Whistleblower", "12 Acacia Avenue"]
```

Those boxes come off the same content-stream walk the redactor itself uses.
Nothing in a content stream says where a glyph lands — it follows from
everything before it, through the transformation matrix, two text matrices and
the text state — so a second interpreter written for searching would be a
second opinion about where a character sits, and the two would disagree on
exactly the material a second opinion is hard to come by on: rotated text, Type
3 fonts, nested forms. The failure would be silent and the wrong way round. The
search says it found the name, the redactor covers a box the name is not in, the
name stays in the file, and the tool reports success. So `pdf-redact.js` grew a
one-line hook that reports each character and its box, and a read is that same
walk with no rectangles to cover anything.

Then it checks its own work and says so: whether each word left the extracted
text, whether it left the raw bytes the way `strings` would read them, which
runs of page instructions could not be interpreted, and **which words it never
found at all** — because "removed 0 occurrences" and "removed them all"
otherwise read the same, and only one of them is true. A redaction that matches
nothing is an error and writes no file.

What it cannot do: take anything out of a picture. A scanned page has no text in
the file, and the tools say so rather than reporting a successful redaction of
nothing.

## Why one server

Nobody installs eight MCP servers, and the transport, the engine loader and the
reporting conventions would otherwise be copy-pasted eight times.

But the cost that matters is not the number of servers, it is the number of
tools: every schema here sits in the model's context in every conversation,
whether or not anybody asks for music. The ten tools above come to about 4,200
tokens, which is less than the five chiptune ones cost before their schemas were
written as prose instead of nested JSON Schema — the detail moved into
`chiptune_get_reference`, where it is fetched when wanted, and into error
messages that name a position and suggest a fix.

So this is deliberately not an inventory of the site. A tool earns a place by
being something an agent cannot already do. Writing for four voices with no
second chances, and taking text out of a file rather than painting over it,
qualify. Drawing pixel art on a grid does not: an agent emits SVG on its own,
and the value of that tool is the canvas and the hand on it.

## The files

| | |
|---|---|
| `server.mjs` | Assembles the tool sets and serves them. |
| `lib/rpc.mjs` | MCP over stdio: the whole protocol surface used here. |
| `lib/engine.mjs` | Loads any of the repo's browser modules into Node. |
| `lib/files.mjs` | Reading and writing the files the tools are asked about. |
| `chiptune/` | The five music tools, the song dialect and its compiler, the diagnostics, the reference. |
| `pdf/` | The five PDF tools, and text extraction off the redactor's own walk. |
| `test.mjs` | The self-test. |

## Testing

```sh
node mcp/test.mjs
```

170 checks, no framework — a test file that needs installing is a test file that
stops being run. It renders the tracker's demo song both directly and through a
round trip of the agent-facing dialect and asserts every sample is identical;
feeds in a song with fifteen deliberate mistakes and checks each one is reported;
runs the PDF toolkit's own selftest, the one that pins the bug where a page was
rewritten correctly while the original stream stayed in the file as an orphan
nothing referred to; finds a word by searching, removes it without being told
where it was, and looks for it again in the re-extracted text and in the raw
bytes while checking its neighbours survived; and runs the protocol against a
real child process over real pipes, calling every tool and every error path.
