/**
 * GET /api/wishlist — the list joins the whole registry document, so its
 * $unset stage is what keeps the curation internals and the contributor out
 * of a member's wishlist. Real router; models and side effects mocked (no
 * MongoDB).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ aggregate: jest.fn() }));
jest.mock('../models/User', () => ({ exists: jest.fn(async () => ({ _id: 'u1' })) }));
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WishlistItem = require('../models/WishlistItem');
const wishlistRouter = require('./wishlist');

const USER_ID = '64b000000000000000000001';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/wishlist', wishlistRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => jest.clearAllMocks());

test('the joined wine carries no contributor field and no curation internal', async () => {
  // First aggregate = the count, the second = the page.
  WishlistItem.aggregate.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
  const res = await fetch(`${baseUrl}/api/wishlist`, {
    headers: { Authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret')}` },
  });
  expect(res.status).toBe(200);

  const pipeline = WishlistItem.aggregate.mock.calls[1][0];
  const unset = pipeline.find((stage) => stage.$unset).$unset;
  expect(unset).toEqual(expect.arrayContaining([
    'wineDefinition.createdBy', 'wineDefinition.contribution', 'wineDefinition.createdVia',
    'wineDefinition.canary', 'wineDefinition.identityProvenance', 'wineDefinition.verifiedChecks',
    'wineDefinition.productNumber', 'wineDefinition.previousSlugs',
    'wineDefinition.normalizedKey', 'wineDefinition.canonicalKey',
    'wineDefinition.scanImage', 'wineDefinition.scanImageBack', 'wineDefinition.scanFieldConflicts',
  ]));
});
