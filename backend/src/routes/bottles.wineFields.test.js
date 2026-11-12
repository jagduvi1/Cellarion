/**
 * The wine inside a bottle answer.
 *
 * Anyone with access to a cellar reads GET /api/bottles/:id and the answers of
 * the bottle writes, a viewer included. The bottle lists leave the
 * member-hidden wine fields out (config/constants MEMBER_WINE_HIDDEN_FIELDS);
 * these answers must too. The one field the single-bottle read needs for
 * itself is createdBy, to say whether a private draft is the reader's own; it
 * is loaded for that and removed before the answer goes out.
 *
 * Harness from bottles.rackInfo.test.js: the real router and access
 * middleware, models mocked.
 */

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../services/search', () => ({
  indexWine: jest.fn(),
  getIsAvailable: jest.fn(() => false),
}));
jest.mock('../services/bottleLot', () => ({ findLotSiblingIds: jest.fn().mockResolvedValue([]) }));
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
jest.mock('../models/Rack', () => ({ findOne: jest.fn(), exists: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/PriceTrackingSkip', () => ({}));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn() }));
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
  // Own photos: find().sort().limit().lean(); the vintage official: find().select().lean() (2026-10-09).
  BottleImage.find.mockImplementation(() => { const q = { sort: () => q, limit: () => q, select: () => q, lean: async () => [] }; return q; });
  BottleImage.findOne.mockReturnValue(sortLean(null));
  BottleImage.findById.mockReturnValue({ lean: async () => null });
});

const { MEMBER_WINE_HIDDEN_FIELDS, WINE_POPULATE, WINE_POPULATE_KEEP_CREATOR } = require('../config/constants');

const OTHER = '64b000000000000000000002';
const WINE = '64b0000000000000000000ee';
const wineSelect = (populate) => populate.find((p) => p.path === 'wineDefinition').select.split(/\s+/);

// What the populate hands the route for a private draft: the creator is there
// because the select kept it, and nothing else of the hidden list is.
const draftBottle = (createdBy) => mkBottle({
  wineDefinition: WINE,
  toObject: () => ({
    _id: BOTTLE, status: 'active',
    wineDefinition: { _id: WINE, name: 'Example Cuvee', producer: 'Example Estate', draft: true, draftExpiresAt: '2026-12-01T00:00:00.000Z', createdBy, grapes: [] },
  }),
});

beforeEach(() => {
  Rack.findOne.mockReturnValue(selectLean(null));
  Rack.exists.mockResolvedValue(null);
  CellarLayout.findOne.mockReturnValue(selectLean(null));
});

describe('the selects', () => {
  test('the wine of a bottle answer leaves every member-hidden field out', () => {
    const fields = wineSelect(WINE_POPULATE);
    for (const f of MEMBER_WINE_HIDDEN_FIELDS) expect(fields).toContain(`-${f}`);
  });

  test('the single-bottle read keeps createdBy, and only that, of the hidden fields', () => {
    const fields = wineSelect(WINE_POPULATE_KEEP_CREATOR);
    expect(fields).not.toContain('-createdBy');
    for (const f of MEMBER_WINE_HIDDEN_FIELDS.filter((x) => x !== 'createdBy')) expect(fields).toContain(`-${f}`);
  });

  test('both load the same paths around the wine', () => {
    const paths = (populate) => populate.map((p) => p.path);
    expect(paths(WINE_POPULATE_KEEP_CREATOR)).toEqual(paths(WINE_POPULATE));
    const inner = (populate) => JSON.stringify(populate.find((p) => p.path === 'wineDefinition').populate);
    expect(inner(WINE_POPULATE_KEEP_CREATOR)).toBe(inner(WINE_POPULATE));
  });
});

describe('GET /api/bottles/:id', () => {
  test('loads the wine with the creator kept, and sends the answer without it', async () => {
    const bottle = draftBottle(USER);
    Bottle.findById.mockResolvedValue(bottle);

    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}`);

    expect(status).toBe(200);
    expect(bottle.populate).toHaveBeenCalledWith(WINE_POPULATE_KEEP_CREATOR);
    expect(body.bottle.wineDefinition.name).toBe('Example Cuvee');
    expect(body.bottle.wineDefinition).not.toHaveProperty('createdBy');
  });

  test('a private draft is still "mine" for the member who made it', async () => {
    Bottle.findById.mockResolvedValue(draftBottle(USER));
    const { body } = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(body.bottle.wineDraft).toEqual({ mine: true, expiresAt: '2026-12-01T00:00:00.000Z' });
  });

  test('and not "mine" for another member of the cellar, who does not learn whose it is', async () => {
    Bottle.findById.mockResolvedValue(draftBottle(OTHER));
    const { body } = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(body.bottle.wineDraft.mine).toBe(false);
    expect(JSON.stringify(body)).not.toContain(OTHER);
  });

  test('a published wine: no creator in the answer either', async () => {
    Bottle.findById.mockResolvedValue(mkBottle({
      wineDefinition: WINE,
      toObject: () => ({ _id: BOTTLE, status: 'active', wineDefinition: { _id: WINE, name: 'Example Cuvee', producer: 'Example Estate', createdBy: OTHER, grapes: [] } }),
    }));
    const { body } = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(body.bottle.wineDefinition).not.toHaveProperty('createdBy');
    expect(body.bottle).not.toHaveProperty('wineDraft');
  });
});
