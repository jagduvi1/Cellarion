/**
 * GET /api/bottles/:id answers "which rack is this bottle in" itself
 * (2026-08-22, from the rate-limit analysis).
 *
 * The client used to download EVERY rack with all slots plus the full 3D
 * layout — the two heaviest requests on the bottle page — and scan them in the
 * browser for one bottle id. `slots.bottle` carries a unique multikey index,
 * so the server answers with one indexed findOne. That per-open cost is what
 * let an ordinary editing session (35 edits in 8 minutes) hit the API rate
 * limit and abandon a 55-minute hole in their evening.
 */
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../services/search', () => ({
  indexBottle: jest.fn(), removeBottle: jest.fn(), indexWine: jest.fn(),
  bulkIndexBottles: jest.fn(), getIsAvailable: jest.fn(() => false),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined), reembedActiveVintages: jest.fn() }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({ checkRestockAlerts: jest.fn(), checkOnConsume: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getSnapshotForDate: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => ({ findOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/PriceTrackingSkip', () => ({}));
jest.mock('../models/BottleImage', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const CellarLayout = require('../models/CellarLayout');
const BottleImage = require('../models/BottleImage');

const USER = '64b000000000000000000001';
const CELLAR = '64b0000000000000000000cc';
const BOTTLE = '64b0000000000000000000bb';
const RACK = '64b0000000000000000000dd';

const selectLean = (doc) => ({ select: () => ({ lean: async () => doc }) });
const sortLean = (doc) => ({ sort: () => ({ lean: async () => doc }) });

function mkBottle(over = {}) {
  return {
    _id: BOTTLE, user: USER, cellar: CELLAR, status: 'active',
    wineDefinition: null, priceSetAt: null, defaultImage: null,
    populate: jest.fn().mockResolvedValue(undefined),
    toObject: () => ({ _id: BOTTLE, status: over.status || 'active' }),
    ...over,
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bottles', require('./bottles'));
  return a;
}

function getJson(a, path) {
  const token = jwt.sign({ id: USER, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return new Promise((resolve, reject) => {
    const server = http.createServer(a);
    server.listen(0, () => {
      http.get({ port: server.address().port, path, headers: { authorization: `Bearer ${token}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({
    _id: CELLAR, user: USER, deletedAt: null, members: [], userColors: [],
  });
  BottleImage.findOne.mockReturnValue(sortLean(null));
  BottleImage.findById.mockReturnValue({ lean: async () => null });
});

describe('GET /api/bottles/:id rackInfo', () => {
  test('a racked bottle answers with its rack, slot and inRoom — one indexed query, not a client scan', async () => {
    Bottle.findById.mockResolvedValue(mkBottle());
    Rack.findOne.mockReturnValue(selectLean({
      _id: RACK, name: 'Wine Fridge',
      slots: [{ bottle: 'other', position: 1 }, { bottle: BOTTLE, position: 7 }],
    }));
    CellarLayout.findOne.mockReturnValue(selectLean({ rackPlacements: [{ rack: RACK }] }));

    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(status).toBe(200);
    expect(body.rackInfo).toEqual({ rackId: RACK, rackName: 'Wine Fridge', position: 7, inRoom: true });
    // The query the index serves — and soft-deleted racks excluded.
    expect(Rack.findOne).toHaveBeenCalledWith({ cellar: CELLAR, 'slots.bottle': BOTTLE, deletedAt: null });
  });

  test('an unracked bottle answers rackInfo null', async () => {
    Bottle.findById.mockResolvedValue(mkBottle());
    Rack.findOne.mockReturnValue(selectLean(null));
    const { body } = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(body.rackInfo).toBeNull();
    expect(CellarLayout.findOne).not.toHaveBeenCalled(); // no layout query when unracked
  });

  test('a rack outside the 3D room answers inRoom false', async () => {
    Bottle.findById.mockResolvedValue(mkBottle());
    Rack.findOne.mockReturnValue(selectLean({ _id: RACK, name: 'Cellar Wall', slots: [{ bottle: BOTTLE, position: 2 }] }));
    CellarLayout.findOne.mockReturnValue(selectLean(null));
    const { body } = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(body.rackInfo).toMatchObject({ inRoom: false });
  });

  test('a CONSUMED bottle skips the lookup entirely', async () => {
    Bottle.findById.mockResolvedValue(mkBottle({ status: 'drank', toObject: () => ({ _id: BOTTLE, status: 'drank' }) }));
    const { body } = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(body.rackInfo).toBeNull();
    expect(Rack.findOne).not.toHaveBeenCalled();
  });

  test('a failing rack lookup degrades to null — placement is auxiliary and must never 500 the page', async () => {
    Bottle.findById.mockResolvedValue(mkBottle());
    Rack.findOne.mockImplementation(() => { throw new Error('index rebuild in progress'); });
    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(status).toBe(200);
    expect(body.rackInfo).toBeNull();
  });
});
