/**
 * imageProcessor keeps ONLY the processed file once background removal has
 * succeeded.
 *
 * Support ticket 2026-09-03: a user's cellar showed photos "including the
 * background", served from /api/uploads/originals/. Nothing needs the raw
 * frame once rembg has run, so processImage now deletes it (discardOriginal).
 * Pinned here: the happy path drops the original file AND the pointer; a
 * failed rembg run keeps both (the retry needs its source); a keepBackground
 * row, whose "original" IS the kept file, is never touched; a file another
 * record still references stays on disk while this record drops its pointer.
 */
jest.mock('../config/upload', () => ({ PROCESSED_DIR: '/app/uploads/processed' }));
jest.mock('../models/BottleImage', () => ({
  findById: jest.fn(),
  countDocuments: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('fs', () => ({
  readFileSync: jest.fn(() => Buffer.from('raw-upload-bytes')),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(() => true),
  promises: {
    unlink: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest.fn(),
  },
}));
// The sizes and the WebP encode have their own suite (photoFormat.test.js).
jest.mock('./photoFormat', () => ({
  prepareRembgInput: jest.fn(async (buf) => ({ buffer: Buffer.concat([Buffer.from('small:'), buf]), type: 'image/jpeg', filename: 'input.jpg' })),
  encodeKeptPhoto: jest.fn(async () => Buffer.from('kept-webp-bytes')),
  KEPT_EXTENSION: 'webp',
}));
jest.mock('./thumbnails', () => ({
  ...jest.requireActual('./thumbnails'),
  warmThumbFor: jest.fn().mockResolvedValue(true),
}));

const crypto = require('crypto');
const fs = require('fs');
const BottleImage = require('../models/BottleImage');
const { prepareRembgInput, encodeKeptPhoto } = require('./photoFormat');
const { warmThumbFor } = require('./thumbnails');
const { processImage, discardOriginal, unlinkImageFiles } = require('./imageProcessor');

const ORIG = '/api/uploads/originals/abc.jpg';
const PROC = '/api/uploads/processed/abc.webp';

function makeDoc(over = {}) {
  return {
    _id: 'img1', status: 'uploaded', keepBackground: false, assignedToWine: false,
    originalUrl: ORIG, processedUrl: null, contentHash: null,
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// processImage loads the doc once (awaited directly), then re-reads a
// projection for the official-wine hook (.select()). First call → the doc;
// every later call → a non-official projection.
function loadDoc(doc) {
  BottleImage.findById.mockReset();
  BottleImage.findById
    .mockResolvedValueOnce(doc)
    .mockImplementation(() => ({ select: jest.fn().mockResolvedValue({ assignedToWine: false }) }));
}

function rembg({ ok = true, status = 200 } = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
    text: async () => 'boom',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.countDocuments.mockResolvedValue(0);
  BottleImage.updateOne.mockResolvedValue({ acknowledged: true });
});

describe('processImage', () => {
  test('a successful rembg run deletes the original file and nulls originalUrl — the processed file is the only copy', async () => {
    const doc = makeDoc();
    loadDoc(doc);
    rembg();

    await processImage('img1');

    expect(doc.status).toBe('processed');
    expect(doc.processedUrl).toBe(PROC);
    expect(fs.writeFileSync).toHaveBeenCalledWith('/app/uploads/processed/abc.webp', expect.any(Buffer));
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/originals/abc.jpg');
    expect(BottleImage.updateOne).toHaveBeenCalledWith(
      { _id: 'img1', originalUrl: ORIG },
      { $set: { originalUrl: null } },
    );
    expect(doc.originalUrl).toBeNull();
  });

  test('rembg gets the scaled-down frame; the WebP of its answer is what is written, hashed and thumbnailed', async () => {
    const doc = makeDoc();
    loadDoc(doc);
    rembg();

    await processImage('img1');

    expect(prepareRembgInput).toHaveBeenCalledWith(Buffer.from('raw-upload-bytes'));
    const sent = global.fetch.mock.calls[0][1].body.get('image');
    expect(sent.type).toBe('image/jpeg');
    expect(Buffer.from(await sent.arrayBuffer()).toString()).toBe('small:raw-upload-bytes');
    // The PNG rembg answered with is encoded, and only the encoded bytes are kept.
    expect(Buffer.from(encodeKeptPhoto.mock.calls[0][0])).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(fs.writeFileSync.mock.calls[0][1].toString()).toBe('kept-webp-bytes');
    expect(doc.contentHash).toBe(crypto.createHash('sha256').update('kept-webp-bytes').digest('hex'));
    expect(warmThumbFor).toHaveBeenCalledWith(PROC);
  });

  test('a photo that cannot be encoded fails like a rembg failure — original kept, retryable, nothing written', async () => {
    encodeKeptPhoto.mockRejectedValueOnce(new Error('corrupt PNG'));
    const doc = makeDoc();
    loadDoc(doc);
    rembg();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await processImage('img1');

    expect(doc.status).toBe('uploaded');
    expect(doc.processedUrl).toBeNull();
    expect(doc.originalUrl).toBe(ORIG);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.promises.unlink).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test('a FAILED rembg run keeps the original — the retry needs its source', async () => {
    const doc = makeDoc();
    loadDoc(doc);
    rembg({ ok: false, status: 500 });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await processImage('img1');

    expect(doc.status).toBe('uploaded');
    expect(doc.originalUrl).toBe(ORIG);
    expect(fs.promises.unlink).not.toHaveBeenCalled();
    expect(BottleImage.updateOne).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test('a keepBackground row is settled from its original and nothing is deleted', async () => {
    const doc = makeDoc({ keepBackground: true });
    loadDoc(doc);
    global.fetch = jest.fn(() => { throw new Error('rembg must not be called'); });

    await processImage('img1');

    expect(doc.processedUrl).toBe(ORIG);
    expect(doc.originalUrl).toBe(ORIG);
    expect(fs.promises.unlink).not.toHaveBeenCalled();
  });
});

describe('discardOriginal', () => {
  test("keeps a file another record still references, but drops this record's pointer", async () => {
    BottleImage.countDocuments.mockResolvedValue(1);
    const doc = makeDoc({ processedUrl: PROC });

    await discardOriginal(doc);

    expect(fs.promises.unlink).not.toHaveBeenCalled();
    expect(BottleImage.updateOne).toHaveBeenCalledWith({ _id: 'img1', originalUrl: ORIG }, { $set: { originalUrl: null } });
    expect(doc.originalUrl).toBeNull();
  });

  test('never touches a row whose original IS the kept file (keepBackground: processedUrl === originalUrl)', async () => {
    const doc = makeDoc({ keepBackground: true, processedUrl: ORIG });
    await discardOriginal(doc);
    expect(fs.promises.unlink).not.toHaveBeenCalled();
    expect(BottleImage.updateOne).not.toHaveBeenCalled();
    expect(doc.originalUrl).toBe(ORIG);
  });

  test('never touches a row with no processed file (failed run, or an imported never-cropped photo)', async () => {
    const doc = makeDoc({ processedUrl: null });
    await discardOriginal(doc);
    expect(fs.promises.unlink).not.toHaveBeenCalled();
    expect(BottleImage.updateOne).not.toHaveBeenCalled();
    expect(doc.originalUrl).toBe(ORIG);
  });

  test('an unlink failure is logged, not thrown — and the pointer is still dropped so nothing serves the file', async () => {
    fs.promises.unlink.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = makeDoc({ processedUrl: PROC });

    await expect(discardOriginal(doc)).resolves.toBeUndefined();

    expect(doc.originalUrl).toBeNull();
    expect(BottleImage.updateOne).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('unlinkImageFiles (same contract after the refactor)', () => {
  test('unlinks both files of an unreferenced record, and the processed file\'s thumbnail', async () => {
    await unlinkImageFiles(makeDoc({ processedUrl: PROC }));
    expect(fs.promises.unlink).toHaveBeenCalledTimes(3);
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/originals/abc.jpg');
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/processed/abc.webp');
    // services/thumbnails — only processed/ files have one.
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/thumbs/processed/abc.webp.webp');
  });

  test('a photo processed before WebP (a .png) is deleted the same way', async () => {
    await unlinkImageFiles(makeDoc({ originalUrl: null, processedUrl: '/api/uploads/processed/old.png' }));
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/processed/old.png');
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/thumbs/processed/old.png.webp');
  });

  test('keeps a file another record shares', async () => {
    BottleImage.countDocuments.mockResolvedValue(2);
    await unlinkImageFiles(makeDoc({ processedUrl: PROC }));
    expect(fs.promises.unlink).not.toHaveBeenCalled();
  });
});

describe('processImage gates (post-ship audit 2026-09-03)', () => {
  test('a label scan is never sent to rembg, so its frame is never discarded', async () => {
    const doc = makeDoc({ kind: 'label-scan' });
    loadDoc(doc);
    global.fetch = jest.fn();
    await processImage('img1');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.originalUrl).toBe(ORIG);
  });

  test('an image approved before processing is processed and STAYS approved', async () => {
    const doc = makeDoc({ status: 'approved' });
    loadDoc(doc);
    rembg();
    await processImage('img1');
    expect(doc.status).toBe('approved');
    expect(doc.processedUrl).toBe(PROC);
    expect(doc.originalUrl).toBeNull();
  });

  test('a failed run on an approved image keeps it approved with its original', async () => {
    const doc = makeDoc({ status: 'approved' });
    loadDoc(doc);
    rembg({ ok: false, status: 500 });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    await processImage('img1');
    expect(doc.status).toBe('approved');
    expect(doc.originalUrl).toBe(ORIG);
    error.mockRestore();
  });

  test('an approved image that already has a processed file is left alone', async () => {
    const doc = makeDoc({ status: 'approved', processedUrl: PROC });
    loadDoc(doc);
    global.fetch = jest.fn();
    await processImage('img1');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });
});
