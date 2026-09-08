/**
 * Registry Bridge daily quotas (REGISTRY_LOCKDOWN_PLAN §6).
 *
 * WHY THIS TEST EXISTS:
 * The quotas are what make walking the registry through a key slow and
 * visible. Pinned: a unit is spent before it is compared (no silent
 * underspend), the cap refuses with a reset time, the import window
 * multiplies every cap by five and can be opened once per 30 days, the usage
 * summary is what the Settings page and GET /v1/me show, and a missing
 * database fails OPEN so a self-hoster is never refused by a counter outage.
 */
jest.mock('mongoose', () => ({ connection: { readyState: 1 } }));
jest.mock('../models/BridgeKey', () => ({
  updateOne: jest.fn().mockResolvedValue({}),
  updateMany: jest.fn().mockResolvedValue({}),
  findOne: jest.fn(),
}));
jest.mock('../models/BridgeUsageDay', () => ({
  findOneAndUpdate: jest.fn(),
  findOne: jest.fn(),
  RETENTION_DAYS: 90,
}));

const mongoose = require('mongoose');
const BridgeKey = require('../models/BridgeKey');
const BridgeUsageDay = require('../models/BridgeUsageDay');
const q = require('./bridgeQuota');

const key = (over = {}) => ({ _id: 'k1', user: 'u1', importWindowUntil: null, importWindowOpenedAt: null, ...over });
const lean = (doc) => ({ lean: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mongoose.connection.readyState = 1;
  // No earlier import window anywhere on the account, unless a test says so.
  BridgeKey.findOne.mockReturnValue({ select: () => ({ sort: () => ({ lean: () => Promise.resolve(null) }) }) });
});

/** The account-wide cooldown lookup, answering with one key's opening date. */
const openedAt = (date) => BridgeKey.findOne.mockReturnValue({
  select: () => ({ sort: () => ({ lean: () => Promise.resolve(date ? { importWindowOpenedAt: date } : null) }) }),
});

describe('takeQuota', () => {
  test('spends one unit and allows while at or under the cap', async () => {
    BridgeUsageDay.findOneAndUpdate.mockReturnValue(lean({ searches: 600 }));
    const r = await q.takeQuota(key(), 'searches');
    // Keyed on the ACCOUNT: keys are re-mintable, so a per-key counter was an
    // allowance multiplier (audit 2026-09-08). The key is recorded for
    // attribution only.
    expect(BridgeUsageDay.findOneAndUpdate).toHaveBeenCalledWith(
      { user: 'u1', day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      expect.objectContaining({ $inc: { searches: 1 }, $setOnInsert: expect.objectContaining({ key: 'k1' }) }),
      expect.objectContaining({ upsert: true, new: true })
    );
    expect(r).toMatchObject({ allowed: true, used: 600, cap: 600, counted: true });
    expect(r.resetAt.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  test('refuses past the cap, with the cap and the reset time', async () => {
    BridgeUsageDay.findOneAndUpdate.mockReturnValue(lean({ fetches: 301 }));
    const r = await q.takeQuota(key(), 'fetches');
    expect(r).toMatchObject({ allowed: false, used: 301, cap: 300 });
  });

  test('an open import window multiplies the cap by five', async () => {
    BridgeUsageDay.findOneAndUpdate.mockReturnValue(lean({ fetches: 1200 }));
    const r = await q.takeQuota(key({ importWindowUntil: new Date(Date.now() + 3600e3) }), 'fetches');
    expect(r).toMatchObject({ allowed: true, cap: 1500 });
    const closed = await q.takeQuota(key({ importWindowUntil: new Date(Date.now() - 1) }), 'fetches');
    expect(closed.cap).toBe(300);
  });

  test('an unknown kind is a programming error, not a silent allow', async () => {
    await expect(q.takeQuota(key(), 'downloads')).rejects.toThrow(/Unknown bridge quota kind/);
  });

  test('fails open when the database is unreachable or the write throws', async () => {
    mongoose.connection.readyState = 0;
    expect(await q.takeQuota(key(), 'searches')).toMatchObject({ allowed: true, counted: false });
    expect(BridgeUsageDay.findOneAndUpdate).not.toHaveBeenCalled();
    mongoose.connection.readyState = 1;
    BridgeUsageDay.findOneAndUpdate.mockReturnValue({ lean: () => Promise.reject(new Error('mongo went away')) });
    expect(await q.takeQuota(key(), 'searches')).toMatchObject({ allowed: true, counted: false });
  });
});

describe('quota middleware', () => {
  test('429 with code quota when over, quota headers otherwise', async () => {
    const res = () => { const r = { status: jest.fn(() => r), json: jest.fn(() => r), set: jest.fn(() => r) }; return r; };
    BridgeUsageDay.findOneAndUpdate.mockReturnValue(lean({ changeChecks: 2 }));
    let r = res(); let next = jest.fn();
    await q.quota('changeChecks')({ bridge: { keyDoc: key() } }, r, next);
    expect(r.status).toHaveBeenCalledWith(429);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'quota', kind: 'changeChecks', cap: 1 }));
    expect(next).not.toHaveBeenCalled();

    BridgeUsageDay.findOneAndUpdate.mockReturnValue(lean({ changeChecks: 1 }));
    r = res(); next = jest.fn();
    await q.quota('changeChecks')({ bridge: { keyDoc: key() } }, r, next);
    expect(next).toHaveBeenCalled();
    expect(r.set).toHaveBeenCalledWith('X-Bridge-Quota-Remaining', '0');
  });
});

describe('usageFor / openImportWindow', () => {
  test('usage summary carries today\'s spend, every cap and the import-window state', async () => {
    BridgeUsageDay.findOne.mockReturnValue({ lean: () => ({ catch: () => Promise.resolve({ searches: 12, fetches: 3 }) }) });
    const opened = new Date(Date.now() - 5 * 86400e3);
    const u = await q.usageFor(key({ importWindowOpenedAt: opened, importWindowUntil: new Date(opened.getTime() + 86400e3) }));
    expect(u.used).toEqual({ searches: 12, fetches: 3, changeChecks: 0, contributions: 0 });
    expect(u.caps).toEqual({ searches: 600, fetches: 300, changeChecks: 1, contributions: 50 });
    expect(u.importWindow.active).toBe(false);
    expect(u.importWindow.nextAvailableAt.getTime()).toBe(opened.getTime() + q.IMPORT_COOLDOWN_MS);
  });

  test('opening the window sets 24 hours on every active key of the ACCOUNT', async () => {
    const first = await q.openImportWindow(key());
    expect(first.ok).toBe(true);
    expect(first.until.getTime() - Date.now()).toBeGreaterThan(q.IMPORT_WINDOW_MS - 5000);
    // Every active key of the owner, so the sync capFor(keyDoc) stays right
    // whichever key makes the next request.
    expect(BridgeKey.updateMany).toHaveBeenCalledWith(
      { user: 'u1', revokedAt: null },
      { $set: expect.objectContaining({ importWindowUntil: first.until }) }
    );
  });

  test('the 30-day cooldown is per ACCOUNT — a freshly minted key does not reset it', async () => {
    // The cooldown lookup asks about the OWNER, not the key in hand: a brand
    // new key with importWindowOpenedAt: null used to grant ×5 immediately
    // (audit 2026-09-08).
    openedAt(new Date(Date.now() - 10 * 86400e3));
    const again = await q.openImportWindow(key({ importWindowOpenedAt: null }));
    expect(again.ok).toBe(false);
    expect(again.nextAvailableAt).toBeInstanceOf(Date);
    expect(BridgeKey.findOne).toHaveBeenCalledWith(expect.objectContaining({ user: 'u1' }));
    expect(BridgeKey.updateMany).not.toHaveBeenCalled();

    // Older than the cooldown: the real query filters on
    // `importWindowOpenedAt >= now - 30 days`, so it finds nothing.
    openedAt(null);
    const later = await q.openImportWindow(key({ importWindowOpenedAt: new Date(Date.now() - 31 * 86400e3) }));
    expect(later.ok).toBe(true);
    expect(BridgeKey.findOne.mock.calls[BridgeKey.findOne.mock.calls.length - 1][0].importWindowOpenedAt.$gte)
      .toBeInstanceOf(Date);
  });
});

describe('runtime caps', () => {
  const rateLimitsConfig = require('../config/rateLimits');
  afterEach(() => rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults))));

  test('capsNow follows the admin-tuned bridge group, field by field, and falls back to the constants', () => {
    expect(q.capsNow()).toEqual({ searches: 600, fetches: 300, changeChecks: 1, contributions: 50 });
    rateLimitsConfig.set({ ...rateLimitsConfig.get(), bridge: { fetches: 1000, searches: 0, changeChecks: 'x' } });
    expect(q.capsNow()).toEqual({ searches: 600, fetches: 1000, changeChecks: 1, contributions: 50 });
    expect(q.capFor('fetches', key())).toBe(1000);
    expect(q.capFor('fetches', key({ importWindowUntil: new Date(Date.now() + 3600e3) }))).toBe(5000);
    expect(q.capFor('searches', key())).toBe(600);
  });

  test('usageFor reports the caps in force, not the constants', async () => {
    rateLimitsConfig.set({ ...rateLimitsConfig.get(), bridge: { ...rateLimitsConfig.get().bridge, searches: 50 } });
    BridgeUsageDay.findOne.mockReturnValue(lean(null));
    const u = await q.usageFor(key());
    expect(u.caps.searches).toBe(50);
    expect(u.caps.fetches).toBe(300);
  });
});
