/**
 * /api/admin/settings/import-policy — the two switches for how an import
 * treats new wines (config/importPolicy).
 *
 * WHY THIS TEST EXISTS:
 * checkNewWines decides whether a member's file reaches the shared registry
 * unchecked, so it is changed by the same authority as the review switch:
 * where a super admin is configured only they may, elsewhere any admin. A
 * change sends one switch or both, only as a real true/false, takes effect at
 * once and is audited; the switch not sent keeps its value.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/User', () => ({ findById: jest.fn(), exists: jest.fn().mockResolvedValue(true) }));
jest.mock('../../models/WineDefinition', () => ({ countDocuments: jest.fn().mockResolvedValue(7) }));
jest.mock('../../utils/siteConfig', () => ({ updateSiteConfig: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const WineDefinition = require('../../models/WineDefinition');
const { logAudit } = require('../../services/audit');
const { updateSiteConfig } = require('../../utils/siteConfig');
const contributionReview = require('../../config/contributionReview');
const importPolicy = require('../../config/importPolicy');
const router = require('./settings');

const ADMIN_ID = '64b000000000000000000001';
const token = (roles) => jwt.sign({ id: ADMIN_ID, roles }, 'test-secret');
let email = 'admin@home.example';

let server; let baseUrl;
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
  importPolicy.set({});
  User.exists.mockResolvedValue(true);
  User.findById.mockImplementation(() => ({ select: () => ({ lean: async () => ({ email }) }) }));
  WineDefinition.countDocuments.mockResolvedValue(7);
  updateSiteConfig.mockResolvedValue({ updatedAt: new Date('2026-11-27T12:00:00Z') });
});
afterAll(() => { delete process.env.SUPER_ADMIN_EMAIL; contributionReview.set({ enabled: true }); importPolicy.set({}); });

const call = (method, body, roles = ['admin']) => fetch(`${baseUrl}/api/admin/settings/import-policy`, {
  method,
  headers: { Authorization: `Bearer ${token(roles)}`, 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

test('GET: the switches, whether I may change them, whether wines are in fact held back, and how many wait', async () => {
  const res = await call('GET');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    aiLookup: true, checkNewWines: false, updatedAt: null, canChange: true, reviewOn: true, checking: false, waiting: 7,
  });
  expect(WineDefinition.countDocuments).toHaveBeenCalledWith({ uncheckedIdentity: true, draft: { $ne: true }, nonWine: { $ne: true } });
});

test('GET says when the check is switched on but does nothing, because the server reviews no contributions', async () => {
  importPolicy.set({ checkNewWines: true });
  contributionReview.set({ enabled: false });
  expect(await (await call('GET')).json()).toMatchObject({ checkNewWines: true, reviewOn: false, checking: false });
});

test('one switch is changed at once and audited; the other keeps its value', async () => {
  const res = await call('PATCH', { aiLookup: false });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ aiLookup: false, checkNewWines: false, updatedAt: '2026-11-27T12:00:00.000Z' });
  expect(updateSiteConfig).toHaveBeenCalledWith('importPolicy', { aiLookup: false, checkNewWines: false }, ADMIN_ID);
  expect(importPolicy.usesAi()).toBe(false);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.settings.import_policy.update', {}, { aiLookup: false, checkNewWines: false });

  await call('PATCH', { checkNewWines: true });
  expect(updateSiteConfig).toHaveBeenLastCalledWith('importPolicy', { aiLookup: false, checkNewWines: true }, ADMIN_ID);
  expect(importPolicy.checksNewWines()).toBe(true);
  expect(importPolicy.usesAi()).toBe(false);
});

test('a super admin configured (cellarion.app): an ordinary admin sees the switches but may not change them', async () => {
  process.env.SUPER_ADMIN_EMAIL = 'owner@cellarion.example';
  expect((await (await call('GET')).json()).canChange).toBe(false);
  expect((await call('PATCH', { checkNewWines: true })).status).toBe(403);
  expect(updateSiteConfig).not.toHaveBeenCalled();
  expect(importPolicy.checksNewWines()).toBe(false);

  email = 'owner@cellarion.example';
  expect((await (await call('GET')).json()).canChange).toBe(true);
  expect((await call('PATCH', { checkNewWines: true })).status).toBe(200);
  expect(importPolicy.checksNewWines()).toBe(true);
});

test('only real true/false values, at least one of them; only admins', async () => {
  for (const body of [{}, { aiLookup: 'false' }, { checkNewWines: 1 }, { aiLookup: true, checkNewWines: null }, { other: true }]) {
    expect((await call('PATCH', body)).status).toBe(400);
  }
  expect(updateSiteConfig).not.toHaveBeenCalled();
  expect((await call('GET', undefined, ['user'])).status).toBe(403);
  expect((await call('PATCH', { aiLookup: false }, ['user'])).status).toBe(403);
});
