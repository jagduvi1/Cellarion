const {
  CATEGORY_CHANNELS,
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
      'supportReply',
    ]);
  });

  it('treats email and push as the only outbound channels', () => {
    expect(OUTBOUND_CHANNELS).toEqual(['email', 'push']);
  });

  // The unsubscribe writes every channel a category defines, present in the
  // stored record or not — so the map must say exactly what the schema says.
  it('CATEGORY_CHANNELS names exactly the outbound leaves the User schema defines', () => {
    const User = require('../models/User');
    for (const [category, channels] of Object.entries(CATEGORY_CHANNELS)) {
      for (const channel of OUTBOUND_CHANNELS) {
        expect(!!User.schema.path(`preferences.notifications.${category}.${channel}`)).toBe(channels.includes(channel));
      }
    }
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
      supportReply:     { email: false },
    }, { emailOptOutAt: new Date('2026-08-01') });

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

  // Audit 2026-09-27 M7: a category missing from the stored record used to be
  // skipped — an account whose settings were saved before support replies
  // existed kept receiving them after "unsubscribe from all". Every channel
  // the schema defines is written, and only those (no email on follows).
  it('writes a category missing from the stored record off, rather than skipping it', () => {
    const user = makeUser({
      drinkWindow: { enabled: true, email: true, push: true },
      // communityReply, communityMention, communityFollow, supportReply all absent
    });

    const changed = unsubscribeAllNotifications(user);

    expect(changed).toBe(true);
    expect(user.preferences.notifications).toEqual({
      drinkWindow:      { enabled: true, email: false, push: false },
      communityReply:   { email: false, push: false },
      communityMention: { email: false, push: false },
      communityFollow:  { push: false },
      supportReply:     { email: false },
    });
    expect(user.markModified).toHaveBeenCalledTimes(5);
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(user.markModified).toHaveBeenCalledWith(`preferences.notifications.${category}`);
    }
  });
});

// Audit 2026-09-27 M7: the click is an objection to email as such, not to the
// categories that existed that day. It is recorded on the account
// (emailOptOutAt) and every sender honours it on top of the per-category flags.
describe('the objection itself — emailOptOutAt', () => {
  const allOff = () => ({
    drinkWindow:      { enabled: true, email: false, push: false },
    communityReply:   { email: false, push: false },
    communityMention: { email: false, push: false },
    communityFollow:  { push: false },
    supportReply:     { email: false },
  });

  it('is stamped with the time of the click', () => {
    const user = makeUser({ drinkWindow: { enabled: true, email: true, push: true } });
    const before = Date.now();
    unsubscribeAllNotifications(user);
    expect(user.emailOptOutAt).toBeInstanceOf(Date);
    expect(user.emailOptOutAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('counts as a change on its own — an all-off account without a stamp is saved and audited', () => {
    const user = makeUser(allOff());
    expect(unsubscribeAllNotifications(user)).toBe(true);
    expect(user.emailOptOutAt).toBeInstanceOf(Date);
    expect(user.markModified).not.toHaveBeenCalled(); // no flag moved
  });

  it('an earlier stamp is kept — the first objection is the one that counts', () => {
    const first = new Date('2026-08-01T10:00:00Z');
    const user = makeUser(allOff(), { emailOptOutAt: first });
    expect(unsubscribeAllNotifications(user)).toBe(false);
    expect(user.emailOptOutAt).toBe(first);
  });
});

// Support answers are emailed by default (2026-09-26). "Unsubscribe from all
// Cellarion emails" must stop them too, including on accounts whose stored
// settings were saved before the category existed.
describe('support-reply emails and the one-click unsubscribe', () => {
  it('turns the support-reply email off with everything else', () => {
    const user = makeUser({ communityFollow: { push: true }, supportReply: { email: true } });

    expect(unsubscribeAllNotifications(user)).toBe(true);
    expect(user.preferences.notifications.supportReply.email).toBe(false);
    expect(user.markModified).toHaveBeenCalledWith('preferences.notifications.supportReply');
  });

  it('covers an account stored before the category existed (the schema default fills it in)', () => {
    const mongoose = require('mongoose');
    const User = require('../models/User');
    const user = User.hydrate({
      _id: new mongoose.Types.ObjectId(),
      username: 'older', email: 'older@cellarion.app',
      preferences: { notifications: {
        drinkWindow: { enabled: true, email: false, push: false },
        communityReply: { email: false, push: true },
      } },
    });
    expect(user.preferences.notifications.supportReply.email).toBe(true);

    expect(unsubscribeAllNotifications(user)).toBe(true);
    expect(user.preferences.notifications.supportReply.email).toBe(false);
    expect(user.isModified('preferences.notifications.supportReply')).toBe(true);
    // …and the objection is recorded on the real document too.
    expect(user.emailOptOutAt).toBeInstanceOf(Date);
    expect(user.isModified('emailOptOutAt')).toBe(true);
  });
});
