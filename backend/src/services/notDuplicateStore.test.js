/**
 * services/notDuplicateStore — the "not the same wine" verdicts.
 *
 * One row per unordered pair, the smaller id first. The scans ask whether a
 * pair has a verdict without caring about the order they hold the two wines
 * in; the admin routes record and withdraw a verdict for every pair of a set.
 */

jest.mock('../models/WineNotDuplicate', () => ({
  find: jest.fn(),
  bulkWrite: jest.fn(),
  deleteMany: jest.fn(),
}));

const WineNotDuplicate = require('../models/WineNotDuplicate');
const {
  loadNotDuplicates, buildWinePairs, markNotDuplicates, unmarkNotDuplicates, forgetWine,
} = require('./notDuplicateStore');

const A = '64b0000000000000000000a1';
const B = '64b0000000000000000000b2';
const C = '64b0000000000000000000c3';

const rows = (list) => ({ select: () => ({ lean: () => Promise.resolve(list) }) });
const asStrings = (pair) => ({ wineA: String(pair.wineA), wineB: String(pair.wineB) });

beforeEach(() => jest.clearAllMocks());

describe('loadNotDuplicates', () => {
  test('answers for a pair in either order, and for no other pair', async () => {
    WineNotDuplicate.find.mockReturnValue(rows([{ wineA: A, wineB: B }]));
    const verdicts = await loadNotDuplicates();

    expect(verdicts.has(A, B)).toBe(true);
    expect(verdicts.has(B, A)).toBe(true);
    expect(verdicts.has(A, C)).toBe(false);
    expect(WineNotDuplicate.find).toHaveBeenCalledWith({});
  });

  test('takes ids as strings or as objects that print as their id', async () => {
    WineNotDuplicate.find.mockReturnValue(rows([{ wineA: { toString: () => A }, wineB: { toString: () => B } }]));
    const verdicts = await loadNotDuplicates();

    expect(verdicts.has({ toString: () => B }, A)).toBe(true);
  });

  test('with no row, no pair has a verdict', async () => {
    WineNotDuplicate.find.mockReturnValue(rows([]));

    expect((await loadNotDuplicates()).has(A, B)).toBe(false);
  });
});

describe('buildWinePairs', () => {
  test('every unordered pair once, the smaller id first', () => {
    expect(buildWinePairs([C, A, B]).map(asStrings)).toEqual([
      { wineA: A, wineB: C },
      { wineA: B, wineB: C },
      { wineA: A, wineB: B },
    ]);
  });

  test('fewer than two ids make no pair', () => {
    expect(buildWinePairs([A])).toEqual([]);
    expect(buildWinePairs([])).toEqual([]);
  });
});

describe('markNotDuplicates', () => {
  test('upserts one row per pair and returns how many pairs', async () => {
    WineNotDuplicate.bulkWrite.mockResolvedValue({});
    const count = await markNotDuplicates([A, B, C]);

    expect(count).toBe(3);
    const [ops, options] = WineNotDuplicate.bulkWrite.mock.calls[0];
    expect(options).toEqual({ ordered: false });
    expect(ops).toHaveLength(3);
    for (const op of ops) {
      expect(op.updateOne.upsert).toBe(true);
      expect(asStrings(op.updateOne.update.$setOnInsert)).toEqual(asStrings(op.updateOne.filter));
    }
  });
});

describe('unmarkNotDuplicates', () => {
  test('deletes exactly the pairs of the set and returns how many rows went', async () => {
    WineNotDuplicate.deleteMany.mockResolvedValue({ deletedCount: 1 });
    const removed = await unmarkNotDuplicates([B, A]);

    expect(removed).toBe(1);
    expect(WineNotDuplicate.deleteMany.mock.calls[0][0].$or.map(asStrings)).toEqual([{ wineA: A, wineB: B }]);
  });

  test('returns 0 when the driver reports no count', async () => {
    WineNotDuplicate.deleteMany.mockResolvedValue({});

    expect(await unmarkNotDuplicates([A, B])).toBe(0);
  });
});

describe('forgetWine', () => {
  test('drops every verdict that names the wine, on either side', () => {
    const query = { then: jest.fn() };
    WineNotDuplicate.deleteMany.mockReturnValue(query);

    expect(forgetWine(A)).toBe(query);
    expect(WineNotDuplicate.deleteMany).toHaveBeenCalledWith({ $or: [{ wineA: A }, { wineB: A }] });
  });
});
