/**
 * SSO sign-up never derives a reserved system name.
 *
 * WHY THIS TEST EXISTS:
 * A first-time Google or OIDC user gets a username derived from the email
 * local part. The "[deleted]" sentinel is found by its username and inherits
 * every erased member's forum content, so an address like
 * "__deleted__@example.com" must not hand its owner that name while it is
 * still free. A reserved local part is trimmed to an ordinary handle instead.
 */
process.env.JWT_SECRET = 'test-secret';

// Just enough of the User model for generateUniqueUsername / upsertSsoUser:
// findOne (by provider, email or username; the username probe chains
// .select().lean()) and doc.save().
jest.mock('../models/User', () => {
  const store = { users: [] };

  function User(doc) {
    Object.assign(this, doc);
    this.authProviders = doc.authProviders || [];
    this._id = doc._id || `id-${store.users.length + 1}`;
  }
  User.prototype.save = async function save() {
    if (!store.users.includes(this)) store.users.push(this);
    return this;
  };
  User.findOne = (query) => {
    let result = null;
    if (query.username) result = store.users.find((u) => u.username === query.username) || null;
    else if (query.email) result = store.users.find((u) => u.email === query.email) || null;
    const chain = {
      select: () => chain,
      lean: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };
  User.__store = store;
  return User;
});

const User = require('../models/User');
const { generateUniqueUsername, upsertSsoUser } = require('./oauth');
const { isReservedUsername } = require('../utils/deletedUser');

beforeEach(() => { User.__store.users.length = 0; });

test('the sentinel local part yields an ordinary handle, not the sentinel', async () => {
  const name = await generateUniqueUsername('__deleted__@example.com', '');
  expect(name).not.toBe('__deleted__');
  expect(isReservedUsername(name)).toBe(false);
  expect(name).toBe('deleted__');
});

test('any double-underscore local part is trimmed to an ordinary handle', async () => {
  const name = await generateUniqueUsername('__System@example.com', '');
  expect(name).toBe('system');
});

test('the display-name fallback is trimmed the same way', async () => {
  const name = await generateUniqueUsername('@example.com', '__deleted__');
  expect(isReservedUsername(name)).toBe(false);
});

test('a local part of only underscores still yields a schema-valid handle', async () => {
  const name = await generateUniqueUsername('____@example.com', '');
  expect(isReservedUsername(name)).toBe(false);
  expect(name).toMatch(/^[a-z0-9_.-]{3,30}$/);
});

test('when the trimmed handle is taken the suffixed one is not reserved either', async () => {
  await new User({ username: 'deleted__', email: 'someone@example.com' }).save();
  const name = await generateUniqueUsername('__deleted__@example.com', '');
  expect(name).toMatch(/^deleted__-[0-9a-f]{4}$/);
  expect(isReservedUsername(name)).toBe(false);
});

test('a single leading underscore is an ordinary handle and is kept', async () => {
  expect(await generateUniqueUsername('_jane@example.com', '')).toBe('_jane');
});

test('a brand-new SSO account with a sentinel-shaped address gets an ordinary username', async () => {
  const user = await upsertSsoUser('google', {
    providerId: 'g-1', email: '__deleted__@example.com', emailVerified: true, displayName: 'Someone',
  });
  expect(isReservedUsername(user.username)).toBe(false);
});
