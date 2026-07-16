/* MCP tool-selection eval (plan §9) — measures whether a REAL model, given our
 * live tool list + server instructions, reaches for the right tool on natural
 * user phrasings. This is the feedback loop for tool names/descriptions: when
 * a case fails consistently, fix the description, not the case.
 *
 * Opt-in (costs real API tokens):
 *   ANTHROPIC_API_KEY=sk-...  node src/mcp/eval/run.js
 * Environment:
 *   CELLARION_URL    target backend (default http://127.0.0.1:5000 — the local
 *                    Docker stack; run `docker exec cellarion-backend node
 *                    src/seed-demo.js` first if the DB is empty)
 *   CELLARION_TOKEN  cel_ token or JWT; else CELLARION_USER/CELLARION_PASS
 *                    (defaults: the seeded demo user)
 *   EVAL_MODEL       default claude-opus-4-8
 *   EVAL_MIN         accuracy gate 0..1 (default 0.8); exit 1 below it
 *
 * NOT part of jest (needs network + API key). The pure logic lives in lib.js,
 * which IS jest-covered.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { toAnthropicTools, judgeCase, assertValidCases, caseApplies } = require('./lib');
const { CASES } = require('./cases');

const BASE = process.env.CELLARION_URL || 'http://127.0.0.1:5000';
if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(BASE) && process.env.CELLARION_ALLOW_REMOTE !== '1') {
  console.error('Refusing non-local CELLARION_URL without CELLARION_ALLOW_REMOTE=1:', BASE);
  process.exit(2);
}
const MODEL = process.env.EVAL_MODEL || 'claude-opus-4-8';
const MIN = Number(process.env.EVAL_MIN || 0.8);

async function bearer() {
  if (process.env.CELLARION_TOKEN) return process.env.CELLARION_TOKEN;
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.CELLARION_USER || 'user@cellarion.app',
      password: process.env.CELLARION_PASS || 'User1234!demo',
    }),
  });
  if (!r.ok) throw new Error(`login failed (${r.status}) — set CELLARION_TOKEN or CELLARION_USER/PASS`);
  return (await r.json()).token;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — the eval calls a real model and is strictly opt-in.');
    process.exit(2);
  }
  assertValidCases(CASES);
  const token = await bearer();

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'cellarion-eval', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const { tools } = await client.listTools();
  // The server instructions are ambient context in every real client session —
  // the eval must include them or it measures a setup no user actually has.
  const system = client.getInstructions?.() || '';
  await client.close();

  const anthropic = new Anthropic();
  const anthropicTools = toAnthropicTools(tools);

  // The tool surface is scope/role-filtered per token, so only judge cases whose
  // expected tools are actually advertised to THIS token — a somm case is not a
  // failure when a normal user runs the eval, it is out of scope. Skips are
  // reported so a run against the wrong token is obvious, not silently narrowed.
  const advertised = new Set(tools.map((t) => t.name));
  const applicable = CASES.filter((k) => caseApplies(k, advertised));
  const skipped = CASES.length - applicable.length;
  console.log(`Evaluating ${applicable.length} cases against ${MODEL} with ${tools.length} live tools` +
    (skipped ? ` (skipped ${skipped} whose tools this token can't see)` : '') + '\n');

  let passed = 0;
  for (const kase of applicable) {
    let msg;
    try {
      msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system,
      tools: anthropicTools,
      messages: [{ role: 'user', content: kase.prompt }],
    });
    } catch (err) {
      // The SDK already retried transient errors; a hard failure costs this
      // case only — earlier paid results are kept and the gate stays honest.
      console.log(` ✗ ${kase.id.padEnd(24)} API error: ${err.status || err.message}`);
      continue;
    }
    const toolUses = msg.content.filter((c) => c.type === 'tool_use');
    const { pass, detail } = judgeCase(kase, toolUses);
    passed += pass ? 1 : 0;
    console.log(` ${pass ? '✓' : '✗'} ${kase.id.padEnd(24)} ${detail}`);
  }

  const accuracy = applicable.length ? passed / applicable.length : 1;
  console.log(`\nTool-selection accuracy: ${passed}/${applicable.length} (${Math.round(accuracy * 100)}%) — gate ${Math.round(MIN * 100)}%`);
  if (accuracy < MIN) {
    console.error('Below the accuracy gate. Fix tool descriptions (see failing cases), then re-run.');
    process.exit(1);
  }
  console.log('PASS');
}

main().catch((e) => { console.error('EVAL FAILED:', e); process.exit(1); });
