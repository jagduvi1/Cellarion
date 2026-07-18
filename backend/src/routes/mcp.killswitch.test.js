/**
 * The MCP kill switches (config/rateLimits.js `mcp` group).
 *
 * Pins: enabled=0 shuts the personal endpoint (all three verbs) AND the public
 * endpoint with 503 before auth even runs; publicEnabled=0 shuts ONLY the
 * anonymous surface; the browser-facing activity route stays up either way
 * (the switch cuts AI protocol access, not the human's review tools); and the
 * default config leaves everything open.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../mcp/server', () => ({
  handleMcpRequest: jest.fn(async (req, res) => res.json({ handled: true })),
  initStatefulSession: jest.fn(async () => false),
}));
jest.mock('../mcp/sessions', () => ({ getSession: jest.fn(() => null) }));
jest.mock('../mcp/revert', () => ({
  revertLedgerRow: jest.fn(),
  reversibleActionsFor: jest.fn(() => ['consume', 'restore']),
}));
jest.mock('../services/bottleOps', () => ({ RESTORE_WINDOW_MS: 7 * 24 * 60 * 60 * 1000 }));
jest.mock('../services/exportLinks', () => ({ findLiveLink: jest.fn(), redeemExportLink: jest.fn() }));
jest.mock('../services/mcpOAuth', () => ({ issuer: () => 'http://localhost' }));
jest.mock('../models/McpActionLog', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/User', () => ({ exists: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const rateLimitsConfig = require('../config/rateLimits');
const McpActionLog = require('../models/McpActionLog');
const mcpRouter = require('./mcp');

const USER_ID = '64b000000000000000000001';
const userToken = () => jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', mcpRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

// Flip the in-memory config the way admin settings PATCH does, restore after.
const withMcpConfig = (mcp, fn) => async () => {
  const previous = rateLimitsConfig.get();
  rateLimitsConfig.set({ ...previous, mcp });
  try { await fn(); } finally { rateLimitsConfig.set(previous); }
};

const post = (path, auth) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
});

test('defaults leave every MCP surface open', async () => {
  expect(rateLimitsConfig.defaults.mcp).toEqual({ enabled: 1, publicEnabled: 1, userMax: 300, ipMax: 5000 });
  const res = await post('/api/mcp/public');
  expect(res.status).toBe(200);
  expect((await res.json()).handled).toBe(true);
});

test('enabled=0 shuts personal POST/GET/DELETE and public POST with 503', withMcpConfig({ enabled: 0, publicEnabled: 1 }, async () => {
  const personal = await post('/api/mcp', userToken());
  expect(personal.status).toBe(503);
  expect((await personal.json()).error).toMatch(/temporarily disabled/i);
  // Before auth: an unauthenticated caller sees the same 503, not a 401.
  expect((await post('/api/mcp')).status).toBe(503);
  expect((await fetch(`${baseUrl}/api/mcp`, { headers: { Authorization: `Bearer ${userToken()}` } })).status).toBe(503);
  expect((await fetch(`${baseUrl}/api/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${userToken()}` } })).status).toBe(503);
  expect((await post('/api/mcp/public')).status).toBe(503);
}));

test('publicEnabled=0 shuts only the anonymous surface', withMcpConfig({ enabled: 1, publicEnabled: 0 }, async () => {
  expect((await post('/api/mcp/public')).status).toBe(503);
  // Personal endpoint passes the gate and reaches the (mocked) MCP handler.
  const personal = await post('/api/mcp', userToken());
  expect(personal.status).toBe(200);
  expect((await personal.json()).handled).toBe(true);
}));

test('the activity timeline stays up while MCP is disabled', withMcpConfig({ enabled: 0, publicEnabled: 0 }, async () => {
  McpActionLog.find.mockReturnValue({
    sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }),
  });
  McpActionLog.countDocuments.mockResolvedValue(0);
  const res = await fetch(`${baseUrl}/api/mcp/activity`, { headers: { Authorization: `Bearer ${userToken()}` } });
  expect(res.status).toBe(200);
  expect((await res.json()).activity).toEqual([]);
}));
