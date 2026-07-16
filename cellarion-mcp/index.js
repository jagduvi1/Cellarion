#!/usr/bin/env node
/* cellarion-mcp — stdio ⇄ Streamable HTTP bridge.
 *
 * Runs on the USER's machine (zero Cellarion server cost) and lets stdio-only
 * MCP clients (Claude Desktop, Cursor, …) talk to a Cellarion server's
 * /api/mcp endpoint with a personal API token. It is a transparent proxy:
 * tools, resources and the server instructions come from the remote — nothing
 * is defined here, so new server capabilities appear without updating this
 * package.
 *
 * Config (env, or --url/--token args):
 *   CELLARION_TOKEN  required — a `cel_…` personal API token (Settings → API
 *                    tokens; `read` scope is enough for everything read-only)
 *   CELLARION_URL    default https://cellarion.app — set for self-hosted
 *
 * stdio protocol rule: stdout belongs to MCP. All diagnostics go to stderr.
 */
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const VERSION = createRequire(import.meta.url)('./package.json').version;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const RAW_URL = arg('url') || process.env.CELLARION_URL || 'https://cellarion.app';
const TOKEN = arg('token') || process.env.CELLARION_TOKEN;

// Resolve /api/mcp against the ORIGIN of the configured URL — tolerant of
// trailing slashes, stray paths or query strings in the config value (the API
// always lives at the domain root, also on self-hosted installs).
let MCP_URL;
try {
  MCP_URL = new URL('/api/mcp', RAW_URL);
} catch {
  process.stderr.write(`cellarion-mcp: CELLARION_URL is not a valid URL: ${RAW_URL}\n`);
  process.exit(1);
}
if (MCP_URL.protocol === 'http:' && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(MCP_URL.hostname)) {
  process.stderr.write(`cellarion-mcp: WARNING — ${MCP_URL.origin} is plain http; your token travels unencrypted. Use https.\n`);
}

if (!TOKEN) {
  process.stderr.write(
    'cellarion-mcp: no token.\n' +
    'Mint a personal API token in Cellarion (Settings → API tokens, "read" scope)\n' +
    'and pass it as CELLARION_TOKEN (or --token). Self-hosted? Also set CELLARION_URL.\n'
  );
  process.exit(1);
}

async function connectRemote() {
  const client = new Client({ name: 'cellarion-mcp-bridge', version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }));
  return client;
}

let remoteClient = null;
// One reconnect attempt per failed call — but ONLY for transport-level
// failures (dropped connection, network blip). A JSON-RPC error (McpError:
// unknown tool, invalid params, server-side error result) means the remote
// EXECUTED the request; retrying it would be wrong today and dangerous once
// write tools exist, so those propagate unchanged.
async function remote(fn) {
  if (!remoteClient) remoteClient = await connectRemote();
  try {
    return await fn(remoteClient);
  } catch (err) {
    if (err instanceof McpError) throw err;
    try { await remoteClient.close(); } catch { /* already dead */ }
    remoteClient = await connectRemote();
    return fn(remoteClient);
  }
}

async function main() {
  // Connect eagerly: fail fast on a bad token/URL (before the client believes
  // the server is up), and fetch the remote instructions for our initialize.
  try {
    remoteClient = await connectRemote();
  } catch (err) {
    process.stderr.write(
      `cellarion-mcp: cannot reach ${MCP_URL} — ${err?.message || err}\n` +
      'Check CELLARION_URL, and that the token is valid and not revoked.\n'
    );
    process.exit(1);
  }
  const instructions = remoteClient.getInstructions?.() || undefined;
  const remoteVersion = remoteClient.getServerVersion?.()?.version;

  const server = new Server(
    { name: 'cellarion', version: remoteVersion || VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions }
  );

  // Full passthrough incl. req.params, so pagination cursors survive the hop
  // if the server ever starts paginating its lists.
  server.setRequestHandler(ListToolsRequestSchema, (req) => remote((c) => c.listTools(req.params)));
  server.setRequestHandler(CallToolRequestSchema, (req) => remote((c) => c.callTool(req.params)));
  server.setRequestHandler(ListResourcesRequestSchema, (req) => remote((c) => c.listResources(req.params)));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) => remote((c) => c.listResourceTemplates(req.params)));
  server.setRequestHandler(ReadResourceRequestSchema, (req) => remote((c) => c.readResource(req.params)));

  // When the client closes our stdin (Claude Desktop quitting), take the
  // remote connection down with us instead of lingering on an open stream.
  // server.onclose is the SDK's public hook — the transport's own onclose is
  // owned by the Protocol internals and must not be overwritten.
  server.onclose = () => {
    Promise.resolve().then(() => remoteClient?.close()).catch(() => {}).finally(() => process.exit(0));
  };
  await server.connect(new StdioServerTransport());
  process.stderr.write(`cellarion-mcp v${VERSION} → ${MCP_URL.origin} (server v${remoteVersion || '?'}) ready\n`);
}

main().catch((err) => {
  process.stderr.write(`cellarion-mcp: fatal — ${err?.stack || err}\n`);
  process.exit(1);
});
