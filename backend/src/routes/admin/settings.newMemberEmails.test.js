/**
 * /api/admin/settings/new-member-emails — the admin switch for the one email a
 * new member gets two days after joining (services/newMemberEmails).
 *
 * WHY THIS TEST EXISTS:
 * The emails are off until an admin turns them on, and turning them on is the
 * moment that decides who can get one. Only a real true/false may change it,
 * only admins may reach it, and every change is audited.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/User', () => ({
  findById: jest.fn(),
  exists: jest.fn().mockResolvedValue(true),
  countDocuments: jest.fn(),
}));
jest.mock('../../services/newMemberEmails', () => ({
  getSettings: jest.fn(),
  setEnabled: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const { logAudit } = require('../../services/audit');
const { getSettings, setEnabled } = require('../../services/newMemberEmails');
const router = require('./settings');

const ADMIN_ID = '64b000000000000000000001';
const token = (roles) => jwt.sign({ id: ADMIN_ID, roles }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/settings', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => { jest.clearAllMocks(); User.exists.mockResolvedValue(true); });

const call = (method, body, roles = ['admin']) => fetch(`${baseUrl}/api/admin/settings/new-member-emails`, {
  method,
  headers: { Authorization: `Bearer ${token(roles)}`, 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

test('GET shows the switch, whether mail is set up, and what went out in 30 days', async () => {
  getSettings.mockResolvedValue({ enabled: true, since: new Date('2026-10-24T09:00:00Z') });
  User.countDocuments.mockImplementation(async (q) => (q.newMemberEmailKind === 'cellar' ? 7 : 4));

  const res = await call('GET');

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    enabled: true, since: '2026-10-24T09:00:00.000Z', mailConfigured: false, sentLast30Days: { cellar: 7, empty: 4 },
  });
});

test('PATCH turns it on and audits the change', async () => {
  setEnabled.mockResolvedValue({ enabled: true, since: new Date('2026-10-24T09:00:00Z') });

  const res = await call('PATCH', { enabled: true });

  expect(res.status).toBe(200);
  expect(setEnabled).toHaveBeenCalledWith(true, ADMIN_ID);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.settings.new_member_emails.update', {}, { enabled: true });
});

test.each([[{}], [{ enabled: 'yes' }], [{ enabled: 1 }]])('PATCH %j is refused and changes nothing', async (body) => {
  const res = await call('PATCH', body);
  expect(res.status).toBe(400);
  expect(setEnabled).not.toHaveBeenCalled();
});

test('a non-admin cannot read or change it', async () => {
  expect((await call('GET', undefined, ['user'])).status).toBe(403);
  expect((await call('PATCH', { enabled: true }, ['user'])).status).toBe(403);
  expect(setEnabled).not.toHaveBeenCalled();
});
