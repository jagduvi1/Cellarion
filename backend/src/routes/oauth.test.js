/**
 * Tests for the Google SSO account-resolution logic (upsertGoogleUser).
 *
 * WHY THIS TEST EXISTS:
 * upsertGoogleUser is the heart of the SSO flow — it decides, for an incoming
 * Google profile, whether to return an already-linked account, link Google to
 * an existing email account, or create a fresh one. Getting the branches or the
 * verified-email guard wrong means duplicate accounts or account takeover, so
 * the contract is pinned here.
 *
 * The User model is mocked with a tiny in-memory store so the branching logic
 * is exercised without a database (the suite has no Mongo).
 */

process.env.JWT_SECRET = 'test-secret';

// In-memory fake of the Mongoose User model supporting exactly the calls
// upsertGoogleUser / generateUniqueUsername make: findOne (by provider, email,
// or username — the username form is chained .select().lean()) and doc.save().
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
    if (query['authProviders.provider']) {
      result = store.users.find((u) =>
        (u.authProviders || []).some(
          (p) => p.provider === query['authProviders.provider'] && p.providerId === query['authProviders.providerId']
        )
      ) || null;
    } else if (query.email) {
      result = store.users.find((u) => u.email === query.email) || null;
    } else if (query.username) {
      result = store.users.find((u) => u.username === query.username) || null;
    }
    // Thenable that also supports the .select().lean() chain used for the
    // username-uniqueness probe.
    const chain = {
      select: () => chain,
      lean: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };

  User.__store = store;
  User.__seed = (doc) => {
    const u = new User(doc);
    store.users.push(u);
    return u;
  };
  return User;
});

const User = require('../models/User');
const { upsertSsoUser, upsertGoogleUser, generateUniqueUsername } = require('./oauth');

const googleProfile = (overrides = {}) => ({
  id: 'google-1',
  displayName: 'Jane Doe',
  emails: [{ value: 'jane@example.com', verified: true }],
  _json: { email_verified: true },
  ...overrides,
});

beforeEach(() => {
  User.__store.users.length = 0;
});

describe('upsertGoogleUser', () => {
  test('creates a new account for a first-time Google user', async () => {
    const user = await upsertGoogleUser(googleProfile());

    expect(User.__store.users).toHaveLength(1);
    expect(user.email).toBe('jane@example.com');
    expect(user.emailVerified).toBe(true);
    expect(user.roles).toEqual(['user']);
    expect(user.username).toBe('jane');
    expect(user.authProviders).toEqual([{ provider: 'google', providerId: 'google-1' }]);
    // GDPR consent must NOT be pre-stamped — the ReconsentModal collects it.
    expect(user.gdprConsent).toBeUndefined();
  });

  test('returns the SAME account when the provider id is already linked (no duplicate)', async () => {
    const first = await upsertGoogleUser(googleProfile());
    const second = await upsertGoogleUser(googleProfile());

    expect(second).toBe(first);
    expect(User.__store.users).toHaveLength(1);
  });

  test('links Google to an existing account with the same verified email', async () => {
    const existing = User.__seed({
      username: 'bob',
      email: 'bob@example.com',
      password: 'hashed',
      emailVerified: false,
      authProviders: [],
    });

    const user = await upsertGoogleUser(
      googleProfile({ id: 'google-99', emails: [{ value: 'bob@example.com', verified: true }] })
    );

    expect(user).toBe(existing); // linked, not duplicated
    expect(User.__store.users).toHaveLength(1);
    expect(user.authProviders).toContainEqual({ provider: 'google', providerId: 'google-99' });
    expect(user.emailVerified).toBe(true); // upgraded — Google verified it
    expect(user.password).toBe('hashed'); // password untouched
  });

  test('matches email case-insensitively when linking', async () => {
    const existing = User.__seed({ username: 'carol', email: 'carol@example.com', authProviders: [] });

    const user = await upsertGoogleUser(
      googleProfile({ id: 'google-7', emails: [{ value: 'Carol@Example.com', verified: true }] })
    );

    expect(user).toBe(existing);
    expect(User.__store.users).toHaveLength(1);
  });

  test('rejects an unverified Google email (no link, no create)', async () => {
    await expect(
      upsertGoogleUser(googleProfile({ emails: [{ value: 'x@example.com', verified: false }], _json: { email_verified: false } }))
    ).rejects.toMatchObject({ code: 'no_verified_email' });
    expect(User.__store.users).toHaveLength(0);
  });

  test('rejects a profile with no email', async () => {
    await expect(
      upsertGoogleUser(googleProfile({ emails: undefined, _json: {} }))
    ).rejects.toMatchObject({ code: 'no_verified_email' });
  });

  test('an already-linked account is returned even if its email is now unverified upstream', async () => {
    // Linked accounts short-circuit before the verified-email guard.
    const existing = User.__seed({
      username: 'dave',
      email: 'dave@example.com',
      authProviders: [{ provider: 'google', providerId: 'google-linked' }],
    });
    const user = await upsertGoogleUser(
      googleProfile({ id: 'google-linked', emails: [{ value: 'dave@example.com', verified: false }], _json: { email_verified: false } })
    );
    expect(user).toBe(existing);
  });
});

describe('upsertSsoUser — the provider-neutral core', () => {
  const oidcClaims = (overrides = {}) => ({
    providerId: 'oidc-1',
    email: 'erin@example.com',
    emailVerified: true,
    displayName: 'Erin Example',
    ...overrides,
  });

  test('creates an account tagged with the given provider, not google', async () => {
    const user = await upsertSsoUser('oidc', oidcClaims());
    expect(User.__store.users).toHaveLength(1);
    expect(user.authProviders).toEqual([{ provider: 'oidc', providerId: 'oidc-1' }]);
    expect(user.email).toBe('erin@example.com');
    expect(user.emailVerified).toBe(true);
    expect(user.gdprConsent).toBeUndefined();
  });

  test('lowercases the email before matching, like the Google path', async () => {
    const existing = User.__seed({ username: 'erin', email: 'erin@example.com', authProviders: [] });
    const user = await upsertSsoUser('oidc', oidcClaims({ providerId: 'oidc-9', email: 'Erin@Example.COM' }));
    expect(user).toBe(existing);
    expect(User.__store.users).toHaveLength(1);
  });

  test('an unverified claim is rejected by default (trustEmailVerified off)', async () => {
    await expect(
      upsertSsoUser('oidc', oidcClaims({ emailVerified: false }))
    ).rejects.toMatchObject({ code: 'no_verified_email' });
    expect(User.__store.users).toHaveLength(0);
  });

  test('an unverified claim links when the operator has opted in via trustEmailVerified', async () => {
    // Pocket ID reports email_verified:false by default; the operator asserts
    // trust for their own issuer with OIDC_TRUST_EMAIL_VERIFIED.
    const user = await upsertSsoUser(
      'oidc',
      oidcClaims({ emailVerified: false }),
      { trustEmailVerified: true }
    );
    expect(user.email).toBe('erin@example.com');
    expect(user.emailVerified).toBe(true);
  });

  test('trustEmailVerified does not rescue a claim with no email at all', async () => {
    await expect(
      upsertSsoUser('oidc', oidcClaims({ email: null, emailVerified: false }), { trustEmailVerified: true })
    ).rejects.toMatchObject({ code: 'no_verified_email' });
  });

  test('a linked (provider, providerId) short-circuits before the verified-email guard', async () => {
    const existing = User.__seed({
      username: 'frank',
      email: 'frank@example.com',
      authProviders: [{ provider: 'oidc', providerId: 'oidc-linked' }],
    });
    const user = await upsertSsoUser('oidc', oidcClaims({ providerId: 'oidc-linked', emailVerified: false }));
    expect(user).toBe(existing);
  });

  test('the same providerId under a different provider is NOT treated as linked', async () => {
    User.__seed({
      username: 'grace',
      email: 'grace@example.com',
      authProviders: [{ provider: 'google', providerId: 'shared-id' }],
    });
    // Same providerId string, different provider → a new account, not a link.
    const user = await upsertSsoUser('oidc', oidcClaims({ providerId: 'shared-id', email: 'grace2@example.com' }));
    expect(User.__store.users).toHaveLength(2);
    expect(user.authProviders).toEqual([{ provider: 'oidc', providerId: 'shared-id' }]);
  });
});

describe('generateUniqueUsername', () => {
  test('derives a lowercase handle from the email local-part', async () => {
    expect(await generateUniqueUsername('Johan@accure.se', 'Johan')).toBe('johan');
  });

  test('strips characters that are not allowed in usernames', async () => {
    expect(await generateUniqueUsername('a.b+tag@x.com', '')).toBe('a.btag');
  });

  test('pads a too-short handle to satisfy the 3-char minimum', async () => {
    expect(await generateUniqueUsername('ab@x.com', '')).toBe('abuser');
  });

  test('appends a suffix when the base handle is taken', async () => {
    User.__seed({ username: 'jane', email: 'other@example.com' });
    const name = await generateUniqueUsername('jane@example.com', 'Jane');
    expect(name).not.toBe('jane');
    expect(name).toMatch(/^jane-[0-9a-f]{4}$/);
  });

  test('always returns a schema-valid username', async () => {
    for (const email of ['日本@x.com', 'X@x.com', 'a_b.c-d@x.com']) {
      const name = await generateUniqueUsername(email, '');
      expect(name.length).toBeGreaterThanOrEqual(3);
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name).toMatch(/^[a-z0-9_.-]+$/);
    }
  });
});
