/* Manual MCP smoke test — drives the REAL server module with the MCP SDK's own
 * client over Streamable HTTP. Run:  node src/mcp/smoke.js
 *
 * NOT part of the jest suite: the SDK is ESM-only and jest's CJS transform can't
 * load it via import(), so end-to-end transport coverage lives here (and, later,
 * in the eval harness — MCP plan §9). Auth/DB are bypassed with an injected ctx
 * so this exercises the MCP layer (registry, scope filtering, transport) in
 * isolation, exactly as the /api/mcp route wires it. */
const express = require('express');
const { handleMcpRequest } = require('./server');

async function main() {
  const ctx = { user: { id: 'smoke-user' }, scopes: ['read'] };

  const app = express();
  app.use(express.json());
  app.post('/api/mcp', (req, res, next) => handleMcpRequest(req, res, ctx).catch(next));
  app.get('/api/mcp', (req, res) => res.status(405).end());

  const httpServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = httpServer.address().port;

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`)));
  console.log('[smoke] initialize handshake: OK');

  const { tools } = await client.listTools();
  console.log('[smoke] tools/list ->', tools.map((t) => t.name));
  if (!tools.some((t) => t.name === 'get_source_info')) throw new Error('get_source_info not advertised');

  const res = await client.callTool({ name: 'get_source_info', arguments: {} });
  const info = JSON.parse(res.content.find((c) => c.type === 'text').text);
  console.log('[smoke] get_source_info ->', info.name, info.version, info.license);
  if (info.license !== 'AGPL-3.0') throw new Error('unexpected get_source_info payload');

  await client.close();
  httpServer.close();
  console.log('[smoke] OK — /api/mcp serves the full initialize -> tools/list -> tools/call round-trip.');
}

main().catch((e) => { console.error('[smoke] FAILED:', e); process.exit(1); });
