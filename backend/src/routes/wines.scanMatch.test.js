/**
 * POST /api/wines/scan-label — the registry match never returns a hidden row,
 * and a member's match carries no curation internals.
 *
 * matchScannedIdentity was a bare registry lookup: the exact-key findOne and
 * the $text fallback (used whenever Meilisearch is down or found nothing) had
 * none of the filters registry search applies, so a scan could match a
 * quarantined non-wine, a canary (firing the lockdown alarm), or — through the
 * fallback — a stranger's pending row. And the matched document went back
 * whole: createdBy, keys, scan-image ids, the canary flag. Harness follows
 * wines.scanLabel.test.js; WineDefinition's two lookups are mocked.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
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
const HIDDEN = { nonWine: { $ne: true }, canary: { $ne: true } };
const MEMBER_PENDING = { $or: [{ pendingIdentity: { $ne: true } }, { pendingIdentity: true, createdBy: USER_ID }] };

function postScan(app, roles) {
  return new Promise((resolve, reject) => {
    sharp({ create: { width: 6, height: 4, channels: 3, background: { r: 120, g: 0, b: 40 } } }).png().toBuffer().then((png) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const payload = JSON.stringify({ image: png.toString('base64'), mediaType: 'image/png' });
        const token = jwt.sign({ id: USER_ID, roles }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
        const req = http.request({
          port: server.address().port,
          path: '/api/wines/scan-label',
          method: 'POST',
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

const registryWine = (over = {}) => ({
  _id: '64b0000000000000000000c1',
  name: 'Prapò', producer: 'Paolo Scavino', appellation: 'Barolo', type: 'red',
  country: { _id: '64b0000000000000000000a1', name: 'Italy' }, grapes: [],
  createdBy: '64b0000000000000000000d9', normalizedKey: 'paolo scavino:prapo:barolo',
  canonicalKey: 'k', scanImage: '64b0000000000000000000e1', canary: false,
  ...over,
});
const exactHit = (doc) => WineDefinition.findOne.mockReturnValue({ populate: () => Promise.resolve(doc) });
const textHits = (list) => WineDefinition.find.mockReturnValue({ populate: () => ({ limit: () => Promise.resolve(list) }) });

describe('POST /api/wines/scan-label — the registry match', () => {
  const realFetch = global.fetch;
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/wines', winesRouter);
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')); // rembg down
    scanLabelFull.mockResolvedValue({ name: 'Prapò', producer: 'Paolo Scavino', appellation: 'Barolo' });
    textHits([]);
  });
  afterEach(() => { global.fetch = realFetch; });

  test('the exact-key lookup carries nonWine $ne, canary $ne and the viewer\'s pending clause', async () => {
    exactHit(registryWine());
    const { status } = await postScan(app, ['user']);
    expect(status).toBe(200);
    expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: expect.any(String), ...HIDDEN, ...MEMBER_PENDING });
  });

  test('a filtered-out exact hit falls through to the $text fallback, which carries the same filter', async () => {
    exactHit(null); // what Mongo answers when the only key match is hidden
    textHits([registryWine({ _id: '64b0000000000000000000c2', name: 'Prapo' })]);
    const { status, body } = await postScan(app, ['user']);
    expect(status).toBe(200);
    expect(WineDefinition.find).toHaveBeenCalledWith({ $text: { $search: 'Prapò Paolo Scavino' }, ...HIDDEN, ...MEMBER_PENDING });
    expect(body.match.wine._id).toBe('64b0000000000000000000c2');
  });

  test('a member\'s match carries no curation internals', async () => {
    exactHit(registryWine());
    const { body } = await postScan(app, ['user']);
    expect(body.match.wine.name).toBe('Prapò');
    expect(body.match.wine.country.name).toBe('Italy');
    for (const f of ['createdBy', 'normalizedKey', 'canonicalKey', 'scanImage', 'canary']) {
      expect(body.match.wine).not.toHaveProperty(f);
    }
  });

  test('a sommelier\'s match keeps the full document, under the curator pending clause', async () => {
    exactHit(registryWine());
    const { body } = await postScan(app, ['somm']);
    expect(body.match.wine.createdBy).toBe('64b0000000000000000000d9');
    expect(body.match.wine.normalizedKey).toBe('paolo scavino:prapo:barolo');
    expect(body.match.wine.scanImage).toBe('64b0000000000000000000e1');
    expect(WineDefinition.findOne).toHaveBeenCalledWith(expect.objectContaining({
      ...HIDDEN,
      $or: [{ draft: { $ne: true } }, { draft: true, createdBy: USER_ID }],
    }));
  });
});
