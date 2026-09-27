/**
 * DELETE /api/bottles/:id — the audit comes after the bottle is gone.
 *
 * WHY THIS TEST EXISTS:
 * The audit moves the owner's data version (services/dataVersion), which the
 * cellar search uses to know its kept documents are still current. Audited
 * before the delete, a search that read the new version in between would load
 * the bottle while it still existed and keep it, under the new version, for
 * its whole cache window (review 2026-09-27). Every other writer audits after
 * its write; this route now does too.
 *
 * Real router + real requireAuth/requireBottleAccess (HS256 test tokens);
 * models and side-effect services are mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexBottle: jest.fn(),
  removeBottle: jest.fn(),
}));
jest.mock('../services/bottleLot', () => ({ findLotSiblingIds: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({
  checkRestockGap: jest.fn().mockResolvedValue(null),
  resolveRestockAlerts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  getSnapshotForDate: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/vintageProfile', () => ({
  ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => ({ updateMany: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/WineRequest', () => ({ deleteOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), countDocuments: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Rack = require('../models/Rack');
const { logAudit } = require('../services/audit');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const BOTTLE_ID = '64b0000000000000000000dd';

function remove() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port,
        path: `/api/bottles/${BOTTLE_ID}`,
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}` },
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

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  Rack.updateMany.mockResolvedValue({});
  BottleImage.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  BottleImage.deleteMany.mockResolvedValue({});
  BottleImage.updateMany.mockResolvedValue({});
});

test('the bottle is deleted first, then audited (which moves the data version)', async () => {
  const order = [];
  const bottle = {
    _id: BOTTLE_ID, cellar: CELLAR_ID, user: USER_ID, status: 'active',
    deleteOne: jest.fn(async () => { order.push('delete'); }),
  };
  Bottle.findById.mockResolvedValue(bottle);
  logAudit.mockImplementation((req, action) => { order.push(action); });

  const { status } = await remove();

  expect(status).toBe(200);
  expect(order).toEqual(['delete', 'bottle.delete']);
  expect(logAudit).toHaveBeenCalledWith(
    expect.anything(), 'bottle.delete', { type: 'bottle', id: BOTTLE_ID, cellarId: CELLAR_ID }, {},
  );
});

test('a delete that fails is not audited', async () => {
  const bottle = {
    _id: BOTTLE_ID, cellar: CELLAR_ID, user: USER_ID, status: 'active',
    deleteOne: jest.fn(async () => { throw new Error('mongo is down'); }),
  };
  Bottle.findById.mockResolvedValue(bottle);
  jest.spyOn(console, 'error').mockImplementation(() => {});

  const { status } = await remove();

  expect(status).toBe(500);
  expect(logAudit).not.toHaveBeenCalled();
});
