/**
 * POST /api/bottles/import/confirm — the outcome each archived row records.
 *
 * The archive keeps what the row's SELECTION resolved to. The import client
 * sends a confirmed AI proposal as `aiWine` (utils/importPayload), and /confirm
 * fills in item.wineDefinition when it mints that wine, before the archive is
 * written. The outcome therefore has to be read from `aiWine`, or every
 * minted row reads as an ordinary registry match.
 *
 * Locked here:
 *   - a matched row, a confirmed AI proposal and a request read
 *     'matched', 'created' and 'request'
 *   - a repeat of the same AI proposal in one batch is 'created' too, even
 *     though the wine is only minted once
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
  WineRequest.findOne = jest.fn().mockResolvedValue(null); // intake reuse lookup (services/wineRequestIntake)
  return WineRequest;
});
// The archive itself — captured, never written.
jest.mock('../models/ImportArchive', () => ({ create: jest.fn(() => Promise.resolve({})) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const ImportArchive = require('../models/ImportArchive');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000c1';
const MINTED_WINE_ID = '64b0000000000000000000c2';

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

const MATCHED_ROW = {
  wineName: 'Chianti Classico Riserva', producer: 'Fèlsina', vintage: '2019',
  country: 'Italy', wineDefinition: WINE_ID,
};
const AI_WINE = { name: 'Clos du Test', producer: 'Domaine Fictif', country: 'France', type: 'red' };
const AI_ROW = { aiWine: AI_WINE, wineName: 'Clos du Test', producer: 'Domaine Fictif', vintage: '2019' };
const REQUEST_ROW = { wineName: 'Unknown One', producer: 'Nobody', country: 'Italy', requestWine: true };

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
  require('../models/WineDefinition').findById.mockResolvedValue({ _id: WINE_ID, name: 'X', producer: 'Y' });
  findOrCreateWine.mockResolvedValue({
    wine: { _id: MINTED_WINE_ID, name: AI_WINE.name, producer: AI_WINE.producer, type: 'red' },
    created: true,
  });
});

// The archive write is fire-and-forget, so it may land a tick after the
// response; give the microtask queue a chance before asserting.
const flush = () => new Promise((r) => setImmediate(r));

describe('import archive outcome', () => {
  it('archives a confirmed AI proposal as created, beside matched and request rows', async () => {
    const { status, body } = await post({ cellarId: CELLAR_ID, items: [MATCHED_ROW, AI_ROW, REQUEST_ROW] });
    expect(status).toBe(200);
    expect(body.created).toBe(3);
    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    await flush();

    expect(ImportArchive.create).toHaveBeenCalledTimes(1);
    const { rows } = ImportArchive.create.mock.calls[0][0];
    expect(rows.map((r) => r.outcome)).toEqual(['matched', 'created', 'request']);
    // The archive keeps the row's identity columns, not the AI proposal itself.
    expect(rows[1]).not.toHaveProperty('aiWine');
  });

  it('a repeat of the same AI proposal in one batch is archived as created too', async () => {
    const { status, body } = await post({
      cellarId: CELLAR_ID,
      items: [AI_ROW, { ...AI_ROW, vintage: '2020' }],
    });
    expect(status).toBe(200);
    expect(body.created).toBe(2);
    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    await flush();

    const { rows } = ImportArchive.create.mock.calls[0][0];
    expect(rows.map((r) => r.outcome)).toEqual(['created', 'created']);
  });
});
