/**
 * services/imageVintageBackfill — photos written before BottleImage.vintage
 * existed learn their bottle's vintage at boot (support ticket 2026-10-09).
 * Only rows WITHOUT the key are touched, every row ends with the key present
 * (null for wine-level uploads and label scans), and the loop stops when a
 * page writes nothing rather than spinning.
 */
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const { backfillImageVintages } = require('./imageVintageBackfill');

const chain = (rows) => {
  const q = { select: () => q, limit: () => q, lean: async () => rows };
  return q;
};

beforeEach(() => jest.clearAllMocks());

test('a photo of a bottle takes that bottle\'s vintage; one with no bottle gets an explicit null; then the loop ends', async () => {
  BottleImage.find
    .mockReturnValueOnce(chain([{ _id: 'i1', bottle: 'b1' }, { _id: 'i2', bottle: 'b2' }, { _id: 'i3', bottle: null }]))
    .mockReturnValueOnce(chain([]));
  Bottle.find.mockReturnValue(chain([{ _id: 'b1', vintage: '2015' }, { _id: 'b2', vintage: 'Unknown' }]));
  BottleImage.bulkWrite.mockResolvedValue({ modifiedCount: 3 });

  const n = await backfillImageVintages();

  expect(n).toBe(3);
  expect(BottleImage.find).toHaveBeenCalledWith({ vintage: { $exists: false } });
  expect(Bottle.find).toHaveBeenCalledWith({ _id: { $in: ['b1', 'b2'] } });
  const ops = BottleImage.bulkWrite.mock.calls[0][0];
  expect(ops).toEqual([
    { updateOne: { filter: { _id: 'i1', vintage: { $exists: false } }, update: { $set: { vintage: '2015' } } } },
    { updateOne: { filter: { _id: 'i2', vintage: { $exists: false } }, update: { $set: { vintage: null } } } }, // Unknown year → wine-wide
    { updateOne: { filter: { _id: 'i3', vintage: { $exists: false } }, update: { $set: { vintage: null } } } }, // no bottle
  ]);
  expect(BottleImage.bulkWrite).toHaveBeenCalledWith(expect.anything(), { ordered: false });
});

test('a photo whose bottle is gone still gets the key (null), so it is never re-read', async () => {
  BottleImage.find.mockReturnValueOnce(chain([{ _id: 'i9', bottle: 'gone' }])).mockReturnValueOnce(chain([]));
  Bottle.find.mockReturnValue(chain([]));
  BottleImage.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

  await backfillImageVintages();
  expect(BottleImage.bulkWrite.mock.calls[0][0][0].updateOne.update).toEqual({ $set: { vintage: null } });
});

test('nothing to do: one probe, no bottle lookup, no write', async () => {
  BottleImage.find.mockReturnValue(chain([]));
  expect(await backfillImageVintages()).toBe(0);
  expect(Bottle.find).not.toHaveBeenCalled();
  expect(BottleImage.bulkWrite).not.toHaveBeenCalled();
});

test('a page that writes nothing (another process got there first) ends the loop instead of spinning', async () => {
  BottleImage.find.mockReturnValue(chain([{ _id: 'i1', bottle: null }]));
  BottleImage.bulkWrite.mockResolvedValue({ modifiedCount: 0 });
  expect(await backfillImageVintages()).toBe(0);
  expect(BottleImage.find).toHaveBeenCalledTimes(1);
});
