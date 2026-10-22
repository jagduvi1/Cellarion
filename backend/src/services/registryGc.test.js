/**
 * Undo GC of a minted registry wine (the launch-day orphan report): every
 * guard must hold the wine in place, and the happy path must clean up the
 * profile stubs, images, embeddings, search doc and the wine itself.
 */

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), deleteOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/WineVintageProfile', () => ({ countDocuments: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Bottle', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/DeletedBottle', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ countDocuments: jest.fn(), find: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/WineEmbedding', () => ({ find: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./search', () => ({ removeWine: jest.fn() }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const Bottle = require('../models/Bottle');
const DeletedBottle = require('../models/DeletedBottle');
const BottleImage = require('../models/BottleImage');
const WineEmbedding = require('../models/WineEmbedding');
const searchService = require('./search');
const { logAudit } = require('./audit');
const { gcOrphanMintedWine } = require('./registryGc');

const WINE_ID = 'a'.repeat(24);
const REQ = { user: { id: 'u1' }, headers: {} };

const selectable = (doc) => ({ select: jest.fn().mockReturnValue(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.findById.mockReturnValue(selectable({ _id: WINE_ID, name: 'Barolo', producer: 'Cantina Bartolo Mascarello' }));
  Bottle.countDocuments.mockResolvedValue(0);
  DeletedBottle.countDocuments.mockResolvedValue(0);
  BottleImage.countDocuments.mockResolvedValue(0);
  BottleImage.find.mockResolvedValue([]);
  WineVintageProfile.countDocuments.mockResolvedValue(0);
  WineEmbedding.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
});

describe('gcOrphanMintedWine guards', () => {
  test('invalid id / already-gone wine → not removed, nothing touched', async () => {
    expect((await gcOrphanMintedWine('nope', REQ)).removed).toBe(false);
    WineDefinition.findById.mockReturnValue(selectable(null));
    expect((await gcOrphanMintedWine(WINE_ID, REQ)).removed).toBe(false);
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });

  test('ANY bottle referencing the wine (any user, any status) keeps it', async () => {
    Bottle.countDocuments.mockResolvedValue(1);
    const res = await gcOrphanMintedWine(WINE_ID, REQ);
    expect(res.removed).toBe(false);
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
    expect(WineVintageProfile.deleteMany).not.toHaveBeenCalled();
  });

  test("a bottle in someone's Recently deleted keeps it (a restore needs the wine)", async () => {
    DeletedBottle.countDocuments.mockResolvedValue(2);
    const res = await gcOrphanMintedWine(WINE_ID, REQ);
    expect(res.removed).toBe(false);
    expect(res.reason).toMatch(/recently deleted/);
    expect(DeletedBottle.countDocuments).toHaveBeenCalledWith({ wineDefinition: WINE_ID });
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });

  test('an admin-approved official wine image keeps it', async () => {
    BottleImage.countDocuments.mockResolvedValue(1);
    expect((await gcOrphanMintedWine(WINE_ID, REQ)).removed).toBe(false);
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });

  describe('photos: the shared registry-photo rule decides (services/photoRetention)', () => {
    // countDocuments evaluates the guard's real query against these rows, so
    // the test pins what the query MEANS, not how it is spelled. Covers the
    // operators the rule uses: equality, $ne, $or, $nor.
    const matches = (doc, q) => Object.entries(q).every(([k, v]) => {
      if (k === '$or') return v.some((sub) => matches(doc, sub));
      if (k === '$nor') return !v.some((sub) => matches(doc, sub));
      if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne;
      return doc[k] === v;
    });
    const photo = (over) => ({ wineDefinition: WINE_ID, kind: 'bottle', status: 'pending', visibility: 'private', assignedToWine: false, ...over });
    const withPhotos = (rows) => {
      BottleImage.countDocuments.mockImplementation(async (q) => rows.filter((r) => matches(r, q)).length);
      BottleImage.find.mockResolvedValue(rows);
    };

    test('an approved public photo that is not the wine\'s picture keeps the wine, and no photo is touched', async () => {
      withPhotos([photo({ status: 'approved', visibility: 'public' })]);
      const res = await gcOrphanMintedWine(WINE_ID, REQ);
      expect(res).toEqual({ removed: false, reason: 'has a published photo' });
      const { unlinkImageFiles } = require('./imageProcessor');
      expect(unlinkImageFiles).not.toHaveBeenCalled();
      expect(BottleImage.deleteMany).not.toHaveBeenCalled();
      expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
    });

    test('the wine\'s chosen picture keeps it too', async () => {
      withPhotos([photo({ assignedToWine: true })]);
      expect((await gcOrphanMintedWine(WINE_ID, REQ)).removed).toBe(false);
      expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
    });

    test('the uploader\'s own photos (pending, private, a label scan) go with the minted wine', async () => {
      withPhotos([
        photo({}),
        photo({ status: 'approved', visibility: 'private' }),
        photo({ kind: 'label-scan', status: 'approved', visibility: 'public' }),
      ]);
      const res = await gcOrphanMintedWine(WINE_ID, REQ);
      expect(res.removed).toBe(true);
      expect(require('./imageProcessor').unlinkImageFiles).toHaveBeenCalledTimes(3);
      expect(BottleImage.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID });
    });
  });

  test('a somm-reviewed maturity profile keeps it', async () => {
    WineVintageProfile.countDocuments.mockResolvedValue(1);
    expect((await gcOrphanMintedWine(WINE_ID, REQ)).removed).toBe(false);
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });

  test('an admin-verified data-quality check keeps it (user undo must not delete curated data)', async () => {
    WineDefinition.findById.mockReturnValue(selectable({
      _id: WINE_ID, name: 'Opus One', producer: 'Opus One',
      verifiedChecks: ['name-equals-producer.v1'],
    }));
    const res = await gcOrphanMintedWine(WINE_ID, REQ);
    expect(res.removed).toBe(false);
    expect(res.reason).toContain('verified');
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });

  test('the findById projection includes verifiedChecks (or the guard would always pass)', async () => {
    await gcOrphanMintedWine(WINE_ID, REQ);
    const selectMock = WineDefinition.findById.mock.results[0].value.select;
    expect(selectMock.mock.calls[0][0]).toContain('verifiedChecks');
  });
});

describe('gcOrphanMintedWine happy path', () => {
  test('removes pending profiles, embeddings (the rows hold the vectors), search doc, wine — and audits', async () => {
    const res = await gcOrphanMintedWine(WINE_ID, REQ);
    expect(res.removed).toBe(true);
    expect(WineVintageProfile.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID, status: 'pending' });
    expect(WineEmbedding.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID });
    expect(searchService.removeWine).toHaveBeenCalledWith(WINE_ID);
    expect(WineDefinition.deleteOne).toHaveBeenCalledWith({ _id: WINE_ID });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'wine.undo_create',
      { type: 'wine', id: WINE_ID },
      { name: 'Barolo', producer: 'Cantina Bartolo Mascarello', via: 'undo' });
  });

  test('a failed embedding cleanup does not stop the rest (best-effort vectors)', async () => {
    WineEmbedding.deleteMany.mockRejectedValueOnce(new Error('embeddings hiccup'));
    const res = await gcOrphanMintedWine(WINE_ID, REQ);
    expect(res.removed).toBe(true);
    expect(WineDefinition.deleteOne).toHaveBeenCalled();
  });

  test('never throws — an unexpected model error reports removed:false', async () => {
    Bottle.countDocuments.mockRejectedValue(new Error('mongo hiccup'));
    const res = await gcOrphanMintedWine(WINE_ID, REQ);
    expect(res.removed).toBe(false);
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });
});
