/**
 * GET /api/og/wines/:idOrSlug — the crawler-rendered wine page.
 *
 * Search engines and AI crawlers are routed here instead of the SPA, so this
 * page must carry what a signed-out visitor sees on the wine: the prose
 * tasting profile (services/registryTiering.publicProfileSummary), marked when
 * the AI wrote it, and never the structured flavour and pairing lists that
 * stay for members. The meta description is the wine's own text when there is
 * tasting prose, and the shared line when there is none.
 */

let mockWine = null;

jest.mock('../models/WineDefinition', () => ({
  findOne: jest.fn(() => {
    const q = { populate: () => q, select: () => q, lean: () => Promise.resolve(mockWine) };
    return q;
  }),
  slugFilter: (slug) => ({ slug }),
}));
jest.mock('../models/WineVintageProfile', () => ({
  findOne: jest.fn(() => {
    const q = { sort: () => q, select: () => q, lean: () => Promise.resolve(null) };
    return q;
  }),
}));
jest.mock('../services/registryReadTracker', () => ({
  recordRead: jest.fn(),
  readerFor: jest.fn(() => 'reader'),
}));

const express = require('express');
const http = require('http');
const ogRouter = require('./og');

const SLUG = 'example-estate-reserve-red';
const DESCRIPTION = 'Ripe blackcurrant and dark plum lifted by a eucalyptus note, with cedar and tobacco on a long, firm finish that rewards a few more years in the cellar before opening.';

function wine(aiProfile) {
  return {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Reserve Red',
    producer: 'Example Estate',
    slug: SLUG,
    type: 'red',
    region: { name: 'Coonawarra' },
    country: { name: 'Australia' },
    grapes: [{ name: 'Cabernet Sauvignon' }],
    aiProfile,
  };
}

const metaDescription = (html) => html.match(/<meta name="description" content="([^"]*)"/)[1];

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

describe('GET /api/og/wines/:idOrSlug', () => {
  test('shows the AI tasting profile a visitor sees, labelled, without the structured lists', async () => {
    mockWine = wine({
      body: 'full', tannin: 'high', acidity: 'medium', sweetness: 'dry',
      flavors: ['zz-flavour-list'], foodPairings: ['zz-pairing-list'],
      description: DESCRIPTION, source: 'ai',
    });
    const res = await fetch(`${baseUrl}/api/og/wines/${SLUG}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<h2>Tasting profile (AI-generated)</h2>');
    expect(html).toContain('<strong>Structure:</strong> full-bodied, high tannin, medium acidity, dry');
    expect(html).toContain(DESCRIPTION);
    expect(html).not.toContain('zz-flavour-list');
    expect(html).not.toContain('zz-pairing-list');

    const meta = metaDescription(html);
    expect(meta.startsWith('Reserve Red — Example Estate. Ripe blackcurrant')).toBe(true);
    expect(meta.length).toBeLessThanOrEqual(160);
    expect(meta.endsWith('…')).toBe(true);
    expect(meta).not.toMatch(/\s…$/);
  });

  test('a curator profile carries no AI label', async () => {
    mockWine = wine({ description: 'Bright red cherry and violets.', source: 'curator' });
    const html = await (await fetch(`${baseUrl}/api/og/wines/${SLUG}`)).text();
    expect(html).toContain('<h2>Tasting profile</h2>');
    expect(html).not.toContain('(AI-generated)');
    expect(metaDescription(html)).toBe('Reserve Red — Example Estate. Bright red cherry and violets.');
  });

  test('without tasting prose the page has no profile section and keeps the shared line', async () => {
    mockWine = wine({ body: 'full', description: null });
    const html = await (await fetch(`${baseUrl}/api/og/wines/${SLUG}`)).text();
    expect(html).not.toContain('Tasting profile');
    expect(metaDescription(html)).toBe('Reserve Red — Example Estate. Red · Coonawarra · Australia. Discover, track, and manage your wine cellar with Cellarion.');
  });
});
