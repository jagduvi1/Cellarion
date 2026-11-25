/**
 * GET /api/somm/prices/lookup — the price history of one wine + vintage, read
 * by any signed-in member (BottleDetail, CellarVintage).
 *
 * The registry never shows members who contributed its data, so who recorded a
 * price (setBy) is populated for sommeliers and admins only; for everyone else
 * the field is left out of the query altogether — the same rule as
 * GET /api/somm/maturity/lookup (maturity.lookup.test.js, whose harness this
 * follows: real router + real requireAuth, the model mocked).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/labelScan', () => ({ suggestPrice: jest.fn() }));
jest.mock('../../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  getSnapshotsForDates: jest.fn(),
}));
jest.mock('../../models/WineVintagePrice', () => ({ find: jest.fn() }));
jest.mock('../../models/PriceTrackingRequest', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../models/PriceTrackingSkip', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), exists: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineVintagePrice = require('../../models/WineVintagePrice');
const { getSnapshotsForDates } = require('../../utils/exchangeRates');
const pricesRouter = require('./prices');

const USER_ID = '64b000000000000000000002';
const WINE_ID = '64b0000000000000000000ee';
const DAY = '2026-11-20';
const RATES = { base: 'USD', rates: { EUR: 0.9 } };

// The query find returns: sort/populate/select record the call and return the
// query; lean() resolves the rows the test chose.
const queryResolving = (rows) => {
  const q = {};
  q.sort = jest.fn(() => q);
  q.populate = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.lean = jest.fn(() => Promise.resolve(rows));
  return q;
};
const entry = (extra = {}) => ({ _id: 'p1', price: 120, currency: 'EUR', source: 'Auction house', sommNotes: 'Hammer price', setAt: new Date(`${DAY}T10:00:00.000Z`), ...extra });

function lookup(roles, url = `/api/somm/prices/lookup?wine=${WINE_ID}&vintage=2018`) {
  const app = express();
  app.use('/api/somm/prices', pricesRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const token = jwt.sign({ id: USER_ID, roles }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
      http.get({ port: server.address().port, path: url, headers: { authorization: `Bearer ${token}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getSnapshotsForDates.mockResolvedValue(new Map([[DAY, RATES]]));
});

test('a member gets the prices, the source and the note, without who recorded them', async () => {
  const q = queryResolving([entry()]);
  WineVintagePrice.find.mockReturnValue(q);
  const res = await lookup(['user']);
  expect(res.status).toBe(200);
  expect(WineVintagePrice.find).toHaveBeenCalledWith({ wineDefinition: WINE_ID, vintage: '2018' });
  expect(q.sort).toHaveBeenCalledWith({ setAt: -1 });
  // The setter is never read for a member, so it cannot be in the answer.
  expect(q.select).toHaveBeenCalledWith('-setBy');
  expect(q.populate).not.toHaveBeenCalled();
  expect(res.body.history).toHaveLength(1);
  expect(res.body.history[0]).toMatchObject({ price: 120, currency: 'EUR', source: 'Auction house', sommNotes: 'Hammer price', exchangeRates: RATES });
  expect(res.body.history[0]).not.toHaveProperty('setBy');
});

test.each([['somm'], ['admin']])('a %s also sees who recorded each price', async (role) => {
  const q = queryResolving([entry({ setBy: { _id: 'u9', username: 'curator' } })]);
  WineVintagePrice.find.mockReturnValue(q);
  const res = await lookup([role]);
  expect(res.status).toBe(200);
  expect(q.populate).toHaveBeenCalledWith('setBy', 'username');
  expect(q.select).not.toHaveBeenCalled();
  expect(res.body.history[0].setBy).toEqual({ _id: 'u9', username: 'curator' });
});

test('no price yet answers an empty history', async () => {
  WineVintagePrice.find.mockReturnValue(queryResolving([]));
  const res = await lookup(['user']);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ history: [] });
});

test.each([
  ['a missing vintage', `/api/somm/prices/lookup?wine=${WINE_ID}`],
  ['a wine id that is not an id', '/api/somm/prices/lookup?wine=not-an-id&vintage=2018'],
])('%s is refused before the database is asked', async (_label, url) => {
  const res = await lookup(['user'], url);
  expect(res.status).toBe(400);
  expect(WineVintagePrice.find).not.toHaveBeenCalled();
});
