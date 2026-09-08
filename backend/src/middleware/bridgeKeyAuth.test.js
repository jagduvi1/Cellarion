/**
 * Registry Bridge key auth (REGISTRY_LOCKDOWN_PLAN §6).
 *
 * WHY THIS TEST EXISTS:
 * A bridge key is a durable credential to the shared registry. The properties
 * that matter: only a `cbr_` bearer is even looked up (a `cel_` token or a JWT
 * is refused here, never dispatched elsewhere), a revoked key or a key whose
 * account is pending deletion is dead, the owner's identity lands in
 * req.user in the same shape the other auth paths produce, and usage
 * bookkeeping is throttled and never carries the key itself.
 */
jest.mock('../models/BridgeKey', () => {
  const crypto = require('crypto');
  return {
    findOne: jest.fn(),
    updateOne: jest.fn(() => ({ catch: () => {} })),
    hashKey: (raw) => crypto.createHash('sha256').update(raw).digest('hex'),
    KEY_PREFIX: 'cbr_',
  };
});
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const BridgeKey = require('../models/BridgeKey');
const User = require('../models/User');
const { logAudit } = require('../services/audit');
const { requireBridgeKey, isBridgeCredential, instanceHostFrom, LAST_USED_THROTTLE_MS } = require('./bridgeKeyAuth');

const RAW = 'cbr_' + 'a'.repeat(64);
const req = (headers = {}) => ({ headers, get: (h) => headers[h.toLowerCase()] });
const res = () => {
  const r = { status: jest.fn(() => r), json: jest.fn(() => r), set: jest.fn(() => r) };
  return r;
};
const keyDoc = (over = {}) => ({
  _id: { toString: () => 'k1' }, user: 'u1', name: 'Home NAS', prefix: 'cbr_aaaaaaaa', instanceHost: null,
  lastUsedAt: null, importWindowUntil: null, ...over,
});
const selectChain = (doc) => ({ select: jest.fn().mockResolvedValue(doc) });

beforeEach(() => jest.clearAllMocks());

describe('isBridgeCredential / instanceHostFrom', () => {
  test('only a cbr_ bearer is a bridge credential', () => {
    expect(isBridgeCredential(RAW)).toBe(true);
    expect(isBridgeCredential('cel_' + 'a'.repeat(64))).toBe(false);
    expect(isBridgeCredential('eyJhbGciOi')).toBe(false);
    expect(isBridgeCredential(undefined)).toBe(false);
  });

  test('the instance header is reduced to a host-like string', () => {
    expect(instanceHostFrom(req({ 'x-cellarion-instance': 'https://Cellar.Example.org/path' }))).toBe('cellar.example.org');
    // Anything after the first slash is a path, not a host; what is left is
    // reduced to host characters.
    expect(instanceHostFrom(req({ 'x-cellarion-instance': '<script>alert(1)</script>' }))).toBe('scriptalert1');
    expect(instanceHostFrom(req({ 'x-cellarion-instance': 'x'.repeat(300) }))).toHaveLength(120);
    expect(instanceHostFrom(req({}))).toBeNull();
  });
});

describe('requireBridgeKey', () => {
  test('no bearer, a JWT, or a cel_ token → 401 no_key with a challenge, and nothing is looked up', async () => {
    for (const headers of [{}, { authorization: 'Bearer eyJhbGciOi' }, { authorization: `Bearer cel_${'b'.repeat(64)}` }]) {
      const r = res(); const next = jest.fn();
      await requireBridgeKey(req(headers), r, next);
      expect(r.status).toHaveBeenCalledWith(401);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'no_key' }));
      expect(r.set).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('cellarion-bridge'));
      expect(next).not.toHaveBeenCalled();
    }
    expect(BridgeKey.findOne).not.toHaveBeenCalled();
  });

  test('an unknown or revoked key → 401 invalid_key; the lookup is by hash with revokedAt null', async () => {
    BridgeKey.findOne.mockResolvedValue(null);
    const r = res(); const next = jest.fn();
    await requireBridgeKey(req({ authorization: `Bearer ${RAW}` }), r, next);
    expect(BridgeKey.findOne).toHaveBeenCalledWith({ keyHash: BridgeKey.hashKey(RAW), revokedAt: null });
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_key' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('a key whose account is missing or pending deletion is dead', async () => {
    BridgeKey.findOne.mockResolvedValue(keyDoc());
    User.findById.mockReturnValue(selectChain({ _id: 'u1', roles: ['user'], deletionScheduledFor: new Date() }));
    const r = res(); const next = jest.fn();
    await requireBridgeKey(req({ authorization: `Bearer ${RAW}` }), r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('success attaches the owner as req.user and the key as req.bridge, and records usage once an hour', async () => {
    BridgeKey.findOne.mockResolvedValue(keyDoc());
    User.findById.mockReturnValue(selectChain({ _id: { toString: () => 'u1' }, roles: [], plan: 'free', planExpiresAt: null, deletionScheduledFor: null }));
    const request = req({ authorization: `Bearer ${RAW}`, 'x-cellarion-instance': 'https://cellar.example.org' });
    const r = res(); const next = jest.fn();
    await requireBridgeKey(request, r, next);
    expect(next).toHaveBeenCalled();
    expect(request.user).toEqual({ id: 'u1', roles: ['user'], plan: 'free', planExpiresAt: null });
    expect(request.bridge.key).toMatchObject({ id: 'k1', name: 'Home NAS', prefix: 'cbr_aaaaaaaa' });
    expect(BridgeKey.updateOne).toHaveBeenCalledWith({ _id: expect.anything() }, { $set: expect.objectContaining({ lastUsedAt: expect.any(Date), instanceHost: 'cellar.example.org' }) });
    // The audit row carries the key id and host, never the key (the request
    // object is the first argument and is not what gets stored).
    const detail = logAudit.mock.calls[0];
    expect(detail[1]).toBe('bridge.key.used');
    expect(JSON.stringify(detail.slice(1))).not.toContain(RAW);
  });

  test('a recently used key is not written again', async () => {
    BridgeKey.findOne.mockResolvedValue(keyDoc({ lastUsedAt: new Date(Date.now() - LAST_USED_THROTTLE_MS / 2) }));
    User.findById.mockReturnValue(selectChain({ _id: { toString: () => 'u1' }, roles: ['user'], deletionScheduledFor: null }));
    const next = jest.fn();
    await requireBridgeKey(req({ authorization: `Bearer ${RAW}` }), res(), next);
    expect(next).toHaveBeenCalled();
    expect(BridgeKey.updateOne).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('an expired plan is downgraded to free, exactly as the JWT path does', async () => {
    BridgeKey.findOne.mockResolvedValue(keyDoc());
    User.findById.mockReturnValue(selectChain({ _id: { toString: () => 'u1' }, roles: ['user'], plan: 'supporter', planExpiresAt: new Date(Date.now() - 1000), deletionScheduledFor: null }));
    const request = req({ authorization: `Bearer ${RAW}` });
    await requireBridgeKey(request, res(), jest.fn());
    expect(request.user.plan).toBe('free');
  });
});
