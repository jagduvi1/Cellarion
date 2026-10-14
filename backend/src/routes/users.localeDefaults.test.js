/**
 * POST /api/users/me/locale-defaults — the language and currency a new account
 * gets at its first sign-in.
 *
 * WHY THIS TEST EXISTS:
 * It is client-driven and writes preferences, so the update itself must be
 * one-shot (only while localeDefaultsPending is set, cleared in the same write)
 * and every value must pass the ordinary preferences validator.
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
beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockResolvedValue({ toJSON: () => ({ id: USER, preferences: { language: 'sv', currency: 'SEK' } }) });
});

const post = (body, auth = true) => fetch(`${baseUrl}/api/users/me/locale-defaults`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test('saves language + currency only while the first-sign-in flag is set, clearing it in the same update', async () => {
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });

  const res = await post({ language: 'sv', currency: 'sek' });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ applied: true, user: { preferences: { language: 'sv', currency: 'SEK' } } });
  const [filter, update] = User.updateOne.mock.calls[0];
  expect(filter).toEqual({ _id: USER, localeDefaultsPending: true });
  expect(update.$set).toEqual({ 'preferences.language': 'sv', 'preferences.currency': 'SEK' });
  expect(update.$unset).toEqual({ localeDefaultsPending: 1 });
});

test('answers applied:false when the flag is gone (older account, or already saved)', async () => {
  User.updateOne.mockResolvedValue({ modifiedCount: 0 });

  const res = await post({ language: 'sv', currency: 'SEK' });

  expect(await res.json()).toMatchObject({ applied: false });
});

test('skips a value the preferences validator refuses, keeps the valid one', async () => {
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });

  await post({ language: 'sv', currency: 'XYZ' });

  const [, update] = User.updateOne.mock.calls[0];
  expect(update.$set).toEqual({ 'preferences.language': 'sv' });
  expect(update.$unset).toEqual({ localeDefaultsPending: 1 });
});

test('with nothing valid it only clears the flag', async () => {
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });

  await post({ language: '<script>', currency: 42 });

  const [, update] = User.updateOne.mock.calls[0];
  expect(update).not.toHaveProperty('$set');
  expect(update.$unset).toEqual({ localeDefaultsPending: 1 });
});

test('requires a signed-in user', async () => {
  const res = await post({ language: 'sv' }, false);
  expect(res.status).toBe(401);
  expect(User.updateOne).not.toHaveBeenCalled();
});
