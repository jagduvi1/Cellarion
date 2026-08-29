/**
 * Guards the permanent-cellar-deletion cascade invariants:
 *  - bottle ids are collected BEFORE Bottle.deleteMany so the Meilisearch
 *    cleanup receives them (there is no scheduled resync);
 *  - registry-assigned images (assignedToWine) are detached, never unlinked;
 *  - user-owned image files are unlinked before their docs are deleted.
 */
jest.mock('../models/Bottle', () => ({
  find: jest.fn(),
  deleteMany: jest.fn(),
  distinct: jest.fn(),
}));
jest.mock('../models/BottleImage', () => ({
  find: jest.fn(),
  deleteMany: jest.fn(),
  updateMany: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ deleteMany: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ deleteMany: jest.fn() }));
jest.mock('../models/CellarValueSnapshot', () => ({ deleteMany: jest.fn() }));
jest.mock('../models/ImportSession', () => ({ deleteMany: jest.fn() }));
jest.mock('../models/PendingShare', () => ({ deleteMany: jest.fn() }));
jest.mock('../models/WineList', () => ({ deleteMany: jest.fn() }));
jest.mock('../models/ClimateDevice', () => ({ updateMany: jest.fn() }));
jest.mock('../models/Cellar', () => ({ deleteOne: jest.fn() }));
jest.mock('../models/WineRequest', () => ({ deleteMany: jest.fn() }));
jest.mock('./wineListLogos', () => ({ deleteLogoFilesFor: jest.fn() }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('./search', () => ({ removeBottles: jest.fn() }));

const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Rack = require('../models/Rack');
const CellarLayout = require('../models/CellarLayout');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const ImportSession = require('../models/ImportSession');
const PendingShare = require('../models/PendingShare');
const WineList = require('../models/WineList');
const ClimateDevice = require('../models/ClimateDevice');
const Cellar = require('../models/Cellar');
const WineRequest = require('../models/WineRequest');
const { deleteLogoFilesFor } = require('./wineListLogos');
const { unlinkImageFiles } = require('./imageProcessor');
const searchService = require('./search');
const { purgeCellarPermanently } = require('./cellarPurge');

const CELLAR_ID = '64c000000000000000000001';
const BOTTLE_IDS = ['b1', 'b2', 'b3'];

const OWN_IMAGES = [
  { originalUrl: '/uploads/a.jpg', processedUrl: '/uploads/a.png' },
  { originalUrl: '/uploads/b.jpg', processedUrl: '/uploads/b.png' },
];

function setupMocks({ bottleIds = BOTTLE_IDS, ownImages = OWN_IMAGES } = {}) {
  Bottle.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue(bottleIds) });
  Bottle.distinct.mockResolvedValue([]);
  WineRequest.deleteMany.mockResolvedValue({ deletedCount: 0 });
  BottleImage.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(ownImages) }),
  });
  BottleImage.deleteMany.mockResolvedValue({ deletedCount: ownImages.length });
  BottleImage.updateMany.mockResolvedValue({ modifiedCount: 1 });
  Rack.deleteMany.mockResolvedValue({ deletedCount: 2 });
  Bottle.deleteMany.mockResolvedValue({ deletedCount: bottleIds.length });
  CellarLayout.deleteMany.mockResolvedValue({ deletedCount: 1 });
  CellarValueSnapshot.deleteMany.mockResolvedValue({ deletedCount: 5 });
  ImportSession.deleteMany.mockResolvedValue({ deletedCount: 1 });
  PendingShare.deleteMany.mockResolvedValue({ deletedCount: 1 });
  WineList.deleteMany.mockResolvedValue({ deletedCount: 1 });
  deleteLogoFilesFor.mockResolvedValue();
  unlinkImageFiles.mockResolvedValue();
  searchService.removeBottles.mockResolvedValue();
  Cellar.deleteOne.mockResolvedValue({ deletedCount: 1 });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupMocks();
});

describe('purgeCellarPermanently', () => {
  test('deletes every cellar-scoped collection with the cellar filter', async () => {
    await purgeCellarPermanently(CELLAR_ID);

    const cellarFilter = { cellar: CELLAR_ID };
    expect(Rack.deleteMany).toHaveBeenCalledWith(cellarFilter);
    expect(Bottle.deleteMany).toHaveBeenCalledWith(cellarFilter);
    expect(CellarLayout.deleteMany).toHaveBeenCalledWith(cellarFilter);
    expect(CellarValueSnapshot.deleteMany).toHaveBeenCalledWith(cellarFilter);
    expect(ImportSession.deleteMany).toHaveBeenCalledWith(cellarFilter);
    expect(PendingShare.deleteMany).toHaveBeenCalledWith(cellarFilter);
    expect(WineList.deleteMany).toHaveBeenCalledWith(cellarFilter);
    // Climate devices belong to the user, not the cellar → detached, not deleted (M12).
    expect(ClimateDevice.updateMany).toHaveBeenCalledWith(cellarFilter, { $set: { cellar: null } });
    expect(Cellar.deleteOne).toHaveBeenCalledWith({ _id: CELLAR_ID });
  });

  test('collects bottle ids BEFORE Bottle.deleteMany and passes them to the search cleanup', async () => {
    await purgeCellarPermanently(CELLAR_ID);

    // Ordering invariant: the id collection query must run before deleteMany,
    // otherwise the search cleanup would receive an empty list and leave
    // ghost bottles in Meilisearch forever.
    expect(Bottle.find).toHaveBeenCalledWith({ cellar: CELLAR_ID });
    const findOrder = Bottle.find.mock.invocationCallOrder[0];
    const deleteOrder = Bottle.deleteMany.mock.invocationCallOrder[0];
    expect(findOrder).toBeLessThan(deleteOrder);

    expect(searchService.removeBottles).toHaveBeenCalledWith(BOTTLE_IDS);
  });

  test('unlinks image files for user-owned images only', async () => {
    await purgeCellarPermanently(CELLAR_ID);

    // Only non-registry images are loaded for unlinking
    expect(BottleImage.find).toHaveBeenCalledWith({
      bottle: { $in: BOTTLE_IDS },
      assignedToWine: { $ne: true },
    });
    expect(unlinkImageFiles).toHaveBeenCalledTimes(OWN_IMAGES.length);
    expect(unlinkImageFiles).toHaveBeenCalledWith(OWN_IMAGES[0]);
    expect(unlinkImageFiles).toHaveBeenCalledWith(OWN_IMAGES[1]);
  });

  test('registry-assigned images are detached (bottle ref unset), not deleted or unlinked', async () => {
    await purgeCellarPermanently(CELLAR_ID);

    // Docs deleted: only the user-owned ones
    expect(BottleImage.deleteMany).toHaveBeenCalledWith({
      bottle: { $in: BOTTLE_IDS },
      assignedToWine: { $ne: true },
    });
    // Registry images survive with their dead bottle ref detached
    expect(BottleImage.updateMany).toHaveBeenCalledWith(
      { bottle: { $in: BOTTLE_IDS }, assignedToWine: true },
      { $unset: { bottle: '' } }
    );
  });

  test('files are unlinked BEFORE the BottleImage docs are deleted', async () => {
    await purgeCellarPermanently(CELLAR_ID);

    const unlinkOrder = Math.max(...unlinkImageFiles.mock.invocationCallOrder);
    const deleteOrder = BottleImage.deleteMany.mock.invocationCallOrder[0];
    expect(unlinkOrder).toBeLessThan(deleteOrder);
  });

  test('deletes wine-list logo files scoped to the cellar', async () => {
    await purgeCellarPermanently(CELLAR_ID);
    expect(deleteLogoFilesFor).toHaveBeenCalledWith(WineList, { cellar: CELLAR_ID });
  });

  test('returns the deletion counts', async () => {
    const result = await purgeCellarPermanently(CELLAR_ID);
    expect(result).toEqual({
      racksDeleted: 2,
      bottlesDeleted: BOTTLE_IDS.length,
      imagesDeleted: OWN_IMAGES.length,
    });
  });

  test('empty cellar: skips image handling entirely, still cleans search and deletes the cellar doc', async () => {
    setupMocks({ bottleIds: [], ownImages: [] });

    const result = await purgeCellarPermanently(CELLAR_ID);

    expect(BottleImage.find).not.toHaveBeenCalled();
    expect(BottleImage.deleteMany).not.toHaveBeenCalled();
    expect(BottleImage.updateMany).not.toHaveBeenCalled();
    expect(unlinkImageFiles).not.toHaveBeenCalled();
    expect(searchService.removeBottles).toHaveBeenCalledWith([]);
    expect(Cellar.deleteOne).toHaveBeenCalledWith({ _id: CELLAR_ID });
    expect(result).toEqual({ racksDeleted: 2, bottlesDeleted: 0, imagesDeleted: 0 });
  });

  // ── Wine-request cascade (fix/import-empty-winename) ─────────────────────
  // A request whose every referencing bottle is being purged can never be
  // resolved into anything — it goes with the bottles. Requests also feeding
  // another cellar's bottles stay; resolved/rejected are history and stay.

  test('deletes pending/withdrawn requests referenced only by this cellar', async () => {
    Bottle.distinct.mockImplementation(async (field, filter) =>
      (filter && filter.cellar === CELLAR_ID) ? ['r1', 'r2', 'r3'] : ['r2']);

    await purgeCellarPermanently(CELLAR_ID);

    expect(WineRequest.deleteMany).toHaveBeenCalledWith({
      _id: { $in: ['r1', 'r3'] },                 // r2 is referenced elsewhere
      status: { $in: ['pending', 'withdrawn'] },  // resolved/rejected = history
    });
  });

  test('no request refs → the request collection is never touched', async () => {
    Bottle.distinct.mockResolvedValue([]);
    await purgeCellarPermanently(CELLAR_ID);
    expect(WineRequest.deleteMany).not.toHaveBeenCalled();
  });
});
