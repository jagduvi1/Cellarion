/**
 * /api/admin/settings/contribution-review — the switch for reviewing what
 * members contribute (config/contributionReview).
 *
 * WHY THIS TEST EXISTS:
 * Turning review off publishes every member's contribution as it is made. On
 * a private server that is the point (discussion #1778); on cellarion.app it
 * would publish to a shared registry. So: where a super admin is configured,
 * only the super admin may switch it (any admin still sees it); on a server
 * without one, any admin may. Only a real true/false may change it, the new
 * state takes effect at once, and every change is audited.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/User', () => ({ findById: jest.fn(), exists: jest.fn().mockResolvedValue(true) }));
jest.mock('../../models/BottleImage', () => ({ countDocuments: jest.fn().mockResolvedValue(3) }));
jest.mock('../../models/RegistryDataValue', () => ({ countDocuments: jest.fn().mockResolvedValue(2) }));
jest.mock('../../models/RegistryDataKey', () => ({ countDocuments: jest.fn().mockResolvedValue(1) }));
jest.mock('../../models/WineCorrectionProposal', () => ({ countDocuments: jest.fn().mockResolvedValue(4) }));
jest.mock('../../utils/siteConfig', () => ({ updateSiteConfig: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const { logAudit } = require('../../services/audit');
const { updateSiteConfig } = require('../../utils/siteConfig');
const contributionReview = require('../../config/contributionReview');
const router = require('./settings');

const ADMIN_ID = '64b000000000000000000001';
const token = (roles) => jwt.sign({ id: ADMIN_ID, roles }, 'test-secret');
let email = 'admin@home.example';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/settings', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPER_ADMIN_EMAIL;
  delete process.env.SUPER_ADMIN_IPS;
  email = 'admin@home.example';
  contributionReview.set({ enabled: true });
  User.exists.mockResolvedValue(true);
  User.findById.mockImplementation(() => ({ select: () => ({ lean: async () => ({ email }) }) }));
  updateSiteConfig.mockResolvedValue({ updatedAt: new Date('2026-11-04T12:00:00Z') });
});
afterAll(() => { delete process.env.SUPER_ADMIN_EMAIL; contributionReview.set({ enabled: true }); });

const call = (method, body, roles = ['admin']) => fetch(`${baseUrl}/api/admin/settings/contribution-review`, {
  method,
  headers: { Authorization: `Bearer ${token(roles)}`, 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

test('GET: the switch, whether I may change it, and what is still waiting', async () => {
  const res = await call('GET');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    enabled: true, updatedAt: null, canChange: true, waiting: { photos: 3, values: 2, fields: 1, corrections: 4 },
  });
});

test('no super admin configured (a typical self-hosted server): an admin turns review off, at once, audited', async () => {
  const res = await call('PATCH', { enabled: false });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ enabled: false, updatedAt: '2026-11-04T12:00:00.000Z' });
  expect(updateSiteConfig).toHaveBeenCalledWith('contributionReview', { enabled: false }, ADMIN_ID);
  expect(contributionReview.isOn()).toBe(false);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.settings.contribution_review.update', {}, { enabled: false });
});

test('a super admin configured (cellarion.app): an ordinary admin sees it but may not change it', async () => {
  process.env.SUPER_ADMIN_EMAIL = 'owner@cellarion.example';
  const seen = await (await call('GET')).json();
  expect(seen.canChange).toBe(false);
  const res = await call('PATCH', { enabled: false });
  expect(res.status).toBe(403);
  expect(updateSiteConfig).not.toHaveBeenCalled();
  expect(contributionReview.isOn()).toBe(true);
});

test('…and the super admin may', async () => {
  process.env.SUPER_ADMIN_EMAIL = 'owner@cellarion.example';
  email = 'owner@cellarion.example';
  expect((await (await call('GET')).json()).canChange).toBe(true);
  expect((await call('PATCH', { enabled: false })).status).toBe(200);
  expect(contributionReview.isOn()).toBe(false);
});

test('only a real true/false; only admins', async () => {
  for (const enabled of ['false', 0, null, undefined]) {
    expect((await call('PATCH', { enabled })).status).toBe(400);
  }
  expect(updateSiteConfig).not.toHaveBeenCalled();
  expect((await call('GET', undefined, ['user'])).status).toBe(403);
  expect((await call('PATCH', { enabled: false }, ['user'])).status).toBe(403);
});
