/**
 * services/scanImageRetentionJob — a daily run drains each clock
 * (scaling audit 2026-09-25). It used to take ONE batch of 500 per clock per
 * day, so once more than 500 rows lapsed in a day the backlog only grew and
 * the 30-day / 7-day retention promises quietly became weeks.
 *
 * Pinned here: a backlog larger than a batch is cleared in one run; a run
 * stops at its batch budget; a batch that deletes nothing (rows changed under
 * it) ends the run instead of spinning.
 */
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./labelScanAccess', () => ({ PROMOTED_SCAN_GRACE_DAYS: 7 }));

const BottleImage = require('../models/BottleImage');
const { unlinkImageFiles } = require('./imageProcessor');
const {
  runUnattachedScanSweep,
  runPromotedScanExpirySweep,
  runUnattachedBottleImageSweep,
  runScanImageRetentionSweep,
  SWEEP_LIMIT,
  MAX_BATCHES_PER_RUN,
} = require('./scanImageRetentionJob');

// An in-memory collection behind the two query shapes the job uses:
//   find(selector).select().limit(n).lean()   — a batch of lapsed rows
//   find({ _id: { $in } }).select().lean()    — which of those survived
// deleteMany({ _id: { $in } }) removes them unless `refuseDeletes` is set
// (every row changed between the find and the delete).
function store(count) {
  let rows = Array.from({ length: count }, (_, i) => ({ _id: `img${i}`, originalUrl: `/api/uploads/originals/${i}.jpg` }));
  const state = { refuseDeletes: false, batches: 0 };
  BottleImage.find.mockImplementation((selector) => {
    let limit = Infinity;
    const chain = {
      select() { return chain; },
      limit(n) { limit = n; return chain; },
      lean: async () => {
        if (selector._id?.$in) return rows.filter((r) => selector._id.$in.includes(r._id)).map((r) => ({ _id: r._id }));
        state.batches++;
        return rows.slice(0, limit);
      },
    };
    return chain;
  });
  BottleImage.deleteMany.mockImplementation(async (filter) => {
    if (state.refuseDeletes) return { deletedCount: 0 };
    const ids = new Set(filter._id.$in);
    const before = rows.length;
    rows = rows.filter((r) => !ids.has(r._id));
    return { deletedCount: before - rows.length };
  });
  return { state, remaining: () => rows.length };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => console.log.mockRestore());

test('a backlog bigger than one batch is cleared in one run, batch by batch', async () => {
  const s = store(SWEEP_LIMIT * 2 + 250);
  expect(await runUnattachedScanSweep()).toEqual({ deleted: SWEEP_LIMIT * 2 + 250 });
  expect(s.remaining()).toBe(0);
  expect(s.state.batches).toBe(3); // 500 + 500 + 250 (short → done)
  expect(unlinkImageFiles).toHaveBeenCalledTimes(SWEEP_LIMIT * 2 + 250);
});

test('the same holds for the promoted-scan clock and the orphan-photo clock', async () => {
  let s = store(SWEEP_LIMIT + 1);
  expect(await runPromotedScanExpirySweep()).toEqual({ expired: SWEEP_LIMIT + 1 });
  expect(s.remaining()).toBe(0);

  s = store(SWEEP_LIMIT * 3);
  expect(await runUnattachedBottleImageSweep()).toEqual({ deleted: SWEEP_LIMIT * 3 });
  expect(s.remaining()).toBe(0);
  expect(s.state.batches).toBe(4); // three full batches, then an empty one
});

test('a run stops at its batch budget; the next run carries on', async () => {
  const s = store(SWEEP_LIMIT * (MAX_BATCHES_PER_RUN + 2));
  expect(await runUnattachedScanSweep()).toEqual({ deleted: SWEEP_LIMIT * MAX_BATCHES_PER_RUN });
  expect(s.state.batches).toBe(MAX_BATCHES_PER_RUN);
  expect(s.remaining()).toBe(SWEEP_LIMIT * 2);
  await runUnattachedScanSweep();
  expect(s.remaining()).toBe(0);
});

test('a batch that deletes nothing (rows changed under it) ends the run instead of spinning', async () => {
  const s = store(SWEEP_LIMIT * 3);
  s.state.refuseDeletes = true;
  expect(await runUnattachedScanSweep()).toEqual({ deleted: 0 });
  expect(s.state.batches).toBe(1);
});

test('the daily entry point drains all three clocks', async () => {
  store(SWEEP_LIMIT + 10); // the same store answers each clock in turn
  const r = await runScanImageRetentionSweep();
  expect(r).toEqual({ deleted: SWEEP_LIMIT + 10, expired: 0, orphanPhotos: 0 });
});
