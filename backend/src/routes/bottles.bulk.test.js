/**
 * POST /api/bottles/bulk — one edit or consume applied to many bottles
 * (support ticket 6a9949e3 follow-up: purchase details for a delivery, one
 * date for a dinner's bottles, a reservation across a case).
 *
 * Pinned: access is editor+ per bottle's cellar (a viewer's bottle reads as
 * not_found), `fields` is cut down to the bulk whitelist before the shared
 * updateBottleFields sees it, consume skips already-consumed bottles, a
 * payload the shared validation rejects fails the whole request up front,
 * and one summary audit row is written on top of the per-bottle rows.
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
  openBottle: jest.fn(), pourFromBottle: jest.fn(), closeBottle: jest.fn(),
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

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { updateBottleFields, consumeBottle } = require('../services/bottleOps');
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

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockImplementation(async (id) => CELLARS[String(id)] || null);
  Bottle.find.mockResolvedValue([]);
  updateBottleFields.mockResolvedValue({ bottle: {}, changes: {}, prev: {} });
  consumeBottle.mockResolvedValue({ bottle: {} });
});

describe('POST /api/bottles/bulk', () => {
  test('update: applies the whitelisted fields per bottle for owner + editor cellars, skips a viewer cellar', async () => {
    Bottle.find.mockResolvedValue([
      { _id: B(1), cellar: OWNED, status: 'active' },
      { _id: B(2), cellar: EDITABLE, status: 'active' },
      { _id: B(3), cellar: VIEWONLY, status: 'active' },
    ]);

    const { status, body } = await postJson(app(), '/api/bottles/bulk', {
      action: 'update',
      bottleIds: [B(1), B(2), B(3), B(4)],
      fields: { purchaseDate: '2026-09-01', price: 120, currency: 'SEK', notes: 'must not pass', vintage: '1999' },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ done: 2, doneIds: [B(1), B(2)], skipped: [{ id: B(3), reason: 'not_found' }, { id: B(4), reason: 'not_found' }] });
    expect(updateBottleFields).toHaveBeenCalledTimes(2);
    // Only the bulk whitelist reaches the shared update — notes/vintage are per bottle.
    expect(updateBottleFields).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ _id: B(1) }), { purchaseDate: '2026-09-01', price: 120, currency: 'SEK' }, expect.anything());
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'bottle.bulk_update', expect.objectContaining({ type: 'cellar', id: OWNED }),
      { requested: 4, done: 2, skipped: 2, fields: ['price', 'currency', 'purchaseDate'] },
    );
  });

  test('consume: one reason and date for every active bottle; already-consumed bottles are skipped', async () => {
    Bottle.find.mockResolvedValue([
      { _id: B(1), cellar: OWNED, status: 'active' },
      { _id: B(2), cellar: OWNED, status: 'drank' },
    ]);

    const { status, body } = await postJson(app(), '/api/bottles/bulk', {
      action: 'consume', bottleIds: [B(1), B(2)], reason: 'gifted', note: 'to Anna', consumedAt: '2026-08-30',
    });

    expect(status).toBe(200);
    expect(body).toEqual({ done: 1, doneIds: [B(1)], skipped: [{ id: B(2), reason: 'not_active' }] });
    expect(consumeBottle).toHaveBeenCalledTimes(1);
    expect(consumeBottle).toHaveBeenCalledWith(
      expect.objectContaining({ _id: B(1) }), { reason: 'gifted', note: 'to Anna', consumedAt: '2026-08-30', skipRestockCheck: true }, expect.anything());
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'bottle.bulk_consume', expect.objectContaining({ type: 'cellar' }),
      { requested: 2, done: 1, skipped: 1, reason: 'gifted' },
    );
  });

  test('a payload the shared validation rejects fails the whole request before anything is touched', async () => {
    Bottle.find.mockResolvedValue([
      { _id: B(1), cellar: OWNED, status: 'active' },
      { _id: B(2), cellar: OWNED, status: 'active' },
    ]);
    consumeBottle.mockResolvedValue({ error: { status: 400, message: 'consumedAt must be a valid date and not in the future' } });

    const { status, body } = await postJson(app(), '/api/bottles/bulk', {
      action: 'consume', bottleIds: [B(1), B(2)], consumedAt: '2099-01-01',
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/consumedAt/);
    expect(consumeBottle).toHaveBeenCalledTimes(1); // stopped at the first bottle
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('rejects an unknown action, an update without usable fields, and a bad id list', async () => {
    let res = await postJson(app(), '/api/bottles/bulk', { action: 'delete', bottleIds: [B(1)] });
    expect(res.status).toBe(400);

    res = await postJson(app(), '/api/bottles/bulk', { action: 'update', bottleIds: [B(1)], fields: { notes: 'x' } });
    expect(res.status).toBe(400);

    res = await postJson(app(), '/api/bottles/bulk', { action: 'update', bottleIds: [], fields: { price: 1 } });
    expect(res.status).toBe(400);

    res = await postJson(app(), '/api/bottles/bulk', { action: 'consume', bottleIds: ['nope'] });
    expect(res.status).toBe(400);

    expect(updateBottleFields).not.toHaveBeenCalled();
    expect(consumeBottle).not.toHaveBeenCalled();
  });
});

describe('POST /api/bottles/bulk — post-ship audit fixes (2026-09-03)', () => {
  test('a bottle in a soft-deleted cellar reads as not_found, as on the single routes', async () => {
    Bottle.find.mockResolvedValue([{ _id: B(1), cellar: DELETED, status: 'active' }]);
    const { status, body } = await postJson(app(), '/api/bottles/bulk', { action: 'update', bottleIds: [B(1)], fields: { price: 10 } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ done: 0, skipped: [{ id: B(1), reason: 'not_found' }] });
    expect(updateBottleFields).not.toHaveBeenCalled();
  });

  test('a reserved bottle is skipped as reserved unless includeReserved is set', async () => {
    Bottle.find.mockResolvedValue([{ _id: B(1), cellar: OWNED, status: 'active', reservedFor: "Anna's wedding" }]);
    let res = await postJson(app(), '/api/bottles/bulk', { action: 'consume', bottleIds: [B(1)] });
    expect(res.body).toMatchObject({ done: 0, skipped: [{ id: B(1), reason: 'reserved' }] });
    expect(consumeBottle).not.toHaveBeenCalled();

    Bottle.find.mockResolvedValue([{ _id: B(1), cellar: OWNED, status: 'active', reservedFor: "Anna's wedding" }]);
    res = await postJson(app(), '/api/bottles/bulk', { action: 'consume', bottleIds: [B(1)], includeReserved: true });
    expect(res.body).toMatchObject({ done: 1, skipped: [] });
    expect(consumeBottle).toHaveBeenCalledTimes(1);
  });

  test('the restock-gap check runs once per wine+vintage, not once per bottle, and only for "drank"', async () => {
    const W1 = '64b0000000000000000000e1';
    const W2 = '64b0000000000000000000e2';
    const bottles = () => [
      { _id: B(1), cellar: OWNED, status: 'active', wineDefinition: W1, vintage: '2019' },
      { _id: B(2), cellar: OWNED, status: 'active', wineDefinition: W1, vintage: '2019' },
      { _id: B(3), cellar: OWNED, status: 'active', wineDefinition: W2, vintage: '2019' },
    ];
    Bottle.find.mockResolvedValue(bottles());
    await postJson(app(), '/api/bottles/bulk', { action: 'consume', bottleIds: [B(1), B(2), B(3)], reason: 'drank' });
    expect(consumeBottle).toHaveBeenCalledTimes(3);
    expect(consumeBottle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ skipRestockCheck: true }), expect.anything());
    expect(checkRestockGap).toHaveBeenCalledTimes(2);

    jest.clearAllMocks();
    consumeBottle.mockResolvedValue({ bottle: {} });
    Cellar.findById.mockImplementation(async (id) => CELLARS[String(id)] || null);
    Bottle.find.mockResolvedValue(bottles());
    await postJson(app(), '/api/bottles/bulk', { action: 'consume', bottleIds: [B(1), B(2), B(3)], reason: 'gifted' });
    expect(checkRestockGap).not.toHaveBeenCalled();
  });
});
