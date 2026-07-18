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
// attachOfficialWineImage lazy-requires search (ESM meilisearch — unparseable
// by jest) — mock at top level like every other suite.
jest.mock('../services/search', () => ({ indexWine: jest.fn(), indexBottle: jest.fn() }));

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

// ── attachOfficialWineImage — the admin one-shot (REST + MCP shared) ─────────
describe('attachOfficialWineImage', () => {
  // Monkey-patch the real model singleton — the service lazy-requires the same
  // object, and a block-level jest.mock would not hoist.
  const WineDefinition = require('../models/WineDefinition');
  const searchService = require('../services/search');
  const { attachOfficialWineImage } = require('./imageOps');

  beforeEach(() => {
    WineDefinition.findByIdAndUpdate = jest.fn().mockResolvedValue({});
    BottleImage.updateMany = jest.fn().mockResolvedValue({});
  });

  test('ingests, pre-approves as the official public image, replaces the prior one, stamps wine.image + credit', async () => {
    const res = await attachOfficialWineImage(
      { buffer: Buffer.from('img'), wineDefinitionId: 'w1', credit: 'Photo: Systembolaget', userId: 'admin1' }, REQ
    );
    expect(res.error).toBeUndefined();
    const img = res.image;
    expect(img.status).toBe('approved');
    expect(img.visibility).toBe('public');
    expect(img.assignedToWine).toBe(true);
    expect(img.reviewedBy).toBe('admin1');
    expect(img.credit).toBe('Photo: Systembolaget');
    // Any previous official image is demoted first.
    expect(BottleImage.updateMany).toHaveBeenCalledWith(
      { wineDefinition: 'w1', assignedToWine: true }, { assignedToWine: false });
    expect(WineDefinition.findByIdAndUpdate).toHaveBeenCalledWith('w1',
      expect.objectContaining({ imageCredit: 'Photo: Systembolaget' }));
    expect(searchService.indexWine).toHaveBeenCalledWith('w1');
  });

  test('a rejected buffer fails closed — nothing approved, wine untouched', async () => {
    sanitizeImageBuffer.mockRejectedValue(new Error('not an image'));
    const res = await attachOfficialWineImage(
      { buffer: Buffer.from('junk'), wineDefinitionId: 'w1', userId: 'admin1' }, REQ
    );
    expect(res.error.status).toBe(400);
    expect(WineDefinition.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(BottleImage.updateMany).not.toHaveBeenCalled();
  });
});
