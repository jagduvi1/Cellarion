/**
 * POST /api/wishlist with `newWine` — mint-at-commit for the wishlist flow.
 *
 * WHY THIS TEST EXISTS:
 * A wishlist item REQUIRES a real registry row, so wishing for a
 * not-yet-registered wine is a legitimate zero-bottle registry write — but
 * AddToWishlist used to mint it in step 1 (find-or-create), and an abandoned
 * form left an orphan exactly like the AddBottle flow did. The mint now
 * happens with the SAVE, via the same shared service as POST /api/bottles
 * (services/wineCommit). Pinned here:
 *   - exactly one of wineDefinitionId | newWine (400 otherwise)
 *   - newWine resolves-or-mints, audits wine.create (via ui/ai) + IndexNow,
 *     and the item is created with the RESOLVED id in one request (201)
 *   - soft-zone candidates → 200 { candidates }, nothing created
 *   - dedup runs against the resolved id (409 can only follow a
 *     resolve-to-existing, never a fresh mint — no orphan is left behind)
 *   - demo accounts: newWine is 403 (registry write), the by-id path stays open
 *   - the by-id path never touches findOrCreateWine (regression)
 *
 * Real router + real wineCommit; findOrCreateWine, models and side-effect
 * services are mocked (no MongoDB).
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
// Demo tokens make requireAuth confirm the account still exists.
jest.mock('../models/User', () => ({ exists: jest.fn(async () => ({ _id: 'demo1' })) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WishlistItem = require('../models/WishlistItem');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { logAudit } = require('../services/audit');
const { submitUrls } = require('../services/indexNow');
const wishlistRouter = require('./wishlist');

const USER_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000ff';
const ITEM_ID = '64b0000000000000000000ee';

function post(body, { userId = USER_ID, isDemo = false } = {}) {
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
          path: '/api/wishlist',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${jwt.sign(
              { id: userId, roles: ['user'], ...(isDemo ? { isDemo: true } : {}) },
              'test-secret', { algorithm: 'HS256', expiresIn: '1h' }
            )}`,
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

const NEW_WINE = {
  name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France', type: 'white',
};
const WINE_DOC = { _id: WINE_ID, name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', slug: 'kaefferkopf' };

beforeEach(() => {
  jest.clearAllMocks();
  findOrCreateWine.mockResolvedValue({ wine: WINE_DOC, created: true });
  WishlistItem.findOne.mockResolvedValue(null);
  WishlistItem.create.mockResolvedValue({ _id: ITEM_ID });
  WishlistItem.findById.mockReturnValue({
    populate: jest.fn().mockResolvedValue({ _id: ITEM_ID, wineDefinition: WINE_DOC }),
  });
});

describe('POST /api/wishlist — wine reference contract', () => {
  test('neither wineDefinitionId nor newWine is a 400', async () => {
    const { status, body } = await post({ vintage: '2019' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/wineDefinitionId or newWine/);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(WishlistItem.create).not.toHaveBeenCalled();
  });

  test('BOTH wineDefinitionId and newWine is a 400', async () => {
    const { status } = await post({ wineDefinitionId: WINE_ID, newWine: NEW_WINE });

    expect(status).toBe(400);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(WishlistItem.create).not.toHaveBeenCalled();
  });

  test('the by-id path is untouched: never calls findOrCreateWine, item created with the given id', async () => {
    const { status } = await post({ wineDefinitionId: WINE_ID, vintage: '2019' });

    expect(status).toBe(201);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(WishlistItem.create).toHaveBeenCalledWith(expect.objectContaining({ wineDefinition: WINE_ID }));
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'wine.create', expect.anything(), expect.anything());
  });
});

describe('POST /api/wishlist — newWine mints at commit', () => {
  test('mints, audits wine.create via ui, pings IndexNow, creates the item with the resolved id → 201', async () => {
    const { status, body } = await post({ newWine: NEW_WINE, vintage: '2019', priority: 'high' });

    expect(status).toBe(201);
    expect(body.item).toBeTruthy();
    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    expect(findOrCreateWine.mock.calls[0][2]).toEqual({
      // allowPending: a wishlist add is a commit path too — an incomplete
      // identity is filed for curation instead of refusing the add.
      confirmCreate: false, skipSiblingMatch: false, createdVia: 'ui', allowPending: true,
    });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'wine.create',
      { type: 'wine', id: WINE_ID }, { via: 'ui', name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' });
    expect(submitUrls).toHaveBeenCalledWith('/wines/kaefferkopf');
    expect(WishlistItem.create).toHaveBeenCalledWith(expect.objectContaining({ wineDefinition: WINE_ID }));
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'wishlist.add',
      expect.objectContaining({ type: 'wishlistItem' }), { wineDefinitionId: WINE_ID });
  });

  test('soft-zone candidates → 200 { candidates }, nothing created', async () => {
    findOrCreateWine.mockResolvedValue({
      wine: null,
      candidates: [{ wine: { _id: WINE_ID, name: 'Kaefferkopf', producer: 'Cave Vinicole' }, score: 0.9 }],
    });

    const { status, body } = await post({ newWine: NEW_WINE });

    expect(status).toBe(200);
    expect(body.candidates).toHaveLength(1);
    expect(body.item).toBeUndefined();
    expect(WishlistItem.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('dedup runs against the RESOLVED id: resolve-to-existing + already-wanted → 409, nothing minted', async () => {
    findOrCreateWine.mockResolvedValue({ wine: WINE_DOC, created: false });
    WishlistItem.findOne.mockResolvedValue({ _id: 'existing' });

    const { status, body } = await post({ newWine: NEW_WINE });

    expect(status).toBe(409);
    expect(body.error).toMatch(/already on your wishlist/);
    expect(WishlistItem.findOne).toHaveBeenCalledWith(expect.objectContaining({ wineDefinition: WINE_ID }));
    expect(WishlistItem.create).not.toHaveBeenCalled();
    // created:false → no wine.create audit, no IndexNow: nothing was minted,
    // so the 409 leaves no orphan behind
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'wine.create', expect.anything(), expect.anything());
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('validation caps run before the service (over-long name → 400)', async () => {
    const { status } = await post({ newWine: { ...NEW_WINE, name: 'x'.repeat(201) } });

    expect(status).toBe(400);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test("source:'ai' stamps createdVia 'ai'", async () => {
    await post({ newWine: { ...NEW_WINE, source: 'ai' } });

    expect(findOrCreateWine.mock.calls[0][2].createdVia).toBe('ai');
  });
});

describe('POST /api/wishlist — demo accounts', () => {
  test('newWine is a registry write → 403, service untouched', async () => {
    const { status, body } = await post({ newWine: NEW_WINE }, { userId: 'demo1', isDemo: true });

    expect(status).toBe(403);
    expect(body.error).toMatch(/not available in the demo/);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(WishlistItem.create).not.toHaveBeenCalled();
  });

  test('the by-id path stays open to demo accounts (references an existing wine, writes nothing shared)', async () => {
    const { status } = await post({ wineDefinitionId: WINE_ID }, { userId: 'demo1', isDemo: true });

    expect(status).toBe(201);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });
});
