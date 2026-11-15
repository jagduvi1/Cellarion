/**
 * The shop link on a wishlist entry (POST and PUT /api/wishlist).
 *
 * A member saves the page of a shop where they saw the wine. Pinned here:
 *   - the link is stored normalised (https:// added when left off)
 *   - anything that is not an http(s) address is a 400 with the code
 *     wishlist_shop_url_invalid, checked before any registry work
 *   - PUT sets, keeps (absent) or clears ('' / null) the link
 *
 * Real router; models and side-effect services are mocked (no MongoDB).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WishlistItem = require('../models/WishlistItem');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const wishlistRouter = require('./wishlist');

const USER_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000ff';
const ITEM_ID = '64b0000000000000000000ee';

function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/wishlist', wishlistRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

let stored;
beforeEach(() => {
  jest.clearAllMocks();
  require('../models/WineDefinition').findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: WINE_ID }) }),
  });
  WishlistItem.findOne.mockResolvedValue(null);
  WishlistItem.create.mockResolvedValue({ _id: ITEM_ID });
  stored = { _id: ITEM_ID, user: { toString: () => USER_ID }, status: 'wanted', shopUrl: 'https://old.example/wine', save: jest.fn(async () => {}) };
  WishlistItem.findById.mockImplementation(() => {
    const doc = Promise.resolve(stored);
    doc.populate = jest.fn().mockResolvedValue(stored);
    return doc;
  });
});

describe('POST /api/wishlist — shop link', () => {
  test('stores the link normalised, with https:// added when it was left off', async () => {
    const { status } = await call('POST', '/api/wishlist', { wineDefinitionId: WINE_ID, shopUrl: '  shop.example/wine/123 ' });

    expect(status).toBe(201);
    expect(WishlistItem.create).toHaveBeenCalledWith(expect.objectContaining({ shopUrl: 'https://shop.example/wine/123' }));
  });

  test('no link stores none', async () => {
    await call('POST', '/api/wishlist', { wineDefinitionId: WINE_ID });

    expect(WishlistItem.create).toHaveBeenCalledWith(expect.objectContaining({ shopUrl: undefined }));
  });

  test('a link that is not http(s) is a 400 with its code, before any registry work', async () => {
    const { status, body } = await call('POST', '/api/wishlist', {
      newWine: { name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France' },
      shopUrl: 'javascript:alert(1)',
    });

    expect(status).toBe(400);
    expect(body.code).toBe('wishlist_shop_url_invalid');
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(WishlistItem.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/wishlist/:id — shop link', () => {
  test('sets a new link', async () => {
    const { status } = await call('PUT', `/api/wishlist/${ITEM_ID}`, { shopUrl: 'https://shop.example/new' });

    expect(status).toBe(200);
    expect(stored.shopUrl).toBe('https://shop.example/new');
    expect(stored.save).toHaveBeenCalled();
  });

  test('an absent field keeps the link', async () => {
    await call('PUT', `/api/wishlist/${ITEM_ID}`, { notes: 'tried it at a tasting' });

    expect(stored.shopUrl).toBe('https://old.example/wine');
  });

  test("'' clears the link", async () => {
    await call('PUT', `/api/wishlist/${ITEM_ID}`, { shopUrl: '' });

    expect(stored.shopUrl).toBeUndefined();
  });

  test('a bad link is a 400 with its code and nothing is saved', async () => {
    const { status, body } = await call('PUT', `/api/wishlist/${ITEM_ID}`, { shopUrl: 'ftp://shop.example/wine' });

    expect(status).toBe(400);
    expect(body.code).toBe('wishlist_shop_url_invalid');
    expect(stored.save).not.toHaveBeenCalled();
    expect(stored.shopUrl).toBe('https://old.example/wine');
  });
});
