const { shouldSendDigestEmail } = require('./drinkWindowNotifier');

/**
 * Regression coverage for the "silently dead digest" bug: the email opt-in
 * lives at preferences.notifications.drinkWindow.email, NOT a top-level
 * notifications.email flag. Reading the wrong leaf made the predicate
 * undefined for every user, so the digest never sent.
 */
describe('shouldSendDigestEmail', () => {
  const verified = (drinkWindowEmail) => ({
    emailVerified: true,
    preferences: { notifications: { drinkWindow: { enabled: true, email: drinkWindowEmail } } },
  });

  it('returns true when opted in at drinkWindow.email, verified, and channel enabled', () => {
    expect(shouldSendDigestEmail(verified(true), true)).toBe(true);
  });

  it('returns false when the user has not opted in (drinkWindow.email false)', () => {
    expect(shouldSendDigestEmail(verified(false), true)).toBe(false);
  });

  it('returns false when the (non-existent) legacy top-level notifications.email is set but drinkWindow.email is not', () => {
    // This is the exact shape the old buggy code read — must NOT trigger a send.
    const user = { emailVerified: true, preferences: { notifications: { email: true } } };
    expect(shouldSendDigestEmail(user, true)).toBe(false);
  });

  it('returns false when the email channel is not configured (emailVerificationEnabled false)', () => {
    expect(shouldSendDigestEmail(verified(true), false)).toBe(false);
  });

  it('returns false when the email is not verified', () => {
    const user = { emailVerified: false, preferences: { notifications: { drinkWindow: { email: true } } } };
    expect(shouldSendDigestEmail(user, true)).toBe(false);
  });

  it('is null-safe for missing preferences / user', () => {
    expect(shouldSendDigestEmail(undefined, true)).toBe(false);
    expect(shouldSendDigestEmail({}, true)).toBe(false);
    expect(shouldSendDigestEmail({ emailVerified: true }, true)).toBe(false);
    expect(shouldSendDigestEmail({ emailVerified: true, preferences: { notifications: {} } }, true)).toBe(false);
  });
});
