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

jest.mock('../models/User', () => ({ findById: jest.fn(), findOneAndUpdate: jest.fn() }));
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
const { logAudit } = require('../services/audit');
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
const SAVED = { _id: USER, toJSON: () => ({ id: USER, preferences: { language: 'sv', currency: 'SEK' } }) };
const UNCHANGED = { _id: USER, toJSON: () => ({ id: USER, preferences: { language: 'en', currency: 'USD' } }) };

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockResolvedValue(UNCHANGED);
});

const post = (body, auth = true) => fetch(`${baseUrl}/api/users/me/locale-defaults`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test('saves language + currency only while the first-sign-in flag is set, clearing it in the same update', async () => {
  User.findOneAndUpdate.mockResolvedValue(SAVED);

  const res = await post({ language: 'sv', currency: 'sek' });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ applied: true, user: { preferences: { language: 'sv', currency: 'SEK' } } });
  const [filter, update, options] = User.findOneAndUpdate.mock.calls[0];
  expect(filter).toEqual({ _id: USER, localeDefaultsPending: true });
  expect(update.$set).toEqual({ 'preferences.language': 'sv', 'preferences.currency': 'SEK' });
  expect(update.$unset).toEqual({ localeDefaultsPending: 1 });
  expect(options).toEqual({ new: true });
  // One query when it applies, and the automatic change is on record.
  expect(User.findById).not.toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'user.locale_defaults',
    { type: 'user', id: USER }, { language: 'sv', currency: 'SEK', temperatureUnit: null });
});

test('the temperature unit the device guessed is saved and recorded with the rest', async () => {
  User.findOneAndUpdate.mockResolvedValue(SAVED);

  const res = await post({ language: 'en', currency: 'USD', temperatureUnit: 'f' });

  expect(res.status).toBe(200);
  const [, update] = User.findOneAndUpdate.mock.calls[0];
  expect(update.$set).toEqual({ 'preferences.language': 'en', 'preferences.currency': 'USD', 'preferences.temperatureUnit': 'F' });
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'user.locale_defaults',
    { type: 'user', id: USER }, { language: 'en', currency: 'USD', temperatureUnit: 'F' });
});

test('answers applied:false when the flag is gone (older account, or already saved) and records nothing', async () => {
  User.findOneAndUpdate.mockResolvedValue(null);

  const res = await post({ language: 'sv', currency: 'SEK' });

  expect(await res.json()).toMatchObject({ applied: false, user: { preferences: { language: 'en', currency: 'USD' } } });
  expect(logAudit).not.toHaveBeenCalled();
});

test('skips a value the preferences validator refuses, keeps the valid one', async () => {
  User.findOneAndUpdate.mockResolvedValue(SAVED);

  await post({ language: 'sv', currency: 'XYZ' });

  const [, update] = User.findOneAndUpdate.mock.calls[0];
  expect(update.$set).toEqual({ 'preferences.language': 'sv' });
  expect(update.$unset).toEqual({ localeDefaultsPending: 1 });
});

test('with nothing valid it only clears the flag', async () => {
  User.findOneAndUpdate.mockResolvedValue(SAVED);

  await post({ language: '<script>', currency: 42 });

  const [, update] = User.findOneAndUpdate.mock.calls[0];
  expect(update).not.toHaveProperty('$set');
  expect(update.$unset).toEqual({ localeDefaultsPending: 1 });
});

test('requires a signed-in user', async () => {
  const res = await post({ language: 'sv' }, false);
  expect(res.status).toBe(401);
  expect(User.findOneAndUpdate).not.toHaveBeenCalled();
});
