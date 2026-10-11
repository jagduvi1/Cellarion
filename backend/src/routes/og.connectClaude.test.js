/**
 * GET /api/og/connect-ai/claude — the crawler-rendered beginner's guide to
 * connecting Claude.
 *
 * nginx sends crawler user-agents (search engines, AI crawlers, link-preview
 * bots) here instead of the empty SPA shell, whose title and og:url are the
 * homepage's. The test pins that the page says what the guide says (the free
 * plan, the four steps, the address to paste), that its JSON-LD parses, and
 * that a shared link previews as this page.
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
  const res = await fetch(`${baseUrl}/api/og/connect-ai/claude`);
  return { res, html: await res.text() };
};

const jsonLd = (html) =>
  JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);

describe('GET /api/og/connect-ai/claude', () => {
  test('renders the guide as text: free plan, the address to paste, the consent step', async () => {
    const { res, html } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(html).toContain('<h1>Ask Claude about your wine cellar</h1>');
    expect(html).toContain('/api/mcp');
    expect(html).toMatch(/free plan/i);
    expect(html).toContain('Add custom connector');
    expect(html).toContain('Approve');
  });

  test('previews as this page, not the homepage', async () => {
    const { res, html } = await get();
    expect(html).toMatch(/<link rel="canonical" href="[^"]+\/connect-ai\/claude"/);
    expect(html).toMatch(/<meta property="og:url" content="[^"]+\/connect-ai\/claude"/);
    expect(html).toMatch(/<meta property="og:title" content="Ask Claude about your wine cellar/);
    expect(res.headers.get('cache-control')).toMatch(/max-age=3600/);
  });

  test('emits parseable HowTo + FAQPage + BreadcrumbList JSON-LD that cannot be broken out of', async () => {
    const { html } = await get();
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    expect(block).not.toMatch(/[<>]/);

    const graph = jsonLd(html)['@graph'];
    const types = graph.map((n) => n['@type']);
    expect(types).toEqual(expect.arrayContaining(['HowTo', 'FAQPage', 'BreadcrumbList']));

    const howTo = graph.find((n) => n['@type'] === 'HowTo');
    expect(howTo.step).toHaveLength(4);
    expect(howTo.step.map((s) => s.position)).toEqual([1, 2, 3, 4]);

    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    expect(faq.mainEntity.length).toBeGreaterThan(0);
    for (const q of faq.mainEntity) expect(q.acceptedAnswer.text).toBeTruthy();
  });

  test('the /connect-ai crawler page links to the guide', async () => {
    const html = await (await fetch(`${baseUrl}/api/og/connect-ai`)).text();
    expect(html).toMatch(/<a href="[^"]+\/connect-ai\/claude">/);
  });
});
