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
let mockCount = 5;
let mockProfiles = [];
let mockRelated = { sameProducer: [], similar: [] };

jest.mock('../models/WineDefinition', () => ({
  findOne: jest.fn(() => {
    const q = { populate: () => q, select: () => q, lean: () => Promise.resolve(mockWine) };
    return q;
  }),
  slugFilter: (slug) => ({ slug }),
  countDocuments: jest.fn(() => Promise.resolve(mockCount)),
  find: jest.fn((filter) => {
    const rows = filter.region ? mockRelated.similar : mockRelated.sameProducer;
    const q = { select: () => q, populate: () => q, sort: () => q, limit: () => q, lean: () => Promise.resolve(rows) };
    return q;
  }),
}));
jest.mock('../models/WineVintageProfile', () => ({
  find: jest.fn(() => {
    const q = { select: () => q, sort: () => q, limit: () => q, lean: () => Promise.resolve(mockProfiles) };
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
const SITE = process.env.FRONTEND_URL || 'https://cellarion.app';
const DESCRIPTION = 'Ripe blackcurrant and dark plum lifted by a eucalyptus note, with cedar and tobacco on a long, firm finish that rewards a few more years in the cellar before opening.';

function wine(aiProfile) {
  return {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Reserve Red',
    producer: 'Example Estate',
    slug: SLUG,
    type: 'red',
    region: { _id: 'r1', name: 'Coonawarra', slug: 'coonawarra', description: '**Coonawarra** is a strip of red soil in South Australia, known for Cabernet. It is flat.' },
    country: { _id: 'c1', name: 'Australia', slug: 'australia' },
    grapes: [{ _id: 'g1', name: 'Cabernet Sauvignon', slug: 'cabernet-sauvignon', description: 'Cabernet Sauvignon is a red grape born in Bordeaux. More.' }],
    aiProfile,
  };
}

beforeEach(() => {
  mockCount = 5;
  mockProfiles = [];
  mockRelated = { sameProducer: [], similar: [] };
});

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

  test('says how many vintages have a reviewed drink window, never the years', async () => {
    mockWine = wine({ description: 'Bright red cherry.', source: 'ai' });
    mockProfiles = [{ _id: 'p1' }, { _id: 'p2' }];
    const html = await (await fetch(`${baseUrl}/api/og/wines/${SLUG}`)).text();
    expect(html).toContain('<h2>When to drink</h2>');
    expect(html).toContain('reviewed the drink window of 2 vintages');
    expect(html).not.toMatch(/peak maturity|Drink window:/);
    const WineVintageProfile = require('../models/WineVintageProfile');
    expect(WineVintageProfile.find).toHaveBeenCalledWith({ wineDefinition: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'reviewed' });
  });

  test('links the region, country and grape pages that exist, with a sentence about each', async () => {
    mockWine = wine(null);
    const html = await (await fetch(`${baseUrl}/api/og/wines/${SLUG}`)).text();
    expect(html).toContain(`<p><strong>Region:</strong> <a href="${SITE}/regions/coonawarra">Coonawarra</a></p>`);
    expect(html).toContain(`<a href="${SITE}/countries/australia">Australia</a>`);
    expect(html).toContain(`<a href="${SITE}/grapes/cabernet-sauvignon">Cabernet Sauvignon</a>`);
    expect(html).toContain('<h2>Where it comes from</h2>');
    expect(html).toContain('Coonawarra is a strip of red soil in South Australia, known for Cabernet.');
    expect(html).not.toContain('It is flat.');
    expect(html).toContain('Cabernet Sauvignon is a red grape born in Bordeaux.');
  });

  test('a place whose page does not exist stays plain text', async () => {
    mockWine = wine(null);
    mockCount = 2;
    const html = await (await fetch(`${baseUrl}/api/og/wines/${SLUG}`)).text();
    expect(html).toContain('<p><strong>Region:</strong> Coonawarra</p>');
    expect(html).not.toContain('/regions/coonawarra');
  });

  test('lists more wines from the producer and similar wines, never a canary', async () => {
    mockWine = wine(null);
    mockRelated = {
      sameProducer: [{ _id: 'w2', name: 'Estate Shiraz', producer: 'Example Estate', slug: 'example-estate-estate-shiraz', type: 'red', region: { name: 'Clare Valley' } }],
      similar: [{ _id: 'w3', name: 'Block Cabernet', producer: 'Other House', slug: 'other-house-block-cabernet', type: 'red', appellation: 'Coonawarra', grapes: ['g1'] }],
    };
    const html = await (await fetch(`${baseUrl}/api/og/wines/${SLUG}`)).text();
    expect(html).toContain('<h3>From Example Estate</h3>');
    expect(html).toContain(`<a href="${SITE}/wines/example-estate-estate-shiraz">Estate Shiraz</a> — Example Estate, Clare Valley`);
    expect(html).toContain('<h3>More red wines from Coonawarra</h3>');
    expect(html).toContain(`<a href="${SITE}/wines/other-house-block-cabernet">Block Cabernet</a> — Other House, Coonawarra`);
    const WineDefinition = require('../models/WineDefinition');
    for (const [filter] of WineDefinition.find.mock.calls) expect(filter.canary).toEqual({ $ne: true });
  });
});
