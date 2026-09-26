/**
 * GET /api/stats/overview — the data-version cache.
 *
 * Scaling audit 2026-09-25: Home Assistant polls the overview every few
 * minutes; the old 2-minute cache window almost never matched, so every poll
 * reloaded and recomputed the user's whole collection — the #1 database load.
 * Pinned here: an unchanged poll is answered from memory without touching the
 * collection; any audited change (the data version), a new currency or rating
 * scale, or the max age brings a recompute; and a change that lands while the
 * overview is being computed is never stored as current.
 *
 * Real router + real requireAuth (HS256 test tokens) + the real data version;
 * models and the stats computation are mocked.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/CellarValueSnapshot', () => ({}));
jest.mock('../services/statsService', () => ({
  computeOverview: jest.fn(),
  buildEmptyStats: jest.fn(() => ({ empty: true })),
}));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn(), getSnapshotsForDates: jest.fn(), convertCurrency: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { computeOverview } = require('../services/statsService');
const { bumpDataVersion } = require('../services/dataVersion');
const statsRouter = require('./stats');

let prefs;
function get(userId) {
  const app = express();
  app.use('/api/stats', statsRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: '/api/stats/overview', method: 'GET',
        headers: { authorization: `Bearer ${jwt.sign({ id: userId, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}` },
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

let computed;
beforeEach(() => {
  jest.clearAllMocks();
  prefs = { currency: 'SEK', ratingScale: '5' };
  User.findById.mockImplementation(() => ({ select: () => ({ lean: async () => ({ preferences: { ...prefs } }) }) }));
  Cellar.find.mockReturnValue({ lean: async () => [{ _id: 'c1', name: 'Home' }] });
  const chain = { populate: () => chain, lean: async () => [] };
  Bottle.find.mockReturnValue(chain);
  computed = 0;
  computeOverview.mockImplementation(async () => ({ run: ++computed }));
});

test('an unchanged poll is answered from memory — no cellar or bottle reads', async () => {
  const first = await get('64b000000000000000000001');
  const second = await get('64b000000000000000000001');
  expect(first.body.stats).toEqual({ run: 1 });
  expect(second.body.stats).toEqual({ run: 1 });
  expect(computeOverview).toHaveBeenCalledTimes(1);
  expect(Cellar.find).toHaveBeenCalledTimes(1);
  expect(Bottle.find).toHaveBeenCalledTimes(2); // active + consumed, once
});

test('a change (the data version moves) brings a recompute on the next poll', async () => {
  const u = '64b000000000000000000002';
  await get(u);
  bumpDataVersion(u);
  const after = await get(u);
  expect(after.body.stats).toEqual({ run: 2 });
  // …and is then served from memory again.
  expect((await get(u)).body.stats).toEqual({ run: 2 });
  expect(computeOverview).toHaveBeenCalledTimes(2);
});

test('another user\'s change does not touch this user\'s answer', async () => {
  const u = '64b000000000000000000003';
  await get(u);
  bumpDataVersion('64b0000000000000000000ff');
  expect((await get(u)).body.stats).toEqual({ run: 1 });
});

test('a change that lands WHILE the overview is computed is never cached as current', async () => {
  const u = '64b000000000000000000004';
  computeOverview.mockImplementationOnce(async () => {
    bumpDataVersion(u); // a write finishes mid-computation
    return { run: ++computed };
  });
  await get(u);
  const next = await get(u);
  expect(next.body.stats).toEqual({ run: 2 });
});

test('a new currency or rating scale is a different answer', async () => {
  const u = '64b000000000000000000005';
  await get(u);
  prefs = { currency: 'EUR', ratingScale: '5' };
  expect((await get(u)).body.stats).toEqual({ run: 2 });
  prefs = { currency: 'EUR', ratingScale: '100' };
  expect((await get(u)).body.stats).toEqual({ run: 3 });
});

test('an answer older than the max age is recomputed — changes the version cannot see', async () => {
  const u = '64b000000000000000000006';
  await get(u);
  const later = Date.now() + 31 * 60 * 1000;
  const spy = jest.spyOn(Date, 'now').mockReturnValue(later);
  try {
    expect((await get(u)).body.stats).toEqual({ run: 2 });
  } finally {
    spy.mockRestore();
  }
});

test('no cellars: the empty answer, and nothing is computed', async () => {
  Cellar.find.mockReturnValue({ lean: async () => [] });
  const res = await get('64b000000000000000000007');
  expect(res.body.stats).toEqual({ empty: true });
  expect(computeOverview).not.toHaveBeenCalled();
});
