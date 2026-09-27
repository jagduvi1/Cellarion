/**
 * GET /api/cellars/:id/statistics — the cellar page's totals, asked on every
 * visit.
 *
 * WHY THIS TEST EXISTS:
 * Until 2026-09-27 the handler loaded every active bottle to count them (a
 * 2,800-bottle cellar: ~100–140 ms). It now runs one grouping query: bottles
 * that share wine, vintage, rating and scale, price currency and price day
 * count the same way, so every figure is computed per group and weighed by
 * its size. On a copy of real data all 436 answers (218 cellars, 2
 * currencies) matched the per-bottle version. (MongoDB adds more precisely
 * than JavaScript, so a figure that falls on half a cent can round one cent
 * the other way.) Pinned here: what the query asks, and how groups become the
 * same numbers as bottles did.
 *
 * Real router + real requireAuth (HS256 test token); models are mocked.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/bottleSearch', () => ({ searchBottles: jest.fn(), bottleFacets: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({ createCellar: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/cellarTransfer', () => ({ transferCellarOwnership: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendCellarInviteEmail: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getSnapshotsForDates: jest.fn(),
  getOrCreateDailySnapshot: jest.fn(),
  convertCurrency: jest.requireActual('../utils/exchangeRates').convertCurrency,
}));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({}));
jest.mock('../models/AuditLog', () => ({}));
jest.mock('../models/PendingShare', () => ({}));
jest.mock('../models/ClimateDevice', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { getSnapshotsForDates, getOrCreateDailySnapshot } = require('../utils/exchangeRates');
const cellarsRouter = require('./cellars');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000c1';
const RED = '64b0000000000000000000a1';
const WHITE = '64b0000000000000000000a2';
const GONE = '64b0000000000000000000a9'; // a wine that no longer exists

function request(url) {
  const app = express();
  app.use(express.json());
  app.use('/api/cellars', cellarsRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port,
        path: url,
        method: 'GET',
        headers: { authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}` },
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

// One group per shared (wine, vintage, rating, scale, currency, price day).
const group = (id, count, { priceCount = 0, priceSum = 0 } = {}) => ({ _id: { priceDay: null, ...id }, count, priceCount, priceSum });

let pipeline;
beforeEach(() => {
  jest.clearAllMocks();
  // An ObjectId, as a loaded cellar has: an aggregation doesn't cast a string
  // id the way find() does, so matching on the URL's string would count nothing.
  const cellar = { _id: new mongoose.Types.ObjectId(CELLAR_ID), name: 'Home', user: USER_ID, members: [], deletedAt: null };
  Cellar.findById.mockResolvedValue(cellar);
  WineDefinition.find.mockImplementation((q) => {
    const wanted = new Set(q._id.$in.map(String));
    const rows = [
      { _id: RED, type: 'red', country: { name: 'France' } },
      { _id: WHITE, type: 'white', country: { name: 'Italy' } },
    ].filter((w) => wanted.has(w._id));
    const chain = { select: () => chain, populate: () => chain, lean: async () => rows };
    return chain;
  });
  getOrCreateDailySnapshot.mockResolvedValue({ rates: { USD: 1, EUR: 0.5, SEK: 10 } });
  getSnapshotsForDates.mockResolvedValue(new Map([['2026-01-15', { USD: 1, EUR: 0.8, SEK: 11 }]]));
});

function setGroups(groups) {
  Bottle.aggregate.mockImplementation((p) => {
    pipeline = p;
    return { allowDiskUse: async () => groups };
  });
}

test('one grouping query over this cellar\'s active bottles, by what the figures read', async () => {
  setGroups([]);
  const { status, body } = await request(`/api/cellars/${CELLAR_ID}/statistics`);
  expect(status).toBe(200);
  expect(Bottle.find).not.toHaveBeenCalled();
  const { cellar, ...rest } = pipeline[0].$match;
  expect(cellar).toBeInstanceOf(mongoose.Types.ObjectId);
  expect(String(cellar)).toBe(CELLAR_ID);
  expect(rest).toEqual({ status: { $nin: ['drank', 'gifted', 'sold', 'other'] } });
  expect(Object.keys(pipeline[1].$group._id)).toEqual(['wine', 'vintage', 'rating', 'ratingScale', 'currency', 'priceDay']);
  expect(pipeline[2]).toEqual({ $sort: { first: 1 } });
  expect(body.statistics).toMatchObject({ totalBottles: 0, uniqueWines: 0, totalValue: 0, oldestVintage: null, newestVintage: null });
});

test('groups weigh by their size: counts, unique wines (not pending, not gone), maps and vintage bounds', async () => {
  setGroups([
    group({ wine: RED, vintage: '2015', rating: 4, ratingScale: '5' }, 3),
    group({ wine: RED, vintage: '2010' }, 2),
    group({ wine: WHITE, vintage: 'NV', rating: 5, ratingScale: '5' }, 1),
    group({ wine: null, vintage: '2020' }, 4), // waiting for a wine request
    group({ wine: GONE, vintage: '1999' }, 1), // its wine no longer exists
  ]);
  const { body: { statistics: s } } = await request(`/api/cellars/${CELLAR_ID}/statistics`);
  expect(s.totalBottles).toBe(11);
  expect(s.uniqueWines).toBe(2);
  expect(s.byCountry).toEqual({ France: 5, Italy: 1, Unknown: 5 });
  expect(Object.keys(s.byCountry)).toEqual(['France', 'Italy', 'Unknown']); // first-bottle order
  expect(s.byType).toEqual({ red: 5, white: 1, Unknown: 5 });
  expect(s.byVintage).toEqual({ 1999: 1, 2010: 2, 2015: 3, 2020: 4, NV: 1 });
  expect(s.byRating).toEqual({ '61-80': 3, '81-100': 1 });
  expect(s.oldestVintage).toBe(1999);
  expect(s.newestVintage).toBe(2020);
});

test('prices: totals and averages over priced bottles; each group converts at its own day\'s rate, today\'s when it has none', async () => {
  setGroups([
    group({ wine: RED, vintage: '2015', currency: 'SEK' }, 3, { priceCount: 2, priceSum: 300 }), // one of three unpriced
    group({ wine: RED, vintage: '2015', currency: 'EUR', priceDay: '2026-01-15' }, 2, { priceCount: 2, priceSum: 40 }),
    group({ wine: WHITE, vintage: '2016' }, 1, { priceCount: 1, priceSum: 10 }), // no currency: USD
  ]);
  const { body: { statistics: s } } = await request(`/api/cellars/${CELLAR_ID}/statistics?currency=SEK`);
  expect(getSnapshotsForDates).toHaveBeenCalledWith(['2026-01-15']);
  expect(s.totalValue).toBe(350);
  expect(s.averagePrice).toBe(70); // 350 over 5 priced bottles
  // SEK as is (300) + 40 EUR at 2026-01-15 (40 / 0.8 * 11 = 550) + 10 USD today (10 / 1 * 10 = 100)
  expect(s.convertedTotal).toBe(950);
  expect(s.convertedAverage).toBe(190);
  expect(s.convertedCurrency).toBe('SEK');
});

test('a currency with no rate is left out of the converted figures, as before', async () => {
  getOrCreateDailySnapshot.mockResolvedValue({ rates: { USD: 1, SEK: 10 } }); // no XYZ
  setGroups([
    group({ wine: RED, vintage: '2015', currency: 'XYZ' }, 1, { priceCount: 1, priceSum: 5 }),
    group({ wine: RED, vintage: '2015', currency: 'USD' }, 1, { priceCount: 1, priceSum: 2 }),
  ]);
  const { body: { statistics: s } } = await request(`/api/cellars/${CELLAR_ID}/statistics?currency=SEK`);
  expect(s.totalValue).toBe(7);
  expect(s.convertedTotal).toBe(20);
  expect(s.convertedAverage).toBe(20);
});

test('another user\'s cellar is not found', async () => {
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: '64b000000000000000000099', members: [], deletedAt: null });
  const { status } = await request(`/api/cellars/${CELLAR_ID}/statistics`);
  expect(status).toBe(404);
  expect(Bottle.aggregate).not.toHaveBeenCalled();
});
