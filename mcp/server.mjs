#!/usr/bin/env node
/* Felix' Workshop, as tools an agent can use.

   The site is a folder of browser tools, and a browser tool wants somebody
   sitting in front of it. But almost none of the arithmetic does: every
   substantial tool here is already built in two halves, the engine in modules
   of its own and a script.js that is the only thing touching the DOM. So the
   engines run under Node unchanged, and the half that needed a person becomes
   optional. Ask Claude Code for eight bars in A minor and a WAV lands on disk;
   ask it to take a name out of a PDF and the characters leave the file.

   One server rather than one per tool, for two reasons. Nobody installs eight
   MCP servers, and the transport, the engine loader and the reporting
   conventions would otherwise be copy-pasted eight times.

   But the cost that matters is not the number of servers, it is the number of
   tools: every schema here sits in the model's context in every conversation,
   whether or not anybody asks for music. So this is deliberately not an
   inventory of the site. A tool earns a place by being something an agent
   cannot already do — writing a song for hardware with four voices and no
   second chances, or removing text from a PDF rather than painting over it —
   and the ones that are only a convenience in front of a canvas stay on the
   web page where they belong.

       node mcp/server.mjs

   Protocol messages go to stdout and must be the only thing there; anything
   worth saying goes to stderr. */

import { serve, log } from './lib/rpc.mjs';
import { tools as chiptune } from './chiptune/tools.mjs';
import { tools as pdf } from './pdf/tools.mjs';

const tools = [...chiptune, ...pdf];

serve({
  tools,
  serverInfo: { name: 'workshop-mcp-server', version: '1.0.0' },
  instructions:
    'The engines behind the browser tools at workshop.fubl.org, running headless. Two sets of tools.\n\n' +
    'Music for the NES sound chip (chiptune_*): four voices, one note each, rendered by the same code ' +
    'the tracker page runs. Start with chiptune_get_reference, and read what chiptune_check_song ' +
    'reports — this chip rounds pitches, silences notes it cannot reach and gives the triangle no ' +
    'volume control, none of which is audible from a file.\n\n' +
    'PDFs (pdf_*): a PDF implementation written from scratch, no library. Reading text with positions, ' +
    'redaction that rewrites the page so the characters leave the file rather than being painted over, ' +
    'metadata with what each field discloses, and page rearrangement. Start with pdf_inspect_file.',
});

log('ready — ' + tools.length + ' tools (' + chiptune.length + ' chiptune, ' + pdf.length + ' pdf)');
