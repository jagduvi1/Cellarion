/**
 * POST /api/users/me/signup-source — where a new single sign-on account came
 * from, sent once by the app when it returns from the provider.
 *
 * WHY THIS TEST EXISTS:
 * It is client-driven, so the update itself must refuse to overwrite a
 * recorded source or back-fill one onto an old (or demo) account.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/User', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), indexWine: jest.fn(), removeWine: jest.fn(),
  bulkIndexWines: jest.fn(), bulkIndexBottles: jest.fn(), fullSync: jest.fn(),
  fullSyncBottles: jest.fn(), waitForTasks: jest.fn(), indexDiscussion: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const usersRouter = require('./users');

const USER = '64b000000000000000000001';
const token = jwt.sign({ id: USER, roles: ['user'] }, 'test-secret', { algorithm: 'HS256' });

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
beforeEach(() => { jest.clearAllMocks(); });

const post = (body) => fetch(`${baseUrl}/api/users/me/signup-source`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

const leanUser = (doc) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });

test('records a sanitised source with the provider as the method, guarded in the update', async () => {
  User.findById.mockReturnValue(leanUser({ authProviders: [{ provider: 'google' }] }));
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });

  const res = await post({ signupSource: { referrerDomain: 'www.reddit.com', email: 'x@example.com' } });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ recorded: true });
  const [filter, update] = User.updateOne.mock.calls[0];
  expect(filter).toMatchObject({ _id: USER, signupSource: { $exists: false }, isDemo: { $ne: true } });
  expect(filter.createdAt.$gte).toBeInstanceOf(Date);
  expect(Date.now() - filter.createdAt.$gte.getTime()).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
  expect(update.$set.signupSource).toMatchObject({ referrerDomain: 'reddit.com', method: 'google' });
  expect(update.$set.signupSource).not.toHaveProperty('email');
});

test('answers recorded:false when the guard matched nothing (old account, or already recorded)', async () => {
  User.findById.mockReturnValue(leanUser({ authProviders: [] }));
  User.updateOne.mockResolvedValue({ modifiedCount: 0 });

  const res = await post({ signupSource: {} });

  expect(await res.json()).toEqual({ recorded: false });
});

test('rejects a payload that is not an object without touching the account', async () => {
  const res = await post({ signupSource: 'reddit' });

  expect(res.status).toBe(400);
  expect(User.updateOne).not.toHaveBeenCalled();
});

test('requires a signed-in user', async () => {
  const res = await fetch(`${baseUrl}/api/users/me/signup-source`, { method: 'POST' });
  expect(res.status).toBe(401);
});
