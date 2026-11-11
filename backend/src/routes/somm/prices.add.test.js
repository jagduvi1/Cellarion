/**
 * POST /api/somm/prices — a price snapshot carries the bottles' canonical
 * vintage.
 *
 * The route stored the vintage as typed (only trimmed). A snapshot for "nv"
 * never matched NV bottles in the value report, and a malformed year ("2O15",
 * "20015") was stored and matched nothing — not the bottles, not the open
 * request it was meant to answer. It now goes through the same
 * parseAndValidateVintage the bottles do; an unknown vintage has no vintage
 * price. Harness follows prices.decline.test.js (real router + real auth,
 * models mocked).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/labelScan', () => ({ suggestPrice: jest.fn() }));
jest.mock('../../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  getSnapshotsForDates: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../../models/WineVintagePrice', () => jest.fn(function (doc) {
  Object.assign(this, doc);
  this._id = 'price-1';
  this.save = jest.fn().mockResolvedValue(undefined);
  this.populate = jest.fn().mockResolvedValue(undefined);
}));
jest.mock('../../models/PriceTrackingRequest', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../models/PriceTrackingSkip', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), exists: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineVintagePrice = require('../../models/WineVintagePrice');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const WineDefinition = require('../../models/WineDefinition');
const pricesRouter = require('./prices');

const SOMM_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000ee';

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

function addPrice(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/somm/prices', pricesRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: '/api/somm/prices', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${jwt.sign({ id: SOMM_ID, roles: ['somm'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(JSON.stringify(body));
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.exists.mockResolvedValue(true);
  PriceTrackingRequest.findOne.mockReturnValue(chain(null));
});

test('"nv" is stored as NV and the open request is looked up as NV', async () => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: 'nv', price: 40, currency: 'EUR' });
  expect(res.status).toBe(201);
  expect(res.body.entry.vintage).toBe('NV');
  expect(WineVintagePrice.mock.calls[0][0].vintage).toBe('NV');
  expect(PriceTrackingRequest.findOne).toHaveBeenCalledWith({ wineDefinition: WINE_ID, vintage: 'NV' });
});

test.each([
  ['an infinite number', 1e999],
  ['an infinite number as text', 'Infinity'],
  ['a decimal comma', '12,5'],
  ['a figure with a unit', '40 EUR'],
  ['a boolean', true],
  ['a negative number', -1],
])('a price that is %s is a 400 and nothing is stored', async (_label, price) => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: '2019', price });
  expect(res.status).toBe(400);
  expect(WineVintagePrice).not.toHaveBeenCalled();
});

test('a price sent as text with surrounding spaces is read as the number it is', async () => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: '2019', price: ' 45.50 ' });
  expect(res.status).toBe(201);
  expect(WineVintagePrice.mock.calls[0][0].price).toBe(45.5);
});

test.each([
  ['a number', 5],
  ['an object', { id: 'aaaaaaaaaaaa' }],
])('a wineDefinition that is %s is a 400, not a server error', async (_label, wineDefinition) => {
  const res = await addPrice({ wineDefinition, vintage: '2019', price: 40 });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Invalid wineDefinition ID');
  expect(WineDefinition.exists).not.toHaveBeenCalled();
});

test('a malformed year is a 400 with the vintage rule, and nothing is stored', async () => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: '20015', price: 40 });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Vintage 20015 is out of range/);
  expect(WineVintagePrice).not.toHaveBeenCalled();
});

test('an unknown vintage has no vintage price', async () => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: 'Unknown', price: 40 });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('A price needs a vintage year or NV');
  expect(WineVintagePrice).not.toHaveBeenCalled();
});

// Release audit 2026-10-23: the helper reads a blank value as NV, so a
// whitespace-only vintage was stored as an NV price instead of being refused.
test('a whitespace-only vintage is refused, not stored as NV', async () => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: '   ', price: 40 });
  expect(res.status).toBe(400);
  expect(WineVintagePrice).not.toHaveBeenCalled();
});

// Requesters are members: /somm/prices answers them with Access Denied, so the
// notification links to the public wine page instead.
test('requesters are notified with a link to the public wine page', async () => {
  const { createNotification } = require('../../services/notifications');
  PriceTrackingRequest.findOne.mockReturnValue(chain({
    requesters: [{ user: '64b000000000000000000002' }],
    wineDefinition: { name: 'Barolo Castiglione', producer: 'Vietti' },
  }));
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: '2019', price: 45, currency: 'EUR' });
  expect(res.status).toBe(201);
  await new Promise((r) => setImmediate(r));
  expect(createNotification).toHaveBeenCalledWith('64b000000000000000000002', 'price_tracked', 'Market price updated',
    'A sommelier just added a market price for Vietti — Barolo Castiglione 2019: EUR 45.', `/wines/${WINE_ID}`);
});

test('an ordinary year is stored unchanged', async () => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: ' 2016 ', price: 55 });
  expect(res.status).toBe(201);
  expect(res.body.entry.vintage).toBe('2016');
});

test.each([
  ['a source over 100 characters', { source: 'x'.repeat(101) }, 'source must be 100 characters or less'],
  ['notes over 2,000 characters', { sommNotes: 'x'.repeat(2001) }, 'sommNotes must be 2000 characters or less'],
  ['a source that is not text', { source: { $gt: '' } }, 'source must be text'],
  ['notes that are not text', { sommNotes: 5 }, 'sommNotes must be text'],
])('%s is a 400, and nothing is stored', async (name, extra, message) => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: '2019', price: 40, ...extra });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe(message);
  expect(WineVintagePrice).not.toHaveBeenCalled();
});

test('a source and notes within the limits are stored', async () => {
  const res = await addPrice({ wineDefinition: WINE_ID, vintage: '2019', price: 40, source: 'x'.repeat(100), sommNotes: 'auction result' });
  expect(res.status).toBe(201);
  expect(WineVintagePrice.mock.calls[0][0]).toMatchObject({ source: 'x'.repeat(100), sommNotes: 'auction result' });
});
