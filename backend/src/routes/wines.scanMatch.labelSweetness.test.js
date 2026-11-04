/**
 * The scan-label match and the label sweetness term (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * The style guard that keeps a producer's range apart (issue #1134) reads a
 * candidate's RECORDED term before its name. It can only do that when the
 * candidate load populates the term: with a bare id and a cold term table the
 * guard reads "no term", and once the word has left the names a scanned
 * "… trocken" would be matched to the registry's halbtrocken. So the load
 * populates the term, and the guard drops a candidate whose record states a
 * different sweetness. Same mocks as wines.scanMatch.test.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false),
  search: jest.fn(async () => ({ ids: [] })),
}));
jest.mock('../services/labelScan', () => ({
  scanLabelFull: jest.fn(),
  identifyWineFromQuery: jest.fn(),
}));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn().mockResolvedValue({ ok: true, refund: jest.fn() }),
  isRefundableFailure: jest.fn().mockReturnValue(false),
  isRefundableScanError: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/crossFieldScan', () => ({ detectScanSuspectProducer: jest.fn(async () => null) }));
jest.mock('../services/imageOps', () => ({ persistLabelScan: jest.fn(async () => null) }));
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn() }));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const winesRouter = require('./wines');
const WineDefinition = require('../models/WineDefinition');
const { scanLabelFull } = require('../services/labelScan');

sharp.cache(false);

const USER_ID = '64b000000000000000000001';

function postScan(app) {
  return new Promise((resolve, reject) => {
    sharp({ create: { width: 6, height: 4, channels: 3, background: { r: 120, g: 0, b: 40 } } }).png().toBuffer().then((png) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const payload = JSON.stringify({ image: png.toString('base64'), mediaType: 'image/png' });
        const token = jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
        const req = http.request({
          port: server.address().port, path: '/api/wines/scan-label', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
        });
        req.on('error', (err) => { server.close(); reject(err); });
        req.end(payload);
      });
    }, reject);
  });
}

const candidate = (labelSweetness) => ({
  _id: '64b0000000000000000000c1', name: 'Riesling Spätlese', producer: 'Weingut Keller', appellation: 'Rheinhessen', type: 'white',
  country: { _id: '64b0000000000000000000a1', name: 'Germany' }, grapes: [], createdBy: '64b0000000000000000000d9', normalizedKey: 'k', canonicalKey: 'k',
  labelSweetness,
});
let populateSpy;
const textHits = (list) => {
  populateSpy = jest.fn(() => ({ limit: () => Promise.resolve(list) }));
  WineDefinition.find.mockReturnValue({ populate: populateSpy });
};

describe('POST /api/wines/scan-label — the style guard reads the candidate\'s recorded term', () => {
  const realFetch = global.fetch;
  let app;
  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/wines', winesRouter);
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    scanLabelFull.mockResolvedValue({ name: 'Riesling Spätlese trocken', producer: 'Weingut Keller', appellation: 'Rheinhessen' });
    WineDefinition.findOne.mockReturnValue({ populate: () => Promise.resolve(null) });
  });
  afterEach(() => { global.fetch = realFetch; });

  test('the candidate load populates the term as the API shape', async () => {
    textHits([]);
    await postScan(app);
    expect(populateSpy).toHaveBeenCalledWith(expect.arrayContaining([{ path: 'labelSweetness', select: 'name band scale regulated -_id' }]));
  });

  test('a populated candidate that RECORDS halbtrocken is dropped for a scanned "… trocken" — the next wine in the range', async () => {
    textHits([candidate({ name: 'halbtrocken', band: 'off-dry', scale: 'still', regulated: true })]);
    const { status, body } = await postScan(app);
    expect(status).toBe(200);
    expect(body.match).toBeNull();
  });

  test('the same candidate with an UNPOPULATED ref (and a cold term table) would have been matched — which is why the populate is load-bearing', async () => {
    textHits([candidate({ toString: () => '64b0000000000000000000f1' })]);
    const { body } = await postScan(app);
    expect(body.match && body.match.wine._id).toBe('64b0000000000000000000c1');
  });

  test('a populated candidate that records the same word links as before', async () => {
    textHits([candidate({ name: 'trocken', band: 'dry', scale: 'still', regulated: true })]);
    const { body } = await postScan(app);
    expect(body.match && body.match.wine._id).toBe('64b0000000000000000000c1');
  });
});
