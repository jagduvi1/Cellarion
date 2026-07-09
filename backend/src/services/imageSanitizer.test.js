const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { stripImageMetadata, hasStrippableMetadata, sanitizeImageBuffer, detectImageFormat } = require('./imageSanitizer');

// sharp caches open file descriptors, which blocks the temp-dir cleanup on
// Windows (EBUSY on unlink). The cache is irrelevant for these tests.
sharp.cache(false);

describe('stripImageMetadata', () => {
  let dir;

  beforeAll(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'exif-test-'));
  });

  afterAll(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  async function createJpegWithExif(file, { orientation } = {}) {
    let pipeline = sharp({
      create: { width: 8, height: 4, channels: 3, background: { r: 180, g: 20, b: 20 } },
    }).jpeg();
    pipeline = pipeline.withMetadata({
      ...(orientation ? { orientation } : {}),
      exif: {
        IFD0: { Make: 'TestCam', Software: 'jest' },
        GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
      },
    });
    await pipeline.toFile(file);
  }

  it('removes EXIF (incl. GPS) from a JPEG', async () => {
    const file = path.join(dir, 'gps.jpg');
    await createJpegWithExif(file);

    const before = await sharp(file).metadata();
    expect(before.exif).toBeDefined();

    await stripImageMetadata(file);

    const after = await sharp(file).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.width).toBe(8);
    expect(after.height).toBe(4);
  });

  it('bakes EXIF orientation into the pixels before stripping it', async () => {
    const file = path.join(dir, 'rotated.jpg');
    await createJpegWithExif(file, { orientation: 6 }); // 90° clockwise

    await stripImageMetadata(file);

    const after = await sharp(file).metadata();
    expect(after.orientation).toBeUndefined();
    // Orientation 6 rotates 90°, so the 8x4 image becomes 4x8.
    expect(after.width).toBe(4);
    expect(after.height).toBe(8);
  });

  it('strips metadata from PNG and WebP files', async () => {
    for (const ext of ['png', 'webp']) {
      const file = path.join(dir, `image.${ext}`);
      await sharp({
        create: { width: 6, height: 6, channels: 3, background: { r: 20, g: 20, b: 180 } },
      })
        .toFormat(ext)
        .withMetadata({ exif: { IFD0: { Make: 'TestCam' } } })
        .toFile(file);

      await stripImageMetadata(file);

      const after = await sharp(file).metadata();
      expect(after.exif).toBeUndefined();
      expect(after.format).toBe(ext);
    }
  });

  it('chooses the output format from the decoded content, not the (lying) extension', async () => {
    // A transparent PNG uploaded with Content-Type image/jpeg gets a .jpg
    // filename — encoding it as JPEG would flatten the alpha channel onto
    // black. The sanitizer must keep it PNG.
    const file = path.join(dir, 'mislabeled.jpg');
    await sharp({
      create: { width: 6, height: 6, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Make: 'TestCam' } } })
      .toFile(file);

    await stripImageMetadata(file);

    const after = await sharp(file).metadata();
    expect(after.format).toBe('png');
    expect(after.hasAlpha).toBe(true);
    expect(after.exif).toBeUndefined();
  });

  it('rejects a file that is not a decodable image without touching it', async () => {
    const file = path.join(dir, 'fake.jpg');
    await fs.promises.writeFile(file, 'definitely not an image');
    await expect(stripImageMetadata(file)).rejects.toThrow();
    expect((await fs.promises.readFile(file)).toString()).toBe('definitely not an image');
  });

  it('rejects decodable but unsupported formats (gif)', async () => {
    const file = path.join(dir, 'anim.gif');
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .gif()
      .toFile(file);
    await expect(stripImageMetadata(file)).rejects.toThrow(/unsupported image format/i);
  });

  it('hasStrippableMetadata: true for EXIF-bearing files, false after stripping', async () => {
    const file = path.join(dir, 'probe.jpg');
    await createJpegWithExif(file);
    expect(await hasStrippableMetadata(file)).toBe(true);

    await stripImageMetadata(file);
    expect(await hasStrippableMetadata(file)).toBe(false);
  });
});

describe('detectImageFormat', () => {
  async function make(format) {
    const pipeline = sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    });
    if (format === 'jpeg') return pipeline.jpeg().toBuffer();
    if (format === 'png') return pipeline.png().toBuffer();
    return pipeline.webp().toBuffer();
  }

  it('identifies jpeg, png and webp from magic bytes', async () => {
    expect(detectImageFormat(await make('jpeg'))).toBe('jpeg');
    expect(detectImageFormat(await make('png'))).toBe('png');
    expect(detectImageFormat(await make('webp'))).toBe('webp');
  });

  it('returns null for non-image or too-short input', () => {
    expect(detectImageFormat(Buffer.from('not an image at all'))).toBeNull();
    expect(detectImageFormat(Buffer.from('hi'))).toBeNull();
    expect(detectImageFormat('string')).toBeNull();
  });

  it('matches the format sanitizeImageBuffer actually produced (format is preserved)', async () => {
    for (const format of ['jpeg', 'png', 'webp']) {
      const out = await sanitizeImageBuffer(await make(format));
      expect(detectImageFormat(out)).toBe(format);
    }
  });
});
