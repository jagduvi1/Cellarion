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

const fs = require('fs');
const BottleImage = require('../models/BottleImage');
const { processImage, discardOriginal, unlinkImageFiles } = require('./imageProcessor');

const ORIG = '/api/uploads/originals/abc.jpg';
const PROC = '/api/uploads/processed/abc.png';

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
    expect(fs.writeFileSync).toHaveBeenCalledWith('/app/uploads/processed/abc.png', expect.any(Buffer));
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/originals/abc.jpg');
    expect(BottleImage.updateOne).toHaveBeenCalledWith(
      { _id: 'img1', originalUrl: ORIG },
      { $set: { originalUrl: null } },
    );
    expect(doc.originalUrl).toBeNull();
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
  test('unlinks both files of an unreferenced record', async () => {
    await unlinkImageFiles(makeDoc({ processedUrl: PROC }));
    expect(fs.promises.unlink).toHaveBeenCalledTimes(2);
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/originals/abc.jpg');
    expect(fs.promises.unlink).toHaveBeenCalledWith('/app/uploads/processed/abc.png');
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
