/**
 * services/inactiveAccounts — deleting accounts nobody uses.
 *
 * WHY THIS TEST EXISTS:
 * It erases people's data. Pinned here:
 *   - who can never be deleted (demo, staff, system accounts, an account
 *     already being deleted, a paying supporter, the owner of a shared cellar
 *     a member still uses)
 *   - which period applies (24 months, 12 for an account that never held anything)
 *   - that nobody counts as unused from before this install started recording
 *     use (history before it is mostly gone, and absence is not proof)
 *   - the timeline: a first notice 30 days before, a final one 7 days before,
 *     and never less notice than that however late the job runs
 *   - that a notice which fails to send is undone and retried, and that no
 *     account is erased in a run in which a notice failed
 *   - that using the account ends the timeline, even on the day of a notice
 *   - that a deletion is decided again from a fresh read and claimed once
 *   - that nothing runs while the rule is off or email is not configured
 */
jest.mock('../models/User', () => ({
  find: jest.fn(), findById: jest.fn(), findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(), updateMany: jest.fn(), exists: jest.fn(),
}));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ exists: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ exists: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ exists: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../utils/siteConfig', () => ({ updateSiteConfig: jest.fn() }));
jest.mock('./mailgun', () => ({ sendInactivityNoticeEmail: jest.fn(), EMAIL_VERIFICATION_ENABLED: true }));
jest.mock('./userDeletionJob', () => ({ eraseAccount: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WishlistItem = require('../models/WishlistItem');
const JournalEntry = require('../models/JournalEntry');
const SiteConfig = require('../models/SiteConfig');
const { updateSiteConfig } = require('../utils/siteConfig');
const { sendInactivityNoticeEmail } = require('./mailgun');
const { eraseAccount } = require('./userDeletionJob');
const { logAudit } = require('./audit');
const ia = require('./inactiveAccounts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2028-11-01T09:13:00Z');
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const daysFrom = (d, n) => new Date(d.getTime() + n * DAY);

const account = (over = {}) => ({
  _id: 'u1', username: 'anna', email: 'anna@example.com', emailVerified: true, roles: ['user'],
  plan: 'free', createdAt: new Date('2025-01-10T12:00:00Z'), lastActiveAt: day('2026-11-01'), ...over,
});
const facts = (over = {}) => ({ hasContent: true, sharedCellarInUse: false, ...over });

// Mongoose query chains used by the service.
const chain = (value) => {
  const q = { select: () => q, sort: () => q, limit: () => q, lean: () => Promise.resolve(value) };
  return q;
};

// SiteConfig holds both the switch and the tracking start; answer by key.
let settings;
let tracking;
beforeEach(() => {
  jest.clearAllMocks();
  settings = { enabled: true, since: '2028-10-01T00:00:00Z' };
  tracking = { since: '2026-01-01T00:00:00Z' }; // long enough ago not to matter, unless a test says so
  SiteConfig.findOne.mockImplementation(({ key }) => ({
    lean: () => Promise.resolve(key === 'inactiveAccounts' ? { value: settings } : { value: tracking }),
  }));
  User.updateMany.mockResolvedValue({ modifiedCount: 0 });
  User.updateOne.mockResolvedValue({});
  User.findOneAndUpdate.mockReturnValue({ select: () => Promise.resolve({ _id: 'u1' }) });
  User.exists.mockResolvedValue(null);
  Bottle.exists.mockResolvedValue({ _id: 'b1' });
  Bottle.countDocuments.mockResolvedValue(12);
  Bottle.distinct.mockResolvedValue([]);
  WishlistItem.exists.mockResolvedValue(null);
  WishlistItem.distinct.mockResolvedValue([]);
  JournalEntry.exists.mockResolvedValue(null);
  JournalEntry.distinct.mockResolvedValue([]);
  Cellar.find.mockReturnValue(chain([]));
  sendInactivityNoticeEmail.mockResolvedValue(undefined);
  eraseAccount.mockResolvedValue(undefined);
});

describe('decide: who can never be deleted', () => {
  // All of these are long unused; only the exemption keeps them.
  const old = { lastActiveAt: day('2024-01-01') };
  test.each([
    ['a demo account', { isDemo: true }, 'skip:demo'],
    ['an admin', { roles: ['admin'] }, 'skip:staff'],
    ['a sommelier', { roles: ['user', 'somm'] }, 'skip:staff'],
    ['a moderator', { roles: ['moderator'] }, 'skip:staff'],
    ['the deleted-user sentinel', { username: '__deleted__' }, 'skip:system'],
    ['an account already being deleted', { deletionScheduledFor: NOW }, 'skip:deleting'],
    ['a live Stripe subscription', { stripeSubscriptionId: 'sub_1', plan: 'supporter' }, 'skip:paying'],
    ['a granted paid plan that has not expired', { plan: 'patron', planExpiresAt: daysFrom(NOW, 10) }, 'skip:paying'],
  ])('%s', (_, over, action) => {
    expect(ia.decide(account({ ...old, ...over }), facts(), NOW).action).toBe(action);
  });

  test('an expired paid plan does not protect the account', () => {
    expect(ia.decide(account({ ...old, plan: 'supporter', planExpiresAt: daysFrom(NOW, -1) }), facts(), NOW).action).toBe('first');
  });

  test('the owner of a shared cellar a member still uses', () => {
    expect(ia.decide(account(old), facts({ sharedCellarInUse: true }), NOW).action).toBe('skip:shared-cellar');
  });
});

describe('decide: the period and the timeline', () => {
  test('with content: 24 months; the first notice comes 30 days before, not sooner', () => {
    const lastActiveAt = day('2026-11-01'); // due 2028-11-01
    const due = ia.addMonths(lastActiveAt, 24);
    expect(ia.decide(account({ lastActiveAt }), facts(), daysFrom(due, -31)).action).toBe('skip:active');
    const d = ia.decide(account({ lastActiveAt }), facts(), daysFrom(due, -30));
    expect(d).toMatchObject({ action: 'first', months: 24 });
    expect(d.deleteAfter).toEqual(day('2028-11-01'));
  });

  test('without content: 12 months', () => {
    const at = daysFrom(day('2028-11-15'), -30); // the first-notice day of an account unused since 2027-11-15
    expect(ia.decide(account({ lastActiveAt: day('2027-11-15') }), facts({ hasContent: false }), daysFrom(at, -1)).action).toBe('skip:active');
    const d = ia.decide(account({ lastActiveAt: day('2027-11-15') }), facts({ hasContent: false }), at);
    expect(d).toMatchObject({ action: 'first', months: 12 });
    expect(d.deleteAfter).toEqual(day('2028-11-15'));
  });

  test('a job that runs late still gives the full 30 days from the first notice', () => {
    const d = ia.decide(account({ lastActiveAt: day('2025-06-01') }), facts(), NOW);
    expect(d.action).toBe('first');
    expect(d.deleteAfter).toEqual(daysFrom(NOW, 30));
  });

  test('an account never seen since lastActiveAt existed counts from the day it was created', () => {
    const d = ia.decide(account({ lastActiveAt: null, createdAt: new Date('2026-10-20T15:00:00Z') }), facts(), NOW);
    expect(d.action).toBe('first');
    expect(d.due).toEqual(day('2028-10-20'));
  });

  const onTimeline = (n, over = {}) => account({
    lastActiveAt: day('2026-09-01'),
    inactivityNotice: { firstSentAt: day('2028-10-01'), finalSentAt: null, deleteAfter: day('2028-11-01'), unusedSince: day('2026-09-01'), ...n },
    ...over,
  });

  test('between the notices it waits; the final notice comes 7 days before the date', () => {
    expect(ia.decide(onTimeline({}), facts(), day('2028-10-24')).action).toBe('wait');
    const d = ia.decide(onTimeline({}), facts(), day('2028-10-25'));
    expect(d.action).toBe('final');
    expect(d.deleteAfter).toEqual(day('2028-11-01'));
  });

  test('a final notice sent late moves the date: never less than 7 days after it', () => {
    const d = ia.decide(onTimeline({}), facts(), day('2028-10-31'));
    expect(d.action).toBe('final');
    expect(d.deleteAfter).toEqual(day('2028-11-07'));
  });

  test('after both notices, the account is deleted on the date and not before', () => {
    const n = { finalSentAt: day('2028-10-25') };
    expect(ia.decide(onTimeline(n), facts(), daysFrom(day('2028-11-01'), -0.01)).action).toBe('wait');
    expect(ia.decide(onTimeline(n), facts(), day('2028-11-01')).action).toBe('delete');
  });

  test('used since the timeline started — even on the day of the notice — the timeline is over', () => {
    // Signed in on the day of the first notice: lastActiveAt is that day's midnight.
    const back = onTimeline({ finalSentAt: day('2028-10-25') }, { lastActiveAt: day('2028-10-01') });
    expect(ia.decide(back, facts(), day('2028-11-02')).action).toBe('skip:active');
  });
});

describe('decide: nobody counts as unused from before use was recorded', () => {
  // Recording started on 2026-11-01. An account created in 2024 whose last
  // trace (creation, or a backfilled date) is old must not be "unused since 2024".
  const trackedSince = day('2026-11-01');

  test('an old account with no later trace is counted from the tracking start', () => {
    const user = account({ lastActiveAt: null, createdAt: new Date('2024-01-10T12:00:00Z') });
    expect(ia.decide(user, facts(), day('2028-09-30'), trackedSince).action).toBe('skip:active');
    const d = ia.decide(user, facts(), day('2028-10-02'), trackedSince);
    expect(d).toMatchObject({ action: 'first', due: day('2028-11-01') });
    expect(d.unusedFrom).toEqual(trackedSince);
  });

  test('a backfilled date from before the tracking start is floored the same way', () => {
    const user = account({ lastActiveAt: day('2025-03-01') });
    expect(ia.decide(user, facts({ hasContent: false }), day('2027-09-30'), trackedSince).action).toBe('skip:active');
    expect(ia.decide(user, facts({ hasContent: false }), day('2027-10-02'), trackedSince).action).toBe('first');
  });

  test('a day of use recorded after the tracking start counts as it is', () => {
    const d = ia.decide(account({ lastActiveAt: day('2027-01-15') }), facts(), day('2029-01-01'), trackedSince);
    expect(d.unusedFrom).toEqual(day('2027-01-15'));
    expect(d.due).toEqual(day('2029-01-15'));
  });
});

describe('runInactiveAccounts', () => {
  const plan = (users) => User.find.mockReturnValue(chain(users));

  test('does nothing while the rule is off', async () => {
    settings = { enabled: false };
    expect(await ia.runInactiveAccounts({ now: NOW })).toEqual({ skipped: 'off' });
    expect(User.find).not.toHaveBeenCalled();
  });

  test('does nothing while email is not configured: nobody is deleted without notice', async () => {
    const mailgun = require('./mailgun');
    mailgun.EMAIL_VERIFICATION_ENABLED = false;
    try {
      expect(await ia.runInactiveAccounts({ now: NOW })).toEqual({ skipped: 'email-not-configured' });
      expect(User.find).not.toHaveBeenCalled();
    } finally {
      mailgun.EMAIL_VERIFICATION_ENABLED = true;
    }
  });

  test('ends the timelines of accounts used since (lastActiveAt past unusedSince)', async () => {
    plan([]);
    await ia.runInactiveAccounts({ now: NOW });
    const [query, update] = User.updateMany.mock.calls[0];
    expect(query).toEqual({ 'inactivityNotice.firstSentAt': { $ne: null }, $expr: { $gt: ['$lastActiveAt', '$inactivityNotice.unusedSince'] } });
    expect(update).toEqual({ $unset: { inactivityNotice: '' } });
  });

  test('a first notice: claimed while the account is still unused, then emailed and audited', async () => {
    plan([account({ lastActiveAt: day('2026-11-20') })]); // due 2028-11-20, 19 days away

    const r = await ia.runInactiveAccounts({ now: NOW });

    expect(r.first).toBe(1);
    const [filter, update] = User.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'u1', lastActiveAt: day('2026-11-20'), 'inactivityNotice.firstSentAt': null });
    expect(update.$set.inactivityNotice).toEqual({
      firstSentAt: NOW, finalSentAt: null, deleteAfter: daysFrom(NOW, 30), emailed: true, unusedSince: day('2026-11-20'), erasingAt: null,
    });
    expect(sendInactivityNoticeEmail).toHaveBeenCalledWith('anna@example.com', 'anna', {
      final: false, deleteAfter: daysFrom(NOW, 30), lastActiveAt: day('2026-11-20'), months: 24, bottles: 12,
    });
    expect(logAudit).toHaveBeenCalledWith(null, 'user.inactivity_notice', { type: 'user', id: 'u1' },
      expect.objectContaining({ notice: 'first', emailed: true, months: 24 }));
  });

  test('a first notice that fails to send is undone (so it is sent again tomorrow), not audited as sent', async () => {
    plan([account({ lastActiveAt: day('2026-11-20') })]);
    sendInactivityNoticeEmail.mockRejectedValue(new Error('mailgun 401'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const r = await ia.runInactiveAccounts({ now: NOW });

    expect(r).toMatchObject({ first: 0, failed: 1 });
    expect(User.updateOne).toHaveBeenCalledWith({ _id: 'u1', 'inactivityNotice.firstSentAt': NOW }, { $unset: { inactivityNotice: '' } });
    expect(logAudit).not.toHaveBeenCalledWith(null, 'user.inactivity_notice', expect.anything(), expect.anything());
    errors.mockRestore();
  });

  test('a final notice that fails to send restores the stamp and the date it had', async () => {
    plan([account({
      lastActiveAt: day('2026-09-01'),
      inactivityNotice: { firstSentAt: day('2028-10-01'), finalSentAt: null, deleteAfter: day('2028-11-05'), unusedSince: day('2026-09-01') },
    })]);
    sendInactivityNoticeEmail.mockRejectedValue(new Error('timed out'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    await ia.runInactiveAccounts({ now: NOW });

    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'u1', 'inactivityNotice.finalSentAt': NOW },
      { $set: { 'inactivityNotice.finalSentAt': null, 'inactivityNotice.deleteAfter': day('2028-11-05') } },
    );
    errors.mockRestore();
  });

  test('no account is erased in a run in which a notice failed', async () => {
    const dueUser = account({
      _id: 'u2', lastActiveAt: day('2026-09-01'),
      inactivityNotice: { firstSentAt: day('2028-09-20'), finalSentAt: day('2028-10-14'), deleteAfter: day('2028-10-21'), unusedSince: day('2026-09-01') },
    });
    plan([account({ lastActiveAt: day('2026-11-20') }), dueUser]);
    sendInactivityNoticeEmail.mockRejectedValue(new Error('mailgun down'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const r = await ia.runInactiveAccounts({ now: NOW });

    expect(r).toMatchObject({ deleted: 0, deletionsHeld: 1 });
    expect(eraseAccount).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  test('a lost claim (used a moment ago) sends nothing', async () => {
    plan([account({ lastActiveAt: day('2026-11-20') })]);
    User.findOneAndUpdate.mockReturnValue({ select: () => Promise.resolve(null) });
    const r = await ia.runInactiveAccounts({ now: NOW });
    expect(r.first).toBe(0);
    expect(sendInactivityNoticeEmail).not.toHaveBeenCalled();
  });

  test('an unconfirmed address: the same timeline, recorded as not emailed', async () => {
    plan([account({ lastActiveAt: day('2026-11-20'), emailVerified: false })]);
    await ia.runInactiveAccounts({ now: NOW });
    expect(User.findOneAndUpdate.mock.calls[0][1].$set.inactivityNotice.emailed).toBe(false);
    expect(sendInactivityNoticeEmail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(null, 'user.inactivity_notice', expect.anything(), expect.objectContaining({ emailed: false }));
  });

  test('a final notice stamps finalSentAt and the (possibly later) date', async () => {
    plan([account({
      lastActiveAt: day('2026-09-01'),
      inactivityNotice: { firstSentAt: day('2028-10-01'), finalSentAt: null, deleteAfter: day('2028-11-05'), unusedSince: day('2026-09-01') },
    })]);

    const r = await ia.runInactiveAccounts({ now: NOW });

    expect(r.final).toBe(1);
    const [filter, update] = User.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: 'u1', lastActiveAt: day('2026-09-01'), 'inactivityNotice.finalSentAt': null });
    expect(update).toEqual({ $set: { 'inactivityNotice.finalSentAt': NOW, 'inactivityNotice.deleteAfter': daysFrom(NOW, 7) } });
    expect(sendInactivityNoticeEmail.mock.calls[0][2].final).toBe(true);
  });

  const due = account({
    lastActiveAt: day('2026-09-01'), stripeCustomerId: 'cus_1',
    inactivityNotice: { firstSentAt: day('2028-09-20'), finalSentAt: day('2028-10-14'), deleteAfter: day('2028-10-21'), unusedSince: day('2026-09-01') },
  });

  test('on the date: decided again from a fresh read, claimed, erased, then audited', async () => {
    plan([due]);
    User.findById.mockReturnValue(chain(due));

    const r = await ia.runInactiveAccounts({ now: NOW });

    expect(r.deleted).toBe(1);
    expect(User.findById).toHaveBeenCalledWith('u1');
    const [claimFilter, claim] = User.findOneAndUpdate.mock.calls[0];
    expect(claimFilter).toMatchObject({ _id: 'u1', lastActiveAt: day('2026-09-01'), 'inactivityNotice.finalSentAt': { $ne: null } });
    expect(claim).toEqual({ $set: { 'inactivityNotice.erasingAt': NOW } });
    expect(eraseAccount).toHaveBeenCalledWith(due);
    expect(logAudit).toHaveBeenCalledWith(null, 'user.inactivity_deleted', { type: 'user', id: 'u1' }, expect.objectContaining({ months: 24 }));
    expect(eraseAccount.mock.invocationCallOrder[0]).toBeLessThan(logAudit.mock.invocationCallOrder[0]);
  });

  test('another process holding the erase claim: this one erases nothing', async () => {
    plan([due]);
    User.findById.mockReturnValue(chain(due));
    User.findOneAndUpdate.mockReturnValue({ select: () => Promise.resolve(null) });
    const r = await ia.runInactiveAccounts({ now: NOW });
    expect(r.deleted).toBe(0);
    expect(eraseAccount).not.toHaveBeenCalled();
  });

  test('an erase that fails releases its claim for the next run', async () => {
    plan([due]);
    User.findById.mockReturnValue(chain(due));
    eraseAccount.mockRejectedValue(new Error('purge failed'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await ia.runInactiveAccounts({ now: NOW });
    expect(r).toMatchObject({ deleted: 0, failed: 1 });
    expect(User.updateOne).toHaveBeenCalledWith({ _id: 'u1', 'inactivityNotice.erasingAt': NOW }, { $set: { 'inactivityNotice.erasingAt': null } });
    errors.mockRestore();
  });

  test('used between the run\'s read and the deletion: nothing is erased', async () => {
    plan([due]);
    User.findById.mockReturnValue(chain({ ...due, lastActiveAt: day('2028-11-01') }));
    const r = await ia.runInactiveAccounts({ now: NOW });
    expect(r.deleted).toBe(0);
    expect(eraseAccount).not.toHaveBeenCalled();
  });

  test('exempt now while on a timeline (a supporter since): the timeline ends', async () => {
    plan([{ ...due, stripeSubscriptionId: 'sub_9', plan: 'supporter' }]);
    const r = await ia.runInactiveAccounts({ now: NOW });
    expect(User.updateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $unset: { inactivityNotice: '' } });
    expect(r.cleared).toBe(1);
    expect(eraseAccount).not.toHaveBeenCalled();
  });

  test('one account failing does not stop the run', async () => {
    plan([account({ _id: 'u1', lastActiveAt: day('2026-11-20') }), account({ _id: 'u2', lastActiveAt: day('2026-11-20') })]);
    User.findOneAndUpdate
      .mockReturnValueOnce({ select: () => Promise.reject(new Error('write conflict')) })
      .mockReturnValueOnce({ select: () => Promise.resolve({ _id: 'u2' }) });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await ia.runInactiveAccounts({ now: NOW });
    expect(r).toMatchObject({ first: 1, failed: 1 });
    errors.mockRestore();
  });
});

describe('candidates: only accounts with a step due today', () => {
  test('before the tracking start plus the period, only timelines are read', async () => {
    User.find.mockReturnValue(chain([]));
    await ia.candidates(NOW, daysFrom(NOW, -100));
    expect(User.find).toHaveBeenCalledTimes(1);
    expect(User.find.mock.calls[0][0]['inactivityNotice.firstSentAt']).toEqual({ $ne: null });
  });

  test('the 12-month band keeps only accounts that never held anything, narrowed in bulk', async () => {
    const band = [{ _id: 'full' }, { _id: 'empty' }];
    User.find
      .mockReturnValueOnce(chain([]))                    // timelines due
      .mockReturnValueOnce(chain([]))                    // 24-month first notices
      .mockReturnValueOnce(chain(band))                  // the 12-month band (ids)
      .mockReturnValueOnce(chain([account({ _id: 'empty' })]));
    Bottle.distinct.mockResolvedValue(['full']);

    const rows = await ia.candidates(NOW, day('2026-01-01'));

    expect(rows.map((r) => r._id)).toEqual(['empty']);
    expect(User.find.mock.calls[3][0]).toEqual({ _id: { $in: ['empty'] } });
    expect(Bottle.distinct).toHaveBeenCalledWith('user', { user: { $in: ['full', 'empty'] } });
  });

  test('timelines are read by their next step: the final notice or the deletion date', async () => {
    User.find.mockReturnValue(chain([]));
    await ia.candidates(NOW, daysFrom(NOW, -100));
    const q = User.find.mock.calls[0][0];
    expect(q.$or).toEqual([
      { 'inactivityNotice.finalSentAt': null, 'inactivityNotice.deleteAfter': { $lte: daysFrom(NOW, 7) } },
      { 'inactivityNotice.finalSentAt': { $ne: null }, 'inactivityNotice.deleteAfter': { $lte: NOW } },
    ]);
    expect(q).toMatchObject({ isDemo: { $ne: true }, deletionScheduledFor: null, roles: { $nin: ['admin', 'somm', 'moderator'] } });
    expect(q.username.$not.test('__deleted__')).toBe(true);
  });
});

describe('factsFor', () => {
  test('content is a bottle, a wishlist entry or a journal entry', async () => {
    Bottle.exists.mockResolvedValue(null);
    expect((await ia.factsFor(account(), NOW)).hasContent).toBe(false);
    JournalEntry.exists.mockResolvedValue({ _id: 'j1' });
    expect((await ia.factsFor(account(), NOW)).hasContent).toBe(true);
  });

  test('a shared cellar counts while a member was active within the owner\'s period', async () => {
    Cellar.find.mockReturnValue(chain([{ members: [{ user: 'm1' }, { user: 'm2' }] }]));
    User.exists.mockResolvedValue({ _id: 'm2' });
    const f = await ia.factsFor(account(), NOW);
    expect(f.sharedCellarInUse).toBe(true);
    const q = User.exists.mock.calls[0][0];
    expect(q._id).toEqual({ $in: ['m1', 'm2'] });
    expect(q.lastActiveAt.$gte).toEqual(ia.addMonths(NOW, -24));
    expect(Cellar.find.mock.calls[0][0]).toEqual({ user: 'u1', deletedAt: null, 'members.0': { $exists: true } });
  });
});

describe('the switch and the preview', () => {
  test('turning it on restarts every timeline', async () => {
    settings = { enabled: false };
    const r = await ia.setEnabled(true, 'admin1');
    expect(User.updateMany).toHaveBeenCalledWith({ inactivityNotice: { $exists: true } }, { $unset: { inactivityNotice: '' } });
    expect(r.enabled).toBe(true);
    expect(updateSiteConfig).toHaveBeenCalledWith('inactiveAccounts', expect.objectContaining({ enabled: true }), 'admin1');
  });

  test('turning it off keeps the stored timelines (they resume only after a restart)', async () => {
    await ia.setEnabled(false, 'admin1');
    expect(User.updateMany).not.toHaveBeenCalled();
    expect(updateSiteConfig).toHaveBeenCalledWith('inactiveAccounts', expect.objectContaining({ enabled: false }), 'admin1');
  });

  test('the preview counts today\'s decisions, reports the tracking start, and is kept for ten minutes', async () => {
    User.find.mockReturnValue(chain([account({ lastActiveAt: day('2026-11-20') })]));
    const p = await ia.preview({ now: NOW, fresh: true });
    expect(p.counts).toEqual({ first: 1 });
    expect(p.trackedSince).toEqual(new Date('2026-01-01T00:00:00Z'));
    const calls = User.find.mock.calls.length;
    await ia.preview({ now: daysFrom(NOW, 5 / (24 * 60)) });
    expect(User.find.mock.calls.length).toBe(calls);
  });
});
