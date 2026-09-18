/**
 * wineCorrectionNotify — telling a submitter what became of their correction,
 * from every place one gets decided.
 *
 * Pre-deploy audit 2026-09-18: the bottle page promises "we'll notify you when
 * a curator has decided", but a merge or a delete closed the wine's pending
 * corrections with a bare updateMany and told nobody — and a merge is exactly
 * where a correction that makes a wine collide with its twin ends up.
 */

jest.mock('../models/WineCorrectionProposal', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn() }));

const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { createNotification } = require('./notifications');
const { notifyProposer, closePendingForWine } = require('./wineCorrectionNotify');

const oid = (c) => c.repeat(24);
const USER = oid('a');
const ADMIN = oid('d');
const SOURCE = oid('b');
const KEEPER = oid('c');

const row = (over = {}) => ({
  kind: 'field_correction', via: 'ui', proposer: USER,
  proposedFields: { producer: 'E. Pira e Figli', grapes: ['Nebbiolo'], appellation: null },
  ...over,
});
const found = (rows) => WineCorrectionProposal.find.mockReturnValue({ select: () => ({ lean: async () => rows }) });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  createNotification.mockResolvedValue(undefined);
  WineCorrectionProposal.updateMany.mockResolvedValue({ modifiedCount: 1 });
  found([]);
});

describe('notifyProposer', () => {
  test('applied: names the wine and the fields that carried a value, links to the wine', async () => {
    notifyProposer(row(), { _id: SOURCE, producer: 'Pira', name: 'Barolo' }, ADMIN, true);
    await flush();
    expect(createNotification).toHaveBeenCalledWith(
      USER, 'wine_correction_decided', 'Wine correction applied',
      'Your suggested fix for Pira — Barolo (producer, grapes) is now live in the registry. Thank you for improving it.',
      `/wines/${SOURCE}`
    );
  });

  test('not applied: the reason follows, and a wine that is gone gets no link', async () => {
    notifyProposer(row(), { producer: 'Pira', name: 'Barolo' }, ADMIN, false, 'The estate site still says Pira.');
    await flush();
    const [, , title, message, link] = createNotification.mock.calls[0];
    expect(title).toBe('Wine correction not applied');
    expect(message).toBe('Your suggested fix for Pira — Barolo (producer, grapes) was not applied.\n\nThe estate site still says Pira.');
    expect(link).toBeNull();
  });

  test.each([
    ['a sommelier proposal (filed without an origin)', row({ via: null })],
    ['a row from before origins were recorded', row({ via: undefined })],
    ['a merge proposal', row({ kind: 'merge' })],
    ['the decider\'s own suggestion', row({ proposer: ADMIN })],
    ['a row with no proposer left (erased account)', row({ proposer: null })],
  ])('%s notifies nobody', async (_label, proposal) => {
    notifyProposer(proposal, { _id: SOURCE, producer: 'Pira', name: 'Barolo' }, ADMIN, true);
    await flush();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a mongoose subdocument, a missing wine and a lifecycle closure (no decider) are all fine', async () => {
    notifyProposer(row({ proposedFields: { toObject: () => ({ type: 'white' }) } }), null, null, false, 'Closed automatically.');
    await flush();
    expect(createNotification.mock.calls[0][3]).toBe('Your suggested fix for a wine (type) was not applied.\n\nClosed automatically.');
  });

  test('never throws and never rejects — neither on a synchronous throw nor on a failed send', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    createNotification.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => notifyProposer(row(), null, ADMIN, true)).not.toThrow();
    createNotification.mockRejectedValueOnce(new Error('push service down'));
    expect(() => notifyProposer(row(), null, ADMIN, true)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('closePendingForWine', () => {
  const REASON = 'Closed automatically: the wine was merged into "Pira — Barolo". Re-file against that wine if the issue still applies.';

  test('closes EVERY pending proposal on or targeting the wine, decidedBy left alone', async () => {
    await closePendingForWine(SOURCE, REASON);
    const [filter, update] = WineCorrectionProposal.updateMany.mock.calls[0];
    expect(filter).toEqual({ status: 'pending', $or: [{ wineDefinition: SOURCE }, { mergeTargetId: SOURCE }] });
    expect(update.$set).toMatchObject({ status: 'rejected', rejectReason: REASON });
    expect(update.$set.decidedAt).toBeInstanceOf(Date);
    expect(update.$set).not.toHaveProperty('decidedBy');
  });

  test('reads who to tell BEFORE the update — afterwards they are just rejected rows — and only the user pipeline', async () => {
    const order = [];
    WineCorrectionProposal.find.mockImplementation(() => { order.push('find'); return { select: () => ({ lean: async () => [row()] }) }; });
    WineCorrectionProposal.updateMany.mockImplementation(async () => { order.push('update'); return {}; });
    await closePendingForWine(SOURCE, REASON, { wine: { producer: 'Pira Luigi', name: 'Barolo' }, linkWineId: KEEPER, actorId: ADMIN });
    expect(order).toEqual(['find', 'update']);
    expect(WineCorrectionProposal.find.mock.calls[0][0]).toMatchObject({ status: 'pending', kind: 'field_correction', via: { $ne: null } });
  });

  test('a merge tells the submitter under the name they knew, and links to the KEEPER', async () => {
    found([row()]);
    await closePendingForWine(SOURCE, REASON, { wine: { producer: 'Pira Luigi', name: 'Barolo' }, linkWineId: KEEPER, actorId: ADMIN });
    await flush();
    const [to, type, title, message, link] = createNotification.mock.calls[0];
    expect([to, type, title]).toEqual([USER, 'wine_correction_decided', 'Wine correction not applied']);
    expect(message).toBe(`Your suggested fix for Pira Luigi — Barolo (producer, grapes) was not applied.\n\n${REASON}`);
    expect(link).toBe(`/wines/${KEEPER}`);
  });

  test('a delete has nowhere to link; the admin doing it is not told about their own suggestion', async () => {
    found([row(), row({ proposer: ADMIN })]);
    await closePendingForWine(SOURCE, 'Closed automatically: the wine was deleted before review.', { wine: { producer: 'Pira', name: 'Barolo' }, actorId: ADMIN });
    await flush();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toBe(USER);
    expect(createNotification.mock.calls[0][4]).toBeNull();
  });

  test('failing to read the submitters costs the notifications, never the closure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    WineCorrectionProposal.find.mockImplementation(() => { throw new Error('primary stepped down'); });
    await expect(closePendingForWine(SOURCE, REASON)).resolves.toBeDefined();
    expect(WineCorrectionProposal.updateMany).toHaveBeenCalledTimes(1);
    expect(createNotification).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a failed closure still fails loudly — the caller must know the rows are still pending', async () => {
    WineCorrectionProposal.updateMany.mockRejectedValue(new Error('write concern'));
    found([row()]);
    await expect(closePendingForWine(SOURCE, REASON)).rejects.toThrow('write concern');
    await flush();
    expect(createNotification).not.toHaveBeenCalled();
  });
});
