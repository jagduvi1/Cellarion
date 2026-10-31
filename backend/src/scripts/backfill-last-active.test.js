/**
 * scripts/backfill-last-active — fills User.lastActiveAt for accounts not seen
 * since the field existed, from the evidence that remains: creation, device
 * sessions, the activity log (own actions and sign-ins), API tokens and
 * Cellar Chat days. Models mocked; the script's logic is what is tested.
 */
jest.mock('../models/User', () => ({ find: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ aggregate: jest.fn() }));
jest.mock('../models/ApiToken', () => ({ aggregate: jest.fn() }));
jest.mock('../models/ChatUsage', () => ({ aggregate: jest.fn() }));

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiToken = require('../models/ApiToken');
const ChatUsage = require('../models/ChatUsage');
const { backfillLastActive, SIGN_IN_ACTIONS } = require('./backfill-last-active');

const oid = (c) => c.repeat(24);
const lean = (rows) => ({ lean: () => Promise.resolve(rows) });
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date('2026-10-31T12:00:00Z');

// The two activity-log aggregations run in this order: own actions, then sign-ins.
function evidence({ acted = [], signedIn = [], tokens = [], chats = [] } = {}) {
  AuditLog.aggregate.mockResolvedValueOnce(acted).mockResolvedValueOnce(signedIn);
  ApiToken.aggregate.mockResolvedValueOnce(tokens);
  ChatUsage.aggregate.mockResolvedValueOnce(chats);
}

beforeEach(() => {
  jest.clearAllMocks();
  User.bulkWrite.mockImplementation(async (ops) => ({ modifiedCount: ops.length }));
});

test('the latest evidence wins, stored as midnight UTC of that day', async () => {
  User.find.mockReturnValue(lean([
    { _id: oid('a'), createdAt: new Date('2026-05-02T09:00:00Z'), sessions: [{ lastUsedAt: new Date('2026-10-20T18:00:00Z') }] },
    { _id: oid('b'), createdAt: new Date('2026-06-01T09:00:00Z'), sessions: [] },
    { _id: oid('c'), createdAt: new Date('2026-07-01T09:00:00Z') },
    { _id: oid('d'), createdAt: new Date('2025-09-01T09:00:00Z') },
  ]));
  evidence({
    acted: [{ _id: oid('a'), at: new Date('2026-10-10T08:00:00Z') }],           // older than a's session
    signedIn: [{ _id: oid('b'), at: new Date('2026-09-15T21:00:00Z') }],
    tokens: [{ _id: oid('c'), at: new Date('2026-10-30T23:59:00Z') }],          // an integration, after the log
    chats: [{ _id: oid('b'), day: '2026-09-16' }],                              // a day after b's sign-in
  });

  const r = await backfillLastActive({ apply: true, now: () => NOW });

  const written = Object.fromEntries(User.bulkWrite.mock.calls[0][0].map((o) => [o.updateOne.filter._id, o.updateOne.update.$set.lastActiveAt]));
  expect(written).toEqual({
    [oid('a')]: day('2026-10-20'),
    [oid('b')]: day('2026-09-16'),
    [oid('c')]: day('2026-10-30'),
    [oid('d')]: day('2025-09-01'), // nothing but its creation
  });
  expect(r).toEqual({ candidates: 4, applied: 4, byAge: { under30d: 2, '30-90d': 1, '90-180d': 0, '180-365d': 0, over365d: 1 } });
});

test('only accounts without a value are read, and the write is guarded against a live write since', async () => {
  User.find.mockReturnValue(lean([{ _id: oid('a'), createdAt: new Date('2026-10-01T00:00:00Z') }]));
  evidence();

  await backfillLastActive({ apply: true, now: () => NOW });

  expect(User.find.mock.calls[0][0]).toEqual({ lastActiveAt: null });
  expect(User.bulkWrite.mock.calls[0][0][0].updateOne.filter).toEqual({ _id: oid('a'), lastActiveAt: null });
});

test('sign-ins are read by the account they are about (their actor is null), own actions by the actor', async () => {
  User.find.mockReturnValue(lean([{ _id: oid('a'), createdAt: NOW }]));
  evidence();

  await backfillLastActive({ now: () => NOW });

  const [actedPipeline] = AuditLog.aggregate.mock.calls[0];
  const [signInPipeline] = AuditLog.aggregate.mock.calls[1];
  expect(actedPipeline[0].$match).toEqual({ 'actor.userId': { $in: [oid('a')] } });
  expect(signInPipeline[0].$match).toEqual({ action: { $in: SIGN_IN_ACTIONS }, 'resource.id': { $in: [oid('a')] } });
  expect(signInPipeline[1].$group._id).toBe('$resource.id');
});

test('a dry run counts and writes nothing', async () => {
  User.find.mockReturnValue(lean([{ _id: oid('a'), createdAt: new Date('2026-10-30T00:00:00Z') }]));
  evidence();

  const r = await backfillLastActive({ now: () => NOW });

  expect(r.candidates).toBe(1);
  expect(r.applied).toBe(0);
  expect(r.byAge.under30d).toBe(1);
  expect(User.bulkWrite).not.toHaveBeenCalled();
});

test('nothing to fill: no evidence is read', async () => {
  User.find.mockReturnValue(lean([]));
  const r = await backfillLastActive({ apply: true, now: () => NOW });
  expect(r).toEqual({ candidates: 0, applied: 0, byAge: { under30d: 0, '30-90d': 0, '90-180d': 0, '180-365d': 0, over365d: 0 } });
  expect(AuditLog.aggregate).not.toHaveBeenCalled();
  expect(User.bulkWrite).not.toHaveBeenCalled();
});
