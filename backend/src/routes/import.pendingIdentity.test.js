/**
 * POST /api/bottles/import/confirm — import rows whose wine cannot be fully
 * identified now IMPORT instead of vanishing.
 *
 * Before this feature: an aiWine row with no producer was rejected outright
 * ("missing its name or producer"), and one whose producer was a geography
 * ("Bordeaux", the classic one-column-off mapping) threw the strict mint gate
 * into the per-row catch. Either way the user silently lost the bottle from
 * their own file — the exact friction the pending-identity queue removes.
 *
 * Pins: the row imports, the wine is minted with allowPending, the count is
 * reported to the client AND folded into the EXISTING bottle.import audit
 * event (rather than a second action nobody reads).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf'];
  return model;
});
jest.mock('../models/Bottle', () => {
  const instances = [];
  function Bottle(data) {
    Object.assign(this, data);
    this._id = `bottle-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  Bottle.__instances = instances;
  return Bottle;
});
jest.mock('../models/WineRequest', () => {
  const instances = [];
  function WineRequest(data) {
    Object.assign(this, data);
    this._id = `winereq-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  WineRequest.__instances = instances;
  return WineRequest;
});
jest.mock('../models/WishlistItem', () => ({ findOne: jest.fn(), create: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineRequest = require('../models/WineRequest');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { logAudit } = require('../services/audit');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000cc';

function postJson(url, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: url, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
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
}

const confirm = (items) => postJson('/api/bottles/import/confirm', { cellarId: CELLAR_ID, items });

const PENDING_WINE = { _id: WINE_ID, name: 'Kaefferkopf', producer: '', pendingIdentity: true };

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.__instances.length = 0;
  WineRequest.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  findOrCreateWine.mockResolvedValue({ wine: PENDING_WINE, created: true, pendingIdentity: true });
});

test('a row with NO producer still imports — the bottle lands, the wine goes to the queue', async () => {
  const { status, body } = await confirm([
    { aiWine: { name: 'Kaefferkopf', country: 'France' }, vintage: '2019' },
  ]);

  expect(status).toBe(200);
  expect(body.created).toBe(1);
  expect(body.errors).toEqual([]);            // no longer "missing its name or producer"
  expect(Bottle.__instances).toHaveLength(1);
  expect(String(Bottle.__instances[0].wineDefinition)).toBe(WINE_ID);
  // No WineRequest degradation: the wine EXISTS, it is just incomplete.
  expect(WineRequest.__instances).toHaveLength(0);

  // The mint ran on the commit path with allowPending, and '' not undefined
  // reached the service (its .trim() runs before any option is consulted).
  const [fields, userId, opts] = findOrCreateWine.mock.calls[0];
  expect(fields.producer).toBe('');
  expect(userId).toBe(USER_ID);
  // toEqual, not objectContaining: the option set is a drift canary, so a new
  // option has to be added here deliberately. `provenance` joined on
  // 2026-08-31 (somm ticket 6a958dbc) — and this row is the purest case for
  // it, since the file states nothing but a vintage, so every identity field
  // the wine ends up with came from the model.
  expect(opts).toEqual({
    createdVia: 'import',
    allowPending: true,
    provenance: expect.objectContaining({ name: 'model', country: 'model', grapes: 'model' }),
  });
});

test('the count is reported to the client and folded into the EXISTING import audit', async () => {
  const { body } = await confirm([
    { aiWine: { name: 'Kaefferkopf', country: 'France' }, vintage: '2019' },
  ]);

  expect(body.pendingIdentityCount).toBe(1);
  expect(logAudit).toHaveBeenCalledWith(
    expect.anything(), 'bottle.import', { type: 'cellar', id: CELLAR_ID },
    expect.objectContaining({ created: 1, pendingIdentity: 1 }),
  );
});

test('a complete identity reports zero — the count is a subset of created wines', async () => {
  findOrCreateWine.mockResolvedValue({
    wine: { _id: WINE_ID, name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' },
    created: true,
  });

  const { body } = await confirm([
    { aiWine: { name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France' }, vintage: '2019' },
  ]);

  expect(body.created).toBe(1);
  expect(body.pendingIdentityCount).toBe(0);
});

test('a row with no NAME is still an error — a nameless wine is no identity at all', async () => {
  const { body } = await confirm([{ aiWine: { producer: 'Cave de Kaysersberg' }, vintage: '2019' }]);

  expect(body.created).toBe(0);
  expect(body.errors[0].reason).toMatch(/missing its name/);
  expect(findOrCreateWine).not.toHaveBeenCalled();
});

test('repeated rows of the same unidentified wine mint ONE registry row (batch cache)', async () => {
  const { body } = await confirm([
    { aiWine: { name: 'Kaefferkopf', country: 'France' }, vintage: '2019' },
    { aiWine: { name: 'Kaefferkopf', country: 'France' }, vintage: '2020' },
  ]);

  expect(body.created).toBe(2);
  expect(findOrCreateWine).toHaveBeenCalledTimes(1);
  expect(body.pendingIdentityCount).toBe(1);
});
