/**
 * /api/bridge/keys — Registry Bridge key management (REGISTRY_LOCKDOWN_PLAN §6).
 *
 * WHY THIS TEST EXISTS:
 * Issuing a bridge key hands the shared registry to a self-hosted install. The
 * route must (a) demand a fresh password confirmation, (b) refuse until the
 * current Registry Data Terms are accepted and record that acceptance,
 * (c) cap active keys per account, (d) return the plaintext exactly once while
 * storing only the SHA-256, and (e) audit ids, never key material. Revocation
 * and the import window are owner-scoped.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/rateLimits', () => ({
  get: () => ({ auth: { max: 1000 }, api: { max: 1000 }, write: { max: 1000 } }),
}));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/ApiToken', () => {
  const crypto = require('crypto');
  return { findOne: jest.fn(), hashToken: (raw) => crypto.createHash('sha256').update(raw).digest('hex'), TOKEN_PREFIX: 'cel_' };
});
jest.mock('../models/BridgeKey', () => {
  const crypto = require('crypto');
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
    hashKey: (raw) => crypto.createHash('sha256').update(raw).digest('hex'),
    generateKey: () => 'cbr_' + crypto.randomBytes(32).toString('hex'),
    displayPrefix: (raw) => raw.slice(0, 12),
    KEY_PREFIX: 'cbr_',
    MAX_ACTIVE_PER_USER: 2,
    NAME_MAX: 60,
  };
});
jest.mock('../services/bridgeQuota', () => ({
  usageFor: jest.fn().mockResolvedValue({ day: '2026-09-08', used: {}, caps: {}, importWindow: { active: false } }),
  openImportWindow: jest.fn(),
}));
jest.mock('../config/legal', () => ({ CURRENT_PRIVACY_POLICY_VERSION: '2026-09', CURRENT_REGISTRY_TERMS_VERSION: '2026-09' }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const BridgeKey = require('../models/BridgeKey');
const { logAudit } = require('../services/audit');
const { openImportWindow } = require('../services/bridgeQuota');
const router = require('./bridgeKeys');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/bridge/keys', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

const auth = () => `Bearer ${jwt.sign({ id: 'u1', roles: ['user'] }, process.env.JWT_SECRET, { algorithm: 'HS256' })}`;
const call = (method, path, body) => fetch(`${baseUrl}${path}`, {
  method, headers: { Authorization: auth(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const userDoc = (over = {}) => {
  const u = {
    _id: 'u1', password: 'hash', registryTerms: { accepted: false, acceptedAt: null, version: null },
    comparePassword: jest.fn().mockResolvedValue(true),
    set: jest.fn(function (path, value) { const [a, b] = path.split('.'); this[a][b] = value; }),
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
  return u;
};

describe('GET /api/bridge/keys', () => {
  test('lists the owner\'s active keys with usage, the cap, and the terms state', async () => {
    BridgeKey.find.mockReturnValue({ sort: () => Promise.resolve([{ _id: 'k1', name: 'Home NAS', prefix: 'cbr_12345678', instanceHost: 'cellar.example.org', termsVersion: '2026-09', createdAt: new Date(), lastUsedAt: null }]) });
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ registryTerms: { accepted: true, version: '2026-09', acceptedAt: new Date() } }) }) });
    const res = await call('GET', '/api/bridge/keys');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ id: 'k1', name: 'Home NAS', prefix: 'cbr_12345678', instanceHost: 'cellar.example.org' });
    expect(body.keys[0].usage).toBeDefined();
    expect(body.keys[0]).not.toHaveProperty('keyHash');
    expect(body.maxActive).toBe(2);
    expect(body.terms).toMatchObject({ version: '2026-09', accepted: true, url: '/terms' });
  });

  test('a stale terms version reads as not accepted', async () => {
    BridgeKey.find.mockReturnValue({ sort: () => Promise.resolve([]) });
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ registryTerms: { accepted: true, version: '2026-03' } }) }) });
    const body = await (await call('GET', '/api/bridge/keys')).json();
    expect(body.terms.accepted).toBe(false);
  });
});

describe('POST /api/bridge/keys', () => {
  test('refuses without the current terms accepted, and records the acceptance when the box is ticked', async () => {
    const u = userDoc();
    User.findById.mockResolvedValue(u);
    BridgeKey.countDocuments.mockResolvedValue(0);
    BridgeKey.create.mockImplementation(async (doc) => ({ _id: 'k1', createdAt: new Date(), ...doc }));

    let res = await call('POST', '/api/bridge/keys', { name: 'Home NAS', password: 'pw' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('terms_required');
    expect(BridgeKey.create).not.toHaveBeenCalled();

    res = await call('POST', '/api/bridge/keys', { name: 'Home NAS', password: 'pw', acceptTerms: true });
    expect(res.status).toBe(201);
    expect(u.set).toHaveBeenCalledWith('registryTerms.version', '2026-09');
    expect(u.save).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'user.registry_terms.accepted', expect.anything(), { version: '2026-09' });
  });

  test('returns the plaintext once, stores only its hash, and audits the id — never the key', async () => {
    User.findById.mockResolvedValue(userDoc({ registryTerms: { accepted: true, version: '2026-09', acceptedAt: new Date() } }));
    BridgeKey.countDocuments.mockResolvedValue(1);
    BridgeKey.create.mockImplementation(async (doc) => ({ _id: 'k2', createdAt: new Date(), ...doc }));
    const res = await call('POST', '/api/bridge/keys', { name: 'Club cellar', password: 'pw' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^cbr_[0-9a-f]{64}$/);
    expect(body.prefix).toBe(body.key.slice(0, 12));
    expect(body.env).toEqual({ REGISTRY_BRIDGE_URL: expect.any(String), REGISTRY_BRIDGE_KEY: body.key });
    const stored = BridgeKey.create.mock.calls[0][0];
    expect(stored.keyHash).toBe(BridgeKey.hashKey(body.key));
    expect(stored).not.toHaveProperty('key');
    expect(stored.termsVersion).toBe('2026-09');
    // Audit arguments after the request object — the request carries the
    // response body only in this test's mock, never in a stored audit row.
    expect(JSON.stringify(logAudit.mock.calls.map((c) => c.slice(1)))).not.toContain(body.key);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bridge.key.created', { type: 'bridgeKey', id: 'k2' }, expect.objectContaining({ name: 'Club cellar' }));
  });

  test('wrong password → 403 (not 401); SSO account without a password → 403 no_password', async () => {
    User.findById.mockResolvedValue(userDoc({ comparePassword: jest.fn().mockResolvedValue(false) }));
    let res = await call('POST', '/api/bridge/keys', { name: 'x', password: 'nope', acceptTerms: true });
    expect(res.status).toBe(403);
    User.findById.mockResolvedValue(userDoc({ password: null }));
    res = await call('POST', '/api/bridge/keys', { name: 'x', password: 'nope', acceptTerms: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('no_password');
    expect(BridgeKey.create).not.toHaveBeenCalled();
  });

  test('two active keys is the cap; a bad name is a 400', async () => {
    User.findById.mockResolvedValue(userDoc({ registryTerms: { accepted: true, version: '2026-09' } }));
    BridgeKey.countDocuments.mockResolvedValue(2);
    let res = await call('POST', '/api/bridge/keys', { name: 'Third', password: 'pw' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('key_cap');
    res = await call('POST', '/api/bridge/keys', { name: 'x'.repeat(61), password: 'pw' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE and import window', () => {
  test('revoke is owner-scoped and soft', async () => {
    const key = { _id: 'k1', name: 'Home NAS', revokedAt: null, save: jest.fn().mockResolvedValue(undefined) };
    BridgeKey.findOne.mockResolvedValue(key);
    let res = await call('DELETE', '/api/bridge/keys/aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(res.status).toBe(200);
    expect(BridgeKey.findOne).toHaveBeenCalledWith({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', user: 'u1', revokedAt: null });
    expect(key.revokedAt).toBeInstanceOf(Date);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bridge.key.revoked', { type: 'bridgeKey', id: 'k1' }, { name: 'Home NAS' });

    BridgeKey.findOne.mockResolvedValue(null);
    res = await call('DELETE', '/api/bridge/keys/bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(res.status).toBe(404);
    res = await call('DELETE', '/api/bridge/keys/not-an-id');
    expect(res.status).toBe(400);
  });

  test('the import window opens once and reports the cooldown the second time', async () => {
    BridgeKey.findOne.mockResolvedValue({ _id: 'k1', name: 'Home NAS' });
    openImportWindow.mockResolvedValueOnce({ ok: true, until: new Date() });
    let res = await call('POST', '/api/bridge/keys/aaaaaaaaaaaaaaaaaaaaaaaa/import-window');
    expect(res.status).toBe(200);
    openImportWindow.mockResolvedValueOnce({ ok: false, nextAvailableAt: new Date() });
    res = await call('POST', '/api/bridge/keys/aaaaaaaaaaaaaaaaaaaaaaaa/import-window');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('import_window_cooldown');
  });
});

describe('GET /api/bridge/keys — admin revocation notice', () => {
  test("a key an admin revoked recently is listed with the reason; the owner's own revocations are not", async () => {
    BridgeKey.find.mockImplementation((filter) => ({
      sort: () => Promise.resolve(filter.revokedBy
        ? [{ _id: 'k9', name: 'Old box', prefix: 'cbr_87654321', revokedAt: new Date('2026-09-07T00:00:00Z'), revokedReason: 'Read 4000 wines in a day' }]
        : []),
    }));
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ registryTerms: { accepted: true, version: '2026-09' } }) }) });
    const body = await (await call('GET', '/api/bridge/keys')).json();
    expect(body.keys).toEqual([]);
    expect(body.revoked).toEqual([{ id: 'k9', name: 'Old box', prefix: 'cbr_87654321', revokedAt: '2026-09-07T00:00:00.000Z', reason: 'Read 4000 wines in a day' }]);
    const revokedCall = BridgeKey.find.mock.calls.find(([f]) => f.revokedBy);
    expect(revokedCall[0]).toMatchObject({ user: 'u1', revokedBy: { $ne: null } });
    expect(revokedCall[0].revokedAt.$gte).toBeInstanceOf(Date);
    // Only what the notice shows is read — never the hash.
    expect(revokedCall[1]).toBe('name prefix revokedAt revokedReason');
  });

  test('a failing notice lookup never takes the key list down', async () => {
    BridgeKey.find.mockImplementation((filter) => (filter.revokedBy
      ? { sort: () => Promise.reject(new Error('boom')) }
      : { sort: () => Promise.resolve([]) }));
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ registryTerms: { accepted: true, version: '2026-09' } }) }) });
    const res = await call('GET', '/api/bridge/keys');
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toEqual([]);
  });
});

describe('audit 2026-09-08 — key churn', () => {
  test('minting is bounded per account per day, and the refusal is audited', async () => {
    const u = userDoc({ registryTerms: { accepted: true, acceptedAt: new Date(), version: '2026-09' } });
    User.findById.mockResolvedValue(u);
    // First call: active keys. Second: keys minted in the last 24 hours.
    BridgeKey.countDocuments.mockResolvedValueOnce(0).mockResolvedValueOnce(5);

    const res = await call('POST', '/api/bridge/keys', { name: 'Home NAS', password: 'pw', acceptTerms: true });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('key_churn');
    expect(BridgeKey.create).not.toHaveBeenCalled();
    // The active-key cap alone was no cap: revoking frees the slot at once, so
    // mint-revoke-mint was unbounded (audit 2026-09-08).
    const churnFilter = BridgeKey.countDocuments.mock.calls[1][0];
    expect(churnFilter.createdAt.$gte).toBeInstanceOf(Date);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bridge.key.create_failed', expect.anything(), expect.objectContaining({ reason: 'churn' }));
  });

  test('under the daily limit a key is still issued', async () => {
    const u = userDoc({ registryTerms: { accepted: true, acceptedAt: new Date(), version: '2026-09' } });
    User.findById.mockResolvedValue(u);
    BridgeKey.countDocuments.mockResolvedValueOnce(0).mockResolvedValueOnce(4);
    BridgeKey.create.mockImplementation(async (doc) => ({ _id: 'k1', createdAt: new Date(), ...doc }));
    const res = await call('POST', '/api/bridge/keys', { name: 'Home NAS', password: 'pw', acceptTerms: true });
    expect(res.status).toBe(201);
  });
});
