/**
 * imageProcessor honours BottleImage.keepBackground.
 *
 * Label-only photos come back cropped because rembg expects a whole bottle.
 * An uploader who opts out must never have their photo sent to rembg — not
 * on the initial hand-off (imageOps skips it) and not on a retry. (There is
 * no reprocess-everything job to guard: originals are not retained once
 * processed, so there is nothing to re-run — see
 * imageProcessor.discardOriginal.)
 */
jest.mock('../config/upload', () => ({ PROCESSED_DIR: '/tmp/processed' }));
jest.mock('../models/BottleImage', () => ({ findById: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const { processImage } = require('./imageProcessor');

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
  // The original IS the kept file — it must still be referenced.
  expect(doc.originalUrl).toBe('/api/uploads/originals/a.jpg');
  expect(doc.save).toHaveBeenCalledTimes(1);
});
