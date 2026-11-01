/**
 * /api/admin/settings/inactive-accounts — the admin switch for deleting
 * accounts nobody uses (services/inactiveAccounts).
 *
 * WHY THIS TEST EXISTS:
 * It deletes accounts, so it is off until an admin turns it on, the admin sees
 * what it would do today before doing so, only a real true/false may change it,
 * only admins may reach it, and every change is audited.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/User', () => ({
  findById: jest.fn(),
  exists: jest.fn().mockResolvedValue(true),
  countDocuments: jest.fn(),
}));
jest.mock('../../models/AuditLog', () => ({ countDocuments: jest.fn() }));
jest.mock('../../services/inactiveAccounts', () => ({
  getSettings: jest.fn(),
  setEnabled: jest.fn(),
  preview: jest.fn(),
  addMonths: (d, m) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + m); return x; },
  MONTHS_WITH_CONTENT: 24,
  MONTHS_EMPTY: 12,
  FIRST_NOTICE_DAYS: 30,
  FINAL_NOTICE_DAYS: 7,
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const { logAudit } = require('../../services/audit');
const { getSettings, setEnabled, preview } = require('../../services/inactiveAccounts');
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

const call = (method, body, roles = ['admin']) => fetch(`${baseUrl}/api/admin/settings/inactive-accounts`, {
  method,
  headers: { Authorization: `Bearer ${token(roles)}`, 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

test('GET shows the switch, the rule, the tracking start, what it would do today and the last 30 days', async () => {
  getSettings.mockResolvedValue({ enabled: false, since: null });
  preview.mockResolvedValue({
    counts: { first: 3, final: 1, wait: 2, 'skip:active': 40, 'skip:paying': 2, 'skip:staff': 1 },
    trackedSince: new Date('2026-11-01T00:00:00Z'),
  });
  AuditLog.countDocuments.mockImplementation(async (q) => {
    if (q.action === 'user.inactivity_deleted') return 1;
    return q['detail.notice'] === 'first' ? 5 : 2;
  });

  const res = await call('GET');

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    enabled: false,
    since: null,
    mailConfigured: false,
    rule: { monthsWithContent: 24, monthsEmpty: 12, firstNoticeDays: 30, finalNoticeDays: 7 },
    // Nobody counts as unused from before recording started: the earliest deletion is a year on.
    trackedSince: '2026-11-01T00:00:00.000Z',
    earliestDeletion: '2027-11-01T00:00:00.000Z',
    // Exempt counts the reasons an account can never be deleted, not the active ones.
    today: { first: 3, final: 1, delete: 0, waiting: 2, exempt: 3 },
    last30Days: { firstNotices: 5, finalNotices: 2, deleted: 1 },
  });
  // What the job did comes from its own audit rows.
  expect(AuditLog.countDocuments.mock.calls.map((c) => c[0].action).sort())
    .toEqual(['user.inactivity_deleted', 'user.inactivity_notice', 'user.inactivity_notice']);
});

test('PATCH turns it on and audits the change', async () => {
  setEnabled.mockResolvedValue({ enabled: true, since: new Date('2026-11-01T09:00:00Z') });

  const res = await call('PATCH', { enabled: true });

  expect(res.status).toBe(200);
  expect(setEnabled).toHaveBeenCalledWith(true, ADMIN_ID);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.settings.inactive_accounts.update', {}, { enabled: true });
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
