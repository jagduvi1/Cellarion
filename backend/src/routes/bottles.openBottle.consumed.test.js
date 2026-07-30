/**
 * DELETE /api/bottles/:id/open and DELETE /api/bottles/:id/pour must refuse a
 * CONSUMED bottle.
 *
 * WHY THIS TEST EXISTS (security audit 2026-07-30, M-1):
 * A consumed bottle deliberately KEEPS openedAt / preservationMethod / pours —
 * they are drinking history on the consumption record, not current state. PR
 * #866 added that guard to the three MCP tools one at a time and left the REST
 * twins with none, so any cellar EDITOR could silently destroy the owner's
 * consumption record: no error, no MCP ledger row, nothing to undo.
 *
 * The `/open` guard lives in services/bottleOps.closeBottle so both surfaces
 * inherit one implementation; `/pour` is an inline handler and carries its own.
 * Both halves are asserted here, together with the active-bottle happy paths
 * that prove the guard is not over-broad.
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
const EDITOR_ID = '64b000000000000000000003';
const CELLAR_ID = '64b0000000000000000000bb';
const BOTTLE_ID = '64b0000000000000000000dd';

const OPENED_AT = new Date('2026-07-28T19:00:00Z');
const POURS = [{ at: OPENED_AT, ml: 125 }, { at: OPENED_AT, ml: 150 }];

function request(method, url, userId = OWNER_ID) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method,
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${jwt.sign({ id: userId, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

const closeOpen = (userId) => request('DELETE', `/api/bottles/${BOTTLE_ID}/open`, userId);
const undoPour  = (userId) => request('DELETE', `/api/bottles/${BOTTLE_ID}/pour`, userId);

/** A bottle carrying open-bottle state — consumed or not, the fields are there. */
function makeBottle(overrides = {}) {
  return {
    _id: BOTTLE_ID,
    cellar: CELLAR_ID,
    user: OWNER_ID,
    vintage: '2018',
    status: 'active',
    openedAt: OPENED_AT,
    preservationMethod: 'vacuum',
    pours: POURS.map((p) => ({ ...p })),
    openBottleNotifiedAt: null,
    save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    populate: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    ...overrides,
  };
}

/** Every field the guard exists to protect, unchanged. */
function expectHistoryIntact(bottle) {
  expect(bottle.openedAt).toEqual(OPENED_AT);
  expect(bottle.preservationMethod).toBe('vacuum');
  expect(bottle.pours).toEqual(POURS);
  expect(bottle.save).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  // The editor is a MEMBER, not the owner — the role that made this exploitable:
  // an editor could destroy the owner's consumption record.
  Cellar.findById.mockResolvedValue({
    _id: CELLAR_ID, name: 'Main', user: OWNER_ID, deletedAt: null,
    members: [{ user: EDITOR_ID, role: 'editor', addedAt: new Date() }],
  });
});

describe('DELETE /api/bottles/:id/open on a consumed bottle', () => {
  test.each(['drank', 'gifted', 'sold', 'other'])(
    'refuses a %s bottle with 409 and destroys nothing', async (status) => {
      const bottle = makeBottle({ status, consumedAt: new Date(), consumedReason: status });
      Bottle.findById.mockResolvedValue(bottle);

      const res = await closeOpen();

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already consumed/i);
      expectHistoryIntact(bottle);
      expect(logAudit).not.toHaveBeenCalled();
    }
  );

  test('an EDITOR (not the owner) is refused too — the record belongs to the consume', async () => {
    const bottle = makeBottle({ status: 'drank', consumedAt: new Date(), consumedReason: 'drank' });
    Bottle.findById.mockResolvedValue(bottle);

    const res = await closeOpen(EDITOR_ID);

    expect(res.status).toBe(409);
    expectHistoryIntact(bottle);
  });

  test('still closes an ACTIVE open bottle — the guard is not over-broad', async () => {
    const bottle = makeBottle();
    Bottle.findById.mockResolvedValue(bottle);

    const res = await closeOpen();

    expect(res.status).toBe(200);
    expect(bottle.openedAt).toBeNull();
    expect(bottle.pours).toEqual([]);
    expect(bottle.save).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/bottles/:id/pour on a consumed bottle', () => {
  test.each(['drank', 'gifted', 'sold', 'other'])(
    'refuses a %s bottle with 409 and pops nothing', async (status) => {
      const bottle = makeBottle({ status, consumedAt: new Date(), consumedReason: status });
      Bottle.findById.mockResolvedValue(bottle);

      const res = await undoPour();

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already consumed/i);
      expectHistoryIntact(bottle);
      expect(logAudit).not.toHaveBeenCalled();
    }
  );

  test('consumed is checked BEFORE "no pours to undo" — the message names the real reason', async () => {
    const bottle = makeBottle({ status: 'drank', pours: [], consumedAt: new Date() });
    Bottle.findById.mockResolvedValue(bottle);

    const res = await undoPour();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already consumed/i);
  });

  test('still undoes the last pour on an ACTIVE bottle — the guard is not over-broad', async () => {
    const bottle = makeBottle();
    Bottle.findById.mockResolvedValue(bottle);

    const res = await undoPour();

    expect(res.status).toBe(200);
    expect(bottle.pours).toEqual([POURS[0]]);
    expect(bottle.save).toHaveBeenCalledTimes(1);
  });
});
