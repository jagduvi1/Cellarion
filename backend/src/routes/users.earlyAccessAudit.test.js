/**
 * PATCH /api/users/preferences — the audit row for "Try new features early".
 *
 * WHY THIS TEST EXISTS:
 * Early access decides which screens a member sees, so switching it is
 * logged. The row must mean a real switch: a form re-sending the value the
 * account already has writes nothing (release audit 2026-10-10), and the
 * other preferences stay unlogged as before.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/User', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/accountOps', () => ({ updatePreferences: jest.fn(), updateProfile: jest.fn() }));
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
const { updatePreferences } = require('../services/accountOps');
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

const patch = (body) => fetch(`${baseUrl}/api/users/preferences`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const stored = (earlyAccess) => User.findById.mockReturnValue({ select: () => ({ lean: async () => ({ preferences: { earlyAccess } }) }) });
const saved = (earlyAccess, changed) => updatePreferences.mockResolvedValue({
  user: { _id: USER, preferences: { earlyAccess }, toJSON: () => ({ id: USER, preferences: { earlyAccess } }) },
  changed,
});

test('a real switch is logged with its new value', async () => {
  stored(false);
  saved(true, ['preferences.earlyAccess']);
  const res = await patch({ earlyAccess: true });
  expect(res.status).toBe(200);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'user.early_access', { type: 'user', id: USER }, { on: true });
});

test('re-sending the value the account already has writes no row', async () => {
  stored(true);
  saved(true, ['preferences.earlyAccess']);
  expect((await patch({ earlyAccess: true })).status).toBe(200);
  expect(logAudit).not.toHaveBeenCalled();
});

test('another preference neither reads the account first nor logs', async () => {
  saved(false, ['preferences.currency']);
  expect((await patch({ currency: 'EUR' })).status).toBe(200);
  expect(User.findById).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});
