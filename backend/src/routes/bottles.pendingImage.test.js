/**
 * GET /api/bottles/:id — the "pending photo" lookup, pinned.
 *
 * Support ticket 2026-09-03: a user's bottle page (and cellar list) showed the
 * RAW frame they had handed to the label scanner — background, table and all —
 * served from /api/uploads/originals/. That frame is kept as a private
 * kind:'label-scan' row so a curator can read a misread label; it carries the
 * wine it minted and sits at status 'uploaded' with no processed file, so the
 * by-wine arm of this lookup matched it and `processedUrl || originalUrl`
 * resolved to the raw upload. The lookup must exclude label scans.
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
const BottleImage = require('../models/BottleImage');
// Loaded here, not inside app(): the router is the heaviest module in the
// tree, and requiring it inside the first test's 5 s budget times out under a
// parallel suite run.
const bottlesRouter = require('./bottles');

jest.setTimeout(20000);

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
    toObject: () => ({ _id: BOTTLE, status: 'active' }),
    ...over,
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bottles', bottlesRouter);
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
  Bottle.findById.mockResolvedValue(mkBottle());
  Rack.findOne.mockReturnValue(selectLean(null));
  BottleImage.findOne.mockReturnValue(sortLean(null));
  BottleImage.findById.mockReturnValue({ lean: async () => null });
});

describe('GET /api/bottles/:id pending photo', () => {
  test('the lookup excludes label scans — the scanner\'s raw frame is curation evidence, not a bottle photo', async () => {
    const { status, body } = await getJson(app(), `/api/bottles/${BOTTLE}`);

    expect(status).toBe(200);
    expect(body.pendingImageUrl).toBeNull();
    expect(BottleImage.findOne).toHaveBeenCalledTimes(1);
    expect(BottleImage.findOne).toHaveBeenCalledWith(expect.objectContaining({
      uploadedBy: USER,
      // 'approved' is deliberate — see the cellar-list twin (ticket 2026-09-05 / #1227).
      status: { $in: ['uploaded', 'processing', 'processed', 'approved'] },
      // `$ne`, not `kind: 'bottle'` — rows older than the field have no kind.
      kind: { $ne: 'label-scan' },
    }));
  });

  test('an APPROVED own photo keeps showing on the bottle page hero (ticket 2026-09-05 / #1227)', async () => {
    BottleImage.findOne.mockReturnValue(sortLean({
      _id: 'img1', kind: 'bottle', status: 'approved', visibility: 'public',
      originalUrl: null, processedUrl: '/api/uploads/processed/approved.png',
    }));
    const res = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(res.body.pendingImageUrl).toBe('/api/uploads/processed/approved.png');
  });

  test('a genuine bottle photo still shows — the processed file first, the original only while rembg is still running', async () => {
    BottleImage.findOne.mockReturnValue(sortLean({
      _id: 'img1', kind: 'bottle', status: 'processing',
      originalUrl: '/api/uploads/originals/x.jpg', processedUrl: null,
    }));
    let res = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(res.body.pendingImageUrl).toBe('/api/uploads/originals/x.jpg');

    BottleImage.findOne.mockReturnValue(sortLean({
      _id: 'img1', kind: 'bottle', status: 'processed',
      originalUrl: null, processedUrl: '/api/uploads/processed/x.png',
    }));
    res = await getJson(app(), `/api/bottles/${BOTTLE}`);
    expect(res.body.pendingImageUrl).toBe('/api/uploads/processed/x.png');
  });
});
