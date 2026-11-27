/**
 * services/uncheckedWineSweepJob — which waiting wines the daily sweep looks at.
 *
 * WHY THIS TEST EXISTS:
 * The sweep read the 500 oldest waiting wines and then dropped the ones a
 * bottle holds. A queue whose 500 oldest wines ARE held (two large imports
 * are enough) then hid every wine behind them for good. It must walk the
 * whole queue a page at a time, hand only bottle-less wines to the per-wine
 * guards, and tell those guards to delete a wine only while it still waits.
 * What the guards themselves keep is pinned against a real database in
 * services/uncheckedWines.mongo.test.js.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ distinct: jest.fn() }));
jest.mock('./registryGc', () => ({ gcOrphanMintedWine: jest.fn() }));
jest.mock('./audit', () => ({ logger: { warn: jest.fn() } }));

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { gcOrphanMintedWine } = require('./registryGc');
const { logger } = require('./audit');
const { runUncheckedWineSweep, PAGE_SIZE, MIN_AGE_MS } = require('./uncheckedWineSweepJob');

const ids = (from, n) => Array.from({ length: n }, (_, i) => ({ _id: `w${String(from + i).padStart(5, '0')}` }));
const NOW = new Date('2026-11-27T05:10:00Z');

let pages;
beforeEach(() => {
  jest.clearAllMocks();
  pages = [];
  WineDefinition.find.mockImplementation(() => {
    const page = pages.shift() || [];
    const q = { select: () => q, sort: () => q, limit: () => q, lean: async () => page };
    return q;
  });
  Bottle.distinct.mockResolvedValue([]);
  gcOrphanMintedWine.mockResolvedValue({ removed: true });
});

test('a full page of held wines does not hide the wines behind it', async () => {
  const held = ids(0, PAGE_SIZE);
  const behind = ids(PAGE_SIZE, 3);
  pages = [held, behind];
  Bottle.distinct
    .mockResolvedValueOnce(held.map((w) => w._id)) // every wine of page one has a bottle
    .mockResolvedValueOnce([]);

  const result = await runUncheckedWineSweep({ now: NOW });

  expect(result).toEqual({ examined: PAGE_SIZE + 3, candidates: 3, removed: 3, kept: 0, errors: 0 });
  // The second read continues after the last id of the first page.
  expect(WineDefinition.find.mock.calls[1][0]._id).toEqual({ $gt: held[PAGE_SIZE - 1]._id });
  expect(gcOrphanMintedWine.mock.calls.map((c) => c[0])).toEqual(behind.map((w) => w._id));
});

test('only waiting wines older than a day are read, never a draft', async () => {
  pages = [ids(0, 2)];
  await runUncheckedWineSweep({ now: NOW });

  expect(WineDefinition.find.mock.calls[0][0]).toEqual({
    uncheckedIdentity: true,
    draft: { $ne: true },
    createdAt: { $lt: new Date(NOW.getTime() - MIN_AGE_MS) },
  });
});

test('a wine is deleted only while it still waits, under the sweep\'s own audit action', async () => {
  pages = [ids(0, 1)];
  await runUncheckedWineSweep({ now: NOW });

  expect(gcOrphanMintedWine).toHaveBeenCalledWith('w00000', null, {
    action: 'wine.unchecked_orphan_delete', via: 'sweep', onlyIf: { uncheckedIdentity: true },
  });
});

test('a wine the guards keep is counted as kept, and one failing wine does not stop the rest', async () => {
  pages = [ids(0, 3)];
  gcOrphanMintedWine
    .mockResolvedValueOnce({ removed: false, reason: 'member content still references it (WishlistItem)' })
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce({ removed: true });

  expect(await runUncheckedWineSweep({ now: NOW })).toEqual({ examined: 3, candidates: 3, removed: 1, kept: 1, errors: 1 });
  expect(logger.warn).toHaveBeenCalledTimes(1);
});

test('an empty queue reads once and does nothing', async () => {
  expect(await runUncheckedWineSweep({ now: NOW })).toEqual({ examined: 0, candidates: 0, removed: 0, kept: 0, errors: 0 });
  expect(WineDefinition.find).toHaveBeenCalledTimes(1);
  expect(Bottle.distinct).not.toHaveBeenCalled();
});
