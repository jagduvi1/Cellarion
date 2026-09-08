/**
 * /api/admin/settings/rate-limits — the registry lockdown and Registry
 * Bridge groups.
 *
 * Before this, `registryRead` (the distinct-wines-per-day cap) was declared
 * in config/rateLimits.js defaults but dropped by load() and unknown to the
 * PATCH handler: the one lockdown number had no lever. The bridge quotas were
 * constants. Both are now ordinary tunable groups: partial PATCH, bounded,
 * effective on the next request through the shared in-memory config and the
 * quota service that reads it.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/SiteConfig', () => ({ findOne: jest.fn() }));
jest.mock('../../utils/siteConfig', () => ({ updateSiteConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/User', () => ({ findById: jest.fn(), exists: jest.fn().mockResolvedValue(true) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const rateLimitsConfig = require('../../config/rateLimits');
const { updateSiteConfig } = require('../../utils/siteConfig');
const { capsNow, capFor } = require('../../services/bridgeQuota');
const { limits } = require('../../services/registryReadTracker');
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

test('GET exposes both groups with their defaults', async () => {
  const res = await fetch(`${baseUrl}/api/admin/settings/rate-limits`, { headers: { Authorization: `Bearer ${admin()}` } });
  const body = await res.json();
  expect(body.config.registryRead).toEqual({ anonymousDailyDistinct: 300, memberAlertDistinct: 1000 });
  expect(body.config.bridge).toEqual({ searches: 600, fetches: 300, changeChecks: 1, contributions: 50, burstPerMinute: 60 });
  expect(body.defaults.bridge.fetches).toBe(300);
});

test('a partial PATCH changes only the fields sent and reaches the tracker and the quota service', async () => {
  const res = await patch({ registryRead: { anonymousDailyDistinct: 500 }, bridge: { fetches: 1000, burstPerMinute: 120 } });
  expect(res.status).toBe(200);
  const { config } = await res.json();
  expect(config.registryRead).toEqual({ anonymousDailyDistinct: 500, memberAlertDistinct: 1000 });
  expect(config.bridge).toEqual({ searches: 600, fetches: 1000, changeChecks: 1, contributions: 50, burstPerMinute: 120 });
  // Untouched groups survive the wholesale set().
  expect(config.mcp).toEqual(rateLimitsConfig.defaults.mcp);
  expect(config.aiBurst).toEqual(rateLimitsConfig.defaults.aiBurst);
  // The persisted document is the same object.
  expect(updateSiteConfig).toHaveBeenCalledWith('rateLimits', expect.objectContaining({ bridge: config.bridge, registryRead: config.registryRead }), ADMIN_ID);
  // …and the consumers see it on their next call, no restart.
  expect(limits().anonymousDailyDistinct).toBe(500);
  expect(capsNow().fetches).toBe(1000);
  expect(capFor('fetches', {})).toBe(1000);
  expect(capFor('fetches', { importWindowUntil: new Date(Date.now() + 3600e3) })).toBe(5000);
  expect(capFor('searches', {})).toBe(600);
});

test('PATCHing other groups leaves the registry groups as they were', async () => {
  await patch({ bridge: { fetches: 1000 } });
  const res = await patch({ api: { max: 700 } });
  const { config } = await res.json();
  expect(config.api.max).toBe(700);
  expect(config.bridge.fetches).toBe(1000);
  expect(config.registryRead.anonymousDailyDistinct).toBe(300);
});

test('out-of-range values are refused with the field named, and nothing is written', async () => {
  for (const body of [
    { registryRead: { anonymousDailyDistinct: 5 } },
    { registryRead: { memberAlertDistinct: 10 } },
    { bridge: { changeChecks: 0 } },
    { bridge: { fetches: 5 } },
    { bridge: { burstPerMinute: 1 } },
    { bridge: { contributions: 'many' } },
  ]) {
    const res = await patch(body);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    const field = `${Object.keys(body)[0]}.${Object.keys(Object.values(body)[0])[0]}`;
    expect(error).toContain(field);
  }
  expect(updateSiteConfig).not.toHaveBeenCalled();
  expect(capsNow().fetches).toBe(300);
});
