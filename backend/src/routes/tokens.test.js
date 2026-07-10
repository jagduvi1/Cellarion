/**
 * /api/tokens management routes (docs/ha-push-events.md §3).
 *
 * WHY THIS TEST EXISTS:
 * Token creation mints a durable credential, so the route must (a) demand a
 * fresh password confirmation, (b) cap active tokens per user, (c) return the
 * plaintext exactly once while storing only the SHA-256, and (d) audit ids —
 * never token material. Revocation must be owner-scoped.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/rateLimits', () => ({
  get: () => ({ auth: { max: 1000 }, api: { max: 1000 }, write: { max: 1000 } }),
}));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/ApiToken', () => {
  const crypto = require('crypto');
  const mock = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(() => ({ catch: () => {} })),
    hashToken: (raw) => crypto.createHash('sha256').update(raw).digest('hex'),
    generateToken: () => 'cel_' + crypto.randomBytes(32).toString('hex'),
    TOKEN_PREFIX: 'cel_',
    TOKEN_SCOPES: ['read', 'consume'],
    MAX_ACTIVE_TOKENS_PER_USER: 10,
  };
  return mock;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');
const { logAudit } = require('../services/audit');
const tokensRouter = require('./tokens');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/tokens', tokensRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  // fetch() keeps sockets alive — sever them or close() never calls back.
  server.closeAllConnections();
  server.close(done);
});
beforeEach(() => jest.clearAllMocks());

const authHeader = () =>
  `Bearer ${jwt.sign({ id: 'u1', roles: ['user'] }, process.env.JWT_SECRET, { algorithm: 'HS256' })}`;

const request = (method, path, body, headers = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('POST /api/tokens', () => {
  const validBody = { name: 'Home Assistant', scopes: ['read', 'consume'], password: 'pw' };

  test('rejects without auth', async () => {
    const res = await fetch(`${baseUrl}/api/tokens`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test.each([
    [{ ...validBody, name: '' }],
    [{ ...validBody, name: 'x'.repeat(101) }],
    [{ ...validBody, scopes: [] }],
    [{ ...validBody, scopes: ['read', 'admin'] }],
    [{ ...validBody, password: undefined }],
  ])('validates input → 400 (%#)', async (body) => {
    const res = await request('POST', '/api/tokens', body);
    expect(res.status).toBe(400);
  });

  test('wrong password → 403 (NOT 401 — apiFetch auto-refreshes and re-submits on 401) and an audit entry, no token created', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', comparePassword: jest.fn().mockResolvedValue(false) });
    const res = await request('POST', '/api/tokens', validBody);
    expect(res.status).toBe(403);
    expect(ApiToken.create).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'token.create_failed', expect.anything(), { reason: 'incorrect_password' });
  });

  test('active-token cap → 400', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', comparePassword: jest.fn().mockResolvedValue(true) });
    ApiToken.countDocuments.mockResolvedValue(10);
    const res = await request('POST', '/api/tokens', validBody);
    expect(res.status).toBe(400);
    expect(ApiToken.create).not.toHaveBeenCalled();
  });

  test('happy path: returns plaintext once, stores only the hash, audits the id', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', comparePassword: jest.fn().mockResolvedValue(true) });
    ApiToken.countDocuments.mockResolvedValue(0);
    ApiToken.create.mockImplementation(async (doc) => ({ ...doc, _id: 't1', createdAt: new Date() }));

    const res = await request('POST', '/api/tokens', validBody);
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.token).toMatch(/^cel_[0-9a-f]{64}$/);
    const stored = ApiToken.create.mock.calls[0][0];
    expect(stored.tokenHash).toBe(ApiToken.hashToken(body.token));
    expect(JSON.stringify(stored)).not.toContain(body.token);
    expect(stored.scopes).toEqual(['read', 'consume']);

    // Audit carries the id + metadata, never the token or hash. (Skip arg 0 —
    // the Express req is circular.)
    const auditJson = JSON.stringify(logAudit.mock.calls.map(c => c.slice(1)));
    expect(auditJson).toContain('token.created');
    expect(auditJson).not.toContain(body.token);
    expect(auditJson).not.toContain(stored.tokenHash);
  });

  test('duplicate scopes are de-duplicated', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', comparePassword: jest.fn().mockResolvedValue(true) });
    ApiToken.countDocuments.mockResolvedValue(0);
    ApiToken.create.mockImplementation(async (doc) => ({ ...doc, _id: 't1', createdAt: new Date() }));

    const res = await request('POST', '/api/tokens', { name: 'HA', scopes: ['read', 'read'], password: 'pw' });
    expect(res.status).toBe(201);
    expect(ApiToken.create.mock.calls[0][0].scopes).toEqual(['read']);
  });
});

describe('GET /api/tokens', () => {
  test('lists metadata only — no hash field in the response', async () => {
    const lean = jest.fn().mockResolvedValue([
      { _id: 't1', name: 'HA', scopes: ['read'], lastUsedAt: null, createdAt: new Date() },
    ]);
    ApiToken.find.mockReturnValue({ sort: () => ({ select: () => ({ lean }) }) });

    const res = await request('GET', '/api/tokens');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual(expect.objectContaining({ id: 't1', name: 'HA', scopes: ['read'] }));
    expect(JSON.stringify(body)).not.toContain('tokenHash');
    // Owner-scoped and active-only
    expect(ApiToken.find).toHaveBeenCalledWith({ user: 'u1', revokedAt: null });
  });
});

describe('DELETE /api/tokens/:id', () => {
  test('revokes an owned token and audits it', async () => {
    const save = jest.fn();
    ApiToken.findOne.mockResolvedValue({ _id: 't1', name: 'HA', save });

    const res = await request('DELETE', '/api/tokens/t1');
    expect(res.status).toBe(200);
    expect(ApiToken.findOne).toHaveBeenCalledWith({ _id: 't1', user: 'u1', revokedAt: null });
    expect(save).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'token.revoked', { type: 'apiToken', id: 't1' }, { name: 'HA' });
  });

  test("someone else's token (or already revoked) → 404", async () => {
    ApiToken.findOne.mockResolvedValue(null);
    const res = await request('DELETE', '/api/tokens/t2');
    expect(res.status).toBe(404);
  });
});
