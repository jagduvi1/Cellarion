/**
 * POST /api/bottles/import/confirm — the photo link a file gives a row.
 *
 * The bottles are created as always; the link of each row that has one is
 * handed, with its bottle, to services/importPhotos (its own suite), which
 * copies the photos in after the response. The answer says how many are on
 * their way, and says nothing when none are.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }), indexWine: () => {} }));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn(), logger: { warn: jest.fn() } }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/importPhotos', () => ({ queueImportPhotos: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({
  wineVisibilityFilter: () => ({}),
  findVisibleWine: (id) => require('../models/WineDefinition').findById(id),
}));
jest.mock('../models/ImportSession', () => ({ deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/ImportArchive', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/Bottle', () => {
  const instances = [];
  function Bottle(data) {
    this.status = 'active';
    Object.assign(this, data);
    this._id = `bottle-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  Bottle.__instances = instances;
  return Bottle;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { queueImportPhotos } = require('../services/importPhotos');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000cc';
const PHOTO = 'https://firebasestorage.googleapis.com/v0/b/ma-cave-a-vins-app.appspot.com/o/wines%2Fu%2Fp1?alt=media&token=t';

function confirm(items) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify({ cellarId: CELLAR_ID, items });
      const req = http.request({
        port: server.address().port,
        path: '/api/bottles/import/confirm',
        method: 'POST',
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
      req.write(payload);
      req.end();
    });
  });
}

const row = (fields = {}) => ({ wineDefinition: WINE_ID, vintage: '2021', ...fields });

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  WineDefinition.findById.mockResolvedValue({ _id: WINE_ID, name: 'Test Wine', producer: 'Test Prod' });
});

test('each created bottle is handed over with its row\'s photo link, and the answer counts what is on its way', async () => {
  queueImportPhotos.mockReturnValue({ queued: 1, notQueued: 0 });
  const { status, body } = await confirm([row({ photoUrl: PHOTO }), row({ photoUrl: PHOTO }), row()]);

  expect(status).toBe(200);
  expect(body.created).toBe(3);
  expect(queueImportPhotos).toHaveBeenCalledTimes(1);
  const [, rows, opts] = queueImportPhotos.mock.calls[0];
  expect(rows).toEqual([{ bottleId: 'bottle-0', url: PHOTO }, { bottleId: 'bottle-1', url: PHOTO }]);
  expect(opts).toEqual({ cellarId: CELLAR_ID });
  expect(body.photosQueued).toBe(1);
  expect(body).not.toHaveProperty('photosNotQueued');
});

test('photos the queue could not take are counted in the answer', async () => {
  queueImportPhotos.mockReturnValue({ queued: 0, notQueued: 2 });
  const { body } = await confirm([row({ photoUrl: PHOTO })]);

  expect(body).not.toHaveProperty('photosQueued');
  expect(body.photosNotQueued).toBe(2);
});

test('an import without photo links answers as it always did', async () => {
  queueImportPhotos.mockReturnValue({ queued: 0, notQueued: 0 });
  const { body } = await confirm([row()]);

  expect(queueImportPhotos.mock.calls[0][1]).toEqual([]);
  expect(body).not.toHaveProperty('photosQueued');
  expect(body).not.toHaveProperty('photosNotQueued');
});
