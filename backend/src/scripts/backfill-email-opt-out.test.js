/**
 * scripts/backfill-email-opt-out — stamps emailOptOutAt (and turns the
 * support-reply email off) for accounts that clicked "unsubscribe from all"
 * before the stamp existed. Models mocked; the script's logic is what is tested.
 */
jest.mock('../models/User', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ aggregate: jest.fn() }));

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { backfillEmailOptOut, ALL_OFF } = require('./backfill-email-opt-out');

const oid = (c) => c.repeat(24);
const lean = (rows) => ({ lean: () => Promise.resolve(rows) });
const T1 = new Date('2026-08-01T10:00:00Z');
const T2 = new Date('2026-09-01T10:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  User.updateOne.mockResolvedValue({});
});

test('a dry run counts the clicks whose account has no stamp yet, and writes nothing', async () => {
  AuditLog.aggregate.mockResolvedValue([{ _id: oid('a'), clickedAt: T1 }, { _id: oid('b'), clickedAt: T2 }]);
  User.find.mockReturnValueOnce(lean([{ _id: oid('a') }])); // b is already stamped

  const r = await backfillEmailOptOut();

  expect(r).toEqual({ fromAuditLog: 1, allOff: 0, applied: 0 });
  expect(User.updateOne).not.toHaveBeenCalled();
  // Only accounts without a stamp are candidates.
  expect(User.find.mock.calls[0][0]).toEqual({ _id: { $in: [oid('a'), oid('b')] }, emailOptOutAt: null });
});

test('--apply stamps the FIRST click\'s time and turns the support-reply email off, guarded against a race', async () => {
  AuditLog.aggregate.mockResolvedValue([{ _id: oid('a'), clickedAt: T1 }]);
  User.find.mockReturnValueOnce(lean([{ _id: oid('a') }]));

  const r = await backfillEmailOptOut({ apply: true });

  expect(r.applied).toBe(1);
  expect(User.updateOne).toHaveBeenCalledWith(
    { _id: oid('a'), emailOptOutAt: null },
    { $set: { emailOptOutAt: T1, 'preferences.notifications.supportReply.email': false } },
  );
});

test('--all-off adds accounts whose every stored flag is off, stamped now, without double-counting clickers', async () => {
  const now = new Date('2026-09-27T12:00:00Z');
  AuditLog.aggregate.mockResolvedValue([{ _id: oid('a'), clickedAt: T1 }]);
  User.find
    .mockReturnValueOnce(lean([{ _id: oid('a') }]))               // stamp candidates among clickers
    .mockReturnValueOnce(lean([{ _id: oid('a') }, { _id: oid('c') }])); // all-off accounts (a is a clicker too)

  const r = await backfillEmailOptOut({ apply: true, allOff: true, now: () => now });

  expect(r).toEqual({ fromAuditLog: 1, allOff: 1, applied: 2 });
  expect(User.find.mock.calls[1][0]).toEqual(ALL_OFF);
  expect(User.updateOne).toHaveBeenCalledWith(
    { _id: oid('c'), emailOptOutAt: null },
    { $set: { emailOptOutAt: now, 'preferences.notifications.supportReply.email': false } },
  );
  expect(User.updateOne).toHaveBeenCalledTimes(2);
});

test('the all-off selector requires every pre-existing outbound flag to be explicitly false, and no stamp', () => {
  expect(ALL_OFF).toEqual({
    emailOptOutAt: null,
    'preferences.notifications.drinkWindow.email': false,
    'preferences.notifications.drinkWindow.push': false,
    'preferences.notifications.communityReply.email': false,
    'preferences.notifications.communityReply.push': false,
    'preferences.notifications.communityMention.email': false,
    'preferences.notifications.communityMention.push': false,
    'preferences.notifications.communityFollow.push': false,
  });
});

test('no clicks: nothing queried further, nothing written', async () => {
  AuditLog.aggregate.mockResolvedValue([]);
  const r = await backfillEmailOptOut({ apply: true });
  expect(r).toEqual({ fromAuditLog: 0, allOff: 0, applied: 0 });
  expect(User.find).not.toHaveBeenCalled();
  expect(User.updateOne).not.toHaveBeenCalled();
});
