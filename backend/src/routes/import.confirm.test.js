/**
 * POST /api/bottles/import/confirm — additive grapes + drink-window fields.
 *
 * WHY THIS TEST EXISTS:
 * The bottle-import confirm pipeline accepts two optional per-item fields
 * emitted for CellarTracker imports: `grapes` (grape-name strings) and
 * `drinkFrom`/`drinkTo` (integer years, the user's own per-bottle drink
 * window). The import contract is ADDITIVE-ONLY:
 *   - items WITHOUT the fields must behave exactly as before (regression),
 *   - a matched registry wine is NEVER mutated (registry integrity — grapes
 *     only flow into NEW wines, via WineRequest.suggestedGrapes on the
 *     request-wine path),
 *   - drinkFrom/drinkTo land on the created Bottle document itself — never on
 *     the shared WineVintageProfile registry — and invalid values are
 *     silently dropped, never failing the row.
 *
 * The real import router runs with the real requireAuth (HS256 test tokens)
 * and the real parseDrinkYear validation; models are mocked so no MongoDB is
 * needed (the full round-trip is covered by the Docker smoke test).
 */

process.env.JWT_SECRET = 'test-secret';

// services/search eagerly requires the ESM-only `meilisearch` package, which
// Jest can't transform — stub it (matches the repo's unit-test style).
jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/vintageProfile', () => ({
  ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined),
}));

// ── Model mocks ──────────────────────────────────────────────────────────────

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));

jest.mock('../models/Rack', () => {
  const model = { find: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf'];
  return model;
});

// Constructor mocks capture every instance so tests can inspect what the
// route persisted without a live DB.
jest.mock('../models/Bottle', () => {
  const instances = [];
  function Bottle(data) {
    Object.assign(this, data);
    this._id = `bottle-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  Bottle.__instances = instances;
  return Bottle;
});

jest.mock('../models/WineRequest', () => {
  const instances = [];
  function WineRequest(data) {
    Object.assign(this, data);
    this._id = `winereq-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  WineRequest.__instances = instances;
  return WineRequest;
});

jest.mock('../models/WishlistItem', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const WineRequest = require('../models/WineRequest');
const WishlistItem = require('../models/WishlistItem');
const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000cc';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return app;
}

function postJson(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'POST',
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
      req.write(payload);
      req.end();
    });
  });
}

const confirm = (items) => postJson(buildApp(), '/api/bottles/import/confirm', { cellarId: CELLAR_ID, items });

let wineDoc;

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.__instances.length = 0;
  WineRequest.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  wineDoc = { _id: WINE_ID, name: 'Test Wine', producer: 'Test Prod', grapes: ['g-existing'] };
  WineDefinition.findById.mockResolvedValue(wineDoc);
  WishlistItem.findOne.mockResolvedValue(null);
  WishlistItem.create.mockImplementation(async (data) => ({ _id: 'wish-1', ...data }));
});

// ── Regression: items without the new fields ────────────────────────────────

describe('additive regression (items without grapes/drink windows)', () => {
  test('behaves as before: bottle created, pending profile seeded, no new fields set', async () => {
    const { status, body } = await confirm([{ wineDefinition: WINE_ID, vintage: '2018', notes: 'plain row' }]);

    expect(status).toBe(200);
    // Response shape unchanged (wishlistCreated is additive — 0 when no
    // items carry addToWishlist)
    expect(body).toEqual({
      created: 1,
      createdActive: 1,
      createdHistory: 0,
      wishlistCreated: 0,
      skipped: [],
      errors: [],
      total: 1,
      racksCreated: [],
      placed: 0,
      overflowed: 0,
      unplaced: [],
      // Additive — 0 when every row's wine had a complete identity.
      pendingIdentityCount: 0,
    });

    expect(Bottle.__instances).toHaveLength(1);
    const bottle = Bottle.__instances[0];
    expect(bottle.save).toHaveBeenCalled();
    expect(bottle.drinkFrom).toBeUndefined();
    expect(bottle.drinkTo).toBeUndefined();
    expect(ensurePendingVintageProfile).toHaveBeenCalledWith(WINE_ID, '2018');
    expect(WineRequest.__instances).toHaveLength(0);
  });

  test('request-wine row without grapes creates a WineRequest without suggestedGrapes', async () => {
    const { status, body } = await confirm([{ requestWine: true, wineName: 'Mystery', producer: 'Someone', vintage: '2019' }]);
    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(WineRequest.__instances).toHaveLength(1);
    expect(WineRequest.__instances[0]).not.toHaveProperty('suggestedGrapes');
  });
});

// ── Grapes ───────────────────────────────────────────────────────────────────

describe('item.grapes', () => {
  test('matched registry wine is NEVER mutated by import grapes', async () => {
    const { status, body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', grapes: ['Syrah', 'Grenache'] },
    ]);

    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.errors).toEqual([]);
    // Registry integrity: the shared wine's grapes are untouched
    expect(wineDoc.grapes).toEqual(['g-existing']);
    expect(WineRequest.__instances).toHaveLength(0);
  });

  test('request-wine path carries sanitized grapes as WineRequest.suggestedGrapes', async () => {
    const { status, body } = await confirm([
      {
        requestWine: true,
        wineName: 'Mystery Red',
        producer: 'Unknown Estate',
        vintage: '2019',
        // 7 entries incl. junk — sanitizer trims, drops empties, caps at 5
        grapes: ['  Syrah  ', '', 'Grenache', 'Mourvèdre', 'Cinsault', 'Counoise', 'Carignan'],
      },
    ]);

    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(WineRequest.__instances).toHaveLength(1);
    expect(WineRequest.__instances[0].suggestedGrapes)
      .toEqual(['Syrah', 'Grenache', 'Mourvèdre', 'Cinsault', 'Counoise']);
    expect(WineRequest.__instances[0].status).toBe('pending');
  });
});

// ── Drink windows (per-bottle personal fields) ───────────────────────────────

describe('item.drinkFrom / item.drinkTo', () => {
  test('valid window lands on the created bottle (matched-wine path)', async () => {
    const { status, body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', drinkFrom: 2018, drinkTo: 2046 },
    ]);

    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(Bottle.__instances[0].drinkFrom).toBe(2018);
    expect(Bottle.__instances[0].drinkTo).toBe(2046);
    // Somm queue seeding still runs as before — registry untouched otherwise
    expect(ensurePendingVintageProfile).toHaveBeenCalledWith(WINE_ID, '2018');
  });

  test('valid window lands on the created bottle (request-wine path)', async () => {
    const { body } = await confirm([
      { requestWine: true, wineName: 'Mystery', producer: 'Someone', vintage: '2019', drinkFrom: 2022, drinkTo: 2030 },
    ]);

    expect(body.created).toBe(1);
    expect(Bottle.__instances[0].drinkFrom).toBe(2022);
    expect(Bottle.__instances[0].drinkTo).toBe(2030);
  });

  test('numeric strings are accepted (CSV-sourced values)', async () => {
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', drinkFrom: '2020', drinkTo: '2035' },
    ]);
    expect(body.created).toBe(1);
    expect(Bottle.__instances[0].drinkFrom).toBe(2020);
    expect(Bottle.__instances[0].drinkTo).toBe(2035);
  });

  test('single-sided window keeps the provided side', async () => {
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', drinkFrom: 2025 },
    ]);
    expect(body.created).toBe(1);
    expect(Bottle.__instances[0].drinkFrom).toBe(2025);
    expect(Bottle.__instances[0].drinkTo).toBeUndefined();
  });

  test('from > to is silently dropped whole — the row still imports', async () => {
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', drinkFrom: 2046, drinkTo: 2018 },
    ]);

    expect(body.created).toBe(1);
    expect(body.errors).toEqual([]);
    expect(Bottle.__instances[0].drinkFrom).toBeUndefined();
    expect(Bottle.__instances[0].drinkTo).toBeUndefined();
  });

  test('sentinel years 1001/9999 are re-guarded server-side and dropped', async () => {
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', drinkFrom: 1001, drinkTo: 2030 },
      { wineDefinition: WINE_ID, vintage: '2018', drinkFrom: 2018, drinkTo: 9999 },
    ]);

    expect(body.created).toBe(2);
    expect(body.errors).toEqual([]);
    // Invalid side dropped, valid side kept
    expect(Bottle.__instances[0].drinkFrom).toBeUndefined();
    expect(Bottle.__instances[0].drinkTo).toBe(2030);
    expect(Bottle.__instances[1].drinkFrom).toBe(2018);
    expect(Bottle.__instances[1].drinkTo).toBeUndefined();
  });

  test('non-integer junk is dropped without failing the row', async () => {
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', drinkFrom: 'soonish', drinkTo: 2030.5 },
    ]);

    expect(body.created).toBe(1);
    expect(Bottle.__instances[0].drinkFrom).toBeUndefined();
    expect(Bottle.__instances[0].drinkTo).toBeUndefined();
  });
});

// ── Wishlist destination (item.addToWishlist) ────────────────────────────────

describe('item.addToWishlist', () => {
  test('creates a WishlistItem for the importing user instead of a Bottle', async () => {
    const { status, body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', notes: 'sounded great', addToWishlist: true },
    ]);

    expect(status).toBe(200);
    expect(body.wishlistCreated).toBe(1);
    expect(body.created).toBe(0);
    expect(body.errors).toEqual([]);
    expect(Bottle.__instances).toHaveLength(0);
    expect(WishlistItem.create).toHaveBeenCalledWith({
      user: USER_ID,
      wineDefinition: WINE_ID,
      vintage: '2018',
      notes: 'sounded great',
      priority: 'medium',
    });
  });

  test('skips rows already on the wishlist (same wine + vintage, wanted)', async () => {
    WishlistItem.findOne.mockResolvedValue({ _id: 'existing-wish' });
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', addToWishlist: true },
    ]);

    expect(body.wishlistCreated).toBe(0);
    expect(body.skipped).toEqual([{ index: 0, reason: 'Already on your wishlist' }]);
    expect(WishlistItem.create).not.toHaveBeenCalled();
    expect(WishlistItem.findOne).toHaveBeenCalledWith({
      user: USER_ID,
      wineDefinition: WINE_ID,
      status: 'wanted',
      vintage: '2018',
    });
  });

  test('dedups repeated wine+vintage rows within one batch (scan histories repeat wines)', async () => {
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', addToWishlist: true },
      { wineDefinition: WINE_ID, vintage: '2018', addToWishlist: true },
      { wineDefinition: WINE_ID, vintage: '2019', addToWishlist: true },
    ]);

    expect(body.wishlistCreated).toBe(2);
    expect(body.skipped).toEqual([{ index: 1, reason: 'Duplicate wishlist row in this import' }]);
    expect(WishlistItem.create).toHaveBeenCalledTimes(2);
  });

  test('request-wine rows cannot be wishlisted — per-row error, no WineRequest created', async () => {
    const { body } = await confirm([
      { requestWine: true, wineName: 'Mystery', producer: 'Someone', vintage: '2019', addToWishlist: true },
      { wineDefinition: WINE_ID, vintage: '2018', addToWishlist: true },
    ]);

    expect(body.wishlistCreated).toBe(1);
    expect(body.errors).toEqual([
      { index: 0, reason: 'Only wines matched to the registry can be added to the wishlist' },
    ]);
    expect(WineRequest.__instances).toHaveLength(0);
  });

  test('mixed batch: wishlist rows and bottle rows are both honoured', async () => {
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '2018', addToWishlist: true },
      { wineDefinition: WINE_ID, vintage: '2018' },
    ]);

    expect(body.wishlistCreated).toBe(1);
    expect(body.created).toBe(1);
    expect(body.createdActive).toBe(1);
    expect(Bottle.__instances).toHaveLength(1);
  });

  test('NV vintage rows use the canonical NV identity for dedup', async () => {
    const { body } = await confirm([
      { wineDefinition: WINE_ID, vintage: '', addToWishlist: true },
      { wineDefinition: WINE_ID, vintage: 'NV', addToWishlist: true },
    ]);

    // '' and 'NV' both canonicalise to 'NV' → second row is an in-batch dupe
    expect(body.wishlistCreated).toBe(1);
    expect(body.skipped).toEqual([{ index: 1, reason: 'Duplicate wishlist row in this import' }]);
  });
});

// ── Whole-import comment/occasion (support ticket 2026-07-30) ───────────────

describe('importNotes / importOccasion', () => {
  const confirmWith = (items, extra) =>
    postJson(buildApp(), '/api/bottles/import/confirm', { cellarId: CELLAR_ID, items, ...extra });

  test('land on every created bottle when rows carry neither (matched + request-wine paths)', async () => {
    const { status, body } = await confirmWith(
      [
        { wineDefinition: WINE_ID, vintage: '2018' },
        { requestWine: true, wineName: 'Mystery', producer: 'Someone', vintage: '2019' },
      ],
      { importNotes: 'Moved from CellarTracker', importOccasion: 'Estate auction' }
    );

    expect(status).toBe(200);
    expect(body.created).toBe(2);
    expect(Bottle.__instances).toHaveLength(2);
    for (const b of Bottle.__instances) {
      expect(b.notes).toBe('Moved from CellarTracker');
      expect(b.occasion).toBe('Estate auction');
    }
  });

  test('fill-blank only: a row with its own note keeps it', async () => {
    const { body } = await confirmWith(
      [
        { wineDefinition: WINE_ID, vintage: '2018', notes: 'from the file' },
        { wineDefinition: WINE_ID, vintage: '2019' },
      ],
      { importNotes: 'batch comment' }
    );

    expect(body.created).toBe(2);
    expect(Bottle.__instances[0].notes).toBe('from the file');
    expect(Bottle.__instances[1].notes).toBe('batch comment');
  });

  test('sanitised and capped: HTML stripped, occasion clamped to the schema max (500)', async () => {
    const { body } = await confirmWith(
      [{ wineDefinition: WINE_ID, vintage: '2018' }],
      { importNotes: '<b>bold</b> move', importOccasion: 'x'.repeat(600) }
    );

    expect(body.created).toBe(1);
    expect(Bottle.__instances[0].notes).toBe('bold move');
    expect(Bottle.__instances[0].occasion).toHaveLength(500);
  });

  test('wishlist rows are NOT stamped — the comment describes bottles owned, not wines wanted', async () => {
    const { body } = await confirmWith(
      [{ wineDefinition: WINE_ID, vintage: '2018', addToWishlist: true }],
      { importNotes: 'batch comment', importOccasion: 'gala' }
    );

    expect(body.wishlistCreated).toBe(1);
    expect(WishlistItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ notes: undefined })
    );
    expect(WishlistItem.create.mock.calls[0][0].occasion).toBeUndefined();
  });

  test('non-string values are ignored, absent fields leave bottles untouched (regression)', async () => {
    const { body } = await confirmWith(
      [{ wineDefinition: WINE_ID, vintage: '2018' }],
      { importNotes: { length: 1e12 }, importOccasion: 42 }
    );

    expect(body.created).toBe(1);
    expect(Bottle.__instances[0].notes).toBeUndefined();
    expect(Bottle.__instances[0].occasion).toBeUndefined();
  });
});
