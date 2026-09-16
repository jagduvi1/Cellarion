/**
 * GET /api/bottles/:id/lot-history — the viewer's own story with this wine
 * (support ticket 2026-09-16: "when I drink a bottle of a wine I have several
 * of, I can't see that on the bottles still in my cellar").
 *
 * The route is a thin adapter over services/insightsService.buildCaseJourneys,
 * so what is pinned here is the ADAPTER's contract: the owned-cellar gate, the
 * vintage scope, and that a lookup failure never takes the bottle page down.
 * The lot arithmetic itself is pinned in services/insightsService.test.js.
 */
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../services/search', () => ({
  indexBottle: jest.fn(), removeBottle: jest.fn(), indexWine: jest.fn(),
  bulkIndexBottles: jest.fn(), getIsAvailable: jest.fn(() => false),
}));
jest.mock('../services/bottleLot', () => ({ findLotSiblingIds: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/insightsService', () => ({ buildCaseJourneys: jest.fn() }));
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
const { buildCaseJourneys } = require('../services/insightsService');

const USER = '64b000000000000000000001';
const OTHER_USER = '64b000000000000000000009';
const CELLAR = '64b0000000000000000000cc';
const BOTTLE = '64b0000000000000000000bb';
const WINE = '64b0000000000000000000ff';

const mkBottle = (over = {}) => ({
  _id: BOTTLE, user: USER, cellar: CELLAR, status: 'active', vintage: '2020',
  wineDefinition: WINE, priceSetAt: null, defaultImage: null,
  populate: jest.fn().mockResolvedValue(undefined),
  toObject: () => ({ _id: BOTTLE }),
  ...over,
});

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

const LOT = {
  wine: { wine_id: WINE, name: 'Ch. Test' },
  vintage: '2020',
  counts: { total: 3, remaining: 2, consumed: 1 },
  consumed_events: [{ bottle_id: 'b2', date: '2026-01-05T00:00:00.000Z', reason: 'drank', rating: 4, rating_scale: '5', note: 'Lovely' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR, user: USER, deletedAt: null, members: [], userColors: [] });
  buildCaseJourneys.mockResolvedValue({ summary: '1 lot(s)', data: [LOT] });
});

describe('GET /api/bottles/:id/lot-history', () => {
  test('defaults to this bottle\'s own vintage and returns the lot with its drunk siblings', async () => {
    Bottle.findById.mockResolvedValue(mkBottle());
    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}/lot-history`);

    expect(status).toBe(200);
    expect(body).toEqual({ scope: 'this', vintage: '2020', lots: [LOT] });
    expect(buildCaseJourneys).toHaveBeenCalledWith(USER, expect.objectContaining({
      focusWineId: WINE, focusVintage: '2020', sort: 'vintage', limit: 1, noteMaxLength: 1000,
    }));
  });

  test('vintages=all drops the vintage filter and asks for every vintage, newest first', async () => {
    Bottle.findById.mockResolvedValue(mkBottle());
    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}/lot-history?vintages=all`);

    expect(status).toBe(200);
    expect(body.scope).toBe('all');
    expect(buildCaseJourneys).toHaveBeenCalledWith(USER, expect.objectContaining({
      focusVintage: null, sort: 'vintage', limit: 20,
    }));
  });

  test('an unknown vintages value is treated as the safe default, not passed through', async () => {
    Bottle.findById.mockResolvedValue(mkBottle());
    const { body } = await getJson(app(), `/api/bottles/${BOTTLE}/lot-history?vintages=everything`);
    expect(body.scope).toBe('this');
    expect(buildCaseJourneys).toHaveBeenCalledWith(USER, expect.objectContaining({ focusVintage: '2020' }));
  });

  test('a bottle with no vintage asks for the NV lot', async () => {
    Bottle.findById.mockResolvedValue(mkBottle({ vintage: '' }));
    const { body } = await getJson(app(), `/api/bottles/${BOTTLE}/lot-history`);
    expect(body.vintage).toBe('NV');
    expect(buildCaseJourneys).toHaveBeenCalledWith(USER, expect.objectContaining({ focusVintage: 'NV' }));
  });

  // The lot is the VIEWER's bottles. From a bottle in someone else's cellar
  // that would be the wrong story to tell, so it is not told at all — the same
  // rule GET /api/bottles/:id applies to lotSiblingIds (audit 2026-09-07).
  test('a bottle in a cellar the viewer does not own returns no lots', async () => {
    Cellar.findById.mockResolvedValue({
      _id: CELLAR, user: OTHER_USER, deletedAt: null, userColors: [],
      members: [{ user: USER, role: 'viewer' }],
    });
    Bottle.findById.mockResolvedValue(mkBottle({ user: OTHER_USER }));

    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}/lot-history`);
    expect(status).toBe(200);
    expect(body.lots).toEqual([]);
    expect(buildCaseJourneys).not.toHaveBeenCalled();
  });

  test('a bottle still waiting for its registry wine returns no lots instead of grouping on nothing', async () => {
    Bottle.findById.mockResolvedValue(mkBottle({ wineDefinition: null }));
    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}/lot-history`);
    expect(status).toBe(200);
    expect(body.lots).toEqual([]);
    expect(buildCaseJourneys).not.toHaveBeenCalled();
  });

  test('a populated wineDefinition is resolved to its id, not stringified as an object', async () => {
    Bottle.findById.mockResolvedValue(mkBottle({ wineDefinition: { _id: WINE, name: 'Ch. Test' } }));
    await getJson(app(), `/api/bottles/${BOTTLE}/lot-history`);
    expect(buildCaseJourneys).toHaveBeenCalledWith(USER, expect.objectContaining({ focusWineId: WINE }));
  });

  test('a failure in the journey service is a 500 with a message, not an unhandled crash', async () => {
    Bottle.findById.mockResolvedValue(mkBottle());
    buildCaseJourneys.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}/lot-history`);
    expect(status).toBe(500);
    expect(body.error).toMatch(/history/i);
    spy.mockRestore();
  });
});
