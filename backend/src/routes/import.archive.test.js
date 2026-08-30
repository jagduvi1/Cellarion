/**
 * POST /api/bottles/import/confirm — the 30-day import archive.
 *
 * Import defects are only visible in the shape of the file that caused them,
 * and by the time one is reported the file is gone: parsing happens in the
 * browser, and ImportSession (which does hold the rows) is deleted the moment
 * an import succeeds. Two defects in one week were diagnosed by inference
 * instead of by reading the input.
 *
 * Locked here:
 *   - identity columns are archived, and price/notes/purchase data are NOT
 *   - each row records what became of it (matched / created / request)
 *   - the write never blocks or fails the import (fire-and-forget)
 *   - the row list is capped, and a truncated archive says so
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false, search: async () => ({ ids: [] }),
  indexWine: () => {}, bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/priceWarnings', () => ({ computeUserMediansByCurrency: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/aiProvider', () => ({ isConfigured: () => false }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) }));
jest.mock('../models/ImportSession', () => ({ deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/WishlistItem', () => function WishlistItem() {});
jest.mock('../models/Rack', () => {
  const m = { find: jest.fn(() => ({ lean: async () => [] })) };
  m.RACK_TYPES = ['grid'];
  return m;
});
jest.mock('../models/WineDefinition', () => ({
  findOne: jest.fn(() => ({ populate: async () => null })),
  find: jest.fn(() => ({ populate: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) })),
  findById: jest.fn(async () => null),
}));
// A Bottle that "saves" without a database.
jest.mock('../models/Bottle', () => {
  function Bottle(doc) { Object.assign(this, doc); this._id = 'bottle-' + (Bottle.__n++); }
  Bottle.__n = 1;
  Bottle.prototype.save = function () { return Promise.resolve(this); };
  Bottle.insertMany = jest.fn(async (docs) => docs);
  Bottle.countDocuments = jest.fn(async () => 0);
  Bottle.find = jest.fn(() => ({ lean: async () => [] }));
  return Bottle;
});
jest.mock('../models/WineRequest', () => {
  function WineRequest(doc) { Object.assign(this, doc); this._id = 'req-1'; }
  WineRequest.prototype.save = function () { return Promise.resolve(this); };
  return WineRequest;
});
// The archive itself — captured, never written.
jest.mock('../models/ImportArchive', () => ({ create: jest.fn(() => Promise.resolve({})) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const ImportArchive = require('../models/ImportArchive');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000c1';

const post = (body) => new Promise((resolve, reject) => {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  const server = http.createServer(app);
  server.listen(0, () => {
    const payload = JSON.stringify(body);
    const req = http.request({
      port: server.address().port, path: '/api/bottles/import/confirm', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
    });
    req.on('error', (e) => { server.close(); reject(e); });
    req.write(payload); req.end();
  });
});

// A row carrying BOTH identity columns and the personal fields that must not
// be archived.
const ROW = {
  wineName: 'Chianti Classico Riserva', producer: 'Fèlsina', vintage: '2019',
  country: 'Italy', region: 'Tuscany', appellation: 'Chianti Classico',
  type: 'red', grapes: ['Sangiovese'], quantity: 1, bottleSize: '750ml',
  wineDefinition: WINE_ID,
  // none of these may appear in the archive
  price: 42.5, currency: 'EUR', purchaseLocation: 'Systembolaget Uppsala',
  notes: 'For my father\'s birthday', rating: 4, purchaseDate: '2024-03-01',
};

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
  require('../models/WineDefinition').findById.mockResolvedValue({ _id: WINE_ID, name: 'X', producer: 'Y' });
});

// The archive write is fire-and-forget, so it may land a tick after the
// response; give the microtask queue a chance before asserting.
const flush = () => new Promise((r) => setImmediate(r));

describe('import archive', () => {
  it('keeps identity columns and the outcome, and drops personal fields', async () => {
    const { status } = await post({ cellarId: CELLAR_ID, items: [ROW], fileName: 'cellar.csv', detectedFormat: 'generic' });
    expect(status).toBe(200);
    await flush();

    expect(ImportArchive.create).toHaveBeenCalledTimes(1);
    const doc = ImportArchive.create.mock.calls[0][0];
    expect(doc).toMatchObject({
      user: USER_ID, cellar: CELLAR_ID, fileName: 'cellar.csv',
      detectedFormat: 'generic', rowCount: 1, rowsTruncated: false,
    });
    expect(doc.retainUntil.getTime()).toBeGreaterThan(Date.now() + 29 * 864e5);

    const row = doc.rows[0];
    expect(row).toMatchObject({
      wineName: 'Chianti Classico Riserva', producer: 'Fèlsina', vintage: '2019',
      country: 'Italy', region: 'Tuscany', appellation: 'Chianti Classico',
      type: 'red', grapes: ['Sangiovese'], bottleSize: '750ml',
      outcome: 'matched',
    });
    for (const forbidden of ['price', 'currency', 'purchaseLocation', 'notes', 'rating', 'purchaseDate']) {
      expect(row).not.toHaveProperty(forbidden);
    }
  });

  it('records what became of each row', async () => {
    await post({
      cellarId: CELLAR_ID,
      items: [
        { ...ROW },
        { wineName: 'Unknown One', producer: 'Nobody', country: 'Italy', requestWine: true },
      ],
    });
    await flush();

    const { rows } = ImportArchive.create.mock.calls[0][0];
    expect(rows.map((r) => r.outcome)).toEqual(['matched', 'request']);
  });

  it('a failing archive write never fails the import', async () => {
    ImportArchive.create.mockRejectedValueOnce(new Error('mongo down'));
    const { status, body } = await post({ cellarId: CELLAR_ID, items: [ROW] });
    expect(status).toBe(200);
    expect(body.created).toBe(1);
    await flush();
  });

  it('is not awaited — the response does not wait on the write', async () => {
    // A write that never settles must not hold the response open. If the
    // route awaited it, this request could not return.
    ImportArchive.create.mockReturnValueOnce(new Promise(() => {}));
    const { status } = await post({ cellarId: CELLAR_ID, items: [ROW] });
    expect(status).toBe(200);
  });
});
