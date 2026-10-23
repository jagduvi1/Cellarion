/**
 * services/ownerInquiryEmail — who gets a curator's question by email.
 *
 * WHY THIS TEST EXISTS:
 * Owner questions used to reach the bell and push only, and none of 64 open
 * ones had an answer (2026-10-20). The email goes to every recipient EXCEPT
 * one without a verified address, one who unsubscribed from all email
 * (emailOptOutAt) or turned this category off, a demo visitor, and one who
 * already had a question emailed in the last 24 hours. Each send is recorded
 * on the recipient row (emailedAt), which is what the daily cap reads; a
 * failed send is not recorded and does not throw.
 */
jest.mock('./mailgun', () => ({
  EMAIL_VERIFICATION_ENABLED: true,
  sendOwnerInquiryEmail: jest.fn(async () => {}),
}));
jest.mock('../models/User', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/WineOwnerInquiry', () => ({ find: jest.fn(), updateOne: jest.fn() }));

const User = require('../models/User');
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const { sendOwnerInquiryEmail } = require('./mailgun');
const { emailInquiryRecipients, storeOptedOutOwnerQuestions, EMAIL_GAP_MS } = require('./ownerInquiryEmail');

const oid = (c) => c.repeat(24);
const NOW = new Date('2026-10-20T08:00:00Z');
const INQUIRY = {
  _id: oid('e'),
  question: 'Does your label print the word "Réserve"?',
  recipients: ['1', '2', '3', '4', '5', '6', '7'].map((c) => ({ user: oid(c) })),
};
const ok = (c, extra = {}) => ({ _id: oid(c), email: `${c}@example.com`, emailVerified: true, username: `user${c}`, ...extra });

const usersAre = (rows) => User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });
const recentAre = (rows) => WineOwnerInquiry.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });
const run = () => emailInquiryRecipients({ inquiry: INQUIRY, wineLabel: 'Pira — Barolo', questionPath: `/questions/${oid('e')}`, now: NOW });

beforeEach(() => {
  jest.clearAllMocks();
  WineOwnerInquiry.updateOne.mockResolvedValue({});
  recentAre([]);
});

test('emails only verified, not opted-out, not-demo owners with the category on, and records who got it', async () => {
  usersAre([
    ok('1', { displayName: 'Anna' }),
    ok('2', { emailVerified: false }),
    ok('3', { emailOptOutAt: new Date('2026-09-01') }),
    ok('4', { preferences: { notifications: { ownerInquiry: { email: false } } } }),
    ok('5', { isDemo: true }),
    { _id: oid('6'), emailVerified: true },           // no address at all
    ok('7', { preferences: { notifications: { ownerInquiry: { email: true } } } }),
  ]);

  const res = await run();

  expect(res).toEqual({ emailed: 2 });
  expect(sendOwnerInquiryEmail).toHaveBeenCalledTimes(2);
  expect(sendOwnerInquiryEmail).toHaveBeenCalledWith('1@example.com', 'Anna', oid('1'), 'Pira — Barolo', INQUIRY.question, `/questions/${oid('e')}`);
  expect(sendOwnerInquiryEmail).toHaveBeenCalledWith('7@example.com', 'user7', oid('7'), 'Pira — Barolo', INQUIRY.question, `/questions/${oid('e')}`);
  const [filter, update, opts] = WineOwnerInquiry.updateOne.mock.calls[0];
  expect(filter).toEqual({ _id: oid('e') });
  expect(update).toEqual({ $set: { 'recipients.$[r].emailedAt': NOW } });
  expect(opts.arrayFilters[0]['r.user'].$in).toEqual([oid('1'), oid('7')]);
});

test('at most one such email a day: an owner emailed by another question in the last 24 hours is skipped', async () => {
  usersAre([ok('1'), ok('2')]);
  recentAre([{ recipients: [
    { user: oid('1'), emailedAt: new Date(NOW.getTime() - 60 * 60 * 1000) },           // an hour ago: skip
    { user: oid('2'), emailedAt: new Date(NOW.getTime() - EMAIL_GAP_MS - 1000) },      // over a day ago: send
  ] }]);

  const res = await run();

  expect(res).toEqual({ emailed: 1 });
  expect(sendOwnerInquiryEmail).toHaveBeenCalledTimes(1);
  expect(sendOwnerInquiryEmail.mock.calls[0][0]).toBe('2@example.com');
  const [query] = WineOwnerInquiry.find.mock.calls[0];
  expect(query._id).toEqual({ $ne: oid('e') }); // this inquiry's own rows never count
});

test('a failed send is not recorded and does not throw', async () => {
  usersAre([ok('1'), ok('2')]);
  sendOwnerInquiryEmail.mockRejectedValueOnce(new Error('mailgun down'));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

  const res = await run();

  expect(res).toEqual({ emailed: 1 });
  expect(WineOwnerInquiry.updateOne.mock.calls[0][2].arrayFilters[0]['r.user'].$in).toEqual([oid('2')]);
  spy.mockRestore();
});

// Release audit 2026-10-23: the daily cap read the stamps, but a stamp was
// written only after Mailgun answered and each run is a background job, so a
// curator asking about three wines of one import seconds apart emailed the
// same owner three times. Runs are now serialized in-process.
test('two questions created moments apart email an owner once', async () => {
  usersAre([ok('1')]);
  const stamps = [];
  WineOwnerInquiry.updateOne.mockImplementation(async (filter, update, opts) => {
    for (const user of opts.arrayFilters[0]['r.user'].$in) {
      stamps.push({ inquiry: filter._id, user, emailedAt: update.$set['recipients.$[r].emailedAt'] });
    }
    return {};
  });
  WineOwnerInquiry.find.mockImplementation((q) => ({ select: () => ({ lean: () => Promise.resolve(
    stamps.filter((s) => s.inquiry !== q._id.$ne).map((s) => ({ recipients: [{ user: s.user, emailedAt: s.emailedAt }] })),
  ) }) }));

  const second = { ...INQUIRY, _id: oid('f') };
  const [a, b] = await Promise.all([
    run(),
    emailInquiryRecipients({ inquiry: second, wineLabel: 'Pira — Barolo', questionPath: `/questions/${oid('f')}`, now: NOW }),
  ]);

  expect(sendOwnerInquiryEmail).toHaveBeenCalledTimes(1);
  expect(a.emailed + b.emailed).toBe(1);
});

test('a send that timed out still counts for the daily cap (Mailgun may deliver it late)', async () => {
  jest.useFakeTimers();
  try {
    usersAre([ok('1')]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sendOwnerInquiryEmail.mockReturnValueOnce(new Promise(() => {}));
    const pending = run();
    await jest.advanceTimersByTimeAsync(10 * 1000 + 1);
    expect(await pending).toEqual({ emailed: 0 });
    expect(WineOwnerInquiry.updateOne.mock.calls[0][2].arrayFilters[0]['r.user'].$in).toEqual([oid('1')]);
    warn.mockRestore();
  } finally {
    jest.useRealTimers();
  }
});

test('an account scheduled for deletion is not emailed', async () => {
  usersAre([ok('1', { deletionScheduledFor: new Date('2026-10-25') }), ok('2')]);
  expect(await run()).toEqual({ emailed: 1 });
  expect(sendOwnerInquiryEmail.mock.calls[0][0]).toBe('2@example.com');
});

// Release audit 2026-10-23: an account that unsubscribed from all email before
// this category existed has no flag stored, so Settings showed it on and a save
// withdrew the unsubscribe. The boot backfill stores it off.
test('the boot backfill stores the category off for unsubscribed accounts with no flag, and only those', async () => {
  User.updateMany.mockResolvedValue({ modifiedCount: 6 });
  expect(await storeOptedOutOwnerQuestions()).toBe(6);
  expect(User.updateMany).toHaveBeenCalledWith(
    { emailOptOutAt: { $ne: null }, 'preferences.notifications.ownerInquiry.email': { $exists: false } },
    { $set: { 'preferences.notifications.ownerInquiry.email': false } },
  );
});

test('nobody eligible: nothing is sent and nothing is written', async () => {
  usersAre([ok('1', { emailVerified: false })]);
  expect(await run()).toEqual({ emailed: 0 });
  expect(sendOwnerInquiryEmail).not.toHaveBeenCalled();
  expect(WineOwnerInquiry.updateOne).not.toHaveBeenCalled();
});

test('without mail configured, nothing is read or sent', async () => {
  jest.resetModules();
  jest.doMock('./mailgun', () => ({ EMAIL_VERIFICATION_ENABLED: false, sendOwnerInquiryEmail: jest.fn() }));
  const UserFresh = require('../models/User');
  const { emailInquiryRecipients: fresh } = require('./ownerInquiryEmail');
  expect(await fresh({ inquiry: INQUIRY, wineLabel: 'x', questionPath: '/q' })).toEqual({ emailed: 0 });
  expect(UserFresh.find).not.toHaveBeenCalled();
});
