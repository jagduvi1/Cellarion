/**
 * scripts/migrate-closed-proposals — moves the proposals a merge or a delete
 * closed automatically from 'rejected' to 'closed'. Model mocked.
 */
jest.mock('../models/WineCorrectionProposal', () => ({ countDocuments: jest.fn(), updateMany: jest.fn() }));

const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { migrateClosedProposals, FILTER } = require('./migrate-closed-proposals');

beforeEach(() => jest.clearAllMocks());

test('the selection is exactly the automatic closures: rejected, no decider, the automatic reason', () => {
  expect(FILTER).toEqual({ status: 'rejected', decidedBy: null, rejectReason: /^Closed automatically/ });
});

test('a dry run counts and writes nothing', async () => {
  WineCorrectionProposal.countDocuments.mockResolvedValue(32);
  expect(await migrateClosedProposals()).toEqual({ candidates: 32, moved: 0 });
  expect(WineCorrectionProposal.updateMany).not.toHaveBeenCalled();
});

test('--apply moves them to closed, and only them', async () => {
  WineCorrectionProposal.countDocuments.mockResolvedValue(32);
  WineCorrectionProposal.updateMany.mockResolvedValue({ modifiedCount: 32 });
  expect(await migrateClosedProposals({ apply: true })).toEqual({ candidates: 32, moved: 32 });
  expect(WineCorrectionProposal.updateMany).toHaveBeenCalledWith(FILTER, { $set: { status: 'closed' } });
});

test('nothing to move: no write', async () => {
  WineCorrectionProposal.countDocuments.mockResolvedValue(0);
  expect(await migrateClosedProposals({ apply: true })).toEqual({ candidates: 0, moved: 0 });
  expect(WineCorrectionProposal.updateMany).not.toHaveBeenCalled();
});
