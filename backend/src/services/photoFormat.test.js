/**
 * services/photoFormat — the kept photo is a WebP of at most 2048 px with its
 * transparency, and rembg is never handed more than 2048 px (a 24 MP frame
 * exhausted its memory). Real sharp, generated images.
 */
const sharp = require('sharp');
const { encodeKeptPhoto, prepareRembgInput, KEPT_MAX_EDGE, REMBG_MAX_EDGE } = require('./photoFormat');

// A tall bottle-shaped cut-out: transparent canvas, opaque body.
function cutout(width, height) {
  const body = { create: { width: Math.round(width / 3), height: Math.round(height * 0.8), channels: 4, background: { r: 120, g: 20, b: 40, alpha: 1 } } };
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body, gravity: 'centre' }])
    .png()
    .toBuffer();
}

function photo(width, height, { orientation } = {}) {
  let p = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 150 } } }).jpeg({ quality: 90 });
  if (orientation) p = p.withMetadata({ orientation });
  return p.toBuffer();
}

describe('encodeKeptPhoto', () => {
  test('a large cut-out becomes a WebP bounded to 2048 px on the long side, transparency kept', async () => {
    const out = await encodeKeptPhoto(await cutout(1500, 4000));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.height).toBe(KEPT_MAX_EDGE);
    expect(meta.width).toBe(768); // 1500 × 2048/4000, aspect kept
    expect(meta.hasAlpha).toBe(true);
    // The corner is still see-through and the body still opaque.
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(Math.floor(info.width / 2), Math.floor(info.height / 2))).toBe(255);
  });

  test('a photo within the cap keeps its size — never enlarged', async () => {
    const meta = await sharp(await encodeKeptPhoto(await cutout(330, 900))).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([330, 900]);
  });

  test('is much smaller than the lossless PNG rembg returns', async () => {
    // A gradient with sensor-like noise stands in for a photo: the noise is
    // what makes a lossless PNG of a real photo big.
    const width = 600;
    const height = 1600;
    const raw = Buffer.alloc(width * height * 3);
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        const noise = (rand() - 0.5) * 16;
        raw[i] = Math.max(0, Math.min(255, 60 + y / 10 + noise));
        raw[i + 1] = Math.max(0, Math.min(255, 20 + x / 8 + noise));
        raw[i + 2] = Math.max(0, Math.min(255, 40 + noise));
      }
    }
    const png = await sharp(raw, { raw: { width, height, channels: 3 } }).ensureAlpha().png().toBuffer();
    const out = await encodeKeptPhoto(png);
    expect(out.length).toBeLessThan(png.length / 3);
  });

  test('bakes an EXIF rotation into the pixels', async () => {
    const meta = await sharp(await encodeKeptPhoto(await photo(400, 300, { orientation: 6 }))).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
    expect(meta.orientation).toBeUndefined();
  });

  test('throws on bytes that are not an image', async () => {
    await expect(encodeKeptPhoto(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('prepareRembgInput', () => {
  test('a frame that already fits goes untouched — no re-encode, the right type', async () => {
    const jpeg = await photo(1200, 1600);
    const out = await prepareRembgInput(jpeg);
    expect(out.buffer).toBe(jpeg);
    expect(out.type).toBe('image/jpeg');
    expect(out.filename).toBe('input.jpg');

    const png = await cutout(400, 800);
    const outPng = await prepareRembgInput(png);
    expect(outPng.buffer).toBe(png);
    expect(outPng.type).toBe('image/png');
  });

  test('a large opaque photo is scaled to 2048 px as a JPEG', async () => {
    const out = await prepareRembgInput(await photo(4000, 6000));
    const meta = await sharp(out.buffer).metadata();
    expect(out.type).toBe('image/jpeg');
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width, meta.height)).toBe(REMBG_MAX_EDGE);
  });

  test('a large frame with transparency stays PNG, so rembg still sees it is already cut out', async () => {
    const out = await prepareRembgInput(await cutout(2400, 3000));
    const meta = await sharp(out.buffer).metadata();
    expect(out.type).toBe('image/png');
    expect(meta.hasAlpha).toBe(true);
    expect(meta.height).toBe(REMBG_MAX_EDGE);
  });

  test('a small but rotated frame is turned upright (rembg ignores the EXIF tag)', async () => {
    const out = await prepareRembgInput(await photo(400, 300, { orientation: 6 }));
    const meta = await sharp(out.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });

  test('throws on bytes that are not an image', async () => {
    await expect(prepareRembgInput(Buffer.from('nope'))).rejects.toThrow();
  });
});
