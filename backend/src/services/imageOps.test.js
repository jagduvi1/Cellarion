/**
 * services/imageOps.ingestBottleImage — the ONE pipeline shared by the REST
 * upload route and the MCP attach_bottle_image tool.
 *
 * Pins: fail-closed sanitisation (a buffer sharp can't decode is rejected,
 * nothing persisted), the per-bottle image cap, the sniffed-format extension
 * (never a caller claim), and the background-removal hand-off. Real disk /
 * sharp are mocked — imageSanitizer + imageProcessor have their own suites.
 */

jest.mock('../config/upload', () => ({ ORIGINALS_DIR: '/tmp/originals' }));
jest.mock('../services/imageSanitizer', () => ({
  sanitizeImageBuffer: jest.fn(),
  detectImageFormat: jest.fn(),
}));
jest.mock('../services/imageProcessor', () => ({
  processImage: jest.fn(() => Promise.resolve()),
  hashImageBytes: jest.fn(() => 'deadbeef'),
}));

const fs = require('fs');
jest.spyOn(fs.promises, 'writeFile').mockResolvedValue();

const BottleImage = require('../models/BottleImage');
jest.mock('../models/BottleImage');

const { sanitizeImageBuffer, detectImageFormat } = require('../services/imageSanitizer');
const { processImage } = require('../services/imageProcessor');
const { ingestBottleImage } = require('./imageOps');

const REQ = { user: { id: 'u1' } };

beforeEach(() => {
  jest.clearAllMocks();
  fs.promises.writeFile.mockResolvedValue();
  sanitizeImageBuffer.mockResolvedValue(Buffer.from('CLEAN-BYTES'));
  detectImageFormat.mockReturnValue('jpeg');
  BottleImage.countDocuments = jest.fn().mockResolvedValue(0);
  // `new BottleImage(doc)` → an object that remembers doc + a save().
  BottleImage.mockImplementation(function (doc) {
    Object.assign(this, doc, { _id: 'img-new', save: jest.fn().mockResolvedValue(this) });
  });
});

test('happy path: sanitises, writes a sniffed-extension file, saves the row, kicks off bg removal', async () => {
  const res = await ingestBottleImage({ buffer: Buffer.from('RAW'), userId: 'u1', bottle: { _id: 'b1' } }, REQ);
  expect(res.error).toBeUndefined();
  expect(sanitizeImageBuffer).toHaveBeenCalledWith(Buffer.from('RAW'));
  // The CLEAN (re-encoded) bytes are persisted, never the caller's raw input.
  const [, written] = fs.promises.writeFile.mock.calls[0];
  expect(written.toString()).toBe('CLEAN-BYTES');
  // Extension comes from the sniffed format.
  const [writtenPath] = fs.promises.writeFile.mock.calls[0];
  expect(writtenPath).toMatch(/\.jpg$/);
  expect(res.image.originalUrl).toMatch(/^\/api\/uploads\/originals\/.*\.jpg$/);
  expect(res.image.bottle).toBe('b1');
  expect(res.image.save).toHaveBeenCalled();
  expect(processImage).toHaveBeenCalledWith('img-new');
});

test('fail-closed: an undecodable buffer is rejected, nothing written or saved', async () => {
  sanitizeImageBuffer.mockRejectedValue(new Error('Input buffer contains unsupported image format'));
  const res = await ingestBottleImage({ buffer: Buffer.from('NOT-AN-IMAGE'), userId: 'u1' }, REQ);
  expect(res.error.status).toBe(400);
  expect(fs.promises.writeFile).not.toHaveBeenCalled();
  expect(processImage).not.toHaveBeenCalled();
});

test('empty buffer → 400 before any work', async () => {
  const res = await ingestBottleImage({ buffer: Buffer.alloc(0), userId: 'u1' }, REQ);
  expect(res.error.status).toBe(400);
  expect(sanitizeImageBuffer).not.toHaveBeenCalled();
});

test('per-bottle image cap enforced', async () => {
  BottleImage.countDocuments.mockResolvedValue(20);
  const res = await ingestBottleImage({ buffer: Buffer.from('RAW'), userId: 'u1', bottle: { _id: 'b1' } }, REQ);
  expect(res.error.status).toBe(400);
  expect(res.error.message).toMatch(/Maximum of 20/);
  expect(sanitizeImageBuffer).not.toHaveBeenCalled();
});

test('unverifiable sniffed format → 400 (never trust a fallback extension)', async () => {
  detectImageFormat.mockReturnValue(null);
  const res = await ingestBottleImage({ buffer: Buffer.from('RAW'), userId: 'u1' }, REQ);
  expect(res.error.status).toBe(400);
  expect(fs.promises.writeFile).not.toHaveBeenCalled();
});
