/**
 * GET /api/og/connect-ai — the crawler-rendered MCP set-up page.
 *
 * This page exists so AI crawlers learn that this instance HAS an MCP server:
 * nginx routes crawler user-agents here instead of the empty SPA shell. The
 * value is entirely in the rendered text, so the test pins that the endpoints
 * actually appear, that the JSON-LD is parseable, and that the script block
 * cannot be broken out of.
 */

const express = require('express');
const http = require('http');
const ogRouter = require('./og');

let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api/og', ogRouter);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

const get = async () => {
  const res = await fetch(`${baseUrl}/api/og/connect-ai`);
  return { status: res.status, type: res.headers.get('content-type'), html: await res.text() };
};

describe('GET /api/og/connect-ai', () => {
  test('renders HTML naming BOTH MCP endpoints as literal text', async () => {
    const { status, type, html } = await get();
    expect(status).toBe(200);
    expect(type).toMatch(/text\/html/);
    // The whole point of the page — a crawler must be able to read these
    // without executing any JavaScript.
    expect(html).toContain('/api/mcp');
    expect(html).toContain('/api/mcp/public');
    expect(html).toContain('/.well-known/oauth-protected-resource/api/mcp');
    // The public endpoint has to be identifiable as the no-account one.
    expect(html).toMatch(/no account/i);
  });

  // Drift guard. This page duplicates the client list from the SPA's
  // `connectAi.clients.*` locale block, and the first version of it silently
  // shipped without Claude Code and Gemini CLI — invisible to exactly the
  // audience the page exists for. Every client family the SPA lists must be
  // named here too; add to both when a new one is supported.
  test('names every client family the SPA page lists', async () => {
    const { html } = await get();
    for (const client of [
      'Claude',
      'Claude Code',
      'Claude Desktop',
      'ChatGPT',
      'VS Code',
      'Cursor',
      'Gemini CLI',
      'LM Studio',
      'cellarion-mcp',
    ]) {
      expect(html).toContain(client);
    }
  });

  test('emits valid, parseable HowTo + BreadcrumbList JSON-LD', async () => {
    const { html } = await get();
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();

    // serializeJsonLd escapes < > & as \uXXXX, which JSON.parse resolves back.
    const parsed = JSON.parse(match[1]);
    const types = parsed['@graph'].map((n) => n['@type']);
    expect(types).toContain('HowTo');
    expect(types).toContain('BreadcrumbList');

    const howTo = parsed['@graph'].find((n) => n['@type'] === 'HowTo');
    expect(howTo.step.length).toBeGreaterThan(0);
    // Positions must be 1-based and contiguous or crawlers reorder the steps.
    expect(howTo.step.map((s) => s.position)).toEqual(howTo.step.map((_, i) => i + 1));
  });

  test('the JSON-LD block cannot be broken out of', async () => {
    const { html } = await get();
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    // Raw angle brackets inside the block would let a crafted string close the
    // <script> element early.
    expect(block).not.toMatch(/[<>]/);
  });

  test('sets a canonical URL and is cacheable', async () => {
    const res = await fetch(`${baseUrl}/api/og/connect-ai`);
    expect(res.headers.get('cache-control')).toMatch(/max-age=3600/);
    const html = await res.text();
    expect(html).toMatch(/<link rel="canonical" href="[^"]+\/connect-ai"/);
  });
});
