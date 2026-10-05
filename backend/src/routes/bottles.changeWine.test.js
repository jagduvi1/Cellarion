/**
 * POST /api/bottles/:id/change-wine — a bottle saved under the wrong registry
 * wine moves to another one (services/bottleOps.changeBottleWine).
 *
 * Pinned: editor+ on the bottle's cellar, a valid and VISIBLE target wine
 * (findVisibleWine — someone else's pending/draft wine reads as not found),
 * and applyToLot moving the lot found BEFORE the move.
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
jest.mock('../services/restockChecker', () => ({ checkRestockAlerts: jest.fn(), checkOnConsume: jest.fn(), checkRestockGap: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/rackOps', () => ({ moveBottleToCellar: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  addBottle: jest.fn(), validateBottleCommitFields: jest.fn(), updateBottleFields: jest.fn(), consumeBottle: jest.fn(),
  restoreBottle: jest.fn(), removeFromRacks: jest.fn(), removeBottleCascade: jest.fn(),
  openBottle: jest.fn(), pourFromBottle: jest.fn(), closeBottle: jest.fn(), markArrived: jest.fn(), changeBottleWine: jest.fn(),
}));
jest.mock('../utils/exchangeRates', () => ({ getSnapshotForDate: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), findOne: jest.fn() }));
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
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../services/bottleLot', () => ({ findLotSiblingIds: jest.fn().mockResolvedValue([]), findLotSiblings: jest.fn().mockResolvedValue([]) }));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { changeBottleWine } = require('../services/bottleOps');
const { findVisibleWine } = require('../services/wineVisibility');
const { findLotSiblings } = require('../services/bottleLot');
const { logAudit } = require('../services/audit');
const { checkRestockGap } = require('../services/restockChecker');
const bottlesRouter = require('./bottles');

jest.setTimeout(20000);

const USER = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const OWNED = '64b0000000000000000000c1';
const EDITABLE = '64b0000000000000000000c2'; // someone else's cellar, shared with USER as editor
const VIEWONLY = '64b0000000000000000000c3'; // shared with USER as viewer
const DELETED = '64b0000000000000000000c4';  // USER's own, but in its deletion cooling-off
const B = (n) => `64b0000000000000000000b${n}`;

const CELLARS = {
  [OWNED]:    { _id: OWNED, user: USER, name: 'Mine', deletedAt: null, members: [] },
  [EDITABLE]: { _id: EDITABLE, user: OTHER, name: 'Theirs (editor)', deletedAt: null, members: [{ user: USER, role: 'editor' }] },
  [VIEWONLY]: { _id: VIEWONLY, user: OTHER, name: 'Theirs (viewer)', deletedAt: null, members: [{ user: USER, role: 'viewer' }] },
  [DELETED]:  { _id: DELETED, user: USER, name: 'Gone', deletedAt: new Date(), members: [] },
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bottles', bottlesRouter);
  return a;
}

function postJson(a, path, body) {
  const token = jwt.sign({ id: USER, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = http.createServer(a);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path, method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

const W_RED = '64b0000000000000000000d1';
const bottleDoc = (cellar, over = {}) => ({
  _id: B(1), cellar, user: USER, status: 'active', vintage: '2021', wineDefinition: '64b0000000000000000000d0',
  populate: jest.fn().mockResolvedValue(undefined), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockImplementation(async (id) => CELLARS[String(id)] || null);
  findVisibleWine.mockResolvedValue({ _id: W_RED, producer: 'Domaine du Vieux Lazaret', name: 'Châteauneuf-du-Pape' });
  changeBottleWine.mockImplementation(async (b) => ({ bottle: b, from: 'x' }));
  findLotSiblings.mockResolvedValue([]);
});

describe('POST /api/bottles/:id/change-wine', () => {
  test('an editor moves the bottle to a visible wine; the response carries the bottle', async () => {
    Bottle.findById.mockResolvedValue(bottleDoc(EDITABLE));
    const { status, body } = await postJson(app(), `/api/bottles/${B(1)}/change-wine`, { wineDefinitionId: W_RED });
    expect(status).toBe(200);
    expect(body.alsoMoved).toBe(0);
    expect(findVisibleWine).toHaveBeenCalledWith(W_RED, { userId: USER, roles: ['user'] });
    expect(changeBottleWine).toHaveBeenCalledTimes(1);
    expect(findLotSiblings).not.toHaveBeenCalled();
  });

  test('applyToLot moves the lot found before the move, and counts it', async () => {
    Bottle.findById.mockResolvedValue(bottleDoc(OWNED));
    findLotSiblings.mockResolvedValue([{ _id: B(2) }, { _id: B(3) }]);
    const { status, body } = await postJson(app(), `/api/bottles/${B(1)}/change-wine`, { wineDefinitionId: W_RED, applyToLot: true });
    expect(status).toBe(200);
    expect(body.alsoMoved).toBe(2);
    expect(changeBottleWine).toHaveBeenCalledTimes(3);
    // The lot is read BEFORE the first change, so it is the old wine's lot.
    expect(findLotSiblings.mock.invocationCallOrder[0]).toBeLessThan(changeBottleWine.mock.invocationCallOrder[0]);
  });

  test('a viewer cannot; a bad or invisible wine id is refused; the same wine is a 400 with its code', async () => {
    Bottle.findById.mockResolvedValue(bottleDoc(VIEWONLY));
    expect((await postJson(app(), `/api/bottles/${B(1)}/change-wine`, { wineDefinitionId: W_RED })).status).toBe(403);

    Bottle.findById.mockResolvedValue(bottleDoc(OWNED));
    expect((await postJson(app(), `/api/bottles/${B(1)}/change-wine`, { wineDefinitionId: { $ne: null } })).status).toBe(400);

    findVisibleWine.mockResolvedValueOnce(null);
    expect((await postJson(app(), `/api/bottles/${B(1)}/change-wine`, { wineDefinitionId: W_RED })).status).toBe(404);

    changeBottleWine.mockResolvedValueOnce({ error: { status: 400, code: 'same_wine', message: 'The bottle is already this wine' } });
    const same = await postJson(app(), `/api/bottles/${B(1)}/change-wine`, { wineDefinitionId: W_RED });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe('same_wine');
    expect(changeBottleWine).toHaveBeenCalledTimes(1);
  });
});
