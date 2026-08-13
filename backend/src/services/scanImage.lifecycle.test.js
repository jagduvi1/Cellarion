/**
 * Label-scan image lifecycle, end to end at the unit level:
 *
 *   persist   — the scanned frame becomes a PRIVATE kind:'label-scan'
 *               BottleImage, attached to nothing, with no background-removal
 *               job (a curator wants the untouched frame).
 *   stamp     — the commit binds it to the wine it produced, once, and only
 *               for its own uploader.
 *   export    — it ships in GET /api/users/me/export like every other image,
 *               labelled by kind (GDPR portability).
 *   erase     — account deletion removes the file AND nulls WineDefinition
 *               .scanImage, so no wine is left pointing at nothing.
 *   expire    — a scan that never reached a wine is swept after 30 days,
 *               FILES FIRST (a TTL index would orphan them on disk).
 */

jest.mock('../models/BottleImage', () => {
  const M = jest.fn(function (doc) {
    Object.assign(this, doc);
    this._id = 'img-new';
    this.save = jest.fn().mockResolvedValue(this);
  });
  M.find = jest.fn();
  M.findOne = jest.fn();
  M.findOneAndUpdate = jest.fn();
  M.deleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
  M.updateMany = jest.fn().mockResolvedValue({});
  M.countDocuments = jest.fn().mockResolvedValue(0);
  return M;
});
jest.mock('./imageProcessor', () => ({
  processImage: jest.fn(),
  hashImageBytes: jest.fn(() => 'sha-1'),
  unlinkImageFiles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./imageSanitizer', () => ({
  sanitizeImageBuffer: jest.fn(),
  detectImageFormat: jest.fn(() => 'jpeg'),
}));
jest.mock('fs', () => ({
  promises: { writeFile: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../config/upload', () => ({ ORIGINALS_DIR: '/app/uploads/originals' }));

const fs = require('fs');
const BottleImage = require('../models/BottleImage');
const { processImage, unlinkImageFiles } = require('./imageProcessor');
const { persistLabelScan } = require('./imageOps');
const { attachScanImage } = require('./wineCommit');
const { runScanImageRetentionSweep, runUnattachedScanSweep, SCAN_IMAGE_RETENTION_DAYS } = require('./scanImageRetentionJob');

const USER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439022';
const IMG = '507f1f77bcf86cd799439033';

beforeEach(() => jest.clearAllMocks());

describe('persistLabelScan', () => {
  test('stores a PRIVATE label-scan row attached to nothing, and starts no rembg job', async () => {
    const image = await persistLabelScan({ buffer: Buffer.from('bytes'), userId: USER });

    expect(fs.promises.writeFile).toHaveBeenCalled();
    const doc = BottleImage.mock.calls[0][0];
    expect(doc).toMatchObject({
      bottle: null,
      wineDefinition: null,      // bound at commit — this is also the expiry key
      uploadedBy: USER,
      status: 'uploaded',
      visibility: 'private',     // never public, never a gallery entry
      kind: 'label-scan',
    });
    expect(doc.originalUrl).toMatch(/^\/api\/uploads\/originals\/.+\.jpg$/);
    // Background removal is the SCAN flow's job on a copy; the stored frame
    // must stay untouched, so no processing is kicked off here.
    expect(processImage).not.toHaveBeenCalled();
    expect(image._id).toBe('img-new');
  });

  test('is best-effort — a disk failure returns null instead of failing the scan', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fs.promises.writeFile.mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(persistLabelScan({ buffer: Buffer.from('b'), userId: USER })).resolves.toBeNull();
    warn.mockRestore();
  });

  test('refuses an empty buffer', async () => {
    await expect(persistLabelScan({ buffer: Buffer.alloc(0), userId: USER })).resolves.toBeNull();
  });
});

describe('attachScanImage — the commit stamps the label onto the wine', () => {
  const wine = () => ({ _id: 'wine-1', scanImage: null, save: jest.fn().mockResolvedValue(undefined) });
  const req = { user: { id: USER } };

  test('claims the image atomically: uploader-scoped, label-scan only, not already bound — and a BORN-PROMOTED wine gets its retention clock in the SAME write', async () => {
    BottleImage.findOneAndUpdate.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: IMG }),
    });
    const w = wine(); // no pendingIdentity → born promoted

    await attachScanImage(w, { scanImageId: IMG }, req);

    // retainUntil rides the claim itself (release-audit LOW-1): a stamp that
    // ran afterwards could fail and leave an attached frame with no clock —
    // skipped by BOTH sweeps, kept forever.
    expect(BottleImage.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: IMG, uploadedBy: USER, kind: 'label-scan', wineDefinition: null },
      { $set: { wineDefinition: 'wine-1', updatedAt: expect.any(Date), retainUntil: expect.any(Date) } },
      { new: true },
    );
    expect(String(w.scanImage)).toBe(IMG);
    expect(w.save).toHaveBeenCalled();
  });

  test('a PENDING wine claims with NO clock — its window starts at promotion, as always', async () => {
    BottleImage.findOneAndUpdate.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: IMG }),
    });
    const w = { ...wine(), pendingIdentity: true, save: jest.fn().mockResolvedValue(undefined) };

    await attachScanImage(w, { scanImageId: IMG }, req);

    const [, update] = BottleImage.findOneAndUpdate.mock.calls[0];
    expect(update.$set).not.toHaveProperty('retainUntil');
  });

  test('another user\'s scan id is a no-op — the filter IS the authorization', async () => {
    BottleImage.findOneAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const w = wine();

    await attachScanImage(w, { scanImageId: IMG }, { user: { id: OTHER } });

    expect(w.scanImage).toBeNull();
    expect(w.save).not.toHaveBeenCalled();
  });

  test('a junk id never reaches the database', async () => {
    await attachScanImage(wine(), { scanImageId: 'not-an-id' }, req);
    expect(BottleImage.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('runScanImageRetentionSweep', () => {
  test('sweeps only UNATTACHED label scans older than the window, files before docs', async () => {
    const stale = [{ _id: 'i1', originalUrl: '/api/uploads/originals/a.jpg' }];
    BottleImage.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(stale) }),
      }),
    });
    BottleImage.deleteMany.mockResolvedValue({ deletedCount: 1 });

    // The unattached clock specifically — the entry point now runs a second,
    // disjoint one (the 7-day promoted-scan expiry, pinned in
    // services/promotedScanGrace.test.js).
    const res = await runUnattachedScanSweep();

    const filter = BottleImage.find.mock.calls[0][0];
    expect(filter.kind).toBe('label-scan');
    expect(filter.wineDefinition).toBeNull();
    expect(filter.bottle).toBeNull();
    const cutoff = filter.createdAt.$lt.getTime();
    const expected = Date.now() - SCAN_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);

    // Files first: the doc is the only reference to the file on disk.
    expect(unlinkImageFiles).toHaveBeenCalledWith(stale[0]);
    // The delete REPEATS the selection predicate (audit L-1): between the find
    // and the delete a second bottle of the same unidentified wine can attach
    // one of these scans, and deleting by id alone would drop a row a live
    // WineDefinition.scanImage points at.
    const del = BottleImage.deleteMany.mock.calls[0][0];
    expect(del._id).toEqual({ $in: ['i1'] });
    expect(del.kind).toBe('label-scan');
    expect(del.wineDefinition).toBeNull();
    expect(del.bottle).toBeNull();
    expect(del.createdAt.$lt).toBeInstanceOf(Date);
    expect(res.deleted).toBe(1);
  });

  test('nothing stale → no delete call at all', async () => {
    BottleImage.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      }),
    });

    // Two clocks now: the 30-day unattached sweep above and the 7-day
    // promoted-scan expiry (services/promotedScanGrace.test.js pins that one).
    expect(await runScanImageRetentionSweep()).toEqual({ deleted: 0, expired: 0 });
    expect(BottleImage.deleteMany).not.toHaveBeenCalled();
  });
});
