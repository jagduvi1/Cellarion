const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { stripImageMetadata } = require('./imageSanitizer');

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

  it('rejects a file that is not a decodable image', async () => {
    const file = path.join(dir, 'fake.jpg');
    await fs.promises.writeFile(file, 'definitely not an image');
    await expect(stripImageMetadata(file)).rejects.toThrow();
  });

  it('rejects unsupported extensions without touching the file', async () => {
    const file = path.join(dir, 'anim.gif');
    await fs.promises.writeFile(file, 'GIF89a');
    await expect(stripImageMetadata(file)).rejects.toThrow(/unsupported image extension/i);
    expect((await fs.promises.readFile(file)).toString()).toBe('GIF89a');
  });
});
