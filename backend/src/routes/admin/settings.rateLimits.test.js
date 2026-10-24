/**
 * /api/admin/settings/rate-limits — the chat group offers only settings that
 * something enforces.
 *
 * Chat answers in one non-streaming request, so there is no stream to cap
 * and no concurrent-streams setting: GET does not list one, PATCH ignores
 * one sent by an older client (200, not 400, so a page loaded before a
 * deploy can still save its other fields) and never stores it, and load()
 * drops one left in the stored document. chatBurst keeps its bounds.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/SiteConfig', () => ({ findOne: jest.fn() }));
jest.mock('../../utils/siteConfig', () => ({ updateSiteConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/User', () => ({ findById: jest.fn(), exists: jest.fn().mockResolvedValue(true) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const SiteConfig = require('../../models/SiteConfig');
const rateLimitsConfig = require('../../config/rateLimits');
const { updateSiteConfig } = require('../../utils/siteConfig');
const router = require('./settings');

const ADMIN_ID = '64b000000000000000000001';
const admin = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

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
  // The config is a module-level cache; start every test from the defaults.
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
});

const patch = (body) => fetch(`${baseUrl}/api/admin/settings/rate-limits`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin()}` },
  body: JSON.stringify(body),
});

test('GET lists the chat burst group and no concurrent-streams setting', async () => {
  const res = await fetch(`${baseUrl}/api/admin/settings/rate-limits`, { headers: { Authorization: `Bearer ${admin()}` } });
  const body = await res.json();
  expect(body.config.chatBurst).toEqual({ max: 5, windowMs: 60_000 });
  expect(body.config).not.toHaveProperty('chatConcurrentStreams');
  expect(body.defaults).not.toHaveProperty('chatConcurrentStreams');
});

test('a concurrent-streams value from an older client is ignored, and the rest of the save goes through', async () => {
  const res = await patch({ chatBurst: { max: 8, windowMs: 120_000 }, chatConcurrentStreams: { max: 3 } });
  expect(res.status).toBe(200);
  const { config } = await res.json();
  expect(config.chatBurst).toEqual({ max: 8, windowMs: 120_000 });
  expect(config).not.toHaveProperty('chatConcurrentStreams');
  expect(updateSiteConfig).toHaveBeenCalledTimes(1);
  expect(updateSiteConfig.mock.calls[0][1]).not.toHaveProperty('chatConcurrentStreams');
  expect(rateLimitsConfig.get()).not.toHaveProperty('chatConcurrentStreams');
});

test('an out-of-range concurrent-streams value is not a reason to refuse the save', async () => {
  const res = await patch({ chatBurst: { max: 6 }, chatConcurrentStreams: { max: 0 } });
  expect(res.status).toBe(200);
  expect((await res.json()).config.chatBurst).toEqual({ max: 6, windowMs: 60_000 });
});

test('chatBurst keeps its bounds', async () => {
  for (const body of [
    { chatBurst: { windowMs: 5_000 } },
    { chatBurst: { windowMs: 2 * 60 * 60 * 1000 } },
    { chatBurst: { max: 0 } },
  ]) {
    const res = await patch(body);
    expect(res.status).toBe(400);
    const field = `chatBurst.${Object.keys(body.chatBurst)[0]}`;
    expect((await res.json()).error).toContain(field);
  }
  expect(updateSiteConfig).not.toHaveBeenCalled();
});

test('load() drops a concurrent-streams value left in the stored document', async () => {
  SiteConfig.findOne.mockResolvedValue({
    value: { chatBurst: { max: 9, windowMs: 90_000 }, chatConcurrentStreams: { max: 7 } },
  });
  await rateLimitsConfig.load();
  expect(rateLimitsConfig.get().chatBurst).toEqual({ max: 9, windowMs: 90_000 });
  expect(rateLimitsConfig.get()).not.toHaveProperty('chatConcurrentStreams');
});
