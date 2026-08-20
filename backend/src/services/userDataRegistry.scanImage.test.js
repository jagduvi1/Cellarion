/**
 * GDPR contract for label-scan images.
 *
 * They are ordinary BottleImages in the same collection (no new consent
 * category — see the scanImage field note on models/WineDefinition.js), so the
 * existing BottleImage registry entry already covers them. What this suite
 * pins is the two things that are NOT automatic:
 *
 *   portability — the export labels images by `kind`, so a user can tell the
 *   label frames the scanner kept from the photos they chose to upload.
 *
 *   erasure — deleting the images must ALSO clear WineDefinition.scanImage.
 *   Without that, a curated (or still-pending) wine is left pointing at a row
 *   that no longer exists, and the pending queue 404s on it forever.
 */
jest.mock('./search', () => ({ removeBottles: jest.fn(), indexDiscussion: jest.fn() }));
jest.mock('../models/BottleImage', () => ({
  find: jest.fn(),
  deleteMany: jest.fn().mockResolvedValue({}),
  updateMany: jest.fn().mockResolvedValue({}),
}));
jest.mock('../models/WineDefinition', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn().mockResolvedValue(undefined) }));

const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const { unlinkImageFiles } = require('./imageProcessor');
const { REGISTRY } = require('./userDataRegistry');

const USER = 'user-1';
const DELETED = 'deleted-sentinel';

const entry = REGISTRY.find((e) => e.model && e.model.modelName === 'BottleImage')
  // The mocked model has no modelName — match on the presence of the images
  // export fragment instead when running against the mock.
  || REGISTRY.find((e) => e.model === BottleImage);

const leanFind = (rows) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }) });

beforeEach(() => jest.clearAllMocks());

// The export now runs TWO queries — the user's own images, then the reports
// they filed on other people's. Both arrive through BottleImage.find, so the
// mock answers in call order.
const exportQueries = (imageRows, reportRows = []) => {
  BottleImage.find
    .mockReturnValueOnce({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(imageRows) }) })
    .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(reportRows) }) }) });
};

test('the export labels every image with its kind (bottle vs label-scan)', async () => {
  exportQueries([
    { originalUrl: '/api/uploads/originals/a.jpg', processedUrl: null, createdAt: new Date(0), kind: 'label-scan' },
    { originalUrl: '/api/uploads/originals/b.jpg', processedUrl: '/api/uploads/processed/b.png', createdAt: new Date(0) },
  ]);

  const frag = await entry.exportFragment({ userId: USER, truncated: {} });

  expect(frag.images).toEqual([
    { originalUrl: '/api/uploads/originals/a.jpg', processedUrl: null, uploadedAt: new Date(0), kind: 'label-scan', side: 'front' },
    // Rows predating the field default to 'bottle' — no backfill needed.
    { originalUrl: '/api/uploads/originals/b.jpg', processedUrl: '/api/uploads/processed/b.png', uploadedAt: new Date(0), kind: 'bottle', side: 'front' },
  ]);
});

// Ticket 6a865f60: a report is the user's own words about someone else's photo,
// so portability covers it — but the photo is not theirs and must not ride
// along. The image is named by id only.
test('the export includes reports the user filed, WITHOUT the reported photo', async () => {
  exportQueries([], [
    { _id: 'img-1', reports: [
      { user: USER, reason: 'private-info', detail: 'my kitchen', createdAt: new Date(0) },
      { user: 'someone-else', reason: 'offensive', detail: 'not mine', createdAt: new Date(0) },
    ] },
  ]);

  const frag = await entry.exportFragment({ userId: USER, truncated: {} });

  expect(frag.imageReports).toEqual([
    { imageId: 'img-1', reason: 'private-info', detail: 'my kitchen', reportedAt: new Date(0) },
  ]);
  // Another reporter's words are not this user's data.
  expect(JSON.stringify(frag.imageReports)).not.toMatch(/not mine/);
  // Nor is the photo they reported.
  expect(JSON.stringify(frag.imageReports)).not.toMatch(/originalUrl/);
});

test('erasure withdraws the reports the user filed, leaving other reporters alone', async () => {
  BottleImage.find.mockReturnValue(leanFind([]));
  await entry.purge({ userId: USER, deletedUserId: DELETED });
  expect(BottleImage.updateMany).toHaveBeenCalledWith(
    { 'reports.user': USER },
    { $pull: { reports: { user: USER } } }
  );
});

test('erasure unlinks the files, deletes the docs, and NULLS every wine pointing at them', async () => {
  const own = [{ _id: 'i1', originalUrl: '/api/uploads/originals/a.jpg' }];
  BottleImage.find.mockReturnValue(leanFind(own));

  await entry.purge({ userId: USER, deletedUserId: DELETED });

  expect(unlinkImageFiles).toHaveBeenCalledWith(own[0]);
  expect(BottleImage.deleteMany).toHaveBeenCalledWith({ uploadedBy: USER, assignedToWine: { $ne: true } });
  // The dangling-pointer fix: keyed on the DELETED IDS, not the user, because a
  // wine created by someone else can legitimately carry this user's scan.
  // scanFieldConflicts goes with the pointer (release-audit L-4): the
  // front/back disagreement record is a statement about those photos and must
  // not outlive them — same rule the retention sweep applies.
  expect(WineDefinition.updateMany).toHaveBeenCalledWith(
    { scanImage: { $in: ['i1'] } },
    { $set: { scanImage: null, scanFieldConflicts: [] } },
  );
  expect(WineDefinition.updateMany).toHaveBeenCalledWith(
    { scanImageBack: { $in: ['i1'] } },
    { $set: { scanImageBack: null, scanFieldConflicts: [] } },
  );
});

/**
 * 2026-08-13: a scan-originated wine that mints looking COMPLETE now keeps its
 * frame too (services/wineCommit, L-5 revisited). That is a new POPULATION of
 * label-scan rows, not a new data category — so the GDPR contract must already
 * cover it, and this pins that it does: both sides key on the UPLOADER, never
 * on the wine's pending state, so a frame attached to a published wine is
 * exported and erased exactly like one attached to a queued wine.
 */
test('export and erasure never consult the wine — they key on the uploader', async () => {
  const own = [{ _id: 'born-1', originalUrl: '/api/uploads/originals/born.jpg' }];
  BottleImage.find.mockReturnValue(leanFind(own));

  await entry.purge({ userId: USER, deletedUserId: DELETED });

  // The selection carries no pendingIdentity / retainUntil term of any kind.
  const selection = BottleImage.find.mock.calls[0][0];
  expect(selection).toEqual({ uploadedBy: USER, assignedToWine: { $ne: true } });
  expect(BottleImage.deleteMany.mock.calls[0][0]).toEqual({ uploadedBy: USER, assignedToWine: { $ne: true } });
  // …and the published wine's pointer is nulled like any other.
  expect(WineDefinition.updateMany).toHaveBeenCalledWith(
    { scanImage: { $in: ['born-1'] } },
    { $set: { scanImage: null, scanFieldConflicts: [] } },
  );
});

test('with nothing to delete, no pointer update is issued', async () => {
  BottleImage.find.mockReturnValue(leanFind([]));

  await entry.purge({ userId: USER, deletedUserId: DELETED });

  expect(WineDefinition.updateMany).not.toHaveBeenCalled();
});
