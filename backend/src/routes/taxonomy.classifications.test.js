/**
 * GET /api/taxonomy/classifications — the classification taxonomy for the
 * pickers. Pins: signed-in only with a private cache header, rows come from
 * the write rule's in-memory taxonomy (a row an admin just added is offered
 * at once), an unreviewed user-minted row nobody uses is left out, each row
 * carries its kind, country name, spellings and wine count.
 */

jest.mock('../models/WineDefinition', () => ({ aggregate: jest.fn(), countDocuments: jest.fn(), find: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Classification', () => ({ find: jest.fn(), findOne: jest.fn(), KINDS: ['vineyard_rank', 'ripeness', 'ageing', 'other'] }));

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
const Country = require('../models/Country');
const ops = require('../services/classificationOps');
const router = require('./taxonomy');

const chain = (rows) => ({ select: () => chain(rows), sort: () => chain(rows), lean: async () => rows });
const DE = 'd'.repeat(24);

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
afterEach(() => ops.primeClassificationCache(null));

const get = () => fetch(`${baseUrl}/api/taxonomy/classifications`)
  .then(async (r) => ({ status: r.status, cacheControl: r.headers.get('cache-control'), body: await r.json() }));

test('signed-in only', async () => {
  mockSignedIn = false;
  expect((await get()).status).toBe(401);
  mockSignedIn = true;
});

test('rows with kind, country, spellings and wine count; an unreviewed unused member row is left out', async () => {
  ops.primeClassificationCache([
    { _id: '1', name: 'Spätlese', kind: 'ripeness', system: 'Prädikatswein', country: null, synonyms: ['Spatlese'] },
    { _id: '2', name: 'VDP Grosse Lage', kind: 'vineyard_rank', system: 'VDP', country: DE, synonyms: [] },
    { _id: '3', name: 'Honey Tier', kind: 'other', country: null, synonyms: [], createdByUser: true, reviewedAt: null },
    { _id: '4', name: 'Used Tier', kind: 'other', country: null, synonyms: [], createdByUser: true, reviewedAt: null },
  ]);
  WineDefinition.aggregate.mockResolvedValue([{ _id: '1', count: 56 }, { _id: '4', count: 1 }]);
  Country.find.mockReturnValue(chain([{ _id: DE, name: 'Germany' }]));
  const r = await get();
  expect(r.status).toBe(200);
  expect(r.cacheControl).toBe('private, max-age=30');
  expect(r.body.kinds).toEqual(['vineyard_rank', 'ripeness', 'ageing', 'other']);
  expect(r.body.classifications.map((c) => c.name)).toEqual(['Spätlese', 'Used Tier', 'VDP Grosse Lage']);
  expect(r.body.classifications[0]).toMatchObject({ name: 'Spätlese', kind: 'ripeness', system: 'Prädikatswein', country: null, synonyms: ['Spatlese'], wineCount: 56 });
  expect(r.body.classifications[2]).toMatchObject({ name: 'VDP Grosse Lage', country: { _id: DE, name: 'Germany' }, wineCount: 0 });
});
