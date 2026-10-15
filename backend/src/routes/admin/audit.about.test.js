/**
 * GET /api/admin/audit — rows written before anyone is signed in.
 *
 * WHY THIS TEST EXISTS:
 * Sign-up, e-mail verification and sign-in are logged with no actor (nobody
 * is signed in yet); the account is the row's resource. The audit table showed
 * them as "—", as if anonymous. The route now names the account such a row is
 * about — and only that: a row with an actor, or about something else, is
 * left alone, and a deleted account (gone from users) gets no name.
 */
jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'b'.repeat(24), roles: ['admin'] }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../../models/AuditLog', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/User', () => ({ find: jest.fn() }));
jest.mock('../../services/securityAlertJob', () => ({ SECURITY_EVENT_ACTIONS: ['auth.login.failed'] }));

const express = require('express');
const http = require('http');
const AuditLog = require('../../models/AuditLog');
const User = require('../../models/User');
const router = require('./audit');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/admin/audit', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

const ALIVE = 'a'.repeat(24);
const GONE = 'c'.repeat(24);
const BOTTLE = 'd'.repeat(24);

beforeEach(() => {
  jest.clearAllMocks();
  const rows = [
    { _id: '1', action: 'auth.login.success', actor: { userId: null, role: 'anonymous' }, resource: { type: 'user', id: ALIVE } },
    { _id: '2', action: 'auth.register', actor: { userId: null, role: 'anonymous' }, resource: { type: 'user', id: GONE } },
    { _id: '3', action: 'bottle.add', actor: { userId: { _id: ALIVE, username: 'alice' }, role: 'user' }, resource: { type: 'bottle', id: BOTTLE } },
    { _id: '4', action: 'user.profile.update', actor: { userId: { _id: ALIVE, username: 'alice' }, role: 'user' }, resource: { type: 'user', id: ALIVE } },
    // A system job about alice, and a member since erased who followed her:
    // neither is a row "before sign-in", and neither may read as alice's.
    { _id: '5', action: 'bottle.trash_purge', actor: { userId: null, role: 'system' }, resource: { type: 'user', id: ALIVE } },
    { _id: '6', action: 'user.follow', actor: { userId: null, role: 'user' }, resource: { type: 'user', id: ALIVE } },
  ];
  const chain = { sort: () => chain, skip: () => chain, limit: () => chain, populate: () => chain, lean: async () => rows };
  AuditLog.find.mockReturnValue(chain);
  AuditLog.countDocuments.mockResolvedValue(rows.length);
  User.find.mockReturnValue({ lean: async () => [{ _id: ALIVE, username: 'alice' }] });
});

test('a row written before sign-in names the account it is about; others are left alone', async () => {
  const res = await fetch(`${baseUrl}/api/admin/audit`);
  expect(res.status).toBe(200);
  const { logs } = await res.json();
  const byId = Object.fromEntries(logs.map((l) => [l._id, l]));
  expect(byId['1'].about).toEqual({ username: 'alice' });
  // The account is gone (deleted): nothing to name.
  expect(byId['2'].about).toBeUndefined();
  // Rows with an actor carry the actor, not an "about".
  expect(byId['3'].about).toBeUndefined();
  expect(byId['4'].about).toBeUndefined();
  expect(byId['5'].about).toBeUndefined();
  expect(byId['6'].about).toBeUndefined();
  // One lookup, for the actor-less rows about a user only.
  expect(User.find).toHaveBeenCalledTimes(1);
  expect(User.find.mock.calls[0][0]).toEqual({ _id: { $in: [ALIVE, GONE] } });
});

test('filtering by a user also finds the rows about them written before sign-in', async () => {
  const res = await fetch(`${baseUrl}/api/admin/audit?userId=${ALIVE}`);
  expect(res.status).toBe(200);
  expect(AuditLog.find.mock.calls[0][0].$or).toEqual([
    { 'actor.userId': ALIVE },
    { 'resource.type': 'user', 'resource.id': ALIVE, 'actor.userId': null, 'actor.role': 'anonymous' },
  ]);
});
