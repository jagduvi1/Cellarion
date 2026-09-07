/**
 * photoBytes — the one place a stored image reference becomes the bytes of an
 * MCP image block (support ticket 2026-09-07). Pins: an /api/uploads/ path is
 * read through the traversal-safe resolver and downscaled; an inline data:
 * image is decoded and downscaled without touching the disk; an external URL
 * is "not ours" (null), never fetched; a failing read propagates so the tool
 * can answer `unavailable` instead of pretending.
 */
jest.mock('./imageProcessor', () => ({ safeUploadPath: jest.fn((p) => `/app/uploads/${p}`) }));
jest.mock('fs', () => ({ promises: { readFile: jest.fn() } }));
jest.mock('sharp', () => {
  const api = {
    rotate: jest.fn(() => api),
    resize: jest.fn(() => api),
    jpeg: jest.fn(() => api),
    toBuffer: jest.fn(async () => Buffer.from('downscaled-jpeg-bytes')),
  };
  const factory = jest.fn(() => api);
  factory.__api = api;
  return factory;
});

const fs = require('fs');
const sharp = require('sharp');
const { safeUploadPath } = require('./imageProcessor');
const { renderImage, imageSource, IMAGE_MAX_EDGE, IMAGE_QUALITY } = require('./photoBytes');

beforeEach(() => {
  jest.clearAllMocks();
  fs.promises.readFile.mockResolvedValue(Buffer.from('original-bytes'));
});

describe('imageSource', () => {
  test('classifies uploads, inline images and external links; anything else is nothing', () => {
    expect(imageSource('/api/uploads/processed/a.png')).toEqual({ kind: 'upload', relative: 'processed/a.png' });
    expect(imageSource('data:image/png;base64,iVBORw0KGgo=')).toEqual({ kind: 'inline' });
    expect(imageSource('https://cdn.example/x.jpg')).toEqual({ kind: 'external', url: 'https://cdn.example/x.jpg' });
    expect(imageSource('')).toBeNull();
    expect(imageSource(null)).toBeNull();
    expect(imageSource('processed/a.png')).toBeNull();
  });
});

describe('renderImage', () => {
  test('an upload is read through safeUploadPath and downscaled to a JPEG block', async () => {
    const out = await renderImage('/api/uploads/originals/label.jpg');
    expect(safeUploadPath).toHaveBeenCalledWith('originals/label.jpg');
    expect(fs.promises.readFile).toHaveBeenCalledWith('/app/uploads/originals/label.jpg');
    expect(sharp).toHaveBeenCalledWith(Buffer.from('original-bytes'));
    expect(sharp.__api.rotate).toHaveBeenCalled();
    expect(sharp.__api.resize).toHaveBeenCalledWith({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    expect(sharp.__api.jpeg).toHaveBeenCalledWith({ quality: IMAGE_QUALITY });
    expect(out).toEqual({
      data: Buffer.from('downscaled-jpeg-bytes').toString('base64'),
      mimeType: 'image/jpeg',
      bytes: Buffer.from('downscaled-jpeg-bytes').length,
    });
  });

  test('the caller can narrow the edge (the sommelier tool passes its own cap)', async () => {
    await renderImage('/api/uploads/originals/label.jpg', { maxEdge: 640 });
    expect(sharp.__api.resize).toHaveBeenCalledWith(expect.objectContaining({ width: 640, height: 640 }));
  });

  test('an inline data: image is decoded and downscaled without touching the disk', async () => {
    const png = Buffer.from('fake-png-bytes');
    const out = await renderImage(`data:image/png;base64,${png.toString('base64')}`);
    expect(fs.promises.readFile).not.toHaveBeenCalled();
    expect(sharp).toHaveBeenCalledWith(png);
    expect(out.mimeType).toBe('image/jpeg');
  });

  test('an external URL is not ours: null, and nothing is fetched or read', async () => {
    expect(await renderImage('https://cdn.example/x.jpg')).toBeNull();
    expect(await renderImage(null)).toBeNull();
    expect(fs.promises.readFile).not.toHaveBeenCalled();
    expect(sharp).not.toHaveBeenCalled();
  });

  test('a missing file propagates, so the tool can say unavailable', async () => {
    fs.promises.readFile.mockRejectedValue(new Error('ENOENT'));
    await expect(renderImage('/api/uploads/originals/gone.jpg')).rejects.toThrow('ENOENT');
  });

  test('a traversal attempt is refused by the resolver before any read', async () => {
    safeUploadPath.mockImplementationOnce(() => { throw new Error('Path traversal blocked'); });
    await expect(renderImage('/api/uploads/../../etc/passwd')).rejects.toThrow('Path traversal blocked');
    expect(fs.promises.readFile).not.toHaveBeenCalled();
  });
});
