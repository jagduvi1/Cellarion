/**
 * The label scan's 7-day post-promotion GRACE WINDOW.
 *
 * Before this, a promoted wine's scan was the worst of both worlds: retained
 * forever on disk and reachable by nobody, because every gate asked "is the
 * wine still pending?". A completed identity can be WRONG — the
 * "Increíble"/"Increíble" row reached the maturity queue that way — and the
 * label was the only evidence that could have said so.
 *
 * Pinned here: the shared access predicate (served while pending, served on day
 * 3 after promotion, refused after that), the stamp that starts the clock, and
 * the sweep that deletes the expired scan — file, document AND the wine's
 * pointer — while never touching a scan whose wine is still in the queue.
 */
jest.mock('../models/BottleImage', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
}));
jest.mock('../models/WineDefinition', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Bottle', () => ({ distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./search', () => ({
  indexWine: jest.fn().mockResolvedValue(undefined),
  bulkIndexBottles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./wineProfileOps', () => ({
  resolveGrapeIdsStrict: jest.fn(),
  GRAPES_MAX: 20, GRAPE_NAME_MAX: 200,
  WINE_TYPES: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
}));

const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const { unlinkImageFiles } = require('./imageProcessor');
const {
  PROMOTED_SCAN_GRACE_DAYS, promotedScanDeadline, isWithinPromotedGrace, mayCurationReadScan,
} = require('./labelScanAccess');
const { runPromotedScanExpirySweep, runUnattachedScanSweep } = require('./scanImageRetentionJob');
const { runPromotionFollowThrough } = require('./pendingWineOps');

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n) => new Date(Date.now() + n * DAY);

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.updateOne.mockResolvedValue({ modifiedCount: 1 });
  BottleImage.updateMany.mockResolvedValue({ modifiedCount: 1 });
  WineDefinition.updateMany.mockResolvedValue({});
});

describe('the window itself', () => {
  test('it is 7 days, named once', () => {
    expect(PROMOTED_SCAN_GRACE_DAYS).toBe(7);
    const deadline = promotedScanDeadline(Date.parse('2026-08-12T00:00:00Z'));
    expect(deadline.toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });

  test('a still-PENDING wine\'s scan is served, deadline or not', () => {
    expect(mayCurationReadScan({ pendingIdentity: true }, { retainUntil: null })).toBe(true);
    expect(mayCurationReadScan({ pendingIdentity: true }, null)).toBe(true);
  });

  test('day 3 after promotion: served', () => {
    expect(mayCurationReadScan({ pendingIdentity: false }, { retainUntil: daysFromNow(4) })).toBe(true);
  });

  test('after the window: refused', () => {
    expect(mayCurationReadScan({ pendingIdentity: false }, { retainUntil: daysFromNow(-1) })).toBe(false);
  });

  test('a promoted wine whose scan was never stamped is refused — null is "no clock", not "forever"', () => {
    expect(isWithinPromotedGrace({ retainUntil: null })).toBe(false);
    expect(mayCurationReadScan({ pendingIdentity: false }, { retainUntil: null })).toBe(false);
  });

  test('a scan attached to NO wine is not curation evidence', () => {
    // Nobody's queue shows it; it stays its uploader's private image until the
    // 30-day unattached sweep takes it.
    expect(mayCurationReadScan(null, { retainUntil: daysFromNow(4) })).toBe(false);
  });
});

describe('the stamp — promotion starts the clock', () => {
  const promotedWine = (over = {}) => ({ _id: 'wine-1', slug: 'x', scanImage: 'scan-1', ...over });

  test('promotion stamps retainUntil on the label scan', async () => {
    await runPromotionFollowThrough(promotedWine());

    const [filter, update] = BottleImage.updateMany.mock.calls[0];
    expect(filter).toMatchObject({ _id: { $in: ['scan-1'] }, kind: 'label-scan', retainUntil: null });
    const until = update.$set.retainUntil.getTime();
    expect(Math.abs(until - (Date.now() + PROMOTED_SCAN_GRACE_DAYS * DAY))).toBeLessThan(5000);
  });

  test('it re-asserts kind — nothing but a label scan may be given a deadline by this path', async () => {
    await runPromotionFollowThrough(promotedWine());
    expect(BottleImage.updateMany.mock.calls[0][0].kind).toBe('label-scan');
  });

  test('an ALREADY-stamped scan is not re-stamped (the filter requires retainUntil: null)', async () => {
    // A second promotion-follow-through must not extend a window that is
    // already running.
    await runPromotionFollowThrough(promotedWine());
    expect(BottleImage.updateMany.mock.calls[0][0].retainUntil).toBeNull();
  });

  test('a wine with no scan stamps nothing', async () => {
    await runPromotionFollowThrough(promotedWine({ scanImage: null }));
    expect(BottleImage.updateMany).not.toHaveBeenCalled();
  });

  test('a stamp failure is non-fatal — the fix is already committed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    BottleImage.updateMany.mockRejectedValue(new Error('mongo down'));

    await expect(runPromotionFollowThrough(promotedWine())).resolves.toBeUndefined();
    warn.mockRestore();
  });

  /**
   * Audit M-4. "Every promoting caller runs the follow-through" was FALSE: the
   * admin PUT (routes/admin/wines.js) and POST /:id/strip-producer promote by
   * setting a producer and calling save(), and called nothing. The scan then
   * became unreadable (curation access is gated on pending-or-within-grace) AND
   * unsweepable (the expiry job excludes a null retainUntil) — kept forever,
   * readable by nobody, the exact state this window exists to end.
   *
   * So the stamp moved onto the TRANSITION itself and is shared by both.
   */
  describe('the stamp is on the transition, not on the caller', () => {
    const { stampPromotedScanRetention } = require('./labelScanAccess');

    test('one shared implementation, reachable without the curation queue', async () => {
      await stampPromotedScanRetention({ _id: 'w', scanImage: 'scan-9' });

      const [filter, update] = BottleImage.updateMany.mock.calls[0];
      expect(filter).toMatchObject({ _id: { $in: ['scan-9'] }, kind: 'label-scan', retainUntil: null });
      expect(update.$set.retainUntil).toBeInstanceOf(Date);
    });

    // Back-label rescue: the wine points at two frames and they are ONE piece
    // of evidence. A stamp reaching only the front would leave the back frame
    // unreadable AND unsweepable — the exact state the window exists to end.
    test('both frames are stamped when the wine carries a back scan too', async () => {
      await stampPromotedScanRetention({ _id: 'w', scanImage: 'scan-9', scanImageBack: 'scan-10' });

      const [filter] = BottleImage.updateMany.mock.calls[0];
      expect(filter._id.$in).toEqual(['scan-9', 'scan-10']);
    });

    test('a back scan alone is stamped', async () => {
      await stampPromotedScanRetention({ _id: 'w', scanImage: null, scanImageBack: 'scan-10' });
      expect(BottleImage.updateMany.mock.calls[0][0]._id.$in).toEqual(['scan-10']);
    });

    test('it is idempotent by filter — a second call cannot extend a live deadline', async () => {
      await stampPromotedScanRetention({ scanImage: 'scan-9' });
      await stampPromotedScanRetention({ scanImage: 'scan-9' });
      for (const [filter] of BottleImage.updateMany.mock.calls) {
        expect(filter.retainUntil).toBeNull();
      }
    });

    test('no scan, no write', async () => {
      await stampPromotedScanRetention({ scanImage: null });
      await stampPromotedScanRetention(null);
      expect(BottleImage.updateMany).not.toHaveBeenCalled();
    });

    test('it swallows its own failure — a promotion must not roll back over a stamp', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      BottleImage.updateMany.mockRejectedValue(new Error('mongo down'));
      await expect(stampPromotedScanRetention({ scanImage: 'scan-9' })).resolves.toBeUndefined();
      warn.mockRestore();
    });
  });
});

describe('the sweep — an expired scan is deleted, file, doc and pointer', () => {
  const primeExpired = (rows, survivors = []) => {
    let call = 0;
    BottleImage.find.mockImplementation(() => {
      const isFirst = call === 0;
      call += 1;
      const chain = {
        select: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        lean: jest.fn().mockResolvedValue(isFirst ? rows : survivors),
      };
      return chain;
    });
  };

  test('selects only label scans whose deadline has passed', async () => {
    primeExpired([{ _id: 'i1', originalUrl: '/api/uploads/originals/a.jpg' }]);
    BottleImage.deleteMany.mockResolvedValue({ deletedCount: 1 });

    const res = await runPromotedScanExpirySweep();

    const filter = BottleImage.find.mock.calls[0][0];
    expect(filter.kind).toBe('label-scan');
    expect(filter.retainUntil.$type).toBe('date');
    expect(filter.retainUntil.$lt).toBeInstanceOf(Date);
    expect(res.expired).toBe(1);
  });

  test('files first, then the doc — the doc is the only reference to the file', async () => {
    const row = { _id: 'i1', originalUrl: '/api/uploads/originals/a.jpg' };
    primeExpired([row]);
    BottleImage.deleteMany.mockResolvedValue({ deletedCount: 1 });

    await runPromotedScanExpirySweep();

    expect(unlinkImageFiles).toHaveBeenCalledWith(row);
    // TOCTOU-safe: the delete REPEATS the selection predicate, so a row whose
    // deadline was cleared in between is skipped rather than dropped.
    const del = BottleImage.deleteMany.mock.calls[0][0];
    expect(del._id).toEqual({ $in: ['i1'] });
    expect(del.kind).toBe('label-scan');
    expect(del.retainUntil.$type).toBe('date');
  });

  test('the wine\'s scanImage pointer is nulled for the rows that actually went', async () => {
    primeExpired([{ _id: 'i1' }, { _id: 'i2' }], [{ _id: 'i2' }]); // i2 survived the delete
    BottleImage.deleteMany.mockResolvedValue({ deletedCount: 1 });

    await runPromotedScanExpirySweep();

    expect(WineDefinition.updateMany).toHaveBeenCalledWith(
      { scanImage: { $in: ['i1'] } },
      { $set: { scanImage: null, scanFieldConflicts: [] } }
    );
    // The back-label pointer is nulled by its OWN matched update, so a wine
    // whose front scan expired keeps a back scan that did not.
    expect(WineDefinition.updateMany).toHaveBeenCalledWith(
      { scanImageBack: { $in: ['i1'] } },
      { $set: { scanImageBack: null, scanFieldConflicts: [] } }
    );
  });

  test('nothing expired → no delete, no pointer write', async () => {
    primeExpired([]);

    expect(await runPromotedScanExpirySweep()).toEqual({ expired: 0 });
    expect(BottleImage.deleteMany).not.toHaveBeenCalled();
    expect(WineDefinition.updateMany).not.toHaveBeenCalled();
  });

  test('a STILL-PENDING wine\'s scan can never be selected — it carries no deadline', async () => {
    primeExpired([]);
    await runPromotedScanExpirySweep();
    // The filter demands a real DATE retainUntil, and only promotion writes one.
    // ($type: 'date' rather than $ne: null — identical semantics, but it matches
    // the index's partialFilterExpression so the planner can use it; audit L-10.)
    expect(BottleImage.find.mock.calls[0][0].retainUntil.$type).toBe('date');
  });

  test('the 30-day UNATTACHED sweep is unchanged and still ignores retainUntil', async () => {
    primeExpired([]);
    await runUnattachedScanSweep();

    const filter = BottleImage.find.mock.calls[0][0];
    expect(filter).toMatchObject({ kind: 'label-scan', wineDefinition: null, bottle: null });
    expect(filter.retainUntil).toBeUndefined();
  });
});
