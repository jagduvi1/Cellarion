/**
 * imageProcessor honours BottleImage.keepBackground.
 *
 * Support ticket 6a97f870 (2026-09-02): label-only photos came back cropped
 * because rembg expects a whole bottle. An uploader who opts out must never
 * have their photo sent to rembg — not on the initial hand-off (imageOps skips
 * it), not on a retry, and not by the reprocess-everything maintenance job.
 */
jest.mock('../config/upload', () => ({ PROCESSED_DIR: '/tmp/processed' }));
jest.mock('../models/BottleImage', () => ({ findById: jest.fn(), find: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const { processImage, reprocessAllImages } = require('./imageProcessor');

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(() => { throw new Error('rembg must not be called'); });
});

test('processImage on a keepBackground row settles it from the original without calling rembg', async () => {
  const doc = {
    _id: 'i1', status: 'uploaded', keepBackground: true,
    originalUrl: '/api/uploads/originals/a.jpg', processedUrl: null,
    save: jest.fn().mockResolvedValue(),
  };
  BottleImage.findById.mockResolvedValue(doc);
  await processImage('i1');
  expect(global.fetch).not.toHaveBeenCalled();
  expect(doc.status).toBe('processed');
  expect(doc.processedUrl).toBe('/api/uploads/originals/a.jpg');
  expect(doc.save).toHaveBeenCalledTimes(1);
});

test('reprocessAllImages excludes keepBackground rows from its query', async () => {
  BottleImage.find.mockResolvedValue([]);
  await reprocessAllImages();
  expect(BottleImage.find).toHaveBeenCalledWith(expect.objectContaining({ keepBackground: { $ne: true } }));
  expect(global.fetch).not.toHaveBeenCalled();
});
