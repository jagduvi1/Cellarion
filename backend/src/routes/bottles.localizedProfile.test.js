/**
 * GET /api/bottles/:id and the translated copy of the wine's prose
 * (utils/profileLanguage, SuperAdmin → AI).
 *
 * WHY THIS TEST EXISTS:
 * The bottle page shows the translated description, flavours and pairings
 * while the copy is fresh; this route is also on the personal-token surface
 * (openapi/document.js), which reads the English profile only. Pinned: a
 * session gets a fresh copy beside the untouched English, never a stale one
 * (language changed, or the English written again since); a token gets no
 * copy at all; a wine with no copy answers as it always did.
 *
 * requireAuth is stubbed so a request can be marked token-authenticated (as
 * in bottles.tokenCache.test.js); the rest of the harness follows
 * bottles.grapeDisplay.test.js.
 */

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: '64b000000000000000000001', roles: ['user'] };
    if (req.headers['x-token'] === '1') req.apiToken = { id: 'tok', scopes: ['read'] };
    next();
  },
  requireNonDemo: (req, res, next) => next(),
}));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }) }));
jest.mock('../services/bottleLot', () => ({ findLotSiblingIds: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({ checkRestockGap: jest.fn(), resolveRestockAlerts: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn(), getSnapshotForDate: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => ({ updateMany: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) }));

const express = require('express');
const http = require('http');
const aiConfig = require('../config/aiConfig');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000cc';
const BOTTLE_ID = '64b0000000000000000000dd';
const AT = new Date('2026-11-13T10:00:00Z');
const ENGLISH = {
  body: 'full', tannin: 'high', acidity: 'high', sweetness: 'dry', flavors: ['tar', 'rose'],
  foodPairings: ['braised beef'], description: 'Firm and fragrant.', source: 'ai', generatedAt: AT, heldAt: null,
};
const COPY = { lang: 'de', description: 'Fest und duftig.', flavors: ['Teer', 'Rose'], foodPairings: ['Schmorbraten'], generatedAt: AT };
const json = (v) => JSON.parse(JSON.stringify(v));

function get({ token = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: `/api/bottles/${BOTTLE_ID}`, method: 'GET',
        headers: token ? { 'x-token': '1' } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

function serveBottleWith(aiProfile) {
  const wineDefinition = { _id: WINE_ID, name: 'Cannubi Boschis', producer: 'Luciano Sandrone', type: 'red', grapes: [], aiProfile };
  const stored = {
    _id: BOTTLE_ID, cellar: CELLAR_ID, vintage: '2016', wineDefinition,
    populate: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    toObject() {
      // A deep copy, as Mongoose's toObject gives: the route must not reach the stored doc.
      return { _id: this._id, cellar: this.cellar, vintage: this.vintage, wineDefinition: { ...wineDefinition, aiProfile: aiProfile && { ...aiProfile } } };
    },
  };
  Bottle.findById.mockResolvedValue(stored);
  return stored;
}

beforeEach(() => {
  jest.clearAllMocks();
  aiConfig.set({});
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  BottleImage.find.mockImplementation(() => { const q = { sort: () => q, limit: () => q, select: () => q, lean: async () => [] }; return q; });
  BottleImage.findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
  BottleImage.findById.mockReturnValue({ lean: async () => null });
});
afterAll(() => aiConfig.set({}));

test('a session gets a fresh copy beside the untouched English', async () => {
  aiConfig.set({ aiTextLanguage: 'de' });
  serveBottleWith({ ...ENGLISH, localized: COPY });
  const { status, body } = await get();
  expect(status).toBe(200);
  expect(body.bottle.wineDefinition.aiProfile).toEqual(json({ ...ENGLISH, localized: COPY }));
});

test('an API token gets the English profile only, even with the copy fresh', async () => {
  aiConfig.set({ aiTextLanguage: 'de' });
  serveBottleWith({ ...ENGLISH, localized: COPY });
  const { status, body } = await get({ token: true });
  expect(status).toBe(200);
  expect(body.bottle.wineDefinition.aiProfile).toEqual(json(ENGLISH));
});

test('stale by language: another language set, or none', async () => {
  for (const setting of [{ aiTextLanguage: 'fr' }, {}]) {
    aiConfig.set(setting);
    serveBottleWith({ ...ENGLISH, localized: COPY });
    const { body } = await get();
    expect(body.bottle.wineDefinition.aiProfile).toEqual(json(ENGLISH));
  }
});

test('stale by a newer English text: the profile was written again since', async () => {
  aiConfig.set({ aiTextLanguage: 'de' });
  const later = new Date('2026-11-14T08:00:00Z');
  serveBottleWith({ ...ENGLISH, generatedAt: later, localized: COPY });
  const { body } = await get();
  expect(body.bottle.wineDefinition.aiProfile).toEqual(json({ ...ENGLISH, generatedAt: later }));
});

test('a wine with no copy answers as it always did, setting on or off, session or token', async () => {
  for (const setting of [{}, { aiTextLanguage: 'de' }]) {
    for (const token of [false, true]) {
      aiConfig.set(setting);
      serveBottleWith({ ...ENGLISH });
      const { body } = await get({ token });
      expect(body.bottle.wineDefinition.aiProfile).toEqual(json(ENGLISH));
    }
  }
});
