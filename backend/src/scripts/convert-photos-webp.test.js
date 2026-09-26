/**
 * scripts/convert-photos-webp — converts the kept photos to WebP next to
 * themselves, moves every stored reference, and only then removes the old
 * file. Real sharp and a temp uploads folder; the models are mocked.
 */
jest.mock('../models/BottleImage', () => ({ updateMany: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ updateMany: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(), find: jest.fn() }));
jest.mock('../models/WineRequest', () => ({ updateMany: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ updateMany: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const WineRequest = require('../models/WineRequest');
const JournalEntry = require('../models/JournalEntry');
const { convertPhoto, candidateUrls, leftovers, webpUrlFor, makeContext } = require('./convert-photos-webp');

const STEM = '0f3b2a1c-1111-4222-8333-944445555666';
const OLD = `/api/uploads/processed/${STEM}.png`;
const NEW = `/api/uploads/processed/${STEM}.webp`;

let root;
let ctx;
const at = (...p) => path.join(root, ...p);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function cutoutPng(width = 900, height = 3000) {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: Math.round(width / 3), height: Math.round(height * 0.8), channels: 4, background: { r: 120, g: 20, b: 40, alpha: 1 } } }, gravity: 'centre' }])
    .png()
    .toBuffer();
}

beforeEach(async () => {
  jest.clearAllMocks();
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webp-convert-'));
  await fs.promises.mkdir(at('processed'));
  await fs.promises.mkdir(at('originals'));
  ctx = makeContext({ uploadsRoot: root });
  for (const M of [BottleImage, WineDefinition, WineRequest, JournalEntry]) {
    M.updateMany.mockResolvedValue({ modifiedCount: 0 });
    M.countDocuments.mockResolvedValue(0);
    M.distinct.mockResolvedValue([]);
  }
  WineDefinition.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('webpUrlFor', () => {
  test('maps a kept photo to the WebP next to it', () => {
    expect(webpUrlFor(OLD)).toBe(NEW);
    expect(webpUrlFor(`/api/uploads/processed/${STEM}.JPG`)).toBe(NEW);
    expect(webpUrlFor(`/api/uploads/originals/${STEM}.jpeg`)).toBe(`/api/uploads/originals/${STEM}.webp`);
  });
  test.each([
    NEW,                                    // already WebP
    `/api/uploads/thumbs/processed/${STEM}.png.webp`,
    `/api/uploads/blog/${STEM}.png`,
    '/api/uploads/processed/../secret.png',
    `https://cellarion.app/api/uploads/processed/${STEM}.png`,
    null,
  ])('leaves %s alone', (url) => {
    expect(webpUrlFor(url)).toBeNull();
  });
});

describe('convertPhoto', () => {
  test('writes the WebP, moves every reference to it, then removes the old file and its thumbnail', async () => {
    await fs.promises.writeFile(at('processed', `${STEM}.png`), await cutoutPng());
    await fs.promises.mkdir(at('thumbs', 'processed'), { recursive: true });
    await fs.promises.writeFile(at('thumbs', 'processed', `${STEM}.png.webp`), 'old thumb');
    BottleImage.updateMany.mockImplementation(async (filter) => ({ modifiedCount: filter.processedUrl ? 2 : 0 }));
    WineDefinition.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'w1' }] }) });
    WineDefinition.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const r = await convertPhoto(OLD, ctx);

    expect(r.status).toBe('converted');
    const webp = await fs.promises.readFile(at('processed', `${STEM}.webp`));
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.height).toBe(2048);
    expect(meta.hasAlpha).toBe(true);
    expect(r.bytesAfter).toBe(webp.length);
    expect(r.bytesBefore).toBeGreaterThan(0);

    // Every stored reference follows, with the hash of the bytes now kept.
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ processedUrl: OLD }, { $set: { processedUrl: NEW, contentHash: sha256(webp) } });
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ originalUrl: OLD }, { $set: { originalUrl: NEW } });
    expect(WineDefinition.updateMany).toHaveBeenCalledWith({ image: OLD }, { $set: { image: NEW } });
    expect(WineRequest.updateMany).toHaveBeenCalledWith({ image: OLD }, { $set: { image: NEW } });
    expect(JournalEntry.updateMany).toHaveBeenCalledWith({ photos: OLD }, { $set: { 'photos.$[p]': NEW } }, { arrayFilters: [{ p: OLD }] });
    expect(r.moved).toMatchObject({ images: 2, wines: 1, wineIds: ['w1'] });

    // Old file and old thumbnail gone; the new thumbnail is already rendered.
    expect(fs.existsSync(at('processed', `${STEM}.png`))).toBe(false);
    expect(fs.existsSync(at('thumbs', 'processed', `${STEM}.png.webp`))).toBe(false);
    expect((await sharp(at('thumbs', 'processed', `${STEM}.webp.webp`)).metadata()).format).toBe('webp');
  });

  test('a run interrupted after writing the WebP is finished without re-encoding', async () => {
    const earlier = Buffer.from(await sharp(await cutoutPng(300, 900)).webp().toBuffer());
    await fs.promises.writeFile(at('processed', `${STEM}.png`), await cutoutPng());
    await fs.promises.writeFile(at('processed', `${STEM}.webp`), earlier);

    const r = await convertPhoto(OLD, ctx);

    expect(r.status).toBe('converted');
    expect(await fs.promises.readFile(at('processed', `${STEM}.webp`))).toEqual(earlier);
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ processedUrl: OLD }, { $set: { processedUrl: NEW, contentHash: sha256(earlier) } });
    expect(fs.existsSync(at('processed', `${STEM}.png`))).toBe(false);
  });

  test('references left on an old name whose file is already gone are moved to the WebP', async () => {
    const webp = await sharp(await cutoutPng(300, 900)).webp().toBuffer();
    await fs.promises.writeFile(at('processed', `${STEM}.webp`), webp);

    const r = await convertPhoto(OLD, ctx);

    expect(r).toMatchObject({ status: 'converted', bytesBefore: 0 });
    expect(WineDefinition.updateMany).toHaveBeenCalledWith({ image: OLD }, { $set: { image: NEW } });
  });

  test('nothing on disk under either name → missing, and nothing is changed', async () => {
    const r = await convertPhoto(OLD, ctx);
    expect(r.status).toBe('missing');
    for (const M of [BottleImage, WineDefinition, WineRequest, JournalEntry]) expect(M.updateMany).not.toHaveBeenCalled();
  });

  test('a file that does not decode throws — the old file and every reference stay as they were', async () => {
    await fs.promises.writeFile(at('processed', `${STEM}.png`), 'not a png');

    await expect(convertPhoto(OLD, ctx)).rejects.toThrow();

    expect(fs.existsSync(at('processed', `${STEM}.png`))).toBe(true);
    expect(fs.existsSync(at('processed', `${STEM}.webp`))).toBe(false);
    for (const M of [BottleImage, WineDefinition, WineRequest, JournalEntry]) expect(M.updateMany).not.toHaveBeenCalled();
  });

  test('a keep-background original (the kept file lives in originals/) is converted in place, without a thumbnail', async () => {
    const jpeg = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: { r: 200, g: 180, b: 150 } } }).jpeg().toBuffer();
    await fs.promises.writeFile(at('originals', `${STEM}.jpg`), jpeg);
    const oldUrl = `/api/uploads/originals/${STEM}.jpg`;
    const newUrl = `/api/uploads/originals/${STEM}.webp`;

    const r = await convertPhoto(oldUrl, ctx);

    expect(r.status).toBe('converted');
    const meta = await sharp(at('originals', `${STEM}.webp`)).metadata();
    expect([meta.format, meta.height]).toEqual(['webp', 2048]);
    // processedUrl === originalUrl on such a row: both move.
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ processedUrl: oldUrl }, expect.objectContaining({ $set: expect.objectContaining({ processedUrl: newUrl }) }));
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ originalUrl: oldUrl }, { $set: { originalUrl: newUrl } });
    expect(fs.existsSync(at('originals', `${STEM}.jpg`))).toBe(false);
    expect(fs.existsSync(at('thumbs'))).toBe(false);
  });
});

describe('candidateUrls', () => {
  test('collects each old name once, across every collection that stores one, and never asks for label scans', async () => {
    BottleImage.distinct.mockResolvedValue([OLD, `/api/uploads/originals/${STEM}.jpg`]);
    WineDefinition.distinct.mockResolvedValue([OLD, '/api/uploads/processed/only-a-wine.png']);
    WineRequest.distinct.mockResolvedValue(['/api/uploads/processed/requested.jpg']);
    JournalEntry.distinct.mockResolvedValue(['/api/uploads/processed/journal.png', 'https://elsewhere.test/x.png']);

    const urls = await candidateUrls();

    expect(urls).toEqual([
      `/api/uploads/originals/${STEM}.jpg`,
      '/api/uploads/processed/journal.png',
      '/api/uploads/processed/only-a-wine.png',
      OLD,
      '/api/uploads/processed/requested.jpg',
    ].sort());
    expect(BottleImage.distinct).toHaveBeenCalledWith('processedUrl', expect.objectContaining({ kind: { $ne: 'label-scan' } }));
  });
});

describe('leftovers', () => {
  test('an old file whose WebP exists and that nothing refers to any more', async () => {
    await fs.promises.writeFile(at('processed', 'gone-a.png'), 'x');
    await fs.promises.writeFile(at('processed', 'gone-a.webp'), 'x');
    await fs.promises.writeFile(at('processed', 'kept-b.png'), 'x');
    await fs.promises.writeFile(at('processed', 'kept-b.webp'), 'x');
    await fs.promises.writeFile(at('processed', 'lonely-c.png'), 'x'); // not converted yet
    BottleImage.countDocuments.mockImplementation(async (q) => (JSON.stringify(q).includes('kept-b.png') ? 1 : 0));

    expect(await leftovers(ctx)).toEqual(['/api/uploads/processed/gone-a.png']);
  });
});
