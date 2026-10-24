/**
 * PUT /api/bottles/:id/default-image — choosing the photo a bottle shows is
 * audited through the shared service (services/imageOps), the same row the
 * MCP set_bottle_default_image tool writes.
 *
 * Pins: a new choice writes one 'image.default' row naming the acting member,
 * the bottle and its cellar, with the new and the previous photo; a refused
 * choice writes nothing.
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
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined), reembedActiveVintages: jest.fn() }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({ checkRestockAlerts: jest.fn(), checkOnConsume: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn(), processImage: jest.fn(), hashImageBytes: jest.fn() }));
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
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), find: jest.fn() }));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const BottleImage = require('../models/BottleImage');
const { logAudit } = require('../services/audit');
// Loaded here, not inside the first test: the router is the heaviest module in
// the tree and requiring it inside a 5 s test budget can time out.
const bottlesRouter = require('./bottles');

jest.setTimeout(20000);

const USER = '64b000000000000000000001';
const CELLAR = '64b0000000000000000000cc';
const BOTTLE = '64b0000000000000000000bb';
const PREV = '64b0000000000000000000e3';
const CHOSEN = '64b0000000000000000000e4';

function mkBottle(over = {}) {
  return {
    _id: BOTTLE, user: USER, cellar: CELLAR, status: 'active',
    wineDefinition: null, defaultImage: PREV,
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function put(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  const token = jwt.sign({ id: USER, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: `/api/bottles/${BOTTLE}/default-image`, method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        res.resume();
        res.on('end', () => { server.close(); resolve({ status: res.statusCode }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR, user: USER, deletedAt: null, members: [] });
  Bottle.findById.mockResolvedValue(mkBottle());
  BottleImage.findOne.mockResolvedValue({ _id: CHOSEN });
});

test('choosing a photo writes one image.default row for the acting member', async () => {
  const { status } = await put({ imageId: CHOSEN });
  expect(status).toBe(200);
  const rows = logAudit.mock.calls.filter((c) => c[1] === 'image.default');
  expect(rows).toHaveLength(1);
  const [req, , resource, detail] = rows[0];
  expect(req.user.id).toBe(USER);
  expect(resource).toEqual({ type: 'bottle', id: BOTTLE, cellarId: CELLAR });
  expect(detail).toEqual({ imageId: CHOSEN, prev: PREV });
});

test('clearing the choice writes a row with no image', async () => {
  const { status } = await put({ imageId: null });
  expect(status).toBe(200);
  const rows = logAudit.mock.calls.filter((c) => c[1] === 'image.default');
  expect(rows).toHaveLength(1);
  expect(rows[0][3]).toEqual({ imageId: null, prev: PREV });
});

test('a photo that is not the bottle\'s is refused and writes nothing', async () => {
  BottleImage.findOne.mockResolvedValue(null);
  const { status } = await put({ imageId: CHOSEN });
  expect(status).toBe(404);
  expect(logAudit).not.toHaveBeenCalled();
});
