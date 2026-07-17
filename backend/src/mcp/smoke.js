/* Manual MCP smoke test — drives the REAL server module with the MCP SDK's own
 * client over Streamable HTTP. Run:  node src/mcp/smoke.js
 *
 * NOT part of the jest suite: the SDK is ESM-only and jest's CJS transform can't
 * load it via import(), so end-to-end transport coverage lives here (and, later,
 * in the eval harness — MCP plan §9). Auth/DB are bypassed with an injected ctx
 * so this exercises the MCP layer (registry, scope filtering, transport,
 * stateful sessions + subscriptions) in isolation, exactly as the /api/mcp
 * route wires it. */
const express = require('express');
const { handleMcpRequest, initStatefulSession } = require('./server');
const { getSession, sessionCounts } = require('./sessions');
const eventBus = require('../services/eventBus');

const isInitialize = (body) => (Array.isArray(body)
  ? body.some((m) => m && m.method === 'initialize')
  : body && body.method === 'initialize');

async function main() {
  const ctx = { user: { id: 'smoke-user' }, scopes: ['read'] };

  const app = express();
  app.use(express.json());
  // Mirrors routes/mcp.js dispatch (session continuation → init → stateless).
  const withSession = (req) => {
    const sid = req.headers['mcp-session-id'];
    if (!sid) return undefined;
    return getSession(sid, { userId: 'smoke-user', tokenId: null }) || null;
  };
  app.post('/api/mcp', (req, res, next) => {
    const session = withSession(req);
    if (session) {
      session.callState.calls = 0;
      session.ctx.req = req;
      return session.transport.handleRequest(req, res, req.body).catch(next);
    }
    if (session === null) return res.status(404).end();
    const reqCtx = { ...ctx, req };
    if (isInitialize(req.body)) {
      return initStatefulSession(req, res, reqCtx)
        .then((handled) => (handled ? undefined : handleMcpRequest(req, res, reqCtx)))
        .catch(next);
    }
    handleMcpRequest(req, res, reqCtx).catch(next);
  });
  app.get('/api/mcp', (req, res, next) => {
    const session = withSession(req);
    if (session) return session.transport.handleRequest(req, res).catch(next);
    res.status(405).end();
  });
  app.delete('/api/mcp', (req, res, next) => {
    const session = withSession(req);
    if (session) return session.transport.handleRequest(req, res).catch(next);
    res.status(405).end();
  });

  const httpServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = httpServer.address().port;

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
  const clientTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`));
  await client.connect(clientTransport);
  console.log('[smoke] initialize handshake: OK');

  const { tools } = await client.listTools();
  console.log('[smoke] tools/list ->', tools.map((t) => t.name));
  if (!tools.some((t) => t.name === 'get_source_info')) throw new Error('get_source_info not advertised');

  const res = await client.callTool({ name: 'get_source_info', arguments: {} });
  const info = JSON.parse(res.content.find((c) => c.type === 'text').text);
  console.log('[smoke] get_source_info ->', info.name, info.version, info.license);
  if (info.license !== 'AGPL-3.0') throw new Error('unexpected get_source_info payload');

  // Resources: list static + template registrations, then read the one
  // resource that needs no database (cellarion://about).
  const { resources } = await client.listResources();
  console.log('[smoke] resources/list ->', resources.map((r) => r.uri));
  if (!resources.some((r) => r.uri === 'cellar://snapshot')) throw new Error('cellar://snapshot not advertised');
  const { resourceTemplates } = await client.listResourceTemplates();
  if (!resourceTemplates.some((t) => t.uriTemplate === 'cellar://bottle/{id}')) throw new Error('bottle template not advertised');
  const about = await client.readResource({ uri: 'cellarion://about' });
  if (!about.contents[0].text.includes('AGPL-3.0')) throw new Error('about resource payload wrong');
  console.log('[smoke] cellarion://about read OK');

  // Prompts (the third primitive, Phase 3): list is scope-filtered — a read
  // ctx must see the read prompts but NOT the write-workflow one — and
  // prompts/get renders the template with its arguments interpolated.
  const { prompts } = await client.listPrompts();
  console.log('[smoke] prompts/list ->', prompts.map((p) => p.name));
  if (!prompts.some((p) => p.name === 'sommelier_pairing')) throw new Error('sommelier_pairing not advertised');
  if (prompts.some((p) => p.name === 'plan_rack_layout')) throw new Error('write prompt leaked to a read-only ctx');
  const rendered = await client.getPrompt({ name: 'sommelier_pairing', arguments: { dish: 'osso buco' } });
  if (!rendered.messages[0].content.text.includes('osso buco')) throw new Error('prompt args not interpolated');
  if (!rendered.messages[0].content.text.includes('pair_with_dish')) throw new Error('prompt lost its workflow');
  console.log('[smoke] prompts round-trip OK (scope-filtered, args interpolated)');

  // Stateful session + subscriptions (Phase 4): the SDK client keeps the
  // Mcp-Session-Id from initialize, resources/subscribe registers interest,
  // an event-bus nudge becomes notifications/resources/updated on the GET
  // stream, and DELETE tears the session down.
  const { ResourceUpdatedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
  if (sessionCounts().total !== 1) throw new Error(`expected 1 live session, have ${sessionCounts().total}`);
  const updated = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { updated.push(n.params.uri); });
  await client.subscribeResource({ uri: 'cellarion://alerts' });
  console.log('[smoke] resources/subscribe accepted');
  let refused = false;
  try { await client.subscribeResource({ uri: 'cellar://bottle/xyz' }); } catch { refused = true; }
  if (!refused) throw new Error('subscribe to a non-subscribable resource must fail');
  eventBus.emit('smoke-user', 'notification', { id: 'x', type: 'drink_window_peak' });
  await new Promise((r) => setTimeout(r, eventBus.DEBOUNCE_MS + 800));
  if (!updated.includes('cellarion://alerts')) throw new Error(`no resources/updated push received (got: ${updated.join(', ') || 'none'})`);
  console.log('[smoke] event-bus nudge → resources/updated push OK');
  await client.unsubscribeResource({ uri: 'cellarion://alerts' });

  // Explicit termination sends the DELETE (a plain close only drops the
  // stream — stateful sessions survive that by design, until the idle TTL).
  await clientTransport.terminateSession();
  await client.close();
  await new Promise((r) => setTimeout(r, 200));
  if (sessionCounts().total !== 0) throw new Error(`session not torn down on DELETE (${sessionCounts().total} left)`);
  console.log('[smoke] session terminated (DELETE) + store empty');

  httpServer.close();
  console.log('[smoke] OK — tools + resources + prompts + sessions/subscriptions round-trip clean on /api/mcp.');
}

main().catch((e) => { console.error('[smoke] FAILED:', e); process.exit(1); });
