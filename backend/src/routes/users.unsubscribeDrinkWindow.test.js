/**
 * GET /api/users/unsubscribe/drink-window — one click from the drink-window
 * email, no login: stop emailing drink-window alerts, and nothing else.
 *
 * WHY THIS TEST EXISTS:
 * Drink-window emails start on for new accounts, so every one carries a way to
 * stop just these (the bell keeps the alerts). The link must turn off exactly
 * one flag, must not accept an all-categories token or another scope's token,
 * and must answer the same for a bad link.
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

const hit = (token) => fetch(`${baseUrl}/api/users/unsubscribe/drink-window?token=${encodeURIComponent(token)}`, { redirect: 'manual' });

test('turns off only the drink-window email, audits it, and lands on the drink-window confirmation', async () => {
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });

  const res = await hit(createScopedUnsubscribeToken(USER, 'drinkWindow'));

  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('https://cellarion.test/unsubscribed?only=drink-window');
  const [filter, update] = User.updateOne.mock.calls[0];
  expect(String(filter._id)).toBe(USER);
  expect(filter['preferences.notifications.drinkWindow.email']).toEqual({ $ne: false });
  expect(update).toEqual({ $set: { 'preferences.notifications.drinkWindow.email': false } });
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'user.unsubscribe.drinkWindow', { type: 'user', id: USER }, {});
});

test('a second click writes nothing new and audits nothing, but still confirms', async () => {
  User.updateOne.mockResolvedValue({ modifiedCount: 0 });

  const res = await hit(createScopedUnsubscribeToken(USER, 'drinkWindow'));

  expect(res.status).toBe(302);
  expect(logAudit).not.toHaveBeenCalled();
});

test('refuses an all-categories token, a support-reply token and garbage, writing nothing', async () => {
  for (const token of [createUnsubscribeToken(USER), createScopedUnsubscribeToken(USER, 'supportReply'), 'garbage']) {
    const res = await hit(token);
    expect(res.status).toBe(400);
  }
  expect(User.updateOne).not.toHaveBeenCalled();
});
