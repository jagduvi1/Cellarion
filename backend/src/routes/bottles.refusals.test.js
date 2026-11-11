/**
 * Two bottle routes that answered 500 for a request they should refuse:
 * PUT /api/bottles/:id/consumed-rating with a note that is not text, and
 * DELETE /api/bottles/:id/pour when another request changed the pours first.
 *
 * Real router and access middleware (HS256 test tokens); models and
 * side-effect services are mocked.
 */


process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
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
jest.mock('../models/BottleImage', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { logAudit } = require('../services/audit');
const bottlesRouter = require('./bottles');

const OWNER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const BOTTLE_ID = '64b0000000000000000000dd';

function request(method, url, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: url, method,
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${jwt.sign({ id: OWNER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function makeBottle(overrides = {}) {
  return {
    _id: BOTTLE_ID, cellar: CELLAR_ID, user: OWNER_ID, vintage: '2018', status: 'active',
    pours: [{ at: new Date('2026-07-28T19:00:00Z'), ml: 125 }],
    save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    populate: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    ...overrides,
  };
}

let bottle;
const serve = (doc) => { bottle = doc; Bottle.findById.mockResolvedValue(doc); };

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: null });
});

describe('PUT /api/bottles/:id/consumed-rating: the note', () => {
  const rate = (body) => request('PUT', `/api/bottles/${BOTTLE_ID}/consumed-rating`, body);
  const drunk = () => serve(makeBottle({ status: 'drank', consumedNote: 'Lovely with the lamb' }));

  test('a null note clears the note instead of failing', async () => {
    drunk();
    const { status } = await rate({ note: null });
    expect(status).toBe(200);
    expect(bottle.consumedNote).toBe('');
    expect(bottle.save).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a number', 5],
    ['an object', { $gt: '' }],
    ['a list', ['a', 'b']],
  ])('a note that is %s is refused with a 400 and nothing is saved', async (name, note) => {
    drunk();
    const { status, body } = await rate({ note });
    expect(status).toBe(400);
    expect(body.error).toBe('Note must be text');
    expect(bottle.consumedNote).toBe('Lovely with the lamb');
    expect(bottle.save).not.toHaveBeenCalled();
  });

  test('a text note is stored, and one over 1,000 characters keeps its own message', async () => {
    drunk();
    expect((await rate({ note: 'Better than I remembered' })).status).toBe(200);
    expect(bottle.consumedNote).toBe('Better than I remembered');

    drunk();
    const { status, body } = await rate({ note: 'x'.repeat(1001) });
    expect(status).toBe(400);
    expect(body.error).toBe('Note is too long (max 1000 characters)');
  });
});

describe('DELETE /api/bottles/:id/pour: two undos at once', () => {
  test('the undo that loses answers 409, is not audited, and is not reported as a server failure', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    serve(makeBottle({ save: jest.fn().mockRejectedValue(Object.assign(new Error('No matching document found'), { name: 'VersionError' })) }));
    const { status, body } = await request('DELETE', `/api/bottles/${BOTTLE_ID}/pour`);
    expect(status).toBe(409);
    expect(body.error).toMatch(/modified by another request/);
    expect(logAudit).not.toHaveBeenCalled();
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  test('any other failure is still a 500', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    serve(makeBottle({ save: jest.fn().mockRejectedValue(new Error('db down')) }));
    const { status, body } = await request('DELETE', `/api/bottles/${BOTTLE_ID}/pour`);
    expect(status).toBe(500);
    expect(body.error).toBe('Failed to undo pour');
    quiet.mockRestore();
  });
});
