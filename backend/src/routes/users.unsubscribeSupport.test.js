/**
 * GET /api/users/unsubscribe/support-replies — one click from the support-reply
 * email, no login: stop emailing answers to support tickets, and nothing else.
 *
 * WHY THIS TEST EXISTS:
 * The support-reply email only offered "unsubscribe from ALL Cellarion email"
 * as a link; turning off just these answers meant finding the setting by hand
 * (Johan, 2026-09-30). The scoped link must turn off exactly one flag, must not
 * accept an all-categories token, and must answer the same for a bad link.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'https://cellarion.test';

jest.mock('../models/User', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), indexWine: jest.fn(), removeWine: jest.fn(),
  bulkIndexWines: jest.fn(), bulkIndexBottles: jest.fn(), fullSync: jest.fn(),
  fullSyncBottles: jest.fn(), waitForTasks: jest.fn(), indexDiscussion: jest.fn(),
}));

const express = require('express');
const http = require('http');
const User = require('../models/User');
const { logAudit } = require('../services/audit');
const { createUnsubscribeToken, createScopedUnsubscribeToken } = require('../utils/unsubscribe');
const usersRouter = require('./users');

const USER = '64b000000000000000000001';

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/users', usersRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => { jest.clearAllMocks(); });

const hit = (token) => fetch(`${baseUrl}/api/users/unsubscribe/support-replies?token=${encodeURIComponent(token)}`, { redirect: 'manual' });

test('turns off only the support-reply email, audits it, and lands on the support-only confirmation', async () => {
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });

  const res = await hit(createScopedUnsubscribeToken(USER, 'supportReply'));

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('https://cellarion.test/unsubscribed?only=support');
  const [filter, update] = User.updateOne.mock.calls[0];
  expect(String(filter._id)).toBe(USER);
  expect(update).toEqual({ $set: { 'preferences.notifications.supportReply.email': false } });
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'user.unsubscribe.supportReply', { type: 'user', id: USER }, {});
});

test('a second click writes nothing new and audits nothing, but still confirms', async () => {
  User.updateOne.mockResolvedValue({ modifiedCount: 0 });

  const res = await hit(createScopedUnsubscribeToken(USER, 'supportReply'));

  expect(res.status).toBe(302);
  expect(logAudit).not.toHaveBeenCalled();
});

test('an all-categories token is refused here — it cannot be replayed as a support-only one', async () => {
  const res = await hit(createUnsubscribeToken(USER));
  expect(res.status).toBe(400);
  expect(User.updateOne).not.toHaveBeenCalled();
});

test('a forged or missing token is refused, nothing written', async () => {
  expect((await hit('not-a-token')).status).toBe(400);
  const res = await fetch(`${baseUrl}/api/users/unsubscribe/support-replies`, { redirect: 'manual' });
  expect(res.status).toBe(400);
  expect(User.updateOne).not.toHaveBeenCalled();
});

test('the all-categories route refuses a support-only token', async () => {
  const res = await fetch(`${baseUrl}/api/users/unsubscribe?token=${encodeURIComponent(createScopedUnsubscribeToken(USER, 'supportReply'))}`, { redirect: 'manual' });
  expect(res.status).toBe(400);
  expect(User.findById).not.toHaveBeenCalled();
});
