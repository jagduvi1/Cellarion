/**
 * GET /api/admin/mcp/usage — the admin MCP overview endpoint.
 *
 * Pins: admin-only gating, the response shape the AdminMcp page renders
 * (daily series, top tools, connection split, kill-switch state), and the
 * clamping of the ?days window.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/McpUsageStat', () => ({ aggregate: jest.fn() }));
jest.mock('../../models/McpActionLog', () => ({ countDocuments: jest.fn(), NON_ACTIVITY_ACTIONS: ['bulk_preview', 'arrange_preview', 'pending'] }));
jest.mock('../../models/ApiToken', () => ({ aggregate: jest.fn() }));
jest.mock('../../models/User', () => ({ findById: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const McpUsageStat = require('../../models/McpUsageStat');
const McpActionLog = require('../../models/McpActionLog');
const ApiToken = require('../../models/ApiToken');
const rateLimitsConfig = require('../../config/rateLimits');
const adminMcpRouter = require('./mcp');

const ADMIN_ID = '64b000000000000000000001';
const USER_ID = '64b000000000000000000002';

const tokenFor = (id, roles) => jwt.sign({ id, roles }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/mcp', adminMcpRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  McpUsageStat.aggregate.mockResolvedValue([]);
  ApiToken.aggregate.mockResolvedValue([]);
  McpActionLog.countDocuments.mockResolvedValue(0);
});

const getUsage = (auth, qs = '') => fetch(`${baseUrl}/api/admin/mcp/usage${qs}`, {
  headers: auth ? { Authorization: `Bearer ${auth}` } : {},
});

test('rejects unauthenticated and non-admin callers', async () => {
  expect((await getUsage(null)).status).toBe(401);
  expect((await getUsage(tokenFor(USER_ID, ['user']))).status).toBe(403);
});

test('returns the overview shape with empty data', async () => {
  const res = await getUsage(tokenFor(ADMIN_ID, ['admin']));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.days).toBe(30);
  expect(body.daily).toEqual([]);
  expect(body.topTools).toEqual([]);
  expect(body.connections).toEqual({
    bearer: { total: 0, activeLast7d: 0 },
    oauth: { total: 0, activeLast7d: 0 },
  });
  expect(body.writesLast7d).toBe(0);
  // Kill-switch state rides along for the toggles.
  expect(body.mcpConfig).toEqual(rateLimitsConfig.get().mcp);
});

test('maps aggregates into the daily series, top tools and connection split', async () => {
  const day = new Date('2026-07-15T00:00:00Z');
  McpUsageStat.aggregate
    .mockResolvedValueOnce([
      { _id: { day, surface: 'personal' }, calls: 41, errors: 2 },
      { _id: { day, surface: 'public' }, calls: 7, errors: 0 },
    ])
    .mockResolvedValueOnce([
      { _id: { name: 'search_bottles', surface: 'personal' }, calls: 20, errors: 1 },
    ]);
  ApiToken.aggregate.mockResolvedValue([
    { _id: 'bearer', total: 3, activeLast7d: 2 },
    { _id: 'oauth', total: 5, activeLast7d: 4 },
  ]);
  McpActionLog.countDocuments.mockResolvedValue(12);

  const body = await (await getUsage(tokenFor(ADMIN_ID, ['admin']))).json();
  expect(body.daily).toEqual([
    { day: day.toISOString(), surface: 'personal', calls: 41, errors: 2 },
    { day: day.toISOString(), surface: 'public', calls: 7, errors: 0 },
  ]);
  expect(body.topTools).toEqual([
    { name: 'search_bottles', surface: 'personal', calls: 20, errors: 1 },
  ]);
  expect(body.connections).toEqual({
    bearer: { total: 3, activeLast7d: 2 },
    oauth: { total: 5, activeLast7d: 4 },
  });
  expect(body.writesLast7d).toBe(12);
});

test('clamps the days window to 1..90', async () => {
  let body = await (await getUsage(tokenFor(ADMIN_ID, ['admin']), '?days=500')).json();
  expect(body.days).toBe(90);
  body = await (await getUsage(tokenFor(ADMIN_ID, ['admin']), '?days=-3')).json();
  expect(body.days).toBe(1);
  body = await (await getUsage(tokenFor(ADMIN_ID, ['admin']), '?days=abc')).json();
  expect(body.days).toBe(30);
});
