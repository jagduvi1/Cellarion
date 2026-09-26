/**
 * services/authTokens.issueTokens — two sign-ins of one account at the same
 * moment (a double-clicked button, two devices). Both add a session to the
 * same user document and Mongoose's version check fails the later save. The
 * pure-JS bcrypt hid this by serialising logins on the event loop; native
 * bcrypt lets them overlap, and a burst of 8 logins returned 7 × "Login
 * failed" in the Docker smoke before this.
 *
 * Pinned: the conflict is replayed on a fresh copy (keeping the other
 * sign-in's session), never when the doc carries other unsaved changes (a
 * password change persists through here), other errors are not retried,
 * and it gives up after a few attempts.
 */
jest.mock('../models/User', () => ({ findById: jest.fn(), findOne: jest.fn() }));

process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-use';
const User = require('../models/User');
const { issueTokens } = require('./authTokens');

const versionError = () => Object.assign(new Error('No matching document found for id "u1" version 3 modifiedPaths "sessions"'), { name: 'VersionError' });
const res = () => ({ cookie: jest.fn() });

// A minimal stand-in for a Mongoose user document.
function doc({ sessions = [], modified = [], isNew = false, save }) {
  return {
    _id: 'u1', roles: ['user'], plan: 'free', isNew,
    sessions: sessions.map((s) => ({ ...s })),
    modifiedPaths: () => modified,
    save: save || jest.fn().mockResolvedValue(undefined),
  };
}
const other = { hash: 'other-device', lastUsedAt: new Date(), createdAt: new Date(), expiresAt: new Date(Date.now() + 86400e3) };

beforeEach(() => jest.clearAllMocks());

test('a conflicting save is replayed on a fresh copy — the other sign-in\'s session stays', async () => {
  const stale = doc({ save: jest.fn().mockRejectedValue(versionError()) });
  const fresh = doc({ sessions: [other] }); // the concurrent login already landed
  User.findById.mockResolvedValue(fresh);
  const r = res();

  const token = await issueTokens(stale, r, { rememberMe: true, client: 'Windows / Edge' });

  expect(typeof token).toBe('string');
  expect(User.findById).toHaveBeenCalledWith('u1');
  expect(fresh.save).toHaveBeenCalledTimes(1);
  expect(fresh.sessions.map((s) => s.hash)).toEqual(['other-device', expect.stringMatching(/^[a-f0-9]{64}$/)]);
  expect(fresh.sessions[1].client).toBe('Windows / Edge');
  expect(r.cookie).toHaveBeenCalledWith('refreshToken', expect.any(String), expect.any(Object));
});

test('a doc with other unsaved changes is never replayed (a password change must not be dropped)', async () => {
  const changing = doc({ modified: ['password', 'sessions', 'refreshTokenHash'], save: jest.fn().mockRejectedValue(versionError()) });
  await expect(issueTokens(changing, res(), {})).rejects.toThrow(/No matching document/);
  expect(User.findById).not.toHaveBeenCalled();
});

test('other errors are thrown as they are', async () => {
  const failing = doc({ save: jest.fn().mockRejectedValue(new Error('connection closed')) });
  await expect(issueTokens(failing, res(), {})).rejects.toThrow('connection closed');
  expect(User.findById).not.toHaveBeenCalled();
});

test('gives up after five attempts', async () => {
  const stale = doc({ save: jest.fn().mockRejectedValue(versionError()) });
  User.findById.mockImplementation(async () => doc({ save: jest.fn().mockRejectedValue(versionError()) }));
  const r = res();
  await expect(issueTokens(stale, r, {})).rejects.toThrow(/No matching document/);
  expect(User.findById).toHaveBeenCalledTimes(4); // 1 + 4 replays
  expect(r.cookie).not.toHaveBeenCalled();
});

test('a brand-new account (registration) is saved once, nothing to replay', async () => {
  const created = doc({ isNew: true });
  await issueTokens(created, res(), {});
  expect(created.save).toHaveBeenCalledTimes(1);
  expect(created.sessions).toHaveLength(1);
});
