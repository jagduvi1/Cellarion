const User = require('./User');
const { normalizeLegacyNotifications } = User;

describe('toJSON', () => {
  it('exposes id as a string copy of _id (frontend ownership checks use user.id)', () => {
    const user = new User({ username: 'alice', email: 'alice@cellarion.app', password: 'x' });
    const json = user.toJSON();
    expect(json.id).toBe(user._id.toString());
    expect(typeof json.id).toBe('string');
  });

  it('still strips sensitive fields', () => {
    const user = new User({ username: 'alice', email: 'alice@cellarion.app', password: 'x' });
    const json = user.toJSON();
    expect(json.password).toBeUndefined();
    expect(json.refreshTokenHash).toBeUndefined();
    expect(json.stripeCustomerId).toBeUndefined();
  });

  it('strips failedLoginAttempts and stripeSubscriptionId (I-1 data minimisation)', () => {
    const user = new User({
      username: 'alice',
      email: 'alice@cellarion.app',
      password: 'x',
      stripeSubscriptionId: 'sub_123',
      failedLoginAttempts: { count: 3, firstFailedAt: new Date() }
    });
    const json = user.toJSON();
    expect(json.failedLoginAttempts).toBeUndefined();
    expect(json.stripeSubscriptionId).toBeUndefined();
  });

  it('exposes hasStripeSubscription as a derived boolean instead of the raw id', () => {
    const without = new User({ username: 'a', email: 'a@cellarion.app', password: 'x' });
    expect(without.toJSON().hasStripeSubscription).toBe(false);

    const withSub = new User({
      username: 'b', email: 'b@cellarion.app', password: 'x', stripeSubscriptionId: 'sub_123'
    });
    expect(withSub.toJSON().hasStripeSubscription).toBe(true);
  });
});

describe('BCRYPT_COST (L-1)', () => {
  it('is exported and set to 12', () => {
    expect(User.BCRYPT_COST).toBe(12);
  });

  it('matches the cost of the login route DUMMY_HASH so the timing oracle stays closed', () => {
    // Parse the literal out of routes/auth.js rather than requiring the module
    // (the route pulls in mailgun/rate-limit config not needed here). The route
    // also self-checks at load time and throws on drift.
    const fs = require('fs');
    const path = require('path');
    const bcrypt = require('bcryptjs');
    const src = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
    const match = src.match(/DUMMY_HASH = '(\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53})'/);
    expect(match).not.toBeNull();
    expect(bcrypt.getRounds(match[1])).toBe(User.BCRYPT_COST);
  });
});

describe('normalizeLegacyNotifications', () => {
  it('returns [] when notif is null/undefined', () => {
    expect(normalizeLegacyNotifications(null)).toEqual([]);
    expect(normalizeLegacyNotifications(undefined)).toEqual([]);
  });

  it('returns [] when notif has no fields', () => {
    expect(normalizeLegacyNotifications({})).toEqual([]);
  });

  it('returns [] when all four fields are already objects (no migration needed)', () => {
    const notif = {
      drinkWindow:      { enabled: true,  email: false, push: false },
      communityReply:   { email: false, push: true },
      communityMention: { email: false, push: true },
      communityFollow:  { push: true }
    };
    const before = JSON.parse(JSON.stringify(notif));
    expect(normalizeLegacyNotifications(notif)).toEqual([]);
    expect(notif).toEqual(before); // unchanged
  });

  describe('drinkWindow: bool → object', () => {
    it('preserves a false value as enabled=false', () => {
      const notif = { drinkWindow: false };
      const changed = normalizeLegacyNotifications(notif);
      expect(changed).toEqual(['drinkWindow']);
      expect(notif.drinkWindow).toEqual({ enabled: false, email: false, push: false });
    });

    it('preserves a true value as enabled=true', () => {
      const notif = { drinkWindow: true };
      normalizeLegacyNotifications(notif);
      expect(notif.drinkWindow).toEqual({ enabled: true, email: false, push: false });
    });
  });

  describe('community fields: bool → object', () => {
    it('communityReply: true → { email: false, push: true }', () => {
      const notif = { communityReply: true };
      expect(normalizeLegacyNotifications(notif)).toEqual(['communityReply']);
      expect(notif.communityReply).toEqual({ email: false, push: true });
    });

    it('communityReply: false → { email: false, push: false }', () => {
      const notif = { communityReply: false };
      normalizeLegacyNotifications(notif);
      expect(notif.communityReply).toEqual({ email: false, push: false });
    });

    it('communityMention: true → { email: false, push: true }', () => {
      const notif = { communityMention: true };
      normalizeLegacyNotifications(notif);
      expect(notif.communityMention).toEqual({ email: false, push: true });
    });

    it('communityFollow: true → { push: true } (no email channel)', () => {
      const notif = { communityFollow: true };
      normalizeLegacyNotifications(notif);
      expect(notif.communityFollow).toEqual({ push: true });
    });

    it('communityFollow: false → { push: false }', () => {
      const notif = { communityFollow: false };
      normalizeLegacyNotifications(notif);
      expect(notif.communityFollow).toEqual({ push: false });
    });
  });

  it('migrates all four fields when all are bools, returns each key', () => {
    const notif = {
      drinkWindow: false,
      communityReply: true,
      communityMention: false,
      communityFollow: true
    };
    const changed = normalizeLegacyNotifications(notif);
    expect(changed.sort()).toEqual([
      'communityFollow', 'communityMention', 'communityReply', 'drinkWindow'
    ]);
    expect(notif.drinkWindow).toEqual({ enabled: false, email: false, push: false });
    expect(notif.communityReply).toEqual({ email: false, push: true });
    expect(notif.communityMention).toEqual({ email: false, push: false });
    expect(notif.communityFollow).toEqual({ push: true });
  });

  it('only migrates the bool fields when mixed with already-object fields', () => {
    const notif = {
      drinkWindow: false,                                      // bool — should migrate
      communityReply: { email: true, push: true },             // already object — preserve
      communityMention: false,                                 // bool — should migrate
      communityFollow: { push: false }                         // already object — preserve
    };
    const changed = normalizeLegacyNotifications(notif);
    expect(changed.sort()).toEqual(['communityMention', 'drinkWindow']);
    expect(notif.communityReply).toEqual({ email: true, push: true });
    expect(notif.communityFollow).toEqual({ push: false });
  });
});
