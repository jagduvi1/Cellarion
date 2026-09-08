/**
 * /api/admin/bridge — the admin side of the Registry Bridge.
 *
 * Pins: admin-only gating; the keys payload the AdminBridge page renders
 * (owner join, today's and the window's spend, the distinct-wines figure,
 * admin-revocation fields); the readers table with its name joins and the
 * over-alert flag per reader kind; and revocation with a mandatory reason
 * that lands in the audit log and on the key.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/BridgeKey', () => ({ find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn(), REVOKE_REASON_MAX: 300 }));
jest.mock('../../models/BridgeUsageDay', () => ({ aggregate: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), RETENTION_DAYS: 90 }));
jest.mock('../../models/RegistryReadDay', () => ({ aggregate: jest.fn() }));
jest.mock('../../models/ApiToken', () => ({ find: jest.fn() }));
jest.mock('../../models/User', () => ({ findById: jest.fn(), find: jest.fn(), exists: jest.fn().mockResolvedValue(true) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const BridgeKey = require('../../models/BridgeKey');
const BridgeUsageDay = require('../../models/BridgeUsageDay');
const RegistryReadDay = require('../../models/RegistryReadDay');
const ApiToken = require('../../models/ApiToken');
const User = require('../../models/User');
const { logAudit } = require('../../services/audit');
const router = require('./bridge');

const ADMIN_ID = '64b000000000000000000001';
const USER_ID = '64b000000000000000000002';
const OWNER_ID = '64b000000000000000000003';
const K1 = '64c000000000000000000001';
const K2 = '64c000000000000000000002';
const T1 = '64d000000000000000000001';

const tokenFor = (id, roles) => jwt.sign({ id, roles }, 'test-secret');
const admin = () => tokenFor(ADMIN_ID, ['admin']);

/** A thenable query stub: every chained method returns the stub, awaiting yields `result`. */
function chain(result) {
  const q = {};
  for (const m of ['sort', 'limit', 'populate', 'select', 'lean']) q[m] = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/bridge', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  BridgeKey.find.mockImplementation(() => chain([]));
  BridgeUsageDay.aggregate.mockResolvedValue([]);
  RegistryReadDay.aggregate.mockResolvedValue([]);
  ApiToken.find.mockImplementation(() => chain([]));
  User.find.mockImplementation(() => chain([]));
});

const get = (path, auth) => fetch(`${baseUrl}/api/admin/bridge${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
const post = (path, auth, body) => fetch(`${baseUrl}/api/admin/bridge${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  body: JSON.stringify(body || {}),
});

const ACTIVE = {
  _id: K1, name: 'Home NAS', prefix: 'cbr_12345678', instanceHost: 'cellar.example.org', termsVersion: '2026-09',
  createdAt: new Date('2026-09-01T00:00:00Z'), lastUsedAt: new Date('2026-09-08T10:00:00Z'),
  importWindowUntil: null, revokedAt: null, revokedBy: null, revokedReason: null,
  user: { _id: OWNER_ID, username: 'nasowner', email: 'nas@example.org' },
};
const REVOKED = {
  _id: K2, name: 'Old box', prefix: 'cbr_87654321', instanceHost: null, termsVersion: '2026-09',
  createdAt: new Date('2026-08-01T00:00:00Z'), lastUsedAt: null, importWindowUntil: null,
  revokedAt: new Date('2026-09-07T00:00:00Z'), revokedBy: { _id: ADMIN_ID, username: 'johan' }, revokedReason: 'Read 4000 wines in a day',
  user: { _id: OWNER_ID, username: 'nasowner', email: 'nas@example.org' },
};

describe('gating', () => {
  test('every route is admin-only', async () => {
    expect((await get('/keys', null)).status).toBe(401);
    expect((await get('/keys', tokenFor(USER_ID, ['user']))).status).toBe(403);
    expect((await get('/readers', tokenFor(USER_ID, ['sommelier']))).status).toBe(403);
    expect((await post(`/keys/${K1}/revoke`, tokenFor(USER_ID, ['user']), { reason: 'because' })).status).toBe(403);
  });
});

describe('GET /keys', () => {
  test('joins owner, spend and distinct reads onto every key; revoked keys carry who and why', async () => {
    BridgeKey.find.mockImplementation(() => chain([ACTIVE, REVOKED]));
    BridgeUsageDay.aggregate.mockResolvedValue([
      { _id: K1, searches: 40, fetches: 12, changeChecks: 2, contributions: 1, today_searches: 5, today_fetches: 2, today_changeChecks: 0, today_contributions: 0, days: 3 },
    ]);
    RegistryReadDay.aggregate.mockResolvedValue([
      { _id: `key:${K1}`, kind: 'key', reads: 30, distinctMax: 12, distinctSum: 20, distinctToday: 2, days: 3, blockedDays: 0 },
    ]);

    const res = await get('/keys?days=7', admin());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(7);
    expect(body.caps).toMatchObject({ searches: 600, fetches: 300, changeChecks: 1, contributions: 50 });
    expect(body.alertDistinct).toBe(1000);
    expect(body.totals).toEqual({ active: 1, revoked: 1, usedInPeriod: 1, searches: 40, fetches: 12, contributions: 1 });

    const [k1, k2] = body.keys;
    expect(k1).toMatchObject({
      id: K1, name: 'Home NAS', prefix: 'cbr_12345678', instanceHost: 'cellar.example.org',
      owner: { id: OWNER_ID, username: 'nasowner', email: 'nas@example.org' },
      importWindow: { active: false, until: null },
      revokedAt: null, revokedBy: null, revokedReason: null,
      today: { searches: 5, fetches: 2, changeChecks: 0, contributions: 0, distinct: 2 },
      period: { searches: 40, fetches: 12, changeChecks: 2, contributions: 1, reads: 30, distinctMax: 12, activeDays: 3 },
    });
    expect(k2).toMatchObject({
      id: K2, name: 'Old box', revokedBy: 'johan', revokedReason: 'Read 4000 wines in a day',
      today: { searches: 0, fetches: 0, distinct: 0 },
      period: { fetches: 0, reads: 0, distinctMax: 0, activeDays: 0 },
    });
    expect(k2.revokedAt).toBe('2026-09-07T00:00:00.000Z');

    // The read counters are only asked about bridge keys here.
    const pipeline = RegistryReadDay.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({ kind: 'key' });
    // Active keys first, then the recently revoked; never the whole history.
    const filter = BridgeKey.find.mock.calls[0][0];
    expect(filter.$or[0]).toEqual({ revokedAt: null });
    expect(filter.$or[1].revokedAt.$gte).toBeInstanceOf(Date);
  });

  test('clamps the window to 1–90 days and defaults to 7', async () => {
    let body = await (await get('/keys?days=400', admin())).json();
    expect(body.days).toBe(90);
    body = await (await get('/keys?days=abc', admin())).json();
    expect(body.days).toBe(7);
    body = await (await get('/keys?days=0', admin())).json();
    expect(body.days).toBe(7);
  });
});

describe('GET /readers', () => {
  test('names keys, users and tokens, leaves addresses as they are, and flags each kind against its own alert level', async () => {
    RegistryReadDay.aggregate.mockResolvedValue([
      { _id: 'ip:203.0.113.9', kind: 'ip', reads: 900, distinctMax: 301, distinctSum: 301, distinctToday: 0, days: 1, blockedDays: 1 },
      { _id: `key:${K1}`, kind: 'key', reads: 30, distinctMax: 12, distinctSum: 20, distinctToday: 2, days: 3, blockedDays: 0 },
      { _id: `user:${OWNER_ID}`, kind: 'user', reads: 15, distinctMax: 9, distinctSum: 9, distinctToday: 9, days: 1, blockedDays: 0 },
      { _id: `token:${T1}`, kind: 'token', reads: 2000, distinctMax: 1200, distinctSum: 1500, distinctToday: 300, days: 2, blockedDays: 0 },
    ]);
    BridgeKey.find.mockImplementation(() => chain([{ _id: K1, name: 'Home NAS', instanceHost: 'cellar.example.org', user: { username: 'nasowner' }, revokedAt: null }]));
    User.find.mockImplementation(() => chain([{ _id: OWNER_ID, username: 'nasowner' }]));
    ApiToken.find.mockImplementation(() => chain([{ _id: T1, name: 'Claude desktop', user: { username: 'poweruser' } }]));

    const res = await get('/readers?days=7', admin());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thresholds).toEqual({ anonymousDailyDistinct: 300, memberAlertDistinct: 1000 });
    expect(body.readers).toEqual([
      expect.objectContaining({ readerKey: 'ip:203.0.113.9', kind: 'ip', label: null, owner: null, keyId: null, distinctMax: 301, blockedDays: 1, overAlert: true }),
      expect.objectContaining({ readerKey: `key:${K1}`, kind: 'key', label: 'Home NAS (cellar.example.org)', owner: 'nasowner', keyId: K1, revoked: false, overAlert: false }),
      expect.objectContaining({ readerKey: `user:${OWNER_ID}`, kind: 'user', label: 'nasowner', owner: 'nasowner', overAlert: false }),
      expect.objectContaining({ readerKey: `token:${T1}`, kind: 'token', label: 'Claude desktop', owner: 'poweruser', distinctMax: 1200, overAlert: true }),
    ]);
    // Only the ids that appeared are looked up, and only by id.
    expect(BridgeKey.find.mock.calls[0][0]).toEqual({ _id: { $in: [K1] } });
    expect(User.find.mock.calls[0][0]).toEqual({ _id: { $in: [OWNER_ID] } });
    expect(ApiToken.find.mock.calls[0][0]).toEqual({ _id: { $in: [T1] } });
  });

  test('a reader whose key or account is gone keeps its counters, unnamed', async () => {
    RegistryReadDay.aggregate.mockResolvedValue([
      { _id: `key:${K2}`, kind: 'key', reads: 5, distinctMax: 5, distinctSum: 5, distinctToday: 0, days: 1, blockedDays: 0 },
    ]);
    const body = await (await get('/readers', admin())).json();
    expect(body.readers[0]).toMatchObject({ readerKey: `key:${K2}`, label: null, owner: null, keyId: null, reads: 5 });
    expect(User.find).not.toHaveBeenCalled();
    expect(ApiToken.find).not.toHaveBeenCalled();
  });
});

describe('POST /keys/:id/revoke', () => {
  test('needs a reason of 3–300 characters and a valid id', async () => {
    let res = await post(`/keys/${K1}/revoke`, admin(), {});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('reason_required');
    res = await post(`/keys/${K1}/revoke`, admin(), { reason: 'no' });
    expect(res.status).toBe(400);
    res = await post(`/keys/${K1}/revoke`, admin(), { reason: 'x'.repeat(301) });
    expect(res.status).toBe(400);
    res = await post('/keys/not-an-id/revoke', admin(), { reason: 'because' });
    expect(res.status).toBe(400);
    expect(BridgeKey.findOne).not.toHaveBeenCalled();
  });

  test('404 when the key does not exist, 409 when it is already revoked', async () => {
    BridgeKey.findOne.mockResolvedValue(null);
    expect((await post(`/keys/${K1}/revoke`, admin(), { reason: 'because' })).status).toBe(404);
    BridgeKey.findOne.mockResolvedValue({ _id: K2, revokedAt: new Date(), save: jest.fn() });
    const res = await post(`/keys/${K2}/revoke`, admin(), { reason: 'because' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already_revoked');
  });

  test('revokes with who and why, and audits the reason against the key', async () => {
    const doc = { _id: K1, name: 'Home NAS', user: OWNER_ID, revokedAt: null, revokedBy: null, revokedReason: null, save: jest.fn().mockResolvedValue() };
    BridgeKey.findOne.mockResolvedValue(doc);
    const res = await post(`/keys/${K1}/revoke`, admin(), { reason: '  Read 4000 wines in a day  ' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(K1);
    expect(doc.save).toHaveBeenCalled();
    expect(doc.revokedAt).toBeInstanceOf(Date);
    expect(doc.revokedBy).toBe(ADMIN_ID);
    expect(doc.revokedReason).toBe('Read 4000 wines in a day');
    // The lookup is pinned to a plain string id.
    expect(BridgeKey.findOne).toHaveBeenCalledWith({ _id: { $eq: K1 } });
    const audit = logAudit.mock.calls.find((c) => c[1] === 'bridge.key.revoked_by_admin');
    expect(audit).toBeTruthy();
    expect(audit.slice(2)).toEqual([{ type: 'bridgeKey', id: K1 }, { name: 'Home NAS', owner: OWNER_ID, reason: 'Read 4000 wines in a day' }]);
  });
});
