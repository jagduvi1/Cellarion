/**
 * The price-tracking opt-in of a bottle:
 *   POST   /api/bottles/:id/request-price-tracking   ask for this wine + vintage
 *   DELETE /api/bottles/:id/request-price-tracking   withdraw the request
 *   GET    /api/bottles/:id/request-price-tracking   is it asked for, by me?
 *
 * One request document exists per wine + vintage and lists everyone who asked
 * (models/PriceTrackingRequest). What a sommelier's decline does to these
 * routes is pinned in bottles.priceTracking.declined.test.js; this suite pins
 * the rest: who may ask, how a second member joins the same request, what a
 * withdrawal leaves behind, and the status a bottle page reads.
 *
 * Real router with real requireAuth and requireBottleAccess (HS256 test
 * tokens); models and side-effect services are mocked, so no MongoDB.
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
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), exists: jest.fn(async () => null) }));
jest.mock('../models/Rack', () => ({ updateMany: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => {
  const M = jest.fn(function (doc) {
    Object.assign(this, doc);
    this.save = jest.fn().mockResolvedValue(this);
  });
  M.findOne = jest.fn();
  return M;
});
jest.mock('../models/PriceTrackingSkip', () => ({ findOne: jest.fn() }));
jest.mock('../models/BottleImage', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const { logAudit } = require('../services/audit');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const OTHER_ID = '64b000000000000000000002';
const CELLAR_ID = '64b0000000000000000000bb';
const BOTTLE_ID = '64b0000000000000000000dd';
const WINE_ID = '64b0000000000000000000ee';
const PATH = `/api/bottles/${BOTTLE_ID}/request-price-tracking`;
const FIRST = new Date('2026-01-10T08:00:00.000Z');

// Awaitable, and chainable through select() and lean(), to `result`.
const chain = (result) => ({
  select: jest.fn(function () { return this; }),
  lean: jest.fn(() => Promise.resolve(result)),
  then: (res, rej) => Promise.resolve(result).then(res, rej),
});

// A stored request, as the routes hold it: requesters with a user id each.
function stored(userIds, notes = {}) {
  return {
    wineDefinition: WINE_ID,
    vintage: '2018',
    requesters: userIds.map((id) => ({ user: { toString: () => id }, requestedAt: FIRST, note: notes[id] })),
    firstRequestedAt: FIRST,
    lastRequestedAt: FIRST,
    save: jest.fn().mockResolvedValue(undefined),
    deleteOne: jest.fn().mockResolvedValue(undefined),
  };
}

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const token = jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
const call = async (method, body) => {
  const res = await fetch(baseUrl + PATH, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
};

const bottle = (overrides = {}) => ({
  _id: BOTTLE_ID, cellar: CELLAR_ID, user: USER_ID, status: 'active', wineDefinition: WINE_ID, vintage: '2018', ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  Bottle.findById.mockResolvedValue(bottle());
  WineDefinition.exists.mockResolvedValue(null);
  PriceTrackingSkip.findOne.mockReturnValue(chain(null));
  PriceTrackingRequest.findOne.mockResolvedValue(null);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST request-price-tracking', () => {
  test.each([
    ['no vintage', { vintage: undefined }],
    ['a non-vintage wine', { vintage: 'NV' }],
    ['an unknown vintage', { vintage: 'Unknown' }],
    ['no wine', { wineDefinition: null }],
  ])('refuses a bottle with %s', async (_label, overrides) => {
    Bottle.findById.mockResolvedValue(bottle(overrides));
    const { status, body } = await call('POST');

    expect(status).toBe(400);
    expect(body.error).toBe('This wine cannot be price-tracked (missing wine definition or vintage).');
    expect(PriceTrackingRequest.findOne).not.toHaveBeenCalled();
  });

  test('refuses a wine that is still a private draft, before anything is looked up', async () => {
    WineDefinition.exists.mockResolvedValue({ _id: WINE_ID });
    const { status, body } = await call('POST');

    expect(status).toBe(400);
    expect(body.error).toMatch(/still a private draft/);
    expect(WineDefinition.exists).toHaveBeenCalledWith({ _id: WINE_ID, draft: true });
    expect(PriceTrackingSkip.findOne).not.toHaveBeenCalled();
    expect(PriceTrackingRequest.findOne).not.toHaveBeenCalled();
  });

  test('the first request creates the document with this member and their note, cut to 500 characters', async () => {
    const { status, body } = await call('POST', { note: `  ${'n'.repeat(600)}  ` });

    expect(status).toBe(200);
    expect(body.requested).toBe(true);
    expect(body.requesterCount).toBe(1);
    const [doc] = PriceTrackingRequest.mock.calls[0];
    expect(doc.wineDefinition).toBe(WINE_ID);
    expect(doc.vintage).toBe('2018');
    expect(doc.requesters).toHaveLength(1);
    expect(doc.requesters[0].user).toBe(USER_ID);
    expect(doc.requesters[0].note).toBe('n'.repeat(500));
    expect(doc.firstRequestedAt).toBe(doc.lastRequestedAt);
    expect(PriceTrackingRequest.mock.instances[0].save).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'price.track_requested', { type: 'wineDefinition', id: WINE_ID }, { vintage: '2018', bottleId: BOTTLE_ID },
    );
  });

  test('a note that is not a string is left out', async () => {
    await call('POST', { note: { $gt: '' } });

    expect(PriceTrackingRequest.mock.calls[0][0].requesters[0].note).toBeUndefined();
  });

  test('a second member joins the request that exists; the first date stays', async () => {
    const existing = stored([OTHER_ID]);
    PriceTrackingRequest.findOne.mockResolvedValue(existing);
    const { status, body } = await call('POST', { note: 'for the insurance list' });

    expect(status).toBe(200);
    expect(body).toEqual({ requested: true, requesterCount: 2, firstRequestedAt: FIRST.toISOString() });
    expect(PriceTrackingRequest).not.toHaveBeenCalled();
    expect(existing.requesters[1]).toMatchObject({ user: USER_ID, note: 'for the insurance list' });
    expect(existing.lastRequestedAt.getTime()).toBeGreaterThan(FIRST.getTime());
    expect(existing.save).toHaveBeenCalledTimes(1);
  });

  test('asking again updates the member\'s own row: a new note replaces the old, no note keeps it', async () => {
    const existing = stored([USER_ID], { [USER_ID]: 'first note' });
    PriceTrackingRequest.findOne.mockResolvedValue(existing);

    expect((await call('POST')).body.requesterCount).toBe(1);
    expect(existing.requesters[0].note).toBe('first note');
    expect(existing.requesters[0].requestedAt.getTime()).toBeGreaterThan(FIRST.getTime());

    await call('POST', { note: 'second note' });
    expect(existing.requesters).toHaveLength(1);
    expect(existing.requesters[0].note).toBe('second note');
  });

  test('two members creating the same request at once: the loser is told to retry', async () => {
    PriceTrackingRequest.mockImplementationOnce(function (doc) {
      Object.assign(this, doc);
      this.save = jest.fn().mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    });
    const { status, body } = await call('POST');

    expect(status).toBe(409);
    expect(body.error).toBe('Tracking request already exists — please retry.');
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('answers 500 when the save fails for another reason', async () => {
    PriceTrackingRequest.findOne.mockRejectedValue(new Error('db down'));
    const { status, body } = await call('POST');

    expect(status).toBe(500);
    expect(body.error).toBe('Failed to request price tracking');
  });
});

describe('DELETE request-price-tracking', () => {
  test('with no request for the pair there is nothing to withdraw', async () => {
    const { status, body } = await call('DELETE');

    expect(status).toBe(200);
    expect(body).toEqual({ requested: false, requesterCount: 0 });
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('the last requester leaving deletes the request, so the pair leaves the sommeliers\' queue', async () => {
    const existing = stored([USER_ID]);
    PriceTrackingRequest.findOne.mockResolvedValue(existing);
    const { status, body } = await call('DELETE');

    expect(status).toBe(200);
    expect(body).toEqual({ requested: false, requesterCount: 0 });
    expect(existing.deleteOne).toHaveBeenCalledTimes(1);
    expect(existing.save).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'price.track_cancelled', { type: 'wineDefinition', id: WINE_ID }, { vintage: '2018', bottleId: BOTTLE_ID },
    );
  });

  test('one of several leaving keeps the request for the others', async () => {
    const existing = stored([OTHER_ID, USER_ID]);
    PriceTrackingRequest.findOne.mockResolvedValue(existing);
    const { body } = await call('DELETE');

    expect(body).toEqual({ requested: false, requesterCount: 1 });
    expect(existing.requesters.map((r) => r.user.toString())).toEqual([OTHER_ID]);
    expect(existing.save).toHaveBeenCalledTimes(1);
    expect(existing.deleteOne).not.toHaveBeenCalled();
  });

  test('a member who never asked changes nothing', async () => {
    const existing = stored([OTHER_ID]);
    PriceTrackingRequest.findOne.mockResolvedValue(existing);
    const { body } = await call('DELETE');

    expect(body).toEqual({ requested: false, requesterCount: 1 });
    expect(existing.save).not.toHaveBeenCalled();
    expect(existing.deleteOne).not.toHaveBeenCalled();
  });

  test('answers 500 when the lookup fails', async () => {
    PriceTrackingRequest.findOne.mockRejectedValue(new Error('db down'));
    const { status, body } = await call('DELETE');

    expect(status).toBe(500);
    expect(body.error).toBe('Failed to cancel price tracking');
  });
});

describe('GET request-price-tracking', () => {
  test.each([
    ['no vintage', { vintage: undefined }],
    ['a non-vintage wine', { vintage: 'NV' }],
    ['an unknown vintage', { vintage: 'Unknown' }],
    ['no wine', { wineDefinition: null }],
  ])('a bottle with %s is not eligible, and nothing is looked up', async (_label, overrides) => {
    Bottle.findById.mockResolvedValue(bottle(overrides));
    const { status, body } = await call('GET');

    expect(status).toBe(200);
    expect(body).toEqual({ requested: false, requesterCount: 0, eligible: false });
    expect(PriceTrackingSkip.findOne).not.toHaveBeenCalled();
  });

  test('a request the member is part of', async () => {
    PriceTrackingRequest.findOne.mockReturnValue(chain(stored([OTHER_ID, USER_ID])));
    const { body } = await call('GET');

    expect(body).toEqual({ requested: true, requesterCount: 2, firstRequestedAt: FIRST.toISOString(), eligible: true });
  });

  test('a request by others only', async () => {
    PriceTrackingRequest.findOne.mockReturnValue(chain(stored([OTHER_ID])));
    const { body } = await call('GET');

    expect(body).toEqual({ requested: false, requesterCount: 1, firstRequestedAt: FIRST.toISOString(), eligible: true });
  });

  test('answers 500 when the lookup fails', async () => {
    PriceTrackingSkip.findOne.mockImplementation(() => { throw new Error('db down'); });
    const { status, body } = await call('GET');

    expect(status).toBe(500);
    expect(body.error).toBe('Failed to get tracking status');
  });
});
