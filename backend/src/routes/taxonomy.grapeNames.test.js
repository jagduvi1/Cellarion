/**
 * GET /api/taxonomy/grape-names — the whole grape vocabulary, for the grape
 * picker on the bottle page's "suggest a fix" form (support ticket 2026-09-17).
 *
 * Pins what makes it different from the public /grapes list next to it: rare
 * varieties are IN (a correction has to be able to name them), unreviewed
 * user-minted varieties nobody uses are OUT (that is where the typos sit),
 * synonyms ride along, no ids leave, and it is signed-in only with a private
 * cache header.
 */

jest.mock('../models/WineDefinition', () => ({ aggregate: jest.fn(), countDocuments: jest.fn(), find: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn(), findOne: jest.fn() }));

let mockSignedIn = true;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!mockSignedIn) return res.status(401).json({ error: 'No token provided' });
    req.user = { id: 'a'.repeat(24), roles: ['user'] };
    return next();
  },
}));

const express = require('express');
const http = require('http');
const WineDefinition = require('../models/WineDefinition');
const Grape = require('../models/Grape');
const router = require('./taxonomy');

const chain = (rows) => ({ select: () => chain(rows), sort: () => chain(rows), lean: async () => rows });

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const get = () => fetch(`${baseUrl}/api/taxonomy/grape-names`)
  .then(async (r) => ({ status: r.status, cacheControl: r.headers.get('cache-control'), body: await r.json() }));

const SYRAH = '64b000000000000000000001';
const RARE = '64b000000000000000000002';
const TYPO = '64b000000000000000000003';
const USED_MINT = '64b000000000000000000004';
const APPROVED_MINT = '64b000000000000000000005';

beforeEach(() => {
  jest.clearAllMocks();
  mockSignedIn = true;
  router.clearTaxonomyListCache();
  Grape.find.mockReturnValue(chain([
    { _id: SYRAH, name: 'Syrah', color: 'Red', synonyms: ['Shiraz'], createdByUser: false, reviewedAt: null },
    { _id: RARE, name: 'Souvignier Gris', color: 'White', synonyms: [], createdByUser: false, reviewedAt: null },
    { _id: TYPO, name: 'Alvarão', color: null, createdByUser: true, reviewedAt: null },
    { _id: USED_MINT, name: 'Solaris', color: 'White', synonyms: [], createdByUser: true, reviewedAt: null },
    { _id: APPROVED_MINT, name: 'Cabernet Cortis', color: 'Red', synonyms: [], createdByUser: true, reviewedAt: new Date() },
  ]));
  WineDefinition.aggregate.mockResolvedValue([
    { _id: SYRAH, count: 700 },
    { _id: USED_MINT, count: 2 },
  ]);
});

test('signed-in only, and never cacheable by a shared cache', async () => {
  mockSignedIn = false;
  expect((await get()).status).toBe(401);
  expect(Grape.find).not.toHaveBeenCalled();

  mockSignedIn = true;
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.cacheControl).toBe('private, max-age=3600');
});

test('rare varieties are in — the public list\'s 3-wine gate does not apply to a picker', async () => {
  const names = (await get()).body.grapes.map((g) => g.name);
  expect(names).toContain('Souvignier Gris'); // 0 wines, curator-made
});

test('a user-minted variety is offered once a wine uses it or a curator approved it — never the unused, unreviewed one', async () => {
  const names = (await get()).body.grapes.map((g) => g.name);
  expect(names).toContain('Solaris');          // user-minted, in use
  expect(names).toContain('Cabernet Cortis');  // user-minted, approved
  expect(names).not.toContain('Alvarão');      // user-minted, unused, unreviewed
});

test('each entry is name, colour, synonyms and wine count — no ids, no provenance', async () => {
  const { grapes } = (await get()).body;
  expect(grapes.find((g) => g.name === 'Syrah')).toEqual({ name: 'Syrah', color: 'Red', synonyms: ['Shiraz'], wineCount: 700 });
  expect(grapes.find((g) => g.name === 'Souvignier Gris')).toEqual({ name: 'Souvignier Gris', color: 'White', synonyms: [], wineCount: 0 });
});

// Stamped before the queries ran, a 500 went out cacheable for an hour too —
// and the picker's "Try again" would have been answered by the browser's cache
// (pre-deploy audit 2026-09-18).
test('a failure carries no cache header, and is not kept in the list cache either', async () => {
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  WineDefinition.aggregate.mockRejectedValueOnce(new Error('primary stepped down'));
  const failed = await get();
  err.mockRestore();
  expect(failed.status).toBe(500);
  expect(failed.cacheControl || '').not.toMatch(/max-age/);

  const ok = await get();
  expect(ok.status).toBe(200);
  expect(ok.cacheControl).toBe('private, max-age=3600');
});

test('the aggregation runs once and the answer is served from the list cache until taxonomy changes', async () => {
  await get();
  await get();
  expect(Grape.find).toHaveBeenCalledTimes(1);
  expect(WineDefinition.aggregate).toHaveBeenCalledTimes(1);
  router.clearTaxonomyListCache();
  await get();
  expect(Grape.find).toHaveBeenCalledTimes(2);
});
