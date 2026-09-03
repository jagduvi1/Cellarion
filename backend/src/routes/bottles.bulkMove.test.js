/**
 * POST /api/bottles/bulk-move — many bottles to another owned cellar in ONE
 * request (support ticket 6a9949e3, 2026-09-03: a delivery logged in a
 * storage cellar had to be moved home one bottle at a time).
 *
 * Pinned: the request is validated as a whole (ids, cap, a destination you
 * own), then applied PER BOTTLE through the shared rackOps.moveBottleToCellar.
 * A bottle in a cellar you don't own, an unknown id, a consumed bottle or one
 * already in the destination is skipped WITH a reason while the rest still
 * move. Same disclosure rule as the single route: a bottle you may not move
 * reads as not_found.
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
jest.mock('../services/rackOps', () => ({ moveBottleToCellar: jest.fn() }));
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
const { moveBottleToCellar } = require('../services/rackOps');
const { logAudit } = require('../services/audit');
// Loaded here, not inside app(): the router is the heaviest module in the
// tree, and requiring it inside the first test's 5 s budget times out under a
// parallel suite run.
const bottlesRouter = require('./bottles');

jest.setTimeout(20000);

const USER = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const SRC = '64b0000000000000000000c1';
const FOREIGN = '64b0000000000000000000c2';
const DEST = '64b0000000000000000000d1';
const B = (n) => `64b0000000000000000000b${n}`;

const CELLARS = {
  [SRC]:     { _id: SRC, user: USER, name: 'Storage', deletedAt: null, members: [] },
  [FOREIGN]: { _id: FOREIGN, user: OTHER, name: 'Not mine', deletedAt: null, members: [] },
  [DEST]:    { _id: DEST, user: USER, name: 'Home', deletedAt: null, members: [] },
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
  Cellar.findOne.mockResolvedValue(CELLARS[DEST]);
  Cellar.findById.mockImplementation(async (id) => CELLARS[String(id)] || null);
  moveBottleToCellar.mockResolvedValue({ bottle: {} });
  Bottle.find.mockResolvedValue([]);
});

describe('POST /api/bottles/bulk-move', () => {
  test('moves the owned active bottles, skips the rest with a reason, and reports both', async () => {
    Bottle.find.mockResolvedValue([
      { _id: B(1), cellar: SRC, status: 'active' },
      { _id: B(2), cellar: SRC, status: 'active' },
      { _id: B(3), cellar: FOREIGN, status: 'active' }, // a cellar the caller does not own
      { _id: B(4), cellar: SRC, status: 'drank' },      // consumed
      { _id: B(5), cellar: DEST, status: 'active' },    // already in the destination
      // B(6) does not exist
    ]);

    const { status, body } = await postJson(app(), '/api/bottles/bulk-move', {
      bottleIds: [B(1), B(2), B(3), B(4), B(5), B(6), B(1)], // duplicate B(1) collapses
      toCellarId: DEST,
    });

    expect(status).toBe(200);
    expect(body.moved).toBe(2);
    expect(body.movedIds).toEqual([B(1), B(2)]);
    expect(body.skipped).toEqual([
      { id: B(3), reason: 'not_found' },
      { id: B(4), reason: 'not_active' },
      { id: B(5), reason: 'same_cellar' },
      { id: B(6), reason: 'not_found' },
    ]);
    expect(body.toCellar).toEqual({ _id: DEST, name: 'Home' });
    expect(moveBottleToCellar).toHaveBeenCalledTimes(2);
    expect(moveBottleToCellar).toHaveBeenCalledWith(
      expect.objectContaining({ _id: B(1) }), CELLARS[SRC], CELLARS[DEST], expect.anything(),
    );
    // Destination must be an active cellar the caller OWNS.
    expect(Cellar.findOne).toHaveBeenCalledWith(expect.objectContaining({ user: USER, deletedAt: null }));
    // One summary audit row on top of the per-bottle rows the helper writes.
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'bottle.bulk_move', expect.objectContaining({ type: 'cellar' }),
      { requested: 6, moved: 2, skipped: 4 },
    );
  });

  test('a per-bottle conflict from the shared helper is reported, not fatal', async () => {
    Bottle.find.mockResolvedValue([
      { _id: B(1), cellar: SRC, status: 'active' },
      { _id: B(2), cellar: SRC, status: 'active' },
    ]);
    moveBottleToCellar
      .mockResolvedValueOnce({ error: { status: 409, message: 'modified', code: 'conflict' } })
      .mockResolvedValueOnce({ bottle: {} });

    const { status, body } = await postJson(app(), '/api/bottles/bulk-move', { bottleIds: [B(1), B(2)], toCellarId: DEST });

    expect(status).toBe(200);
    expect(body.moved).toBe(1);
    expect(body.skipped).toEqual([{ id: B(1), reason: 'conflict' }]);
  });

  test('rejects an empty list, a bad id, a list over the cap, and an unknown destination', async () => {
    let res = await postJson(app(), '/api/bottles/bulk-move', { bottleIds: [], toCellarId: DEST });
    expect(res.status).toBe(400);

    res = await postJson(app(), '/api/bottles/bulk-move', { bottleIds: ['nope'], toCellarId: DEST });
    expect(res.status).toBe(400);

    res = await postJson(app(), '/api/bottles/bulk-move', { bottleIds: Array.from({ length: 501 }, () => B(1)), toCellarId: DEST });
    expect(res.status).toBe(400);

    res = await postJson(app(), '/api/bottles/bulk-move', { bottleIds: [B(1)], toCellarId: 'nope' });
    expect(res.status).toBe(400);

    Cellar.findOne.mockResolvedValue(null);
    res = await postJson(app(), '/api/bottles/bulk-move', { bottleIds: [B(1)], toCellarId: DEST });
    expect(res.status).toBe(404);

    expect(moveBottleToCellar).not.toHaveBeenCalled();
  });
});
