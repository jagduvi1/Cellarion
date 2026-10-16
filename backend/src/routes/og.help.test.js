/**
 * GET /api/og/help — the crawler-rendered Help page, built from
 * data/helpContent.js. Pins that every section reaches the page (title and
 * every detail line) and that the FAQ JSON-LD parses with one question per
 * section.
 */

const express = require('express');
const http = require('http');
const ogRouter = require('./og');
const { sections } = require('../data/helpContent');

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

// The page escapes text for HTML (esc in og.js); compare the same way.
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('GET /api/og/help', () => {
  let html;
  beforeAll(async () => {
    const res = await fetch(`${baseUrl}/api/og/help`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    html = await res.text();
  });

  test('prints every section with all its detail lines', () => {
    for (const s of sections) {
      expect(html).toContain(`<h2>${esc(s.title)}</h2>`);
      for (const d of s.details) expect(html).toContain(`<li>${esc(d)}</li>`);
    }
  });

  test('emits FAQ JSON-LD with one question per section', () => {
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(match[1]).not.toMatch(/[<>]/);
    const parsed = JSON.parse(match[1]);
    const faq = parsed['@graph'].find((n) => n['@type'] === 'FAQPage');
    expect(faq.mainEntity.map((q) => q.name)).toEqual(sections.map((s) => s.title));
  });
});
