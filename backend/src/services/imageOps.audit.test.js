/**
 * The audit rows the shared photo services write — one place for both
 * surfaces (the web routes and the MCP tools), so a photo change is traceable
 * whichever way it was made.
 *
 * Pins: a photo put on a bottle writes ONE 'image.attach' row naming the
 * surface; a registry picture (no bottle) writes none; a rejected image writes
 * none; choosing, changing or clearing a bottle's default photo writes one
 * 'image.default' row with the previous choice, and a no-op choice writes none.
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
jest.mock('../services/photoFormat', () => ({
  encodeKeptPhoto: jest.fn(async () => Buffer.from('KEPT-WEBP')),
  KEPT_EXTENSION: 'webp',
}));
jest.mock('../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const fs = require('fs');
jest.spyOn(fs.promises, 'writeFile').mockResolvedValue();
jest.spyOn(fs.promises, 'rename').mockResolvedValue();

const mongoose = require('mongoose');
const BottleImage = require('../models/BottleImage');
jest.mock('../models/BottleImage');

const { sanitizeImageBuffer, detectImageFormat } = require('../services/imageSanitizer');
const { logAudit } = require('./audit');
const { ingestBottleImage, setBottleDefaultImage } = require('./imageOps');

const oid = (c) => new mongoose.Types.ObjectId(c.repeat(24));
const REQ = { user: { id: 'u1' }, headers: {} };
const BOTTLE_ID = oid('b');
const CELLAR_ID = oid('c');
const NEW_IMAGE = oid('9');

beforeEach(() => {
  jest.clearAllMocks();
  fs.promises.writeFile.mockResolvedValue();
  fs.promises.rename.mockResolvedValue();
  sanitizeImageBuffer.mockResolvedValue(Buffer.from('CLEAN-BYTES'));
  detectImageFormat.mockReturnValue('jpeg');
  BottleImage.countDocuments = jest.fn().mockResolvedValue(0);
  BottleImage.mockImplementation(function (doc) {
    Object.assign(this, doc, { _id: NEW_IMAGE, save: jest.fn().mockResolvedValue(this) });
  });
});

describe('ingestBottleImage → image.attach', () => {
  const bottle = () => ({ _id: BOTTLE_ID, cellar: CELLAR_ID, vintage: '2016' });

  test('a photo put on a bottle writes one row, on the bottle, naming the web surface by default', async () => {
    const res = await ingestBottleImage({ buffer: Buffer.from('RAW'), userId: 'u1', bottle: bottle() }, REQ);
    expect(res.error).toBeUndefined();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(REQ, 'image.attach',
      { type: 'bottle', id: BOTTLE_ID, cellarId: CELLAR_ID },
      { via: 'web', imageId: String(NEW_IMAGE) });
  });

  test('the caller names its surface', async () => {
    await ingestBottleImage({ buffer: Buffer.from('RAW'), userId: 'u1', bottle: bottle(), via: 'mcp' }, REQ);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][3]).toEqual({ via: 'mcp', imageId: String(NEW_IMAGE) });
  });

  test('a registry picture (no bottle) writes no attach row — its own flow audits it', async () => {
    const res = await ingestBottleImage({ buffer: Buffer.from('RAW'), userId: 'u1', wineDefinitionId: 'w1' }, REQ);
    expect(res.error).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('an image the pipeline rejects writes nothing', async () => {
    sanitizeImageBuffer.mockRejectedValue(new Error('bad'));
    const res = await ingestBottleImage({ buffer: Buffer.from('RAW'), userId: 'u1', bottle: bottle() }, REQ);
    expect(res.error.status).toBe(400);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a bottle already at the photo cap writes nothing', async () => {
    BottleImage.countDocuments.mockResolvedValue(20);
    const res = await ingestBottleImage({ buffer: Buffer.from('RAW'), userId: 'u1', bottle: bottle() }, REQ);
    expect(res.error.status).toBe(400);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('setBottleDefaultImage → image.default', () => {
  const PREV = oid('3');
  const CHOSEN = oid('4');
  const bottle = (over = {}) => ({
    _id: BOTTLE_ID, cellar: CELLAR_ID, wineDefinition: null, defaultImage: PREV,
    save: jest.fn().mockResolvedValue(undefined), ...over,
  });

  beforeEach(() => {
    BottleImage.findOne = jest.fn().mockResolvedValue({ _id: CHOSEN });
  });

  test('choosing another photo writes one row with the new and the previous choice', async () => {
    const res = await setBottleDefaultImage(bottle(), String(CHOSEN), REQ);
    expect(res.error).toBeUndefined();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(REQ, 'image.default',
      { type: 'bottle', id: BOTTLE_ID, cellarId: CELLAR_ID },
      { imageId: String(CHOSEN), prev: String(PREV) });
  });

  test('clearing the choice writes a row with no image', async () => {
    const res = await setBottleDefaultImage(bottle(), null, REQ);
    expect(res.error).toBeUndefined();
    expect(logAudit).toHaveBeenCalledWith(REQ, 'image.default',
      { type: 'bottle', id: BOTTLE_ID, cellarId: CELLAR_ID },
      { imageId: null, prev: String(PREV) });
  });

  test('choosing the photo that already is the default writes nothing', async () => {
    BottleImage.findOne.mockResolvedValue({ _id: PREV });
    await setBottleDefaultImage(bottle(), String(PREV), REQ);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('clearing a bottle that has no choice writes nothing', async () => {
    await setBottleDefaultImage(bottle({ defaultImage: null }), null, REQ);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a photo that is not the bottle\'s writes nothing', async () => {
    BottleImage.findOne.mockResolvedValue(null);
    const res = await setBottleDefaultImage(bottle(), String(CHOSEN), REQ);
    expect(res.error.status).toBe(404);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
