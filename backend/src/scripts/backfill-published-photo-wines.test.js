/**
 * scripts/backfill-published-photo-wines — links published bottle photos to
 * their bottle's wine, and (optionally) gives wines without a picture their
 * oldest published photo. Models mocked; the script's logic is what is tested.
 */
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));

const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { linkPublishedPhotos, assignMissingImages } = require('./backfill-published-photo-wines');

const oid = (c) => c.repeat(24);
const lean = (rows) => ({ lean: () => Promise.resolve(rows) });

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.updateOne.mockResolvedValue({});
  BottleImage.updateMany.mockResolvedValue({});
  WineDefinition.updateOne.mockResolvedValue({});
});

describe('linkPublishedPhotos', () => {
  const photos = [
    { _id: oid('1'), bottle: oid('b') }, // bottle b → wine a
    { _id: oid('2'), bottle: oid('c') }, // bottle c has no wine yet (pending request)
    { _id: oid('3'), bottle: oid('d') }, // bottle d is gone
  ];
  const bottles = [
    { _id: oid('b'), wineDefinition: oid('a') },
    { _id: oid('c'), wineDefinition: null },
  ];

  test('a dry run counts the three cases and writes nothing', async () => {
    BottleImage.find.mockReturnValue(lean(photos));
    Bottle.find.mockReturnValue(lean(bottles));

    const r = await linkPublishedPhotos({ apply: false });

    expect(r).toEqual({ candidates: 3, linked: 1, bottleGone: 1, bottleWithoutWine: 1 });
    expect(BottleImage.updateOne).not.toHaveBeenCalled();
    // Only published bottle photos that carry no wine are candidates — never a label scan.
    expect(BottleImage.find.mock.calls[0][0]).toEqual({
      kind: { $ne: 'label-scan' }, status: 'approved', visibility: 'public', wineDefinition: null, bottle: { $ne: null },
    });
  });

  test('--apply links each photo to its bottle\'s wine, only while it still has none', async () => {
    BottleImage.find.mockReturnValue(lean(photos));
    Bottle.find.mockReturnValue(lean(bottles));

    const r = await linkPublishedPhotos({ apply: true });

    expect(r.linked).toBe(1);
    expect(BottleImage.updateOne).toHaveBeenCalledTimes(1);
    expect(BottleImage.updateOne).toHaveBeenCalledWith(
      { _id: oid('1'), wineDefinition: null },
      { $set: { wineDefinition: oid('a') } }
    );
  });

  test('nothing to do is nothing to do', async () => {
    BottleImage.find.mockReturnValue(lean([]));

    const r = await linkPublishedPhotos({ apply: true });

    expect(r).toEqual({ candidates: 0, linked: 0, bottleGone: 0, bottleWithoutWine: 0 });
    expect(Bottle.find).not.toHaveBeenCalled();
  });
});

describe('assignMissingImages', () => {
  const published = [
    { _id: oid('1'), wineDefinition: oid('a'), processedUrl: '/api/uploads/processed/new.webp', credit: null, createdAt: '2026-09-02T00:00:00Z' },
    { _id: oid('2'), wineDefinition: oid('a'), processedUrl: '/api/uploads/processed/old.webp', credit: 'Ann', createdAt: '2026-09-01T00:00:00Z' },
    { _id: oid('3'), wineDefinition: oid('e'), processedUrl: '/api/uploads/processed/x.webp', credit: null, createdAt: '2026-09-03T00:00:00Z' },
  ];

  test('a wine with no picture gets its OLDEST published photo; a wine with one is left alone', async () => {
    BottleImage.find.mockReturnValue(lean(published));
    WineDefinition.find.mockReturnValue(lean([{ _id: oid('a') }])); // wine e already has a picture
    const indexWine = jest.fn().mockResolvedValue(undefined);

    const r = await assignMissingImages({ apply: true, indexWine });

    expect(r).toEqual({ winesWithPublishedPhotos: 2, winesWithoutImage: 1, assigned: 1 });
    expect(BottleImage.updateMany).toHaveBeenCalledWith(
      { wineDefinition: oid('a'), assignedToWine: true }, { $set: { assignedToWine: false } }
    );
    expect(BottleImage.updateOne).toHaveBeenCalledWith({ _id: oid('2') }, { $set: { assignedToWine: true } });
    expect(WineDefinition.updateOne).toHaveBeenCalledWith(
      { _id: oid('a') }, { $set: { image: '/api/uploads/processed/old.webp', imageCredit: 'Ann' } }
    );
    expect(indexWine).toHaveBeenCalledWith(oid('a'));
    // Only wines that have published photos are even looked at.
    expect(WineDefinition.find.mock.calls[0][0]._id).toEqual({ $in: [oid('a'), oid('e')] });
  });

  test('a dry run counts and writes nothing', async () => {
    BottleImage.find.mockReturnValue(lean(published));
    WineDefinition.find.mockReturnValue(lean([{ _id: oid('a') }]));

    const r = await assignMissingImages({ apply: false });

    expect(r.assigned).toBe(1);
    expect(BottleImage.updateOne).not.toHaveBeenCalled();
    expect(BottleImage.updateMany).not.toHaveBeenCalled();
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });

  test('a published row with no file left (a tombstone) is never picked', async () => {
    BottleImage.find.mockReturnValue(lean([{ _id: oid('7'), wineDefinition: oid('a'), processedUrl: null, originalUrl: null, createdAt: '2026-01-01T00:00:00Z' }]));
    WineDefinition.find.mockReturnValue(lean([{ _id: oid('a') }]));

    const r = await assignMissingImages({ apply: true });

    expect(r.assigned).toBe(0);
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });
});
