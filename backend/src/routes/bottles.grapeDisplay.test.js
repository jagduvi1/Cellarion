/**
 * GET /api/bottles/:id — regional grape display decoration on the bottle page
 * (somm ticket: "Tinta Roriz stored as Tempranillo on a Douro Port").
 *
 * WHY THIS TEST EXISTS:
 * The bottle detail response serializes the populated wineDefinition; each
 * grape must gain `displayName` resolved against the WINE's own
 * country/region while `name` stays the canonical variety — the contract the
 * bottle page's grape pills (`g.displayName || g.name`) rest on. Storage is
 * untouched: the bottle still references the canonical Grape doc.
 *
 * The list route's in-memory search haystack is covered here too (audit
 * 2026-08-11): what the card DISPLAYS must be what search matches, so
 * `?search=` must hit the regional display name resolved for each wine's own
 * place — and only that one, not every mapping the grape carries.
 *
 * Real router + real requireAuth/requireBottleAccess (HS256 test tokens);
 * models and side-effect services are mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexBottle: jest.fn(),
  removeBottle: jest.fn(),
}));
jest.mock('../services/bottleLot', () => ({ findLotSiblingIds: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({
  checkRestockGap: jest.fn().mockResolvedValue(null),
  resolveRestockAlerts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  getSnapshotForDate: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/vintageProfile', () => ({
  ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../models/Cellar', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => ({ updateMany: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
// find(): the sibling-bottle photo lookup (support ticket 2026-09-07) — empty here.
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000cc';
const BOTTLE_ID = '64b0000000000000000000dd';
const PORTUGAL = 'a'.repeat(24);
const DOURO = 'b'.repeat(24);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return app;
}

function get(url) {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'GET',
          headers: {
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
      req.end();
    });
  });
}

let storedBottle;

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  // No pending/default images in this suite.
  // Own photos: find().sort().limit().lean(); the vintage official: find().select().lean() (2026-10-09).
  BottleImage.find.mockImplementation(() => { const q = { sort: () => q, limit: () => q, select: () => q, lean: async () => [] }; return q; });
  BottleImage.findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
  BottleImage.findById.mockReturnValue({ lean: async () => null });

  const wineDefinition = {
    _id: WINE_ID,
    name: 'Vintage Port',
    producer: 'Quinta do Exemplo',
    type: 'fortified',
    country: { _id: PORTUGAL, name: 'Portugal' },
    region: { _id: DOURO, name: 'Douro' },
    grapes: [
      { _id: 'c'.repeat(24), name: 'Tempranillo', regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }] },
      { _id: 'd'.repeat(24), name: 'Touriga Nacional' },
    ],
  };
  storedBottle = {
    _id: BOTTLE_ID,
    cellar: CELLAR_ID,
    vintage: '2017',
    wineDefinition,
    populate: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    toObject() {
      return { _id: this._id, cellar: this.cellar, vintage: this.vintage, wineDefinition: this.wineDefinition };
    },
  };
  Bottle.findById.mockResolvedValue(storedBottle);
});

describe('GET /api/bottles/:id', () => {
  test('wineDefinition grapes carry displayName for the wine\'s place; name stays canonical', async () => {
    const { status, body } = await get(`/api/bottles/${BOTTLE_ID}`);
    expect(status).toBe(200);
    const grapes = body.bottle.wineDefinition.grapes;
    expect(grapes[0].displayName).toBe('Tinta Roriz');
    expect(grapes[0].name).toBe('Tempranillo');
    expect(grapes[1].displayName).toBe('Touriga Nacional');
  });

  test('the stored bottle object is not mutated by decoration (canonical stays canonical in memory)', async () => {
    await get(`/api/bottles/${BOTTLE_ID}`);
    // The doc the rest of the app sees (indexing, audit) keeps canonical-only
    // grapes — decoration happens on the serialized copy.
    expect(storedBottle.wineDefinition.grapes[0].displayName).toBeUndefined();
  });
});

// ── GET /api/bottles?search= — regional names in the in-memory haystack ──────

describe('GET /api/bottles list search', () => {
  const ALENTEJO = 'e'.repeat(24);

  // Lean list bottle: a Douro wine whose Tempranillo carries BOTH a Douro
  // mapping (applies → searchable) and an Alentejo mapping (does not apply).
  const leanBottle = () => ({
    _id: BOTTLE_ID,
    cellar: CELLAR_ID,
    status: 'active',
    vintage: '2017',
    createdAt: new Date('2026-01-01'),
    wineDefinition: {
      _id: WINE_ID,
      name: 'Vintage Port',
      producer: 'Quinta do Exemplo',
      type: 'fortified',
      country: { _id: PORTUGAL, name: 'Portugal' },
      region: { _id: DOURO, name: 'Douro' },
      grapes: [
        {
          _id: 'c'.repeat(24),
          name: 'Tempranillo',
          regionalNames: [
            { country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' },
            { country: PORTUGAL, region: ALENTEJO, name: 'Aragonez' },
          ],
        },
      ],
    },
  });

  const primeList = (bottles) => {
    Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue([CELLAR_ID]) });
    const chain = {
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(bottles),
    };
    Bottle.find.mockReturnValue(chain);
  };

  test('?search= matches the regional display name shown on the card', async () => {
    primeList([leanBottle()]);
    const { status, body } = await get('/api/bottles?search=roriz');
    expect(status).toBe(200);
    expect(body.bottles.items).toHaveLength(1);
    // …and the surviving item is decorated for rendering, same label.
    expect(body.bottles.items[0].wineDefinition.grapes[0].displayName).toBe('Tinta Roriz');
  });

  test('the canonical name still matches (regional recall is additive)', async () => {
    primeList([leanBottle()]);
    const { body } = await get('/api/bottles?search=tempranillo');
    expect(body.bottles.items).toHaveLength(1);
  });

  test('a mapping for a DIFFERENT place does not match — only the label the card shows', async () => {
    primeList([leanBottle()]);
    // "Aragonez" is this grape's ALENTEJO name; the wine is a Douro wine, so
    // its card never shows it and search must not pretend otherwise.
    const { body } = await get('/api/bottles?search=aragonez');
    expect(body.bottles.items).toHaveLength(0);
  });
});

// ── GET /api/bottles — history lists by the rating each bottle counts with ──
// (support ticket 2026-10-11: a drunk bottle counts with the rating given when
// drinking; a statistics band link selects exactly the band's bottles).
describe('GET /api/bottles rating band and rating sort on history', () => {
  const wine = { _id: WINE_ID, name: 'Barolo', producer: 'X', type: 'red', grapes: [] };
  const drunk = (n, consumedRating, consumedRatingScale, over = {}) => ({
    _id: String(n).padStart(24, '0'), cellar: CELLAR_ID, status: 'drank', createdAt: new Date(2026, 0, n),
    consumedRating, consumedRatingScale, wineDefinition: wine, ...over,
  });
  const prime = (bottles) => {
    Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue([CELLAR_ID]) });
    const chain = {
      populate: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(bottles),
    };
    Bottle.find.mockReturnValue(chain);
    return chain;
  };

  test('?ratingBand picks the band\'s bottles by the drink-time rating, an edge value included', async () => {
    // Davis 18.2 → ~80.8: the statistics count it in 81-100.
    prime([drunk(1, 18.2, '20'), drunk(2, 3, '5'), drunk(3, null, null, { rating: 5, ratingScale: '5' })]);
    const { body } = await get('/api/bottles?status=consumed&ratingBand=81-100');
    // 1: Davis 18.2 given when drinking; 3: no drink-time rating, 5★ on the bottle.
    expect(body.bottles.items.map((b) => Number(b._id))).toEqual([1, 3]);
  });

  test('sort=rating on a history list orders by the drink-time rating, in memory, unrated last', async () => {
    const chain = prime([drunk(1, 2, '5'), drunk(2, 5, '5'), drunk(3, null, null), drunk(4, 4, '5')]);
    const { body } = await get('/api/bottles?status=consumed&sort=-rating');
    expect(body.bottles.items.map((b) => Number(b._id))).toEqual([2, 4, 1, 3]);
    // Not handed to the database: its sort only knows the stored rating.
    expect(chain.sort).not.toHaveBeenCalledWith({ rating: -1 });
  });
});
