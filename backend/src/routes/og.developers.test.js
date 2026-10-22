/**
 * GET /api/og/developers — the crawler-rendered developer guide.
 *
 * nginx sends crawler user-agents here instead of the empty SPA shell, so a
 * search engine or an AI crawler can read the guide and the reference without
 * running JavaScript. Both come from the OpenAPI document; the test pins that
 * the guide's sections, every documented operation and parseable JSON-LD are
 * really in the HTML, and that nothing can break out of the script block.
 */

const express = require('express');
const http = require('http');
const ogRouter = require('./og');
const { buildOpenApiDocument } = require('../openapi/document');
const { developersPageHtml } = require('../openapi/crawlerPage');

let server;
let baseUrl;

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

describe('GET /api/og/developers', () => {
  test('renders the guide and every documented operation as HTML', async () => {
    const res = await fetch(`${baseUrl}/api/og/developers`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(html).toContain('<h1>Cellarion API</h1>');
    for (const heading of ['Getting started', 'Authentication and scopes', 'Errors', 'Rate limits', 'Stability and versioning', 'Security', 'Terms of use']) {
      expect(html).toContain(`>${heading}</h2>`);
    }
    expect(html).toContain('<table>');
    const doc = buildOpenApiDocument({ version: 'x' });
    for (const item of Object.values(doc.paths)) {
      for (const op of Object.values(item)) expect(html).toContain(`id="${op.operationId}"`);
    }
    expect(html).toContain('/api/openapi.json');
  });

  test('carries parseable TechArticle JSON-LD and a canonical URL', async () => {
    const html = await (await fetch(`${baseUrl}/api/og/developers`)).text();
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const ld = JSON.parse(m[1]);
    expect(ld['@graph'][0]['@type']).toBe('TechArticle');
    expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^"]+\/developers"/);
    // The only script on the page is the JSON-LD.
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

describe('developersPageHtml', () => {
  test('points at the serving instance, not cellarion.app', () => {
    const html = developersPageHtml({ siteUrl: 'https://cellar.example.org', version: '9.9.9' });
    expect(html).toContain('<link rel="canonical" href="https://cellar.example.org/developers"');
    expect(html).toContain('curl -H &quot;Authorization: Bearer $CELLARION_TOKEN&quot; &quot;https://cellar.example.org/api/inventory&quot;');
    expect(html).toContain('Version 9.9.9');
    expect(html).not.toContain('https://cellarion.app/api');
  });
});
