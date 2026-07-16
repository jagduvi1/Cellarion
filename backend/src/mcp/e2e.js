/* Full-stack MCP e2e — drives the RUNNING backend (real Mongo/Meili/Qdrant)
 * with the real SDK client. The Docker smoke for the MCP surface:
 *
 *   docker-compose up -d           # then, if the DB is fresh:
 *   docker exec cellarion-backend node src/seed-demo.js
 *   npm run mcp:e2e                # from backend/ (or CELLARION_URL=… node src/mcp/e2e.js)
 *
 * Checks auth negatives (401/405/demo-403/foreign-probe), the initialize
 * handshake, every read tool against seeded data, and both resource kinds.
 * NOT part of jest (needs a live stack). First ran as the pre-merge Docker
 * verification of PRs #705/#707 — kept in-repo so every future MCP change can
 * re-run it in minutes (plan §9; the release checklist should include it).
 */
const BASE = process.env.CELLARION_URL || 'http://127.0.0.1:5000';
// Guard: this script logs in with documented DEV credentials and creates a
// demo session — refuse to point it at anything non-local by accident.
if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(BASE) && process.env.CELLARION_ALLOW_REMOTE !== '1') {
  console.error('Refusing non-local CELLARION_URL without CELLARION_ALLOW_REMOTE=1:', BASE);
  process.exit(2);
}
const MCP = `${BASE}/api/mcp`;

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const okLog = (m) => console.log('  ✓', m);

async function main() {
  let r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.CELLARION_USER || 'user@cellarion.app',
      password: process.env.CELLARION_PASS || 'User1234!demo',
    }),
  });
  if (!r.ok) fail(`login ${r.status} — is the stack up and seeded? (docker exec cellarion-backend node src/seed-demo.js)`);
  const { token } = await r.json();
  okLog('login');

  r = await fetch(MCP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (r.status !== 401) fail(`unauthenticated POST expected 401, got ${r.status}`);
  okLog('no-auth POST → 401');
  r = await fetch(MCP, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 405) fail(`GET expected 405, got ${r.status}`);
  okLog('JWT GET → 405');

  // Ephemeral demo sessions must never reach the MCP (requireNonDemo).
  r = await fetch(`${BASE}/api/auth/demo-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (r.ok) {
    const demo = await r.json();
    const dr = await fetch(MCP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${demo.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    if (dr.status !== 403) fail(`demo POST expected 403, got ${dr.status}`);
    okLog('demo JWT → 403 (requireNonDemo)');
  } else {
    console.log(`  – demo-login unavailable (${r.status}) — demo-block check skipped`);
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'cellarion-e2e', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  okLog('initialize handshake');

  const { tools } = await client.listTools();
  if (tools.length < 14) fail(`expected >=14 tools, got ${tools.length}`);
  okLog(`tools/list → ${tools.length} tools`);

  const parse = (res, { allowError = false } = {}) => {
    const body = JSON.parse(res.content.find((c) => c.type === 'text').text);
    if (body.error && !allowError) fail('tool returned an error envelope: ' + JSON.stringify(body.error));
    return body;
  };

  const cellars = parse(await client.callTool({ name: 'list_cellars', arguments: {} }));
  if (!Array.isArray(cellars.data) || !cellars.data.length) fail('no cellars — seed the stack first');
  okLog(`list_cellars → ${cellars.summary}`);
  const cellarId = String(cellars.data[0].cellar_id);

  const bottles = parse(await client.callTool({ name: 'search_bottles', arguments: { cellar_id: cellarId, limit: 5 } }));
  okLog(`search_bottles(cellar) → ${bottles.summary}`);
  const text = parse(await client.callTool({ name: 'search_bottles', arguments: { query: 'cloudy', limit: 5 } }));
  okLog(`search_bottles(query) → ${text.summary}${text.warnings ? ' [fallback]' : ' (Meili)'}`);

  if (bottles.data.length) {
    const bottleId = String(bottles.data[0].bottle_id);
    const detail = parse(await client.callTool({ name: 'get_bottle', arguments: { bottle_id: bottleId } }));
    if (detail.error) fail('get_bottle errored on own bottle: ' + JSON.stringify(detail.error));
    okLog(`get_bottle → ${detail.summary}`);
    const sim = parse(await client.callTool({ name: 'find_similar_wines', arguments: { bottle_id: bottleId } }));
    okLog(`find_similar_wines → ${sim.summary}`);
  }

  const racks = parse(await client.callTool({ name: 'list_racks', arguments: { cellar_id: cellarId } }));
  okLog(`list_racks → ${racks.summary}`);
  if (racks.data.length) {
    const rack = parse(await client.callTool({ name: 'get_rack', arguments: { rack_id: String(racks.data[0].rack_id) } }));
    okLog(`get_rack → ${rack.summary}`);
  }

  const stats = parse(await client.callTool({ name: 'cellar_stats', arguments: {} }));
  if (!stats.data.overview) fail('cellar_stats missing overview');
  okLog(`cellar_stats → ${stats.summary}`);

  okLog(`list_history → ${parse(await client.callTool({ name: 'list_history', arguments: { limit: 3 } })).summary}`);
  okLog(`list_wishlist → ${parse(await client.callTool({ name: 'list_wishlist', arguments: {} })).summary}`);
  okLog(`list_journal → ${parse(await client.callTool({ name: 'list_journal', arguments: {} })).summary}`);

  const reg = parse(await client.callTool({ name: 'search_registry', arguments: { query: 'cabernet' } }));
  okLog(`search_registry → ${reg.summary}`);
  if (reg.data.length) {
    okLog(`get_wine → ${parse(await client.callTool({ name: 'get_wine', arguments: { wine_id: String(reg.data[0].wine_id) } })).summary}`);
  }

  const { resources } = await client.listResources();
  if (!resources.some((x) => x.uri === 'cellar://snapshot')) fail('snapshot resource missing');
  const snap = JSON.parse((await client.readResource({ uri: 'cellar://snapshot' })).contents[0].text);
  if (!Array.isArray(snap.data)) fail('snapshot envelope wrong');
  okLog(`snapshot → ${snap.summary}`);
  const about = await client.readResource({ uri: 'cellarion://about' });
  if (!about.contents[0].text.includes('AGPL-3.0')) fail('about wrong');
  okLog('about → AGPL-3.0');
  const dossier = JSON.parse((await client.readResource({ uri: `cellar://bottle/${'f'.repeat(24)}` })).contents[0].text);
  if (!dossier.error || dossier.error.code !== 'not_found') fail('foreign dossier probe not not_found');
  okLog('foreign bottle dossier → not_found');

  const foreign = parse(await client.callTool({ name: 'get_bottle', arguments: { bottle_id: 'f'.repeat(24) } }), { allowError: true });
  if (!foreign.error || foreign.error.code !== 'not_found') fail('foreign bottle probe not not_found');
  okLog('foreign bottle id → not_found');

  await client.close();
  console.log('\nALL MCP E2E CHECKS PASSED against ' + BASE);
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
