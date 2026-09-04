/**
 * Per-device sessions (services/authTokens.js), unit level.
 *
 * The account used to hold ONE refresh-token hash, so signing in on the phone
 * signed the laptop out (2026-09-04: 247 of 313 consecutive logins on the
 * hosted instance were the same person switching devices). These tests pin
 * the replacement: one `sessions[]` entry per device, rotation touches only
 * its own entry, a cap with least-recently-used eviction, expiry pruning, and
 * reuse detection with a grace window for lost tab races.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/User', () => ({ findOne: jest.fn() }));

const crypto = require('crypto');
const User = require('../models/User');
const tokens = require('./authTokens');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const NOW = 1756944000000; // 2026-09-04T00:00:00Z
const DAY = 24 * 60 * 60 * 1000;

const makeUser = (overrides = {}) => ({
  _id: 'u1', roles: ['user'], plan: 'free', sessions: [],
  refreshTokenHash: null, refreshTokenExpiresAt: null, refreshTokenPersistent: null,
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});
const makeRes = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });
const cookieValue = (res) => res.cookie.mock.calls[res.cookie.mock.calls.length - 1][1];
const reqWith = (ua) => ({ headers: { 'user-agent': ua } });

let nowSpy;
beforeEach(() => {
  jest.clearAllMocks();
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => nowSpy.mockRestore());

describe('issueTokens — starting a device session', () => {
  test('adds one entry with a fresh 30-day cap, the remember-me choice and the device label', async () => {
    const user = makeUser();
    const res = makeRes();
    await tokens.issueTokens(user, res, { rememberMe: true, client: 'Android / Chrome' });

    expect(user.sessions).toHaveLength(1);
    const s = user.sessions[0];
    expect(s.hash).toBe(sha256(cookieValue(res)));
    expect(s.prevHash).toBeNull();
    expect(s.expiresAt.getTime()).toBe(NOW + 30 * DAY);
    expect(s.persistent).toBe(true);
    expect(s.client).toBe('Android / Chrome');
    expect(user.save).toHaveBeenCalledTimes(1);
    // persistent cookie
    expect(res.cookie.mock.calls[0][2].maxAge).toBe(7 * DAY);
  });

  test('a second device adds a second entry and leaves the first untouched', async () => {
    const user = makeUser();
    await tokens.issueTokens(user, makeRes(), { client: 'Windows / Firefox' });
    const first = { ...user.sessions[0] };

    await tokens.issueTokens(user, makeRes(), { client: 'iOS / Safari' });

    expect(user.sessions).toHaveLength(2);
    expect(user.sessions[0]).toEqual(first);
    expect(user.sessions[1].client).toBe('iOS / Safari');
  });

  test('rememberMe=false → session cookie and a non-persistent entry', async () => {
    const user = makeUser();
    const res = makeRes();
    await tokens.issueTokens(user, res, { rememberMe: false });
    expect(user.sessions[0].persistent).toBe(false);
    expect(res.cookie.mock.calls[0][2].maxAge).toBeUndefined();
  });

  test('an explicit expiresAt (demo TTL) replaces the 30-day default', async () => {
    const user = makeUser();
    const ttl = new Date(NOW + 2 * 60 * 60 * 1000);
    await tokens.issueTokens(user, makeRes(), { expiresAt: ttl });
    expect(user.sessions[0].expiresAt).toBe(ttl);
  });

  test('past the cap, the least recently used entry is evicted first', async () => {
    const user = makeUser();
    for (let i = 0; i < tokens.MAX_SESSIONS_PER_USER; i++) {
      nowSpy.mockReturnValue(NOW + i * 1000);
      await tokens.issueTokens(user, makeRes(), { client: `device-${i}` });
    }
    // device-3 was used most recently of the old ones; device-0 is the stalest
    user.sessions[3].lastUsedAt = new Date(NOW + 999999);
    nowSpy.mockReturnValue(NOW + 100000);

    await tokens.issueTokens(user, makeRes(), { client: 'device-new' });

    expect(user.sessions).toHaveLength(tokens.MAX_SESSIONS_PER_USER);
    const labels = user.sessions.map((s) => s.client);
    expect(labels).not.toContain('device-0');
    expect(labels).toContain('device-3');
    expect(labels).toContain('device-new');
  });

  test('expired entries are pruned when a new device signs in', async () => {
    const user = makeUser({ sessions: [
      { hash: 'dead', prevHash: null, expiresAt: new Date(NOW - 1), persistent: true, createdAt: new Date(NOW - DAY), lastUsedAt: new Date(NOW - DAY), client: 'old' },
      { hash: 'live', prevHash: null, expiresAt: new Date(NOW + DAY), persistent: true, createdAt: new Date(NOW - DAY), lastUsedAt: new Date(NOW - DAY), client: 'still here' },
    ] });
    await tokens.issueTokens(user, makeRes(), { client: 'new' });
    expect(user.sessions.map((s) => s.client)).toEqual(['still here', 'new']);
  });
});

describe('issueTokens — rotating one device session', () => {
  test('rotates only its own entry: new hash, old hash kept as prevHash, deadline preserved', async () => {
    const user = makeUser();
    await tokens.issueTokens(user, makeRes(), { client: 'phone' });
    await tokens.issueTokens(user, makeRes(), { client: 'laptop' });
    const [phone, laptop] = user.sessions;
    const phoneBefore = { ...phone };
    const laptopHash = laptop.hash;
    const deadline = laptop.expiresAt;

    nowSpy.mockReturnValue(NOW + 5 * DAY);
    const res = makeRes();
    await tokens.issueTokens(user, res, { session: laptop });

    expect(laptop.hash).toBe(sha256(cookieValue(res)));
    expect(laptop.prevHash).toBe(laptopHash);
    expect(laptop.rotatedAt.getTime()).toBe(NOW + 5 * DAY);
    expect(laptop.lastUsedAt.getTime()).toBe(NOW + 5 * DAY);
    expect(laptop.expiresAt).toBe(deadline); // not extended
    expect(user.sessions[0]).toEqual(phoneBefore); // the other device untouched
  });

  test('a legacy entry with no deadline is backfilled with a fresh cap on rotation', async () => {
    const user = makeUser({ sessions: [{ hash: 'h', prevHash: null, expiresAt: null, persistent: true, createdAt: new Date(NOW), lastUsedAt: new Date(NOW), client: 'x' }] });
    await tokens.issueTokens(user, makeRes(), { session: user.sessions[0] });
    expect(user.sessions[0].expiresAt.getTime()).toBe(NOW + 30 * DAY);
  });

  test('rotation keeps a non-persistent session on a session cookie', async () => {
    const user = makeUser();
    await tokens.issueTokens(user, makeRes(), { rememberMe: false });
    const res = makeRes();
    await tokens.issueTokens(user, res, { session: user.sessions[0] });
    expect(res.cookie.mock.calls[0][2].maxAge).toBeUndefined();
    expect(user.sessions[0].persistent).toBe(false);
  });
});

describe('resolveRefreshSession', () => {
  const plant = (user, { rotatedAgoMs } = {}) => {
    const raw = crypto.randomBytes(64).toString('hex');
    const entry = { hash: sha256(raw), prevHash: null, rotatedAt: null, expiresAt: new Date(NOW + DAY), persistent: true, createdAt: new Date(NOW), lastUsedAt: new Date(NOW), client: 'c' };
    if (rotatedAgoMs !== undefined) {
      entry.prevHash = entry.hash;
      entry.hash = sha256('rotated-' + raw);
      entry.rotatedAt = new Date(NOW - rotatedAgoMs);
    }
    user.sessions.push(entry);
    return { raw, entry };
  };
  const wireLookup = (user) => {
    User.findOne.mockImplementation(async (q) => {
      const [k, v] = Object.entries(q)[0];
      if (k === 'sessions.hash') return user.sessions.some((s) => s.hash === v) ? user : null;
      if (k === 'sessions.prevHash') return user.sessions.some((s) => s.prevHash === v) ? user : null;
      if (k === 'refreshTokenHash') return user.refreshTokenHash === v ? user : null;
      return null;
    });
  };

  test('a live token resolves to its own device entry', async () => {
    const user = makeUser();
    plant(user);
    const { raw, entry } = plant(user);
    wireLookup(user);
    const found = await tokens.resolveRefreshSession(raw);
    expect(found.user).toBe(user);
    expect(found.session).toBe(entry);
    expect(found.reused).toBeUndefined();
  });

  test('a token rotated away 10 s ago is a race, not theft', async () => {
    const user = makeUser();
    const { raw } = plant(user, { rotatedAgoMs: 10 * 1000 });
    wireLookup(user);
    const found = await tokens.resolveRefreshSession(raw);
    expect(found.reused).toBe(true);
    expect(found.race).toBe(true);
  });

  test('a token rotated away 5 minutes ago is reuse', async () => {
    const user = makeUser();
    const { raw } = plant(user, { rotatedAgoMs: 5 * 60 * 1000 });
    wireLookup(user);
    const found = await tokens.resolveRefreshSession(raw);
    expect(found.reused).toBe(true);
    expect(found.race).toBe(false);
  });

  test('a pre-sessions single-token row is adopted into sessions[] with its deadline and remember-me', async () => {
    const raw = crypto.randomBytes(64).toString('hex');
    const user = makeUser({ refreshTokenHash: sha256(raw), refreshTokenExpiresAt: new Date(NOW + 3 * DAY), refreshTokenPersistent: false });
    wireLookup(user);

    const found = await tokens.resolveRefreshSession(raw);

    expect(found.migrated).toBe(true);
    expect(user.sessions).toHaveLength(1);
    expect(found.session).toBe(user.sessions[0]);
    expect(found.session.hash).toBe(sha256(raw));
    expect(found.session.expiresAt.getTime()).toBe(NOW + 3 * DAY);
    expect(found.session.persistent).toBe(false);
    expect(user.refreshTokenHash).toBeNull();
    expect(user.refreshTokenExpiresAt).toBeNull();
    expect(user.refreshTokenPersistent).toBeNull();
  });

  test('unknown token → null', async () => {
    const user = makeUser();
    plant(user);
    wireLookup(user);
    expect(await tokens.resolveRefreshSession('nope')).toBeNull();
  });
});

describe('helpers', () => {
  test('revokeAllSessions empties the list and the legacy fields', () => {
    const user = makeUser({ sessions: [{ hash: 'a' }], refreshTokenHash: 'x', refreshTokenExpiresAt: new Date(), refreshTokenPersistent: true });
    tokens.revokeAllSessions(user);
    expect(user.sessions).toEqual([]);
    expect(user.refreshTokenHash).toBeNull();
    expect(user.refreshTokenExpiresAt).toBeNull();
    expect(user.refreshTokenPersistent).toBeNull();
  });

  test('removeSession drops exactly that device', () => {
    const user = makeUser({ sessions: [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }] });
    tokens.removeSession(user, { hash: 'b' });
    expect(user.sessions.map((s) => s.hash)).toEqual(['a', 'c']);
  });

  test('sessionForCookie finds the entry behind the request cookie', () => {
    const raw = 'tok';
    const user = makeUser({ sessions: [{ hash: 'other' }, { hash: sha256(raw) }] });
    expect(tokens.sessionForCookie(user, { cookies: { refreshToken: raw } })).toBe(user.sessions[1]);
    expect(tokens.sessionForCookie(user, { cookies: {} })).toBeNull();
  });

  test.each([
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36', 'Android / Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Windows / Firefox'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'iOS / Safari'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0', 'Windows / Edge'],
    ['', 'Unknown device'],
  ])('clientHint labels %s as %s', (ua, label) => {
    expect(tokens.clientHint(reqWith(ua))).toBe(label);
  });

  test('clientHint never stores the raw user-agent', () => {
    const label = tokens.clientHint(reqWith('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36 SecretBuild/1.2.3'));
    expect(label).toBe('Linux / Chrome');
    expect(label).not.toContain('SecretBuild');
  });
});
