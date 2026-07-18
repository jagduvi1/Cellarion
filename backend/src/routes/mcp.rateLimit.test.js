/**
 * Dedicated MCP protocol-endpoint rate limits (MCP-audit M8).
 *
 * Hosted AI connectors (claude.ai, ChatGPT) egress from a small shared IP
 * pool, so the old setup — /api/mcp under the global per-IP apiLimiter — made
 * every hosted user share one 15-minute bucket. These tests pin the fix:
 *   - the per-USER limiter is keyed by verified identity, so one user's burst
 *     429s only that user, across DIFFERENT source IPs (shared egress must
 *     not pool strangers, and IP-hopping must not reset the budget);
 *   - the pre-auth per-IP limiter bounds unauthenticated flood/probing;
 *   - the kill switch outranks both (503 without consuming any bucket);
 *   - a stored config missing the new fields falls back to defaults instead
 *     of crashing or going unlimited.
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
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/User', () => ({ exists: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const rateLimitsConfig = require('../config/rateLimits');
const { logAudit } = require('../services/audit');
const mcpRouter = require('./mcp');

const token = (id) => jwt.sign({ id, roles: ['user'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  // Honour X-Forwarded-For so each test controls the source IP the limiter
  // keys on — that's how "same user, different IPs" is driven below.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/mcp', mcpRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

// Flip the in-memory config the way admin settings PATCH does, restore after.
const withMcpConfig = (mcp, fn) => async () => {
  const previous = rateLimitsConfig.get();
  rateLimitsConfig.set({ ...previous, mcp });
  try { await fn(); } finally { rateLimitsConfig.set(previous); }
};

const post = (ip, auth) => fetch(`${baseUrl}/api/mcp`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Forwarded-For': ip,
    ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
});

test('per-user limit: one user 429s across DIFFERENT IPs; another user on a SHARED IP is untouched',
  withMcpConfig({ enabled: 1, publicEnabled: 1, userMax: 2, ipMax: 5000 }, async () => {
    const chatty = token('64b0000000000000000000aa');
    // Two allowed requests from two different egress IPs — one identity, one bucket.
    expect((await post('20.0.0.1', chatty)).status).toBe(200);
    expect((await post('20.0.0.2', chatty)).status).toBe(200);
    // Third request 429s even from a THIRD ip — rotating IPs must not reset it.
    const blocked = await post('20.0.0.3', chatty);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toMatch(/this account/i);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'system.rate_limit_exceeded', {},
      { limiter: 'mcp_user', limit: 2 });
    // A DIFFERENT user calling from an IP the first user already used (the
    // shared-egress scenario) still has their full own allowance.
    const other = token('64b0000000000000000000bb');
    expect((await post('20.0.0.1', other)).status).toBe(200);
  }));

test('pre-auth per-IP guard: unauthenticated probing from one IP is bounded (401s count, then 429)',
  withMcpConfig({ enabled: 1, publicEnabled: 1, userMax: 100000, ipMax: 3 }, async () => {
    expect((await post('30.0.0.9')).status).toBe(401);
    expect((await post('30.0.0.9')).status).toBe(401);
    expect((await post('30.0.0.9')).status).toBe(401);
    const blocked = await post('30.0.0.9');
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toMatch(/this network/i);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'system.rate_limit_exceeded', {},
      { limiter: 'mcp_ip', limit: 3 });
    // Another IP is unaffected.
    expect((await post('30.0.0.10')).status).toBe(401);
  }));

test('kill switch outranks the limiters: 503 without consuming any bucket',
  withMcpConfig({ enabled: 0, publicEnabled: 1, userMax: 100000, ipMax: 1 }, async () => {
    // ipMax=1: if the limiter ran before the switch, the second request would
    // be a 429 — both must be the switch's 503.
    expect((await post('40.0.0.1', token('64b0000000000000000000cc'))).status).toBe(503);
    expect((await post('40.0.0.1', token('64b0000000000000000000cc'))).status).toBe(503);
  }));

test('a stored config missing the new fields falls back to defaults (not unlimited, no crash)',
  withMcpConfig({ enabled: 1, publicEnabled: 1 }, async () => {
    const res = await post('50.0.0.1', token('64b0000000000000000000dd'));
    expect(res.status).toBe(200);
    // draft-7 standardHeaders expose the effective limit — must be the DEFAULT
    // userMax, proving the ?? fallback engaged rather than 0/undefined.
    expect(res.headers.get('ratelimit-limit')).toBe(String(rateLimitsConfig.defaults.mcp.userMax));
  }));
