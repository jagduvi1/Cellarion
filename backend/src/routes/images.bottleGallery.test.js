/**
 * GET /api/images/bottle/:bottleId — what the uploader gets back.
 *
 * Support ticket 2026-09-03 ("one of my wines cannot load"): an admin had
 * rejected the only photo on a bottle. Rejecting deletes the files and nulls
 * both URLs, leaving a tombstone row. This route handed that tombstone back to
 * the uploader under the "your own photos, any state" branch, the carousel
 * called .startsWith on the null URL, and the ErrorBoundary took the whole
 * bottle page down — 138 bottles / 47 owners on prod at the time. The
 * uploader branch must exclude rejected rows; the wine-level branch stays
 * approved + public only.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ processImage: jest.fn() }));
jest.mock('../services/imageSanitizer', () => ({ sanitizeImageBuffer: jest.fn() }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/upload', () => ({ upload: { single: () => (req, res, next) => next() }, ORIGINALS_DIR: '/app/uploads/originals' }));
jest.mock('../utils/cellarAccess', () => ({ getCellarRole: jest.fn(() => 'owner') }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const imagesRouter = require('./images');

const oid = (c) => c.repeat(24);
const BOTTLE = oid('b');
const CELLAR = oid('c');
const WINE = oid('a');
const USER = oid('1');

const tokenFor = (id, roles) => jwt.sign({ id, roles }, 'test-secret');

/** Chainable thenable standing in for a Mongoose Query. */
const makeQuery = (rows = []) => {
  const q = {
    sort: jest.fn(() => q),
    select: jest.fn(() => q),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return q;
};

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/images', imagesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.findById.mockResolvedValue({ _id: BOTTLE, cellar: CELLAR, wineDefinition: WINE, defaultImage: null });
  Cellar.findById.mockResolvedValue({ _id: CELLAR });
});

const get = (path, token) =>
  fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe('the uploader branch', () => {
  test('never returns a rejected tombstone, even to the uploader', async () => {
    BottleImage.find.mockReturnValue(makeQuery([]));

    const res = await get(`/api/images/bottle/${BOTTLE}`, tokenFor(USER, ['user']));
    expect(res.status).toBe(200);

    const bottleFilter = BottleImage.find.mock.calls[0][0];
    expect(bottleFilter.bottle).toBe(BOTTLE);
    expect(bottleFilter.$or).toEqual([
      { status: 'approved', visibility: 'public' },
      { uploadedBy: USER, status: { $ne: 'rejected' } },
    ]);
  });

  test('the wine-level branch stays approved + public only', async () => {
    BottleImage.find.mockReturnValue(makeQuery([]));

    await get(`/api/images/bottle/${BOTTLE}`, tokenFor(USER, ['user']));

    const wineFilter = BottleImage.find.mock.calls[1][0];
    expect(wineFilter).toEqual({ wineDefinition: WINE, status: 'approved', visibility: 'public' });
  });

  test('a row the server returns comes through untouched (regression guard for the shape)', async () => {
    const live = { _id: oid('d'), processedUrl: '/api/uploads/processed/live.png', originalUrl: null, status: 'approved' };
    BottleImage.find
      .mockReturnValueOnce(makeQuery([live]))
      .mockReturnValueOnce(makeQuery([]));

    const res = await get(`/api/images/bottle/${BOTTLE}`, tokenFor(USER, ['user']));
    const body = await res.json();
    expect(body.images).toEqual([live]);
    expect(body.defaultImageId).toBeNull();
  });
});
