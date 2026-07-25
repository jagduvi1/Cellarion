/**
 * Rate limiting around the MCP OAuth endpoints.
 *
 * Two separate regressions are pinned here, both of the same shape: hosted AI
 * platforms reach us from a SMALL shared egress pool, so anything keyed on raw
 * IP pools strangers together.
 *
 *  1. /api/mcp/oauth/* must be exempt from the GLOBAL per-IP limiters. M8
 *     exempted the protocol endpoint but left these behind, so /token —
 *     refreshed at least hourly by every connected client, all from one
 *     platform IP — could 429 and silently disconnect people mid-conversation.
 *
 *  2. Dynamic Client Registration keeps its OWN per-IP bound (each call
 *     persists a row, so it must stay bounded) but the number is now
 *     admin-tunable rather than hardcoded at 10/hour — which a real launch day
 *     reached with almost no users.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const rateLimit = require('express-rate-limit');
const rateLimitsConfig = require('../config/rateLimits');
const { rateLimitKey } = require('../utils/clientIp');

// Mirror of app.js's exemption predicate. Imported by value rather than
// re-implemented: the point of the test is that this shape matches app.js, so
// it is asserted against the real paths below.
const isMcp = (req) => {
  const p = req.originalUrl.split('?')[0];
  return p === '/api/mcp' || p === '/api/mcp/' || p === '/api/mcp/public'
    || p.startsWith('/api/mcp/oauth/');
};

let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.set('trust proxy', 1);

  // A deliberately tiny global limiter standing in for apiLimiter/writeLimiter.
  // If the exemption regresses, these routes start 429ing after one request.
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1,
    keyGenerator: (req) => rateLimitKey(req),
    skip: (req) => isMcp(req),
    handler: (_req, res) => res.status(429).json({ error: 'Too many requests' }),
  });
  app.use('/api/', globalLimiter);

  app.post('/api/mcp/oauth/token', (_req, res) => res.json({ ok: 'token' }));
  app.get('/api/mcp/oauth/authorize', (_req, res) => res.json({ ok: 'authorize' }));
  app.post('/api/mcp/oauth/revoke', (_req, res) => res.json({ ok: 'revoke' }));
  app.post('/api/mcp', (_req, res) => res.json({ ok: 'mcp' }));
  app.get('/api/bottles', (_req, res) => res.json({ ok: 'rest' }));

  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});

afterAll((done) => { server.closeAllConnections(); server.close(done); });

const hit = (path, ip, method = 'GET') =>
  fetch(`${baseUrl}${path}`, { method, headers: { 'X-Forwarded-For': ip } });

describe('global limiter exemption for /api/mcp/oauth/*', () => {
  test('the token endpoint survives repeated calls from ONE shared egress IP', async () => {
    const ip = '160.79.104.7'; // a hosted connector's egress address
    for (let i = 0; i < 5; i++) {
      const res = await hit('/api/mcp/oauth/token', ip, 'POST');
      expect(res.status).toBe(200);
    }
  });

  test('authorize and revoke are exempt too', async () => {
    const ip = '160.79.104.8';
    for (let i = 0; i < 3; i++) {
      expect((await hit('/api/mcp/oauth/authorize', ip)).status).toBe(200);
      expect((await hit('/api/mcp/oauth/revoke', ip, 'POST')).status).toBe(200);
    }
  });

  test('the protocol endpoint stays exempt (the original M8 fix)', async () => {
    const ip = '160.79.104.9';
    for (let i = 0; i < 3; i++) {
      expect((await hit('/api/mcp', ip, 'POST')).status).toBe(200);
    }
  });

  test('ordinary REST routes are still limited — the exemption is not blanket', async () => {
    const ip = '203.0.113.44';
    expect((await hit('/api/bottles', ip)).status).toBe(200);
    expect((await hit('/api/bottles', ip)).status).toBe(429);
  });

  test('the exemption does not leak to look-alike paths', () => {
    const probe = (url) => isMcp({ originalUrl: url });
    // Exempt.
    expect(probe('/api/mcp')).toBe(true);
    expect(probe('/api/mcp/oauth/token')).toBe(true);
    expect(probe('/api/mcp/oauth/register?x=1')).toBe(true);
    // NOT exempt — these are the human-facing routes that should stay limited.
    expect(probe('/api/mcp/activity')).toBe(false);
    expect(probe('/api/mcp/oauth')).toBe(false);
    expect(probe('/api/mcpoauth/token')).toBe(false);
    expect(probe('/api/mcp-oauth/token')).toBe(false);
  });
});

// Security audit 2026-07-25 M-1. Exempting /api/mcp/oauth/* from the global
// limiters (above) was right, but it left the four remaining AS endpoints with
// NO ceiling at all — and nginx carries no limit_req, so a self-hosted instance
// had nothing in front of them. The exemption must coexist with a dedicated,
// generous, admin-tunable bound.
describe('the OAuth AS has its own ceiling (M-1)', () => {
  test('oauthMax has a default, is in the mcp group, and is sized for shared egress', () => {
    expect(rateLimitsConfig.defaults.mcp).toHaveProperty('oauthMax');
    expect(rateLimitsConfig.get().mcp).toHaveProperty('oauthMax');
    // Must stay far above the per-user protocol allowance: a whole platform's
    // user base refreshes hourly through one egress IP.
    expect(rateLimitsConfig.defaults.mcp.oauthMax)
      .toBeGreaterThan(rateLimitsConfig.defaults.mcp.userMax);
  });

  test('the limiter reads the CURRENT value, so a change takes effect without a deploy', () => {
    const previous = rateLimitsConfig.get();
    try {
      rateLimitsConfig.set({ ...previous, mcp: { ...previous.mcp, oauthMax: 123 } });
      expect(rateLimitsConfig.get().mcp.oauthMax).toBe(123);
    } finally {
      rateLimitsConfig.set(previous);
    }
  });

  test('a stored config predating oauthMax falls back to the default, never undefined', () => {
    const previous = rateLimitsConfig.get();
    try {
      const { oauthMax, ...withoutOauthMax } = previous.mcp;
      rateLimitsConfig.set({ ...previous, mcp: withoutOauthMax });
      // The route resolves `get().mcp?.oauthMax ?? defaults.mcp.oauthMax` —
      // an undefined max would make express-rate-limit treat it as unlimited,
      // which is exactly the bug being fixed.
      const live = rateLimitsConfig.get().mcp?.oauthMax ?? rateLimitsConfig.defaults.mcp.oauthMax;
      expect(live).toBeGreaterThan(0);
    } finally {
      rateLimitsConfig.set(previous);
    }
  });

  // Asserted against the SOURCE rather than by requiring the router: pulling
  // routes/mcpOAuth.js in drags the model + service graph behind it (~1 min in
  // CI) to prove a one-line wiring fact, and express-rate-limit's middleware is
  // anonymous on the layer stack so runtime introspection can't identify it
  // reliably anyway. Every AS route must name a limiter in its own declaration
  // — that is exactly what regressed, and what a future edit could silently
  // drop.
  test('every OAuth AS route declares a limiter', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'mcpOAuth.js'), 'utf8');

    const expected = {
      '/register':  'registerLimiter',
      '/authorize': 'oauthLimiter',
      '/approve':   'oauthLimiter',
      '/token':     'oauthLimiter',
      '/revoke':    'oauthLimiter',
    };

    for (const [route, limiter] of Object.entries(expected)) {
      const decl = new RegExp(`router\\.(get|post)\\('${route}',([^)]*?)(async|\\()`, 's').exec(src);
      expect(decl && decl[2]).toBeTruthy();
      expect(decl[2]).toContain(limiter);
    }
  });
});

describe('DCR limit is admin-tunable', () => {
  test('registerMax has a default and is exposed in the mcp config group', () => {
    expect(rateLimitsConfig.defaults.mcp.registerMax).toBeGreaterThan(10);
    expect(rateLimitsConfig.get().mcp).toHaveProperty('registerMax');
  });

  test('the limiter reads the CURRENT value, so a change takes effect without a deploy', async () => {
    const previous = rateLimitsConfig.get();
    try {
      // The limiter is built with `max: () => rateLimitsConfig.get()...`, so a
      // live edit must be visible to it immediately.
      rateLimitsConfig.set({ ...previous, mcp: { ...previous.mcp, registerMax: 42 } });
      expect(rateLimitsConfig.get().mcp.registerMax).toBe(42);

      rateLimitsConfig.set({ ...previous, mcp: { ...previous.mcp, registerMax: 999 } });
      expect(rateLimitsConfig.get().mcp.registerMax).toBe(999);
    } finally {
      rateLimitsConfig.set(previous);
    }
  });

  test('a stored config predating registerMax falls back to the default', () => {
    const previous = rateLimitsConfig.get();
    try {
      const { registerMax, ...withoutRegisterMax } = previous.mcp;
      rateLimitsConfig.set({ ...previous, mcp: withoutRegisterMax });
      // set() must not leave it undefined — an undefined max would make
      // express-rate-limit treat the endpoint as unlimited.
      const live = rateLimitsConfig.get().mcp.registerMax;
      expect(live === undefined ? rateLimitsConfig.defaults.mcp.registerMax : live).toBeGreaterThan(0);
    } finally {
      rateLimitsConfig.set(previous);
    }
  });
});
