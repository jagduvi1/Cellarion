const {
  NOTIFICATION_CATEGORIES,
  OUTBOUND_CHANNELS,
  unsubscribeAllNotifications,
} = require('./notifications');

// Helper to build a fresh user-shaped object with whatever notification
// state the test wants. Mirrors models/User.js shape.
function makeUser(notifications, extra = {}) {
  return {
    preferences: { notifications },
    markModified: jest.fn(),
    ...extra,
  };
}

describe('NOTIFICATION_CATEGORIES', () => {
  it('lists every category currently present in the schema', () => {
    // If the schema gains a new category, this assertion intentionally fails
    // and reminds whoever added it to update the canonical list here so
    // unsubscribe + settings + tests stay in sync.
    expect(NOTIFICATION_CATEGORIES).toEqual([
      'drinkWindow',
      'communityReply',
      'communityMention',
      'communityFollow',
    ]);
  });

  it('treats email and push as the only outbound channels', () => {
    expect(OUTBOUND_CHANNELS).toEqual(['email', 'push']);
  });
});

describe('unsubscribeAllNotifications', () => {
  it('flips every email and push leaf to false across every category', () => {
    const user = makeUser({
      drinkWindow:      { enabled: true, email: true, push: true },
      communityReply:   { email: true, push: true },
      communityMention: { email: true, push: true },
      communityFollow:  { push: true },
    });

    const changed = unsubscribeAllNotifications(user);

    expect(changed).toBe(true);
    expect(user.preferences.notifications.drinkWindow.email).toBe(false);
    expect(user.preferences.notifications.drinkWindow.push).toBe(false);
    expect(user.preferences.notifications.communityReply.email).toBe(false);
    expect(user.preferences.notifications.communityReply.push).toBe(false);
    expect(user.preferences.notifications.communityMention.email).toBe(false);
    expect(user.preferences.notifications.communityMention.push).toBe(false);
    expect(user.preferences.notifications.communityFollow.push).toBe(false);
  });

  it('marks each touched parent path as modified (Mongoose dotted-set workaround)', () => {
    const user = makeUser({
      drinkWindow:      { enabled: true, email: true, push: true },
      communityReply:   { email: true, push: true },
      communityMention: { email: true, push: true },
      communityFollow:  { push: true },
    });

    unsubscribeAllNotifications(user);

    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.drinkWindow');
    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.communityReply');
    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.communityMention');
    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.communityFollow');
  });

  it('does NOT touch drinkWindow.enabled (in-app bell stays on)', () => {
    const user = makeUser({
      drinkWindow: { enabled: true, email: true, push: true },
    });

    unsubscribeAllNotifications(user);

    expect(user.preferences.notifications.drinkWindow.enabled).toBe(true);
  });

  it('does NOT add an `email` key to communityFollow (schema has push only)', () => {
    const user = makeUser({
      communityFollow: { push: true },
    });

    unsubscribeAllNotifications(user);

    expect(user.preferences.notifications.communityFollow.push).toBe(false);
    expect('email' in user.preferences.notifications.communityFollow).toBe(false);
  });

  it('returns false and does not call markModified when nothing needs changing', () => {
    const user = makeUser({
      drinkWindow:      { enabled: true, email: false, push: false },
      communityReply:   { email: false, push: false },
      communityMention: { email: false, push: false },
      communityFollow:  { push: false },
    });

    const changed = unsubscribeAllNotifications(user);

    expect(changed).toBe(false);
    expect(user.markModified).not.toHaveBeenCalled();
  });

  it('flips only the still-true flags in a mixed state', () => {
    const user = makeUser({
      drinkWindow:      { enabled: true, email: true,  push: false },
      communityReply:   { email: false, push: true },
      communityMention: { email: false, push: false },
      communityFollow:  { push: true },
    });

    const changed = unsubscribeAllNotifications(user);

    expect(changed).toBe(true);
    expect(user.preferences.notifications.drinkWindow.email).toBe(false);
    expect(user.preferences.notifications.drinkWindow.push).toBe(false);
    expect(user.preferences.notifications.communityReply.email).toBe(false);
    expect(user.preferences.notifications.communityReply.push).toBe(false);
    expect(user.preferences.notifications.communityFollow.push).toBe(false);
    // communityMention was already off — not marked modified
    expect(user.markModified).not.toHaveBeenCalledWith('preferences.notifications.communityMention');
    // The three categories that changed WERE marked
    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.drinkWindow');
    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.communityReply');
    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.communityFollow');
  });

  it('handles a user with no preferences object', () => {
    const user = { markModified: jest.fn() };
    expect(unsubscribeAllNotifications(user)).toBe(false);
    expect(user.markModified).not.toHaveBeenCalled();
  });

  it('handles a user with no preferences.notifications object', () => {
    const user = { preferences: {}, markModified: jest.fn() };
    expect(unsubscribeAllNotifications(user)).toBe(false);
    expect(user.markModified).not.toHaveBeenCalled();
  });

  it('handles null/undefined user gracefully', () => {
    expect(unsubscribeAllNotifications(null)).toBe(false);
    expect(unsubscribeAllNotifications(undefined)).toBe(false);
  });

  it('skips categories that are missing entirely (partially-populated user)', () => {
    const user = makeUser({
      drinkWindow: { enabled: true, email: true, push: true },
      // communityReply, communityMention, communityFollow all absent
    });

    const changed = unsubscribeAllNotifications(user);

    expect(changed).toBe(true);
    expect(user.preferences.notifications.drinkWindow.email).toBe(false);
    expect(user.preferences.notifications.drinkWindow.push).toBe(false);
    expect(user.markModified).toHaveBeenCalledTimes(1);
    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.drinkWindow');
  });
});
