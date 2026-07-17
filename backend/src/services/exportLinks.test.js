/**
 * Export-link service — credential + redemption invariants.
 *
 * WHY THIS TEST EXISTS: this service is a self-authenticating download path with
 * NO route middleware in front of it (the celx_ token IS the credential), and it
 * streams a user's PII. The invariants pinned here are the ones a leaked-URL or
 * looping-agent threat model turns on: the raw token is never stored (only its
 * SHA-256), an expired link is dead even before TTL sweep, the heavy builds are
 * throttled and their allowance is refunded on failure, and a missing user is a
 * clean 404 not a crash. Handlers run for REAL against mocked models (the audit
 * lesson: mocking the unit under test wholesale hides exactly these bugs).
 */

jest.mock('../models/ExportLink', () => ({ create: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('./cellarExport', () => ({
  buildCellarDataExport: jest.fn(),
  claimImageExportAllowance: jest.fn(),
  refundImageExportAllowance: jest.fn(),
  streamCellarArchive: jest.fn(),
}));
jest.mock('./userDataRegistry', () => ({ buildUserExport: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const crypto = require('crypto');
const ExportLink = require('../models/ExportLink');
const User = require('../models/User');
const cellarExport = require('./cellarExport');
const { buildUserExport } = require('./userDataRegistry');
const { logAudit } = require('./audit');
const svc = require('./exportLinks');

const oid = (c) => c.repeat(24);
const USER = oid('a');

// A findById result that is BOTH .select()-chainable AND directly awaitable —
// the service uses .select() for the header lookup and a bare await for the
// full account doc, so one helper must serve both.
function q(val) {
  const c = { select: () => c, then: (res, rej) => Promise.resolve(val).then(res, rej) };
  return c;
}

// A fake Express response capturing headers + the JSON/stream calls.
function fakeRes() {
  return {
    headers: {},
    body: undefined,
    headersSent: false,
    writableEnded: false,
    destroyed: null,
    listeners: {},
    setHeader(k, v) { this.headers[k] = v; },
    json(b) { this.body = b; this.headersSent = true; this.writableEnded = true; },
    destroy(e) { this.destroyed = e; },
    on(ev, fn) { this.listeners[ev] = fn; return this; },
    emit(ev) { if (this.listeners[ev]) this.listeners[ev](); },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  cellarExport.refundImageExportAllowance.mockResolvedValue();
  ExportLink.create.mockResolvedValue({});
  ExportLink.updateOne.mockResolvedValue({});
  User.updateOne.mockResolvedValue({});
});

describe('token shape + hashing', () => {
  test('isExportLinkToken accepts only celx_ + 64 hex', () => {
    expect(svc.isExportLinkToken('celx_' + 'a'.repeat(64))).toBe(true);
    expect(svc.isExportLinkToken('cel_' + 'a'.repeat(64))).toBe(false); // API-token prefix, not this
    expect(svc.isExportLinkToken('celx_' + 'a'.repeat(63))).toBe(false);
    expect(svc.isExportLinkToken('celx_' + 'Z'.repeat(64))).toBe(false); // non-hex
    expect(svc.isExportLinkToken(null)).toBe(false);
    expect(svc.isExportLinkToken(12345)).toBe(false);
  });

  test('hashLinkToken is a deterministic sha256', () => {
    const raw = 'celx_' + 'b'.repeat(64);
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    expect(svc.hashLinkToken(raw)).toBe(expected);
  });
});

describe('mintExportLink', () => {
  test('stores only the HASH, returns the raw token in the URL, ~1h expiry', async () => {
    const before = Date.now();
    const { url, expiresAt } = await svc.mintExportLink({
      userId: USER, kind: 'cellar_json', cellarScope: 'all', baseUrl: 'https://cellarion.app',
    });

    expect(ExportLink.create).toHaveBeenCalledTimes(1);
    const doc = ExportLink.create.mock.calls[0][0];
    // The raw token appears in the URL but NEVER in the stored document.
    const raw = url.split('/api/mcp/export/')[1];
    expect(raw).toMatch(/^celx_[a-f0-9]{64}$/);
    expect(doc.tokenHash).toBe(svc.hashLinkToken(raw));
    expect(JSON.stringify(doc)).not.toContain(raw);
    expect(doc.kind).toBe('cellar_json');
    expect(doc.cellarScope).toBe('all');
    expect(url.startsWith('https://cellarion.app/api/mcp/export/')).toBe(true);
    const ttl = expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(55 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 2000);
  });
});

describe('findLiveLink', () => {
  test('rejects a malformed token WITHOUT hitting the DB', async () => {
    expect(await svc.findLiveLink('not-a-token')).toBeNull();
    expect(ExportLink.findOne).not.toHaveBeenCalled();
  });

  test('returns null for an unknown or expired link, the doc for a live one', async () => {
    ExportLink.findOne.mockResolvedValueOnce(null);
    expect(await svc.findLiveLink('celx_' + 'a'.repeat(64))).toBeNull();

    ExportLink.findOne.mockResolvedValueOnce({ expiresAt: new Date(Date.now() - 1000) });
    expect(await svc.findLiveLink('celx_' + 'a'.repeat(64))).toBeNull();

    const live = { _id: 'x', expiresAt: new Date(Date.now() + 60000) };
    ExportLink.findOne.mockResolvedValueOnce(live);
    expect(await svc.findLiveLink('celx_' + 'a'.repeat(64))).toBe(live);
  });
});

describe('redeemExportLink — cellar_json', () => {
  test('streams the JSON payload and marks the link used', async () => {
    User.findById.mockReturnValue(q({ username: 'jo' }));
    cellarExport.buildCellarDataExport.mockResolvedValue({ payload: { bottleCount: 3 }, imageCount: 0, imageFiles: [] });
    const res = fakeRes();

    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'cellar_json', cellarScope: 'all' }, res);

    expect(out).toBeNull();
    expect(res.body).toEqual({ bottleCount: 3 });
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(res.headers['Content-Disposition']).toMatch(/\.json"/);
    expect(ExportLink.updateOne).toHaveBeenCalled(); // markUsed
  });

  test('no owned cellar for the scope → 404', async () => {
    User.findById.mockReturnValue(q({ username: 'jo' }));
    cellarExport.buildCellarDataExport.mockResolvedValue(null);
    const res = fakeRes();
    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'cellar_json', cellarScope: 'all' }, res);
    expect(out).toEqual({ status: 404, error: expect.any(String) });
  });

  test('user gone → 404 before any build', async () => {
    User.findById.mockReturnValue(q(null));
    const res = fakeRes();
    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'cellar_json', cellarScope: 'all' }, res);
    expect(out).toEqual({ status: 404, error: expect.any(String) });
    expect(cellarExport.buildCellarDataExport).not.toHaveBeenCalled();
  });
});

describe('redeemExportLink — account_json (daily throttle)', () => {
  test('claims the daily allowance, builds, streams', async () => {
    User.findById
      .mockReturnValueOnce(q({ username: 'jo', lastAccountExportAt: null })) // header lookup
      .mockReturnValueOnce(q({ username: 'jo' }));                           // full doc for build
    User.findOneAndUpdate.mockResolvedValue({ lastAccountExportAt: null });  // claim wins
    buildUserExport.mockResolvedValue({ account: { email: 'jo@x.io' } });
    const res = fakeRes();

    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'account_json' }, res);

    expect(out).toBeNull();
    expect(res.body).toEqual({ account: { email: 'jo@x.io' } });
    expect(res.headers['Content-Disposition']).toMatch(/cellarion-data-export-jo\.json/);
  });

  test('second call within the day → 429, no build', async () => {
    User.findById.mockReturnValue(q({ username: 'jo', lastAccountExportAt: new Date() }));
    User.findOneAndUpdate.mockResolvedValue(null); // claim lost — already exported today
    const res = fakeRes();

    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'account_json' }, res);

    expect(out.status).toBe(429);
    expect(buildUserExport).not.toHaveBeenCalled();
  });

  test('build failure refunds the daily claim and rethrows', async () => {
    const prior = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    User.findById
      .mockReturnValueOnce(q({ username: 'jo', lastAccountExportAt: prior }))
      .mockReturnValueOnce(q({ username: 'jo' }));
    User.findOneAndUpdate.mockResolvedValue({ lastAccountExportAt: prior });
    buildUserExport.mockRejectedValue(new Error('boom'));
    const res = fakeRes();

    await expect(svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'account_json' }, res)).rejects.toThrow('boom');
    // Refund restores the PRIOR timestamp so the user isn't locked out by a transient failure.
    expect(User.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: USER }),
      { $set: { lastAccountExportAt: prior } }
    );
  });
});

describe('redeemExportLink — cellar_zip (weekly allowance)', () => {
  test('claims weekly, streams the archive', async () => {
    User.findById.mockReturnValue(q({ username: 'jo' }));
    cellarExport.claimImageExportAllowance.mockResolvedValue({ claimed: true, claimStamp: new Date(), priorStamp: null });
    cellarExport.buildCellarDataExport.mockResolvedValue({ payload: { bottleCount: 2 }, imageCount: 4, imageFiles: [{ relPath: 'a', archivePath: 'images/a' }] });
    const res = fakeRes();

    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'cellar_zip', cellarScope: 'all' }, res);

    expect(out).toBeNull();
    expect(cellarExport.streamCellarArchive).toHaveBeenCalledWith(res, { bottleCount: 2 }, [{ relPath: 'a', archivePath: 'images/a' }]);
    expect(res.headers['Content-Type']).toBe('application/zip');
  });

  test('weekly allowance already spent → 429, no build', async () => {
    User.findById.mockReturnValue(q({ username: 'jo' }));
    cellarExport.claimImageExportAllowance.mockResolvedValue({ claimed: false, nextAvailableAt: new Date() });
    const res = fakeRes();

    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'cellar_zip', cellarScope: 'all' }, res);

    expect(out.status).toBe(429);
    expect(cellarExport.buildCellarDataExport).not.toHaveBeenCalled();
  });

  test('no images → refund the weekly allowance but still stream the data-only zip', async () => {
    User.findById.mockReturnValue(q({ username: 'jo' }));
    const stamp = new Date();
    cellarExport.claimImageExportAllowance.mockResolvedValue({ claimed: true, claimStamp: stamp, priorStamp: null });
    cellarExport.buildCellarDataExport.mockResolvedValue({ payload: { bottleCount: 1 }, imageCount: 0, imageFiles: [] });
    const res = fakeRes();

    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'cellar_zip', cellarScope: 'all' }, res);

    expect(out).toBeNull();
    expect(cellarExport.refundImageExportAllowance).toHaveBeenCalledWith(USER, stamp, null);
    expect(cellarExport.streamCellarArchive).toHaveBeenCalled();
  });

  test('client disconnect mid-stream refunds the weekly allowance (link stays retryable)', async () => {
    User.findById.mockReturnValue(q({ username: 'jo' }));
    const stamp = new Date();
    cellarExport.claimImageExportAllowance.mockResolvedValue({ claimed: true, claimStamp: stamp, priorStamp: null });
    cellarExport.buildCellarDataExport.mockResolvedValue({ payload: { bottleCount: 2 }, imageCount: 4, imageFiles: [{ relPath: 'a' }] });
    const res = fakeRes();

    await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'cellar_zip', cellarScope: 'all' }, res);
    // No refund yet — the stream (mocked) "completed".
    expect(cellarExport.refundImageExportAllowance).not.toHaveBeenCalled();
    // Now simulate the socket closing before the response finished.
    res.writableEnded = false;
    res.emit('close');
    expect(cellarExport.refundImageExportAllowance).toHaveBeenCalledWith(USER, stamp, null);
  });
});

describe('redeemExportLink — auditing + unknown kind', () => {
  test('a successful download is audit-logged (the data actually leaves us)', async () => {
    User.findById.mockReturnValue(q({ username: 'jo' }));
    cellarExport.buildCellarDataExport.mockResolvedValue({ payload: { bottleCount: 1 }, imageCount: 0, imageFiles: [] });
    const req = { headers: {} };
    await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'cellar_json', cellarScope: 'all' }, fakeRes(), req);
    expect(logAudit).toHaveBeenCalledWith(req, 'user.export_download', expect.objectContaining({ id: USER }), expect.objectContaining({ kind: 'cellar_json' }));
  });

  test('an unknown kind is rejected, not silently streamed', async () => {
    User.findById.mockReturnValue(q({ username: 'jo' }));
    const out = await svc.redeemExportLink({ _id: 'L1', user: USER, kind: 'weird_kind' }, fakeRes());
    expect(out.status).toBe(400);
    expect(cellarExport.buildCellarDataExport).not.toHaveBeenCalled();
  });
});
