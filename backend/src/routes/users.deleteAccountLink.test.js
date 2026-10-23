/**
 * "Delete my account" from an email link — POST /api/users/delete-account/preview
 * and POST /api/users/delete-account (no login), plus DELETE /api/users/me,
 * which now shares the same scheduling code (services/accountDeletion).
 *
 * WHY THIS TEST EXISTS:
 * The emails to new members carry a "Not for you? Delete your account" link.
 * Only a button press on the page it opens may schedule the deletion, the
 * deletion must be the same 7-day one Settings uses, and a bad, expired or
 * borrowed (unsubscribe) token must change nothing and reveal nothing.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'https://cellarion.test';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), indexWine: jest.fn(), removeWine: jest.fn(),
  bulkIndexWines: jest.fn(), bulkIndexBottles: jest.fn(), fullSync: jest.fn(),
  fullSyncBottles: jest.fn(), waitForTasks: jest.fn(), indexDiscussion: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  requireAuth: (req, res, next) => { req.user = { id: '64b000000000000000000001' }; next(); },
  requireNonDemo: (req, res, next) => next(),
}));

const express = require('express');
const http = require('http');
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const PendingShare = require('../models/PendingShare');
const { logAudit } = require('../services/audit');
const { createDeleteAccountToken } = require('../utils/accountDeletionLink');
const { createUnsubscribeToken } = require('../utils/unsubscribe');
const usersRouter = require('./users');

const USER = '64b000000000000000000001';
const DAY = 24 * 60 * 60 * 1000;

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

// A stand-in for a User document: just the fields the routes read and write.
function fakeUser(overrides = {}) {
  return {
    _id: USER, username: 'newbie', isDemo: false, deletionScheduledFor: null,
    stripeSubscriptionId: null, plan: 'free', sessions: [{ hash: 'x' }],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
// findById(...) is awaited directly (confirm) or after .select(...) (preview).
function findByIdReturns(user) {
  const result = Promise.resolve(user);
  result.select = jest.fn(() => Promise.resolve(user));
  return jest.spyOn(User, 'findById').mockReturnValue(result);
}

const post = (path, body) => fetch(`${baseUrl}/api/users${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('preview', () => {
  test('names the account and what is in it', async () => {
    findByIdReturns(fakeUser({ stripeSubscriptionId: 'sub_1' }));
    const distinct = jest.spyOn(Cellar, 'distinct').mockResolvedValue(['c1', 'c2']);
    const count = jest.spyOn(Bottle, 'countDocuments').mockResolvedValue(23);

    const res = await post('/delete-account/preview', { token: createDeleteAccountToken(USER) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: 'newbie', bottles: 23, supporter: true, deletionScheduledFor: null });
    // Only live cellars, and only bottles still in them (or on order).
    expect(distinct).toHaveBeenCalledWith('_id', { user: USER, deletedAt: null });
    expect(count).toHaveBeenCalledWith({ cellar: { $in: ['c1', 'c2'] }, status: { $in: ['active', 'ordered'] } });
  });

  test('an account with no cellar reads as empty without counting bottles', async () => {
    findByIdReturns(fakeUser());
    jest.spyOn(Cellar, 'distinct').mockResolvedValue([]);
    const count = jest.spyOn(Bottle, 'countDocuments');

    const res = await post('/delete-account/preview', { token: createDeleteAccountToken(USER) });

    expect(await res.json()).toMatchObject({ bottles: 0, supporter: false });
    expect(count).not.toHaveBeenCalled();
  });

  test('a bad, missing or unsubscribe token is refused before any lookup', async () => {
    const find = jest.spyOn(User, 'findById');
    for (const body of [{ token: 'nope' }, {}, { token: createUnsubscribeToken(USER) }]) {
      const res = await post('/delete-account/preview', body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('LINK_INVALID');
    }
    expect(find).not.toHaveBeenCalled();
  });

  test('a deleted account and a demo account answer exactly like a bad link', async () => {
    for (const user of [null, fakeUser({ isDemo: true })]) {
      findByIdReturns(user);
      const res = await post('/delete-account/preview', { token: createDeleteAccountToken(USER) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'This link is no longer valid.', code: 'LINK_INVALID' });
    }
  });
});

describe('confirm', () => {
  test('schedules the same 7-day deletion as Settings and records that it came from the link', async () => {
    const user = fakeUser();
    findByIdReturns(user);
    const invites = jest.spyOn(PendingShare, 'deleteMany').mockResolvedValue({});
    const before = Date.now();

    const res = await post('/delete-account', { token: createDeleteAccountToken(USER) });

    expect(res.status).toBe(200);
    const { deletionScheduledFor } = await res.json();
    const when = new Date(deletionScheduledFor).getTime();
    expect(when).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(when).toBeLessThan(Date.now() + 7 * DAY + 1000);
    expect(user.deletionScheduledFor).toBeInstanceOf(Date);
    expect(user.sessions).toEqual([]); // every device signed out
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(invites).toHaveBeenCalledWith({ invitedBy: USER });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'user.deletion_requested', { type: 'user', id: USER }, { via: 'email-link' });
  });

  test('pressing it again on a scheduled account changes nothing', async () => {
    const scheduled = new Date('2026-11-01T00:00:00Z');
    const user = fakeUser({ deletionScheduledFor: scheduled });
    findByIdReturns(user);

    const res = await post('/delete-account', { token: createDeleteAccountToken(USER) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deletionScheduledFor: scheduled.toISOString(), alreadyScheduled: true });
    expect(user.save).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a bad or unsubscribe token schedules nothing', async () => {
    const find = jest.spyOn(User, 'findById');
    for (const body of [{ token: 'nope' }, { token: createUnsubscribeToken(USER) }]) {
      expect((await post('/delete-account', body)).status).toBe(400);
    }
    expect(find).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a demo account cannot be scheduled through a link', async () => {
    const user = fakeUser({ isDemo: true });
    findByIdReturns(user);
    expect((await post('/delete-account', { token: createDeleteAccountToken(USER) })).status).toBe(400);
    expect(user.save).not.toHaveBeenCalled();
  });
});

describe('DELETE /me (Settings) after the move into services/accountDeletion', () => {
  test('still schedules the deletion with the same answer and audit row', async () => {
    const user = fakeUser();
    findByIdReturns(user);
    jest.spyOn(PendingShare, 'deleteMany').mockResolvedValue({});

    const res = await fetch(`${baseUrl}/api/users/me`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/permanently deleted in 7 days/);
    expect(new Date(body.deletionScheduledFor).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(user.sessions).toEqual([]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'user.deletion_requested', { type: 'user', id: USER }, {});
  });

  test('refuses a second request while one is scheduled', async () => {
    findByIdReturns(fakeUser({ deletionScheduledFor: new Date() }));
    const res = await fetch(`${baseUrl}/api/users/me`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });
});
