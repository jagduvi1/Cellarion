/**
 * GET /api/cellars — API-token polls are answered from memory.
 *
 * WHY THIS TEST EXISTS:
 * The Home Assistant integration asks for the cellar list every few minutes
 * per install, and it runs on about one active user in four (usage check
 * 2026-10-09), so these reads grow with the users. A token request repeats
 * the stored answer while the user's data version holds. The version moves
 * on every audited cellar change for the actor and the owner; a MEMBER's list
 * changes without them acting, so the membership routes move the member's
 * version by hand — pinned here, because a missed bump is a list that lags
 * for up to the max age and no test would notice.
 */

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: req.headers['x-user'], roles: ['user'] };
    if (req.headers['x-token'] === '1') req.apiToken = { id: 'tok', scopes: ['read'] };
    next();
  },
  requireNonDemo: (req, res, next) => next(),
}));
jest.mock('../services/bottleSearch', () => ({ searchBottles: jest.fn(), bottleFacets: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({ createCellar: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/cellarTransfer', () => ({ transferCellarOwnership: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendCellarInviteEmail: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getSnapshotsForDates: jest.fn(), getOrCreateDailySnapshot: jest.fn(), convertCurrency: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/AuditLog', () => ({}));
jest.mock('../models/PendingShare', () => ({ findOne: jest.fn(), countDocuments: jest.fn(), create: jest.fn() }));
jest.mock('../models/ClimateDevice', () => ({ updateMany: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));

const express = require('express');
const http = require('http');
const Cellar = require('../models/Cellar');
const User = require('../models/User');
const { getDataVersion, bumpDataVersion } = require('../services/dataVersion');
const cellarsRouter = require('./cellars');

const OWNER = '64b000000000000000000001';
const MEMBER = '64b000000000000000000002';
const CELLAR_ID = '64b0000000000000000000c1';

let server, base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/cellars', cellarsRouter);
  server = http.createServer(app);
  server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

// A cellar document the way the list handler uses it: role lookup reads
// user/members, the colour lookup reads userColors, and toObject() is what
// is sent.
const cellarDoc = (name, user = OWNER, members = []) => ({
  _id: CELLAR_ID, name, user, members, userColors: [],
  toObject() { return { _id: CELLAR_ID, name, user, members: [...members], userColors: [] }; },
});
const listOf = (docs) => ({ sort: jest.fn(async () => docs) });

const tokenGet = (user) => fetch(`${base}/api/cellars`, { headers: { 'x-user': user, 'x-token': '1' } });
const browserGet = (user) => fetch(`${base}/api/cellars`, { headers: { 'x-user': user } });

test('an unchanged token poll is answered from memory — the list is not reloaded', async () => {
  Cellar.find.mockReturnValue(listOf([cellarDoc('Kallaren')]));
  const a = await (await tokenGet(OWNER)).json();
  const b = await (await tokenGet(OWNER)).json();
  expect(a.count).toBe(1);
  expect(a.cellars[0]).toMatchObject({ name: 'Kallaren', userRole: 'owner' });
  expect(b).toEqual(a);
  expect(Cellar.find).toHaveBeenCalledTimes(1);
});

test('a change (the data version moves) brings a fresh answer', async () => {
  const user = '64b000000000000000000011';
  Cellar.find.mockReturnValue(listOf([cellarDoc('One', user)]));
  await tokenGet(user);
  bumpDataVersion(user); // what logAudit does for every cellar.* change
  Cellar.find.mockReturnValue(listOf([cellarDoc('One', user), cellarDoc('Two', user)]));
  const b = await (await tokenGet(user)).json();
  expect(b.count).toBe(2);
  expect(Cellar.find).toHaveBeenCalledTimes(2);
});

test('another user never shares an answer', async () => {
  const a = '64b000000000000000000021';
  const b = '64b000000000000000000022';
  Cellar.find.mockReturnValue(listOf([cellarDoc('A', a)]));
  await tokenGet(a);
  Cellar.find.mockReturnValue(listOf([]));
  const got = await (await tokenGet(b)).json();
  expect(got.count).toBe(0);
  expect(Cellar.find).toHaveBeenCalledTimes(2);
});

test('browser requests (no API token) are never cached', async () => {
  const user = '64b000000000000000000031';
  Cellar.find.mockReturnValue(listOf([cellarDoc('A', user)]));
  await browserGet(user);
  await browserGet(user);
  expect(Cellar.find).toHaveBeenCalledTimes(2);
});

test('sharing a cellar with someone moves THEIR version — their next poll shows it', async () => {
  const member = '64b000000000000000000042';
  const before = getDataVersion(member);
  const cellar = { _id: CELLAR_ID, name: 'Shared', user: OWNER, members: [], save: jest.fn(async () => {}), populate: jest.fn(async () => {}) };
  Cellar.findOne.mockResolvedValue(cellar);
  User.findOne.mockResolvedValue({ _id: { toString: () => member }, email: 'm@example.test' });
  User.findById.mockReturnValue({ select: () => ({ lean: async () => ({ username: 'owner' }) }) });
  const r = await fetch(`${base}/api/cellars/${CELLAR_ID}/members`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user': OWNER },
    body: JSON.stringify({ email: 'm@example.test', role: 'viewer' }),
  });
  expect(r.status).toBe(201);
  expect(getDataVersion(member)).not.toBe(before);
});

test('removing a member moves their version too', async () => {
  const member = '64b000000000000000000052';
  const before = getDataVersion(member);
  const cellar = { _id: CELLAR_ID, user: { toString: () => OWNER }, members: [{ user: { toString: () => member }, role: 'viewer' }], save: jest.fn(async () => {}) };
  Cellar.findById.mockResolvedValue(cellar);
  require('../models/ClimateDevice').updateMany.mockResolvedValue({});
  const r = await fetch(`${base}/api/cellars/${CELLAR_ID}/members/${member}`, { method: 'DELETE', headers: { 'x-user': OWNER } });
  expect(r.status).toBe(200);
  expect(getDataVersion(member)).not.toBe(before);
});

test('renaming a cellar moves every member\'s version — their cached list shows the new name', async () => {
  const member = '64b000000000000000000062';
  const before = getDataVersion(member);
  const cellar = {
    _id: CELLAR_ID, name: 'Old', description: '', user: OWNER, members: [{ user: member, role: 'viewer' }], userColors: [],
    save: jest.fn(async () => {}),
    toObject() { return { _id: CELLAR_ID, name: this.name, user: OWNER, members: this.members, userColors: [] }; },
  };
  Cellar.findOne.mockResolvedValue(cellar);
  const r = await fetch(`${base}/api/cellars/${CELLAR_ID}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-user': OWNER },
    body: JSON.stringify({ name: 'New' }),
  });
  expect(r.status).toBe(200);
  expect(getDataVersion(member)).not.toBe(before);
});

test('changing the personal colour moves the actor\'s own version', async () => {
  const user = '64b000000000000000000072';
  const before = getDataVersion(user);
  const cellar = { _id: CELLAR_ID, user: OWNER, members: [{ user, role: 'viewer' }], userColors: [], deletedAt: null, save: jest.fn(async () => {}) };
  Cellar.findById.mockResolvedValue(cellar);
  const r = await fetch(`${base}/api/cellars/${CELLAR_ID}/color`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'x-user': user },
    body: JSON.stringify({ color: '#aabbcc' }),
  });
  expect(r.status).toBe(200);
  expect(getDataVersion(user)).not.toBe(before);
});
