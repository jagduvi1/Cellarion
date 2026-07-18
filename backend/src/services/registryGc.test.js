/**
 * Undo GC of a minted registry wine (the launch-day orphan report): every
 * guard must hold the wine in place, and the happy path must clean up the
 * profile stubs, images, embeddings, search doc and the wine itself.
 */

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), deleteOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/WineVintageProfile', () => ({ countDocuments: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Bottle', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ countDocuments: jest.fn(), find: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/WineEmbedding', () => ({ find: jest.fn(), deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./vectorStore', () => ({ deletePoints: jest.fn().mockResolvedValue({}) }));
jest.mock('./search', () => ({ removeWine: jest.fn() }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const WineEmbedding = require('../models/WineEmbedding');
const vectorStore = require('./vectorStore');
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

  test('an admin-approved official wine image keeps it', async () => {
    BottleImage.countDocuments.mockResolvedValue(1);
    expect((await gcOrphanMintedWine(WINE_ID, REQ)).removed).toBe(false);
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });

  test('a somm-reviewed maturity profile keeps it', async () => {
    WineVintageProfile.countDocuments.mockResolvedValue(1);
    expect((await gcOrphanMintedWine(WINE_ID, REQ)).removed).toBe(false);
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });
});

describe('gcOrphanMintedWine happy path', () => {
  test('removes pending profiles, embeddings + Qdrant points, search doc, wine — and audits', async () => {
    WineEmbedding.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
      { qdrantPointId: 'p1', indexVersion: 'v1' },
      { qdrantPointId: 'p2', indexVersion: 'v1' },
    ]) }) });

    const res = await gcOrphanMintedWine(WINE_ID, REQ);
    expect(res.removed).toBe(true);
    expect(WineVintageProfile.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID, status: 'pending' });
    expect(vectorStore.deletePoints).toHaveBeenCalledWith('v1', ['p1', 'p2']);
    expect(WineEmbedding.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID });
    expect(searchService.removeWine).toHaveBeenCalledWith(WINE_ID);
    expect(WineDefinition.deleteOne).toHaveBeenCalledWith({ _id: WINE_ID });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'wine.undo_create',
      { type: 'wine', id: WINE_ID },
      { name: 'Barolo', producer: 'Cantina Bartolo Mascarello', via: 'undo' });
  });

  test('a Qdrant outage does not stop the Mongo cleanup (best-effort vectors)', async () => {
    WineEmbedding.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
      { qdrantPointId: 'p1', indexVersion: 'v1' },
    ]) }) });
    vectorStore.deletePoints.mockRejectedValue(new Error('qdrant down'));
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
