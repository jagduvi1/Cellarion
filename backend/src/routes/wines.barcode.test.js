/**
 * GET /api/wines/barcode/:code — route wiring for the barcode lookup.
 *
 * WHY THIS TEST EXISTS:
 * The add-bottle camera calls this on every barcode it sees: an invalid or
 * shop-internal code must answer "not known" without touching the database,
 * a valid one reaches the lookup in its canonical form with the caller as the
 * viewer (whose visibility decides which wines may be named).
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/barcodeLookup', () => ({ lookupBarcode: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: jest.fn(), indexWine: jest.fn() }));
jest.mock('../services/labelScan', () => ({ scanLabelFull: jest.fn(), identifyWineFromQuery: jest.fn() }));
jest.mock('../services/imageOps', () => ({ persistLabelScan: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/crossFieldScan', () => ({ detectBlockingProducerIssue: jest.fn(async () => null), detectScanSuspectProducer: jest.fn(async () => null) }));
jest.mock('../services/wineMatching', () => ({ findBestMatch: jest.fn(() => ({ bestMatch: null, bestScore: 0 })) }));
jest.mock('../services/communityPrice', () => ({ getReleaseCurve: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { lookupBarcode } = require('../services/barcodeLookup');
const winesRouter = require('./wines');

const USER = 'a'.repeat(24);
const token = jwt.sign({ id: USER, roles: ['user'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/wines', winesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

const get = (code, auth = true) => fetch(`${baseUrl}/api/wines/barcode/${code}`, {
  headers: auth ? { Authorization: `Bearer ${token}` } : {},
});

test('a valid code reaches the lookup canonicalised, with the caller as viewer', async () => {
  lookupBarcode.mockResolvedValue({ wine: { _id: 'w1', name: 'Barolo' }, vintage: null, owners: 2 });
  const res = await get('036000291452'); // UPC-A
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ wine: { _id: 'w1', name: 'Barolo' }, vintage: null, owners: 2, code: '0036000291452' });
  expect(lookupBarcode).toHaveBeenCalledWith('0036000291452', { userId: USER, roles: ['user'] });
});

test('an invalid code answers "not known" without a lookup', async () => {
  const res = await get('4006381333932'); // wrong check digit
  expect(await res.json()).toEqual({ wine: null, invalid: true });
  expect(lookupBarcode).not.toHaveBeenCalled();
});

test('requires a signed-in user', async () => {
  expect((await get('4006381333931', false)).status).toBe(401);
});
