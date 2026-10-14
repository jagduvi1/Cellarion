/**
 * The one-time relink of curator-question notifications (support ticket
 * 2026-10-14): only exact matches change, only their link, and a dry run
 * writes nothing.
 */
jest.mock('../models/Notification', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/WineOwnerInquiry', () => ({ findOne: jest.fn() }));

const Notification = require('../models/Notification');
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const { relinkOwnerInquiryNotifications } = require('./relink-owner-inquiry-notifications');

const oid = (c) => c.repeat(24);
const findChain = (rows) => ({ select: () => ({ lean: async () => rows }) });
const inquiryChain = (doc) => ({ sort: () => ({ select: () => ({ lean: async () => doc }) }) });

const NOTES = [
  { _id: 'n1', user: oid('1'), link: `/cellars/${oid('3')}/bottles/${oid('2')}`, createdAt: new Date('2026-10-14T07:38:00Z') },
  { _id: 'n2', user: oid('4'), link: `/cellars/${oid('6')}/bottles/${oid('5')}`, createdAt: new Date('2026-10-09T14:42:00Z') },
  { _id: 'n3', user: oid('7'), link: '/cellars/not-a-bottle-link', createdAt: new Date() },
];

beforeEach(() => {
  jest.clearAllMocks();
  Notification.find.mockReturnValue(findChain(NOTES));
  // n1 matches an inquiry, n2 does not.
  WineOwnerInquiry.findOne
    .mockReturnValueOnce(inquiryChain({ _id: oid('e') }))
    .mockReturnValueOnce(inquiryChain(null));
  Notification.updateOne.mockResolvedValue({ modifiedCount: 1 });
});

test('a dry run counts and writes nothing', async () => {
  const stats = await relinkOwnerInquiryNotifications();
  expect(stats).toEqual({ scanned: 3, matched: 1, relinked: 0, unmatched: 2 });
  expect(Notification.updateOne).not.toHaveBeenCalled();
  expect(Notification.find).toHaveBeenCalledWith({ type: { $in: ['owner_inquiry', 'owner_inquiry_resolved'] }, link: { $regex: '^/cellars/' } });
});

test('--apply relinks only the exact match, to its question, guarded on the old link', async () => {
  const stats = await relinkOwnerInquiryNotifications({ apply: true });
  expect(stats).toEqual({ scanned: 3, matched: 1, relinked: 1, unmatched: 2 });
  expect(Notification.updateOne).toHaveBeenCalledTimes(1);
  expect(Notification.updateOne).toHaveBeenCalledWith(
    { _id: 'n1', link: NOTES[0].link },
    { $set: { link: `/questions/${oid('e')}` } },
  );
  // The match is the recipient row the notification was written from:
  // same user, same bottle, created no later than the notification.
  const q = WineOwnerInquiry.findOne.mock.calls[0][0];
  expect(String(q.recipients.$elemMatch.user)).toBe(oid('1'));
  expect(String(q.recipients.$elemMatch.bottle)).toBe(oid('2'));
  expect(q.createdAt.$lte).toEqual(NOTES[0].createdAt);
});
