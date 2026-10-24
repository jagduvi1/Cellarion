/**
 * POST /confirm quarantines a wine it mints from a row the file marked as a
 * spirit.
 *
 * The import mappers set `nonWineHint: true` on a row whose Type/Category
 * column names a spirit, whisky, gin, … (frontend utils/importMappers
 * looksNonWine), and the confirm payload carries it. When such a row makes
 * /confirm MINT a registry wine, the new row gets the same non-wine flag
 * POST /api/admin/wines/:id/non-wine sets: the bottle lands and its owner
 * keeps the wine, but it stays out of public search. A hinted row that
 * matched an existing wine is left to a curator — the file's category can be
 * wrong.
 *
 * The row is BORN flagged: /confirm passes findOrCreateWine's opt-in
 * `nonWine` option, so the one fire-and-forget index call the mint makes
 * already sees a flagged row. The mock below does what the real service does
 * (services/findOrCreateWine.nonWine.test.js pins that), and every index call
 * records the row's state at that moment: none may see a visible row.
 *
 * Real router + real requireAuth (HS256 test tokens); models, search and the
 * AI layer are mocked (the harness of import.validateReadonly.test.js).
 */

process.env.JWT_SECRET = 'test-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: jest.fn(),
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
jest.mock('../services/priceWarnings', () => ({
  computeUserMediansByCurrency: jest.fn().mockResolvedValue({}),
}));

// ── Model mocks ──────────────────────────────────────────────────────────────

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/ImportArchive', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/WishlistItem', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) };
  model.RACK_TYPES = ['grid'];
  return model;
});

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

jest.mock('../models/WineDefinition', () => {
  const chain = (docs) => {
    const c = { populate: () => c, sort: () => c, limit: () => c, lean: async () => docs };
    return c;
  };
  return {
    findOne: jest.fn(() => ({ populate: async () => null })),
    find: jest.fn(() => chain([])),
    findById: jest.fn(),
  };
});

jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
  exists: jest.fn(async () => true),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const searchService = require('../services/search');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { logAudit } = require('../services/audit');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000c9';

function confirm(items) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify({ cellarId: CELLAR_ID, items });
      const token = jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
      const req = http.request(
        {
          port: server.address().port,
          path: '/api/bottles/import/confirm',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${token}`,
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

const AI_SPIRIT = {
  name: 'Highland Single Malt 12', producer: 'Glen Fictif', country: 'United Kingdom',
  region: 'Scotland', confidence: 0.9,
};

const aiItem = (extra = {}) => ({
  aiWine: { ...AI_SPIRIT }, wineName: 'Highland Single Malt 12', producer: 'Glen Fictif',
  vintage: 'NV', ...extra,
});

// The wine findOrCreateWine hands back, so a test can inspect what the route
// did to it.
let wine;
const mintedWine = () => ({
  _id: WINE_ID, name: AI_SPIRIT.name, producer: AI_SPIRIT.producer, type: 'red', nonWine: false,
  save: jest.fn().mockResolvedValue(undefined),
});
// The row's state at every index call, in order.
let indexed;

const nonWineAudits = () => logAudit.mock.calls.filter((c) => c[1] === 'wine.nonWine');
const optionsOfMint = () => findOrCreateWine.mock.calls[0][2];

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  wine = mintedWine();
  indexed = [];
  searchService.indexWine.mockImplementation((id) => { indexed.push({ id, nonWine: wine.nonWine }); });
  // As the real service does on a mint: the row is created with the caller's
  // nonWine option and indexed once, fire-and-forget.
  findOrCreateWine.mockImplementation(async (_data, _userId, opts = {}) => {
    if (opts.nonWine === true) wine.nonWine = true;
    searchService.indexWine(wine._id);
    return { wine, created: true };
  });
});

describe('POST /confirm — a minted wine from a row the file marked as a spirit', () => {
  test('is born flagged non-wine and audited, never indexed as a visible row; the bottle still lands', async () => {
    const res = await confirm([aiItem({ nonWineHint: true })]);

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toEqual([]);

    expect(optionsOfMint()).toEqual(expect.objectContaining({ createdVia: 'import', allowPending: true, nonWine: true }));
    expect(wine.nonWine).toBe(true);
    // Flagged at birth: no second save, and the mint's own index call is the
    // only one. It saw a flagged row, so it removed rather than added.
    expect(wine.save).not.toHaveBeenCalled();
    expect(indexed).toEqual([{ id: WINE_ID, nonWine: true }]);
    expect(nonWineAudits()).toHaveLength(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'wine.nonWine',
      expect.objectContaining({ type: 'wine', id: WINE_ID }),
      expect.objectContaining({ via: 'import', value: true, name: AI_SPIRIT.name, producer: AI_SPIRIT.producer })
    );
    // The mint itself is still recorded as a create.
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'wine.create',
      expect.objectContaining({ type: 'wine', id: WINE_ID }),
      expect.objectContaining({ via: 'import' })
    );

    expect(Bottle.__instances).toHaveLength(1);
    expect(Bottle.__instances[0].wineDefinition).toBe(WINE_ID);
  });

  test('two rows of the same spirit flag the one minted wine once', async () => {
    const res = await confirm([aiItem({ nonWineHint: true }), aiItem({ nonWineHint: true, vintage: '2015' })]);

    expect(res.body.created).toBe(2);
    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    expect(indexed).toEqual([{ id: WINE_ID, nonWine: true }]);
    expect(nonWineAudits()).toHaveLength(1);
  });

  test('a hinted row that matched an existing wine leaves that wine alone', async () => {
    // The service applies the option only to a row it mints.
    findOrCreateWine.mockImplementation(async () => ({ wine, created: false }));

    const res = await confirm([aiItem({ nonWineHint: true })]);

    expect(res.body.created).toBe(1);
    expect(wine.nonWine).toBe(false);
    expect(wine.save).not.toHaveBeenCalled();
    expect(searchService.indexWine).not.toHaveBeenCalled();
    expect(nonWineAudits()).toHaveLength(0);
    expect(Bottle.__instances[0].wineDefinition).toBe(WINE_ID);
  });

  test.each([
    ['absent', {}],
    ['the string "true"', { nonWineHint: 'true' }],
    ['false', { nonWineHint: false }],
  ])('a row whose hint is %s mints an ordinary wine', async (_label, extra) => {
    const res = await confirm([aiItem(extra)]);

    expect(res.body.created).toBe(1);
    // The service is called exactly as for any other import row.
    expect(Object.prototype.hasOwnProperty.call(optionsOfMint(), 'nonWine')).toBe(false);
    expect(optionsOfMint()).toEqual(expect.objectContaining({ createdVia: 'import', allowPending: true }));
    expect(wine.nonWine).toBe(false);
    expect(wine.save).not.toHaveBeenCalled();
    expect(indexed).toEqual([{ id: WINE_ID, nonWine: false }]);
    expect(nonWineAudits()).toHaveLength(0);
  });
});
