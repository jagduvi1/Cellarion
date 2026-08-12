/**
 * ownerInquiryOps — the shared owner-inquiry engine (REST + MCP both call it).
 *
 * Pins: recipient building (ACTIVE owners first, consumed-owner fallback,
 * per-user dedupe via $group, cap 20); create validation + notification
 * fan-out + the E11000 → conflict mapping; the lazy expiry sweep; the
 * needs-attention-first page query; and the merge/delete lifecycle (answered
 * rows follow the bottles, an open row closes only when the keeper already
 * has one — including the 11000 race fallback).
 */

jest.mock('../models/WineOwnerInquiry', () => ({
  create: jest.fn(),
  updateMany: jest.fn(),
  exists: jest.fn(),
  aggregate: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn() }));
jest.mock('./notifications', () => ({ createNotifications: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { createNotifications } = require('./notifications');
const { logAudit } = require('./audit');
const { CONSUMED_STATUSES } = require('../config/constants');
const {
  RECIPIENT_CAP,
  EXPIRY_NOTE,
  buildRecipients,
  createOwnerInquiry,
  sweepExpiredInquiries,
  queryInquiryPage,
  repointInquiriesForWineMerge,
  closeInquiriesForWineDelete,
} = require('./ownerInquiryOps');

const oid = (c) => c.repeat(24);
const WINE = oid('a');
const ASKER = oid('b');
const QUESTION = 'What does the label say the producer is?';

const wineDoc = { _id: WINE, name: 'Barolo', producer: 'Pira' };
const mockWineFound = () => WineDefinition.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(wineDoc) });

beforeEach(() => {
  jest.clearAllMocks();
  WineOwnerInquiry.updateMany.mockResolvedValue({ modifiedCount: 0 });
});

describe('buildRecipients', () => {
  test('active owners first: matches status $nin CONSUMED, newest bottle per user, capped at 20 in the pipeline', async () => {
    Bottle.aggregate.mockResolvedValue([
      { _id: oid('1'), bottle: oid('2'), cellar: oid('3') },
      { _id: oid('4'), bottle: oid('5'), cellar: oid('6') },
    ]);

    const { recipients, fallbackUsed } = await buildRecipients(WINE);

    expect(fallbackUsed).toBe(false);
    expect(recipients).toHaveLength(2);
    expect(String(recipients[0].user)).toBe(oid('1'));
    expect(String(recipients[0].bottle)).toBe(oid('2'));
    expect(Bottle.aggregate).toHaveBeenCalledTimes(1);

    const pipeline = Bottle.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.status).toEqual({ $nin: CONSUMED_STATUSES });
    // Newest-first sort feeds $first, so each user's entry is their latest bottle.
    expect(pipeline[1]).toEqual({ $sort: { createdAt: -1 } });
    expect(pipeline[2].$group._id).toBe('$user');
    // Audit 2026-08-11: demo accounts can never respond (requireNonDemo) and
    // must not crowd real owners out of the cap — excluded BEFORE $limit; and
    // the cap must be deterministic (newest owners), so the group re-sorts on
    // the captured latest before limiting ($group emits undefined order).
    expect(pipeline[2].$group.latest).toEqual({ $first: '$createdAt' });
    expect(pipeline[3].$lookup).toMatchObject({ from: 'users', localField: '_id' });
    expect(pipeline[4]).toEqual({ $match: { 'owner.isDemo': { $ne: true } } });
    expect(pipeline[5]).toEqual({ $sort: { latest: -1 } });
    expect(pipeline[6]).toEqual({ $limit: RECIPIENT_CAP });
  });

  test('falls back to consumed-bottle owners when no active bottles exist', async () => {
    Bottle.aggregate
      .mockResolvedValueOnce([]) // active pass: nothing
      .mockResolvedValueOnce([{ _id: oid('7'), bottle: oid('8'), cellar: oid('9') }]);

    const { recipients, fallbackUsed } = await buildRecipients(WINE);

    expect(fallbackUsed).toBe(true);
    expect(recipients).toHaveLength(1);
    expect(Bottle.aggregate.mock.calls[1][0][0].$match.status).toEqual({ $in: CONSUMED_STATUSES });
  });

  test('legacy bottles without an owner are dropped, never notified', async () => {
    Bottle.aggregate.mockResolvedValue([
      { _id: null, bottle: oid('2'), cellar: oid('3') },
      { _id: oid('4'), bottle: oid('5'), cellar: oid('6') },
    ]);
    const { recipients } = await buildRecipients(WINE);
    expect(recipients).toHaveLength(1);
    expect(String(recipients[0].user)).toBe(oid('4'));
  });
});

describe('createOwnerInquiry', () => {
  const happyRecipients = () => Bottle.aggregate.mockResolvedValue([
    { _id: oid('1'), bottle: oid('2'), cellar: oid('3') },
    { _id: oid('4'), bottle: oid('5'), cellar: oid('6') },
  ]);

  test('refuses a short / HTML-only / overlong question before touching the DB', async () => {
    for (const q of ['short', '<b><i></i></b>', 'x'.repeat(501), 42, undefined]) {
      const res = await createOwnerInquiry({ wineId: WINE, userId: ASKER, question: q });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('invalid_input');
    }
    expect(WineDefinition.findById).not.toHaveBeenCalled();
    expect(WineOwnerInquiry.create).not.toHaveBeenCalled();
  });

  // Regression: this was REFUSED with a conflict on the reasoning that a
  // pending row's only owner is its creator, so asking adds nothing over
  // reading the scan. Wrong — when the scan cannot answer (washed-out producer
  // line, a label that prints no producer at all), the owner holds the bottle
  // and can read the back label. Refusing left those rows stuck with no
  // escalation at all (found in use 2026-08-12).
  test('ASKS a pending-identity wine — the owner can read the back label the scan cannot show', async () => {
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ ...wineDoc, pendingIdentity: true }),
    });
    happyRecipients();
    WineOwnerInquiry.create.mockResolvedValue({ _id: oid('e'), status: 'open', question: QUESTION });

    const res = await createOwnerInquiry({ wineId: WINE, userId: ASKER, question: QUESTION });

    expect(res.ok).toBe(true);
    expect(WineOwnerInquiry.create).toHaveBeenCalled();
  });

  test('strips HTML from the question — owners read plain text', async () => {
    mockWineFound();
    happyRecipients();
    WineOwnerInquiry.create.mockResolvedValue({ _id: oid('e'), status: 'open', question: QUESTION });

    await createOwnerInquiry({ wineId: WINE, userId: ASKER, question: `<script>x</script>${QUESTION}` });

    expect(WineOwnerInquiry.create.mock.calls[0][0].question).toBe(`x${QUESTION}`);
  });

  test('404s an unknown wine, refuses when nobody owns (or ever owned) a bottle', async () => {
    WineDefinition.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    let res = await createOwnerInquiry({ wineId: WINE, userId: ASKER, question: QUESTION });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });

    mockWineFound();
    Bottle.aggregate.mockResolvedValue([]); // both passes empty
    res = await createOwnerInquiry({ wineId: WINE, userId: ASKER, question: QUESTION });
    expect(res).toMatchObject({ ok: false, code: 'no_owners' });
    expect(WineOwnerInquiry.create).not.toHaveBeenCalled();
  });

  test('creates with per-recipient notifiedAt, fans out owner_inquiry notifications with bottle deep links, audits', async () => {
    mockWineFound();
    happyRecipients();
    WineOwnerInquiry.create.mockResolvedValue({ _id: oid('e'), status: 'open', question: QUESTION, expiresAt: new Date() });

    const res = await createOwnerInquiry({ wineId: WINE, userId: ASKER, via: 'rest', question: QUESTION });

    expect(res.ok).toBe(true);
    expect(res.recipientCount).toBe(2);

    const created = WineOwnerInquiry.create.mock.calls[0][0];
    expect(String(created.askedBy)).toBe(ASKER);
    expect(created.askedVia).toBe('rest');
    expect(created.recipients).toHaveLength(2);
    expect(created.recipients[0].notifiedAt).toBeInstanceOf(Date);
    // The recipient's cellar is used ONLY for the link — never stored.
    expect(created.recipients[0].cellar).toBeUndefined();

    // One batch call, one item per recipient, deep-linked to THEIR bottle.
    expect(createNotifications).toHaveBeenCalledTimes(1);
    const items = createNotifications.mock.calls[0][0];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      userId: oid('1'),
      type: 'owner_inquiry',
      link: `/cellars/${oid('3')}/bottles/${oid('2')}`,
    });

    // Same audit action string as the MCP path (via distinguishes them).
    const audit = logAudit.mock.calls.find((c) => c[1] === 'admin.wine.ownerInquiry.create');
    expect(audit).toBeTruthy();
    expect(audit[3].recipients).toBe(2);
    expect(audit[3].via).toBeUndefined(); // rest carries no via marker
  });

  test('via mcp is stamped on the audit detail (REST/MCP parity on the action string)', async () => {
    mockWineFound();
    happyRecipients();
    WineOwnerInquiry.create.mockResolvedValue({ _id: oid('e'), status: 'open' });

    await createOwnerInquiry({ wineId: WINE, userId: ASKER, via: 'mcp', question: QUESTION });

    const audit = logAudit.mock.calls.find((c) => c[1] === 'admin.wine.ownerInquiry.create');
    expect(audit[3].via).toBe('mcp');
  });

  test('the one-open-per-wine E11000 becomes a clean conflict', async () => {
    mockWineFound();
    happyRecipients();
    WineOwnerInquiry.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    const res = await createOwnerInquiry({ wineId: WINE, userId: ASKER, question: QUESTION });

    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(createNotifications).not.toHaveBeenCalled();
  });
});

describe('sweepExpiredInquiries', () => {
  test('closes only expired OPEN rows, stamps resolvedAt (arming the TTL), audits the batch', async () => {
    WineOwnerInquiry.updateMany.mockResolvedValue({ modifiedCount: 3 });
    const closed = await sweepExpiredInquiries();
    expect(closed).toBe(3);

    const [filter, update] = WineOwnerInquiry.updateMany.mock.calls[0];
    expect(filter.status).toBe('open');
    expect(filter.expiresAt.$lt).toBeInstanceOf(Date);
    expect(update.$set.status).toBe('closed');
    expect(update.$set.resolvedAt).toBeInstanceOf(Date);
    expect(update.$set.resolutionNote).toBe(EXPIRY_NOTE);
    expect(logAudit).toHaveBeenCalledWith(null, 'admin.wine.ownerInquiry.close', {}, { reason: 'expired', count: 3 });
  });

  test('a no-op sweep does not audit', async () => {
    WineOwnerInquiry.updateMany.mockResolvedValue({ modifiedCount: 0 });
    expect(await sweepExpiredInquiries()).toBe(0);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('queryInquiryPage', () => {
  test('ranks answered > open > decided, newest first within rank, and returns the badge counts', async () => {
    WineOwnerInquiry.aggregate.mockResolvedValue([{ _id: oid('e') }]);
    WineOwnerInquiry.countDocuments
      .mockResolvedValueOnce(5)  // total for filter
      .mockResolvedValueOnce(4)  // pendingCount (open+answered)
      .mockResolvedValueOnce(2); // answeredCount

    const out = await queryInquiryPage({ status: 'open' }, { limit: 20, offset: 40 });

    expect(out).toMatchObject({ total: 5, pendingCount: 4, answeredCount: 2 });
    const pipeline = WineOwnerInquiry.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { status: 'open' } });
    const rank = pipeline[1].$addFields._rank.$switch;
    expect(rank.branches[0]).toEqual({ case: { $eq: ['$status', 'answered'] }, then: 0 });
    expect(rank.branches[1]).toEqual({ case: { $eq: ['$status', 'open'] }, then: 1 });
    expect(rank.default).toBe(2);
    expect(pipeline[2]).toEqual({ $sort: { _rank: 1, createdAt: -1 } });
    expect(pipeline[3]).toEqual({ $skip: 40 });
    expect(pipeline[4]).toEqual({ $limit: 20 });
    expect(WineOwnerInquiry.countDocuments.mock.calls[1][0]).toEqual({ status: { $in: ['open', 'answered'] } });
    expect(WineOwnerInquiry.countDocuments.mock.calls[2][0]).toEqual({ status: 'answered' });
  });
});

describe('repointInquiriesForWineMerge', () => {
  const SRC = oid('c');
  const TGT = oid('d');

  test('answered rows ALWAYS follow the bottles; the open row re-points when the keeper has none', async () => {
    WineOwnerInquiry.updateMany
      .mockResolvedValueOnce({ modifiedCount: 2 })  // answered re-point
      .mockResolvedValueOnce({ modifiedCount: 1 }); // open re-point
    WineOwnerInquiry.exists.mockResolvedValue(null);

    const out = await repointInquiriesForWineMerge(SRC, TGT, 'Pira — Barolo');

    expect(out).toEqual({ repointed: 3, closed: 0 });
    expect(WineOwnerInquiry.updateMany.mock.calls[0]).toEqual([
      { wineDefinition: SRC, status: 'answered' },
      { $set: { wineDefinition: TGT } },
    ]);
    expect(WineOwnerInquiry.updateMany.mock.calls[1]).toEqual([
      { wineDefinition: SRC, status: 'open' },
      { $set: { wineDefinition: TGT } },
    ]);
    expect(logAudit).not.toHaveBeenCalled(); // nothing closed
  });

  test('keeper already has an open inquiry → the source open row closes with the merge reason (proposal wording), audited', async () => {
    WineOwnerInquiry.updateMany
      .mockResolvedValueOnce({ modifiedCount: 0 })  // no answered rows
      .mockResolvedValueOnce({ modifiedCount: 1 }); // close
    WineOwnerInquiry.exists.mockResolvedValue({ _id: oid('9') });

    const out = await repointInquiriesForWineMerge(SRC, TGT, 'Pira — Barolo');

    expect(out).toEqual({ repointed: 0, closed: 1 });
    const [filter, update] = WineOwnerInquiry.updateMany.mock.calls[1];
    expect(filter).toEqual({ wineDefinition: SRC, status: 'open' });
    expect(update.$set.status).toBe('closed');
    expect(update.$set.resolvedAt).toBeInstanceOf(Date);
    expect(update.$set.resolutionNote).toMatch(/merged into "Pira — Barolo"/);
    expect(update.$set.resolutionNote).toMatch(/Ask again on that wine/);
    expect(logAudit).toHaveBeenCalledWith(null, 'admin.wine.ownerInquiry.close',
      { type: 'wine', id: SRC }, { reason: 'merge', count: 1, targetId: TGT });
  });

  test('a raced ask on the keeper (E11000 on the re-point) falls back to the close path', async () => {
    WineOwnerInquiry.exists.mockResolvedValue(null);
    WineOwnerInquiry.updateMany
      .mockResolvedValueOnce({ modifiedCount: 0 }) // answered
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 })) // open re-point collides
      .mockResolvedValueOnce({ modifiedCount: 1 }); // fallback close

    const out = await repointInquiriesForWineMerge(SRC, TGT, 'Pira — Barolo');

    expect(out).toEqual({ repointed: 0, closed: 1 });
    expect(WineOwnerInquiry.updateMany.mock.calls[2][1].$set.status).toBe('closed');
  });
});

describe('closeInquiriesForWineDelete', () => {
  test('closes ALL active inquiries (open + answered) with the deletion reason, audited', async () => {
    WineOwnerInquiry.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const closed = await closeInquiriesForWineDelete(WINE);

    expect(closed).toBe(2);
    const [filter, update] = WineOwnerInquiry.updateMany.mock.calls[0];
    expect(filter).toEqual({ wineDefinition: WINE, status: { $in: ['open', 'answered'] } });
    expect(update.$set.status).toBe('closed');
    expect(update.$set.resolutionNote).toMatch(/wine was deleted/);
    expect(logAudit).toHaveBeenCalledWith(null, 'admin.wine.ownerInquiry.close',
      { type: 'wine', id: WINE }, { reason: 'wine-deleted', count: 2 });
  });
});
