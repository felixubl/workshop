/* MCP over stdio, which is newline-delimited JSON-RPC 2.0 and nothing more.

   Hand-written, so the server has no dependencies and nothing to install —
   which is the arrangement the rest of the repository is in. The whole
   protocol surface used here is initialize, tools/list and tools/call; there
   is no resource, prompt, sampling or notification behaviour to get wrong.

   Two rules worth stating because breaking either is silent. Protocol messages
   are the only thing allowed on stdout, so everything else goes to stderr. And
   a tool that fails reports it *inside* its result with isError, not as a
   JSON-RPC error: a protocol error is seen by the client and not by the model,
   so the model cannot act on it, and acting on it is the entire point of
   telling anyone. */

export function log(...args) {
  process.stderr.write('[workshop] ' + args.join(' ') + '\n');
}

/* No version-dependent behaviour here, so the server agrees to whatever the
   client opened with and falls back to the last version it was written
   against. */
const DEFAULT_PROTOCOL = '2025-06-18';

export function serve(options) {
  const { tools, serverInfo, instructions } = options;
  const byName = new Map(tools.map((t) => [t.name, t]));

  function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(message) {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;

    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        reply(id, {
          protocolVersion: typeof asked === 'string' && asked ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo,
          instructions,
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
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        });
        return;

      /* Not advertised in capabilities, but clients probe for them. An empty
         list is a truthful answer and cheaper for both sides than an error. */
      case 'resources/list':
        reply(id, { resources: [] });
        return;
      case 'prompts/list':
        reply(id, { prompts: [] });
        return;

      case 'tools/call': {
        const name = params && params.name;
        const tool = byName.get(name);
        if (!tool) {
          reply(id, {
            isError: true,
            content: [{ type: 'text', text: 'No tool called "' + name + '". Available: ' +
              tools.map((t) => t.name).join(', ') + '.' }],
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
      /* Handled as it arrives rather than awaited in turn: the slowest thing
         here takes a fraction of a second, and JSON-RPC carries ids for
         exactly this reason. */
      handle(message).catch((err) => {
        log('handler failed: ' + (err && err.stack ? err.stack : err));
        if (message && message.id !== undefined && message.id !== null) {
          replyError(message.id, -32603, 'Internal error: ' + ((err && err.message) || String(err)));
        }
      });
    }
  });

  process.stdin.on('end', () => process.exit(0));
}
