/* Bridge e2e — spawns the actual bin over stdio (exactly as Claude Desktop
 * would) against a live Cellarion backend and verifies the full proxy chain:
 * stdio client → bridge → Streamable HTTP → /api/mcp.
 *
 *   CELLARION_TOKEN=cel_… node e2e.js            # or a JWT for a dev stack:
 *   CELLARION_URL=http://127.0.0.1:5000 CELLARION_TOKEN=$(…login…) node e2e.js
 *
 * Not part of any CI suite (needs a live stack); companion to backend
 * `npm run mcp:e2e`, which tests the server side.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

if (!process.env.CELLARION_TOKEN) fail('set CELLARION_TOKEN (cel_ token, or a JWT against a dev stack)');

const client = new Client({ name: 'bridge-e2e', version: '0.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'index.js')],
  env: {
    ...process.env,
    CELLARION_URL: process.env.CELLARION_URL || 'http://127.0.0.1:5000',
  },
}));
console.log('  ✓ bridge spawned + initialize over stdio');

const { tools } = await client.listTools();
if (tools.length < 14) fail(`expected >=14 proxied tools, got ${tools.length}`);
console.log(`  ✓ tools/list proxied → ${tools.length} tools`);

const res = await client.callTool({ name: 'get_source_info', arguments: {} });
const info = JSON.parse(res.content.find((c) => c.type === 'text').text);
if (info.license !== 'AGPL-3.0') fail('get_source_info payload wrong through the bridge');
console.log(`  ✓ tools/call proxied → Cellarion v${info.version}`);

const cellars = JSON.parse((await client.callTool({ name: 'list_cellars', arguments: {} })).content[0].text);
if (cellars.error) fail('list_cellars errored: ' + JSON.stringify(cellars.error));
console.log(`  ✓ authenticated data through the bridge → ${cellars.summary}`);

const { resources } = await client.listResources();
if (!resources.some((r) => r.uri === 'cellar://snapshot')) fail('resources not proxied');
const about = await client.readResource({ uri: 'cellarion://about' });
if (!about.contents[0].text.includes('AGPL-3.0')) fail('resource read wrong through the bridge');
console.log('  ✓ resources listed + read through the bridge');

await client.close();
console.log('\nBRIDGE E2E PASSED');
process.exit(0);
